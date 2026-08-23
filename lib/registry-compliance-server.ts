import { connectDB } from "@/lib/mongodb";
import ComplianceReport from "@/models/ComplianceReport";
import SOPGuidelineResult from "@/models/SOPGuidelineResult";
import type { RegistrySOP } from "@/lib/types";
import { COMPLIANCE_PASS_SCORE, isComplianceBypassed } from "@/lib/registry-compliance";
import { normalizeSopIdentifierKey } from "@/lib/sopIdentifierNormalize";

type ReportHit = {
  id?: string;
  overallScore: number;
  analyzedAt?: number;
  identifier?: string;
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

function identifierKey(value?: string): string | undefined {
  if (!value) return undefined;
  const key = normalizeSopIdentifierKey(value);
  return key || undefined;
}

function isCurrentVersionHit(sop: Pick<RegistrySOP, "identifier">, hit: ReportHit): boolean {
  const current = identifierKey(sop.identifier);
  const hitKey = identifierKey(hit.identifier);
  return Boolean(current && hitKey && current === hitKey);
}

/**
 * Current-version report: the primary file id, any sibling file of the same
 * revision (DOCX/PDF, ENG/GUJ), or a report stored under the same SOP code.
 */
function lookupCurrentReport(
  sop: Pick<RegistrySOP, "id" | "identifier">,
  bySopId: Map<string, ReportHit>,
  byIdentifier: Map<string, ReportHit>,
): ReportHit | undefined {
  const byId = bySopId.get(sop.id);
  const key = identifierKey(sop.identifier);
  const byIdent = key ? byIdentifier.get(key) : undefined;
  if (byId && byIdent) return pickNewer(byId, byIdent);
  return byId ?? byIdent;
}

/**
 * Prior-version report only — skip sibling files of the current revision so a
 * failed analysis on the current DOCX is not treated as "prior failed / bypassed".
 */
function lookupBestPriorReport(
  sop: Pick<RegistrySOP, "id" | "identifier" | "recordIds">,
  bySopId: Map<string, ReportHit>,
): ReportHit | undefined {
  let best: ReportHit | undefined;
  for (const recordId of sop.recordIds) {
    if (recordId === sop.id) continue;
    const hit = bySopId.get(recordId);
    if (!hit || isCurrentVersionHit(sop, hit)) continue;
    best = best ? pickNewer(best, hit) : hit;
  }
  return best;
}

/**
 * Attach current-version compliance fields to grouped registry rows.
 *
 * Join is by the current revision (any sibling file or matching SOP code) so an
 * older version's report never appears on a newly uploaded revision.
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
        identifier: r.sopIdentifier,
      };
      keepBest(reportsBySopId, r.sopId?.toString(), hit);
      keepBest(reportsByIdentifier, identifierKey(r.sopIdentifier), hit);
    }

    const wizardBySopId = new Map<string, ReportHit>();
    const wizardByIdentifier = new Map<string, ReportHit>();
    for (const r of wizardResults) {
      const hit: ReportHit = {
        overallScore: r.overallScore ?? 0,
        analyzedAt: r.runAt ? new Date(r.runAt).getTime() : 0,
        identifier: r.sopNo,
      };
      keepBest(wizardBySopId, r.sopId?.toString(), hit);
      keepBest(wizardByIdentifier, identifierKey(r.sopNo), hit);
    }

    const mergedBySopId = new Map<string, ReportHit>();
    for (const [sopId, hit] of reportsBySopId) {
      mergedBySopId.set(sopId, hit);
    }
    for (const [sopId, hit] of wizardBySopId) {
      const existing = mergedBySopId.get(sopId);
      mergedBySopId.set(sopId, existing ? pickNewer(existing, hit) : hit);
    }

    const mergedByIdentifier = new Map<string, ReportHit>();
    for (const [key, hit] of reportsByIdentifier) {
      mergedByIdentifier.set(key, hit);
    }
    for (const [key, hit] of wizardByIdentifier) {
      const existing = mergedByIdentifier.get(key);
      mergedByIdentifier.set(key, existing ? pickNewer(existing, hit) : hit);
    }

    return rows.map((sop) => {
      const report = lookupCurrentReport(sop, mergedBySopId, mergedByIdentifier);
      const analyzed = Boolean(report);
      const score = analyzed ? report!.overallScore : 0;
      const done = analyzed && score >= COMPLIANCE_PASS_SCORE;
      const priorReport = lookupBestPriorReport(sop, mergedBySopId);
      const priorFailed =
        Boolean(priorReport) && priorReport!.overallScore < COMPLIANCE_PASS_SCORE;
      const bypassed = isComplianceBypassed(sop, analyzed, priorFailed);
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
