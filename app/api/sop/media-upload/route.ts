import { NextRequest, NextResponse } from "next/server";
import { processMediaUpload } from "@/lib/media-upload";
import { requireAuth } from "@/lib/withAuth";
import { actorFromSession, runWithAuditActor } from "@/lib/audit-log";
import { withActivityLog } from "@/lib/activity-log";

async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const formData = await request.formData();
    const data = await runWithAuditActor(actorFromSession(auth.session, request), () =>
      processMediaUpload(formData),
    );
    return NextResponse.json(data);
  } catch (error) {
    console.error("Media upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Media upload failed" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
