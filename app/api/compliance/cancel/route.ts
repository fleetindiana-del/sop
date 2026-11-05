import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/withAuth";
import {
  listActiveComplianceRunIds,
  requestComplianceRunStop,
  requestStopAllComplianceRuns,
} from "@/lib/compliance-run-control";
import { killOrphanComplianceCodexProcesses } from "@/lib/compliance-process-kill";
import { withActivityLog } from "@/lib/activity-log";

/** POST /api/compliance/cancel — stop compliance analysis (one SOP or all). */
async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    const body = await request.json().catch(() => ({}));
    const stopAll = body.stopAll === true || body.sopId === "all" || body.sopId === "*";
    const sopId = typeof body.sopId === "string" ? body.sopId.trim() : "";

    if (stopAll || !sopId) {
      const n = requestStopAllComplianceRuns();
      const killed = await killOrphanComplianceCodexProcesses();
      return NextResponse.json({
        success: true,
        stopAll: true,
        inProcessRuns: n,
        activeBefore: listActiveComplianceRunIds(),
        orphanCodexKilled: killed,
        status: "stopping",
      });
    }

    const stopped = requestComplianceRunStop(sopId);
    const killed = await killOrphanComplianceCodexProcesses();
    if (!stopped && killed === 0) {
      return NextResponse.json(
        { success: false, error: "No active compliance analysis to stop" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      sopId,
      orphanCodexKilled: killed,
      status: "stopping",
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to stop analysis" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
