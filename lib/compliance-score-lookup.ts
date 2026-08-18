import { connectDB } from "@/lib/mongodb";
import ComplianceReport from "@/models/ComplianceReport";
import SOPGuidelineResult from "@/models/SOPGuidelineResult";
import SOP from "@/models/SOP";
import { sopIdentifierMatchFilter } from "@/lib/sopIdentifierNormalize";

/**
 * Look up the best existing compliance score for an SOP (by sopId or identifier).
 * Returns null if no report exists. `bypassed` = has prior versions but no report
 * (i.e. compliance was never run despite the SOP being a revision of an older one).
 */
export async function getExistingComplianceScore(
  sopId: string,
  identifier: string,
): Promise<{ score: number; bypassed: boolean } | null> {
  await connectDB();

  const report = await ComplianceReport.findOne({
    $or: [{ sopId }, { sopIdentifier: identifier }],
    analysisStatus: "completed",
  })
    .sort({ analysisCompletedAt: -1 })
    .select("overallScore")
    .lean();

  if (report) {
    return { score: report.overallScore ?? 0, bypassed: false };
  }

  const wizard = await SOPGuidelineResult.findOne({
    $or: [{ sopId }, { sopNo: identifier }],
  })
    .sort({ runAt: -1 })
    .select("overallScore")
    .lean();

  if (wizard) {
    return { score: wizard.overallScore ?? 0, bypassed: false };
  }

  // No report at all. Check if SOP has prior versions (bypassed).
  const family = await SOP.find({
    ...sopIdentifierMatchFilter(identifier),
    isObsolete: { $ne: true },
  })
    .select("versionNum")
    .lean();

  const hasPrior = family.length > 1;
  if (hasPrior) {
    return { score: 0, bypassed: true };
  }

  return null;
}
