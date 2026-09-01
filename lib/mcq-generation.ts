import SOP, { type ISOP } from "@/models/SOP";
import MCQBank, { type IMcqAnnexureUsage } from "@/models/MCQBank";
import MCQGenJob, { type McqGenLanguage, type McqGenMode, type IMcqGenLangProgress } from "@/models/MCQGenJob";
import { generateJson, isGeminiOverloadedError } from "@/lib/gemini";
import { generateOllamaJson } from "@/lib/ollama";
import { generateClaudeCliMcqBatch, getMcqClaudeModel } from "@/lib/claude-cli";
import { checkCodexCliHealth, generateCodexCliMcqBatch, getMcqCodexModel } from "@/lib/codex-cli";
import { anthropicMcqApiAvailable, generateAnthropicMcqBatch } from "@/lib/anthropic-mcq";
import { getOrBuildClauseIndex } from "@/lib/mcq-clause-cache";
import {
  batchClauses,
  buildClauseMcqUserPrompt,
  clauseRefsMatch,
  clauseRefsMatchExact,
  filterUncoveredClauses,
  isClauseCovered,
  normalizeMcqClauseRef,
  type SopClause,
} from "@/lib/mcq-clauses";
import { DEFAULT_FREE_GEMINI_MODEL } from "@/lib/gemini-free-models";
import type { LlmProvider } from "@/lib/llm";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { connectDB } from "@/lib/mongodb";
import { appendGeneratedToBank, archiveBankForSop, activeBankMcqCount, MCQ_BANK_CAP, type BankInputMcq } from "@/lib/mcq-bank-write";
import {
  MCQ_CONTENT_CHUNKS,
  MCQ_CONTENT_LIMIT,
  MCQ_CONTENT_LIMIT_OLLAMA,
  mcqPromptSopExcerpt,
  normalizeSopTextForMcq,
  scoreSopRecordForMcq,
} from "@/lib/mcq-source-text";
import { isDuplicateMcqQuestionForGeneration } from "@/lib/similarity";
import {
  buildAnnexureSupplementDetailed,
  countLinkedAnnexureDocuments,
} from "@/lib/compliance-sop-content";
import {
  ensureSingleMcqGenJob,
  healOrphanedMcqGenJobIfNeeded,
  mcqGenJobMatchFilter,
  upsertMcqGenJob,
  updateMcqGenJob,
} from "@/lib/mcq-gen-job-store";
import {
  beginMcqRun,
  endMcqRun,
  getMcqRunSignal,
  isMcqRunActiveInProcess,
  isMcqRunStopRequested,
  mcqRunKey,
  requestMcqRunStop,
  requestStopAllMcqRuns,
} from "@/lib/mcq-run-control";

import {
  clausesPerCall,
  creativeBatchSize,
  legacyBatchSize,
  maxCreativeBatches,
  maxLegacyBatches,
  mcqContentLimitClaude,
  mcqContentLimitCodex,
  shouldUseFactPipeline,
  shouldUseFastFill,
} from "@/lib/mcq-generation-config";
import {
  TRANSLATION_BATCH_SIZE,
  TRANSLATION_CONCURRENCY,
  ensureBankMcqIds,
  saveBankTranslations,
  toMasterMcqs,
  translateMcqBatch,
  type MasterMcq,
} from "@/lib/mcqTranslation";
import { generateForLanguageFactBased } from "@/lib/mcq-fact-generation";
import { normalizeKnowledgeFactId } from "@/lib/mcq-facts";
import { enrichMcqRationale } from "@/lib/mcq-rationale";
import {
  MCQ_CLAUSE_SYSTEM,
  MCQ_CREATIVE_SYSTEM,
  MCQ_LEGACY_SYSTEM,
  isMetadataOnlyMcq,
} from "@/lib/mcq-generation-prompts";

/** Each SOP/language bank holds at most this many MCQs (see MCQ_BANK_CAP). */
export const MCQ_TARGET_PER_LANGUAGE = MCQ_BANK_CAP;
const MCQ_MAX_EMPTY_BATCHES = 4;
/** Legacy fill tolerates more duplicate-only rounds while still below cap. */
const MCQ_MAX_ZERO_INSERT_ROUNDS = 16;
const MAX_QUESTIONS_PER_CLAUSE = 1;
/** Abort the whole run after this many fully-overloaded (503) batches. Hammering
 *  an overloaded service just burns quota without producing MCQs. */
const MCQ_MAX_OVERLOAD_ABORT = 2;
/** Per-call retry budget for MCQ generation: a couple of quick tries, and bail
 *  fast on 503 so we don't trigger the escalating-backoff storm. */
const MCQ_GEN_OPTIONS = { maxAttempts: 2, fastFail503: true } as const;
const CLAUDE_BATCH_ATTEMPTS = 2;

/** Prevent duplicate concurrent runs for the same identifier in one Node process. */
const runningMcqIdentifiers = new Set<string>();

export interface GeneratedMCQ {
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: "A" | "B" | "C" | "D";
  explanation?: string;
  difficulty: "easy" | "medium" | "hard";
  topic?: string;
  sopReference: string;
  factId?: string;
  learningObjective?: string;
  questionCategory?: "recall" | "scenario" | "application";
}

async function callMcqModel(
  provider: LlmProvider | undefined,
  system: string,
  user: string,
  identifier: string,
): Promise<{ questions: GeneratedMCQ[] }> {
  if (isMcqRunStopRequested(identifier)) {
    throw new McqGenerationCancelledError();
  }
  const signal = getMcqRunSignal(identifier);
  if (provider === "claude") {
    if (anthropicMcqApiAvailable()) {
      const questions = await generateAnthropicMcqBatch(system, user, getMcqClaudeModel(), signal);
      return { questions };
    }
    const questions = await generateClaudeCliMcqBatch(system, user, getMcqClaudeModel(), {
      runKey: identifier,
      signal,
    });
    return { questions };
  }
  if (provider === "codex") {
    const questions = await generateCodexCliMcqBatch(system, user, getMcqCodexModel(), {
      runKey: identifier,
      signal,
    });
    return { questions };
  }
  if (provider === "ollama") {
    return generateOllamaJson<{ questions: GeneratedMCQ[] }>(system, user);
  }
  return generateJson<{ questions: GeneratedMCQ[] }>(system, user, MCQ_GEN_OPTIONS);
}

function mcqProviderLabel(provider?: LlmProvider): string {
  if (provider === "ollama") return "Ollama (gemma3:12b)";
  if (provider === "codex") return `Codex CLI (${getMcqCodexModel()})`;
  if (provider === "claude") {
    const via = anthropicMcqApiAvailable() ? "Anthropic API" : "Claude CLI";
    return `${via} (${getMcqClaudeModel()})`;
  }
  return "Gemini";
}

function resolveMcqAiModel(provider?: LlmProvider): string {
  if (provider === "ollama") return "gemma3:12b";
  if (provider === "codex") return getMcqCodexModel();
  if (provider === "claude") return getMcqClaudeModel();
  return process.env.GEMINI_MODEL ?? DEFAULT_FREE_GEMINI_MODEL;
}

/** Thrown when the run aborts because the model service is overloaded (503). The
 *  caller maps it to a friendly "retry in a few minutes" job status. */
class OverloadAbortError extends Error {}

class McqGenerationCancelledError extends Error {
  constructor() {
    super("Generation cancelled");
  }
}

async function isMcqGenerationCancelled(identifier: string): Promise<boolean> {
  if (isMcqRunStopRequested(identifier)) return true;
  const job = await MCQGenJob.findOne({
    ...mcqGenJobMatchFilter(identifier),
    status: { $in: ["queued", "running", "cancelled"] },
  })
    .select("cancelRequested status")
    .lean();
  return Boolean(job?.cancelRequested) || job?.status === "cancelled";
}

/** Request the in-flight MCQ run for this identifier to stop (kills CLI subprocess + sets DB flag). */
export async function requestMcqGenerationCancel(identifier: string): Promise<boolean> {
  requestMcqRunStop(identifier);

  const filter = {
    ...mcqGenJobMatchFilter(identifier),
    status: { $in: ["queued", "running"] as const },
  };
  const result = await MCQGenJob.updateMany(filter, {
    $set: {
      status: "cancelled",
      cancelRequested: true,
      phase: "Stopped by user",
      error: "Generation stopped",
      finishedAt: new Date(),
      updatedAt: new Date(),
    },
  });
  return result.modifiedCount > 0 || isMcqRunStopRequested(identifier);
}

/** Stop all active MCQ jobs (DB + in-process CLI subprocesses). */
export async function requestMcqGenerationCancelAll(): Promise<number> {
  requestStopAllMcqRuns();
  const result = await MCQGenJob.updateMany(
    { status: { $in: ["queued", "running"] } },
    {
      $set: {
        status: "cancelled",
        cancelRequested: true,
        phase: "Force stopped (all)",
        error: "Generation stopped by user",
        finishedAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );
  // Also heal any already-flagged-but-stuck jobs
  const healed = await MCQGenJob.updateMany(
    { cancelRequested: true, status: { $in: ["queued", "running"] } },
    {
      $set: {
        status: "cancelled",
        phase: "Force stopped (all)",
        error: "Generation stopped by user",
        finishedAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );
  return result.modifiedCount + healed.modifiedCount;
}

async function finalizeCancelledJob(
  identifier: string,
  langProgress: IMcqGenLangProgress[],
  totalApproved: number,
  totalRecycled: number,
  failedBatches: number,
): Promise<void> {
  for (const lp of langProgress) {
    if (lp.status === "running") lp.status = "failed";
  }
  await updateMcqGenJob(identifier, {
    status: "cancelled",
    phase: `Stopped — ${totalApproved} MCQs saved`,
    languages: langProgress,
    totalInserted: totalApproved,
    totalSkipped: totalRecycled,
    totalFailedBatches: failedBatches,
    error: "Generation stopped",
    finishedAt: new Date(),
  });
}

function ts(): string {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function pushLog(identifier: string, message: string): Promise<void> {
  const line = `[${ts()}] ${message}`;
  const canonicalId = await ensureSingleMcqGenJob(identifier);
  await MCQGenJob.updateOne(
    { identifier: canonicalId },
    {
      $push: { logs: { $each: [line], $slice: -30 } },
      $set: { updatedAt: new Date() },
    },
  );
}

/** Mutable per-run bookkeeping shared across languages/batches. */
interface RunCtx {
  overloadHits: number;
  failedBatches: number;
}

function escapeId(identifier: string): RegExp {
  return new RegExp(`^${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}

/** Overall completion: bank size toward the per-language cap. */
function overallPercent(langs: IMcqGenLangProgress[]): number {
  const totalTarget = langs.reduce((s, l) => s + (l.target || 0), 0) || 1;
  const done = langs.reduce((s, l) => s + Math.min(l.collected, l.target), 0);
  return Math.min(100, Math.round((done / totalTarget) * 100));
}

/** Normalize API/client language codes to the canonical bank language name. */
export function parseMcqLanguage(v: unknown): McqGenLanguage | undefined {
  if (v === "English" || v === "ENG" || v === "en") return "English";
  if (v === "Gujarati" || v === "GUJ" || v === "gu") return "Gujarati";
  return undefined;
}

async function hasActiveBankForLang(identifier: string, language: McqGenLanguage): Promise<boolean> {
  return Boolean(
    await MCQBank.exists({
      sopIdentifier: escapeId(identifier),
      language,
      isObsolete: { $ne: true },
    }),
  );
}

async function activeBankCount(identifier: string, language: "English" | "Gujarati"): Promise<number> {
  return activeBankMcqCount(identifier, language);
}

type HaltReason = "cancel" | "cap";

/** Authoritative stop check — reads live bank size from DB before each API call. */
async function shouldHaltGeneration(
  identifier: string,
  language: "English" | "Gujarati",
): Promise<{ halt: boolean; reason: HaltReason | null; bankTotal: number }> {
  if (await isMcqGenerationCancelled(identifier)) {
    return { halt: true, reason: "cancel", bankTotal: await activeBankCount(identifier, language) };
  }
  const bankTotal = await activeBankCount(identifier, language);
  if (bankTotal >= MCQ_BANK_CAP) {
    return { halt: true, reason: "cap", bankTotal };
  }
  return { halt: false, reason: null, bankTotal };
}

async function handleGenerationHalt(
  identifier: string,
  language: "English" | "Gujarati",
  reason: HaltReason,
  bankTotal: number,
): Promise<void> {
  if (reason === "cancel") {
    await pushLog(identifier, `${language} · stop requested — halting at ${bankTotal}/${MCQ_BANK_CAP}`);
    throw new McqGenerationCancelledError();
  }
  await pushLog(identifier, `${language} · bank at ${bankTotal}/${MCQ_BANK_CAP} — stopping`);
}

interface BankDedupState {
  questions: string[];
  refCounts: Map<string, number>;
  /** Internal fact_id keys already used in the bank this run — not persisted. */
  usedFactIds: Set<string>;
}

async function loadBankDedupState(
  identifier: string,
  language: "English" | "Gujarati",
): Promise<BankDedupState> {
  const banks = await MCQBank.find({
    sopIdentifier: escapeId(identifier),
    language,
    isObsolete: { $ne: true },
  })
    .select("mcqs.question mcqs.sopReference")
    .lean();

  const questions: string[] = [];
  const refCounts = new Map<string, number>();
  for (const bank of banks) {
    for (const m of bank.mcqs ?? []) {
      if (m.question?.trim()) questions.push(m.question);
      const ref = normalizeMcqClauseRef(m.sopReference);
      if (ref) refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
    }
  }
  return { questions, refCounts, usedFactIds: new Set<string>() };
}

function syncInsertedMcqs(
  accepted: GeneratedMCQ[],
  insertedTexts: string[],
  seenQuestions: string[],
  refCounts: Map<string, number>,
  usedFactIds: Set<string>,
): void {
  const pending = new Set(insertedTexts);
  for (const q of accepted) {
    if (!pending.has(q.question)) continue;
    pending.delete(q.question);
    seenQuestions.push(q.question);
    const ref = normalizeMcqClauseRef(q.sopReference ?? "");
    if (ref) refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
    const fid = q.factId ? normalizeKnowledgeFactId(q.factId) : "";
    if (fid) usedFactIds.add(fid);
  }
}

function toBankInput(q: GeneratedMCQ): BankInputMcq {
  const { explanation, sopReference } = enrichMcqRationale(q);
  const topic = q.topic?.trim() || q.learningObjective?.trim() || sopReference.slice(0, 80);
  return {
    question: q.question,
    optionA: q.optionA,
    optionB: q.optionB,
    optionC: q.optionC,
    optionD: q.optionD,
    correctAnswer: q.correctAnswer,
    explanation,
    difficulty: q.difficulty,
    topic,
    sopReference,
  };
}

function clauseRefMatchesBatch(ref: string, batch: SopClause[]): boolean {
  const norm = normalizeMcqClauseRef(ref);
  if (!norm) return false;
  return batch.some((c) => clauseRefsMatch(c.id, norm));
}

/** Fix missing/wrong sopReference by pairing questions to uncovered clauses in order. */
function reconcileClauseRefs(questions: GeneratedMCQ[], work: SopClause[]): GeneratedMCQ[] {
  const out: GeneratedMCQ[] = [];
  const claimed = new Set<string>();

  for (const q of questions) {
    let clause = work.find(
      (c) => !claimed.has(c.id) && clauseRefMatchesBatch(q.sopReference ?? "", [c]),
    );
    if (!clause) {
      clause = work.find((c) => !claimed.has(c.id));
      if (clause) q.sopReference = clause.id;
    }
    if (clause) {
      claimed.add(clause.id);
      out.push(q);
    }
  }
  return out;
}

function refCountForClause(refCounts: Map<string, number>, ref: string): number {
  let count = 0;
  for (const [k, v] of refCounts) {
    if (clauseRefsMatchExact(k, ref)) count += v;
  }
  return count;
}

function isAcceptableMcq(
  q: GeneratedMCQ,
  seenQuestions: string[],
  refCounts: Map<string, number>,
  allowedClauseIds?: Set<string>,
  options?: { skipClauseRefCap?: boolean; usedFactIds?: Set<string>; allowFactReuse?: boolean },
): boolean {
  if (!q?.question?.trim()) return false;
  if (isMetadataOnlyMcq(q.question)) return false;
  if (seenQuestions.some((eq) => isDuplicateMcqQuestionForGeneration(q.question, eq))) return false;

  const fid = q.factId ? normalizeKnowledgeFactId(q.factId) : "";
  if (fid && options?.usedFactIds?.has(fid) && !options?.allowFactReuse) return false;

  const ref = normalizeMcqClauseRef(q.sopReference);
    if (allowedClauseIds && ref) {
    let ok = false;
    for (const id of allowedClauseIds) {
      if (clauseRefsMatchExact(id, ref)) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  if (
    !options?.skipClauseRefCap &&
    ref &&
    refCountForClause(refCounts, ref) >= MAX_QUESTIONS_PER_CLAUSE
  ) {
    return false;
  }
  return true;
}

function coveredClauseRefs(refCounts: Map<string, number>): Set<string> {
  return new Set([...refCounts.keys()]);
}

async function fetchMcqQuestions(
  provider: LlmProvider | undefined,
  system: string,
  user: string,
  identifier: string,
  language: string,
  batchLabel: string,
): Promise<GeneratedMCQ[]> {
  const maxAttempts =
    provider === "claude"
      ? anthropicMcqApiAvailable()
        ? 1
        : CLAUDE_BATCH_ATTEMPTS
      : provider === "codex"
        ? CLAUDE_BATCH_ATTEMPTS
        : 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (await isMcqGenerationCancelled(identifier)) {
      throw new McqGenerationCancelledError();
    }
    try {
      const result = await callMcqModel(provider, system, user, identifier);
      if (await isMcqGenerationCancelled(identifier)) {
        throw new McqGenerationCancelledError();
      }
      return result.questions ?? [];
    } catch (err) {
      lastErr = err;
      if ((provider === "claude" || provider === "codex") && attempt < maxAttempts - 1) {
        const errMsg = err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100);
        await pushLog(identifier, `${language} · ${batchLabel} attempt ${attempt + 1} failed — retry (${errMsg})`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("MCQ batch failed");
}

/** Clause-index pipeline: parse SOP once, then only send uncovered clause text per call. */
async function generateForLanguageClauseWise(
  identifier: string,
  sop: ISOP,
  language: "English" | "Gujarati",
  bankCountAtStart: number,
  dedupAtStart: BankDedupState,
  ctx: RunCtx,
  onBatchDone: (p: { batchesDone: number; newMcqs: BankInputMcq[] }) => Promise<{ bankTotal: number; insertedTexts: string[] }>,
  provider?: LlmProvider,
  mode: McqGenMode = "generate",
): Promise<void> {
  if (bankCountAtStart >= MCQ_BANK_CAP) return;

  let seenQuestions = [...dedupAtStart.questions];
  let refCounts = new Map(dedupAtStart.refCounts);
  let usedFactIds = new Set(dedupAtStart.usedFactIds);
  let bankTotal = bankCountAtStart;

  const { clauses: allClauses, fromCache } = await getOrBuildClauseIndex(sop);
  const isContinue = mode === "continue";

  const perCall = clausesPerCall(provider);
  const countPending = () => filterUncoveredClauses(allClauses, coveredClauseRefs(refCounts));
  let pending = countPending();
  const batches = isContinue ? [] : batchClauses(pending, perCall);
  const totalBatches = isContinue ? Math.ceil(pending.length / perCall) || 0 : batches.length;

  await pushLog(
    identifier,
    `${language} · clause index${fromCache ? " (cached)" : ""}: ${allClauses.length} clauses, ${pending.length} uncovered → ${isContinue ? "continue (missing only)" : `${totalBatches} targeted calls`}`,
  );

  if (isContinue && pending.length === 0 && bankCountAtStart >= MCQ_BANK_CAP) {
    await pushLog(identifier, `${language} · bank already at ${MCQ_BANK_CAP} — nothing to add`);
    return;
  }

  if (isContinue && pending.length === 0) {
    await pushLog(
      identifier,
      `${language} · ${bankCountAtStart}/${MCQ_BANK_CAP} — no uncovered clauses, using excerpt fill`,
    );
  }

  let batchNum = 0;
  const maxBatches = isContinue
    ? Math.ceil((MCQ_BANK_CAP - bankCountAtStart) / perCall) + 5
    : batches.length;

  for (let round = 0; round < maxBatches; round++) {
    if (isContinue) {
      const fresh = await loadBankDedupState(identifier, language);
      seenQuestions = [...fresh.questions];
      refCounts = new Map(fresh.refCounts);
      usedFactIds = new Set(fresh.usedFactIds);
      bankTotal = await activeBankCount(identifier, language);
      pending = countPending();
      if (pending.length === 0) {
        await pushLog(identifier, `${language} · clause targets met at ${bankTotal}/${MCQ_BANK_CAP} — switching to excerpt fill`);
        break;
      }
    } else if (round >= batches.length) {
      break;
    }

    const pre = await shouldHaltGeneration(identifier, language);
    bankTotal = pre.bankTotal;
    if (pre.halt && pre.reason) {
      await handleGenerationHalt(identifier, language, pre.reason, bankTotal);
      return;
    }

    batchNum++;
    const room = MCQ_BANK_CAP - bankTotal;
    const clauseBatch = isContinue ? pending.slice(0, perCall) : batches[round];
    const work = clauseBatch.slice(0, room).filter((c) => !isClauseCovered(c.id, coveredClauseRefs(refCounts)));
    if (!work.length) {
      if (isContinue) continue;
      break;
    }

    const userPrompt = buildClauseMcqUserPrompt(language, sop.identifier, work);

    const batchLabel = isContinue ? `continue batch ${batchNum}` : `clause batch ${batchNum}`;
    await pushLog(
      identifier,
      `${language} · ${batchLabel}${!isContinue ? `/${totalBatches}` : ""} (${work.length} clauses) → ${mcqProviderLabel(provider)} (${bankTotal}/${MCQ_BANK_CAP})`,
    );

    let activeWork = work;
    let questions: GeneratedMCQ[] | undefined;
    try {
      questions = await fetchMcqQuestions(
        provider,
        MCQ_CLAUSE_SYSTEM,
        userPrompt,
        identifier,
        language,
        `clause batch ${batchNum}`,
      );
    } catch (err) {
      ctx.failedBatches++;
      const errMsg = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
      if (provider !== "ollama" && provider !== "claude" && provider !== "codex" && isGeminiOverloadedError(err)) {
        ctx.overloadHits++;
        if (ctx.overloadHits >= MCQ_MAX_OVERLOAD_ABORT) {
          throw new OverloadAbortError("Gemini is overloaded (503). Please retry in a few minutes.");
        }
        continue;
      }
      await pushLog(identifier, `${language} · ${batchLabel} failed — ${errMsg}`);
      if (activeWork.length > 1 && (provider === "claude" || provider === "codex")) {
        activeWork = activeWork.slice(0, Math.ceil(activeWork.length / 2));
        await pushLog(identifier, `${language} · ${batchLabel} retry with ${activeWork.length} clause(s)`);
        try {
          questions = await fetchMcqQuestions(
            provider,
            MCQ_CLAUSE_SYSTEM,
            buildClauseMcqUserPrompt(language, sop.identifier, activeWork),
            identifier,
            language,
            `${batchLabel} retry`,
          );
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message.slice(0, 100) : String(retryErr).slice(0, 100);
          await pushLog(identifier, `${language} · ${batchLabel} retry failed — ${retryMsg}`);
          continue;
        }
      } else {
        continue;
      }
    }

    if (!questions?.length) {
      await pushLog(identifier, `${language} · ${batchLabel}: model returned no questions`);
      continue;
    }

    questions = reconcileClauseRefs(questions, activeWork);
    const activeIds = new Set(activeWork.map((c) => c.id));

    const post = await shouldHaltGeneration(identifier, language);
    bankTotal = post.bankTotal;
    if (post.halt && post.reason === "cancel") {
      await handleGenerationHalt(identifier, language, "cancel", bankTotal);
    }
    if (post.halt && post.reason === "cap") {
      await pushLog(identifier, `${language} · bank at ${bankTotal}/${MCQ_BANK_CAP} — stopping`);
      return;
    }

    const insertRoom = MCQ_BANK_CAP - bankTotal;
    if (insertRoom <= 0) return;

    const candidates: BankInputMcq[] = [];
    const accepted: GeneratedMCQ[] = [];
    const batchSeen = [...seenQuestions];
    const batchRefCounts = new Map(refCounts);
    const batchFactIds = new Set(usedFactIds);
    for (const q of questions) {
      if (!clauseRefMatchesBatch(q.sopReference ?? "", activeWork)) continue;
      if (!isAcceptableMcq(q, batchSeen, batchRefCounts, activeIds, { usedFactIds: batchFactIds })) continue;
      batchSeen.push(q.question);
      const ref = normalizeMcqClauseRef(q.sopReference);
      if (ref) batchRefCounts.set(ref, (batchRefCounts.get(ref) ?? 0) + 1);
      const fid = q.factId ? normalizeKnowledgeFactId(q.factId) : "";
      if (fid) batchFactIds.add(fid);
      accepted.push(q);
      candidates.push(toBankInput(q));
      if (candidates.length >= insertRoom) break;
    }

    if (candidates.length === 0 && questions.length > 0) {
      await pushLog(
        identifier,
        `${language} · ${batchLabel}: ${questions.length} parsed but 0 accepted (check clause refs / duplicates)`,
      );
    }

    const prevBankTotal = bankTotal;
    const batchResult = await onBatchDone({ batchesDone: batchNum, newMcqs: candidates });
    bankTotal = batchResult.bankTotal;
    syncInsertedMcqs(accepted, batchResult.insertedTexts, seenQuestions, refCounts, usedFactIds);

    await pushLog(
      identifier,
      `${language} · clause batch ${batchNum}: +${bankTotal - prevBankTotal} → ${bankTotal}/${MCQ_BANK_CAP}`,
    );
  }

  bankTotal = await activeBankCount(identifier, language);
  if (bankTotal >= MCQ_BANK_CAP) return;

  const freshDedup = await loadBankDedupState(identifier, language);
  await pushLog(
    identifier,
    `${language} · ${bankTotal}/${MCQ_BANK_CAP} after clauses — excerpt fill for remainder`,
  );
  await generateForLanguageLegacy(
    identifier, sop, language, bankTotal, freshDedup,
    ctx, onBatchDone, provider,
  );
}

function formatAvoidQuestionHint(questions: string[], max = 15): string {
  if (!questions.length) return "";
  const sample = questions.slice(-max);
  return `\n\nDo NOT repeat or closely paraphrase these existing questions — use a different scenario or angle:\n${sample
    .map((q, i) => `${i + 1}. ${q.slice(0, 120)}`)
    .join("\n")}`;
}

const CREATIVE_ANGLES = [
  "a deviation or abnormal condition the operator must handle correctly",
  "choosing the correct immediate action when something is out of spec",
  "supervisor review, escalation, or approval decision",
  "correct step sequence when two steps could be confused",
  "documentation or recording requirement in a realistic context",
  "safety, GMP, or compliance judgment call",
  "equipment reading at a limit — what should happen next",
  "why a critical step matters (purpose / risk if skipped)",
] as const;

function buildCreativeUserPrompt(
  language: string,
  sop: ISOP,
  batchNeed: number,
  bankTotal: number,
  batch: number,
  excerpt: string,
  avoidHint: string,
): string {
  const gap = MCQ_BANK_CAP - bankTotal;
  const angle = CREATIVE_ANGLES[batch % CREATIVE_ANGLES.length];
  return `${language} · ${sop.identifier}
The bank has ${bankTotal}/${MCQ_BANK_CAP} MCQs — ${gap} more needed. Standard coverage is exhausted.

Generate exactly ${batchNeed} NEW scenario-based MCQs. Focus this batch on: ${angle}.
Each question must be answerable from the SOP below but use a fresh scenario stem — not verbatim recall.
${avoidHint}

SOP:
${excerpt}`;
}

function sopExcerptForMcqBatch(
  raw: string,
  batch: number,
  maxChars: number,
  preferFull: boolean,
): string {
  const normalized = normalizeSopTextForMcq(raw);
  if (!normalized) return "";
  if (preferFull && normalized.length <= maxChars) return normalized;
  if (preferFull && normalized.length > maxChars) return normalized.slice(0, maxChars);
  return mcqPromptSopExcerpt(raw, batch, maxChars, MCQ_CONTENT_CHUNKS);
}

/** Legacy excerpt batches — bulk fill toward MCQ_BANK_CAP. */
async function generateForLanguageLegacy(
  identifier: string,
  sop: ISOP,
  language: "English" | "Gujarati",
  bankCountAtStart: number,
  dedupAtStart: BankDedupState,
  ctx: RunCtx,
  onBatchDone: (p: { batchesDone: number; newMcqs: BankInputMcq[] }) => Promise<{ bankTotal: number; insertedTexts: string[] }>,
  provider?: LlmProvider,
): Promise<void> {
  const seenQuestions = [...dedupAtStart.questions];
  const refCounts = new Map(dedupAtStart.refCounts);
  const usedFactIds = new Set(dedupAtStart.usedFactIds);
  let bankTotal = bankCountAtStart;
  let emptyResponseStreak = 0;
  let zeroInsertStreak = 0;

  const contentLimit =
    provider === "ollama" ? MCQ_CONTENT_LIMIT_OLLAMA :
    provider === "claude" ? mcqContentLimitClaude() :
    provider === "codex" ? mcqContentLimitCodex() :
    MCQ_CONTENT_LIMIT;

  const gap = MCQ_BANK_CAP - bankCountAtStart;
  const batchSize = legacyBatchSize(provider, gap);
  const legacyMax = maxLegacyBatches(gap, batchSize);

  for (let batch = 0; batch < legacyMax && bankTotal < MCQ_BANK_CAP; batch++) {
    if (await isMcqGenerationCancelled(identifier)) {
      await handleGenerationHalt(identifier, language, "cancel", bankTotal);
    }

    bankTotal = await activeBankCount(identifier, language);
    if (bankTotal >= MCQ_BANK_CAP) return;

    const batchNeed = legacyBatchSize(provider, MCQ_BANK_CAP - bankTotal);
    if (batchNeed <= 0) break;

    const excerpt = mcqPromptSopExcerpt(sop.content, batch, contentLimit, MCQ_CONTENT_CHUNKS);
    const avoidHint = formatAvoidQuestionHint(seenQuestions);
    const userPrompt = `${language} · ${sop.identifier}
Generate exactly ${batchNeed} unique MCQs from this SOP excerpt. Section ${(batch % MCQ_CONTENT_CHUNKS) + 1}/${MCQ_CONTENT_CHUNKS}. Short options.
Each question must test a different fact or procedure — no overlap with existing bank questions.
${avoidHint}

SOP:
${excerpt}`;

    let questions: GeneratedMCQ[];
    try {
      questions = await fetchMcqQuestions(provider, MCQ_LEGACY_SYSTEM, userPrompt, identifier, language, `fill ${batch + 1}`);
    } catch (err) {
      ctx.failedBatches++;
      const errMsg = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
      await pushLog(identifier, `${language} · fill batch ${batch + 1} failed — ${errMsg}`);
      continue;
    }

    if (await isMcqGenerationCancelled(identifier)) {
      await handleGenerationHalt(identifier, language, "cancel", bankTotal);
    }

    if (!questions?.length) {
      await pushLog(identifier, `${language} · fill batch ${batch + 1}: model returned no questions`);
      emptyResponseStreak++;
      if (emptyResponseStreak >= MCQ_MAX_EMPTY_BATCHES) {
        await pushLog(identifier, `${language} · stopping fill — ${emptyResponseStreak} empty responses in a row`);
        break;
      }
      continue;
    }
    emptyResponseStreak = 0;

    const candidates: BankInputMcq[] = [];
    const accepted: GeneratedMCQ[] = [];
    const batchSeen = [...seenQuestions];
    const batchRefCounts = new Map(refCounts);
    const batchFactIds = new Set(usedFactIds);
    let rejectedDup = 0;
    for (const q of questions) {
      if (candidates.length >= batchNeed) break;
      if (seenQuestions.some((eq) => isDuplicateMcqQuestionForGeneration(q.question, eq))) {
        rejectedDup++;
        continue;
      }
      if (!isAcceptableMcq(q, batchSeen, batchRefCounts, undefined, {
        skipClauseRefCap: true,
        usedFactIds: batchFactIds,
      })) continue;
      batchSeen.push(q.question);
      const ref = normalizeMcqClauseRef(q.sopReference);
      if (ref) batchRefCounts.set(ref, (batchRefCounts.get(ref) ?? 0) + 1);
      const fid = q.factId ? normalizeKnowledgeFactId(q.factId) : "";
      if (fid) batchFactIds.add(fid);
      accepted.push(q);
      candidates.push(toBankInput(q));
    }

    if (candidates.length === 0 && questions.length > 0) {
      await pushLog(
        identifier,
        `${language} · fill batch ${batch + 1}: ${questions.length} parsed, 0 accepted` +
          (rejectedDup > 0 ? ` (${rejectedDup} near-duplicates of existing bank)` : ""),
      );
    }

    const prev = bankTotal;
    const batchResult = await onBatchDone({ batchesDone: batch + 1, newMcqs: candidates });
    bankTotal = batchResult.bankTotal;
    syncInsertedMcqs(accepted, batchResult.insertedTexts, seenQuestions, refCounts, usedFactIds);

    if (bankTotal - prev === 0) {
      zeroInsertStreak++;
      const nearCap = MCQ_BANK_CAP - bankTotal <= 15;
      const maxZero = nearCap
        ? 2
        : bankTotal < MCQ_BANK_CAP / 2
          ? MCQ_MAX_ZERO_INSERT_ROUNDS
          : MCQ_MAX_EMPTY_BATCHES;
      if (zeroInsertStreak >= maxZero) {
        await pushLog(
          identifier,
          nearCap
            ? `${language} · standard fill stalled at ${bankTotal}/${MCQ_BANK_CAP} — switching to creative scenarios`
            : `${language} · stopping fill at ${bankTotal}/${MCQ_BANK_CAP} — ${zeroInsertStreak} rounds with no new MCQs`,
        );
        break;
      }
    } else {
      zeroInsertStreak = 0;
    }
  }

  bankTotal = await activeBankCount(identifier, language);
  if (bankTotal >= MCQ_BANK_CAP) return;

  const freshDedup = await loadBankDedupState(identifier, language);
  await generateForLanguageCreative(
    identifier, sop, language, bankTotal, freshDedup, ctx, onBatchDone, provider,
  );
}

/** Scenario-based creative fill when standard excerpt/clause passes cannot add more unique MCQs. */
async function generateForLanguageCreative(
  identifier: string,
  sop: ISOP,
  language: "English" | "Gujarati",
  bankCountAtStart: number,
  dedupAtStart: BankDedupState,
  ctx: RunCtx,
  onBatchDone: (p: { batchesDone: number; newMcqs: BankInputMcq[] }) => Promise<{ bankTotal: number; insertedTexts: string[] }>,
  provider?: LlmProvider,
): Promise<void> {
  if (bankCountAtStart >= MCQ_BANK_CAP) return;

  const seenQuestions = [...dedupAtStart.questions];
  const refCounts = new Map(dedupAtStart.refCounts);
  const usedFactIds = new Set(dedupAtStart.usedFactIds);
  let bankTotal = bankCountAtStart;
  let emptyResponseStreak = 0;
  let zeroInsertStreak = 0;

  const contentLimit =
    provider === "ollama" ? MCQ_CONTENT_LIMIT_OLLAMA :
    provider === "claude" ? mcqContentLimitClaude() :
    provider === "codex" ? mcqContentLimitCodex() :
    MCQ_CONTENT_LIMIT;

  const gap = MCQ_BANK_CAP - bankCountAtStart;
  const creativeMax = maxCreativeBatches(gap);
  await pushLog(
    identifier,
    `${language} · creative fill — ${gap} MCQs needed · up to ${creativeMax} scenario rounds`,
  );

  for (let batch = 0; batch < creativeMax && bankTotal < MCQ_BANK_CAP; batch++) {
    if (await isMcqGenerationCancelled(identifier)) {
      await handleGenerationHalt(identifier, language, "cancel", bankTotal);
    }

    bankTotal = await activeBankCount(identifier, language);
    if (bankTotal >= MCQ_BANK_CAP) return;

    const batchNeed = creativeBatchSize(provider, MCQ_BANK_CAP - bankTotal);
    if (batchNeed <= 0) break;

    const preferFull = MCQ_BANK_CAP - bankTotal <= 15;
    const excerpt = sopExcerptForMcqBatch(sop.content, batch, contentLimit, preferFull);
    const avoidMax = preferFull ? 25 : 18;
    const avoidHint = formatAvoidQuestionHint(seenQuestions, avoidMax);
    const userPrompt = buildCreativeUserPrompt(
      language, sop, batchNeed, bankTotal, batch, excerpt, avoidHint,
    );

    let questions: GeneratedMCQ[];
    try {
      questions = await fetchMcqQuestions(
        provider,
        MCQ_CREATIVE_SYSTEM,
        userPrompt,
        identifier,
        language,
        `creative ${batch + 1}`,
      );
    } catch (err) {
      ctx.failedBatches++;
      const errMsg = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
      await pushLog(identifier, `${language} · creative batch ${batch + 1} failed — ${errMsg}`);
      continue;
    }

    if (await isMcqGenerationCancelled(identifier)) {
      await handleGenerationHalt(identifier, language, "cancel", bankTotal);
    }

    if (!questions?.length) {
      await pushLog(identifier, `${language} · creative batch ${batch + 1}: model returned no questions`);
      emptyResponseStreak++;
      if (emptyResponseStreak >= MCQ_MAX_EMPTY_BATCHES) {
        await pushLog(identifier, `${language} · stopping creative fill — ${emptyResponseStreak} empty responses`);
        break;
      }
      continue;
    }
    emptyResponseStreak = 0;

    const candidates: BankInputMcq[] = [];
    const accepted: GeneratedMCQ[] = [];
    const batchSeen = [...seenQuestions];
    const batchRefCounts = new Map(refCounts);
    const batchFactIds = new Set(usedFactIds);
    let rejectedDup = 0;
    for (const q of questions) {
      if (candidates.length >= batchNeed) break;
      if (seenQuestions.some((eq) => isDuplicateMcqQuestionForGeneration(q.question, eq))) {
        rejectedDup++;
        continue;
      }
      if (!isAcceptableMcq(q, batchSeen, batchRefCounts, undefined, {
        skipClauseRefCap: true,
        usedFactIds: batchFactIds,
      })) continue;
      batchSeen.push(q.question);
      const ref = normalizeMcqClauseRef(q.sopReference);
      if (ref) batchRefCounts.set(ref, (batchRefCounts.get(ref) ?? 0) + 1);
      const fid = q.factId ? normalizeKnowledgeFactId(q.factId) : "";
      if (fid) batchFactIds.add(fid);
      accepted.push(q);
      candidates.push({ ...toBankInput(q), isCreative: true });
    }

    if (candidates.length === 0 && questions.length > 0) {
      await pushLog(
        identifier,
        `${language} · creative batch ${batch + 1}: ${questions.length} parsed, 0 accepted` +
          (rejectedDup > 0 ? ` (${rejectedDup} near-duplicates)` : ""),
      );
    }

    const prev = bankTotal;
    const batchResult = await onBatchDone({ batchesDone: batch + 1, newMcqs: candidates });
    bankTotal = batchResult.bankTotal;
    syncInsertedMcqs(accepted, batchResult.insertedTexts, seenQuestions, refCounts, usedFactIds);

    await pushLog(
      identifier,
      `${language} · creative batch ${batch + 1}: +${bankTotal - prev} → ${bankTotal}/${MCQ_BANK_CAP}`,
    );

    if (bankTotal - prev === 0) {
      zeroInsertStreak++;
      if (zeroInsertStreak >= MCQ_MAX_ZERO_INSERT_ROUNDS) {
        await pushLog(
          identifier,
          `${language} · creative fill ended at ${bankTotal}/${MCQ_BANK_CAP} — could not add more unique questions`,
        );
        break;
      }
    } else {
      zeroInsertStreak = 0;
    }
  }

  bankTotal = await activeBankCount(identifier, language);
  if (bankTotal < MCQ_BANK_CAP) {
    await pushLog(
      identifier,
      `${language} · finished at ${bankTotal}/${MCQ_BANK_CAP} — use Continue to retry creative fill`,
    );
  }
}

async function generateForLanguage(
  identifier: string,
  sop: ISOP,
  language: "English" | "Gujarati",
  bankCountAtStart: number,
  dedupAtStart: BankDedupState,
  ctx: RunCtx,
  onBatchDone: (p: { batchesDone: number; newMcqs: BankInputMcq[] }) => Promise<{ bankTotal: number; insertedTexts: string[] }>,
  provider?: LlmProvider,
  mode: McqGenMode = "generate",
): Promise<void> {
  if (shouldUseFactPipeline(provider) && mode !== "continue") {
    await pushLog(identifier, `${language} · fact-based pipeline (extract → one MCQ/fact → local dedup)`);
    await generateForLanguageFactBased(
      identifier,
      sop,
      language,
      bankCountAtStart,
      dedupAtStart,
      ctx,
      onBatchDone,
      {
        pushLog,
        shouldHaltGeneration,
        handleGenerationHalt,
        activeBankCount,
        fetchMcqQuestions,
        generateForLanguageLegacy,
        generateForLanguageCreative,
        toBankInput,
      },
      provider,
    );
    return;
  }

  const gap = MCQ_BANK_CAP - bankCountAtStart;
  const batchSize = legacyBatchSize(provider, gap);
  if (shouldUseFastFill(mode, bankCountAtStart, gap, provider)) {
    const maxRounds = maxLegacyBatches(gap, batchSize);
    await pushLog(
      identifier,
      `${language} · fast fill — ${gap} MCQs needed · ${batchSize}/call · up to ${maxRounds} rounds`,
    );
    await generateForLanguageLegacy(
      identifier, sop, language, bankCountAtStart, dedupAtStart, ctx, onBatchDone, provider,
    );
    return;
  }
  await generateForLanguageClauseWise(
    identifier, sop, language, bankCountAtStart, dedupAtStart, ctx, onBatchDone, provider, mode,
  );
}

/** Pick the best SOP record per language for generation (DOCX preferred over PDF). */
function representativesByLanguage(sops: ISOP[]): Map<"English" | "Gujarati", ISOP> {
  const byLang = new Map<"English" | "Gujarati", ISOP>();
  for (const s of sops) {
    const lang = (s.language ?? "English") as "English" | "Gujarati";
    const cur = byLang.get(lang);
    if (!cur || scoreSopRecordForMcq(s) > scoreSopRecordForMcq(cur)) byLang.set(lang, s);
  }
  return byLang;
}

/**
 * Gujarati questions for an SOP with no readable Gujarati source document.
 *
 * Generating a second, independent bank from the English text — what this code
 * used to do — is what produced banks labelled Gujarati that hold English
 * questions: the target language reached the model only as a prompt prefix, the
 * clauses it saw were English, and nothing checked the script that came back.
 *
 * Translate the English bank instead. One question keeps one answer key and
 * gains a verified Gujarati rendering on the master (`lib/mcqTranslation.ts`,
 * which rejects anything that changes option order or the numbers an answer
 * turns on). The LMS quiz already prefers those translations and falls back to a
 * standalone Gujarati bank only when they are absent, so a translated SOP stops
 * serving its old English-in-Gujarati set without that bank being touched.
 *
 * Translation runs through the Codex CLI, which Vercel cannot run; when it is
 * unavailable the pass is skipped with an actionable log rather than failing the
 * generation run.
 */
async function translateEnglishBankToGujarati(
  identifier: string,
  onProgress: (progress: { translated: number; total: number }) => Promise<void>,
  mode: McqGenMode = "generate",
): Promise<void> {
  const bankRef = await MCQBank.findOne({
    sopIdentifier: escapeId(identifier),
    isObsolete: { $ne: true },
    $or: [{ language: "English" }, { language: { $exists: false } }],
  })
    .select("_id")
    .lean();
  if (!bankRef) {
    await pushLog(identifier, "Gujarati · no English bank to translate from — skipping");
    return;
  }
  const bankId = String(bankRef._id);

  if (!(await canStartCodexMcqHere())) {
    await pushLog(
      identifier,
      "Gujarati · translation needs the local Codex worker — run: " +
        `npx tsx scripts/translate-mcqs.ts --sop ${identifier}`,
    );
    return;
  }

  await ensureBankMcqIds(bankId);
  const fresh = await MCQBank.findOne({ _id: bankRef._id }).select("mcqs").lean();
  // "Regenerate" means redo the Gujarati, not fill gaps in it. Without this the
  // pass skips every question that already has a translation, so a regenerate on
  // a fully translated bank does nothing at all and reports success.
  const redoAll = mode === "regenerate";
  const bankMcqs = (fresh?.mcqs ?? []) as Parameters<typeof toMasterMcqs>[0];
  // Progress is reported against every translatable question, not just the ones
  // this pass has work for — otherwise a bank that is already translated shows
  // 0/100 instead of the 100 translations it actually has.
  const total = toMasterMcqs(bankMcqs, "gu", { includeTranslated: true }).length;
  const masters = redoAll ? toMasterMcqs(bankMcqs, "gu", { includeTranslated: true }) : toMasterMcqs(bankMcqs, "gu");
  const alreadyTranslated = redoAll ? 0 : total - masters.length;
  if (!masters.length) {
    await pushLog(
      identifier,
      `Gujarati · every English question already has a translation (${total}/${total})`,
    );
    await onProgress({ translated: total, total });
    return;
  }
  if (redoAll) {
    await pushLog(identifier, `Gujarati · regenerate — re-translating all ${masters.length} question(s)`);
  }

  const batches: MasterMcq[][] = [];
  for (let i = 0; i < masters.length; i += TRANSLATION_BATCH_SIZE) {
    batches.push(masters.slice(i, i + TRANSLATION_BATCH_SIZE));
  }
  const lanes = Math.max(1, Math.min(TRANSLATION_CONCURRENCY, batches.length));

  await pushLog(
    identifier,
    `Gujarati · translating ${masters.length} English question(s) — ` +
      `${batches.length} batch(es) of ${TRANSLATION_BATCH_SIZE}, ${lanes} in parallel`,
  );
  await onProgress({ translated: alreadyTranslated, total });

  let translated = 0;
  let rejected = 0;
  let cancelled = false;
  let next = 0;

  // Each batch is its own `codex exec`, so they overlap instead of queueing. Writes
  // touch disjoint `mcqs.<i>.translations.gu` paths, making concurrent saves safe.
  const runLane = async (): Promise<void> => {
    for (;;) {
      const batch = batches[next++];
      if (!batch || cancelled) return;
      if (await isMcqGenerationCancelled(identifier)) {
        cancelled = true;
        return;
      }
      try {
        const { translations, failures } = await translateMcqBatch(batch, {
          lang: "gu",
          runKey: identifier,
          signal: getMcqRunSignal(identifier),
        });

        // A rejected question gets one solo retry — a bad batch is usually one
        // question confusing the model, not all of them.
        for (const failure of failures) {
          const master = batch.find((m) => m.mcqId === failure.mcqId);
          if (!master || cancelled) continue;
          const retry = await translateMcqBatch([master], {
            lang: "gu",
            runKey: identifier,
            signal: getMcqRunSignal(identifier),
          });
          const one = retry.translations.get(master.mcqId);
          if (one) translations.set(master.mcqId, one);
          else rejected += 1;
        }

        // Read-then-add across an await would lose a sibling lane's increment
        // (`x += await f()` reads x before suspending) — resolve first, add after.
        const saved = await saveBankTranslations(bankId, "gu", translations);
        translated += saved;
      } catch (error) {
        rejected += batch.length;
        await pushLog(
          identifier,
          `Gujarati · translation batch failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await onProgress({ translated: alreadyTranslated + translated, total });
    }
  };

  await Promise.all(Array.from({ length: lanes }, runLane));

  if (cancelled) {
    await pushLog(identifier, `Gujarati · stop requested — halting at ${translated} translated`);
    throw new McqGenerationCancelledError();
  }

  await pushLog(
    identifier,
    `Gujarati · translation complete — ${translated}/${masters.length} translated this run ` +
      `(bank now ${alreadyTranslated + translated}/${total})` +
      (rejected ? `, ${rejected} rejected by the equivalence guards` : ""),
  );
}

/** Resolve generate-vs-regenerate (or honour an explicit "continue"), reset the
 *  progress job to "queued", and optionally kick off the background run. */
export type EnqueueMcqOptions = {
  /** When false, persist a queued job for a local Codex worker instead of running here. */
  startWorker?: boolean;
};

export async function canStartCodexMcqHere(): Promise<boolean> {
  if (process.env.VERCEL) return false;
  const health = await checkCodexCliHealth();
  return Boolean(health.ok && health.loggedIn);
}

export async function enqueueMcqGeneration(
  identifier: string,
  provider?: LlmProvider,
  modeOverride?: McqGenMode,
  languageScope?: McqGenLanguage,
  options?: EnqueueMcqOptions,
): Promise<{
  identifier: string;
  mode: McqGenMode;
  languageScope?: McqGenLanguage;
  status: "queued" | "running";
  startedAt: string;
  alreadyRunning?: boolean;
  awaitingLocalWorker?: boolean;
}> {
  await connectDB();
  const idRegex = escapeId(identifier);
  const exists = await SOP.exists({ identifier: idRegex });
  if (!exists) throw new Error(`SOP not found: ${identifier}`);

  const startWorker = options?.startWorker !== false;
  const effectiveProvider: LlmProvider = provider ?? "claude";

  let mode: McqGenMode;
  if (modeOverride) {
    mode = modeOverride;
  } else if (languageScope) {
    const hasLang = await hasActiveBankForLang(identifier, languageScope);
    mode = hasLang ? "regenerate" : "generate";
  } else {
    const hasActive = await MCQBank.exists({ sopIdentifier: idRegex, isObsolete: { $ne: true } });
    mode = hasActive ? "regenerate" : "generate";
  }

  const inFlight = await MCQGenJob.findOne({
    ...mcqGenJobMatchFilter(identifier),
    status: { $in: ["queued", "running"] },
  }).lean();
  if (inFlight) {
    const healed = await healOrphanedMcqGenJobIfNeeded(identifier, inFlight);
    if (!healed) {
      return {
        identifier: String(inFlight.identifier ?? identifier),
        mode: (inFlight.mode ?? mode) as McqGenMode,
        languageScope: (inFlight.languageScope ?? undefined) as McqGenLanguage | undefined,
        status: inFlight.status as "queued" | "running",
        startedAt: new Date(inFlight.startedAt ?? Date.now()).toISOString(),
        alreadyRunning: true,
        awaitingLocalWorker: Boolean(inFlight.awaitingLocalWorker),
      };
    }
  }

  const startedAt = new Date();
  if (startWorker) beginMcqRun(identifier);

  await upsertMcqGenJob(identifier, {
    mode,
    languageScope: languageScope ?? null,
    provider: effectiveProvider,
    awaitingLocalWorker: !startWorker,
    status: "queued",
    phase: startWorker ? "Queued" : "Waiting for local Codex worker",
    percent: 0,
    languages: [],
    totalInserted: 0,
    totalSkipped: 0,
    totalFailedBatches: 0,
    error: null,
    cancelRequested: false,
    startedAt,
    finishedAt: null,
  });

  await SOP.updateMany(
    { identifier: idRegex, isObsolete: { $ne: true } },
    { pipelineStatus: "mcq_generating" },
  );

  if (startWorker) {
    triggerMcqGenerationAsync(identifier, mode, effectiveProvider, languageScope);
  } else {
    console.log(`[mcq-gen] ${identifier} queued for local Codex worker`);
  }
  return {
    identifier,
    mode,
    languageScope,
    status: "queued",
    startedAt: startedAt.toISOString(),
    awaitingLocalWorker: !startWorker,
  };
}

/** Queue Codex MCQs for a newly uploaded SOP. Skips SOPs that already have a bank. */
export async function enqueueMcqGenerationForNewSop(identifier: string): Promise<{
  skipped?: boolean;
  reason?: string;
  awaitingLocalWorker?: boolean;
}> {
  await connectDB();
  const idRegex = escapeId(identifier);
  const hasActive = await MCQBank.exists({ sopIdentifier: idRegex, isObsolete: { $ne: true } });
  if (hasActive) {
    return { skipped: true, reason: "bank_exists" };
  }
  const startWorker = await canStartCodexMcqHere();
  const job = await enqueueMcqGeneration(identifier, "codex", "generate", undefined, { startWorker });
  return { awaitingLocalWorker: job.awaitingLocalWorker };
}

export async function runMcqGeneration(
  identifier: string,
  modeArg?: McqGenMode,
  provider?: LlmProvider,
  languageScope?: McqGenLanguage,
): Promise<{ identifier: string; totalApproved: number; totalRecycled: number }> {
  const rk = mcqRunKey(identifier);
  if (runningMcqIdentifiers.has(rk) && isMcqRunActiveInProcess(identifier)) {
    console.warn(`[mcq-gen] ${identifier} — already running in this process, skipping duplicate`);
    return { identifier, totalApproved: 0, totalRecycled: 0 };
  }
  if (runningMcqIdentifiers.has(rk)) {
    runningMcqIdentifiers.delete(rk);
  }
  runningMcqIdentifiers.add(rk);
  beginMcqRun(identifier);

  try {
  await connectDB();
  const effectiveProvider: LlmProvider = provider ?? "claude";

  const sops = await SOP.find({ identifier: escapeId(identifier) });
  if (!sops.length) {
    await upsertMcqGenJob(identifier, {
      mode: modeArg ?? "generate",
      status: "failed",
      phase: "SOP not found",
      error: `SOP not found: ${identifier}`,
      finishedAt: new Date(),
    });
    throw new Error(`SOP not found: ${identifier}`);
  }

  const sopIds = sops.map((s) => s._id.toString());
  const idRegex = escapeId(identifier);

  // Authoritative mode: regenerate when an active bank already exists.
  let mode = modeArg;
  if (!mode) {
    const hasActive = await MCQBank.exists({ sopIdentifier: idRegex, isObsolete: { $ne: true } });
    mode = hasActive ? "regenerate" : "generate";
  }

  const reps = representativesByLanguage(sops);
  // A Gujarati bank must come from Gujarati source text. When there is none,
  // the English bank is translated after the run instead of a second bank being
  // generated from English text. Gujarati counts as wanted when it was asked for
  // explicitly or a Gujarati bank already exists for this SOP.
  const gujaratiRep = reps.get("Gujarati");
  const gujaratiSourceReadable = Boolean(gujaratiRep && scoreSopRecordForMcq(gujaratiRep) >= 50);
  const translateGujarati =
    !gujaratiSourceReadable &&
    (languageScope === "Gujarati" || (await hasActiveBankForLang(identifier, "Gujarati")));

  // Fold in any linked annexure files (extracted live, same as compliance audits
  // do via buildAnnexureSupplement) so clause parsing + prompts see annexure
  // content. This mutates only the in-memory record — sop.content is never
  // persisted back to SOP, so the canonical document/viewer/compliance-without-
  // annexures paths are unaffected; only mcqClauseCache (keyed by content hash)
  // gets rebuilt to match, exactly like a normal content change would.
  const annexureResult = await buildAnnexureSupplementDetailed(sops);
  if (annexureResult.text) {
    for (const sop of new Set(reps.values())) {
      sop.content = `${sop.content ?? ""}\n\n${annexureResult.text}`;
    }
  }
  // Recorded on every bank this run writes, so the MCQ registry can tell whether
  // a bank's questions actually saw annexure text (annexures are often linked
  // after MCQs were generated).
  const annexureUsage: IMcqAnnexureUsage = {
    linkedCount: countLinkedAnnexureDocuments(sops),
    includedCount: annexureResult.included.length,
    skippedCount: annexureResult.skipped.length,
    includedLabels: annexureResult.included.map((a) => a.label),
    recordedAt: new Date(),
  };

  let eligible = [...reps.entries()].filter(([, sop]) => scoreSopRecordForMcq(sop) >= 50);
  if (languageScope) {
    eligible = eligible.filter(([lang]) => lang === languageScope);
  }

  // No language has readable text — the stored content is an image-only PDF or a
  // failed extraction. Generating from it just yields generic, ungrounded MCQs,
  // so fail fast with an actionable message instead of producing junk. A
  // Gujarati-only request is the exception: there is nothing to generate, but the
  // English bank can still be translated.
  if (!eligible.length && !translateGujarati) {
    await upsertMcqGenJob(identifier, {
      mode,
      languageScope: languageScope ?? null,
      status: "failed",
      phase: "No readable SOP content",
      percent: 0,
      error:
        languageScope
          ? `No readable ${languageScope} SOP text found (image-only PDF or failed extraction). Upload a text-based DOCX/PDF, then try again.`
          : "No readable SOP text found (the stored content is an image-only PDF or failed extraction). " +
            "Upload a text-based DOCX/PDF for this SOP, then regenerate.",
      finishedAt: new Date(),
    });
    await SOP.updateMany({ _id: { $in: sopIds } }, { pipelineStatus: "failed" });
    throw new Error("No readable SOP content to generate from");
  }

  const langProgress: IMcqGenLangProgress[] = eligible.map(([lang]) => ({
    language: lang,
    status: "pending",
    batchesDone: 0,
    batchesTotal: 0,
    collected: 0,
    target: MCQ_BANK_CAP,
    inserted: 0,
    skipped: 0,
  }));

  const ctx: RunCtx = { overloadHits: 0, failedBatches: 0 };

  const persist = async (extra: Record<string, unknown> = {}) => {
    await updateMcqGenJob(identifier, {
      mode,
      languages: langProgress,
      percent: overallPercent(langProgress),
      totalFailedBatches: ctx.failedBatches,
      ...extra,
    });
  };

  await upsertMcqGenJob(identifier, {
    mode,
    languageScope: languageScope ?? null,
    awaitingLocalWorker: false,
    status: "running",
    phase: mode === "regenerate" ? "Regenerating — starting…" : mode === "continue" ? "Continuing — starting…" : "Generating — starting…",
    percent: 0,
    languages: langProgress,
    totalInserted: 0,
    totalSkipped: 0,
    totalFailedBatches: 0,
    error: null,
    cancelRequested: false,
    startedAt: new Date(),
    finishedAt: null,
  });

  await SOP.updateMany({ _id: { $in: sopIds } }, { pipelineStatus: "mcq_generating" });

  const providerLabel = mcqProviderLabel(effectiveProvider);
  // A Gujarati-only request with no Gujarati source generates nothing — the run
  // is the translation pass alone.
  const langLabels = eligible.map(([lang]) => lang).join(" + ") || "Gujarati (translation)";
  await pushLog(identifier, `Starting ${mode} · ${langLabels} · provider: ${providerLabel}`);
  await pushLog(
    identifier,
    annexureUsage.linkedCount === 0
      ? "No annexure connected — generating from the main SOP content only"
      : annexureUsage.includedCount > 0
        ? `Annexures: including ${annexureUsage.includedCount} of ${annexureUsage.linkedCount} linked file(s)`
        : `Annexures: ${annexureUsage.linkedCount} linked but none readable — generating from the main SOP content only`,
  );
  if (translateGujarati) {
    await pushLog(
      identifier,
      "No readable Gujarati SOP text — Gujarati questions will be translated from the English bank, not generated as a separate set",
    );
  }
  if (effectiveProvider === "claude" && !anthropicMcqApiAvailable()) {
    await pushLog(
      identifier,
      `Tip: add ANTHROPIC_API_KEY to .env.local for ~10× faster generation (direct API vs Claude CLI)`,
    );
  }
  const gapSample = MCQ_BANK_CAP;
  await pushLog(
    identifier,
    shouldUseFactPipeline(effectiveProvider)
      ? `Target: ${MCQ_BANK_CAP} MCQs/language · fact pipeline (extract facts → 1 MCQ/fact)`
      : `Target: ${MCQ_BANK_CAP} MCQs/language · bulk batches of ${legacyBatchSize(effectiveProvider, gapSample)}`,
  );

  let totalApproved = 0;
  let totalRecycled = 0;
  const verb = mode === "regenerate" ? "Regenerating" : mode === "continue" ? "Continuing" : "Generating";

  try {
    for (const lp of langProgress) {
      const sop = reps.get(lp.language)!;
      lp.status = "running";

      // For regenerate: archive the old bank upfront so new MCQs start landing
      // in a fresh bank immediately. "continue" skips this — it appends to the
      // existing bank without touching the old questions.
      if (mode === "regenerate") {
        const archived = await archiveBankForSop(sop, lp.language);
        if (archived > 0) {
          await pushLog(identifier, `${lp.language} · archived ${archived} existing bank(s) — generating fresh set`);
        }
      }

      let bankCountAtStart =
        mode === "regenerate" ? 0 : await activeBankCount(identifier, lp.language);
      const dedupAtStart =
        mode === "regenerate"
          ? { questions: [] as string[], refCounts: new Map<string, number>(), usedFactIds: new Set<string>() }
          : await loadBankDedupState(identifier, lp.language);
      if (bankCountAtStart >= MCQ_BANK_CAP) {
        lp.status = "done";
        lp.collected = bankCountAtStart;
        await pushLog(identifier, `${lp.language} · already at ${MCQ_BANK_CAP} MCQs — skipping`);
        await persist({ totalInserted: totalApproved, totalSkipped: totalRecycled });
        continue;
      }

      await persist({ phase: `${verb} ${lp.language} · indexing clauses…` });

      const langSopIds = sops
        .filter((s) => ((s.language ?? "English") as string) === lp.language)
        .map((s) => s._id);

      await generateForLanguage(
        identifier,
        sop,
        lp.language,
        bankCountAtStart,
        dedupAtStart,
        ctx,
        async ({ batchesDone, newMcqs }) => {
          const { inserted: batchInserted, skipped: batchSkipped, total: bankTotal, insertedQuestions } =
            await appendGeneratedToBank(
              sop,
              lp.language,
              newMcqs,
              resolveMcqAiModel(effectiveProvider),
              annexureUsage,
            );

          lp.batchesDone = batchesDone;
          lp.collected = bankTotal;
          lp.inserted += batchInserted;
          lp.skipped += batchSkipped;
          totalApproved += batchInserted;
          totalRecycled += batchSkipped;

          await pushLog(
            identifier,
            `${lp.language} · batch ${batchesDone} done — +${batchInserted} new → ${bankTotal}/${MCQ_BANK_CAP} in bank`,
          );
          await persist({
            phase: `${verb} ${lp.language} · ${bankTotal}/${MCQ_BANK_CAP} MCQs`,
            totalInserted: totalApproved,
            totalSkipped: totalRecycled,
          });

          await SOP.updateMany({ _id: { $in: langSopIds } }, { mcqCount: bankTotal });
          return { bankTotal, insertedTexts: insertedQuestions };
        },
        effectiveProvider,
        mode,
      );

      lp.collected = await activeBankCount(identifier, lp.language);
      lp.status = "done";
      await pushLog(
        identifier,
        `${lp.language} · complete — ${lp.collected}/${MCQ_BANK_CAP} in bank (${lp.inserted} added this run, ${lp.skipped} skipped)`,
      );
      await persist({ totalInserted: totalApproved, totalSkipped: totalRecycled });
    }

    if (translateGujarati) {
      // Translations live on the English bank's masters, so there is no Gujarati
      // bank for activeBankCount to see. Give the pass its own progress row and
      // count translated questions into it — otherwise the modal shows GUJ 0/100
      // and a 0% bar for the whole run even while questions are landing.
      const guProgress: IMcqGenLangProgress = langProgress.find((lp) => lp.language === "Gujarati") ?? {
        language: "Gujarati",
        status: "running",
        batchesDone: 0,
        batchesTotal: 0,
        collected: 0,
        target: MCQ_BANK_CAP,
        inserted: 0,
        skipped: 0,
      };
      if (!langProgress.includes(guProgress)) langProgress.push(guProgress);
      guProgress.status = "running";

      await persist({ phase: "Translating English bank into Gujarati…" });
      await translateEnglishBankToGujarati(
        identifier,
        async ({ translated, total }) => {
          guProgress.collected = translated;
          guProgress.inserted = translated;
          guProgress.target = total || MCQ_BANK_CAP;
          await persist({ phase: `Translating Gujarati · ${translated}/${total}` });
        },
        mode,
      );
      guProgress.status = "done";
      await persist();
    }

    await SOP.updateMany({ _id: { $in: sopIds } }, { pipelineStatus: "updating_platform" });
    await SOP.updateMany(
      { _id: { $in: sopIds } },
      { pipelineStatus: "approved", status: "completed" },
    );

    // A Gujarati-only run generates nothing by design — it only translates the
    // English bank. Reporting it through the generation wording ("creative fill
    // could not add unique questions") reads as a failure when the bank is in
    // fact fully translated.
    const translationOnly = !eligible.length && translateGujarati;
    const guRow = langProgress.find((lp) => lp.language === "Gujarati");

    await updateMcqGenJob(identifier, {
      status: "completed",
      phase:
        totalApproved === 0 && ctx.failedBatches > 0
          ? `Finished with errors — 0 MCQs added (${ctx.failedBatches} batch error${ctx.failedBatches === 1 ? "" : "s"}). Try Continue.`
          : translationOnly
            ? `Done — Gujarati translations up to date (${guRow?.collected ?? 0}/${guRow?.target ?? 0})`
          : totalApproved === 0 && langProgress.some((lp) => lp.collected < MCQ_BANK_CAP)
            ? `Done — ${langProgress.map((lp) => `${lp.collected}/${MCQ_BANK_CAP}`).join(", ")} — creative fill could not add unique questions`
            : langProgress.some((lp) => lp.collected < MCQ_BANK_CAP)
              ? `Done — +${totalApproved} added, bank at ${langProgress.map((lp) => `${lp.collected}/${MCQ_BANK_CAP}`).join(", ")}`
              : `Done — +${totalApproved} MCQs added (${mode})`,
      percent: overallPercent(langProgress),
      languages: langProgress,
      totalInserted: totalApproved,
      totalSkipped: totalRecycled,
      totalFailedBatches: ctx.failedBatches,
      error:
        totalApproved === 0 && ctx.failedBatches > 0
          ? `${ctx.failedBatches} batch(es) had errors — try Continue`
          : null,
      finishedAt: new Date(),
    });

    console.log(
      `[mcq-gen] ${identifier} ${mode} complete — inserted ${totalApproved}, skipped ${totalRecycled}, failed batches ${ctx.failedBatches}`,
    );
    invalidateDashboardSopsCache();
    return { identifier, totalApproved, totalRecycled };
  } catch (error) {
    const cancelled =
      error instanceof McqGenerationCancelledError ||
      isMcqRunStopRequested(identifier) ||
      (error instanceof Error && /cancel/i.test(error.message));
    if (cancelled) {
      await finalizeCancelledJob(identifier, langProgress, totalApproved, totalRecycled, ctx.failedBatches);
      await SOP.updateMany(
        { _id: { $in: sopIds } },
        { pipelineStatus: "approved", status: "completed" },
      );
      invalidateDashboardSopsCache();
      return { identifier, totalApproved, totalRecycled };
    }
    const overloaded = error instanceof OverloadAbortError || isGeminiOverloadedError(error);
    await SOP.updateMany({ _id: { $in: sopIds } }, { pipelineStatus: "failed" });
    for (const lp of langProgress) if (lp.status === "running") lp.status = "failed";
    await updateMcqGenJob(identifier, {
      status: "failed",
      phase: overloaded ? "Aborted — service overloaded (503)" : "Failed",
      error: error instanceof Error ? error.message : String(error),
      languages: langProgress,
      totalInserted: totalApproved,
      totalSkipped: totalRecycled,
      totalFailedBatches: ctx.failedBatches,
      finishedAt: new Date(),
    });
    throw error;
  }
  } finally {
    runningMcqIdentifiers.delete(rk);
    endMcqRun(identifier);
  }
}

export function triggerMcqGenerationAsync(
  identifier: string,
  mode?: McqGenMode,
  provider?: LlmProvider,
  languageScope?: McqGenLanguage,
) {
  runMcqGeneration(identifier, mode, provider, languageScope).catch((err) => {
    console.error(`MCQ generation failed for ${identifier}:`, err);
  });
}
