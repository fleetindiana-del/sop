import { NextRequest, NextResponse } from "next/server";
import { processSopUpload } from "@/lib/sop-upload";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

export const maxDuration = 300;

async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const formData = await request.formData();
    return processSopUpload(formData, request);
  } catch (error) {
    console.error("upload-batch error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
