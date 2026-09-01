import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { generateCodexCliJson, getMcqCodexModel } from "@/lib/codex-cli";
import { extractJsonPayload } from "@/lib/llm-utils";
import type { IMcqTranslation, McqTranslationLang } from "@/models/MCQBank";

/** Languages a master (English) MCQ can be translated into. */
export const TRANSLATION_LANGS = ["gu"] as const;

export const LANG_LABEL: Record<McqTranslationLang, string> = {
  gu: "Gujarati",
};

/** How many MCQs go into one Codex call. Small enough to stay well inside the
 *  model's reliable-JSON window, large enough to keep the run cheap. */
export const TRANSLATION_BATCH_SIZE = Number(process.env.MCQ_TRANSLATION_BATCH_SIZE) || 8;

/** How many translation batches run at once. Each batch is an independent `codex
 *  exec` process, so the wall-clock cost of a 100-MCQ bank drops by roughly this
 *  factor. Kept modest so a local worker does not exhaust its Codex rate limit. */
export const TRANSLATION_CONCURRENCY = Number(process.env.MCQ_TRANSLATION_CONCURRENCY) || 4;

/** The master MCQ fields a translation is derived from. */
export interface MasterMcq {
  mcqId: string;
  question: string;
  options: string[];
  /** Option TEXT (bank convention), not a letter. */
  correctAnswer: string;
  explanation?: string;
  /** Clause the question is grounded in — translated for display alongside it. */
  sopReference?: string;
}

export interface TranslationFailure {
  mcqId: string;
  reason: string;
}

export interface TranslateBatchResult {
  translations: Map<string, IMcqTranslation>;
  failures: TranslationFailure[];
}

// ── Equivalence guards ───────────────────────────────────────────────────────
// A translation is only allowed to change LANGUAGE. Anything that could change
// which option is correct — option count, option order, or the numbers/units the
// answer turns on — is rejected rather than stored.

const GUJARATI_SCRIPT = /[઀-૿]/;
const GUJARATI_DIGITS = "૦૧૨૩૪૫૬૭૮૯";

/** Normalize Gujarati digits to ASCII so numeric comparison is script-agnostic. */
function asciiDigits(text: string): string {
  return text.replace(/[૦-૯]/g, (d) => String(GUJARATI_DIGITS.indexOf(d)));
}

/** Every number in the text, as a sorted multiset. "2–8°C" → ["2","8"]. */
function numericTokens(text: string): string[] {
  const matches = asciiDigits(text).match(/\d+(?:\.\d+)?/g) ?? [];
  return matches.map((n) => String(parseFloat(n))).sort();
}

/** Unit symbols that legitimately stay in Latin script inside a translation. */
const UNIT_WORDS = new Set([
  "mg", "kg", "mcg", "ml", "mm", "cm", "ppm", "ppb", "rpm", "psi", "bar", "lux",
  "min", "hr", "sec", "nm", "cfu", "iso", "usp", "api",
]);

/**
 * Text that is still recognisably English after removing acronyms, units, numbers
 * and symbols — i.e. words a learner would expect to see translated.
 * "QA Head" → "Head"; "2-8°C" → ""; "SOP" → "".
 */
function untranslatedEnglishWords(text: string): string[] {
  return (text.match(/[A-Za-z]+/g) ?? []).filter((w) => {
    if (w.length < 3) return false;              // short tokens are usually units/acronyms
    if (w === w.toUpperCase()) return false;      // ALL-CAPS acronym (SOP, HVAC, QA)
    return !UNIT_WORDS.has(w.toLowerCase());
  });
}

function sameNumbers(a: string, b: string): boolean {
  const na = numericTokens(a);
  const nb = numericTokens(b);
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
}

/** The master's correct option index — the single fact a translation must inherit. */
export function correctIndexOf(master: MasterMcq): number {
  const target = (master.correctAnswer ?? "").trim().toLowerCase();
  const idx = master.options.findIndex((o) => (o ?? "").trim().toLowerCase() === target);
  return idx;
}

export interface CandidateTranslation {
  question: string;
  options: string[];
  explanation?: string;
  sopReference?: string;
}

/**
 * Build a stored translation from a model candidate, or explain why it was rejected.
 *
 * `correctAnswer` is never taken from the model: it is derived from the MASTER's
 * correct index, so an accepted translation is correct-by-construction.
 */
export function buildTranslation(
  master: MasterMcq,
  candidate: CandidateTranslation,
  lang: McqTranslationLang,
  model: string,
  /** Set false to accept options the model left in English (proper nouns, brand names). */
  strictScript = true,
): { ok: true; translation: IMcqTranslation } | { ok: false; reason: string } {
  const correctIdx = correctIndexOf(master);
  if (correctIdx < 0) {
    return { ok: false, reason: "master correctAnswer does not match any master option" };
  }

  const question = (candidate.question ?? "").trim();
  const options = Array.isArray(candidate.options)
    ? candidate.options.map((o) => String(o ?? "").trim())
    : [];

  if (!question) return { ok: false, reason: "empty translated question" };
  if (options.length !== master.options.length) {
    return {
      ok: false,
      reason: `option count changed (${master.options.length} → ${options.length})`,
    };
  }
  if (options.some((o) => o.length === 0)) return { ok: false, reason: "empty translated option" };

  const distinct = new Set(options.map((o) => o.toLowerCase()));
  if (distinct.size !== options.length) {
    return { ok: false, reason: "translated options are not distinct" };
  }

  if (lang === "gu" && !GUJARATI_SCRIPT.test(question)) {
    return { ok: false, reason: "question was not translated (no Gujarati script)" };
  }

  // Numbers, doses, temperatures and durations decide the answer in pharma SOP
  // questions — they must survive translation untouched.
  if (!sameNumbers(master.question, question)) {
    return { ok: false, reason: "numeric values changed in the question" };
  }
  for (let i = 0; i < options.length; i++) {
    if (!sameNumbers(master.options[i], options[i])) {
      return { ok: false, reason: `numeric values changed in option ${i + 1}` };
    }
    // An option echoed back verbatim usually means the model skipped it because it
    // was short ("One month", "QA Head") — the learner would face a half-translated
    // exam. Acronyms, units and pure numbers are exempt.
    if (
      strictScript &&
      options[i] === master.options[i] &&
      untranslatedEnglishWords(master.options[i]).length > 0
    ) {
      return { ok: false, reason: `option ${i + 1} left untranslated` };
    }
  }

  return {
    ok: true,
    translation: {
      question,
      options,
      // Correct-by-construction: same position as the master's correct option.
      correctAnswer: options[correctIdx],
      explanation: (candidate.explanation ?? "").trim(),
      // Falls back to the master reference so the field is never empty — a clause
      // id with no title translates to itself.
      sopReference: (candidate.sopReference ?? "").trim() || (master.sopReference ?? ""),
      model,
      translatedAt: new Date(),
      isStale: false,
      isVerified: false,
    },
  };
}

// ── Codex prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a pharmaceutical SOP translator for a GMP training system.
You translate multiple-choice exam questions from English into the target language.

ABSOLUTE RULES:
1. Translate meaning faithfully. Never rephrase into an easier or harder question.
2. Keep the option ORDER exactly as given. Option 1 stays option 1, and so on.
3. Never mark or indicate which option is correct. You are not told the answer and must not guess.
4. Keep ALL numbers, dates, durations, temperatures, units, percentages, tolerances,
   SOP codes, equipment ids and regulatory references EXACTLY as written in the source,
   in Western digits (2-8°C stays 2-8°C, never "two to eight" and never Gujarati digits).
5. Keep ONLY acronyms and unit symbols in Latin script (SOP, QA, QC, GMP, HVAC, RH, LOD, mg, mL, µm, ppm).
   Everything else must be translated — including ordinary words, durations, job titles and
   department names. "One month" becomes the target-language phrase, never "One month".
   "QA Head" keeps QA but translates "Head". Never leave an option in English because it is short.
6. Do not add, drop, merge or reorder options. Do not add commentary.`;

function buildUserPrompt(batch: MasterMcq[], lang: McqTranslationLang): string {
  const items = batch.map((m) => ({
    id: m.mcqId,
    question: m.question,
    options: m.options,
    explanation: m.explanation ?? "",
    sopReference: m.sopReference ?? "",
  }));

  return `Translate each question below into ${LANG_LABEL[lang]}.

Return ONLY this JSON shape:
{"translations":[{"id":"<same id>","question":"<translated>","options":["<opt1>","<opt2>","<opt3>","<opt4>"],"explanation":"<translated explanation>","sopReference":"<translated clause reference>"}]}

Return one entry per input id, with options in the SAME ORDER as the input.
For sopReference, keep every clause number and SOP code exactly as given and translate
only the wording around them. Return "" when the input sopReference is empty.

INPUT:
${JSON.stringify({ questions: items }, null, 2)}`;
}

interface RawTranslationRow {
  id?: unknown;
  question?: unknown;
  options?: unknown;
  explanation?: unknown;
  sopReference?: unknown;
}

function parseTranslationJson(text: string): RawTranslationRow[] {
  const payload = extractJsonPayload(text);
  const parsed = JSON.parse(payload) as { translations?: unknown } | unknown[];
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { translations?: unknown }).translations)
      ? ((parsed as { translations: unknown[] }).translations)
      : [];
  if (rows.length === 0) throw new SyntaxError("No usable translations in response");
  return rows as RawTranslationRow[];
}

export interface TranslateOptions {
  lang?: McqTranslationLang;
  model?: string;
  runKey?: string;
  signal?: AbortSignal;
  /** Accept options the model left in English (proper nouns, brand names). */
  allowUntranslatedOptions?: boolean;
}

/**
 * Translate one batch of master MCQs through the Codex CLI (`codex exec`, local
 * ChatGPT login — no API key). Rejected candidates come back in `failures` so the
 * caller can retry or report them; nothing unvalidated is ever returned.
 */
export async function translateMcqBatch(
  batch: MasterMcq[],
  options: TranslateOptions = {},
): Promise<TranslateBatchResult> {
  const lang = options.lang ?? "gu";
  const model = options.model ?? getMcqCodexModel();
  const translations = new Map<string, IMcqTranslation>();
  const failures: TranslationFailure[] = [];

  if (batch.length === 0) return { translations, failures };

  const rows = await generateCodexCliJson(
    SYSTEM_PROMPT,
    buildUserPrompt(batch, lang),
    parseTranslationJson,
    `MCQ ${LANG_LABEL[lang]} translation`,
    model,
    { runKey: options.runKey, signal: options.signal, subprocessScope: "mcq" },
  );

  const byId = new Map(rows.map((r) => [String(r.id ?? ""), r]));

  for (const master of batch) {
    const row = byId.get(master.mcqId);
    if (!row) {
      failures.push({ mcqId: master.mcqId, reason: "no translation returned for this question" });
      continue;
    }
    const built = buildTranslation(
      master,
      {
        question: String(row.question ?? ""),
        options: Array.isArray(row.options) ? row.options.map((o) => String(o ?? "")) : [],
        explanation: row.explanation === undefined ? "" : String(row.explanation),
        sopReference: row.sopReference === undefined ? "" : String(row.sopReference),
      },
      lang,
      `codex:${model}`,
      !options.allowUntranslatedOptions,
    );
    if (built.ok) translations.set(master.mcqId, built.translation);
    else failures.push({ mcqId: master.mcqId, reason: built.reason });
  }

  return { translations, failures };
}

// ── Persistence ──────────────────────────────────────────────────────────────

function bankCollection() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database not connected");
  return db.collection("mcqbanks");
}

/**
 * Give every MCQ in a bank a stable `mcqId`. Banks written before translations
 * existed key their questions only by array position, which shifts on edit or
 * regeneration — translations must not be pinned to that.
 *
 * Returns how many ids were assigned.
 */
export async function ensureBankMcqIds(bankId: string | mongoose.Types.ObjectId): Promise<number> {
  const col = bankCollection();
  const _id = typeof bankId === "string" ? new mongoose.Types.ObjectId(bankId) : bankId;
  const bank = await col.findOne({ _id }, { projection: { mcqs: 1 } });
  if (!bank || !Array.isArray(bank.mcqs)) return 0;

  const set: Record<string, string> = {};
  const seen = new Set<string>();
  bank.mcqs.forEach((m: { mcqId?: string }, i: number) => {
    const existing = typeof m?.mcqId === "string" ? m.mcqId.trim() : "";
    // Regenerate on collision too — a duplicated id would let one translation
    // bleed onto another question.
    if (!existing || seen.has(existing)) set[`mcqs.${i}.mcqId`] = randomUUID();
    else seen.add(existing);
  });

  const count = Object.keys(set).length;
  if (count > 0) await col.updateOne({ _id }, { $set: set });
  return count;
}

/** Write validated translations onto their master questions, matched by mcqId. */
export async function saveBankTranslations(
  bankId: string | mongoose.Types.ObjectId,
  lang: McqTranslationLang,
  translations: Map<string, IMcqTranslation>,
): Promise<number> {
  if (translations.size === 0) return 0;
  const col = bankCollection();
  const _id = typeof bankId === "string" ? new mongoose.Types.ObjectId(bankId) : bankId;
  const bank = await col.findOne({ _id }, { projection: { mcqs: 1 } });
  if (!bank || !Array.isArray(bank.mcqs)) return 0;

  const set: Record<string, unknown> = {};
  let added = 0;
  bank.mcqs.forEach((m: { mcqId?: string; translations?: Record<string, unknown> }, i: number) => {
    const t = m?.mcqId ? translations.get(m.mcqId) : undefined;
    if (!t) return;
    set[`mcqs.${i}.translations.${lang}`] = t;
    // Newly translated only — re-translating a stale one must not double-count.
    if (!m?.translations?.[lang]) added += 1;
  });

  const count = Object.keys(set).length;
  if (count > 0) {
    set.updatedAt = new Date();
    // Denormalized so LMS question counts never have to walk `$mcqs` on Atlas
    // (45s timeouts). Incremented by the delta rather than written as an absolute
    // total: batches run concurrently, and each one's read snapshot is already
    // stale by the time it writes — an absolute total would let the last writer
    // clobber its siblings' counts.
    await col.updateOne({ _id }, { $set: set, ...(added ? { $inc: { [`translatedCounts.${lang}`]: added } } : {}) });
  }
  return count;
}

/** Read a bank's master MCQs, optionally only those still missing `lang`. */
export function toMasterMcqs(
  mcqs: Array<{
    mcqId?: string;
    question?: string;
    options?: string[];
    correctAnswer?: string;
    explanation?: string;
    sopReference?: string;
    isSimilar?: boolean;
    translations?: Record<string, { isStale?: boolean }> | null;
  }>,
  lang: McqTranslationLang,
  { includeTranslated = false, includeStale = true } = {},
): MasterMcq[] {
  const out: MasterMcq[] = [];
  for (const m of mcqs) {
    if (!m?.mcqId || m.isSimilar) continue;
    const existing = m.translations?.[lang];
    if (existing && !includeTranslated) {
      // Re-translate only when the English master has moved on.
      if (!includeStale || !existing.isStale) continue;
    }
    const options = Array.isArray(m.options) ? m.options.map((o) => String(o ?? "")) : [];
    if (options.length !== 4) continue;
    out.push({
      mcqId: m.mcqId,
      question: String(m.question ?? ""),
      options,
      correctAnswer: String(m.correctAnswer ?? ""),
      explanation: String(m.explanation ?? ""),
      sopReference: String(m.sopReference ?? ""),
    });
  }
  return out;
}
