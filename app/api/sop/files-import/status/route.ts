import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SopFilesImportJob from "@/models/SopFilesImportJob";
import { requireAuth } from "@/lib/withAuth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const jobId = request.nextUrl.searchParams.get("jobId");

    const job = jobId
      ? await SopFilesImportJob.findById(jobId).lean()
      : await SopFilesImportJob.findOne().sort({ createdAt: -1 }).lean();

    if (!job) {
      return NextResponse.json({ job: null });
    }

    return NextResponse.json({
      job: {
        id: job._id.toString(),
        status: job.status,
        phase: job.phase,
        percent: job.percent,
        totals: job.totals,
        files: job.files,
        error: job.error,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      },
    });
  } catch (error) {
    console.error("files-import status error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Status failed" },
      { status: 500 },
    );
  }
}
