import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import RecheckRun from "@/models/RecheckRun";
import { requireAuth } from "@/lib/withAuth";
import { computeRecheckScore } from "@/lib/recheckScore";
import { withActivityLog } from "@/lib/activity-log";

// GET /api/compliance/recheck/history?reportId=...  → runs for a report (newest first)
// GET /api/compliance/recheck/history?runId=...      → single run
export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  await connectDB();
  const { searchParams } = request.nextUrl;
  const reportId = searchParams.get("reportId");
  const runId = searchParams.get("runId");

  if (runId) {
    const run = await RecheckRun.findById(runId).lean();
    if (!run) return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
    return NextResponse.json({ success: true, run });
  }

  if (!reportId) {
    return NextResponse.json({ success: false, error: "reportId or runId is required" }, { status: 400 });
  }

  const runs = await RecheckRun.find({ reportId }).sort({ createdAt: -1 }).lean();
  return NextResponse.json({ success: true, runs });
}

// PATCH — toggle "ignore" on a prior point or a new issue, then recompute score.
// Body: { runId, kind: "point" | "issue", index, ignored }
async function handlePATCH(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  await connectDB();
  const body = await request.json().catch(() => ({}));
  const { runId, kind, index, ignored } = body as {
    runId?: string;
    kind?: "point" | "issue";
    index?: number;
    ignored?: boolean;
  };

  if (!runId || (kind !== "point" && kind !== "issue") || typeof index !== "number") {
    return NextResponse.json({ success: false, error: "runId, kind and index are required" }, { status: 400 });
  }

  const run = await RecheckRun.findById(runId);
  if (!run) return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });

  if (kind === "point") {
    if (!run.results[index]) {
      return NextResponse.json({ success: false, error: "Point not found" }, { status: 404 });
    }
    run.results[index].ignored = !!ignored;
    run.markModified("results");
  } else {
    if (!run.newIssues[index]) {
      return NextResponse.json({ success: false, error: "Issue not found" }, { status: 404 });
    }
    run.newIssues[index].ignored = !!ignored;
    run.markModified("newIssues");
  }

  const { score, verdict, resolvedCount, openCount } = computeRecheckScore(run.results, run.newIssues);
  run.score = score;
  run.verdict = verdict;
  run.resolvedCount = resolvedCount;
  run.openCount = openCount;
  await run.save();

  return NextResponse.json({ success: true, score, verdict, resolvedCount, openCount });
}

export const PATCH = withActivityLog(handlePATCH);
