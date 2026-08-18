/** Shared detection of regulatory document chrome (cover pages, gazettes, headers). */

const BOILERPLATE_START_RE =
  /^(?:\d+\s+)?(?:EUROPEAN COMMISSION|EudraLex|Volume\s+\d|The Rules Governing|Brussels|SANCO\/|INTERNATIONAL CONFERENCE ON HARMONISATION|ICH HARMONISED|ICH Harmonised|WHO Library|World Health Organization|PIC\/S|PHARMACEUTICAL INSPECTION)/i;

const BOILERPLATE_SIGNAL_RE = [
  /\bMINISTRY OF HEALTH\b/i,
  /\bMINISTRY OF\b.*\bWELFARE\b/i,
  /\bNOTIFICATION\b/i,
  /\bG\.S\.R\.\s*\d/i,
  /\bNew Delhi\b/i,
  /\bDrugs and Cosmetics Act\b/i,
  /\bDrugs Rules,?\s*1945\b/i,
  /\bWhereas,?\s+a draft\b/i,
  /\bGovernment of India\b/i,
  /\bDepartment of Health\b/i,
  /\bFamily Welfare\b/i,
  /\bvide notification\b/i,
  /\bOfficial Gazette\b/i,
  /\b\d{4}\s+GI\/\d+/i,
  /\bINTERNATIONAL CONFERENCE ON HARMONISATION\b/i,
  /\bICH HARMONISED TRIPARTITE GUIDELINE\b/i,
  /\bICH Harmonised Tripartite Guideline\b/i,
  /\bCurrent Step\s+\d\b/i,
  /\bAt Step\s+\d+\s+of the Process\b/i,
  /\bhas been developed by the appropriate ICH\b/i,
  /\brecommended for adoption to the regulatory bodies\b/i,
  /\bEuropean Union, Japan and USA\b/i,
  /\bThis Guideline has been developed\b/i,
  /\bThis Guide is not intended to define\b/i,
  /\bnot intended to define registration requirements\b/i,
  /\bdoes not affect the ability of the responsible competent authority\b/i,
  /\bmodify pharmacopoeial requirements\b/i,
  /\bRegulatory Members of the ICH Assembly\b/i,
  /\bAdoption by the Regulatory Members\b/i,
  /\bICH Assembly under Step\b/i,
  /\bEditorial corrections approved\b/i,
  /\bapproved by the MC within the core text\b/i,
  /\bunder Step\s+\d+\s+\d+\s+[A-Z]+\b/i,
  /\bsubject to consultation by the regulatory parties\b/i,
  /\bWHO Technical Report Series\b/i,
  /\bWorld Health Organization\b/i,
  /\bCopyright\b/i,
  /\bAll rights reserved\b/i,
  /\bTable of Contents\b/i,
  /\bPage\s+\d+\s+of\s+\d+\b/i,
  /--\s*\d+\s+of\s+\d+\s*--/i,
  /\bDocument History\b/i,
  /\bLegal notice\b/i,
  /\bTABLE OF CONTENTS\b/i,
  /\bLegal basis for publishing\b/i,
  /\bEudraLex\b/i,
  /\bHEALTH AND CONSUMERS\b/i,
  /\bDirectorate-General\b/i,
  /\bMedicinal Product[s]?[–-]\s*quality\b/i,
  /\bEU Guidelines for Good Manufacturing Practice\b/i,
  /\bRules Governing Medicinal Products\b/i,
  /\bVolume\s+4\b/i,
];

const HEADING_ONLY_RE =
  /^(?:SCHEDULE|Schedule|CHAPTER|Chapter|Part|PART|Section|SECTION|Annex|ANNEX|GUIDELINE|Guideline)[\s\-–.:]*[A-Z0-9][\s\-–.:A-Z0-9]*$/i;

/** TOC dotted leaders: "2 Time Limits ........" / "Time Limits ….." */
const TOC_DOTTED_LEADER_RE = /\.{4,}|…{2,}|\u2026{2,}|(?:\.\s*){5,}/;

export const REQUIREMENT_VERB_RE =
  /\b(shall|must|should|ensure|adequate|required|manufacturer|premises|procedure|validation|documentation|comply|maintain|establish|control|monitoring|hygiene|sanitation|equipment|personnel|appropriate|responsible|defined|implemented|reviewed|approved)\b/i;

/** True when text is a table-of-contents entry, not assessable requirement body. */
export function isTableOfContentsLine(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return true;
  // Dotted leaders are definitive TOC chrome (e.g. "2 Time Limits ........")
  if (TOC_DOTTED_LEADER_RE.test(t)) return true;
  return false;
}

function signalCount(text: string): number {
  let n = 0;
  if (BOILERPLATE_START_RE.test(text.trim())) n += 2;
  for (const re of BOILERPLATE_SIGNAL_RE) {
    if (re.test(text)) n++;
  }
  return n;
}

/** Document chrome — not assessable requirement content. */
export function isGuidelineBoilerplate(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 12) return true;
  if (isTableOfContentsLine(t)) return true;
  if (BOILERPLATE_START_RE.test(t)) return true;
  if (signalCount(t) >= 2) return true;
  // Long run-on blocks mixing cover page + chapter header (common in EudraLex PDFs)
  if (t.length > 150 && /\b(EudraLex|EUROPEAN COMMISSION|Volume\s+4)\b/i.test(t)) return true;
  if (/\bLegal basis for publishing\b/i.test(t)) return true;
  for (const re of BOILERPLATE_SIGNAL_RE) {
    if (re.test(t) && t.length < 280) return true;
  }
  if (HEADING_ONLY_RE.test(t) && t.length < 100) return true;
  if (/^Chapter\s+\d/i.test(t) && t.length < 100) return true;
  if (/^Part\s+\d/i.test(t) && t.length < 80) return true;
  if (t.length < 120 && t === t.toUpperCase() && /\b(MINISTRY|NOTIFICATION|ICH|HARMONISED|GUIDELINE|SCHEDULE)\b/.test(t)) {
    return true;
  }
  if (/--\s*\d+\s+of\s+\d+\s*--/.test(t)) return true;
  return false;
}

export function isHeadingOnlyTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (HEADING_ONLY_RE.test(t) && t.length < 100) return true;
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize whitespace for substring checks. */
export function normalizeGuidelineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Split into sentences without breaking on section/decimal numbers (6.41, 8.20). */
export function splitGuidelineSentences(text: string): string[] {
  const placeholders: string[] = [];
  const protectedText = text.replace(/\b\d+\.\d+(?:\.\d+)*\b/g, (m) => {
    const key = `__NUM${placeholders.length}__`;
    placeholders.push(m);
    return key;
  });
  const raw = protectedText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [protectedText];
  return raw
    .map((s) =>
      normalizeGuidelineText(
        s.replace(/__NUM(\d+)__/g, (_, i) => placeholders[Number(i)] ?? ""),
      ),
    )
    .filter(Boolean);
}

/** True when `text` appears verbatim inside the stored guideline clause blob. */
export function isTextInGuideline(text: string, clauseText: string): boolean {
  const needle = normalizeGuidelineText(text);
  const hay = normalizeGuidelineText(clauseText);
  if (needle.length < 18 || hay.length < 18) return false;
  if (hay.toLowerCase().includes(needle.toLowerCase())) return true;
  const prefix = needle.slice(0, Math.min(72, needle.length));
  return prefix.length >= 24 && hay.toLowerCase().includes(prefix.toLowerCase());
}

export function substantiveScore(text: string, requirement?: string): number {
  if (isGuidelineBoilerplate(text)) return -1;
  let score = 0;
  if (REQUIREMENT_VERB_RE.test(text)) score += 5;
  if (/\d+\.\d+/.test(text)) score += 2;
  if (text.length >= 50) score += 1;
  if (text.length >= 90) score += 1;
  if (text.length > 320) score -= 4;
  if (requirement) {
    const wordsA = new Set(requirement.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const wordsB = requirement.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (wordsA.size && wordsB.length) {
      const overlap = wordsB.filter((w) => wordsA.has(w)).length / wordsA.size;
      score += overlap * 8;
    }
  }
  return score;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "shall", "must", "should",
  "have", "been", "are", "was", "will", "their", "they", "which", "when", "where",
]);

function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.5 ? slice.slice(0, lastSpace) : slice).trimEnd() + "…";
}

/**
 * One concise requirement sentence for display and PDF search — never cover-page chrome.
 */
export function compactRequirementText(text: string, maxLen = 260): string {
  const t = normalizeGuidelineText(text);
  if (!t || isGuidelineBoilerplate(t)) return "";

  const sentences = splitGuidelineSentences(t);

  for (const raw of sentences) {
    const sent = normalizeGuidelineText(raw);
    if (sent.length < 20 || isGuidelineBoilerplate(sent)) continue;
    if (REQUIREMENT_VERB_RE.test(sent) || /\d+\.\d+/.test(sent)) {
      return sent.length <= maxLen ? sent : truncateAtWordBoundary(sent, maxLen);
    }
  }

  for (const raw of sentences) {
    const sent = normalizeGuidelineText(raw);
    if (sent.length >= 20 && !isGuidelineBoilerplate(sent)) {
      return sent.length <= maxLen ? sent : truncateAtWordBoundary(sent, maxLen);
    }
  }

  if (t.length <= maxLen && !isGuidelineBoilerplate(t)) return t;
  return truncateAtWordBoundary(t, maxLen);
}

/** Score a candidate offset as a real clause body start (not TOC / cover). */
function scoreClauseSectionStart(text: string, idx: number): number {
  const head = text.slice(idx, idx + 100).split(/\n/)[0] || "";
  if (isTableOfContentsLine(head)) return -100;
  const window = text.slice(idx, idx + 600);
  let score = 0;
  if (REQUIREMENT_VERB_RE.test(window)) score += 12;
  // ICH-style numbered paragraphs under the heading (8.20, 8.21)
  if (/\b\d+\.\d{2,}\b/.test(window)) score += 8;
  // Prefer later hits — TOC entries usually appear before the real section body
  score += Math.min(8, Math.floor(idx / 1500));
  if (window.length < 40) score -= 5;
  return score;
}

/**
 * Locate the start of a numbered guideline section in full document text.
 * Prefers the real body over TOC dotted-leader entries.
 */
export function findClauseSectionStart(
  text: string,
  clauseNumber?: string,
  clauseTitle?: string,
): number {
  const num = clauseNumber?.replace(/[^\d.]/g, "") ?? "";
  if (!num || text.length < 20) return -1;

  const hits: number[] = [];
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*${escapeRegex(num)}(?!\\d)\\s+[A-Za-z(]`, "gm"),
    new RegExp(`(?:^|\\n)\\s*${escapeRegex(num)}\\.\\d+\\s+[A-Za-z(]`, "gm"),
    new RegExp(`(?:^|\\n)\\s*${escapeRegex(num)}\\.\\s+[A-Z][A-Za-z]`, "gm"),
  ];
  if (clauseTitle?.trim() && !isHeadingOnlyTitle(clauseTitle) && !isTableOfContentsLine(clauseTitle)) {
    const title = escapeRegex(clauseTitle.trim().slice(0, 48));
    patterns.push(
      new RegExp(`(?:^|\\n)\\s*${escapeRegex(num)}(?!\\d)\\s*[.:\\-–]?\\s*${title}`, "gim"),
    );
  }

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    const local = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    while ((m = local.exec(text)) !== null) {
      if (m.index === undefined) continue;
      // (^|\n) + \s* can consume multiple newlines — land on the first non-space char
      const lead = m[0].match(/^\s*/)?.[0].length ?? 0;
      hits.push(m.index + lead);
    }
  }

  const unique = [...new Set(hits.filter((i) => i >= 0 && i < text.length))];
  if (!unique.length) return -1;

  let best = unique[0];
  let bestScore = scoreClauseSectionStart(text, best);
  for (const idx of unique.slice(1)) {
    const s = scoreClauseSectionStart(text, idx);
    if (s > bestScore) {
      bestScore = s;
      best = idx;
    }
  }
  return bestScore >= 0 ? best : -1;
}

/** End offset of section `num` — next peer/higher heading, or a bounded window. */
export function findClauseSectionEnd(text: string, start: number, clauseNumber: string): number {
  const num = clauseNumber.replace(/[^\d.]/g, "");
  if (!num || start < 0) return text.length;

  const parts = num.split(".");
  const major = parts[0];
  const minor = parts.length > 1 ? Number.parseInt(parts[1], 10) : Number.NaN;
  const after = text.slice(start + Math.min(12, Math.max(1, num.length)));

  const tryMatch = (re: RegExp): number | null => {
    const m = after.match(re);
    if (m?.index === undefined) return null;
    return start + Math.min(12, Math.max(1, num.length)) + m.index;
  };

  if (!Number.isNaN(minor)) {
    const nextMinor = tryMatch(
      new RegExp(`(?:^|\\n)\\s*${escapeRegex(major)}\\.${minor + 1}(?!\\d)\\b`, "m"),
    );
    if (nextMinor != null) return nextMinor;
  }

  const nextMajorNum = Number.parseInt(major, 10) + 1;
  if (!Number.isNaN(nextMajorNum)) {
    const nextMajor = tryMatch(
      new RegExp(`(?:^|\\n)\\s*${nextMajorNum}(?:\\.0)?(?!\\d)\\s+[A-Z]`, "m"),
    );
    if (nextMajor != null) return nextMajor;
  }

  return Math.min(text.length, start + 2800);
}

/**
 * Extract only the cited guideline section from a full document blob.
 * Falls back to boilerplate stripping when the heading cannot be located.
 */
export function sliceGuidelineSection(
  text: string,
  clauseNumber?: string,
  clauseTitle?: string,
): string {
  const trimmed = text.trim();
  if (trimmed.length < 20) return trimmed;

  const start = findClauseSectionStart(trimmed, clauseNumber, clauseTitle);
  if (start >= 0 && clauseNumber?.trim()) {
    const end = findClauseSectionEnd(trimmed, start, clauseNumber);
    const slice = trimmed.slice(start, Math.max(end, start + 40)).trim();
    if (slice.length >= 40 && !isTableOfContentsLine(slice.slice(0, 120))) {
      return slice;
    }
  }

  return stripGuidelineBoilerplate(trimmed, clauseNumber);
}

/** Find where numbered assessable content begins (after cover pages). */
export function findGuidelineContentStart(text: string, clauseNumber?: string): number {
  const num = clauseNumber?.replace(/[^\d.]/g, "") ?? "";

  // When a clause is cited, jump to that section — never Math.min with early intro hits.
  if (num) {
    const clauseStart = findClauseSectionStart(text, num);
    if (clauseStart >= 0) return clauseStart;
  }

  const candidates: number[] = [];

  const subsection = text.match(/(?:^|\n)\s*\d+\.\d+\s+[A-Za-z(]/m);
  if (subsection?.index !== undefined) candidates.push(subsection.index);

  const afterPageMarker = text.match(/--\s*\d+\s+of\s+\d+\s*--\s*/i);
  if (afterPageMarker?.index !== undefined) {
    candidates.push(afterPageMarker.index + afterPageMarker[0].length);
  }

  const afterLegalBasis = text.match(/\bLegal basis for publishing[^.]*\.\s*/i);
  if (afterLegalBasis?.index !== undefined) {
    candidates.push(afterLegalBasis.index + afterLegalBasis[0].length);
  }

  const partChapter = text.match(/\bPart\s+\d+\s+Chapter\s+\d+[^.]*\.\s*/i);
  if (partChapter?.index !== undefined) {
    candidates.push(partChapter.index + partChapter[0].length);
  }

  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i].replace(/\s+/g, " ").trim();
    if (s.length >= 30 && substantiveScore(s) >= 5) {
      const idx = text.indexOf(sentences[i]);
      if (idx >= 0) candidates.push(idx);
      break;
    }
  }

  const valid = candidates.filter((i) => i >= 0 && i < text.length);
  return valid.length ? Math.min(...valid) : 0;
}

/** Return clause body with cover pages and gazette preambles removed. */
export function stripGuidelineBoilerplate(clauseText: string, clauseNumber?: string): string {
  const start = findGuidelineContentStart(clauseText, clauseNumber);
  let body = start > 0 ? clauseText.slice(start).trim() : clauseText;

  const paragraphs = body.split(/\n\s*\n+/);
  if (paragraphs.length > 1) {
    let startPara = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      const p = normalizeGuidelineText(paragraphs[i]);
      if (!p || isGuidelineBoilerplate(p) || signalCount(p) >= 2) {
        startPara = i + 1;
        continue;
      }
      break;
    }
    if (startPara > 0) {
      const joined = paragraphs.slice(startPara).join("\n\n").trim();
      if (joined.length >= 24) body = joined;
    }
  }

  const lines = body.split("\n");
  let lineStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = normalizeGuidelineText(lines[i]);
    if (!line) continue;
    if (isGuidelineBoilerplate(line) || (line.length < 40 && HEADING_ONLY_RE.test(line))) {
      lineStart = i + 1;
      continue;
    }
    break;
  }
  body = lines.slice(lineStart).join("\n").trim();

  const sentences = splitGuidelineSentences(body);
  for (let i = 0; i < sentences.length; i++) {
    const s = normalizeGuidelineText(sentences[i]);
    if (s.length >= 28 && substantiveScore(s) >= 4) {
      return sentences.slice(i).join(" ").trim();
    }
  }

  return body.length >= 20 ? body : clauseText;
}
