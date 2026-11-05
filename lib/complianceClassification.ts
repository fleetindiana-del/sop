/**
 * Compliance Classification & Scoring
 * -----------------------------------
 * Turns raw evidence-based findings into a structured regulatory assessment:
 *  - classifies every observation into one of five regulatory categories
 *  - assigns a risk level for prioritization
 *  - computes a transparent compliance score (recommendations never lower the score)
 *  - de-duplicates findings that share a single root cause
 *  - rates evidence strength and flags low-confidence findings for manual review
 */

import type {
  ComplianceFinding,
  ComplianceScoreBreakdown,
  EvidenceStrength,
  FindingCategory,
  RiskLevel,
} from "@/lib/complianceEngine";

/** Confidence below this threshold means a reviewer must verify the finding. */
export const MANUAL_REVIEW_CONFIDENCE_THRESHOLD = 55;

/** Requirement weights for weighted scoring. */
export const REQUIREMENT_WEIGHTS = { critical: 5, major: 3, minor: 1 } as const;

/**
 * Speculative / assumption-based language an auditor must NOT use as the sole basis
 * for a finding. A defensible finding cites concrete missing evidence, not a guess.
 */
const SPECULATIVE_RE =
  /\b(may\s+be|maybe|might|could\s+be|appears?|seems?|seem\s+to|possibly|perhaps|presumably|likely|unclear|not\s+clearly|it\s+is\s+possible|potential(?:ly)?|suggests?\s+that|assum)/i;

export function isSpeculative(text?: string): boolean {
  if (!text?.trim()) return false;
  return SPECULATIVE_RE.test(text);
}

function isMeaningfulEvidence(text?: string): boolean {
  if (!text?.trim()) return false;
  return !/^(none|n\/a|na|not\s+found|not\s+applicable|-|—)$/i.test(text.trim());
}

/**
 * Categorize a finding. Compliant / Not-Applicable clauses are advisory at most
 * (Best Practice / Improvement) and NEVER reduce the score. Only partial or
 * non-compliant findings against a genuine requirement count as gaps.
 */
export function classifyFinding(finding: ComplianceFinding): {
  findingCategory?: FindingCategory;
  riskLevel: RiskLevel;
} {
  const level = finding.complianceLevel;
  const severity = finding.issueSeverity;

  if (level === "not-applicable" || level === "analysis-failed") {
    return {
      findingCategory: "Best Practice Recommendation",
      riskLevel: "Improvement",
    };
  }

  // Compliant clause — scored via complianceLevel. Only tag Best Practice when there is an enhancement note.
  if (level === "compliant") {
    const hasSuggestion = Boolean(finding.suggestedAction?.trim() || finding.suggestedText?.trim());
    if (hasSuggestion) {
      return { findingCategory: "Best Practice Recommendation", riskLevel: "Improvement" };
    }
    return { riskLevel: "Minor" };
  }

  if (level === "non-compliant") {
    if (severity === "critical") return { findingCategory: "Critical Non-Compliance", riskLevel: "Critical" };
    if (severity === "major") return { findingCategory: "Major Gap", riskLevel: "Major" };
    return { findingCategory: "Minor Gap", riskLevel: "Minor" };
  }

  // partial
  if (severity === "critical") return { findingCategory: "Major Gap", riskLevel: "Major" };
  if (severity === "major") return { findingCategory: "Major Gap", riskLevel: "Major" };
  return { findingCategory: "Minor Gap", riskLevel: "Minor" };
}

/** True for findings that represent a genuine, score-affecting compliance requirement. */
export function isScoringFinding(finding: ComplianceFinding): boolean {
  // GMP Intelligence and cross-SOP checks are advisory — they never drive the 0–10 score.
  if (finding.findingType === "gmp-expectation" || finding.findingType === "cross-sop-dependency") {
    return false;
  }
  if (finding.complianceLevel === "not-applicable" || finding.complianceLevel === "analysis-failed") {
    return false;
  }
  // Auditor-demoted speculative gaps are advisory only.
  if (finding.findingCategory === "Improvement Opportunity") {
    return false;
  }
  // Best Practice on a compliant clause is an enhancement note — still counts positively.
  if (finding.findingCategory === "Best Practice Recommendation") {
    return finding.complianceLevel === "compliant";
  }
  return (
    finding.complianceLevel === "compliant" ||
    finding.complianceLevel === "partial" ||
    finding.complianceLevel === "non-compliant"
  );
}

function countImprovementFindings(findings: ComplianceFinding[]): number {
  return findings.filter(
    (f) =>
      f.complianceLevel !== "compliant" &&
      (f.findingCategory === "Improvement Opportunity" ||
        f.findingCategory === "Best Practice Recommendation"),
  ).length;
}

/**
 * Transparent compliance score.
 *
 *   Score = (Compliant + (Partial × 0.5)) ÷ Total Applicable Requirements × 10
 *
 * Only genuine requirements (compliant / partial / non-compliant) are counted.
 * Improvement & Best Practice recommendations are excluded so a recommendation
 * can never reduce the score.
 */
export function computeScoreBreakdown(findings: ComplianceFinding[]): ComplianceScoreBreakdown {
  const scoring = findings.filter(isScoringFinding);

  const compliantCount = scoring.filter((f) => f.complianceLevel === "compliant").length;
  const partialCount = scoring.filter((f) => f.complianceLevel === "partial").length;
  const nonCompliantCount = scoring.filter((f) => f.complianceLevel === "non-compliant").length;

  const improvementCount = countImprovementFindings(findings);
  const notApplicableCount = findings.filter((f) => f.complianceLevel === "not-applicable").length;

  const totalApplicableRequirements = scoring.length;
  const rawScore =
    totalApplicableRequirements > 0
      ? ((compliantCount + partialCount * 0.5) / totalApplicableRequirements) * 10
      : 0;
  const score = Math.round(rawScore * 10) / 10;

  const formula =
    `Score = (Compliant + (Partial × 0.5)) ÷ Total Applicable Requirements × 10` +
    `\n= (${compliantCount} + (${partialCount} × 0.5)) ÷ ${totalApplicableRequirements} × 10` +
    `\n= ${score.toFixed(1)} / 10`;

  return {
    totalApplicableRequirements,
    compliantCount,
    partialCount,
    nonCompliantCount,
    improvementCount,
    notApplicableCount,
    formula,
    score,
  };
}

/** Derive the inherent importance (criticality) of the requirement for weighting. */
export function getRequirementCriticality(finding: ComplianceFinding): "critical" | "major" | "minor" {
  if (finding.requirementCriticality) return finding.requirementCriticality;
  // For gaps, the gap severity is a good proxy for requirement importance.
  if (finding.complianceLevel === "non-compliant" || finding.complianceLevel === "partial") {
    if (finding.issueSeverity === "critical") return "critical";
    if (finding.issueSeverity === "major") return "major";
    return "minor";
  }
  // Compliant requirements default to a moderate weight so a compliant SOP scores well.
  return "major";
}

/**
 * Weighted compliance score.
 *
 * Each applicable requirement carries a weight by criticality
 * (Critical=5, Major=3, Minor=1). A compliant requirement earns its full weight,
 * a partial earns half, a non-compliant earns zero. Improvement / Best Practice
 * recommendations carry weight 0 and never affect the score.
 *
 *   Score = (Σ achieved weight) ÷ (Σ total weight) × 10
 *
 * This prevents a single minor gap from collapsing the score of an otherwise
 * compliant SOP.
 */
export function computeWeightedScoreBreakdown(findings: ComplianceFinding[]): ComplianceScoreBreakdown {
  const scoring = findings.filter(isScoringFinding);

  const compliantCount = scoring.filter((f) => f.complianceLevel === "compliant").length;
  const partialCount = scoring.filter((f) => f.complianceLevel === "partial").length;
  const nonCompliantCount = scoring.filter((f) => f.complianceLevel === "non-compliant").length;

  const improvementCount = countImprovementFindings(findings);
  const notApplicableCount = findings.filter((f) => f.complianceLevel === "not-applicable").length;

  let weightedTotal = 0;
  let weightedAchieved = 0;
  let criticalRequirementCount = 0;
  let majorRequirementCount = 0;
  let minorRequirementCount = 0;

  for (const f of scoring) {
    const crit = getRequirementCriticality(f);
    const weight = REQUIREMENT_WEIGHTS[crit];
    weightedTotal += weight;
    if (crit === "critical") criticalRequirementCount++;
    else if (crit === "major") majorRequirementCount++;
    else minorRequirementCount++;

    if (f.complianceLevel === "compliant") weightedAchieved += weight;
    else if (f.complianceLevel === "partial") weightedAchieved += weight * 0.5;
    // non-compliant earns 0
  }

  const totalApplicableRequirements = scoring.length;
  const rawScore = weightedTotal > 0 ? (weightedAchieved / weightedTotal) * 10 : 0;
  const score = Math.round(rawScore * 10) / 10;

  const formula =
    totalApplicableRequirements === 0
      ? "No guideline clauses were successfully evaluated for scoring. " +
        "Repeat the assessment. GMP and cross-SOP observations are advisory and do not affect this score."
      : `Weighted Score = (Σ achieved weight) ÷ (Σ total weight) × 10` +
        `\nWeights: Critical=5, Major=3, Minor=1, GMP/Cross-SOP=0 (advisory only)` +
        `\nGuideline requirements: ${criticalRequirementCount} critical, ${majorRequirementCount} major, ${minorRequirementCount} minor` +
        `\n= (${weightedAchieved.toFixed(1)}) ÷ (${weightedTotal.toFixed(1)}) × 10` +
        `\n= ${score.toFixed(1)} / 10`;

  return {
    totalApplicableRequirements,
    compliantCount,
    partialCount,
    nonCompliantCount,
    improvementCount,
    notApplicableCount,
    formula,
    score,
    scoringMethod: "weighted",
    weightedAchieved: Math.round(weightedAchieved * 10) / 10,
    weightedTotal: Math.round(weightedTotal * 10) / 10,
    criticalRequirementCount,
    majorRequirementCount,
    minorRequirementCount,
  };
}

/** Rate the strength of the SOP evidence backing a finding. */
export function assignEvidenceStrength(finding: ComplianceFinding): EvidenceStrength {
  const hasSnippet = Boolean(finding.sopTextSnippet?.trim()) && !/^not\s+found$/i.test(finding.sopTextSnippet.trim());
  const conf = finding.matchConfidence ?? 0;

  if (!hasSnippet) return finding.complianceLevel === "compliant" ? "weak" : "none";
  if (conf >= 80) return "strong";
  if (conf >= 60) return "moderate";
  if (conf >= 35) return "weak";
  return "none";
}

/** Map a risk level to a numeric weight for sorting (lower = higher priority). */
const RISK_ORDER: Record<RiskLevel, number> = {
  Critical: 0,
  Major: 1,
  Minor: 2,
  Improvement: 3,
};

/** Sort findings by risk severity — Critical always first. */
export function sortByRisk(findings: ComplianceFinding[]): ComplianceFinding[] {
  return [...findings].sort((a, b) => {
    const ra = RISK_ORDER[a.riskLevel ?? "Improvement"] ?? 3;
    const rb = RISK_ORDER[b.riskLevel ?? "Improvement"] ?? 3;
    if (ra !== rb) return ra - rb;
    return (b.matchConfidence ?? 0) - (a.matchConfidence ?? 0);
  });
}

/**
 * Build a stable root-cause key so findings describing the same underlying gap can
 * be merged. Uses the dominant regulatory concept extracted from the requirement/gap.
 */
const ROOT_CAUSE_CONCEPTS: { key: string; pattern: RegExp }[] = [
  { key: "change-control", pattern: /change\s+control|change\s+manag/i },
  { key: "risk-assessment", pattern: /risk\s+assess|quality\s+risk|risk\s+manag/i },
  { key: "capa", pattern: /\bcapa\b|corrective\s+and\s+preventive/i },
  { key: "deviation", pattern: /deviation|non[\s-]?conformance/i },
  { key: "data-integrity", pattern: /data\s+integ|alcoa|audit\s+trail|data\s+govern/i },
  { key: "validation-lifecycle", pattern: /lifecycle|continued\s+process\s+verification|revalidation|requalif/i },
  { key: "training", pattern: /training|competenc/i },
  { key: "periodic-review", pattern: /periodic\s+review|annual\s+review/i },
  { key: "documentation-retention", pattern: /retention|archiv|record\s+keeping/i },
  { key: "trending", pattern: /trend|statistical\s+analysis/i },
  { key: "investigation", pattern: /investigation|root\s+cause|oos|out[\s-]of[\s-]specification/i },
  { key: "vmp", pattern: /validation\s+master\s+plan|\bvmp\b/i },
];

export function deriveRootCauseKey(finding: ComplianceFinding): string {
  const haystack = `${finding.clauseTitle} ${finding.guidelineRequirement} ${finding.mismatchExplanation} ${finding.evidenceMissing ?? ""}`;
  for (const concept of ROOT_CAUSE_CONCEPTS) {
    if (concept.pattern.test(haystack)) return concept.key;
  }
  return "";
}

/**
 * Merge findings that share the same root cause AND compliance level so the report
 * does not repeat the same gap many times. The highest-risk finding wins; merged
 * clause references are recorded on the survivor.
 */
export function dedupeFindings(findings: ComplianceFinding[]): ComplianceFinding[] {
  const groups = new Map<string, ComplianceFinding[]>();
  const passthrough: ComplianceFinding[] = [];

  for (const f of findings) {
    const rootKey = f.rootCauseKey || deriveRootCauseKey(f);
    const isGap = f.complianceLevel === "partial" || f.complianceLevel === "non-compliant";
    // Only merge actionable gaps with a recognized root cause.
    if (!rootKey || !isGap) {
      passthrough.push(f);
      continue;
    }
    const groupKey = `${rootKey}::${f.complianceLevel}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(f);
  }

  const merged: ComplianceFinding[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const sorted = sortByRisk(group);
    const survivor = { ...sorted[0] };
    const others = sorted.slice(1);
    survivor.mergedClauseRefs = others.map(
      (o) => `${o.guidelineName ?? ""} Clause ${o.clauseNumber}`.trim(),
    );
    const extraGuidelines = [...new Set(others.map((o) => o.guidelineName).filter(Boolean))];
    if (extraGuidelines.length) {
      survivor.mismatchExplanation = [
        survivor.mismatchExplanation,
        `This root-cause gap also affects: ${extraGuidelines.join(", ")} (${others.length} related clause${others.length > 1 ? "s" : ""} merged).`,
      ]
        .filter(Boolean)
        .join(" ");
    }
    merged.push(survivor);
  }

  return [...merged, ...passthrough];
}

function deriveApplicability(f: ComplianceFinding): NonNullable<ComplianceFinding["applicability"]> {
  if (f.applicability) return f.applicability;
  if (f.complianceLevel === "not-applicable") return "not-applicable";
  if (f.complianceLevel === "partial") return "partially-applicable";
  return "applicable";
}

/** Build auditor reasoning fields when the model did not supply them. */
function deriveReasoning(f: ComplianceFinding): {
  whyApplies: string;
  whyEvidenceInsufficient: string;
  whyScoreReduced: string;
} {
  const isGap = f.complianceLevel === "partial" || f.complianceLevel === "non-compliant";
  const ref = f.guidelineReference || `${f.guidelineName ?? "the guideline"} Clause ${f.clauseNumber}`;

  const whyApplies =
    f.whyApplies?.trim() ||
    `${ref} applies because its requirement (${(f.guidelineRequirement || f.clauseTitle).slice(0, 160)}) is within the operational scope of this SOP.`;

  const whyEvidenceInsufficient =
    f.whyEvidenceInsufficient?.trim() ||
    (isGap
      ? f.evidenceMissing && isMeaningfulEvidence(f.evidenceMissing)
        ? `The SOP is missing: ${f.evidenceMissing}.`
        : f.mismatchExplanation?.trim() || "Required evidence was not located in the SOP text."
      : "");

  const whyScoreReduced =
    f.whyScoreReduced?.trim() ||
    (f.complianceLevel === "non-compliant"
      ? `Scored 0 for this ${getRequirementCriticality(f)} requirement — no supporting evidence found.`
      : f.complianceLevel === "partial"
        ? `Scored at half weight for this ${getRequirementCriticality(f)} requirement — partially addressed.`
        : "Not score-affecting.");

  return { whyApplies, whyEvidenceInsufficient, whyScoreReduced };
}

/**
 * Apply the full classification pass to a list of evidence-validated findings:
 * applicability + category + risk + evidence strength + manual-review flag + reasoning.
 */
export function classifyAll(findings: ComplianceFinding[]): ComplianceFinding[] {
  return findings.map((f) => {
    const { findingCategory, riskLevel } = classifyFinding(f);
    const evidenceStrength = assignEvidenceStrength(f);
    const requiresManualReview =
      (f.complianceLevel === "partial" || f.complianceLevel === "non-compliant") &&
      ((f.matchConfidence ?? 0) < MANUAL_REVIEW_CONFIDENCE_THRESHOLD ||
        evidenceStrength === "none" ||
        evidenceStrength === "weak");

    const applicability = deriveApplicability(f);
    const requirementCriticality = getRequirementCriticality(f);
    const reasoning = deriveReasoning(f);

    return {
      ...f,
      ...(findingCategory ? { findingCategory } : {}),
      riskLevel,
      evidenceStrength,
      requiresManualReview,
      applicability,
      requirementCriticality,
      ...reasoning,
      rootCauseKey: f.rootCauseKey || deriveRootCauseKey(f),
    };
  });
}

/**
 * Regulatory auditor standard — keep EVERY clause evaluation while protecting the
 * compliance score from speculation. This NEVER drops a finding: complete
 * clause-by-clause coverage is mandatory, so every evaluated clause remains
 * visible and traceable in the report.
 *
 *  - Not-Applicable / compliant clauses pass through unchanged.
 *  - A gap that lacks concrete missing evidence AND relies on speculative wording
 *    ("may be", "appears", "could be"…) is kept but demoted to an advisory
 *    Improvement Opportunity so it no longer penalises the score — the
 *    observation is still shown for the reviewer, just not counted as a defensible gap.
 *  - A gap missing mandatory traceability fields is kept but flagged for manual
 *    QA review instead of being suppressed.
 *
 * Returns the full finding set (same length in), with adjustments applied.
 */
export function applyAuditorStandards(findings: ComplianceFinding[]): ComplianceFinding[] {
  const result: ComplianceFinding[] = [];

  for (const f of findings) {
    const isGap = f.complianceLevel === "partial" || f.complianceLevel === "non-compliant";

    if (!isGap) {
      result.push(f);
      continue;
    }

    // Cross-SOP / GMP-intelligence findings are validated structurally elsewhere.
    const isStructural = f.findingType === "cross-sop-dependency" || f.findingType === "gmp-expectation";

    const hasConcreteMissingEvidence = isMeaningfulEvidence(f.evidenceMissing);
    const reason = f.mismatchExplanation?.trim() || "";
    const reasonIsSpeculative = isSpeculative(reason) && !hasConcreteMissingEvidence;

    // Mandatory traceability fields for a defensible finding.
    const hasTraceability =
      !!f.clauseNumber?.trim() &&
      !!(f.guidelineRequirement?.trim() || f.guidelineReference?.trim()) &&
      (hasConcreteMissingEvidence || !!reason) &&
      (f.matchConfidence ?? 0) > 0;

    // Speculative gap without concrete missing evidence → keep but mark advisory.
    if (!isStructural && reasonIsSpeculative) {
      result.push({
        ...f,
        findingCategory: "Improvement Opportunity",
        riskLevel: "Improvement",
        requiresManualReview: true,
        whyScoreReduced:
          "Not score-affecting — observation is advisory (no concrete missing evidence to defensibly cite as a gap). Flagged for QA review.",
      });
      continue;
    }

    // Gap lacks full traceability → keep but flag for manual review (never suppress).
    if (!isStructural && !hasTraceability) {
      result.push({
        ...f,
        requiresManualReview: true,
        whyEvidenceInsufficient:
          f.whyEvidenceInsufficient?.trim() ||
          "Traceability fields are incomplete for this clause — QA must verify the evidence before relying on this finding.",
      });
      continue;
    }

    result.push(f);
  }

  return result;
}
