import { NextRequest, NextResponse } from "next/server";
import { relinkBunnyVersionFiles } from "@/lib/relink-bunny-versions";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    const body = await request.json().catch(() => ({}));
    const result = await relinkBunnyVersionFiles({
      department: typeof body?.department === "string" ? body.department : undefined,
      refreshIndex: body?.refreshIndex === true,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to relink Bunny files" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
