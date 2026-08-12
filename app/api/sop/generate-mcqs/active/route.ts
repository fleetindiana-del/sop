import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import MCQGenJob from "@/models/MCQGenJob";

/** In-flight MCQ generation jobs — used to resume UI polling after page reload. */
export async function GET() {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const jobs = await MCQGenJob.find({
      status: { $in: ["queued", "running"] },
      cancelRequested: { $ne: true },
    })
      .select(
        "identifier mode languageScope status phase percent languages totalInserted totalSkipped totalFailedBatches logs startedAt",
      )
      .sort({ startedAt: -1 })
      .lean();

    return NextResponse.json({
      jobs: jobs.map((j) => ({
        identifier: j.identifier,
        mode: j.mode,
        languageScope: j.languageScope ?? null,
        status: j.status,
        phase: j.phase,
        percent: j.percent,
        languages: j.languages,
        totalInserted: j.totalInserted,
        totalSkipped: j.totalSkipped,
        totalFailedBatches: j.totalFailedBatches,
        logs: j.logs ?? [],
        startedAt: j.startedAt,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load active jobs" },
      { status: 500 },
    );
  }
}
