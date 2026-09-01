import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import { findMcqGenJob, updateMcqGenJob } from "@/lib/mcq-gen-job-store";
// Live progress for an MCQ generation/regeneration run. Polled by the MCQ Bank
// client while a row is generating. Returns 404 when no run has been started for
// the identifier (the client treats that as "idle").
export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const identifier = request.nextUrl.searchParams.get("identifier")?.trim();
    if (!identifier) {
      return NextResponse.json({ error: "identifier is required" }, { status: 400 });
    }

    const job = await findMcqGenJob(identifier);
    if (!job) {
      return NextResponse.json({ error: "No generation job found" }, { status: 404 });
    }

    // Heal stuck jobs: cancel was requested but status never flipped (orphaned after server restart).
    let status = job.status;
    if (job.cancelRequested && (status === "running" || status === "queued")) {
      status = "cancelled";
      await updateMcqGenJob(identifier, {
        status: "cancelled",
        phase: job.phase?.includes("Stop") ? job.phase : "Stopped by user",
        error: job.error ?? "Generation stopped",
        finishedAt: job.finishedAt ?? new Date(),
      });
    }
    // Status poll is read-only — never mark jobs failed here (that raced active runs).

    return NextResponse.json({
      identifier: job.identifier,
      mode: job.mode,
      languageScope: job.languageScope ?? null,
      status,
      cancelRequested: Boolean(job.cancelRequested),
      awaitingLocalWorker: Boolean(job.awaitingLocalWorker),
      phase: job.phase,
      percent: job.percent,
      languages: job.languages,
      totalInserted: job.totalInserted,
      totalSkipped: job.totalSkipped,
      totalFailedBatches: job.totalFailedBatches,
      error: job.error ?? null,
      logs: job.logs ?? [],
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load status" },
      { status: 500 },
    );
  }
}
