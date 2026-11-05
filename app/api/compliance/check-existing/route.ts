import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import ComplianceReport from "@/models/ComplianceReport";
import mongoose from "mongoose";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const sopIds: string[] = body.sopIds ?? [];

    if (!sopIds.length) {
      return NextResponse.json({ success: true, results: {} });
    }

    const objectIds = sopIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const existing = await ComplianceReport.find({ sopId: { $in: objectIds } })
      .select("sopId analysisStatus analyzedAt overallScore complianceStatus")
      .lean();

    const results: Record<
      string,
      { hasReport: boolean; analysisStatus?: string; analyzedAt?: string; overallScore?: number; complianceStatus?: string }
    > = {};

    for (const id of sopIds) {
      results[id] = { hasReport: false };
    }

    for (const r of existing) {
      results[r.sopId.toString()] = {
        hasReport: true,
        analysisStatus: r.analysisStatus,
        analyzedAt: r.analyzedAt?.toISOString(),
        overallScore: r.overallScore,
        complianceStatus: r.complianceStatus,
      };
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to check existing reports" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
