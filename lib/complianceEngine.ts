import { generateJson } from "@/lib/gemini";
import { buildComplianceSystemPrompt, buildComplianceUserPrompt } from "@/lib/compliancePrompts";

/**
 * Regulatory finding category — every observation must be classified into exactly one.
 * Improvement Opportunity and Best Practice Recommendation NEVER reduce the compliance
 * score; they are advisory only.
 */
export type FindingCategory =
  | "Critical Non-Compliance"
  | "Major Gap"
  | "Minor Gap"
  | "Improvement Opportunity"
  | "Best Practice Recommendation";

/** Risk severity used for risk-based prioritization (Critical findings sort to the top). */
export type RiskLevel = "Critical" | "Major" | "Minor" | "Improvement";

/** Strength of the SOP evidence backing a finding — drives manual-review flagging. */
export type EvidenceStrength = "strong" | "moderate" | "weak" | "none";

/** Distinguishes guideline-clause findings from GMP-intelligence and cross-SOP findings. */
export type FindingType = "guideline-clause" | "gmp-expectation" | "cross-sop-dependency";

export interface ComplianceFinding {
  clauseNumber: string;
  clauseTitle: string;
  complianceLevel: "compliant" | "partial" | "non-compliant" | "not-applicable" | "analysis-failed";
  matchConfidence: number;
  issueSeverity: "critical" | "major" | "minor" | "informational";
  sopSectionAffected: string;
  mismatchExplanation: string;
  sopTextSnippet: string;
  guidelineRequirement: string;
  clauseText?: string;
  guidelineSourceLine?: string;
  guidelineLineNumber?: string;
  suggestedAction: string;
  suggestedText: string;
  impactAnalysis?: string;
  highlightedIssue?: string;
  estimatedEffort: "low" | "medium" | "high";
  guidelineName?: string;
  folderName?: string;
  guidelineId?: string;

  // ── Structured regulatory audit fields (V5) ──────────────────────────────
  /** One of the five mandatory regulatory classifications. */
  findingCategory?: FindingCategory;
  /** Risk band used for prioritization/sorting. */
  riskLevel?: RiskLevel;
  /** Reference label for the guideline (e.g. "Annex 15 Section 9.3"). */
  guidelineReference?: string;
  /** Evidence the SOP DOES contain that addresses the requirement. */
  evidenceFound?: string;
  /** Specific evidence the SOP is MISSING for full compliance. */
  evidenceMissing?: string;
  /** Qualitative strength of the cited SOP evidence. */
  evidenceStrength?: EvidenceStrength;
  /** Page number where evidence was located (best-effort). */
  pageNumber?: string;
  /** Paragraph number where evidence was located (best-effort). */
  paragraphNumber?: string;
  /** True when confidence/evidence is too weak to trust without QA review. */
  requiresManualReview?: boolean;
  /** What kind of finding this is (clause vs GMP expectation vs cross-SOP). */
  findingType?: FindingType;
  /** Stable key used to merge duplicate findings sharing one root cause. */
  rootCauseKey?: string;
  /** Other clause references merged into this finding during de-duplication. */
  mergedClauseRefs?: string[];

  // ── Regulatory auditor mode (requirement-first, defensible findings) ──────
  /** Whether the requirement applies to this SOP's scope. */
  applicability?: "applicable" | "partially-applicable" | "not-applicable";
  /** Inherent importance of the requirement, independent of compliance outcome. */
  requirementCriticality?: "critical" | "major" | "minor";
  /** Which document/system actually owns this topic. */
  scopeOwner?: "current-sop" | "referenced-sop" | "department-procedure" | "quality-system" | "unknown";
  /** Auditor reasoning: why the requirement applies to this SOP. */
  whyApplies?: string;
  /** Auditor reasoning: why the cited SOP evidence is insufficient. */
  whyEvidenceInsufficient?: string;
  /** Auditor reasoning: why (and how much) the score was reduced. */
  whyScoreReduced?: string;
}

/** One row of the clause-by-clause traceability matrix. */
export interface TraceabilityMatrixEntry {
  clauseNumber: string;
  clauseTitle: string;
  clauseText: string;
  guidelineName: string;
  folderName: string;
  applicable: boolean;
  complianceStatus: "Compliant" | "Partial" | "Non-Compliant" | "Not Applicable" | "Not Analyzed";
  supportingSopSection: string;
  confidenceScore: number;
}

/**
 * Audit completeness report — proves the entire guideline library was evaluated.
 * Shown at the top of every compliance report so reviewers can verify 100%
 * clause coverage rather than a partial AI summary.
 */
export interface AuditCompleteness {
  totalGuidelinesReviewed: number;
  totalChaptersReviewed: number;
  totalClausesReviewed: number;
  applicableClauses: number;
  notApplicableClauses: number;
  compliantCount: number;
  partialCount: number;
  nonCompliantCount: number;
  criticalFindings: number;
  majorFindings: number;
  minorFindings: number;
  improvementOpportunities: number;
  /** % of guideline clauses that were actually analyzed (not "Not Analyzed"). */
  clauseCoveragePct: number;
  /** % of SOP sections that were cited as evidence by at least one finding. */
  sopCoveragePct: number;
  overallScore: number;
}

/** Cross-SOP dependency validation result for a referenced SOP type. */
export interface CrossSopDependency {
  referencedType: string;
  referenceText: string;
  found: boolean;
  status: "available" | "missing" | "obsolete" | "expired" | "unknown";
  matchedSopIdentifier?: string;
  matchedSopName?: string;
  riskLevel: RiskLevel;
  note: string;
}

/** Transparent score calculation breakdown shown to reviewers. */
export interface ComplianceScoreBreakdown {
  totalApplicableRequirements: number;
  compliantCount: number;
  partialCount: number;
  nonCompliantCount: number;
  improvementCount: number;
  notApplicableCount: number;
  formula: string;
  score: number;

  // ── Weighted scoring (Critical=5, Major=3, Minor=1, Improvement=0) ──
  scoringMethod?: "weighted" | "simple";
  weightedAchieved?: number;
  weightedTotal?: number;
  criticalRequirementCount?: number;
  majorRequirementCount?: number;
  minorRequirementCount?: number;
}

export interface ComplianceAnalysisResult {
  findings: ComplianceFinding[];
  overallScore: number;
  complianceStatus: "Fully Compliant" | "Partially Compliant" | "Non-Compliant" | "Analysis Incomplete";
  compliantCount: number;
  partialCount: number;
  nonCompliantCount: number;
  totalGuidelinesChecked: number;
  processingTimeMs: number;
  summary?: string;

  // ── Structured regulatory audit output (V5) ──────────────────────────────
  criticalCount?: number;
  majorCount?: number;
  minorCount?: number;
  improvementCount?: number;
  bestPracticeCount?: number;
  notApplicableCount?: number;
  clauseCoveragePct?: number;
  scoreBreakdown?: ComplianceScoreBreakdown;
  traceabilityMatrix?: TraceabilityMatrixEntry[];
  crossSopDependencies?: CrossSopDependency[];
  auditCompleteness?: AuditCompleteness;
  analysisEngineVersion?: string;
}

export function getScoreLabel(score: number): "Fully Compliant" | "Partially Compliant" | "Non-Compliant" {
  if (score >= 8) return "Fully Compliant";
  if (score >= 5) return "Partially Compliant";
  return "Non-Compliant";
}

export async function analyzeSOPCompliance(request: {
  sopIdentifier: string;
  sopName: string;
  department: string;
  sopContent: string;
  guidelineClauses: {
    clauseNumber: string;
    clauseTitle: string;
    clauseText: string;
    guidelineName: string;
    folderName: string;
    guidelineId?: string;
  }[];
}): Promise<ComplianceAnalysisResult> {
  const startTime = Date.now();

  const systemPrompt = buildComplianceSystemPrompt();
  const userPrompt = buildComplianceUserPrompt(
    request.sopIdentifier,
    request.sopName,
    request.department,
    request.sopContent,
    request.guidelineClauses,
  );

  const parsed = await generateJson<{
    findings: ComplianceFinding[];
    overallScore: number;
    complianceStatus: "Fully Compliant" | "Partially Compliant" | "Non-Compliant";
    summary?: string;
  }>(systemPrompt, userPrompt);

  const findings: ComplianceFinding[] = (parsed.findings ?? []).map((f, i) => ({
    ...f,
    guidelineName: request.guidelineClauses[i]?.guidelineName ?? "",
    folderName: request.guidelineClauses[i]?.folderName ?? "",
    guidelineId: request.guidelineClauses[i]?.guidelineId,
  }));

  const compliantCount = findings.filter((f) => f.complianceLevel === "compliant").length;
  const partialCount = findings.filter((f) => f.complianceLevel === "partial").length;
  const nonCompliantCount = findings.filter((f) => f.complianceLevel === "non-compliant").length;

  const score = Math.min(10, Math.max(0, parsed.overallScore ?? 0));

  return {
    findings,
    overallScore: score,
    complianceStatus: getScoreLabel(score),
    compliantCount,
    partialCount,
    nonCompliantCount,
    totalGuidelinesChecked: findings.length,
    processingTimeMs: Date.now() - startTime,
    summary: parsed.summary,
  };
}
