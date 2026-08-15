import { randomUUID } from "crypto";
import MCQBank, { type IMCQ, type IMcqAnnexureUsage, type DifficultyLevel } from "@/models/MCQBank";
import type { ISOP } from "@/models/SOP";
import { enrichMcqRationale } from "@/lib/mcq-rationale";
import { isDuplicateMcqQuestionForGeneration } from "@/lib/similarity";
import { sopFamilyIdentifierRegex } from "@/lib/sop-utils";

// Shape the generator produces (kept structural to avoid a circular import with
// lib/mcq-generation). Any object with these fields can be written to a bank.
export interface BankInputMcq {
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: "A" | "B" | "C" | "D";
  explanation: string;
  difficulty: "easy" | "medium" | "hard";
  topic: string;
  /** Exact SOP section/clause the question traces back to (e.g. "4.6.1.4").
   *  Optional here so legacy callers without it still type-check. */
  sopReference?: string;
  /** Stamp creative-fill MCQs so annexure swap and the viewer can preserve/mark them. */
  isCreative?: boolean;
}

const DIFFICULTY_MAP: Record<string, DifficultyLevel> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

/** Normalize stored/generated difficulty to the bank display enum. */
export function normalizeMcqDifficulty(raw: unknown): DifficultyLevel {
  if (raw === "Easy" || raw === "Medium" || raw === "Hard") return raw;
  return DIFFICULTY_MAP[String(raw ?? "").toLowerCase()] ?? "Medium";
}

const STARS: Record<DifficultyLevel, "⭐" | "⭐⭐" | "⭐⭐⭐"> = {
  Easy: "⭐",
  Medium: "⭐⭐",
  Hard: "⭐⭐⭐",
};

const LETTER_INDEX: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

/** Hard cap on MCQs stored per SOP identifier + language. */
export const MCQ_BANK_CAP = 100;

/**
 * Map a generated MCQ to the MCQBank embedded shape.
 *
 * The bank's `correctAnswer` is stored as the option TEXT (not a letter) because
 * the viewer marks an option correct via `opt === mcq.correctAnswer`
 * (MCQViewerModal) and the LMS quiz resolves text → letter. Required string
 * fields (explanation/sopReference/aiIcon/correctAnswer) must be non-empty or
 * Mongoose `required` validation rejects the doc.
 */
export function toBankMcq(q: BankInputMcq, sopIdentifier: string): IMCQ {
  const options = [q.optionA, q.optionB, q.optionC, q.optionD].map((o) => (o ?? "").trim());
  const idx = LETTER_INDEX[q.correctAnswer] ?? 0;
  const difficulty = normalizeMcqDifficulty(q.difficulty);
  const correctText =
    options[idx] || options.find((o) => o.length > 0) || "N/A";
  const { explanation, sopReference } = enrichMcqRationale({
    question: q.question,
    optionA: q.optionA,
    optionB: q.optionB,
    optionC: q.optionC,
    optionD: q.optionD,
    correctAnswer: q.correctAnswer,
    explanation: q.explanation,
    sopReference: q.sopReference,
    topic: q.topic,
  });
  return {
    mcqId: randomUUID(),
    aiIcon: "✨",
    question: (q.question ?? "").trim(),
    difficulty,
    difficultyStars: STARS[difficulty],
    options,
    correctAnswer: correctText,
    explanation,
    sopReference: sopReference || (q.topic ?? "").trim() || sopIdentifier,
    optionVariants: [],
    isChecked: false,
    isReviewed: false,
    isSimilar: false,
    fromAnnexure: false,
    isCreative: Boolean(q.isCreative),
  };
}

function difficultyDistribution(mcqs: { difficulty: DifficultyLevel }[]) {
  return {
    easy: mcqs.filter((m) => m.difficulty === "Easy").length,
    medium: mcqs.filter((m) => m.difficulty === "Medium").length,
    hard: mcqs.filter((m) => m.difficulty === "Hard").length,
  };
}

export interface BankWriteResult {
  bankId: string;
  inserted: number;
  skipped: number;
  total: number;
  /** Question texts that were actually written (survived dedup). */
  insertedQuestions: string[];
}

/**
 * Upsert generated MCQs into the SOP's MCQBank (one bank per SOP record +
 * language). New questions are deduped against the bank's existing questions
 * before appending, so re-running generation never produces near-duplicates.
 *
 * Returns the resulting bank id and counts. If nothing new survives dedup and no
 * bank exists yet, no empty bank is created (the schema requires ≥1 question).
 */
// Match by exact identifier + language (version-specific) rather than sopId, so
// pdf+docx records of the same SOP version share one bank — preventing duplicate
// banks that would double-count in the family-level stats fold. Different versions
// keep distinct identifiers and so keep distinct banks.
function identifierRegex(identifier: string): RegExp {
  return new RegExp(`^${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}

/** Total MCQs across all active banks for this identifier + language. */
export async function activeBankMcqCount(
  sopIdentifier: string,
  language: "English" | "Gujarati",
): Promise<number> {
  const banks = await MCQBank.find({
    sopIdentifier: identifierRegex(sopIdentifier),
    language,
    isObsolete: { $ne: true },
  })
    .select("mcqs")
    .lean();
  return banks.reduce((sum, b) => sum + (b.mcqs?.length ?? 0), 0);
}

async function loadActiveBanks(sopIdentifier: string, language: "English" | "Gujarati") {
  return MCQBank.find({
    sopIdentifier: identifierRegex(sopIdentifier),
    language,
    isObsolete: { $ne: true },
  });
}

/** Dedup a batch of generated MCQs against a running list, mapping survivors to
 *  the bank shape. Returns the new bank questions plus how many were skipped. */
function dedupToBank(
  generated: BankInputMcq[],
  identifier: string,
  against: string[],
  maxInsert = Infinity,
): { toAdd: IMCQ[]; skipped: number } {
  const seen = [...against];
  const toAdd: IMCQ[] = [];
  let skipped = 0;
  for (const q of generated) {
    if (toAdd.length >= maxInsert) {
      skipped++;
      continue;
    }
    if (seen.some((eq) => isDuplicateMcqQuestionForGeneration(q.question, eq))) {
      skipped++;
      continue;
    }
    seen.push(q.question);
    toAdd.push(toBankMcq(q, identifier));
  }
  return { toAdd, skipped };
}

export const SUPERSEDED_REASON = "Superseded by regenerated MCQs";

/**
 * Append generated MCQs to the SOP's ACTIVE bank (one per identifier + language),
 * deduping against what's already there. Creates the bank if none exists. Use for
 * "generate more" — it adds to the current set without archiving anything.
 */
export async function appendGeneratedToBank(
  sop: Pick<ISOP, "_id" | "name" | "identifier" | "department">,
  language: "English" | "Gujarati",
  generated: BankInputMcq[],
  aiModel = "gemini-2.5-flash",
  annexureUsage?: IMcqAnnexureUsage,
): Promise<BankWriteResult> {
  const idRegex = identifierRegex(sop.identifier);
  const banks = await loadActiveBanks(sop.identifier, language);
  const existingQuestions = banks.flatMap((b) => b.mcqs.map((m) => m.question));
  const totalNow = existingQuestions.length;
  const room = Math.max(0, MCQ_BANK_CAP - totalNow);
  if (room === 0) {
    const primary = banks.sort((a, b) => b.mcqs.length - a.mcqs.length)[0];
    return {
      bankId: primary ? String(primary._id) : "",
      inserted: 0,
      skipped: generated.length,
      total: totalNow,
      insertedQuestions: [],
    };
  }
  const { toAdd, skipped } = dedupToBank(generated, sop.identifier, existingQuestions, room);

  if (!banks.length) {
    if (toAdd.length === 0) {
      return { bankId: "", inserted: 0, skipped, total: 0, insertedQuestions: [] };
    }
    const created = await MCQBank.create({
      sopId: sop._id,
      sopName: sop.name,
      sopIdentifier: sop.identifier,
      department: sop.department,
      language,
      mcqs: toAdd,
      totalQuestions: toAdd.length,
      generatedAt: new Date(),
      difficultyDistribution: difficultyDistribution(toAdd),
      aiModel,
      annexureUsage,
    });
    return {
      bankId: String(created._id),
      inserted: toAdd.length,
      skipped,
      total: toAdd.length,
      insertedQuestions: toAdd.map((m) => m.question),
    };
  }

  const bank = [...banks].sort((a, b) => b.mcqs.length - a.mcqs.length)[0];
  if (toAdd.length > 0) {
    bank.mcqs.push(...toAdd);
    if (bank.mcqs.length > MCQ_BANK_CAP) {
      bank.mcqs = bank.mcqs.slice(0, MCQ_BANK_CAP);
    }
    bank.totalQuestions = bank.mcqs.length;
    bank.difficultyDistribution = difficultyDistribution(bank.mcqs);
    // Stamp the latest run's annexure usage — questions just added to this bank
    // were generated with whatever this run folded in.
    if (annexureUsage) bank.annexureUsage = annexureUsage;
    await bank.save();
  }
  const total = await activeBankMcqCount(sop.identifier, language);
  return {
    bankId: String(bank._id),
    inserted: toAdd.length,
    skipped,
    total,
    insertedQuestions: toAdd.map((m) => m.question),
  };
}

/**
 * Archive the SOP's current active bank(s) without creating a new one.
 * Used by progressive regeneration: archive first, then append batches one by one.
 */
export async function archiveBankForSop(
  sop: Pick<ISOP, "identifier">,
  language: "English" | "Gujarati",
): Promise<number> {
  const idRegex = identifierRegex(sop.identifier);
  const result = await MCQBank.updateMany(
    { sopIdentifier: idRegex, language, isObsolete: { $ne: true } },
    { $set: { isObsolete: true, obsoleteAt: new Date(), obsoleteReason: SUPERSEDED_REASON } },
  );
  return result.modifiedCount;
}

/**
 * Replace the SOP's active bank with a freshly generated set: the current active
 * bank(s) for this identifier + language are archived to the Obsolete MCQs section
 * (isObsolete=true, alongside old SOP-version MCQs), and a new active bank is
 * created from the generated questions. Use for full regeneration.
 *
 * If nothing usable is generated, the existing active bank is left untouched (we
 * never strand an SOP with zero active MCQs over an empty AI response).
 */
export async function replaceBankForSop(
  sop: Pick<ISOP, "_id" | "name" | "identifier" | "department">,
  language: "English" | "Gujarati",
  generated: BankInputMcq[],
  aiModel = "gemini-2.5-flash",
): Promise<BankWriteResult> {
  const idRegex = identifierRegex(sop.identifier);
  const capped = generated.slice(0, MCQ_BANK_CAP);
  const { toAdd, skipped } = dedupToBank(capped, sop.identifier, []);

  if (toAdd.length === 0) {
    const cur = await MCQBank.findOne({ sopIdentifier: idRegex, language, isObsolete: { $ne: true } })
      .select("_id totalQuestions")
      .lean();
    return {
      bankId: cur ? String(cur._id) : "",
      inserted: 0,
      skipped,
      total: cur?.totalQuestions ?? 0,
      insertedQuestions: [],
    };
  }

  // Archive the current active bank(s) to the Obsolete MCQs section (preserving
  // their review flags/history) before installing the new one.
  await MCQBank.updateMany(
    { sopIdentifier: idRegex, language, isObsolete: { $ne: true } },
    { $set: { isObsolete: true, obsoleteAt: new Date(), obsoleteReason: SUPERSEDED_REASON } },
  );

  const created = await MCQBank.create({
    sopId: sop._id,
    sopName: sop.name,
    sopIdentifier: sop.identifier,
    department: sop.department,
    language,
    mcqs: toAdd,
    totalQuestions: toAdd.length,
    generatedAt: new Date(),
    difficultyDistribution: difficultyDistribution(toAdd),
    aiModel,
  });
  return {
    bankId: String(created._id),
    inserted: toAdd.length,
    skipped,
    total: toAdd.length,
    insertedQuestions: toAdd.map((m) => m.question),
  };
}

export type McqDeleteScope = "eng" | "guj" | "both";

/** Permanently remove active MCQ banks for an SOP family, scoped by language. */
export async function deleteBanksForFamily(
  identifier: string,
  scope: McqDeleteScope,
): Promise<number> {
  const filter: Record<string, unknown> = {
    sopIdentifier: sopFamilyIdentifierRegex(identifier),
    isObsolete: { $ne: true },
  };
  if (scope === "eng") filter.language = "English";
  else if (scope === "guj") filter.language = "Gujarati";

  const result = await MCQBank.deleteMany(filter);
  return result.deletedCount;
}
