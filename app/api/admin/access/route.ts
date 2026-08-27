import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import User from "@/models/User";
import Department from "@/models/Department";
import SOP from "@/models/SOP";
import { sortByDeptOrder } from "@/lib/sop-utils";
import { isDashboardDepartmentName } from "@/lib/dashboardDepartments";
import { parseAssignedDepartments } from "@/lib/access-control";
import { effectivePageKeys } from "@/lib/page-access";
import { APP_PAGES, sanitizePageAccess } from "@/lib/page-registry";
import { actorFromSession, logUserAudit, snapshotUser } from "@/lib/audit-log";
import type { AppRole } from "@/lib/auth";

type UserAccessRow = {
  _id: mongoose.Types.ObjectId;
  username: string;
  name: string;
  email?: string;
  role: AppRole;
  department?: string;
  designation?: string;
  pageAccess?: string[];
  updatedAt?: Date;
};

function toAccessRow(user: UserAccessRow) {
  return {
    id: user._id.toString(),
    username: user.username,
    name: user.name,
    email: user.email ?? "",
    role: user.role,
    designation: user.designation ?? "",
    departments: parseAssignedDepartments(user.department),
    /** null = never configured, so role defaults apply. */
    pageAccess: Array.isArray(user.pageAccess) ? user.pageAccess : null,
    effectivePages: effectivePageKeys(
      user.role,
      Array.isArray(user.pageAccess) ? user.pageAccess : undefined,
      APP_PAGES,
    ),
    updatedAt: user.updatedAt,
  };
}

async function listDepartments(): Promise<string[]> {
  const [sopDepts, persistedDepts] = await Promise.all([
    SOP.distinct("department") as Promise<string[]>,
    Department.distinct("name") as Promise<string[]>,
  ]);
  return sortByDeptOrder(
    [...new Set([...sopDepts, ...persistedDepts])].filter(isDashboardDepartmentName),
  );
}

// GET /api/admin/access — every user plus the page and department catalogues.
// `requireAuth(["admin"])` admits SOP Admin too — see `roleSatisfies`.
export async function GET() {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const [users, departments] = await Promise.all([
      User.find({}).select("-passwordHash").sort({ role: 1, username: 1 }).lean<UserAccessRow[]>(),
      listDepartments(),
    ]);

    return NextResponse.json({
      success: true,
      users: users.map(toAccessRow),
      pages: APP_PAGES,
      departments,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load access data" },
      { status: 500 },
    );
  }
}

// PATCH /api/admin/access — update one user's page and department access.
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const userId = String(body.userId || "");

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
    }

    const user = await User.findById(userId);
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const previous = snapshotUser(user);

    // A SOP Admin may configure everyone below it, but not a Super Admin —
    // otherwise the lower tier could strip the higher one's pages.
    if (user.role === "admin" && auth.session?.user?.role !== "admin") {
      return NextResponse.json(
        { error: "Only a Super Admin can change another Super Admin's access" },
        { status: 403 },
      );
    }

    // Mongoose will not persist `undefined`, so a reset needs an explicit $unset.
    let unsetPageAccess = false;

    if (body.pageAccess !== undefined) {
      if (body.pageAccess === null) {
        unsetPageAccess = true;
      } else if (Array.isArray(body.pageAccess)) {
        user.pageAccess = sanitizePageAccess(body.pageAccess, user.role);
      } else {
        return NextResponse.json({ error: "pageAccess must be an array or null" }, { status: 400 });
      }
    }

    if (body.departments !== undefined) {
      if (!Array.isArray(body.departments)) {
        return NextResponse.json({ error: "departments must be an array" }, { status: 400 });
      }
      const valid = new Set((await listDepartments()).map((d) => d.toLowerCase()));
      const requested = [
        ...new Set(body.departments.map((d: unknown) => String(d || "").trim()).filter(Boolean)),
      ] as string[];
      // Report unknown names instead of dropping them: silently saving a subset
      // looks like the change applied when it did not.
      const unknown = requested.filter((d) => !valid.has(d.toLowerCase()));
      if (unknown.length) {
        return NextResponse.json(
          { error: `Unknown department(s): ${unknown.join(", ")}` },
          { status: 400 },
        );
      }
      user.department = requested.length ? requested.join(", ") : undefined;
    }

    await user.save();

    if (unsetPageAccess) {
      await User.updateOne({ _id: user._id }, { $unset: { pageAccess: 1 } });
    }

    const saved = user.toObject() as UserAccessRow;
    if (unsetPageAccess) delete saved.pageAccess;

    await logUserAudit({
      actor: actorFromSession(auth.session, request),
      action: "updated",
      user: saved,
      previous,
      comments: "Access Management",
    });

    return NextResponse.json({ success: true, user: toAccessRow(saved) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update access" },
      { status: 500 },
    );
  }
}
