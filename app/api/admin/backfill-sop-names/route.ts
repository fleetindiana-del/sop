import { NextResponse } from "next/server";
import { backfillSopNames } from "@/lib/backfill-sop-names";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

async function handlePOST() {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const result = await backfillSopNames();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Backfill failed" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
