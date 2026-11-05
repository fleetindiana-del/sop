import ComplianceReport from "@/models/ComplianceReport";
import SOP from "@/models/SOP";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import type {
  AuditCompleteness,
  ComplianceFinding,
  ComplianceScoreBreakdown,
  CrossSopDependency,
  TraceabilityMatrixEntry,
} from "@/lib/complianceEngine";
import { computeWeightedScoreBreakdown } from "@/lib/complianceClassification";
import { attachGuidelineSourceFields } from "@/lib/guidelineClauseDisplay";
import mongoose from "mongoose";
import { completeMatchingComplianceRunRequests } from "@/lib/complianceRunRequests";
import { logAuditEvent, resolveAuditActor } from "@/lib/audit-log";
import { COMPLIANCE_PASS_SCORE } from "@/lib/registry-compliance";

function isObjectId(value?: string): boolean {
  return !!value && mongoose.Types.ObjectId.isValid(value);
}

/**
 * Registry SCORE / COMPLIANCE DONE are derived from the current report, so an
 * analysis run is the mutation that changes those columns — audit it here.
 */
async function logComplianceScoreAudit(params: {
  sopId: string;
  sopIdentifier: string;
  sopName: string;
  department: string;
  before: { overallScore?: number; complianceStatus?: string } | null;
  afterScore: number;
  afterStatus: string;
}): Promise<void> {
  try {
    const previousScore = params.before?.overallScore ?? null;
    const previousDone = previousScore == null ? null : previousScore >= COMPLIANCE_PASS_SCORE;
    const nextDone = params.afterScore >= COMPLIANCE_PASS_SCORE;
    if (previousScore === params.afterScore && previousDone === nextDone) return;

    const fieldsChanged = ["complianceScore", "complianceDone", "complianceStatus"];
    const scoreText = `${Math.round(params.afterScore * 10)}%`;
    await logAuditEvent({
      actor: await resolveAuditActor(),
      entityType: "sop",
      entityId: params.sopId,
      entityLabel: params.sopIdentifier,
      sopName: params.sopName,
      department: params.department,
      action: "updated",
      fieldsChanged,
      previousValues: {
        complianceScore: previousScore,
        complianceDone: previousDone,
        complianceStatus: params.before?.complianceStatus ?? null,
      },
      updatedValues: {
        complianceScore: params.afterScore,
        complianceDone: nextDone,
        complianceStatus: params.afterStatus,
      },
      summary:
        previousScore == null
          ? `Compliance analysed for ${params.sopIdentifier} — score ${scoreText}`
          : `Compliance score for ${params.sopIdentifier} changed ${Math.round(previousScore * 10)}% → ${scoreText}`,
    });
  } catch (err) {
    console.error("[compliance] audit log failed:", err);
  }
}

function sopStatusFromReport(
  status: string,
): "compliant" | "partial" | "non-compliant" | "pending" {
  const s = status.toLowerCase();
  if (s.includes("non-compliant") || s.includes("non compliant")) return "non-compliant";
  if (s.includes("partial")) return "partial";
  if (s.includes("fully") || s === "compliant") return "compliant";
  return "pending";
}

/** QA-facing note stored on the SOP. Cites the guidelines behind the score. */
function sopComplianceNote(params: {
  score: number;
  status: string;
  guidelines: string[];
  breakdown: ComplianceScoreBreakdown;
  assessedBy?: string;
}): string {
  const cited = params.guidelines.slice(0, 12);
  const against = cited.length
    ? `Assessed against ${cited.join("; ")}.`
    : "Assessed against the applicable guideline clauses.";
  return [
    params.assessedBy ? `Compliance assessment performed by ${params.assessedBy}.` : "",
    `Compliance score ${params.score.toFixed(1)}/10 (${params.status}).`,
    against,
    `${params.breakdown.compliantCount} compliant, ${params.breakdown.partialCount} partial, ${params.breakdown.nonCompliantCount} non-compliant of ${params.breakdown.totalApplicableRequirements} applicable guideline requirements.`,
    "Not-applicable clauses are excluded from the score. Critical requirements weigh 5, major 3, minor 1; a partial requirement receives half credit.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function writeComplianceOntoSop(params: {
  sopId: string;
  score: number;
  status: string;
  findings: { guidelineName?: string }[];
  breakdown: ComplianceScoreBreakdown;
  assessedBy?: string;
  invalidate?: boolean;
}): Promise<void> {
  if (!isObjectId(params.sopId)) return;
  const guidelines = [
    ...new Set(
      params.findings
        .map((f) => f.guidelineName?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  await SOP.updateOne(
    { _id: new mongoose.Types.ObjectId(params.sopId) },
    {
      $set: {
        complianceStatus: sopStatusFromReport(params.status),
        complianceScore: params.score,
        complianceNotes: sopComplianceNote({
          score: params.score,
          status: params.status,
          guidelines,
          breakdown: params.breakdown,
          assessedBy: params.assessedBy,
        }),
        ...(params.assessedBy ? { lastReviewedBy: params.assessedBy } : {}),
        ...(guidelines.length
          ? { guidelineReference: guidelines.join("; ").slice(0, 4000) }
          : {}),
        lastReviewedAt: new Date(),
      },
    },
  );
  if (params.invalidate !== false) invalidateDashboardSopsCache();
}

export async function saveComplianceReport(data: {
  sopId: string;
  sopIdentifier: string;
  sopName: string;
  sopVersion?: string;
  department: string;
  findings: (ComplianceFinding & { guidelineId?: string; folderName?: string })[];
  overallScore: number;
  complianceStatus: string;
  // structured regulatory audit output (V5)
  scoreBreakdown?: ComplianceScoreBreakdown;
  traceabilityMatrix?: TraceabilityMatrixEntry[];
  crossSopDependencies?: CrossSopDependency[];
  auditCompleteness?: AuditCompleteness;
  clauseCoveragePct?: number;
  analysisEngineVersion?: string;
  /** Shown on the SOP as who performed the assessment, e.g. "Codex". */
  assessedBy?: string;
  // accepted but not stored — callers may still pass these
  sopContentLength?: number;
  processingTimeMs?: number;
  guidelinesUsed?: unknown;
  /** Annexure evidence folded into the audited SOP text for this run. */
  annexuresChecked?: boolean;
  annexureStatus?: "none" | "checked" | "not-checked" | "linked-unread";
  linkedAnnexureCount?: number;
  annexureChars?: number;
  annexuresIncluded?: { label: string; fileName: string; chars: number }[];
  annexuresSkipped?: { label: string; fileName: string; reason: string }[];
}) {
  const compliantCount = data.findings.filter((f) => f.complianceLevel === "compliant").length;
  const partialCount = data.findings.filter((f) => f.complianceLevel === "partial").length;
  const nonCompliantCount = data.findings.filter((f) => f.complianceLevel === "non-compliant").length;
  const notApplicableCount = data.findings.filter((f) => f.complianceLevel === "not-applicable").length;

  // Transparent weighted score — V3 uses its own formula; V5 uses classification weights.
  const isV3Engine = data.analysisEngineVersion?.startsWith("v3");
  const breakdown = data.scoreBreakdown ?? computeWeightedScoreBreakdown(data.findings);
  const scoreFromFindings = isV3Engine
    ? data.overallScore
    : breakdown.totalApplicableRequirements > 0
      ? breakdown.score
      : data.overallScore;

  const criticalCount = data.findings.filter((f) => f.findingCategory === "Critical Non-Compliance").length;
  const majorCount = data.findings.filter((f) => f.findingCategory === "Major Gap").length;
  const minorCount = data.findings.filter((f) => f.findingCategory === "Minor Gap").length;
  const improvementCount = data.findings.filter((f) => f.findingCategory === "Improvement Opportunity").length;
  const bestPracticeCount = data.findings.filter((f) => f.findingCategory === "Best Practice Recommendation").length;

  const reportData = {
    sopId: new mongoose.Types.ObjectId(data.sopId),
    sopIdentifier: data.sopIdentifier,
    sopName: data.sopName,
    sopVersion: data.sopVersion ?? "1.0",
    department: data.department,
    analysisStatus: "completed" as const,
    analysisCompletedAt: new Date(),
    overallScore: scoreFromFindings,
    complianceStatus: data.complianceStatus as never,
    totalGuidelinesChecked: data.findings.length,
    compliantCount,
    partialCount,
    nonCompliantCount,
    notApplicableCount,
    criticalCount,
    majorCount,
    minorCount,
    improvementCount,
    bestPracticeCount,
    clauseCoveragePct: data.clauseCoveragePct ?? data.auditCompleteness?.clauseCoveragePct ?? 0,
    analysisEngineVersion: data.analysisEngineVersion ?? "v5",
    annexuresChecked:
      data.annexureStatus === "checked" || data.annexuresChecked === true,
    annexureStatus:
      data.annexureStatus ??
      (data.annexuresChecked === true ? "checked" : "none"),
    linkedAnnexureCount: data.linkedAnnexureCount ?? 0,
    annexureChars: data.annexureChars ?? 0,
    annexuresIncluded: data.annexuresIncluded ?? [],
    annexuresSkipped: data.annexuresSkipped ?? [],
    scoreBreakdown: breakdown,
    auditCompleteness: data.auditCompleteness,
    traceabilityMatrix: data.traceabilityMatrix ?? [],
    crossSopDependencies: data.crossSopDependencies ?? [],
    findings: data.findings.map((f) => {
      const withSource = attachGuidelineSourceFields(f);
      return {
      guidelineId: isObjectId(f.guidelineId) ? new mongoose.Types.ObjectId(f.guidelineId) : undefined,
      guidelineName: f.guidelineName ?? "",
      folderName: f.folderName ?? "",
      clauseNumber: f.clauseNumber,
      clauseTitle: f.clauseTitle,
      complianceLevel: f.complianceLevel,
      matchConfidence: f.matchConfidence,
      issueSeverity: f.issueSeverity,
      sopSectionAffected: f.sopSectionAffected,
      mismatchExplanation: f.mismatchExplanation,
      sopTextSnippet: f.sopTextSnippet,
      guidelineRequirement: withSource.guidelineRequirement ?? f.guidelineRequirement,
      clauseText: withSource.clauseText ?? f.clauseText ?? "",
      guidelineSourceLine: withSource.guidelineSourceLine ?? "",
      guidelineLineNumber: withSource.guidelineLineNumber ?? "",
      guidelineSearchPhrase: (withSource as { guidelineSearchPhrase?: string }).guidelineSearchPhrase ?? "",
      suggestedAction: f.suggestedAction,
      suggestedText: f.suggestedText,
      impactAnalysis: f.impactAnalysis ?? "",
      estimatedEffort: f.estimatedEffort,
      findingCategory: f.findingCategory,
      riskLevel: f.riskLevel,
      guidelineReference: f.guidelineReference,
      evidenceFound: f.evidenceFound ?? "",
      evidenceMissing: f.evidenceMissing ?? "",
      evidenceStrength: f.evidenceStrength,
      pageNumber: f.pageNumber ?? "",
      paragraphNumber: f.paragraphNumber ?? "",
      requiresManualReview: f.requiresManualReview ?? false,
      findingType: f.findingType ?? "guideline-clause",
      rootCauseKey: f.rootCauseKey ?? "",
      mergedClauseRefs: f.mergedClauseRefs,
      applicability: f.applicability,
      requirementCriticality: f.requirementCriticality,
      scopeOwner: f.scopeOwner,
      whyApplies: f.whyApplies ?? "",
      whyEvidenceInsufficient: f.whyEvidenceInsufficient ?? "",
      whyScoreReduced: f.whyScoreReduced ?? "",
    };
    }),
    analyzedAt: new Date(),
  };

  const before = await ComplianceReport.findOne({ sopId: new mongoose.Types.ObjectId(data.sopId) })
    .select("overallScore complianceStatus analysisStatus")
    .lean();

  const saved = await ComplianceReport.findOneAndUpdate(
    { sopId: new mongoose.Types.ObjectId(data.sopId) },
    { $set: reportData },
    { upsert: true, returnDocument: 'after' },
  );

  await logComplianceScoreAudit({
    sopId: data.sopId,
    sopIdentifier: data.sopIdentifier,
    sopName: data.sopName,
    department: data.department,
    before,
    afterScore: reportData.overallScore,
    afterStatus: data.complianceStatus,
  });

  try {
    await writeComplianceOntoSop({
      sopId: data.sopId,
      score: reportData.overallScore,
      status: data.complianceStatus,
      findings: data.findings,
      breakdown,
      assessedBy: data.assessedBy,
    });
  } catch (err) {
    console.error("[compliance] failed to copy score onto SOP:", err);
  }

  try {
    await completeMatchingComplianceRunRequests({
      _id: saved?._id,
      sopId: saved?.sopId ?? data.sopId,
      sopIdentifier: saved?.sopIdentifier ?? data.sopIdentifier,
      sopName: saved?.sopName ?? data.sopName,
      department: saved?.department ?? data.department,
      overallScore: saved?.overallScore ?? data.overallScore,
      complianceStatus: saved?.complianceStatus ?? data.complianceStatus,
      analyzedAt: saved?.analyzedAt,
      compliantCount: saved?.compliantCount,
      partialCount: saved?.partialCount,
      nonCompliantCount: saved?.nonCompliantCount,
    });
  } catch (err) {
    console.error("[compliance] failed to complete matching run requests:", err);
  }
  return saved;
}

/** Copy the latest completed assessment onto each SOP that already has a report. */
export async function backfillComplianceOntoSops(): Promise<number> {
  const reports = await ComplianceReport.find({ analysisStatus: "completed" })
    .select("sopId overallScore complianceStatus findings scoreBreakdown")
    .lean();
  let updated = 0;
  for (const report of reports) {
    const sopId = report.sopId?.toString();
    if (!sopId) continue;
    const findings = (report.findings ?? []) as { guidelineName?: string; complianceLevel?: string; findingCategory?: string }[];
    const breakdown =
      (report.scoreBreakdown as ComplianceScoreBreakdown | undefined) ??
      computeWeightedScoreBreakdown(findings as never);
    await writeComplianceOntoSop({
      sopId,
      score: report.overallScore ?? breakdown.score ?? 0,
      status: report.complianceStatus ?? "Analysis Pending",
      findings,
      breakdown,
      invalidate: false,
    });
    updated += 1;
  }
  if (updated > 0) invalidateDashboardSopsCache();
  return updated;
}

export async function getComplianceReport(sopId: string) {
  return ComplianceReport.findOne({ sopId: new mongoose.Types.ObjectId(sopId) }).lean();
}

export async function getAllComplianceReports(limit = 100) {
  return ComplianceReport.find({})
    .sort({ analyzedAt: -1 })
    .limit(limit)
    .select("-findings")
    .lean();
}

export async function deleteComplianceReport(reportId: string) {
  return ComplianceReport.findByIdAndDelete(reportId);
}
