import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import { requestMcqGenerationCancel } from "@/lib/mcq-generation";

// POST /api/sop/generate-mcqs/cancel
// Body: { identifier: string }
export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const identifier = body.identifier?.trim();
    if (!identifier) {
      return NextResponse.json({ error: "identifier is required" }, { status: 400 });
    }

    const cancelled = await requestMcqGenerationCancel(identifier);
    if (!cancelled) {
      return NextResponse.json({ error: "No active generation job to stop" }, { status: 404 });
    }

    return NextResponse.json({ success: true, identifier, status: "stopping" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to stop generation" },
      { status: 500 },
    );
  }
}
