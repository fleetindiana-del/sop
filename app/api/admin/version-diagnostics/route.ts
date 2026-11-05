import { NextRequest, NextResponse } from "next/server";
import { buildVersionDiagnostics } from "@/lib/version-diagnostics";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

export const dynamic = "force-dynamic";
// Bunny storage listing can take a while on large zones.
export const maxDuration = 300;

async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    const body = await request.json().catch(() => ({}));
    const report = await buildVersionDiagnostics({
      checkBunny: body?.checkBunny === true,
      department: typeof body?.department === "string" ? body.department : undefined,
    });
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to run version diagnostics" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
