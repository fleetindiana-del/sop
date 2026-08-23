import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import type { EditSOPPayload } from "@/lib/types";
import {
  applyRegistryUpdate,
  buildEditFormData,
  deleteRegistryGroup,
  markRegistryObsolete,
  reviveRegistryGroup,
  sopFamilyIdentifierRegex,
} from "@/lib/sop-utils";
import { clearImportStateAfterPermanentDelete } from "@/lib/sop-files-import";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { markMcqBanksObsoleteForIdentifier, reviveMcqBanksForIdentifier } from "@/lib/mcq-bank-sync";
import { forbidUnlessDepartmentAccess, requireAuth } from "@/lib/withAuth";
import {
  actorFromSession,
  diffAuditValues,
  logSopAudit,
  snapshotSop,
} from "@/lib/audit-log";

type RouteContext = { params: Promise<{ identifier: string }> };

/**
 * Password that gates the irreversible permanent-delete action. Falls back to a
 * shared default when no environment override is configured.
 */
const PERMANENT_DELETE_PASSWORD = process.env.SOP_DELETE_PASSWORD ?? "indiana132";

async function loadGroup(identifier: string) {
  await connectDB();
  return SOP.find({ identifier: sopFamilyIdentifierRegex(identifier) });
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    const { identifier } = await context.params;
    const group = await loadGroup(decodeURIComponent(identifier));
    if (!group.length) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }
    const denied = forbidUnlessDepartmentAccess(
      auth.session.user.role,
      auth.session.user.department,
      group[0].department,
    );
    if (denied) return denied;
    return NextResponse.json(buildEditFormData(group));
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
    const { identifier } = await context.params;
    const group = await loadGroup(decodeURIComponent(identifier));
    if (!group.length) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }

    const body = (await request.json()) as EditSOPPayload;
    if (!body.name?.trim() || !body.department?.trim() || !body.identifier?.trim()) {
      return NextResponse.json(
        { error: "Name, department, and SOP number are required" },
        { status: 400 },
      );
    }

    const previous = snapshotSop(group[0]);
    await applyRegistryUpdate(group, body);
    invalidateDashboardSopsCache();
    const refreshed = await loadGroup(body.identifier.trim());
    const after = refreshed[0] ?? group[0];
    const updated = snapshotSop(after);
    const diff = diffAuditValues(previous, updated);
    await logSopAudit({
      actor: actorFromSession(auth.session, request),
      action: "updated",
      sop: after,
      previous,
      updated,
      comments: diff.fieldsChanged.length
        ? `Edited registry fields: ${diff.fieldsChanged.join(", ")}`
        : "Registry saved",
    });
    return NextResponse.json(buildEditFormData(refreshed));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update SOP" },
      { status: 500 },
    );
  }
}

// Revive an obsolete SOP family — move it back to the active registry.
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const { identifier } = await context.params;
    const group = await loadGroup(decodeURIComponent(identifier));
    if (!group.length) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }

    const previous = snapshotSop(group[0]);
    await reviveRegistryGroup(group);
    await reviveMcqBanksForIdentifier(group[0].identifier);
    invalidateDashboardSopsCache();
    const revived = { ...group[0].toObject(), isObsolete: false, obsoleteReason: undefined };
    await logSopAudit({
      actor: actorFromSession(auth.session, request),
      action: "restored",
      sop: revived,
      previous,
      updated: snapshotSop(revived),
    });
    return NextResponse.json({ success: true, revived: true, identifier: group[0].identifier });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to revive SOP" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  // `?permanent=1` removes the family outright; otherwise it is merely marked
  // obsolete. The permanent path is gated by a password sent in the request
  // header so an accidental click can't destroy records.
  const permanent = request.nextUrl.searchParams.get("permanent") === "1";

  try {
    const { identifier } = await context.params;
    const group = await loadGroup(decodeURIComponent(identifier));
    if (!group.length) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }

    if (permanent) {
      const password = request.headers.get("x-confirm-password") ?? "";
      if (password !== PERMANENT_DELETE_PASSWORD) {
        return NextResponse.json(
          { error: "Incorrect password. SOP was not deleted." },
          { status: 403 },
        );
      }

      const identifiers = [...new Set(group.map((r) => r.identifier).filter(Boolean))];
      const checksums = [
        ...new Set(
          group.flatMap((r) => {
            const docs = Array.isArray(r.sopDocuments) ? r.sopDocuments : [];
            return [
              r.checksum,
              ...docs.map((d: { checksum?: string }) => d?.checksum),
            ].filter((c): c is string => Boolean(c));
          }),
        ),
      ];

      try {
        await clearImportStateAfterPermanentDelete({ identifiers, checksums });
      } catch (err) {
        console.warn("[permanent-delete] import-state cleanup failed:", err);
      }

      await logSopAudit({
        actor: actorFromSession(auth.session, request),
        action: "deleted",
        sop: group[0],
        previous: snapshotSop(group[0]),
        updated: {},
        comments: `Permanently deleted family (${identifiers.join(", ")})`,
      });
      await deleteRegistryGroup(group);
      invalidateDashboardSopsCache();
      return NextResponse.json({ success: true, deleted: true, identifier: group[0].identifier });
    }

    const previous = snapshotSop(group[0]);
    await markRegistryObsolete(group);
    await markMcqBanksObsoleteForIdentifier(group[0].identifier);
    invalidateDashboardSopsCache();
    const obsoleted = {
      ...group[0].toObject(),
      isObsolete: true,
      obsoleteReason: "Moved to Obsolete SOPs",
    };
    await logSopAudit({
      actor: actorFromSession(auth.session, request),
      action: "obsoleted",
      sop: obsoleted,
      previous,
      updated: snapshotSop(obsoleted),
    });
    return NextResponse.json({ success: true, identifier: group[0].identifier });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete SOP" },
      { status: 500 },
    );
  }
}
