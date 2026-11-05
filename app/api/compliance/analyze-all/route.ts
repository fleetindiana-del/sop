import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import SOPGuideline from "@/models/SOPGuideline";
import ComplianceReport from "@/models/ComplianceReport";
import { analyzeSOPComplianceV3 } from "@/lib/complianceEngineV3";
import { saveComplianceReport } from "@/lib/complianceReportStorage";
import { getGroupedRegistryRows } from "@/lib/dashboardRegistrySource";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

export const maxDuration = 300;

async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const { department, limit = 50, forceRefresh = false } = body;

    const grouped = await getGroupedRegistryRows();
    let activeFamilies = grouped.filter((s) => !s.isObsolete);
    if (department) activeFamilies = activeFamilies.filter((s) => s.department === department);
    const targetFamilies = activeFamilies.slice(0, limit);

    const allSops = await SOP.find({ _id: { $in: targetFamilies.map((s) => s.id) } }).lean();

    const guidelines = await SOPGuideline.find({ ocrStatus: "completed" })
      .select("name folderName pdfName clauses.clauseNumber clauses.clauseTitle clauses.clauseText")
      .lean();
    if (!guidelines.length) {
      return NextResponse.json(
        { success: false, error: "No guidelines found. Upload guideline PDFs in Step 2 first." },
        { status: 400 },
      );
    }

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

    const existingMap: Map<string, boolean> = new Map();
    if (!forceRefresh) {
      const existingReports = await ComplianceReport.find({
        sopId: { $in: allSops.map((s) => s._id) },
        analysisStatus: "completed",
      })
        .select("sopId")
        .lean();
      for (const r of existingReports) {
        existingMap.set(r.sopId.toString(), true);
      }
    }

    const sopsToAnalyze = forceRefresh
      ? allSops
      : allSops.filter((s) => !existingMap.has(s._id.toString()));

    const results = {
      total: allSops.length,
      toAnalyze: sopsToAnalyze.length,
      cached: allSops.length - sopsToAnalyze.length,
      completed: 0,
      failed: 0,
    };

    for (const sop of sopsToAnalyze) {
      try {
        const result = await analyzeSOPComplianceV3({
          sopIdentifier: sop.identifier,
          sopName: sop.name,
          department: sop.department,
          sopContent: sop.content,
          guidelineClauses,
        });

        await saveComplianceReport({
          sopId: sop._id.toString(),
          sopIdentifier: sop.identifier,
          sopName: sop.name,
          sopVersion: sop.version ?? "1.0",
          department: sop.department,
          findings: result.findings,
          overallScore: result.overallScore,
          complianceStatus: result.complianceStatus,
        });

        results.completed++;
      } catch {
        results.failed++;
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Bulk analysis failed" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
