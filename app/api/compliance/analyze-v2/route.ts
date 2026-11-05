import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import SOPGuideline from "@/models/SOPGuideline";
import { analyzeSOPComplianceV2 } from "@/lib/complianceEngineV2";
import { saveComplianceReport } from "@/lib/complianceReportStorage";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

export const maxDuration = 300;

async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const { sopId } = body;

    if (!sopId) {
      return NextResponse.json({ success: false, error: "sopId is required" }, { status: 400 });
    }

    const sop = await SOP.findById(sopId).lean();
    if (!sop) return NextResponse.json({ success: false, error: "SOP not found" }, { status: 404 });

    const guidelines = await SOPGuideline.find({ ocrStatus: "completed" })
      .select("name folderName pdfName clauses.clauseNumber clauses.clauseTitle clauses.clauseText")
      .lean();
    if (!guidelines.length) {
      return NextResponse.json(
        { success: false, error: "No guidelines found. Upload guideline PDFs in Step 2 first." },
        { status: 404 },
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

    const result = await analyzeSOPComplianceV2({
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

    return NextResponse.json({
      success: true,
      sopIdentifier: sop.identifier,
      overallScore: result.overallScore,
      complianceStatus: result.complianceStatus,
      totalGuidelinesChecked: result.totalGuidelinesChecked,
      processingTimeMs: result.processingTimeMs,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Analysis failed" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
