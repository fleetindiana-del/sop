import { NextResponse } from "next/server";
import { clearAllPriorVersionRecords } from "@/lib/clear-prior-versions";
import { requireAuth } from "@/lib/withAuth";
import { actorFromSession, runWithAuditActor } from "@/lib/audit-log";

export async function POST() {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const result = await runWithAuditActor(actorFromSession(auth.session), () =>
      clearAllPriorVersionRecords(),
    );
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to clear prior versions" },
      { status: 500 },
    );
  }
}
