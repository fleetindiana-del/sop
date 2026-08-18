import { locateGuidelineSource } from "@/lib/guidelineSourceLocator";
import { isSmartSearchTerm, resolveDocPhraseInDocument, textSupportedByBody } from "@/lib/guidelineDocSearch";
import { pdfSearchPhrase, primaryRequirementClause } from "@/lib/pdfTextSearch";
import {
  compactRequirementText,
  isGuidelineBoilerplate,
  isHeadingOnlyTitle,
  isTextInGuideline,
  normalizeGuidelineText,
  REQUIREMENT_VERB_RE,
  sliceGuidelineSection,
  splitGuidelineSentences,
  substantiveScore,
} from "@/lib/guidelineBoilerplate";

export { pdfSearchPhrase };

const FILENAME_TITLE_RE =
  /vol\s*\d|chap\s*\d|anx\s*\d|annex\s*\d|\d{4}[\s_-]\d{2}|\.pdf$|^\s*anx\d+[\s_-]*en\s*$/i;

function looksLikeFilename(title: string): boolean {
  return FILENAME_TITLE_RE.test(title.trim());
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineNumberAt(clauseText: string, charOffset: number): string {
  const before = clauseText.slice(0, Math.max(0, charOffset));
  return String(Math.max(1, before.split("\n").length));
}

function extractChapterHeadingLine(clauseText: string, clauseNumber: string): string | null {
  const num = clauseNumber.replace(/[^\d.]/g, "");
  if (!num) return null;
  const patterns = [
    new RegExp(`Chapter\\s+${escapeRegex(num)}\\s*[\\n\\r]+\\s*([A-Z][A-Za-z0-9 ,\\-–'()]{2,80})`, "i"),
    new RegExp(`Chapter\\s+${escapeRegex(num)}\\s*[:\\-–]\\s*([A-Z][A-Za-z0-9 ,\\-–'()]{2,80})`, "i"),
    new RegExp(`Annex\\s+${escapeRegex(num)}\\s*[\\n\\r]+\\s*([A-Z][A-Za-z0-9 ,\\-–'()]{2,80})`, "i"),
  ];
  for (const re of patterns) {
    const m = clauseText.match(re);
    if (m?.[1]?.trim() && !isGuidelineBoilerplate(m[1])) return m[1].trim();
  }
  return null;
}

/** Prefer human-readable section title over upload filename metadata. */
export function resolveSectionTitle(
  clauseNumber: string,
  clauseTitle: string,
  clauseText: string,
): string {
  if (clauseTitle && !looksLikeFilename(clauseTitle)) return clauseTitle;
  const heading = extractChapterHeadingLine(clauseText, clauseNumber);
  if (heading) return heading;
  return clauseTitle;
}

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
    if (trimmed.length >= 40 && trimmed.length <= 320) add(trimmed);
  }

  return units;
}

function findVerbatimInClause(
  clauseText: string,
  requirement: string,
  clauseNumber?: string,
): { line: string; lineNumber: string } | null {
  if (!requirement || requirement.length < 12) return null;

  const body = sliceGuidelineSection(clauseText, clauseNumber);
  const clauseFlat = normalizeGuidelineText(body);
  const reqFlat = normalizeGuidelineText(requirement);

  const tryMatch = (needle: string): { line: string; lineNumber: string } | null => {
    if (needle.length < 18 || isGuidelineBoilerplate(needle)) return null;
    if (!isTextInGuideline(needle, clauseText) && !isTextInGuideline(needle, body)) return null;
    const idx = clauseFlat.toLowerCase().indexOf(needle.toLowerCase());
    const searchIn = idx >= 0 ? body : clauseText;
    const flat = normalizeGuidelineText(searchIn);
    const pos = flat.toLowerCase().indexOf(needle.toLowerCase());
    if (pos < 0) return null;
    const ratio = searchIn.length / Math.max(1, flat.length);
    return { line: needle, lineNumber: lineNumberAt(searchIn, Math.floor(pos * ratio)) };
  };

  const full = tryMatch(reqFlat);
  if (full) return full;

  const sentences = reqFlat.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [reqFlat];
  for (const s of sentences.map((x) => x.trim()).filter((x) => x.length >= 18).sort((a, b) => b.length - a.length)) {
    const hit = tryMatch(s);
    if (hit) return hit;
  }

  const words = reqFlat.split(/\s+/).filter((w) => w.length > 2);
  for (let len = Math.min(words.length, 14); len >= 4; len--) {
    for (let i = 0; i <= words.length - len; i++) {
      const phrase = words.slice(i, i + len).join(" ");
      const hit = tryMatch(phrase);
      if (hit) return hit;
    }
  }

  return null;
}

function anchorOverlapScore(unit: string, anchor: string): number {
  const wordsA = new Set(anchor.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wordsB = unit.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (!wordsA.size || !wordsB.length) return 0;
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;
  return overlap / Math.sqrt(wordsA.size * wordsB.length);
}

function pickByAnchorOverlap(
  clauseText: string,
  anchors: string[],
  clauseNumber?: string,
): { line: string; lineNumber: string } | null {
  const filtered = anchors.map((a) => a.trim()).filter((a) => a.length >= 12 && !isGuidelineBoilerplate(a));
  if (!filtered.length) return null;

  const body = sliceGuidelineSection(clauseText, clauseNumber);
  const units = splitIntoUnits(body);
  if (!units.length) return null;

  let best: string | null = null;
  let bestScore = -1;

  for (const unit of units) {
    if (!isTextInGuideline(unit, clauseText) && !isTextInGuideline(unit, body)) continue;
    let score = substantiveScore(unit);
    for (const anchor of filtered) {
      score += anchorOverlapScore(unit, anchor) * 10;
    }
    if (score > bestScore) {
      bestScore = score;
      best = unit;
    }
  }

  if (!best || bestScore < 2) return null;

  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const lineIdx = lines.findIndex(
    (l) => l.includes(best!.slice(0, Math.min(48, best!.length))) || best!.includes(l.slice(0, 32)),
  );

  return {
    line: best.slice(0, 600),
    lineNumber: String(Math.max(1, lineIdx >= 0 ? lineIdx + 1 : 1)),
  };
}

function pickFromClauseBody(
  clauseText: string,
  requirement?: string,
  clauseNumber?: string,
  minScore = 1,
): { line: string; lineNumber: string } | null {
  const body = sliceGuidelineSection(clauseText, clauseNumber);
  const units = splitIntoUnits(body);
  if (!units.length) return null;

  let best: string | null = null;
  let bestScore = -1;

  for (const unit of units) {
    if (!isTextInGuideline(unit, clauseText)) continue;
    const score = substantiveScore(unit, requirement);
    if (score > bestScore) {
      bestScore = score;
      best = unit;
    }
  }

  if (!best || bestScore < minScore) return null;

  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const lineIdx = lines.findIndex(
    (l) => l.includes(best!.slice(0, Math.min(48, best!.length))) || best!.includes(l.slice(0, 32)),
  );

  return {
    line: best.slice(0, 600),
    lineNumber: String(Math.max(1, lineIdx >= 0 ? lineIdx + 1 : 1)),
  };
}

/** Keep one concise requirement sentence — never expand to cover-page paragraphs. */
function toCompactPoint(
  shortLine: string,
  clauseText: string,
  requirement?: string,
  clauseNumber?: string,
): string {
  const body = clauseText ? sliceGuidelineSection(clauseText, clauseNumber) : "";
  const candidates = [
    compactRequirementText(shortLine),
    requirement ? compactRequirementText(requirement) : "",
    body ? compactRequirementText(body) : "",
  ].filter(Boolean);

  for (const c of candidates) {
    if (!clauseText || isTextInGuideline(c, clauseText)) return c;
  }
  return candidates[0] || compactRequirementText(shortLine) || shortLine.slice(0, 260);
}

function derivePdfSearchPhrase(
  fullPoint: string,
  clauseText: string,
  clauseNumber?: string,
  anchors: string[] = [],
): string {
  if (clauseText.length >= 15 && anchors.length) {
    const fromDoc = resolveDocPhraseInDocument(clauseText, [fullPoint, ...anchors], clauseNumber);
    if (fromDoc?.searchPhrase) return fromDoc.searchPhrase;
  }
  const primary = primaryRequirementClause(fullPoint);
  if (!primary) return "";
  return pdfSearchPhrase(primary);
}

function collectImpactAnchors(input: GuidelineSourceInput, requirement: string): string[] {
  const title = input.clauseTitle?.trim() || "";
  const clauseRef =
    input.clauseNumber?.trim() && title
      ? `${input.clauseNumber.trim()} ${title}`
      : title || input.clauseNumber?.trim() || "";
  return [
    requirement,
    clauseRef,
    title,
    input.impactGap,
    input.mismatchExplanation,
    input.highlightedIssue,
    input.sopTextSnippet,
    input.evidenceFound,
  ].filter((s): s is string => !!s?.trim() && s.trim().length >= 4 && !isGuidelineBoilerplate(s));
}

function pickLocatedLine(
  clauseText: string,
  clauseNumber: string,
  clauseTitle: string,
  requirement?: string,
): { line: string; lineNumber: string } | null {
  const body = sliceGuidelineSection(clauseText, clauseNumber);
  const located = locateGuidelineSource({
    rawText: body,
    clauseText: body,
    clauseNumber,
    clauseTitle,
  });
  if (located.sourceLine.length < 18 || isGuidelineBoilerplate(located.sourceLine)) return null;
  if (!isTextInGuideline(located.sourceLine, clauseText)) return null;
  return {
    line: located.sourceLine.slice(0, 600),
    lineNumber: located.lineNumber ?? "1",
  };
}

export interface GuidelineClauseDisplay {
  sectionLabel: string;
  sectionTitle: string;
  lineNumber: string | null;
  sourceLine: string;
  /** Concise requirement sentence shown in the panel. */
  fullPoint: string;
  isVerbatim: boolean;
  searchPhrase: string;
  /** Search phrase differs from the assessed requirement (optimized for PDF lookup). */
  isSmartSearch: boolean;
}

export interface GuidelineSourceInput {
  clauseNumber?: string;
  clauseTitle?: string;
  clauseText?: string;
  guidelineRequirement?: string;
  guidelineReference?: string;
  guidelineSourceLine?: string;
  guidelineLineNumber?: string;
  sopTextSnippet?: string;
  evidenceFound?: string;
  complianceLevel?: string;
  impactGap?: string;
  mismatchExplanation?: string;
  highlightedIssue?: string;
  guidelineSearchPhrase?: string;
}

function finalizeRequirementText(text: string): string {
  return primaryRequirementClause(text) || text.replace(/[,;]+$/, "").trim();
}

/** Resolve the best verbatim requirement text from clause body and analysis anchors. */
export function resolveGuidelineRequirementForFinding(
  input: GuidelineSourceInput,
): string {
  const clauseText = input.clauseText?.trim() || "";
  let rawReq = input.guidelineRequirement?.trim() || "";
  const sectionBody =
    clauseText.length >= 15 ? sliceGuidelineSection(clauseText, input.clauseNumber) : "";

  if (rawReq && clauseText.length >= 15 && !textSupportedByBody(clauseText, rawReq)) {
    rawReq = "";
  }
  // Drop stored requirements that live outside the cited section (wrong early intro hits)
  if (rawReq && sectionBody.length >= 40 && !textSupportedByBody(sectionBody, rawReq)) {
    rawReq = "";
  }

  const anchors = [
    rawReq,
    input.clauseTitle?.trim()
      ? `${input.clauseNumber?.trim() || ""} ${input.clauseTitle.trim()}`.trim()
      : "",
    input.clauseTitle,
    input.sopTextSnippet,
    input.evidenceFound,
    input.impactGap,
    input.mismatchExplanation,
    input.highlightedIssue,
  ].filter((s): s is string => !!s?.trim() && s.trim().length >= 4 && !isGuidelineBoilerplate(s));

  if (clauseText.length >= 15 && anchors.length) {
    const docPhrase = resolveDocPhraseInDocument(clauseText, anchors, input.clauseNumber);
    if (docPhrase?.fullPoint) {
      return finalizeRequirementText(docPhrase.fullPoint);
    }
  }

  if (
    rawReq.length >= 40 &&
    !isGuidelineBoilerplate(rawReq) &&
    (!clauseText || isTextInGuideline(rawReq, clauseText)) &&
    (!sectionBody || textSupportedByBody(sectionBody, rawReq))
  ) {
    return finalizeRequirementText(compactRequirementText(rawReq) || rawReq.slice(0, 260));
  }

  if (clauseText.length >= 15) {
    const verbatim = rawReq ? findVerbatimInClause(clauseText, rawReq, input.clauseNumber) : null;
    if (verbatim) {
      return finalizeRequirementText(toCompactPoint(verbatim.line, clauseText, rawReq, input.clauseNumber));
    }

    const anchorPick = pickByAnchorOverlap(clauseText, anchors, input.clauseNumber);
    if (anchorPick) {
      return finalizeRequirementText(toCompactPoint(anchorPick.line, clauseText, rawReq, input.clauseNumber));
    }

    const bodyPick = pickFromClauseBody(clauseText, rawReq || anchors[0], input.clauseNumber, 0);
    if (bodyPick) {
      return finalizeRequirementText(toCompactPoint(bodyPick.line, clauseText, rawReq, input.clauseNumber));
    }

    // Cited section was located — use its first assessable sentence, not early-doc intro text
    if (sectionBody.length >= 40) {
      const units = splitIntoUnits(sectionBody);
      const preferred =
        units.find((u) => substantiveScore(u) >= 5 && REQUIREMENT_VERB_RE.test(u)) || units[0];
      if (preferred) {
        return finalizeRequirementText(compactRequirementText(preferred) || preferred.slice(0, 260));
      }
    }
  }

  return finalizeRequirementText(compactRequirementText(rawReq) || compactRequirementText(clauseText) || rawReq.slice(0, 260));
}

/**
 * Derive guideline section + source line for display and PDF search.
 * Prefers verbatim clause text; falls back to assessed requirement when needed.
 */
export function extractGuidelineClauseDisplay(input: GuidelineSourceInput): GuidelineClauseDisplay {
  const sectionNum = input.clauseNumber?.trim() || "";
  const clauseText = input.clauseText?.trim() || "";
  const requirement = resolveGuidelineRequirementForFinding({
    ...input,
    guidelineRequirement:
      input.guidelineRequirement?.trim() &&
      clauseText.length >= 15 &&
      !textSupportedByBody(clauseText, input.guidelineRequirement)
        ? ""
        : input.guidelineRequirement,
  });
  const impactAnchors = collectImpactAnchors(input, requirement);
  const resolvedTitle = resolveSectionTitle(sectionNum, input.clauseTitle?.trim() || "", clauseText);
  const sectionLabel = [sectionNum ? `§${sectionNum}` : "", resolvedTitle].filter(Boolean).join(" — ");

  const finish = (
    sourceLine: string,
    lineNumber: string | null,
    isVerbatim: boolean,
    searchOverride?: string,
  ): GuidelineClauseDisplay => {
    const compact = toCompactPoint(sourceLine, clauseText, requirement, sectionNum);
    const fullPoint = primaryRequirementClause(compact || sourceLine.trim());
    const searchPhrase =
      searchOverride ||
      derivePdfSearchPhrase(fullPoint, clauseText, sectionNum, impactAnchors);
    return {
      sectionLabel,
      sectionTitle: resolvedTitle,
      lineNumber,
      sourceLine: fullPoint || compact || sourceLine.trim().slice(0, 260),
      fullPoint: fullPoint || compact || sourceLine.trim().slice(0, 260),
      isVerbatim,
      searchPhrase,
      isSmartSearch: isSmartSearchTerm(fullPoint || compact || sourceLine, searchPhrase),
    };
  };

  // Primary: locate impact-related sentence in document text, derive search phrase verbatim from PDF/OCR body
  if (clauseText.length >= 15 && impactAnchors.length) {
    const docPhrase = resolveDocPhraseInDocument(clauseText, impactAnchors, sectionNum);
    if (docPhrase?.searchPhrase && docPhrase.fullPoint) {
      const body = sliceGuidelineSection(clauseText, sectionNum);
      const idx = normalizeGuidelineText(body)
        .toLowerCase()
        .indexOf(normalizeGuidelineText(docPhrase.matchedUnit).slice(0, 40).toLowerCase());
      const lineNumber =
        idx >= 0
          ? String(Math.max(1, body.slice(0, idx).split("\n").length))
          : null;
      return finish(docPhrase.fullPoint, lineNumber, true, docPhrase.searchPhrase);
    }
  }

  if (input.guidelineSearchPhrase?.trim() && clauseText.length >= 15) {
    const phrase = input.guidelineSearchPhrase.trim();
    if (phraseInClause(clauseText, phrase)) {
      const docPhrase = resolveDocPhraseInDocument(clauseText, [phrase, ...impactAnchors], sectionNum);
      if (docPhrase) {
        return finish(docPhrase.fullPoint, input.guidelineLineNumber?.trim() || null, true, docPhrase.searchPhrase);
      }
    }
  }

  if (input.guidelineSourceLine?.trim() && !isGuidelineBoilerplate(input.guidelineSourceLine)) {
    const line = input.guidelineSourceLine.trim();
    const compact = compactRequirementText(line);
    if (compact && (!clauseText || isTextInGuideline(compact, clauseText))) {
      return finish(compact, input.guidelineLineNumber?.trim() || null, true);
    }
  }

  if (clauseText.length >= 15) {
    const anchors = impactAnchors;
    const verbatimReq = findVerbatimInClause(clauseText, requirement, sectionNum);
    if (verbatimReq) return finish(verbatimReq.line, verbatimReq.lineNumber, true);

    const anchorPick = pickByAnchorOverlap(clauseText, anchors, sectionNum);
    if (anchorPick) return finish(anchorPick.line, anchorPick.lineNumber, true);

    const located = pickLocatedLine(clauseText, sectionNum, resolvedTitle, requirement);
    if (located) return finish(located.line, located.lineNumber, true);

    const picked = pickFromClauseBody(clauseText, requirement, sectionNum, 0);
    if (picked) return finish(picked.line, picked.lineNumber, true);
  }

  if (requirement.length >= 12 && !isGuidelineBoilerplate(requirement)) {
    const verbatim = clauseText ? isTextInGuideline(requirement, clauseText) : false;
    return finish(requirement, "1", verbatim);
  }

  const ref = input.guidelineReference?.trim() || "";
  if (ref && !isHeadingOnlyTitle(ref) && (!clauseText || isTextInGuideline(ref, clauseText))) {
    return finish(ref, null, !!clauseText);
  }

  if (resolvedTitle && !looksLikeFilename(resolvedTitle) && !isHeadingOnlyTitle(resolvedTitle)) {
    return finish(resolvedTitle, null, false);
  }

  return finish("", null, false);
}

function phraseInClause(clauseText: string, phrase: string): boolean {
  return normalizeGuidelineText(clauseText)
    .toLowerCase()
    .includes(normalizeGuidelineText(phrase).toLowerCase());
}

/** Attach persisted source line fields when saving or enriching findings. */
export function attachGuidelineSourceFields<T extends GuidelineSourceInput>(finding: T): T {
  const effectiveRequirement = resolveGuidelineRequirementForFinding(finding);
  const enriched: T = {
    ...finding,
    guidelineRequirement: effectiveRequirement || finding.guidelineRequirement,
    impactGap:
      finding.impactGap ||
      finding.mismatchExplanation ||
      finding.highlightedIssue,
  };
  const display = extractGuidelineClauseDisplay(enriched);
  return {
    ...enriched,
    guidelineSourceLine: display.sourceLine || finding.guidelineSourceLine,
    guidelineLineNumber: display.lineNumber ?? finding.guidelineLineNumber,
    guidelineRequirement: display.fullPoint || effectiveRequirement || finding.guidelineRequirement,
    guidelineSearchPhrase: display.searchPhrase || finding.guidelineSearchPhrase,
  };
}

export { isGuidelineBoilerplate };
