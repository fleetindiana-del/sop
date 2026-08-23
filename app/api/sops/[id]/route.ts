import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { markMcqBanksObsoleteForIdentifier } from "@/lib/mcq-bank-sync";
import { forbidUnlessDepartmentAccess, requireAuth } from "@/lib/withAuth";
import { actorFromSession, logSopAudit, snapshotSop } from "@/lib/audit-log";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    const { id } = await context.params;
    await connectDB();
    const sop = await SOP.findById(id).lean();
    if (!sop) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }
    const denied = forbidUnlessDepartmentAccess(
      auth.session.user.role,
      auth.session.user.department,
      (sop as { department?: string }).department,
    );
    if (denied) return denied;
    return NextResponse.json(sop);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch SOP" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const { id } = await context.params;
    await connectDB();
    const before = await SOP.findById(id).lean();
    if (!before) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }
    const body = await request.json();
    const sop = await SOP.findByIdAndUpdate(id, body, { returnDocument: 'after' }).lean();
    if (!sop) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }
    invalidateDashboardSopsCache();
    await logSopAudit({
      actor: actorFromSession(auth.session, request),
      action: "updated",
      sop,
      previous: snapshotSop(before),
      updated: snapshotSop(sop),
    });
    return NextResponse.json(sop);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update SOP" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const { id } = await context.params;
    await connectDB();
    const sop = await SOP.findById(id);
    if (!sop) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }

    const now = new Date();
    const previous = snapshotSop(sop);
    await sop.updateOne({
      isObsolete: true,
      obsoleteAt: now,
      obsoleteReason: "Moved to Obsolete SOPs",
    });
    await markMcqBanksObsoleteForIdentifier(sop.identifier);
    invalidateDashboardSopsCache();
    const obsoleted = { ...sop.toObject(), isObsolete: true, obsoleteReason: "Moved to Obsolete SOPs" };
    await logSopAudit({
      actor: actorFromSession(auth.session, request),
      action: "obsoleted",
      sop: obsoleted,
      previous,
      updated: snapshotSop(obsoleted),
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete SOP" },
      { status: 500 },
    );
  }
}
