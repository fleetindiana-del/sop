import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/withAuth";
import { requestMcqGenerationCancelAll } from "@/lib/mcq-generation";
import { withActivityLog } from "@/lib/activity-log";

/** POST /api/sop/generate-mcqs/cancel-all — emergency stop for all in-flight MCQ jobs. */
async function handlePOST() {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const stopped = await requestMcqGenerationCancelAll();
    return NextResponse.json({ success: true, stopped });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to stop all jobs" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
