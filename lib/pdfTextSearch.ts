export type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

export type PdfTextPart = {
  text: string;
  itemIdx: number;
  normStart: number;
  normEnd: number;
};

import { compactRequirementText, isGuidelineBoilerplate, REQUIREMENT_VERB_RE } from "@/lib/guidelineBoilerplate";

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "shall", "must", "should",
  "have", "been", "are", "was", "will", "their", "they", "which", "when", "where",
]);

/** Max chars between consecutive query words in PDF text (page discovery only). */
const ORDERED_WORD_GAP = 140;

/** Tight gap for highlight — words must sit in the same sentence/clause. */
const HIGHLIGHT_WORD_GAP = 22;

function maxHighlightSpan(query: string): number {
  const len = normalizeWhitespace(query).length;
  return Math.max(Math.ceil(len * 1.75), 72);
}

function spellingVariants(phrase: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t.length >= 6 && !out.includes(t)) out.push(t);
  };
  add(phrase);
  add(phrase.replace(/preventative/gi, "preventive"));
  add(phrase.replace(/preventive/gi, "preventative"));
  add(phrase.replace(/isation/gi, "ization"));
  add(phrase.replace(/ization/gi, "isation"));
  return out;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Build normalized page string + map char offsets → PDF text items. */
export function buildTextIndex(items: PdfTextItem[]): { normalized: string; parts: PdfTextPart[] } {
  const parts: PdfTextPart[] = [];
  let normalized = "";

  for (let i = 0; i < items.length; i++) {
    const text = (items[i].str ?? "").trim();
    if (!text) continue;
    if (normalized.length > 0) normalized += " ";
    const normStart = normalized.length;
    normalized += text.toLowerCase();
    parts.push({ text, itemIdx: i, normStart, normEnd: normalized.length });
  }

  return { normalized, parts };
}

function itemIndicesForRange(parts: PdfTextPart[], start: number, end: number): number[] {
  const hits: number[] = [];
  for (const p of parts) {
    if (p.normEnd > start && p.normStart < end) hits.push(p.itemIdx);
  }
  return [...new Set(hits)];
}

function stripWordPunct(word: string): string {
  return word.replace(/^[,;:.('"[\]]+|[,;:.)'"\]]+$/g, "");
}

/** First assessable clause when AI merged multiple requirements into one string. */
export function primaryRequirementClause(text: string): string {
  if (isGuidelineBoilerplate(text)) return "";
  const t = (compactRequirementText(text, 400) || text).replace(/\s+/g, " ").trim();
  if (!t || isGuidelineBoilerplate(t)) return "";

  const splitters = [
    /,\s*with\s+[a-z]/i,
    /;\s+/,
    /\.\s+(?=[A-Z\d])/,
  ];
  for (const re of splitters) {
    const idx = t.search(re);
    if (idx > 40) return t.slice(0, idx).replace(/[,;]+$/, "").trim();
  }
  return t.replace(/[,;]+$/, "").trim();
}

/**
 * Consecutive word window for PDF search — always from the start of the primary clause.
 * Same value is shown in the finding card and passed to the PDF viewer.
 */
export function pickSearchWindowFromRequirement(text: string, windowSize = 6): string {
  const primary = primaryRequirementClause(text);
  if (!primary || isGuidelineBoilerplate(primary)) return "";

  const clean = primary.replace(/^\d+(?:\.\d+)*\s+(?:[A-Z]\s+)?/, "").trim();
  const words = clean.split(/\s+/).filter(Boolean).map(stripWordPunct).filter(Boolean);
  if (!words.length) return "";

  if (words.length <= windowSize) {
    return words.join(" ");
  }

  let bestStart = 0;
  let bestScore = -1;
  const maxStart = Math.min(words.length - windowSize, 2);
  for (let i = 0; i <= maxStart; i++) {
    const window = words.slice(i, i + windowSize);
    const joined = window.join(" ");
    let score = window.filter((w) => w.length > 3).length;
    if (REQUIREMENT_VERB_RE.test(joined)) score += 3;
    score -= i * 0.6;
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }
  return words.slice(bestStart, bestStart + windowSize).join(" ");
}

function pickContiguousWordWindow(text: string, windowSize = 6): string {
  return pickSearchWindowFromRequirement(text, windowSize);
}

/** Short consecutive phrase for PDF search — aligned with displayed requirement. */
export function pdfSearchPhrase(sourceLine: string): string {
  return pickSearchWindowFromRequirement(sourceLine, 6);
}

/** Build search variants — all derived from the same primary clause, start-aligned only. */
export function buildPdfSearchVariants(query: string): string[] {
  const variants: string[] = [];
  const add = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim().replace(/[,;]+$/, "");
    if (t.length >= 8 && !isGuidelineBoilerplate(t) && !variants.includes(t)) variants.push(t);
  };

  const trimmed = query.replace(/\s+/g, " ").trim().replace(/[,;]+$/, "");
  if (trimmed) add(trimmed);

  const primary = primaryRequirementClause(query);
  if (!primary) return [];

  add(primary);
  add(pickSearchWindowFromRequirement(primary, 8));
  add(pickSearchWindowFromRequirement(primary, 7));
  add(pickSearchWindowFromRequirement(primary, 6));
  add(pickSearchWindowFromRequirement(primary, 5));
  add(pickSearchWindowFromRequirement(primary, 4));

  const words = primary.replace(/^\d+(?:\.\d+)*\s+/, "").split(/\s+/).filter(Boolean);
  for (const size of [10, 8, 7, 6, 5, 4]) {
    if (words.length >= size) {
      add(words.slice(0, size).map(stripWordPunct).join(" "));
    }
  }

  return variants.sort((a, b) => b.length - a.length);
}

/** Exact contiguous phrase match (longest variants first). */
function findExactPhrase(
  normalized: string,
  parts: PdfTextPart[],
  query: string,
): { matchedPhrase: string; highlightItems: number[] } | null {
  const base = normalizeWhitespace(query);
  if (base.length < 6) return null;

  const variants = spellingVariants(base);
  if (base.length > 80) variants.push(...spellingVariants(base.slice(0, 80)));
  if (base.length > 60) variants.push(...spellingVariants(base.slice(0, 60)));
  if (base.length > 50) variants.push(...spellingVariants(base.slice(0, 50)));

  const words = base.split(/\s+/).filter((w) => w.length > 2);
  for (const size of [8, 7, 6, 5, 4, 3]) {
    if (words.length >= size) variants.push(...spellingVariants(words.slice(0, size).join(" ")));
  }

  const unique = [...new Set(variants.filter((v) => v.length >= 8))].sort((a, b) => b.length - a.length);

  for (const phrase of unique) {
    const idx = normalized.indexOf(phrase);
    if (idx < 0) continue;
    const highlightItems = itemIndicesForRange(parts, idx, idx + phrase.length);
    if (highlightItems.length) {
      return { matchedPhrase: phrase, highlightItems };
    }
  }
  return null;
}

/**
 * Query words appearing in order within a short span (handles extra words like "must", "are").
 */
function findOrderedWordsSpan(
  normalized: string,
  parts: PdfTextPart[],
  query: string,
  maxGap = ORDERED_WORD_GAP,
  maxSpan?: number,
  preferEarliest = false,
): { matchedPhrase: string; highlightItems: number[] } | null {
  const words = normalizeWhitespace(query).split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 2) return null;

  const spanLimit = maxSpan ?? maxHighlightSpan(query);
  let best: { start: number; end: number } | null = null;

  let searchFrom = 0;
  while (searchFrom < normalized.length) {
    const firstIdx = normalized.indexOf(words[0], searchFrom);
    if (firstIdx < 0) break;

    let end = firstIdx + words[0].length;
    let matched = true;
    for (let w = 1; w < words.length; w++) {
      const nextIdx = normalized.indexOf(words[w], end);
      if (nextIdx < 0 || nextIdx - end > maxGap) {
        matched = false;
        break;
      }
      end = nextIdx + words[w].length;
    }

    if (matched) {
      const span = end - firstIdx;
      if (span <= spanLimit) {
        if (!best) {
          best = { start: firstIdx, end };
        } else if (preferEarliest) {
          if (
            firstIdx < best.start ||
            (firstIdx === best.start && span > best.end - best.start)
          ) {
            best = { start: firstIdx, end };
          }
        } else if (span < best.end - best.start) {
          best = { start: firstIdx, end };
        }
      }
    }
    searchFrom = firstIdx + 1;
  }

  if (!best) return null;
  const matchedPhrase = normalized.slice(best.start, best.end);
  const highlightItems = itemIndicesForRange(parts, best.start, best.end);
  if (!highlightItems.length) return null;
  return { matchedPhrase, highlightItems };
}

/** Match distinctive content words in order (skips stop words in query). Last resort. */
function findFlexibleContentWords(
  normalized: string,
  parts: PdfTextPart[],
  query: string,
): { matchedPhrase: string; highlightItems: number[] } | null {
  const words = normalizeWhitespace(query)
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  if (words.length < 3) return null;
  return findOrderedWordsSpan(normalized, parts, words.join(" "), ORDERED_WORD_GAP + 40);
}

function findMatchForQuery(
  normalized: string,
  parts: PdfTextPart[],
  query: string,
): { matchedPhrase: string; highlightItems: number[] } | null {
  return (
    findExactPhrase(normalized, parts, query) ??
    findOrderedWordsSpan(normalized, parts, query, ORDERED_WORD_GAP, maxHighlightSpan(query) * 2) ??
    findFlexibleContentWords(normalized, parts, query)
  );
}

/** Strict match for yellow highlight — no loose stop-word fallback. */
function findHighlightMatchForQuery(
  normalized: string,
  parts: PdfTextPart[],
  query: string,
): { matchedPhrase: string; highlightItems: number[] } | null {
  return (
    findExactPhrase(normalized, parts, query) ??
    findOrderedWordsSpan(
      normalized,
      parts,
      query,
      HIGHLIGHT_WORD_GAP,
      maxHighlightSpan(query),
      true,
    )
  );
}

/** Precise highlight on a single page — used after the target page is known. */
export function findHighlightInItems(
  items: PdfTextItem[],
  query: string,
): { matchedPhrase: string; highlightItems: number[] } | null {
  const q = query?.trim();
  if (!q) return null;

  const { normalized, parts } = buildTextIndex(items);
  if (!normalized) return null;

  for (const variant of buildPdfSearchVariants(q)) {
    const hit = findHighlightMatchForQuery(normalized, parts, variant);
    if (hit) return hit;
  }

  for (const variant of spellingVariants(normalizeWhitespace(q))) {
    const hit = findHighlightMatchForQuery(normalized, parts, variant);
    if (hit) return hit;
  }

  return findHighlightMatchForQuery(normalized, parts, q);
}

/** Find phrase match in a page's text items — tries multiple query variants. */
export function findTextMatchInItems(
  items: PdfTextItem[],
  query: string,
): { matchedPhrase: string; highlightItems: number[] } | null {
  const q = query?.trim();
  if (!q) return null;

  const { normalized, parts } = buildTextIndex(items);
  if (!normalized) return null;

  for (const variant of buildPdfSearchVariants(q)) {
    const hit = findMatchForQuery(normalized, parts, variant);
    if (hit) return hit;
  }

  return findMatchForQuery(normalized, parts, q);
}

type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

/** Per-page text — used for lighter prefetch (single pass, early exit). */
export async function extractPdfPagesText(pdf: PdfDoc): Promise<string[]> {
  const pages: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const line = (content.items as PdfTextItem[])
      .map((i) => (i.str ?? "").trim())
      .filter(Boolean)
      .join(" ");
    pages.push(line);
  }
  return pages;
}

async function getPageTextItems(pdf: PdfDoc, pageNum: number): Promise<PdfTextItem[]> {
  const page = await pdf.getPage(pageNum);
  const content = await page.getTextContent();
  return content.items as PdfTextItem[];
}

/** First page containing the phrase — stops early; no highlight indices. */
export async function findPageForPhrase(
  pdf: PdfDoc,
  query: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const q = query?.trim();
  if (!q || signal?.aborted) return null;

  for (let p = 1; p <= pdf.numPages; p++) {
    if (signal?.aborted) return null;
    try {
      const items = await getPageTextItems(pdf, p);
      if (findHighlightInItems(items, q)) return p;
    } catch (err) {
      if (signal?.aborted) return null;
      const msg = err instanceof Error ? err.message : String(err);
      if (/transport destroyed|detached ArrayBuffer/i.test(msg)) return null;
      throw err;
    }
  }
  return null;
}

/** Concatenate all page text from a loaded PDF (same order as PDF.js items). */
export async function extractPdfFullText(pdf: PdfDoc): Promise<string> {
  const pages = await extractPdfPagesText(pdf);
  return pages.filter(Boolean).join("\n\n");
}

/** Search all pages; returns page number with precise highlight item indices. */
export async function findMatchInPdf(
  pdf: PdfDoc,
  query: string,
): Promise<{ page: number; matchedPhrase: string; highlightItems: number[] } | null> {
  const q = query?.trim();
  if (!q) return null;

  const variants = buildPdfSearchVariants(q);
  let targetPage: number | null = null;

  for (const variant of variants) {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = content.items as PdfTextItem[];
      const { normalized, parts } = buildTextIndex(items);
      const located =
        findExactPhrase(normalized, parts, variant) ??
        findOrderedWordsSpan(
          normalized,
          parts,
          variant,
          HIGHLIGHT_WORD_GAP,
          maxHighlightSpan(variant),
          true,
        ) ??
        findMatchForQuery(normalized, parts, variant);
      if (located) {
        targetPage = p;
        break;
      }
    }
    if (targetPage) break;
  }

  if (!targetPage) return null;

  const page = await pdf.getPage(targetPage);
  const content = await page.getTextContent();
  const highlight =
    findHighlightInItems(content.items as PdfTextItem[], q) ??
    findTextMatchInItems(content.items as PdfTextItem[], q);

  if (!highlight) return null;

  return {
    page: targetPage,
    matchedPhrase: highlight.matchedPhrase,
    highlightItems: highlight.highlightItems,
  };
}
