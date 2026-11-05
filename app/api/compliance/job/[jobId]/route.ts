import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import ComplianceAnalysisJob from "@/models/ComplianceAnalysisJob";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { jobId } = await params;
    const job = await ComplianceAnalysisJob.findOne({ jobId }).lean();

    if (!job) {
      return NextResponse.json({ success: false, error: "Job not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, job });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to fetch job" },
      { status: 500 },
    );
  }
}

async function handleDELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { jobId } = await params;
    await ComplianceAnalysisJob.findOneAndDelete({ jobId });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to delete job" },
      { status: 500 },
    );
  }
}

export const DELETE = withActivityLog(handleDELETE);
