import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import MCQBank from "@/models/MCQBank";
import SOP, { type ISOP } from "@/models/SOP";
import { requireAuth } from "@/lib/withAuth";
import { toBankMcq, type BankInputMcq } from "@/lib/mcq-bank-write";
import { MCQ_REPLACE_SYSTEM, isMetadataOnlyMcq } from "@/lib/mcq-generation-prompts";
import { MCQ_CONTENT_LIMIT_CLAUDE, mcqPromptSopExcerpt, scoreSopRecordForMcq } from "@/lib/mcq-source-text";
import { isDuplicateMcqQuestionForGeneration } from "@/lib/similarity";
import { sopIdentifierMatchFilter } from "@/lib/sopIdentifierNormalize";
import { anthropicMcqApiAvailable, generateAnthropicMcqBatch } from "@/lib/anthropic-mcq";
import { generateClaudeCliMcqBatch, getMcqClaudeModel } from "@/lib/claude-cli";
import type { ParsedMcq } from "@/lib/mcq-json-parse";
import { invalidateMcqBankAggregateCache } from "@/lib/mcqBankAggregateCache";

// Always Claude for individual regeneration, preferring the direct Anthropic API
// (faster) when ANTHROPIC_API_KEY is configured, same fallback order as the main
// MCQ pipeline (lib/mcq-generation.ts callMcqModel).
async function generateWithClaude(system: string, user: string): Promise<ParsedMcq[]> {
  const model = getMcqClaudeModel();
  if (anthropicMcqApiAvailable()) {
    return generateAnthropicMcqBatch(system, user, model);
  }
  return generateClaudeCliMcqBatch(system, user, model);
}

/**
 * Resolve the SOP text for this bank by identifier (+ language), not the bank's
 * stored sopId — SOPs get replaced on re-upload/re-version and the old _id can
 * go stale while sopIdentifier stays stable. Falls back to the stored sopId only
 * as a last resort. Picks the highest-scoring record when multiple exist
 * (DOCX over PDF placeholder), same rule the main MCQ pipeline uses.
 */
async function resolveSopForBank(bank: { sopId: mongoose.Types.ObjectId; sopIdentifier: string; language?: string }): Promise<ISOP | null> {
  const language = bank.language === "Gujarati" ? "Gujarati" : "English";

  const active = await SOP.find({
    ...sopIdentifierMatchFilter(bank.sopIdentifier),
    language,
    isObsolete: { $ne: true },
  }).lean<ISOP[]>();
  if (active.length) {
    return active.reduce((best, cur) => (scoreSopRecordForMcq(cur) > scoreSopRecordForMcq(best) ? cur : best));
  }

  // No non-obsolete match in this language — try any language/obsolete state
  // rather than failing outright.
  const any = await SOP.find(sopIdentifierMatchFilter(bank.sopIdentifier)).lean<ISOP[]>();
  if (any.length) {
    return any.reduce((best, cur) => (scoreSopRecordForMcq(cur) > scoreSopRecordForMcq(best) ? cur : best));
  }

  return SOP.findById(bank.sopId).lean<ISOP | null>();
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Sanity check that the question's SOP quote is actually grounded in the text
 *  Claude was given — guards against a plausible-sounding but hallucinated fact. */
function isGroundedInExcerpt(sopReference: string, excerpt: string): boolean {
  const ref = normalizeForMatch((sopReference || "").replace(/^[\d.]+\s*[-—–]\s*/, ""));
  const words = ref.split(" ").filter((w) => w.length > 3);
  if (words.length === 0) return false;
  const excerptNorm = normalizeForMatch(excerpt);
  const hits = words.filter((w) => excerptNorm.includes(w)).length;
  return hits / words.length >= 0.6;
}

// POST /api/mcq-bank/regenerate-question
// Body: { bankId, questionIndex }
// Regenerates a single MCQ in place, always via Claude regardless of the app's
// configured LLM_PROVIDER — individual regeneration is a Claude-only workflow.
export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { bankId, questionIndex } = await request.json();

    if (!bankId || typeof questionIndex !== "number") {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const bank = await MCQBank.findById(bankId).lean();
    if (!bank) {
      return NextResponse.json({ error: "Bank not found" }, { status: 404 });
    }
    if (questionIndex < 0 || questionIndex >= bank.mcqs.length) {
      return NextResponse.json({ error: "Question index out of range" }, { status: 400 });
    }

    const sop = await resolveSopForBank(bank);
    if (!sop) {
      return NextResponse.json({ error: "Source SOP not found for this bank" }, { status: 404 });
    }

    const language = bank.language === "Gujarati" ? "Gujarati" : "English";
    const current = bank.mcqs[questionIndex];
    // Full existing question set (minus the one being replaced) so the model —
    // and our own dedup check — sees every question already in the bank, not a sample.
    const avoid = bank.mcqs.filter((_, i) => i !== questionIndex).map((m) => m.question);

    const excerpt = mcqPromptSopExcerpt(sop.content, 0, MCQ_CONTENT_LIMIT_CLAUDE);
    const basePrompt =
      `SOP text:\n${excerpt}\n\n` +
      `Replace this question with a NEW, different one testing a different fact from the SOP text above:\n"${current.question}"\n\n` +
      (avoid.length ? `Avoid repeating any of these existing questions:\n- ${avoid.join("\n- ")}\n\n` : "") +
      `Generate exactly 1 new unique question in ${language}, grounded strictly in the SOP text above ` +
      `(sopReference must be a verbatim or near-verbatim quote from it).`;

    function isBad(q: ParsedMcq | undefined): string | null {
      if (!q?.question) return "Claude did not return a usable question";
      if (isMetadataOnlyMcq(q.question)) return "Generated question tested document metadata, not SOP content";
      if ([current.question, ...avoid].some((existing) => isDuplicateMcqQuestionForGeneration(q.question, existing))) {
        return "Generated question duplicated an existing one in the bank";
      }
      if (!isGroundedInExcerpt(q.sopReference ?? "", excerpt)) {
        return "Generated question's SOP reference could not be verified against the SOP text";
      }
      return null;
    }

    const MAX_ATTEMPTS = 3;
    let generated: ParsedMcq | undefined;
    let lastReason = "Claude did not return a usable question";
    const rejectedQuestions: string[] = [];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const prompt =
        attempt === 0
          ? basePrompt
          : `${basePrompt}\n\nIMPORTANT: Your previous attempt(s) were rejected for: ${lastReason}. ` +
            (rejectedQuestions.length
              ? `Also avoid anything resembling: ${rejectedQuestions.join(" | ")}. `
              : "") +
            "Pick a genuinely different, clearly-grounded SOP fact.";

      const questions = await generateWithClaude(MCQ_REPLACE_SYSTEM, prompt);
      const candidate = questions[0];
      const reason = isBad(candidate);
      if (!reason) {
        generated = candidate;
        break;
      }
      lastReason = reason;
      if (candidate?.question) rejectedQuestions.push(candidate.question);
    }

    if (!generated) {
      return NextResponse.json(
        { error: `Regeneration failed after ${MAX_ATTEMPTS} attempts: ${lastReason}` },
        { status: 502 },
      );
    }

    const bankInput: BankInputMcq = {
      question: generated.question,
      optionA: generated.optionA,
      optionB: generated.optionB,
      optionC: generated.optionC,
      optionD: generated.optionD,
      correctAnswer: generated.correctAnswer,
      explanation: generated.explanation ?? "",
      difficulty: generated.difficulty,
      topic: generated.topic ?? "",
      sopReference: generated.sopReference,
    };
    const newMcq = toBankMcq(bankInput, bank.sopIdentifier);
    // Auto-approve on successful regeneration — a fresh Claude-authored question
    // that just replaced the flagged one, mirroring the Approved badge immediately.
    newMcq.isChecked = true;
    newMcq.isReviewed = false;
    newMcq.isSimilar = false;

    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");
    await db.collection("mcqbanks").updateOne(
      { _id: new mongoose.Types.ObjectId(bankId) },
      {
        $set: {
          [`mcqs.${questionIndex}`]: newMcq,
          updatedAt: new Date(),
        },
      },
    );
    invalidateMcqBankAggregateCache();

    return NextResponse.json({ success: true, questionIndex, mcq: newMcq });
  } catch (error) {
    console.error("[regenerate-question] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to regenerate question" },
      { status: 500 },
    );
  }
}
