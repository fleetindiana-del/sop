import { connectDB } from "@/lib/mongodb";
import SOPGuideline from "@/models/SOPGuideline";
import SOP from "@/models/SOP";
import ComplianceReport from "@/models/ComplianceReport";
import SOPGuidelineResult from "@/models/SOPGuidelineResult";
import { analyzeSOPComplianceV3 } from "@/lib/complianceEngineV3";
import { saveComplianceReport } from "@/lib/complianceReportStorage";

export interface GuidelineSopReviewOptions {
  sopId: string;
  guidelineIds?: string[];
}

export async function runGuidelineSopReview(options: GuidelineSopReviewOptions) {
  await connectDB();

  const sop = await SOP.findById(options.sopId).lean();
  if (!sop) throw new Error("SOP not found");

  const guidelineQuery = options.guidelineIds?.length
    ? { _id: { $in: options.guidelineIds }, ocrStatus: "completed" as const }
    : { ocrStatus: "completed" as const };
  const guidelines = await SOPGuideline.find(guidelineQuery)
    .select("name folderName pdfName clauses.clauseNumber clauses.clauseTitle clauses.clauseText")
    .lean();

  if (!guidelines.length) throw new Error("No guidelines found");

  const guidelineClauses = guidelines.flatMap((g) =>
    (g.clauses ?? []).map((c) => ({
      clauseNumber: c.clauseNumber ?? "",
      clauseTitle: c.clauseTitle ?? "",
      clauseText: (c.clauseText ?? "").slice(0, 3000),
      guidelineName: g.name,
      folderName: g.folderName,
      pdfName: g.pdfName,
      guidelineId: g._id.toString(),
    })),
  );

  const result = await analyzeSOPComplianceV3({
    sopIdentifier: sop.identifier,
    sopName: sop.name,
    department: sop.department,
    sopContent: sop.content,
    guidelineClauses,
  });

  const report = await saveComplianceReport({
    sopId: sop._id.toString(),
    sopIdentifier: sop.identifier,
    sopName: sop.name,
    sopVersion: sop.version ?? "1.0",
    department: sop.department,
    findings: result.findings,
    overallScore: result.overallScore,
    complianceStatus: result.complianceStatus,
  });

  await SOPGuidelineResult.findOneAndUpdate(
    { sopNo: sop.identifier },
    {
      sopId: sop._id,
      sopNo: sop.identifier,
      sopName: sop.name,
      overallScore: result.overallScore,
      clausesAnalyzed: result.totalGuidelinesChecked,
      guidelineDocumentsUsed: guidelines.length,
      guidelineIds: guidelines.map((g) => g._id.toString()),
      runAt: new Date(),
    },
    { upsert: true, returnDocument: 'after' },
  );

  return { result, report };
}

export async function getGuidelineStats() {
  await connectDB();
  const [guidelines, reports] = await Promise.all([
    SOPGuideline.find({ ocrStatus: "completed" }).select("name folderName").lean(),
    ComplianceReport.find({ analysisStatus: "completed" })
      .select("findings sopIdentifier")
      .lean(),
  ]);

  const stats: Record<
    string,
    {
      folderName: string;
      totalFindings: number;
      compliantCount: number;
      partialCount: number;
      nonCompliantCount: number;
      notApplicableCount: number;
      sopCount: number;
    }
  > = {};

  for (const g of guidelines) {
    const relatedFindings = reports.flatMap((r) =>
      (r.findings ?? []).filter(
        (f: { guidelineName?: string }) => f.guidelineName === g.name,
      ),
    );
    const sopCount = new Set(
      reports
        .filter((r) =>
          (r.findings ?? []).some(
            (f: { guidelineName?: string }) => f.guidelineName === g.name,
          ),
        )
        .map((r) => r.sopIdentifier),
    ).size;

    stats[g.name] = {
      folderName: g.folderName,
      totalFindings: relatedFindings.length,
      compliantCount: relatedFindings.filter(
        (f: { complianceLevel?: string }) => f.complianceLevel === "compliant",
      ).length,
      partialCount: relatedFindings.filter(
        (f: { complianceLevel?: string }) => f.complianceLevel === "partial",
      ).length,
      nonCompliantCount: relatedFindings.filter(
        (f: { complianceLevel?: string }) => f.complianceLevel === "non-compliant",
      ).length,
      notApplicableCount: relatedFindings.filter(
        (f: { complianceLevel?: string }) => f.complianceLevel === "not-applicable",
      ).length,
      sopCount,
    };
  }

  return stats;
}
