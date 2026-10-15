import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import { buildPipelineStatusResponse } from "@/lib/pipeline";
import { requireAuth } from "@/lib/withAuth";
import { sopIdentifierEquivalentRegex } from "@/lib/sopIdentifierNormalize";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    const identifier = request.nextUrl.searchParams.get("identifier");
    if (!identifier) {
      return NextResponse.json({ error: "identifier query param required" }, { status: 400 });
    }

    await connectDB();
    const sops = await SOP.find({ identifier: sopIdentifierEquivalentRegex(identifier) }).lean();
    if (!sops.length) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }

    return NextResponse.json(buildPipelineStatusResponse(identifier, sops as never[]));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch pipeline status" },
      { status: 500 },
    );
  }
}
