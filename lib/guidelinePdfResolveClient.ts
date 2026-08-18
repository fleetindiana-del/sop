import {
  findClauseSectionStart,
  isGuidelineBoilerplate,
  sliceGuidelineSection,
} from '@/lib/guidelineBoilerplate';
import {
  isSmartSearchTerm,
  resolveDocPhraseInDocument,
  textSupportedByBody,
  type PdfSearchResolution,
} from '@/lib/guidelineDocSearch';
import { openGuidelinePdf } from '@/lib/guidelinePdfLoader';
import { isPdfTransportError, mergeAbortSignals } from '@/lib/guidelinePdfResolveQueue';
import {
  extractPdfFullText,
  findMatchInPdf,
  findPageForPhrase,
  type PdfTextItem,
} from '@/lib/pdfTextSearch';

export interface ResolveGuidelinePdfSearchInput {
  guidelineId: string;
  searchPhrase: string;
  searchAnchors?: string[];
  clauseNumber?: string;
  requirementText?: string;
  /** Text already stored on the finding — skips full-PDF phrase mining when sufficient. */
  clauseText?: string;
  /** Prefetch uses a lighter page lookup; modal uses full highlight scan. */
  mode?: 'prefetch' | 'full';
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Resolve search phrase and requirement point from extracted PDF text. */
export function resolveSearchPhraseFromText(
  pdfText: string,
  searchPhrase: string,
  searchAnchors: string[] = [],
  clauseNumber?: string,
): { query: string; point: string } {
  const scoped = sliceGuidelineSection(pdfText, clauseNumber);
  const anchors = [searchPhrase.trim(), ...searchAnchors.map((a) => a.trim())].filter(Boolean);

  let query = searchPhrase.trim();
  let point = '';

  const docPhrase = resolveDocPhraseInDocument(scoped, anchors, clauseNumber);
  if (docPhrase?.searchPhrase) {
    query = docPhrase.searchPhrase;
    point = docPhrase.fullPoint;
  } else if (query && !textSupportedByBody(scoped, query) && !textSupportedByBody(pdfText, query)) {
    query = '';
  }

  return { query, point };
}

export function buildPdfSearchResolution(
  query: string,
  point: string,
  requirementText: string,
  matchFound: boolean,
  matchPage?: number,
): PdfSearchResolution | null {
  if (!query) return null;
  const compareReq = point || requirementText.trim();
  return {
    searchPhrase: query,
    fullPoint: point || undefined,
    isSmartSearch: isSmartSearchTerm(compareReq, query),
    matchFound,
    matchPage: matchFound ? matchPage : undefined,
  };
}

async function getPageText(
  pdf: import('pdfjs-dist').PDFDocumentProxy,
  pageNum: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return '';
  try {
    const page = await pdf.getPage(pageNum);
    if (signal?.aborted) return '';
    const content = await page.getTextContent();
    return (content.items as PdfTextItem[])
      .map((i) => (i.str ?? '').trim())
      .filter(Boolean)
      .join(' ');
  } catch (err) {
    if (signal?.aborted || isPdfTransportError(err)) return '';
    throw err;
  }
}

/**
 * Stream pages until we can resolve a phrase, or exhaust the document.
 * Stops early once a good doc phrase is found — avoids parsing every page of large PDFs.
 */
async function resolvePhraseStreaming(
  pdf: import('pdfjs-dist').PDFDocumentProxy,
  searchPhrase: string,
  searchAnchors: string[],
  clauseNumber?: string,
  signal?: AbortSignal,
): Promise<{ query: string; point: string; pdfText: string }> {
  const anchors = [searchPhrase.trim(), ...searchAnchors.map((a) => a.trim())].filter(Boolean);
  let accumulated = '';
  let best: { query: string; point: string } | null = null;
  const clauseNum = clauseNumber?.replace(/[^\d.]/g, "") ?? "";

  for (let p = 1; p <= pdf.numPages; p++) {
    if (signal?.aborted) break;
    const pageText = await getPageText(pdf, p, signal);
    if (signal?.aborted) break;
    if (!pageText) continue;
    accumulated += (accumulated ? '\n\n' : '') + pageText;

    if (accumulated.length < 120) continue;

    // When a clause is cited, wait until that section appears — do not lock onto
    // early intro pages that share generic words (e.g. "intermediate", "API").
    if (clauseNum) {
      const sectionStart = findClauseSectionStart(accumulated, clauseNum);
      if (sectionStart < 0) continue;
      const section = sliceGuidelineSection(accumulated, clauseNum);
      if (section.length < 40) continue;
      const resolved = resolveSearchPhraseFromText(section, searchPhrase, searchAnchors, clauseNum);
      if (resolved.query && textSupportedByBody(section, resolved.query)) {
        const candidate = resolved.point || resolved.query;
        if (isGuidelineBoilerplate(candidate)) continue;
        best = resolved;
        if (resolved.point) break;
      }
      continue;
    }

    const resolved = resolveSearchPhraseFromText(accumulated, searchPhrase, searchAnchors, clauseNumber);
    if (resolved.query && textSupportedByBody(accumulated, resolved.query)) {
      const candidate = resolved.point || resolved.query;
      if (isGuidelineBoilerplate(candidate)) continue;
      best = resolved;
      if (resolved.point) break;
    }
  }

  if (signal?.aborted) {
    return { query: best?.query ?? '', point: best?.point ?? '', pdfText: accumulated };
  }

  if (best) return { ...best, pdfText: accumulated };

  const fallback = resolveSearchPhraseFromText(accumulated, searchPhrase, anchors, clauseNumber);
  return { ...fallback, pdfText: accumulated };
}

async function resolvePrefetch(
  pdf: import('pdfjs-dist').PDFDocumentProxy,
  input: ResolveGuidelinePdfSearchInput,
): Promise<PdfSearchResolution | null> {
  const {
    searchPhrase,
    searchAnchors = [],
    clauseNumber,
    requirementText = '',
    clauseText = '',
    signal,
  } = input;

  if (signal?.aborted) return null;

  const clauseBody = clauseText.trim();
  const initialPhrase = searchPhrase.trim();

  // Fast path: stored clause text already supports the search phrase — only locate page in PDF.
  if (
    initialPhrase &&
    clauseBody.length >= 80 &&
    textSupportedByBody(clauseBody, initialPhrase)
  ) {
    const fromClause = resolveSearchPhraseFromText(
      clauseBody,
      searchPhrase,
      searchAnchors,
      clauseNumber,
    );
    const query = fromClause.query || initialPhrase;
    const point = fromClause.point || requirementText.trim();
    if (signal?.aborted) return null;
    const page = await findPageForPhrase(pdf, query, signal);
    // Only trust the stored phrase when it is actually locatable in the PDF.
    // If it isn't, the stored clause text diverges from the document — fall
    // through to the full scan so the card resolves the same verbatim point the
    // modal shows, instead of displaying an unverified (possibly wrong) point.
    if (page) {
      return buildPdfSearchResolution(query, point, requirementText, true, page);
    }
  }

  const { query, point } = await resolvePhraseStreaming(
    pdf,
    searchPhrase,
    searchAnchors,
    clauseNumber,
    signal,
  );

  if (signal?.aborted || !query) return null;

  const page = await findPageForPhrase(pdf, query, signal);
  return buildPdfSearchResolution(query, point, requirementText, !!page, page ?? undefined);
}

/**
 * Load a guideline PDF, resolve the best verbatim search phrase, and locate the page.
 * Prefetch is timeout-bounded via abort (always awaited to completion before queue advances).
 */
export async function resolveGuidelinePdfSearch(
  input: ResolveGuidelinePdfSearchInput,
): Promise<PdfSearchResolution | null> {
  const {
    guidelineId,
    searchPhrase,
    searchAnchors = [],
    clauseNumber,
    requirementText = '',
    mode = 'full',
    signal: parentSignal,
    timeoutMs = mode === 'prefetch' ? 18_000 : 30_000,
  } = input;
  if (!guidelineId.trim()) return null;

  const timeoutAc = new AbortController();
  const timeoutId = setTimeout(() => timeoutAc.abort(), timeoutMs);
  const signal = mergeAbortSignals(parentSignal, timeoutAc.signal);

  let pdf: import('pdfjs-dist').PDFDocumentProxy | null = null;

  try {
    if (signal.aborted) return null;

    pdf = await openGuidelinePdf(guidelineId, signal);
    if (signal.aborted) return null;

    if (mode === 'prefetch') {
      return await resolvePrefetch(pdf, { ...input, signal });
    }

    const pdfText = await extractPdfFullText(pdf);
    if (signal.aborted) return null;

    const { query, point } = resolveSearchPhraseFromText(
      pdfText,
      searchPhrase,
      searchAnchors,
      clauseNumber,
    );

    let foundPage: number | undefined;
    let found = false;

    if (query && !signal.aborted) {
      const hit = await findMatchInPdf(pdf, query);
      if (hit) {
        foundPage = hit.page;
        found = true;
      }
    }

    return buildPdfSearchResolution(query, point, requirementText, found, foundPage);
  } catch (err) {
    if (!signal.aborted && !isPdfTransportError(err)) {
      console.warn('[resolveGuidelinePdfSearch]', err);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (pdf) await pdf.destroy().catch(() => {});
  }
}
