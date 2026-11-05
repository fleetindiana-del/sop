import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import ComplianceReport from "@/models/ComplianceReport";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const department = request.nextUrl.searchParams.get("department");
    const status = request.nextUrl.searchParams.get("status");

    const query: Record<string, unknown> = { analysisStatus: "completed" };
    if (department && department !== "Total") query.department = department;

    const reports = await ComplianceReport.find(query)
      .sort({ analyzedAt: -1 })
      .select("sopIdentifier sopName department findings analyzedAt overallScore complianceStatus")
      .lean();

    let findings = reports.flatMap((r) =>
      (r.findings ?? []).map((f) => ({
        ...(f as unknown as Record<string, unknown>),
        sopIdentifier: r.sopIdentifier,
        sopName: r.sopName,
        department: r.department,
        overallScore: r.overallScore,
        analyzedAt: r.analyzedAt,
      })),
    ) as Array<Record<string, unknown>>;

    if (status && status !== "All") {
      findings = findings.filter(
        (f) => f.complianceLevel === status || f.complianceLevel === status.toLowerCase(),
      );
    }

    const summary = {
      total: findings.length,
      compliant: findings.filter((f) => f.complianceLevel === "compliant").length,
      partial: findings.filter((f) => f.complianceLevel === "partial").length,
      nonCompliant: findings.filter((f) => f.complianceLevel === "non-compliant").length,
      notApplicable: findings.filter((f) => f.complianceLevel === "not-applicable").length,
    };

    return NextResponse.json({ findings, summary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch findings" },
      { status: 500 },
    );
  }
}

async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { reportId, findingIds } = await request.json();

    if (!reportId) {
      return NextResponse.json({ success: false, error: "reportId is required" }, { status: 400 });
    }

    const report = await ComplianceReport.findById(reportId).lean();
    if (!report) {
      return NextResponse.json({ success: false, error: "Report not found" }, { status: 404 });
    }

    const idsToMark: string[] = Array.isArray(findingIds) ? findingIds : [];

    return NextResponse.json({
      success: true,
      reportId,
      markedFindings: idsToMark.length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process findings" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
