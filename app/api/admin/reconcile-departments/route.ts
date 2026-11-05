import { NextRequest, NextResponse } from "next/server";
import { reconcileAllDepartments } from "@/lib/reconcile-departments";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    const body = await request.json().catch(() => ({}));
    const onlyGeneral = body.onlyGeneral !== false;
    const result = await reconcileAllDepartments({ onlyGeneral });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reconcile departments" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
