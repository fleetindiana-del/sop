import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import MCQBank, { type IMCQ, type IMcqAnnexureUsage } from "@/models/MCQBank";
import SOP from "@/models/SOP";
import { generateJson, type LlmProvider } from "@/lib/llm";
import { toBankMcq, type BankInputMcq } from "@/lib/mcq-bank-write";
import { MCQ_REPLACE_SYSTEM } from "@/lib/mcq-generation-prompts";
import { MCQ_CONTENT_LIMIT, MCQ_CONTENT_LIMIT_OLLAMA } from "@/lib/mcq-source-text";
import { mcqContentLimitClaude, mcqContentLimitCodex } from "@/lib/mcq-generation-config";
import { generateCodexCliMcqBatch, getMcqCodexModel } from "@/lib/codex-cli";
import { generateClaudeCliMcqBatch, getMcqClaudeModel } from "@/lib/claude-cli";
import { anthropicMcqApiAvailable, generateAnthropicMcqBatch } from "@/lib/anthropic-mcq";
import {
  buildAnnexureSupplementDetailed,
  countLinkedAnnexureDocuments,
} from "@/lib/compliance-sop-content";
import { isDuplicateMcqQuestion, isDuplicateMcqQuestionForGeneration } from "@/lib/similarity";
import { sopFamilyIdentifierRegex } from "@/lib/sop-utils";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { invalidateMcqBankAggregateCache } from "@/lib/mcqBankAggregateCache";
import { requireAuth } from "@/lib/withAuth";

/** Annexure swap runs a single LLM batch — keep under serverless/proxy limits. */
export const maxDuration = 300;

/** Hard ceiling for the model call inside this route (Codex often hangs past this). */
const ANNEX_SWAP_MODEL_TIMEOUT_MS = Number(process.env.ANNEX_SWAP_TIMEOUT_MS) || 180_000;

function parseMcqProvider(value: unknown): LlmProvider {
  if (value === "ollama" || value === "gemini" || value === "codex" || value === "claude") {
    return value;
  }
  return "claude";
}

/** How many MCQs to swap out for annexure-based ones per run. */
const SWAP_COUNT = 15;

function annexureContentLimit(provider: LlmProvider): number {
  if (provider === "codex") return mcqContentLimitCodex();
  if (provider === "claude") return mcqContentLimitClaude();
  if (provider === "ollama") return MCQ_CONTENT_LIMIT_OLLAMA;
  return Math.min(MCQ_CONTENT_LIMIT, 12_000);
}

/** CLI providers are much faster with a smaller swap batch. */
function swapCountForProvider(provider: LlmProvider): number {
  if (provider === "codex") return 8;
  if (provider === "claude" && !anthropicMcqApiAvailable()) return 10;
  return SWAP_COUNT;
}

async function generateAnnexureSwapQuestions(
  provider: LlmProvider,
  user: string,
  signal?: AbortSignal,
): Promise<BankInputMcq[]> {
  const system = MCQ_REPLACE_SYSTEM;
  if (provider === "codex") {
    const questions = await generateCodexCliMcqBatch(system, user, getMcqCodexModel(), { signal });
    return questions as BankInputMcq[];
  }
  if (provider === "claude") {
    if (anthropicMcqApiAvailable()) {
      const questions = await generateAnthropicMcqBatch(system, user, getMcqClaudeModel(), signal);
      return questions as BankInputMcq[];
    }
    const questions = await generateClaudeCliMcqBatch(system, user, getMcqClaudeModel(), { signal });
    return questions as BankInputMcq[];
  }
  const result = await generateJson<{ questions: BankInputMcq[] }>(
    system,
    user,
    { maxAttempts: 2, fastFail503: true },
    provider,
  );
  return result.questions ?? [];
}

/**
 * Choose which existing MCQs to drop to make room for annexure MCQs.
 * Only near-duplicates and similar-flagged questions are removed.
 * Never removed: approved, creative-fill, prior annexure-sourced, or unique MCQs.
 */
function pickRemovals(
  mcqs: IMCQ[],
  max: number,
): { indices: Set<number>; creative: number; similar: number; duplicate: number } {
  const remove = new Set<number>();
  let similar = 0;
  let duplicate = 0;

  const removable = (i: number) =>
    !mcqs[i].isChecked &&
    !mcqs[i].isCreative &&
    !mcqs[i].fromAnnexure &&
    !remove.has(i);

  // 1. Similar-flagged
  for (let i = 0; i < mcqs.length && remove.size < max; i++) {
    if (removable(i) && mcqs[i].isSimilar) {
      remove.add(i);
      similar++;
    }
  }

  // 2. Near-duplicates (drop the later of any matching pair)
  for (let i = 0; i < mcqs.length && remove.size < max; i++) {
    if (!removable(i)) continue;
    for (let j = 0; j < i; j++) {
      if (remove.has(j)) continue;
      if (isDuplicateMcqQuestion(mcqs[i].question, mcqs[j].question)) {
        remove.add(i);
        duplicate++;
        break;
      }
    }
  }

  return { indices: remove, creative: 0, similar, duplicate };
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const { identifier, language = "English" } = body;
    const provider = parseMcqProvider(body.provider);
    if (!identifier) {
      return NextResponse.json({ error: "identifier required" }, { status: 400 });
    }

    // Match the whole SOP family (version suffixes collapse) — the same grouping
    // the registry uses, and where annexures / banks may live on a sibling record.
    const famRegex = sopFamilyIdentifierRegex(identifier);
    const family = await SOP.find({ identifier: famRegex });
    if (!family.length) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }

    const linkedCount = countLinkedAnnexureDocuments(family);
    if (linkedCount === 0) {
      return NextResponse.json(
        { error: "No annexure is connected to this SOP." },
        { status: 400 },
      );
    }

    const annexure = await buildAnnexureSupplementDetailed(family);
    if (!annexure.text.trim()) {
      return NextResponse.json(
        { error: `${linkedCount} annexure(s) are linked but their text could not be read (image-only or unsupported format).` },
        { status: 400 },
      );
    }

    // Active bank for this family + language (the same set the registry counts).
    const banks = await MCQBank.find({
      sopIdentifier: famRegex,
      language,
      isObsolete: { $ne: true },
    });
    const bank = [...banks].sort((a, b) => b.mcqs.length - a.mcqs.length)[0];
    if (!bank || bank.mcqs.length === 0) {
      return NextResponse.json(
        { error: `No ${language} MCQs exist yet — generate the bank first, then swap in annexure questions.` },
        { status: 400 },
      );
    }

    // Anchor the SOP record to the bank's owner (for identifier/name on new MCQs).
    const sop =
      family.find((s) => String(s._id) === String(bank.sopId)) ??
      family.find((s) => (s.language ?? "English") === language) ??
      family[0];

    // Generate FIRST, then remove only as many MCQs as we can actually replace —
    // so a weak/empty generation never strands the bank with fewer questions.
    // Use the MCQ-batch path + provider content limits (not the 32k generic JSON call).
    const swapCount = swapCountForProvider(provider);
    const excerpt = annexure.text.slice(0, annexureContentLimit(provider));
    const avoid = bank.mcqs.slice(-12).map((m) => m.question).join("\n- ");
    const userPrompt =
      `The following is the ANNEXURE content (forms, logs, and record templates) linked to SOP "${sop.name}". ` +
      `Generate ${swapCount} training questions based STRICTLY on this annexure content — the fields, entries, ` +
      `frequencies, limits, and record-keeping steps it defines. Do NOT ask about the annexure number or document metadata.\n\n` +
      `Annexure content:\n${excerpt}\n\n` +
      `Avoid repeating:\n- ${avoid}\n\nReturn ${swapCount} unique questions in ${language}.`;
    const modelSignal = AbortSignal.timeout(ANNEX_SWAP_MODEL_TIMEOUT_MS);
    let generated: BankInputMcq[];
    try {
      generated = await generateAnnexureSwapQuestions(provider, userPrompt, modelSignal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const timedOut =
        modelSignal.aborted ||
        /timed out|aborted|cancelled/i.test(msg);
      if (timedOut) {
        return NextResponse.json(
          {
            error:
              `Annexure swap timed out after ${Math.round(ANNEX_SWAP_MODEL_TIMEOUT_MS / 1000)}s ` +
              `(${provider}). Try again, or switch to Claude/Gemini for a faster swap.`,
          },
          { status: 504 },
        );
      }
      throw err;
    }

    // Dedup generated questions against the existing bank and each other, then
    // map to the stored MCQ shape. Cap the batch at swapCount.
    const existing = bank.mcqs.map((m) => m.question);
    const kept: string[] = [];
    const newMcqs: IMCQ[] = [];
    for (const q of generated) {
      if (newMcqs.length >= swapCount) break;
      const text = (q?.question ?? "").trim();
      if (!text) continue;
      if (existing.some((e) => isDuplicateMcqQuestionForGeneration(text, e))) continue;
      if (kept.some((e) => isDuplicateMcqQuestionForGeneration(text, e))) continue;
      kept.push(text);
      newMcqs.push({ ...toBankMcq(q, sop.identifier), fromAnnexure: true });
    }

    if (newMcqs.length === 0) {
      return NextResponse.json(
        { error: "The annexure produced no new unique questions — nothing was removed. Try again or check the annexure content." },
        { status: 422 },
      );
    }

    // Only duplicate/similar MCQs — creative-fill, approved, annexure, and unique stay.
    // Insert at most as many as we remove so the bank size never grows.
    const { indices, creative, similar, duplicate } = pickRemovals(bank.mcqs, newMcqs.length);
    if (indices.size === 0) {
      return NextResponse.json(
        {
          error:
            "No duplicate or similar MCQs available to swap out — creative-fill, approved, and unique questions are kept.",
        },
        { status: 422 },
      );
    }
    const toInsert = newMcqs.slice(0, indices.size);
    const removed = indices.size;
    const surviving = bank.mcqs.filter((_, i) => !indices.has(i));

    bank.mcqs = [...surviving, ...toInsert];
    bank.totalQuestions = bank.mcqs.length;
    bank.annexureUsage = {
      linkedCount,
      includedCount: annexure.included.length,
      skippedCount: annexure.skipped.length,
      includedLabels: annexure.included.map((a) => a.label),
      recordedAt: new Date(),
    } satisfies IMcqAnnexureUsage;
    await bank.save();

    // Keep the SOP's denormalized mcqCount in sync with the family bank total.
    const familyTotal = (await MCQBank.find({ sopIdentifier: famRegex, language, isObsolete: { $ne: true } }).select("mcqs").lean())
      .reduce((sum, b) => sum + (b.mcqs?.length ?? 0), 0);
    await SOP.updateMany({ identifier: famRegex, language }, { mcqCount: familyTotal });
    invalidateDashboardSopsCache();
    invalidateMcqBankAggregateCache();

    return NextResponse.json({
      removed,
      removedBreakdown: { creative, similar, duplicate },
      inserted: toInsert.length,
      mcqCount: bank.mcqs.length,
      annexuresUsed: annexure.included.length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Annexure swap failed" },
      { status: 500 },
    );
  }
}
