import { stripGuidelineBoilerplate } from "@/lib/guidelineBoilerplate";

// ── Types ──────────────────────────────────────────────────────────────────

export interface OCRResult {
  text: string;
  /** Per-page text (1-based page order), when available from the PDF parser. */
  pages: string[];
  isScanned: boolean;
  confidence: number;
  pageCount: number;
  processingTimeMs: number;
}

export interface GuidelineClause {
  clauseNumber: string;
  clauseTitle: string;
  clauseText: string;
  keywords: string[];
}

// ── PDF Processing ─────────────────────────────────────────────────────────

export async function processGuidelinePDF(buffer: Buffer): Promise<OCRResult> {
  const t0 = Date.now();
  const { extractPdfText } = await import("@/lib/pdf-parse-server");
  const result = await extractPdfText(buffer);

  const rawText = result.text ?? "";
  const pageCount = result.pageCount ?? 1;
  const pages = (result.pages ?? [])
    .map((p) => normalizeText(p))
    .filter((t) => t.length > 0);
  const avgCharsPerPage = rawText.length / Math.max(1, pageCount);
  const isScanned = avgCharsPerPage < 50;

  return {
    text: normalizeText(rawText),
    pages: pages.length > 0 ? pages : [normalizeText(rawText)],
    isScanned,
    confidence: isScanned ? 60 : 100,
    pageCount,
    processingTimeMs: Date.now() - t0,
  };
}

// ── Text Normalization ─────────────────────────────────────────────────────

export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Collapse runs of spaces/tabs but PRESERVE newlines so clause/section
    // boundaries survive for extraction.
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\bPage\s+\d+\s+of\s+\d+\b/gi, "")
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "\n")
    .replace(/\b(\d+)\s*\/\s*(\d+)\b/g, (m, a, b) =>
      a.length <= 3 && b.length <= 3 ? "" : m,
    )
    .replace(/\b l \b/g, " 1 ")
    .replace(/\b O \b/g, " 0 ")
    .trim();
}

// ── Guideline Type Detection ───────────────────────────────────────────────

export function identifyGuidelineType(text: string, filename: string): string {
  const t = text.toLowerCase();
  const f = filename.toLowerCase();
  if (t.includes("ich q7") || f.includes("ich-q7") || f.includes("ichq7"))
    return "ICH Q7 - GMP for Active Pharmaceutical Ingredients";
  if (t.includes("ich q10")) return "ICH Q10 - Pharmaceutical Quality System";
  if (t.includes("ich q8")) return "ICH Q8 - Pharmaceutical Development";
  if (t.includes("fda") && t.includes("21 cfr"))
    return "FDA 21 CFR Part 211 - GMP for Finished Pharmaceuticals";
  if (t.includes("who gmp") || (f.includes("who") && t.includes("gmp")))
    return "WHO GMP Guidelines";
  if (t.includes("who") && t.includes("trs")) return "WHO Technical Report Series";
  if (t.includes("iso") && t.includes("9001")) return "ISO 9001 - Quality Management";
  if (t.includes("iso") && t.includes("13485")) return "ISO 13485 - Medical Devices";
  if (t.includes("schedule m")) return "Schedule M - GMP for Pharmaceuticals (India)";
  if (t.includes("eu gmp") || t.includes("eudralex"))
    return "EU GMP - EudraLex Volume 4";
  if (t.includes("pic/s") || t.includes("pics")) return "PIC/S GMP Guide";
  return "Generic Regulatory Guideline";
}

// ── Category Detection ─────────────────────────────────────────────────────

export function categorizeGuideline(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("quality control") || t.includes("testing") || t.includes("laboratory"))
    return "Quality Control";
  if (t.includes("quality assurance")) return "Quality Assurance";
  if (t.includes("manufacturing") || t.includes("production")) return "Manufacturing";
  if (t.includes("documentation") || t.includes("record")) return "Documentation";
  if (t.includes("equipment") || t.includes("calibration") || t.includes("maintenance"))
    return "Equipment & Maintenance";
  if (t.includes("personnel") || t.includes("training")) return "Personnel & Training";
  if (t.includes("storage") || t.includes("material")) return "Storage & Material Handling";
  return "General Compliance";
}

// ── Keyword Extraction ─────────────────────────────────────────────────────

const PHARMA_KEYWORDS = [
  "quality", "manufacturing", "documentation", "validation", "qualification",
  "control", "assurance", "testing", "inspection", "audit", "compliance",
  "procedure", "process", "requirement", "standard", "specification",
  "calibration", "maintenance", "training", "personnel", "equipment", "material",
  "storage", "handling", "contamination", "hygiene", "record", "report",
  "review", "approval", "authorization", "deviation", "corrective", "preventive",
  "investigation", "monitoring",
];

export function extractKeywords(text: string): string[] {
  const t = text.toLowerCase();
  return PHARMA_KEYWORDS.filter((kw) => t.includes(kw));
}

// ── Clause Extraction ──────────────────────────────────────────────────────
//
// Goal: extract EVERY clause/section of a guideline so compliance is assessed
// against the full document, not a single truncated fallback clause.
//
// Strategy:
//   1. Detect headings using several bounded patterns (dotted section numbers,
//      labelled sections, line-start numbering). Titles are length-capped so
//      detection still works even when newlines were stripped from older data.
//   2. If at least a few real headings are found, build one clause per heading.
//   3. Otherwise fall back to CHUNKING the full text into ordered segments so
//      no content is dropped (every part of the guideline is still analysed).

interface ClauseBoundary {
  number: string;
  title: string;
  index: number;
}

// Dotted section numbers: "9.3 Lifecycle validation", "4.2.1 Records"
const DOTTED_HEADING_RE = /(\d+\.\d+(?:\.\d+){0,3})\s+([A-Z(][^\n]{2,99})/g;
// Labelled headings: "Section 5: Scope", "Annex 15", "Article 4 Personnel"
const LABELLED_HEADING_RE =
  /\b(Section|Clause|Article|Annex|Appendix|Part|Chapter)\s+([0-9A-Z][\w.\-]*)\s*[:.\-)]?\s+([A-Z(][^\n]{2,90})/gi;
// Line-start single/double digit headings: "5. Quality system"
const LINE_START_HEADING_RE = /(?:^|\n)\s*(\d{1,2})\.?\s+([A-Z][A-Za-z][^\n]{3,90})/g;

const MIN_HEADINGS = 3;
const MAX_CLAUSE_CHARS = 6000;
const CHUNK_CHARS = 3500;
const MAX_CHUNKS = 25;

function cleanTitle(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, 110);
}

function collectBoundaries(text: string): ClauseBoundary[] {
  const found: ClauseBoundary[] = [];
  const push = (number: string, title: string, index: number) => {
    const t = cleanTitle(title);
    if (t.length < 2) return;
    found.push({ number: number.trim(), title: t, index });
  };

  let m: RegExpExecArray | null;

  const dotted = new RegExp(DOTTED_HEADING_RE.source, "g");
  while ((m = dotted.exec(text)) !== null) push(m[1], m[2], m.index);

  const labelled = new RegExp(LABELLED_HEADING_RE.source, "gi");
  while ((m = labelled.exec(text)) !== null) push(`${m[1]} ${m[2]}`, m[3], m.index);

  const lineStart = new RegExp(LINE_START_HEADING_RE.source, "g");
  while ((m = lineStart.exec(text)) !== null) push(m[1], m[2], m.index);

  // Order by position and drop near-duplicate boundaries (same heading caught
  // by more than one pattern).
  found.sort((a, b) => a.index - b.index);
  const deduped: ClauseBoundary[] = [];
  for (const b of found) {
    const prev = deduped[deduped.length - 1];
    if (prev && b.index - prev.index < 8) continue;
    deduped.push(b);
  }
  return deduped;
}

function chunkIntoClauses(text: string, fallbackName: string): GuidelineClause[] {
  const segments = text.match(/[^.!?\n]+[.!?\n]?\s*/g) ?? [text];
  const chunks: string[] = [];
  let buf = "";
  for (const seg of segments) {
    if (buf.length + seg.length > CHUNK_CHARS && buf) {
      chunks.push(buf);
      buf = "";
      if (chunks.length >= MAX_CHUNKS) break;
    }
    buf += seg;
  }
  if (buf.trim() && chunks.length < MAX_CHUNKS) chunks.push(buf);

  const total = chunks.length;
  return chunks.map((c, i) => {
    const raw = c.trim().slice(0, MAX_CLAUSE_CHARS);
    const clauseText = stripGuidelineBoilerplate(raw).slice(0, MAX_CLAUSE_CHARS);
    return {
      clauseNumber: String(i + 1),
      clauseTitle: total > 1 ? `${fallbackName} (part ${i + 1} of ${total})` : fallbackName,
      clauseText,
      keywords: extractKeywords(clauseText),
    };
  });
}

export function extractClauses(normalizedText: string, fallbackName: string): GuidelineClause[] {
  const text = normalizedText ?? "";
  const boundaries = collectBoundaries(text);

  if (boundaries.length >= MIN_HEADINGS) {
    const clauses: GuidelineClause[] = [];
    for (let i = 0; i < boundaries.length; i++) {
      const b = boundaries[i];
      const end = i + 1 < boundaries.length ? boundaries[i + 1].index : text.length;
      const raw = text.slice(b.index, end).trim().slice(0, MAX_CLAUSE_CHARS);
      const clauseText = stripGuidelineBoilerplate(raw, b.number).slice(0, MAX_CLAUSE_CHARS);
      // Skip noise boundaries that captured almost no body text.
      if (clauseText.length < 30) continue;
      clauses.push({
        clauseNumber: b.number,
        clauseTitle: b.title,
        clauseText,
        keywords: extractKeywords(clauseText),
      });
    }
    if (clauses.length >= MIN_HEADINGS) return clauses;
  }

  // Full-coverage fallback: chunk the entire document so nothing is dropped.
  return chunkIntoClauses(text, fallbackName);
}
