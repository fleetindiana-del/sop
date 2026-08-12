import { NextRequest, NextResponse } from "next/server";
import { processMediaUpload } from "@/lib/media-upload";
import { requireAuth } from "@/lib/withAuth";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const formData = await request.formData();
    const data = await processMediaUpload(formData);
    return NextResponse.json(data);
  } catch (error) {
    console.error("Media upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Media upload failed" },
      { status: 500 },
    );
  }
}
