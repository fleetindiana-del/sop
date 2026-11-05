import type { ComplianceFinding } from "@/lib/complianceEngine";
import {
  extractLineRefs,
  getLinesText,
  type ParsedSop,
  type SopSectionType,
} from "@/lib/sopStructureParser";
import { applySemanticValidation } from "@/lib/semanticRelevance";

export interface ClauseForValidation {
  clauseNumber: string;
  clauseTitle: string;
  clauseText: string;
  guidelineName: string;
  folderName: string;
  guidelineId?: string;
}

const VALID_COMPLIANCE_LEVELS = new Set(["compliant", "partial", "non-compliant", "not-applicable", "analysis-failed"]);
const VALID_SEVERITIES = new Set(["critical", "major", "minor", "informational"]);
const VALID_EFFORTS = new Set(["low", "medium", "high"]);

const PLACEHOLDER_RE = /\b(n\/a|na|none|not\s+determined|unable\s+to\s+determine|not\s+specified|not\s+found|not\s+addressed|manual\s+review\s+required|review\s+required)\b/i;

const EXACT_PLACEHOLDERS = new Set(["n/a", "na", "n.a.", "none", "-", "—", "nil", "null"]);

const BINARY_DOCUMENT_RE = /%PDF-|\/Subtype\s*\/Image|\/DCTDecode|\/FlateDecode|stream\s+JFIF/i;

/** True when stored "SOP text" is a PDF or image stream rather than procedure language. */
export function isUnreadableDocumentText(text?: string | null): boolean {
  if (!text?.trim()) return false;
  const sample = text.slice(0, 4000);
  if (BINARY_DOCUMENT_RE.test(sample)) return true;
  const probe = sample.slice(0, 600);
  let weird = 0;
  for (let i = 0; i < probe.length; i++) {
    const code = probe.charCodeAt(i);
    if (code === 0xfffd || code < 9 || (code > 14 && code < 32)) weird++;
  }
  return probe.length > 40 && weird / probe.length > 0.05;
}

export function isBadFindingNarrative(text?: string | null): boolean {
  if (!text?.trim()) return false;
  if (isUnreadableDocumentText(text)) return true;
  return /scanned (?:page )?image|no readable procedure|unreadable scanned|truncated image|pdf image stream/i.test(
    text,
  );
}

export function isPlaceholderText(text?: string | null): boolean {
  if (!text?.trim()) return true;
  const normalized = text.trim().toLowerCase();
  if (EXACT_PLACEHOLDERS.has(normalized)) return true;
  return PLACEHOLDER_RE.test(normalized);
}

export function cleanFindingText(text?: string | null): string {
  if (isPlaceholderText(text) || isUnreadableDocumentText(text)) return "";
  return text!.trim();
}

export function buildProposedVerbiage(input: {
  suggestedAction: string;
  sopTextSnippet?: string;
  sopSectionAffected?: string;
  gap?: string;
  clauseTitle: string;
  clauseNumber: string;
  guidelineName: string;
}): string {
  const section = cleanFindingText(input.sopSectionAffected);
  const sectionNum = section.match(/(\d+(?:\.\d+)*)/)?.[1] ?? "";
  const prefix = sectionNum ? `${sectionNum} ` : section ? `${section} ` : "";
  const snippet = cleanFindingText(input.sopTextSnippet);
  const action = input.suggestedAction.trim();

  if (snippet && action) {
    const addition = action.endsWith(".") ? action : `${action}.`;
    return `${prefix}${snippet} ${addition}`;
  }

  if (snippet) {
    return `${prefix}${snippet} Additionally, the SOP shall explicitly address ${input.clauseTitle} in compliance with ${input.guidelineName} Clause ${input.clauseNumber}.`;
  }

  if (action) {
    return `${prefix}${action}`;
  }

  return `${prefix}Add explicit language to address ${input.clauseTitle} as required by ${input.guidelineName} Clause ${input.clauseNumber}.`;
}

export function validateFinding(f: Partial<ComplianceFinding>): f is ComplianceFinding {
  if (!f.clauseNumber || !f.clauseTitle) return false;
  if (!VALID_COMPLIANCE_LEVELS.has(f.complianceLevel ?? "")) return false;
  if (!VALID_SEVERITIES.has(f.issueSeverity ?? "")) return false;
  return true;
}

export function sanitizeFinding(f: Partial<ComplianceFinding>): ComplianceFinding {
  return {
    clauseNumber: f.clauseNumber ?? "unknown",
    clauseTitle: f.clauseTitle ?? "Unknown Clause",
    complianceLevel: VALID_COMPLIANCE_LEVELS.has(f.complianceLevel ?? "")
      ? (f.complianceLevel as ComplianceFinding["complianceLevel"])
      : "analysis-failed",
    matchConfidence: Math.min(100, Math.max(0, f.matchConfidence ?? 0)),
    issueSeverity: VALID_SEVERITIES.has(f.issueSeverity ?? "")
      ? (f.issueSeverity as ComplianceFinding["issueSeverity"])
      : "informational",
    sopSectionAffected: filterPlaceholder(f.sopSectionAffected ?? ""),
    mismatchExplanation: filterPlaceholder(f.mismatchExplanation ?? ""),
    sopTextSnippet: filterPlaceholder(f.sopTextSnippet ?? ""),
    guidelineRequirement: filterPlaceholder(f.guidelineRequirement ?? ""),
    suggestedAction: filterPlaceholder(f.suggestedAction ?? ""),
    suggestedText: filterPlaceholder(f.suggestedText ?? ""),
    estimatedEffort: VALID_EFFORTS.has(f.estimatedEffort ?? "")
      ? (f.estimatedEffort as ComplianceFinding["estimatedEffort"])
      : "medium",
  };
}

function filterPlaceholder(text: string): string {
  if (PLACEHOLDER_RE.test(text)) return "";
  return text;
}

export function sanitizeFindings(findings: Partial<ComplianceFinding>[]): ComplianceFinding[] {
  return findings.map(sanitizeFinding);
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s.%-]/g, "").trim();
}

/** Check whether quoted SOP text actually exists in the document (fuzzy). */
export function textExistsInSop(snippet: string, sopContent: string): boolean {
  const trimmed = snippet?.trim();
  if (!trimmed || trimmed.length < 8) return false;

  const normSnippet = normalizeForMatch(trimmed);
  const normSop = normalizeForMatch(sopContent);
  if (normSop.includes(normSnippet)) return true;

  const words = normSnippet.split(" ").filter((w) => w.length > 3);
  if (words.length < 3) return false;
  const matched = words.filter((w) => normSop.includes(w)).length;
  return matched / words.length >= 0.7;
}

function clauseKey(c: { guidelineName?: string; clauseNumber?: string }): string {
  return `${c.guidelineName ?? ""}::${c.clauseNumber ?? ""}`;
}

function formatLineRef(n: number): string {
  return `L${String(n).padStart(3, "0")}`;
}

/** Scope/purpose excerpt used when AI omits SOP evidence (common for not-applicable findings). */
export function getRepresentativeSopExcerpt(
  parsedSop: ParsedSop,
  sopIdentifier?: string,
  sopName?: string,
): { sopTextSnippet: string; sopSectionAffected: string } {
  const sectionKinds: Array<SopSectionType | "first"> = ["scope", "purpose", "general", "first"];

  for (const kind of sectionKinds) {
    const section =
      kind === "first" ? parsedSop.sections[0] : parsedSop.sections.find((s) => s.type === kind);
    if (!section) continue;

    const lineNumbers = Array.from(
      { length: section.lineEnd - section.lineStart + 1 },
      (_, i) => section.lineStart + i,
    );
    const lineText = getLinesText(parsedSop, lineNumbers).trim();
    if (lineText.length < 15) continue;

    const sectionRef = section.id
      ? `${formatLineRef(section.lineStart)} [§${section.id} ${section.title}]`
      : formatLineRef(section.lineStart);

    return {
      sopTextSnippet: lineText.slice(0, 500),
      sopSectionAffected: sectionRef,
    };
  }

  const openingLines = parsedSop.lines
    .slice(0, 5)
    .map((l) => l.text)
    .join(" ")
    .trim();
  if (openingLines.length >= 10) {
    const firstSection = parsedSop.sections[0];
    return {
      sopTextSnippet: openingLines.slice(0, 500),
      sopSectionAffected: firstSection?.id
        ? `§${firstSection.id}`
        : firstSection
          ? formatLineRef(firstSection.lineStart)
          : "1",
    };
  }

  if (sopIdentifier && sopName) {
    return {
      sopTextSnippet: `${sopIdentifier}_${sopName}`,
      sopSectionAffected: parsedSop.sections[0]?.id || "1",
    };
  }

  return { sopTextSnippet: "", sopSectionAffected: "" };
}

/** Fill missing SOP citation fields from parsed document content. */
export function enrichFindingSopContent(
  finding: ComplianceFinding,
  parsedSop: ParsedSop,
  sopIdentifier?: string,
  sopName?: string,
): ComplianceFinding {
  const needsSnippet = !cleanFindingText(finding.sopTextSnippet);
  const needsSection =
    !finding.sopSectionAffected?.trim() || isPlaceholderText(finding.sopSectionAffected);

  if (!needsSnippet && !needsSection) return finding;

  const excerpt = getRepresentativeSopExcerpt(parsedSop, sopIdentifier, sopName);
  return {
    ...finding,
    sopTextSnippet: needsSnippet && excerpt.sopTextSnippet ? excerpt.sopTextSnippet : finding.sopTextSnippet,
    sopSectionAffected:
      needsSection && excerpt.sopSectionAffected ? excerpt.sopSectionAffected : finding.sopSectionAffected,
  };
}

/**
 * Validate and enrich a finding against actual SOP and guideline content.
 * Adjusts confidence, fills evidence from line refs, and flags unsupported claims.
 */
export function validateFindingEvidence(
  finding: ComplianceFinding,
  clause: ClauseForValidation,
  sopContent: string,
  parsedSop: ParsedSop,
  sopMeta?: { identifier: string; name: string },
): ComplianceFinding {
  const result = { ...finding };

  const requirementFromClause =
    clause.clauseText?.trim() || clause.clauseTitle?.trim() || "";
  if (
    !result.guidelineRequirement?.trim() ||
    isPlaceholderText(result.guidelineRequirement)
  ) {
    result.guidelineRequirement = requirementFromClause.slice(0, 800);
  }

  const lineRefs = [
    ...extractLineRefs(result.sopSectionAffected ?? ""),
    ...extractLineRefs(result.sopTextSnippet ?? ""),
  ];

  if (lineRefs.length > 0) {
    const lineText = getLinesText(parsedSop, lineRefs);
    if (lineText && !result.sopTextSnippet?.trim()) {
      result.sopTextSnippet = lineText.slice(0, 500);
    } else if (
      lineText &&
      result.sopTextSnippet &&
      !textExistsInSop(result.sopTextSnippet, sopContent)
    ) {
      result.sopTextSnippet = lineText.slice(0, 500);
    }
  }

  const hasSnippetEvidence = textExistsInSop(result.sopTextSnippet ?? "", sopContent);
  const isActionable =
    result.complianceLevel === "partial" || result.complianceLevel === "non-compliant";

  if (result.complianceLevel === "compliant") {
    if (!hasSnippetEvidence) {
      result.matchConfidence = Math.min(result.matchConfidence, 55);
      if (!result.mismatchExplanation?.trim()) {
        result.mismatchExplanation =
          "Marked compliant but no verifiable SOP text excerpt was cited — confidence reduced pending review.";
      }
    } else {
      result.matchConfidence = Math.max(result.matchConfidence, 70);
    }
  }

  if (isActionable) {
    if (!hasSnippetEvidence && result.sopTextSnippet) {
      result.matchConfidence = Math.min(result.matchConfidence, 50);
      result.mismatchExplanation = [
        result.mismatchExplanation,
        "Cited SOP excerpt could not be verified in the document text.",
      ]
        .filter(Boolean)
        .join(" ");
    } else if (!hasSnippetEvidence) {
      result.sopTextSnippet = "Not Found";
      result.matchConfidence = Math.min(result.matchConfidence, 65);
    }
  }

  if (result.complianceLevel === "not-applicable" && !result.mismatchExplanation?.trim()) {
    result.mismatchExplanation = `Clause ${clause.clauseNumber} (${clause.clauseTitle}) is outside the scope of this SOP.`;
  }

  const semantic = applySemanticValidation(
    result.complianceLevel,
    result.matchConfidence,
    result.guidelineRequirement,
    result.clauseTitle,
    result.sopTextSnippet ?? "",
    result.mismatchExplanation ?? "",
  );

  result.complianceLevel = semantic.complianceLevel;
  result.matchConfidence = semantic.matchConfidence;
  result.sopTextSnippet = semantic.sopTextSnippet;
  result.mismatchExplanation = semantic.mismatchExplanation;

  if (
    semantic.complianceLevel === "non-compliant" &&
    finding.complianceLevel !== "non-compliant" &&
    !result.impactAnalysis?.trim()
  ) {
    result.impactAnalysis = `Finding downgraded after validation: cited SOP lines do not substantively address ${clause.clauseTitle}.`;
  }

  result.matchConfidence = Math.min(100, Math.max(0, Math.round(result.matchConfidence)));

  if (!cleanFindingText(result.sopTextSnippet) || !result.sopSectionAffected?.trim()) {
    const enriched = enrichFindingSopContent(result, parsedSop, sopMeta?.identifier, sopMeta?.name);
    result.sopTextSnippet = enriched.sopTextSnippet;
    result.sopSectionAffected = enriched.sopSectionAffected;
  }

  return result;
}

/** Ensure every input clause has exactly one finding; fill gaps for missed clauses. */
export function auditClauseCoverage(
  findings: ComplianceFinding[],
  clauses: ClauseForValidation[],
): ComplianceFinding[] {
  const byKey = new Map<string, ComplianceFinding>();

  for (const f of findings) {
    const key = clauseKey(f);
    if (!byKey.has(key)) byKey.set(key, f);
  }

  const audited: ComplianceFinding[] = [];

  for (const clause of clauses) {
    const key = clauseKey(clause);
    const existing = byKey.get(key);

    if (existing) {
      audited.push(existing);
      continue;
    }

    audited.push({
      clauseNumber: clause.clauseNumber,
      clauseTitle: clause.clauseTitle,
      complianceLevel: "analysis-failed",
      matchConfidence: 0,
      issueSeverity: "informational",
      sopSectionAffected: "",
      mismatchExplanation:
        "This guideline clause was not analyzed — coverage gap detected during validation. Re-run analysis.",
      sopTextSnippet: "",
      guidelineRequirement: clause.clauseText?.slice(0, 600) || clause.clauseTitle,
      suggestedAction: "",
      suggestedText: "",
      estimatedEffort: "medium",
      guidelineName: clause.guidelineName,
      folderName: clause.folderName,
      guidelineId: clause.guidelineId,
    });
  }

  return audited;
}

/** Validate all findings and recompute scores from evidence-backed results only. */
export function validateAllFindings(
  findings: ComplianceFinding[],
  clauses: ClauseForValidation[],
  sopContent: string,
  parsedSop: ParsedSop,
  sopMeta?: { identifier: string; name: string },
): ComplianceFinding[] {
  const clauseMap = new Map(clauses.map((c) => [clauseKey(c), c]));
  const covered = auditClauseCoverage(findings, clauses);

  return covered.map((f) => {
    const clause = clauseMap.get(clauseKey(f));
    if (!clause || f.complianceLevel === "analysis-failed") {
      return enrichFindingSopContent(f, parsedSop, sopMeta?.identifier, sopMeta?.name);
    }
    return validateFindingEvidence(f, clause, sopContent, parsedSop, sopMeta);
  });
}
