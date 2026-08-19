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

function pickNewer(a: ReportHit, b: ReportHit): ReportHit {
  return (a.analyzedAt ?? 0) >= (b.analyzedAt ?? 0) ? a : b;
}

function lookupCurrentReport(
  sop: Pick<RegistrySOP, "id">,
  bySopId: Map<string, ReportHit>,
): ReportHit | undefined {
  return bySopId.get(sop.id);
}

function lookupBestPriorReport(
  sop: Pick<RegistrySOP, "id" | "recordIds">,
  bySopId: Map<string, ReportHit>,
): ReportHit | undefined {
  let best: ReportHit | undefined;
  for (const recordId of sop.recordIds) {
    if (recordId === sop.id) continue;
    const hit = bySopId.get(recordId);
    if (!hit) continue;
    best = best ? pickNewer(best, hit) : hit;
  }
  return best;
}

/**
 * Attach current-version compliance fields to grouped registry rows.
 *
 * Join is by the current version's record id only so an older version's report
 * never appears on a newly uploaded revision.
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
    }

    const wizardBySopId = new Map<string, ReportHit>();
    for (const r of wizardResults) {
      const hit: ReportHit = {
        overallScore: r.overallScore ?? 0,
        analyzedAt: r.runAt ? new Date(r.runAt).getTime() : 0,
      };
      keepBest(wizardBySopId, r.sopId?.toString(), hit);
    }

    const mergedBySopId = new Map<string, ReportHit>();
    for (const [sopId, hit] of reportsBySopId) {
      mergedBySopId.set(sopId, hit);
    }
    for (const [sopId, hit] of wizardBySopId) {
      const existing = mergedBySopId.get(sopId);
      mergedBySopId.set(sopId, existing ? pickNewer(existing, hit) : hit);
    }

    return rows.map((sop) => {
      const report = lookupCurrentReport(sop, mergedBySopId);
      const analyzed = Boolean(report);
      const score = analyzed ? report!.overallScore : 0;
      const done = analyzed && score >= COMPLIANCE_PASS_SCORE;
      const priorReport = lookupBestPriorReport(sop, mergedBySopId);
      const priorFailed =
        Boolean(priorReport) && priorReport!.overallScore < COMPLIANCE_PASS_SCORE;
      const bypassed =
        !analyzed && hasUploadedPriorVersion(sop) && priorFailed;
      return {
        ...sop,
        complianceScore: analyzed ? score : 0,
        complianceReportId: report?.id,
        complianceAnalyzed: analyzed,
        complianceDone: done,
        complianceBypassed: bypassed,
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
