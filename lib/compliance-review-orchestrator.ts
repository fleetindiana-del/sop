import type { LlmProvider } from "@/lib/llm";
import type { ComplianceFinding } from "@/lib/complianceEngine";
import type { TraceabilityMatrixEntry } from "@/lib/complianceEngine";
import { analyzeSOPComplianceV5, type SopLibraryEntry } from "@/lib/complianceEngineV5";
import { saveComplianceReport } from "@/lib/complianceReportStorage";
import {
  attachGapIdsToReportFindings,
  persistComplianceFindings,
} from "@/lib/compliance-finding-store";
import { runIncrementalComplianceReview } from "@/lib/compliance-incremental";
import { computeWeightedScoreBreakdown } from "@/lib/complianceClassification";
import { getOrBuildComplianceStructure } from "@/lib/compliance-sop-cache";
import { hashGuidelineSet, hashSingleGuideline, hashSopContent } from "@/lib/compliance-hashes";
import type { IComplianceFindingDetail } from "@/models/ComplianceReport";
import ComplianceGapFinding from "@/models/ComplianceGapFinding";
import ComplianceReport from "@/models/ComplianceReport";
import type { ISOP } from "@/models/SOP";

/** Lean SOP fields required by the review pipeline (not a full Mongoose document). */
export type ComplianceReviewSop = Pick<
  ISOP,
  | "_id"
  | "content"
  | "identifier"
  | "name"
  | "department"
  | "version"
  | "complianceStructureCache"
>;

export type GuidelineClauseInput = {
  clauseNumber: string;
  clauseTitle: string;
  clauseText: string;
  guidelineName: string;
  folderName: string;
  pdfName?: string;
  guidelineId: string;
};

export type ComplianceReviewMode = "initial" | "incremental" | "auto";

export type RunComplianceReviewInput = {
  sop: ComplianceReviewSop;
  guidelineClauses: GuidelineClauseInput[];
  sopLibrary: SopLibraryEntry[];
  provider?: LlmProvider;
  model?: string;
  mode?: ComplianceReviewMode;
  forceRefresh?: boolean;
  runEpoch?: number;
  /** When set, only these guidelines are re-analyzed; other findings are kept from the last report. */
  scopedGuidelineIds?: string[];
  annexuresChecked?: boolean;
  annexureStatus?: "none" | "checked" | "not-checked" | "linked-unread";
  linkedAnnexureCount?: number;
  annexureChars?: number;
  annexuresIncluded?: { label: string; fileName: string; chars: number }[];
  annexuresSkipped?: { label: string; fileName: string; reason: string }[];
};

export type ComplianceReviewOutput = {
  mode: "initial" | "incremental" | "cached";
  overallScore: number;
  complianceStatus: string;
  compliantCount: number;
  partialCount: number;
  nonCompliantCount: number;
  criticalCount: number;
  majorCount: number;
  minorCount: number;
  improvementCount: number;
  clauseCoveragePct: number;
  totalGuidelinesChecked: number;
  processingTimeMs: number;
  findingsPersisted?: number;
  findingsSkipped?: number;
  findingsMerged?: number;
  incrementalReviewed?: number;
  incrementalResolved?: number;
};

/** Map a stored DB finding back to the engine's ComplianceFinding shape. */
function fromStoredFinding(f: IComplianceFindingDetail): ComplianceFinding {
  return {
    clauseNumber: f.clauseNumber,
    clauseTitle: f.clauseTitle,
    complianceLevel: f.complianceLevel,
    matchConfidence: f.matchConfidence,
    issueSeverity: f.issueSeverity,
    sopSectionAffected: f.sopSectionAffected,
    mismatchExplanation: f.mismatchExplanation,
    sopTextSnippet: f.sopTextSnippet,
    guidelineRequirement: f.guidelineRequirement,
    suggestedAction: f.suggestedAction,
    suggestedText: f.suggestedText,
    impactAnalysis: f.impactAnalysis,
    highlightedIssue: f.mismatchExplanation,
    estimatedEffort: f.estimatedEffort,
    guidelineName: f.guidelineName,
    folderName: f.folderName,
    guidelineId: f.guidelineId?.toString(),
    findingType: f.findingType as ComplianceFinding["findingType"],
    guidelineReference: f.guidelineReference,
    evidenceFound: f.evidenceFound,
    evidenceMissing: f.evidenceMissing,
    pageNumber: f.pageNumber,
    paragraphNumber: f.paragraphNumber,
    rootCauseKey: f.rootCauseKey,
    applicability: f.applicability as ComplianceFinding["applicability"],
    scopeOwner: f.scopeOwner as ComplianceFinding["scopeOwner"],
    requirementCriticality: f.requirementCriticality as ComplianceFinding["requirementCriticality"],
    whyApplies: f.whyApplies,
    whyEvidenceInsufficient: f.whyEvidenceInsufficient,
    findingCategory: f.findingCategory as ComplianceFinding["findingCategory"],
    riskLevel: f.riskLevel as ComplianceFinding["riskLevel"],
    evidenceStrength: f.evidenceStrength as ComplianceFinding["evidenceStrength"],
    requiresManualReview: f.requiresManualReview,
    mergedClauseRefs: f.mergedClauseRefs,
  };
}

function deriveComplianceStatus(score: number): "Fully Compliant" | "Partially Compliant" | "Non-Compliant" {
  if (score >= 8) return "Fully Compliant";
  if (score >= 5) return "Partially Compliant";
  return "Non-Compliant";
}

export async function runComplianceReview(
  input: RunComplianceReviewInput,
): Promise<ComplianceReviewOutput> {
  const start = Date.now();
  const sopContentHash = hashSopContent(input.sop.content ?? "");
  const guidelineHash = hashGuidelineSet(input.guidelineClauses);
  const structure = await getOrBuildComplianceStructure(input.sop);

  const existingReport = await ComplianceReport.findOne({
    sopId: input.sop._id,
    analysisStatus: "completed",
  })
    .sort({ analyzedAt: -1 })
    .lean();

  const existingGaps = await ComplianceGapFinding.countDocuments({ sopId: input.sop._id });
  const unresolvedGaps = await ComplianceGapFinding.countDocuments({
    sopId: input.sop._id,
    resolved: false,
  });

  const wantIncremental =
    input.mode === "incremental" ||
    (input.mode !== "initial" &&
      !input.forceRefresh &&
      existingReport &&
      existingGaps > 0 &&
      unresolvedGaps > 0);

  if (wantIncremental && !input.forceRefresh) {
    const prevHashes = input.sop.complianceStructureCache?.sectionHashes;
    const inc = await runIncrementalComplianceReview(input.sop, {
      provider: input.provider,
      previousStructure: prevHashes,
    });

    return {
      mode: "incremental",
      overallScore: inc.overallScore,
      complianceStatus: deriveComplianceStatus(inc.overallScore),
      compliantCount: existingReport?.compliantCount ?? 0,
      partialCount: existingReport?.partialCount ?? 0,
      nonCompliantCount: existingReport?.nonCompliantCount ?? 0,
      criticalCount: inc.criticalCount,
      majorCount: inc.majorCount,
      minorCount: inc.minorCount,
      improvementCount: inc.improvementCount,
      clauseCoveragePct: existingReport?.clauseCoveragePct ?? 0,
      totalGuidelinesChecked: existingReport?.totalGuidelinesChecked ?? 0,
      processingTimeMs: Date.now() - start,
      incrementalReviewed: inc.reviewed,
      incrementalResolved: inc.resolved,
    };
  }

  if (!input.forceRefresh && existingReport && existingGaps > 0) {
    const reportGuidelineHash = (existingReport as { guidelineSetHash?: string }).guidelineSetHash;
    if (reportGuidelineHash === guidelineHash) {
      return {
        mode: "cached",
        overallScore: existingReport.overallScore,
        complianceStatus: existingReport.complianceStatus,
        compliantCount: existingReport.compliantCount,
        partialCount: existingReport.partialCount,
        nonCompliantCount: existingReport.nonCompliantCount,
        criticalCount: existingReport.criticalCount ?? 0,
        majorCount: existingReport.majorCount ?? 0,
        minorCount: existingReport.minorCount ?? 0,
        improvementCount: existingReport.improvementCount ?? 0,
        clauseCoveragePct: existingReport.clauseCoveragePct ?? 0,
        totalGuidelinesChecked: existingReport.totalGuidelinesChecked,
        processingTimeMs: Date.now() - start,
      };
    }
  }

  // Per-guideline cache: only re-analyze guidelines whose content changed.
  // Fresh guidelines reuse findings stored in the last completed report.
  const staleClauses: GuidelineClauseInput[] = [];
  const cachedFindings: ComplianceFinding[] = [];
  const newGuidelineHashes = new Map<string, string>();

  const byGuideline = new Map<string, GuidelineClauseInput[]>();
  for (const c of input.guidelineClauses) {
    const id = c.guidelineId;
    if (!byGuideline.has(id)) byGuideline.set(id, []);
    byGuideline.get(id)!.push(c);
  }

  // Mongoose .lean() returns Maps as plain objects — normalize to a real Map.
  const storedHashesRaw =
    !input.forceRefresh && existingReport?.sopContentHash === sopContentHash
      ? ((existingReport as unknown as Record<string, unknown>).guidelineHashes as Record<string, string> | Map<string, string> | undefined)
      : undefined;
  const storedHashes: Map<string, string> | undefined = storedHashesRaw
    ? storedHashesRaw instanceof Map
      ? storedHashesRaw
      : new Map(Object.entries(storedHashesRaw))
    : undefined;

  for (const [id, clauses] of byGuideline) {
    const hash = hashSingleGuideline(clauses);
    newGuidelineHashes.set(id, hash);

    if (storedHashes?.get(id) === hash && existingReport) {
      const fresh = (existingReport.findings as IComplianceFindingDetail[])
        .filter((f) => f.guidelineId?.toString() === id)
        .map(fromStoredFinding);
      // Don't reuse a cached result where every finding is analysis-failed —
      // that means the AI call failed last time and we should retry.
      const allFailed =
        fresh.length > 0 && fresh.every((f) => f.complianceLevel === "analysis-failed");
      if (allFailed) {
        staleClauses.push(...clauses);
        console.log(
          `[orchestrator] guideline ${id}: cache invalidated — all ${fresh.length} findings were analysis-failed, retrying`,
        );
      } else {
        cachedFindings.push(...fresh);
        console.log(`[orchestrator] guideline ${id}: cache hit (${fresh.length} findings reused)`);
      }
    } else {
      staleClauses.push(...clauses);
    }
  }

  const hasStalework = staleClauses.length > 0;
  if (!hasStalework && cachedFindings.length > 0) {
    // All guidelines are fresh — keep attestation up to date, return cached findings.
    await ComplianceReport.updateOne(
      { _id: existingReport!._id },
      {
        $set: {
          annexuresChecked: input.annexureStatus === "checked" || input.annexuresChecked === true,
          annexureStatus:
            input.annexureStatus ??
            (input.annexuresChecked === true ? "checked" : "none"),
          linkedAnnexureCount: input.linkedAnnexureCount ?? 0,
          annexureChars: input.annexureChars ?? 0,
          annexuresIncluded: input.annexuresIncluded ?? [],
          annexuresSkipped: input.annexuresSkipped ?? [],
        },
      },
    );
    return {
      mode: "cached",
      overallScore: existingReport!.overallScore,
      complianceStatus: existingReport!.complianceStatus,
      compliantCount: existingReport!.compliantCount,
      partialCount: existingReport!.partialCount,
      nonCompliantCount: existingReport!.nonCompliantCount,
      criticalCount: existingReport!.criticalCount ?? 0,
      majorCount: existingReport!.majorCount ?? 0,
      minorCount: existingReport!.minorCount ?? 0,
      improvementCount: existingReport!.improvementCount ?? 0,
      clauseCoveragePct: existingReport!.clauseCoveragePct ?? 0,
      totalGuidelinesChecked: existingReport!.totalGuidelinesChecked,
      processingTimeMs: Date.now() - start,
    };
  }

  const result = await analyzeSOPComplianceV5({
    sopIdentifier: input.sop.identifier,
    sopName: input.sop.name,
    department: input.sop.department,
    sopContent: input.sop.content,
    sopId: input.sop._id.toString(),
    runEpoch: input.runEpoch,
    guidelineClauses: staleClauses,
    cachedFindings,
    allClauses: input.guidelineClauses,
    sopLibrary: input.sopLibrary,
    provider: input.provider,
    model: input.model,
  });

  const scopedIds = input.scopedGuidelineIds?.length
    ? new Set(input.scopedGuidelineIds)
    : null;
  const scopedNames = scopedIds
    ? new Set(input.guidelineClauses.map((c) => c.guidelineName))
    : null;

  let findingsToSave = result.findings;
  let traceabilityMatrix = result.traceabilityMatrix ?? [];
  let scoreBreakdown = result.scoreBreakdown;
  let overallScore = result.overallScore;
  let complianceStatus = result.complianceStatus;

  if (scopedIds && scopedNames && existingReport) {
    const preservedFindings = (existingReport.findings as IComplianceFindingDetail[])
      .filter((f) => !scopedIds.has(f.guidelineId?.toString() ?? ""))
      .map(fromStoredFinding);
    findingsToSave = [...preservedFindings, ...result.findings];

    const preservedMatrix = (existingReport.traceabilityMatrix ?? []).filter(
      (e) => !scopedNames.has(e.guidelineName),
    ) as TraceabilityMatrixEntry[];
    traceabilityMatrix = [...preservedMatrix, ...traceabilityMatrix];

    scoreBreakdown = computeWeightedScoreBreakdown(findingsToSave);
    overallScore = scoreBreakdown.score;
    complianceStatus = deriveComplianceStatus(overallScore);
  }

  const saved = await saveComplianceReport({
    sopId: input.sop._id.toString(),
    sopIdentifier: input.sop.identifier,
    sopName: input.sop.name,
    sopVersion: input.sop.version ?? "1.0",
    department: input.sop.department,
    findings: findingsToSave,
    overallScore,
    complianceStatus,
    scoreBreakdown,
    traceabilityMatrix,
    crossSopDependencies: result.crossSopDependencies,
    clauseCoveragePct: result.clauseCoveragePct,
    auditCompleteness: result.auditCompleteness,
    analysisEngineVersion: result.analysisEngineVersion,
    annexuresChecked: input.annexureStatus === "checked" || input.annexuresChecked === true,
    annexureStatus:
      input.annexureStatus ??
      (input.annexuresChecked === true ? "checked" : "none"),
    linkedAnnexureCount: input.linkedAnnexureCount ?? 0,
    annexureChars: input.annexureChars ?? 0,
    annexuresIncluded: input.annexuresIncluded ?? [],
    annexuresSkipped: input.annexuresSkipped ?? [],
  });

  const mergedGuidelineHashes =
    scopedIds && storedHashes
      ? new Map([...storedHashes.entries(), ...newGuidelineHashes.entries()])
      : newGuidelineHashes;

  await ComplianceReport.updateOne(
    { _id: saved?._id },
    {
      $set: {
        sopContentHash,
        guidelineSetHash:
          scopedIds && (existingReport as { guidelineSetHash?: string } | null)?.guidelineSetHash
            ? (existingReport as { guidelineSetHash?: string }).guidelineSetHash
            : guidelineHash,
        guidelineHashes: mergedGuidelineHashes,
      },
    },
  );

  const persistResult = await persistComplianceFindings({
    sopId: input.sop._id.toString(),
    reportId: saved?._id?.toString(),
    findings: findingsToSave,
    structure,
  });

  return {
    mode: "initial",
    overallScore,
    complianceStatus,
    compliantCount: findingsToSave.filter((f) => f.complianceLevel === "compliant").length,
    partialCount: findingsToSave.filter((f) => f.complianceLevel === "partial").length,
    nonCompliantCount: findingsToSave.filter((f) => f.complianceLevel === "non-compliant").length,
    criticalCount: findingsToSave.filter((f) => f.findingCategory === "Critical Non-Compliance").length,
    majorCount: findingsToSave.filter((f) => f.findingCategory === "Major Gap").length,
    minorCount: findingsToSave.filter((f) => f.findingCategory === "Minor Gap").length,
    improvementCount: findingsToSave.filter((f) => f.findingCategory === "Improvement Opportunity").length,
    clauseCoveragePct: result.clauseCoveragePct ?? 0,
    totalGuidelinesChecked: findingsToSave.length,
    processingTimeMs: result.processingTimeMs ?? Date.now() - start,
    findingsPersisted: persistResult.persisted,
    findingsSkipped: persistResult.skipped,
    findingsMerged: persistResult.merged,
  };
}

export { attachGapIdsToReportFindings };
