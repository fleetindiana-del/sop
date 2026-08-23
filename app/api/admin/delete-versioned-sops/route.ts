import { NextResponse } from "next/server";
import { deleteVersionedSopFamilies } from "@/lib/delete-versioned-sops";
import { requireAuth } from "@/lib/withAuth";
import { actorFromSession, runWithAuditActor } from "@/lib/audit-log";

export async function POST() {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const result = await runWithAuditActor(actorFromSession(auth.session), () =>
      deleteVersionedSopFamilies(),
    );
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete versioned SOPs" },
      { status: 500 },
    );
  }
}
