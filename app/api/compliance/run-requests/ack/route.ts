import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import { isComplianceOperator } from "@/lib/page-access";
import { markMatchingRequestsInProgress } from "@/lib/complianceRunRequests";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  if (!isComplianceOperator(auth.session.user.role, auth.session.user.pageAccess)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await connectDB();
    const body = await request.json().catch(() => ({}));
    const sopIds = Array.isArray(body.sopIds)
      ? body.sopIds.map((id: unknown) => String(id))
      : [];
    const identifiers = Array.isArray(body.identifiers)
      ? body.identifiers.map((id: unknown) => String(id))
      : [];
    const updated = await markMatchingRequestsInProgress({ sopIds, identifiers });
    return NextResponse.json({ success: true, updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to acknowledge requests" },
      { status: 500 },
    );
  }
}
