import mongoose from "mongoose";
import ComplianceGapFinding, {
  type ComplianceGapStatus,
  type GapType,
  type IComplianceGapFinding,
  type ResolutionStatus,
} from "@/models/ComplianceGapFinding";
import type { ComplianceFinding } from "@/lib/complianceEngine";
import {
  dedupeFindings,
  deriveRootCauseKey,
} from "@/lib/complianceClassification";
import {
  deriveGapId,
  hashGuidelineRequirement,
  hashSopContent,
} from "@/lib/compliance-hashes";
import {
  extractSectionText,
  getSectionHash,
  type SectionHashEntry,
  type CachedParsedSop,
} from "@/lib/compliance-sop-cache";

function mapComplianceLevel(level: ComplianceFinding["complianceLevel"]): ComplianceGapStatus {
  switch (level) {
    case "compliant":
      return "fully-compliant";
    case "partial":
      return "partially-compliant";
    case "non-compliant":
      return "non-compliant";
    case "not-applicable":
      return "not-applicable";
    default:
      return "improvement-opportunity";
  }
}

function mapGapType(finding: ComplianceFinding): GapType {
  if (finding.findingCategory === "Improvement Opportunity") return "improvement-opportunity";
  if (finding.complianceLevel === "partial") return "partial-requirement";
  if (finding.complianceLevel === "non-compliant") return "missing-requirement";
  if (/contradict/i.test(finding.mismatchExplanation ?? "")) return "contradiction";
  if (/ambigu/i.test(finding.mismatchExplanation ?? "")) return "ambiguous-statement";
  return "missing-requirement";
}

function isActionableGap(f: ComplianceFinding): boolean {
  return (
    f.complianceLevel === "partial" ||
    f.complianceLevel === "non-compliant" ||
    f.findingCategory === "Improvement Opportunity"
  );
}

export type PersistFindingsInput = {
  sopId: string;
  reportId?: string;
  findings: ComplianceFinding[];
  structure: CachedParsedSop;
};

export type PersistFindingsResult = {
  persisted: number;
  skipped: number;
  merged: number;
  gapIds: string[];
};

function toGapRecord(
  finding: ComplianceFinding,
  input: PersistFindingsInput,
  sectionHashes: SectionHashEntry[],
): Omit<IComplianceGapFinding, keyof mongoose.Document | "createdAt" | "updatedAt"> {
  const rootCauseKey = finding.rootCauseKey || deriveRootCauseKey(finding);
  const sopSection = finding.sopSectionAffected || "General";
  const requirementHash = hashGuidelineRequirement(
    finding.guidelineRequirement || finding.clauseTitle,
    finding.clauseNumber,
  );
  const sectionHash =
    getSectionHash(sectionHashes, sopSection) ??
    hashSopContent(finding.sopTextSnippet || extractSectionText(input.structure.parsed, sopSection));
  const gapId = deriveGapId(input.sopId, rootCauseKey || requirementHash, sopSection, requirementHash);

  const impact = finding.impactAnalysis ?? "";
  const operationalRisk = /operational|routine|day-to-day/i.test(impact) ? impact : "";
  const auditRisk = /audit|inspection|regulator/i.test(impact) ? impact : impact;

  return {
    gapId,
    sopId: new mongoose.Types.ObjectId(input.sopId),
    reportId: input.reportId ? new mongoose.Types.ObjectId(input.reportId) : undefined,
    guidelineId: finding.guidelineId ? new mongoose.Types.ObjectId(finding.guidelineId) : undefined,
    guidelineName: finding.guidelineName ?? "",
    folderName: finding.folderName,
    guidelineSection: finding.clauseNumber,
    guidelineSectionTitle: finding.clauseTitle,
    guidelineRequirement: finding.guidelineRequirement || finding.clauseTitle,
    sopSection,
    sopSectionText: finding.sopTextSnippet || extractSectionText(input.structure.parsed, sopSection),
    complianceStatus: mapComplianceLevel(finding.complianceLevel),
    severity: finding.issueSeverity ?? "minor",
    gapType: mapGapType(finding),
    gapExplanation: finding.mismatchExplanation ?? "",
    impactAnalysis: finding.impactAnalysis,
    operationalRisk: operationalRisk || undefined,
    auditRisk: auditRisk || undefined,
    recommendedAction: finding.suggestedAction ?? "",
    proposedVerbiage: finding.suggestedText ?? "",
    confidenceScore: finding.matchConfidence ?? 70,
    evidenceGuidelineQuote: finding.guidelineRequirement ?? "",
    evidenceSopQuote: finding.sopTextSnippet ?? finding.evidenceFound ?? "",
    sopTextHash: sectionHash,
    requirementHash,
    rootCauseKey: rootCauseKey || undefined,
    mergedClauseRefs: finding.mergedClauseRefs,
    resolved: false,
    resolutionStatus: "open" as ResolutionStatus,
    identifiedAt: new Date(),
    lastReviewedAt: new Date(),
  };
}

/**
 * Persist deduplicated gap findings. Skips regeneration when the SOP section hash
 * is unchanged for an existing open finding with the same gapId.
 */
export async function persistComplianceFindings(
  input: PersistFindingsInput,
): Promise<PersistFindingsResult> {
  const actionable = input.findings.filter(isActionableGap);
  const deduped = dedupeFindings(actionable);
  const mergedCount = actionable.length - deduped.length;

  let persisted = 0;
  let skipped = 0;
  const gapIds: string[] = [];

  for (const finding of deduped) {
    const record = toGapRecord(finding, input, input.structure.sectionHashes);
    gapIds.push(record.gapId);

    const existing = await ComplianceGapFinding.findOne({ gapId: record.gapId }).lean();

    if (existing && !existing.resolved && existing.sopTextHash === record.sopTextHash) {
      skipped++;
      await ComplianceGapFinding.updateOne(
        { gapId: record.gapId },
        { $set: { lastReviewedAt: new Date(), reportId: record.reportId } },
      );
      continue;
    }

    if (existing) {
      await ComplianceGapFinding.updateOne(
        { gapId: record.gapId },
        {
          $set: {
            ...record,
            resolved: existing.resolved && record.sopTextHash === existing.sopTextHash,
            resolvedAt: existing.resolvedAt,
            resolutionStatus:
              existing.resolved && record.sopTextHash === existing.sopTextHash
                ? existing.resolutionStatus
                : "open",
            identifiedAt: existing.identifiedAt,
            lastReviewedAt: new Date(),
          },
        },
      );
    } else {
      await ComplianceGapFinding.create(record);
    }
    persisted++;
  }

  return { persisted, skipped, merged: mergedCount, gapIds };
}

export async function getGapFindingsForSop(sopId: string, opts?: { unresolvedOnly?: boolean }) {
  const query: Record<string, unknown> = {
    sopId: new mongoose.Types.ObjectId(sopId),
  };
  if (opts?.unresolvedOnly) query.resolved = false;
  return ComplianceGapFinding.find(query).sort({ severity: 1, identifiedAt: -1 }).lean();
}

export async function updateGapResolution(
  gapId: string,
  update: {
    resolved?: boolean;
    resolutionStatus?: ResolutionStatus;
    proposedVerbiage?: string;
  },
) {
  const $set: Record<string, unknown> = { lastReviewedAt: new Date() };
  if (update.resolved !== undefined) {
    $set.resolved = update.resolved;
    if (update.resolved) $set.resolvedAt = new Date();
  }
  if (update.resolutionStatus) $set.resolutionStatus = update.resolutionStatus;
  if (update.proposedVerbiage) $set.proposedVerbiage = update.proposedVerbiage;

  return ComplianceGapFinding.findOneAndUpdate({ gapId }, { $set }, { returnDocument: 'after' }).lean();
}

export async function attachGapIdsToReportFindings(
  sopId: string,
  reportFindings: ComplianceFinding[],
): Promise<(ComplianceFinding & { gapId?: string; resolved?: boolean; lastReviewedAt?: Date })[]> {
  const gaps = await getGapFindingsForSop(sopId);
  const byClause = new Map(gaps.map((g) => [`${g.guidelineSection}::${g.guidelineName}`, g]));

  return reportFindings.map((f) => {
    const key = `${f.clauseNumber}::${f.guidelineName ?? ""}`;
    const gap = byClause.get(key);
    if (!gap && !isActionableGap(f)) return f;

    const rootKey = f.rootCauseKey || deriveRootCauseKey(f);
    const match =
      gap ??
      gaps.find(
        (g) =>
          g.rootCauseKey === rootKey &&
          g.sopSection === (f.sopSectionAffected || "General"),
      );

    if (!match) return f;
    return {
      ...f,
      gapId: match.gapId,
      resolved: match.resolved,
      lastReviewedAt: match.lastReviewedAt,
    };
  });
}

export function computeOpenGapScore(
  gaps: Pick<IComplianceGapFinding, "complianceStatus" | "severity" | "resolved">[],
): { score: number; critical: number; major: number; minor: number; improvements: number } {
  let critical = 0;
  let major = 0;
  let minor = 0;
  let improvements = 0;
  let weightedTotal = 0;
  let weightedAchieved = 0;

  for (const g of gaps) {
    if (g.complianceStatus === "not-applicable") continue;
    if (g.complianceStatus === "improvement-opportunity") {
      if (!g.resolved) improvements++;
      continue;
    }
    if (g.complianceStatus === "fully-compliant") continue;

    const weight = g.severity === "critical" ? 5 : g.severity === "major" ? 3 : 1;
    weightedTotal += weight;

    if (g.resolved) weightedAchieved += weight;
    else if (g.complianceStatus === "partially-compliant") weightedAchieved += weight * 0.5;

    if (!g.resolved) {
      if (g.severity === "critical") critical++;
      else if (g.severity === "major") major++;
      else minor++;
    }
  }

  const score =
    weightedTotal > 0 ? Math.round((weightedAchieved / weightedTotal) * 100) / 10 : 10;

  return { score, critical, major, minor, improvements };
}
