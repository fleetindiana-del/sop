import ComplianceReport from "@/models/ComplianceReport";
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

function isObjectId(value?: string): boolean {
  return !!value && mongoose.Types.ObjectId.isValid(value);
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

  const saved = await ComplianceReport.findOneAndUpdate(
    { sopId: new mongoose.Types.ObjectId(data.sopId) },
    { $set: reportData },
    { upsert: true, returnDocument: 'after' },
  );
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
