import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";
import {
  buildFreeModelChain,
  DEFAULT_FREE_COMPLIANCE_MODEL,
  DEFAULT_FREE_GEMINI_MODEL,
  isGeminiFreeModel,
} from "@/lib/gemini-free-models";
import {
  errorDetail,
  errorMessage,
  isConnectionError,
  isJsonParseError,
  parseJsonFromText,
  sleep,
} from "@/lib/llm-utils";

export const DEFAULT_MODEL = DEFAULT_FREE_GEMINI_MODEL;

/** Tuning for a single JSON generation call. The MCQ path passes a low
 *  `maxAttempts` and `fastFail503` so a transient overload doesn't trigger the
 *  8×-per-model escalating-backoff storm (only the compliance path historically
 *  had these guards). */
export interface GeminiJsonOptions {
  /** Cap per-model attempts inside generateWithModel (default 8). */
  maxAttempts?: number;
  /** On a 503/overload, throw immediately instead of retrying the same model —
   *  the chain then tries at most one fallback before giving up. */
  fastFail503?: boolean;
}

const MODEL_FALLBACK_CHAIN = buildFreeModelChain(
  process.env.GEMINI_MODEL,
  DEFAULT_FREE_GEMINI_MODEL,
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
);

function isGeminiFreeTier(): boolean {
  return process.env.GEMINI_FREE_TIER !== "false";
}

/** Free tier: one model only — fallbacks share the same API key quota and waste retries. */
function getComplianceModelChain(): string[] {
  const primary =
    process.env.COMPLIANCE_GEMINI_MODEL ??
    process.env.GEMINI_MODEL ??
    DEFAULT_FREE_COMPLIANCE_MODEL;
  if (isGeminiFreeTier()) {
    return [primary];
  }
  return buildFreeModelChain(
    primary,
    DEFAULT_FREE_COMPLIANCE_MODEL,
    "gemini-2.5-flash",
    "gemini-3.1-flash-lite",
  );
}

/** Serialize compliance API calls — one in flight at a time for free-tier RPM limits. */
let complianceQueueTail: Promise<unknown> = Promise.resolve();
let lastComplianceCallAt = 0;
/** Shared cooldown after 429 — all queued compliance calls wait here before sending. */
let quotaCooldownUntil = 0;

function extendQuotaCooldown(ms: number): void {
  quotaCooldownUntil = Math.max(quotaCooldownUntil, Date.now() + ms);
}

function getComplianceMinGapMs(): number {
  const n = Number(process.env.GEMINI_COMPLIANCE_MIN_GAP_MS);
  if (Number.isFinite(n) && n > 0) return n;
  // Gemini free tier Flash-Lite ≈ 10–15 RPM → ~5s gap keeps under limit.
  return 5_000;
}

function is503Error(error: unknown): boolean {
  const msg = errorMessage(error).toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("high demand") ||
    msg.includes("unavailable") ||
    msg.includes("overloaded")
  );
}

/** True when the model/service is temporarily unavailable (503 / overloaded).
 *  Callers use this to stop a run early instead of burning quota on retries. */
export function isGeminiOverloadedError(error: unknown): boolean {
  return is503Error(error);
}

/** The model returned an empty candidate (safety block, MAX_TOKENS with no
 *  content, etc.). Retrying the SAME model usually repeats the empty result, so
 *  callers should move to the next fallback model instead. */
function isNoTextResponseError(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes("no text response");
}

function isDailyQuotaError(error: unknown): boolean {
  const msg = errorMessage(error).toLowerCase();
  return (
    msg.includes("generaterequestsperday") ||
    msg.includes("perdayperproject") ||
    msg.includes("per day") ||
    msg.includes("requests per day") ||
    msg.includes("daily quota") ||
    msg.includes("daily request limit reached")
  );
}

/** Detect daily quota exhaustion (including wrapped errors from generateWithModel). */
export function isGeminiDailyQuotaError(error: unknown): boolean {
  const msg = errorMessage(error).toLowerCase();
  return isDailyQuotaError(error) || msg.includes("daily limit reached");
}

function formatDailyQuotaError(error: unknown): string {
  const msg = errorMessage(error);
  const limitMatch =
    msg.match(/"quotaValue"\s*:\s*"(\d+)"/) ?? msg.match(/limit:\s*(\d+)/i);
  const modelMatch =
    msg.match(/model:\s*([\w.-]+)/i) ?? msg.match(/"model"\s*:\s*"([^"]+)"/);
  const limit = limitMatch?.[1];
  const model = modelMatch?.[1] ?? process.env.COMPLIANCE_GEMINI_MODEL ?? "gemini-2.5-flash-lite";

  if (limit) {
    return (
      `Gemini free tier daily limit reached (${limit} requests/day on ${model}). ` +
      `A full SOP audit needs ~85 requests. Resume tomorrow, create a new key at ` +
      `https://aistudio.google.com/apikey, or enable billing.`
    );
  }
  return (
    `Gemini free tier daily limit reached. Resume tomorrow, create a new key at ` +
    `https://aistudio.google.com/apikey, or enable billing. Details: ${msg.slice(0, 180)}`
  );
}

async function enqueueComplianceCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = complianceQueueTail.then(async () => {
    const quotaWait = quotaCooldownUntil - Date.now();
    if (quotaWait > 0) await sleep(quotaWait);
    const gapWait = getComplianceMinGapMs() - (Date.now() - lastComplianceCallAt);
    if (gapWait > 0) await sleep(gapWait);
    lastComplianceCallAt = Date.now();
    return fn();
  });
  complianceQueueTail = run.catch(() => {});
  return run;
}

function getApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Create a free key at https://aistudio.google.com/apikey",
    );
  }
  return apiKey;
}

function assertFreeModel(modelName: string): void {
  if (!isGeminiFreeModel(modelName)) {
    throw new Error(
      `Model "${modelName}" is not on the Gemini free tier. Use one of: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-3.1-flash-lite`,
    );
  }
}

function buildModel(
  system: string,
  modelName: string,
  jsonMode = false,
  maxOutputTokens = 16384,
): GenerativeModel {
  assertFreeModel(modelName);
  const genAI = new GoogleGenerativeAI(getApiKey());
  return genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: system,
    generationConfig: {
      maxOutputTokens,
      ...(jsonMode ? { responseMimeType: "application/json" } : {}),
    },
  });
}

function isCreditsDepletedError(error: unknown): boolean {
  const msg = errorMessage(error).toLowerCase();
  return (
    msg.includes("credits are depleted") ||
    msg.includes("prepayment credits") ||
    msg.includes("billing account") ||
    msg.includes("insufficient credit") ||
    msg.includes("payment required")
  );
}

function isRateLimitError(error: unknown): boolean {
  const msg = errorMessage(error).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("resource_exhausted") ||
    msg.includes("rate limit") ||
    (msg.includes("quota") && !isDailyQuotaError(error))
  );
}

function isRetryableGeminiError(error: unknown): boolean {
  if (isCreditsDepletedError(error) || isDailyQuotaError(error)) return false;
  const msg = errorMessage(error).toLowerCase();
  return (
    isJsonParseError(error) ||
    isRateLimitError(error) ||
    msg.includes("503") ||
    msg.includes("500") ||
    msg.includes("high demand") ||
    msg.includes("unavailable") ||
    msg.includes("overloaded")
  );
}

function parseRetryDelayMs(error: unknown, attempt: number, complianceMode = false): number {
  const msg = errorMessage(error);
  const retryMatch = msg.match(/retry in ([\d.]+)s/i);
  if (retryMatch) return Math.ceil(parseFloat(retryMatch[1]) * 1000) + 1000;

  if (isJsonParseError(error)) return 2_000 + attempt * 1_500;

  const lower = msg.toLowerCase();
  if (lower.includes("503") || lower.includes("high demand") || lower.includes("unavailable")) {
    return Math.min(45_000, 5_000 + attempt * 5_000);
  }
  if (lower.includes("perday") || lower.includes("per day")) return 60_000;
  if (lower.includes("429") || lower.includes("quota") || lower.includes("resource_exhausted")) {
    return complianceMode ? 45_000 : 35_000 + attempt * 3_000;
  }
  return 10_000 + attempt * 4_000;
}

type GeminiUserContent =
  | string
  | Array<string | { text: string } | { inlineData: { mimeType: string; data: string } }>;

async function generateWithModel(
  model: GenerativeModel,
  user: GeminiUserContent,
  modelName: string,
  maxAttempts = 8,
  complianceMode = false,
  fastFail503 = false,
): Promise<string> {
  let lastError: unknown;
  const effectiveMax = complianceMode ? Math.min(maxAttempts, 3) : maxAttempts;

  for (let attempt = 0; attempt < effectiveMax; attempt++) {
    try {
      const result = await model.generateContent(user);
      const resp = result.response;
      let text = "";
      try {
        text = resp.text() ?? "";
      } catch {
        // resp.text() throws when the candidate was blocked — fall through to the
        // empty-text branch below, which records the reason.
      }
      if (!text) {
        const finishReason = resp.candidates?.[0]?.finishReason;
        const blockReason = resp.promptFeedback?.blockReason;
        throw new Error(
          `No text response from Gemini (finishReason=${finishReason ?? "unknown"}${
            blockReason ? `, blockReason=${blockReason}` : ""
          })`,
        );
      }
      return text;
    } catch (error) {
      lastError = error;

      if (isCreditsDepletedError(error)) {
        throw new Error(
          `Gemini billing exhausted on this API key. Create a new FREE key at https://aistudio.google.com/apikey ` +
            `(no credit card) and update GEMINI_API_KEY in .env.local. Details: ${errorMessage(error).slice(0, 200)}`,
        );
      }

      if (complianceMode && isDailyQuotaError(error)) {
        throw new Error(formatDailyQuotaError(error));
      }

      if (complianceMode && is503Error(error)) {
        if (attempt >= 1 || isGeminiFreeTier()) throw error;
        console.warn(`[gemini] ${modelName} 503 high demand — retry once in 3s`);
        await sleep(3_000);
        continue;
      }

      // Fast-fail path (MCQ generation): a 503/overload means the service is
      // busy — retrying the SAME model up to 8× with 5–45s backoff just burns
      // quota and stalls the request. Bail immediately so the chain tries at
      // most one fallback model, then stops.
      if (fastFail503 && is503Error(error)) {
        console.warn(`[gemini] ${modelName} 503/overloaded — fast-fail (no same-model retry)`);
        throw error;
      }

      // Empty candidate (safety/MAX_TOKENS). Same-model retries just repeat it —
      // bail so the chain tries the next fallback model.
      if (isNoTextResponseError(error)) {
        console.warn(`[gemini] ${modelName} ${errorMessage(error)} — trying next model`);
        throw error;
      }

      if (complianceMode && isRateLimitError(error)) {
        const delay = parseRetryDelayMs(error, attempt, true);
        extendQuotaCooldown(delay);
        if (attempt >= 1) throw error;
        console.warn(
          `[gemini] ${modelName} rate limited — global cooldown ${Math.round(delay / 1000)}s, one retry`,
        );
        await sleep(delay);
        continue;
      }

      if (isConnectionError(error)) {
        const connMax = complianceMode ? 2 : 5;
        if (attempt >= connMax) throw error;
        const delay = complianceMode ? 3_000 : 2_000 + attempt * 2_000;
        console.warn(
          `[gemini] ${modelName} connection error ${attempt + 1}/${connMax + 1} — ${errorDetail(error).slice(0, 200)} — retry in ${Math.round(delay / 1000)}s`,
        );
        await sleep(delay);
        continue;
      }

      const retryable = isRetryableGeminiError(error);
      if (!retryable || attempt === effectiveMax - 1) throw error;

      const delay =
        complianceMode && is503Error(error) ? 3_000 : parseRetryDelayMs(error, attempt, complianceMode);
      console.warn(
        `[gemini] ${modelName} attempt ${attempt + 1}/${effectiveMax} — ${errorDetail(error).slice(0, 200)} — retry in ${Math.round(delay / 1000)}s`,
      );
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("Gemini request failed");
}

async function generateJsonWithChain<T>(
  system: string,
  user: string,
  chain: string[],
  maxOutputTokens: number,
  logPrefix: string,
  complianceMode = false,
  options: GeminiJsonOptions = {},
): Promise<T> {
  let lastError: unknown;
  const attemptsPerModel = options.maxAttempts ?? 8;
  const fastFail503 = options.fastFail503 ?? false;

  for (const modelName of chain) {
    for (let parseAttempt = 0; parseAttempt < (complianceMode ? 2 : 3); parseAttempt++) {
      try {
        const model = buildModel(system, modelName, true, maxOutputTokens);
        const text = await generateWithModel(
          model,
          user,
          modelName,
          attemptsPerModel,
          complianceMode,
          fastFail503,
        );
        const parsed = parseJsonFromText<T>(text, logPrefix);
        if (modelName !== chain[0]) {
          console.log(`[${logPrefix}] succeeded with fallback model: ${modelName}`);
        }
        return parsed;
      } catch (error) {
        lastError = error;
        if (complianceMode && isGeminiFreeTier() && (isRateLimitError(error) || is503Error(error))) {
          throw error;
        }
        if (isConnectionError(error) || is503Error(error) || isNoTextResponseError(error)) {
          const why = is503Error(error)
            ? "503"
            : isNoTextResponseError(error)
              ? "empty response"
              : "connection";
          console.warn(`[${logPrefix}] ${why} on ${modelName} — trying next free model`);
          break;
        }
        if (isJsonParseError(error) && parseAttempt < 1) {
          console.warn(`[${logPrefix}] JSON parse failed on ${modelName} — retry`);
          await sleep(2_000);
          continue;
        }
        if (!isRetryableGeminiError(error)) throw error;
        break;
      }
    }
    if (complianceMode && isGeminiFreeTier()) break;
    console.warn(`[${logPrefix}] model ${modelName} exhausted — trying next free model`);
  }

  const msg = errorMessage(lastError);
  if (isNoTextResponseError(lastError)) {
    throw new Error(
      `Gemini returned an empty response on all free models — usually a safety filter or the output-token limit (try shortening the SOP content or reducing the batch size). Details: ${msg.slice(0, 220)}`,
    );
  }
  if (isConnectionError(lastError)) {
    throw new Error(
      `Gemini API connection failed after trying all free models. Wait 30 seconds and retry. Details: ${errorDetail(lastError).slice(0, 200)}`,
    );
  }
  if (isRetryableGeminiError(lastError)) {
    throw new Error(
      `Gemini free tier rate limit reached. Wait a minute or try again tomorrow (1,500 req/day on Flash-Lite). Details: ${msg.slice(0, 220)}`,
    );
  }
  throw lastError instanceof Error ? lastError : new Error(msg);
}

export async function generateGeminiJson<T>(
  system: string,
  user: string,
  options: GeminiJsonOptions = {},
): Promise<T> {
  return generateJsonWithChain<T>(system, user, MODEL_FALLBACK_CHAIN, 16384, "gemini", false, options);
}

export async function generateGeminiComplianceJson<T>(
  system: string,
  user: string,
): Promise<T> {
  return enqueueComplianceCall(() =>
    generateJsonWithChain<T>(
      system,
      user,
      getComplianceModelChain(),
      32768,
      "compliance-gemini",
      true,
    ),
  );
}

export type GeminiInlineImage = {
  mimeType: string;
  data: string;
};

/**
 * Multimodal JSON generation (label images / PDFs). Uses the same free-tier
 * chain and quota queue as compliance so vision calls don't stampede the key.
 */
export async function generateGeminiVisionJson<T>(
  system: string,
  userText: string,
  images: GeminiInlineImage[],
): Promise<T> {
  const parts: GeminiUserContent = [
    { text: userText },
    ...images.map((img) => ({
      inlineData: { mimeType: img.mimeType, data: img.data },
    })),
  ];

  return enqueueComplianceCall(async () => {
    let lastError: unknown;
    const chain = getComplianceModelChain();
    for (const modelName of chain) {
      try {
        const model = buildModel(system, modelName, true, 32768);
        const text = await generateWithModel(model, parts, modelName, 3, true, true);
        return parseJsonFromText<T>(text, "label-vision");
      } catch (error) {
        lastError = error;
        if (isGeminiFreeTier() && (isRateLimitError(error) || is503Error(error))) {
          throw error;
        }
        console.warn(`[label-vision] ${modelName} failed — ${errorMessage(error).slice(0, 180)}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
  });
}

export async function* streamGeminiComplianceAnalysis(
  system: string,
  user: string,
): AsyncGenerator<string> {
  const modelName = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  assertFreeModel(modelName);
  const model = buildModel(system, modelName, false);
  const result = await model.generateContentStream(user);

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) yield text;
  }
}
