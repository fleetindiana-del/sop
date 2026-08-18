import {
  compactRequirementText,
  isGuidelineBoilerplate,
  normalizeGuidelineText,
  REQUIREMENT_VERB_RE,
  sliceGuidelineSection,
  splitGuidelineSentences,
  substantiveScore,
} from "@/lib/guidelineBoilerplate";

function splitIntoUnits(text: string): string[] {
  const units: string[] = [];
  const seen = new Set<string>();

  const add = (s: string) => {
    const t = normalizeGuidelineText(s);
    if (t.length < 18 || seen.has(t) || isGuidelineBoilerplate(t)) return;
    seen.add(t);
    units.push(t);
  };

  for (const para of text.split(/\n+/)) {
    const trimmed = normalizeGuidelineText(para);
    if (!trimmed || isGuidelineBoilerplate(trimmed)) continue;
    for (const s of splitGuidelineSentences(trimmed)) add(s);
    if (trimmed.length >= 40 && trimmed.length <= 400) add(trimmed);
  }

  return units;
}

function anchorOverlapScore(unit: string, anchor: string): number {
  const wordsA = new Set(anchor.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wordsB = unit.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (!wordsA.size || !wordsB.length) return 0;
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;
  return overlap / Math.sqrt(wordsA.size * wordsB.length);
}

function stripWordPunct(word: string): string {
  return word.replace(/^[,;:.('"[\]]+|[,;:.)'"\]]+$/g, "");
}

function phraseInBody(body: string, phrase: string): boolean {
  return normalizeGuidelineText(body)
    .toLowerCase()
    .includes(normalizeGuidelineText(phrase).toLowerCase());
}

/** True when enough distinctive words from `text` appear in `body`. */
export function textSupportedByBody(body: string, text: string, minWordRatio = 0.32): boolean {
  if (!body.trim() || !text.trim()) return false;
  const hay = normalizeGuidelineText(body).toLowerCase();
  const needle = normalizeGuidelineText(text);
  if (hay.includes(needle.toLowerCase())) return true;
  if (needle.length >= 24 && hay.includes(needle.slice(0, 72).toLowerCase())) return true;

  const words = needle.toLowerCase().split(/\W+/).filter((w) => w.length > 4);
  if (words.length < 3) {
    return words.length > 0 && words.every((w) => hay.includes(w));
  }
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits >= Math.max(3, Math.ceil(words.length * minWordRatio));
}

/** Drop anchors that clearly belong to a different document than `body`. */
export function filterAnchorsForBody(body: string, anchors: string[]): string[] {
  return anchors
    .map((a) => a.trim())
    .filter((a) => a.length >= 8 && !isGuidelineBoilerplate(a))
    .filter((a) => {
      if (a.length <= 100) return true;
      return textSupportedByBody(body, a);
    });
}

/**
 * True when the search phrase is an optimized PDF lookup, not a verbatim slice of the requirement.
 */
export function isSmartSearchTerm(requirement: string, searchPhrase: string): boolean {
  const search = normalizeGuidelineText(searchPhrase).toLowerCase();
  if (search.length < 6) return false;

  const req = normalizeGuidelineText(requirement).toLowerCase();
  if (!req) return true;

  if (req.includes(search)) {
    if (req.startsWith(search) && req.length > search.length + 12) return true;
    return false;
  }

  const searchWords = search.split(/\s+/).filter(Boolean);
  const reqWords = req.split(/\s+/).filter(Boolean);
  if (searchWords.length >= 3 && reqWords.length >= searchWords.length) {
    const prefix = reqWords.slice(0, searchWords.length).join(" ");
    if (prefix === search) return false;
  }

  return true;
}

export interface PdfSearchResolution {
  searchPhrase: string;
  fullPoint?: string;
  isSmartSearch: boolean;
  matchFound: boolean;
  matchPage?: number;
}

/**
 * Locate impact-related sentence in document text (PDF OCR or clause blob).
 * Only returns phrases verified to exist in `body`.
 */
export function resolveDocPhraseInDocument(
  body: string,
  anchors: string[],
  clauseNumber?: string,
): DocPhraseResult | null {
  if (body.trim().length < 20) return null;
  const filtered = filterAnchorsForBody(body, anchors);
  if (!filtered.length) return null;
  return resolveDocPhraseForImpact({ clauseText: body, clauseNumber, anchors: filtered });
}

/**
 * Pick a contiguous word window that exists verbatim in the document body.
 */
export function extractVerbatimSearchWindow(
  body: string,
  unit: string,
  windowSize = 6,
): string {
  if (!body.trim() || !unit.trim()) return "";

  const bodyNorm = normalizeGuidelineText(body);
  const unitNorm = normalizeGuidelineText(unit);

  const needles = [
    unitNorm,
    unitNorm.slice(0, 80),
    unitNorm.slice(0, 50),
    ...(unitNorm.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [])
      .map((s) => normalizeGuidelineText(s))
      .filter((s) => s.length >= 24)
      .sort((a, b) => b.length - a.length),
  ];

  let charStart = -1;
  let spanLen = 0;
  for (const needle of needles) {
    const idx = bodyNorm.toLowerCase().indexOf(needle.toLowerCase());
    if (idx < 0) continue;
    const ratio = body.length / Math.max(1, bodyNorm.length);
    charStart = Math.floor(idx * ratio);
    spanLen = Math.ceil(needle.length * ratio);
    break;
  }

  const excerpt =
    charStart >= 0
      ? body.slice(charStart, charStart + Math.max(spanLen + 100, unit.length))
      : unit;

  const rawWords = excerpt.replace(/^\d+(?:\.\d+)*\s+/, "").split(/\s+/).filter(Boolean);
  const words = rawWords.map(stripWordPunct).filter(Boolean);
  if (!words.length) return "";

  const verify = (phrase: string) => phraseInBody(body, phrase);

  if (words.length <= windowSize) {
    const p = words.join(" ");
    return verify(p) ? p : "";
  }

  let best = "";
  let bestScore = -1;
  for (let i = 0; i <= words.length - 4; i++) {
    for (const size of [windowSize, windowSize + 1, windowSize - 1, 5, 4]) {
      if (size < 4 || i + size > words.length) continue;
      const window = words.slice(i, i + size).join(" ");
      if (!verify(window)) continue;
      let score = window.split(/\s+/).filter((w) => w.length > 4).length;
      if (REQUIREMENT_VERB_RE.test(window)) score += 3;
      score -= i * 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = window;
      }
    }
  }
  if (best) return best;

  const unitWords = unitNorm.split(/\s+/).filter((w) => w.length > 3);
  for (let len = Math.min(8, unitWords.length); len >= 4; len--) {
    for (let i = 0; i <= unitWords.length - len; i++) {
      const phrase = unitWords.slice(i, i + len).join(" ");
      if (!bodyNorm.toLowerCase().includes(phrase.toLowerCase())) continue;
      return unitWords.slice(i, i + Math.min(windowSize, len)).join(" ");
    }
  }

  return "";
}

export interface DocPhraseInput {
  clauseText: string;
  clauseNumber?: string;
  /** Requirement, gap, impact, SOP snippet — used to locate the right doc sentence. */
  anchors: string[];
}

export interface DocPhraseResult {
  fullPoint: string;
  searchPhrase: string;
  matchedUnit: string;
}

/**
 * Find the document sentence related to the compliance impact and derive a PDF-searchable phrase from it.
 */
export function resolveDocPhraseForImpact(input: DocPhraseInput): DocPhraseResult | null {
  const body = sliceGuidelineSection(input.clauseText, input.clauseNumber);
  if (body.length < 20) return null;

  const anchors = input.anchors
    .map((a) => a.trim())
    .filter((a) => a.length >= 4 && !isGuidelineBoilerplate(a));
  if (!anchors.length) return null;

  const units = splitIntoUnits(body);
  if (!units.length) return null;

  const clauseNum = input.clauseNumber?.replace(/[^\d.]/g, "") ?? "";
  let bestUnit: string | null = null;
  let bestScore = -1;

  for (const unit of units) {
    if (!phraseInBody(body, unit.slice(0, Math.min(40, unit.length)))) continue;
    let score = substantiveScore(unit);
    if (clauseNum) {
      // Prefer sentences that cite this section or its numbered paragraphs (8.2 / 8.20)
      if (new RegExp(`\\b${clauseNum.replace(/\./g, "\\.")}(?!\\d)\\b`).test(unit)) score += 14;
      if (new RegExp(`\\b${clauseNum.replace(/\./g, "\\.")}\\d+\\b`).test(unit)) score += 10;
    }
    for (const anchor of anchors) {
      score += anchorOverlapScore(unit, anchor) * 18;
      // Include short topic words from titles ("time", "limit") — len>5 was too strict
      const keywords = anchor.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      for (const kw of keywords) {
        if (unit.toLowerCase().includes(kw)) score += 2.5;
      }
    }
    // Prefer earlier paragraphs inside a scoped section when scores are close
    const pos = body.toLowerCase().indexOf(unit.slice(0, 32).toLowerCase());
    if (pos >= 0 && pos < 200) score += 3;
    if (score > bestScore) {
      bestScore = score;
      bestUnit = unit;
    }
  }

  if (!bestUnit || bestScore < 3) {
    // Scoped section with weak anchor overlap — still return the primary requirement sentence
    const fallback =
      units.find((u) => substantiveScore(u) >= 5 && REQUIREMENT_VERB_RE.test(u)) || units[0];
    if (!fallback) return null;
    bestUnit = fallback;
  }

  const fullPoint = compactRequirementText(bestUnit) || bestUnit.slice(0, 260);
  const searchPhrase = extractVerbatimSearchWindow(body, bestUnit);
  if (!searchPhrase) return null;

  return { fullPoint, searchPhrase, matchedUnit: bestUnit };
}
