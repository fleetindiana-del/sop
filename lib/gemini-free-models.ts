/**
 * Gemini models with free input + output on the Standard tier.
 * @see https://ai.google.dev/gemini-api/docs/pricing
 */
export const GEMINI_FREE_TEXT_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "gemini-2.5-flash-lite-preview-09-2025",
  /** Free tier but low daily quota (50 RPD) — last resort only. */
  "gemini-2.5-pro",
] as const;

export type GeminiFreeTextModel = (typeof GEMINI_FREE_TEXT_MODELS)[number];

/** Default for MCQ + general JSON — highest free-tier volume limits. */
export const DEFAULT_FREE_GEMINI_MODEL: GeminiFreeTextModel = "gemini-2.5-flash-lite";

/** Default for compliance batching — same model, optimized for cost/volume. */
export const DEFAULT_FREE_COMPLIANCE_MODEL: GeminiFreeTextModel = "gemini-2.5-flash-lite";

export function isGeminiFreeModel(model: string): boolean {
  return (GEMINI_FREE_TEXT_MODELS as readonly string[]).includes(model);
}

/** Build an ordered fallback chain using only free-tier models. */
export function buildFreeModelChain(
  primary?: string,
  ...extras: Array<string | undefined>
): string[] {
  const candidates = [primary, ...extras, ...GEMINI_FREE_TEXT_MODELS].filter(
    (m): m is string => typeof m === "string" && isGeminiFreeModel(m),
  );
  return [...new Set(candidates)];
}
