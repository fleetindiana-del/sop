import { connectDB } from "@/lib/mongodb";
import ComplianceReport from "@/models/ComplianceReport";
import SOPGuidelineResult from "@/models/SOPGuidelineResult";
import type { RegistrySOP } from "@/lib/types";
import { COMPLIANCE_PASS_SCORE, hasUploadedPriorVersion } from "@/lib/registry-compliance";

type ReportHit = {
  id?: string;
  overallScore: number;
  analyzedAt?: number;
};

function keepBest(map: Map<string, ReportHit>, key: string | undefined, hit: ReportHit) {
  if (!key) return;
  const existing = map.get(key);
  if (!existing || (hit.analyzedAt ?? 0) > (existing.analyzedAt ?? 0)) {
    map.set(key, hit);
  }
}

function lookupReport(
  sop: Pick<RegistrySOP, "id" | "identifier">,
  bySopId: Map<string, ReportHit>,
  byIdentifier: Map<string, ReportHit>,
): ReportHit | undefined {
  return bySopId.get(sop.id) ?? byIdentifier.get(sop.identifier);
}

/**
 * Attach current-version compliance fields to grouped registry rows.
 *
 * Join is by the current version only (`row.id` / `row.identifier`) so an older
 * version's report never appears on a newly uploaded revision.
 */
export async function attachRegistryCompliance(rows: RegistrySOP[]): Promise<RegistrySOP[]> {
  if (rows.length === 0) return rows;

  try {
    await connectDB();

    const [reports, wizardResults] = await Promise.all([
      ComplianceReport.find({ analysisStatus: "completed" })
        .select("_id sopId sopIdentifier overallScore analysisCompletedAt analyzedAt")
        .lean(),
      SOPGuidelineResult.find({}).select("sopId sopNo overallScore runAt").lean(),
    ]);

    const reportsBySopId = new Map<string, ReportHit>();
    const reportsByIdentifier = new Map<string, ReportHit>();
    for (const r of reports) {
      const hit: ReportHit = {
        id: r._id.toString(),
        overallScore: r.overallScore ?? 0,
        analyzedAt: r.analysisCompletedAt
          ? new Date(r.analysisCompletedAt).getTime()
          : r.analyzedAt
            ? new Date(r.analyzedAt).getTime()
            : 0,
      };
      keepBest(reportsBySopId, r.sopId?.toString(), hit);
      keepBest(reportsByIdentifier, r.sopIdentifier, hit);
    }

    const wizardBySopId = new Map<string, ReportHit>();
    const wizardByIdentifier = new Map<string, ReportHit>();
    for (const r of wizardResults) {
      const hit: ReportHit = {
        overallScore: r.overallScore ?? 0,
        analyzedAt: r.runAt ? new Date(r.runAt).getTime() : 0,
      };
      keepBest(wizardBySopId, r.sopId?.toString(), hit);
      keepBest(wizardByIdentifier, r.sopNo, hit);
    }

    return rows.map((sop) => {
      const report =
        lookupReport(sop, reportsBySopId, reportsByIdentifier) ??
        lookupReport(sop, wizardBySopId, wizardByIdentifier);
      const analyzed = Boolean(report);
      const score = analyzed ? report!.overallScore : 0;
      const done = analyzed && score >= COMPLIANCE_PASS_SCORE;
      return {
        ...sop,
        complianceScore: analyzed ? score : 0,
        complianceReportId: report?.id,
        complianceAnalyzed: analyzed,
        complianceDone: done,
        complianceBypassed: !analyzed && hasUploadedPriorVersion(sop),
      };
    });
  } catch (err) {
    console.warn("attachRegistryCompliance:", err);
    return rows.map((sop) => ({
      ...sop,
      complianceAnalyzed: sop.complianceAnalyzed ?? false,
      complianceDone: sop.complianceDone ?? false,
      complianceBypassed: sop.complianceBypassed ?? false,
    }));
  }
}
