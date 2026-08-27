import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import Department from "@/models/Department";
import { sortByDeptOrder } from "@/lib/sop-utils";
import { isDashboardDepartmentName } from "@/lib/dashboardDepartments";
import {
  isDeptScopedRole,
  parseAssignedDepartments,
  requireAuth,
} from "@/lib/withAuth";
import { actorFromSession, logAuditEvent } from "@/lib/audit-log";
import { resolveTrainerDepartments } from "@/lib/employeeTrainer";
import { deptMatchesTrainerScope } from "@/lib/lmsTrainerScope";
import Employee from "@/models/Employee";
import User from "@/models/User";

// Password required to delete a department (also enforced in the UI).
const DELETE_PASSWORD = "indiana132";

export async function GET() {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const [sopDepts, persistedDepts] = await Promise.all([
      SOP.distinct("department") as Promise<string[]>,
      Department.distinct("name") as Promise<string[]>,
    ]);
    let merged = sortByDeptOrder(
      [...new Set([...sopDepts, ...persistedDepts])].filter(isDashboardDepartmentName),
    );

    if (isDeptScopedRole(auth.session.user.role)) {
      let assigned = parseAssignedDepartments(auth.session.user.department);
      // Trainers often have departments on the Employee record (trainerDepartments)
      // that were never copied onto User.department — union both so assignment
      // UIs stay consistent with LMS trainer scope.
      try {
        const user = await User.findById(auth.session.user.id)
          .select("lmsEmployeeId username name")
          .lean<{ lmsEmployeeId?: unknown; username?: string; name?: string } | null>();
        let emp = user?.lmsEmployeeId
          ? await Employee.findById(user.lmsEmployeeId)
              .select("department trainerDepartments isTrainer")
              .lean<{
                department?: string;
                trainerDepartments?: string[];
                isTrainer?: boolean;
              } | null>()
          : null;
        if (!emp) {
          const username = String(user?.username || auth.session.user.username || "").trim();
          const displayName = String(user?.name || auth.session.user.name || "").trim();
          const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const ci = (s: string) => new RegExp(`^${escape(s)}$`, "i");
          if (username) {
            emp = await Employee.findOne({
              isActive: true,
              $or: [{ lmsUsername: ci(username) }, { employeeId: ci(username) }],
            })
              .select("department trainerDepartments isTrainer")
              .lean();
          }
          if (!emp && displayName) {
            emp = await Employee.findOne({ isActive: true, name: ci(displayName) })
              .select("department trainerDepartments isTrainer")
              .lean();
          }
        }
        if (emp) {
          assigned = [
            ...new Set([
              ...assigned,
              ...resolveTrainerDepartments({
                department: emp.department,
                trainerDepartments: emp.trainerDepartments,
                isTrainer: emp.isTrainer === true,
              }),
            ]),
          ];
        }
      } catch {
        /* keep login departments only */
      }
      merged = merged.filter((name) => deptMatchesTrainerScope(name, assigned));
    }

    return NextResponse.json({ departments: merged });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch departments" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { name } = await request.json();
    const trimmed = name?.trim();
    if (!trimmed) {
      return NextResponse.json({ error: "Department name required" }, { status: 400 });
    }

    // Check if department already exists in SOP records
    const inSops = await SOP.exists({ department: trimmed });
    if (inSops) {
      return NextResponse.json({ department: trimmed, created: false });
    }

    const result = await Department.updateOne(
      { name: trimmed },
      { $setOnInsert: { name: trimmed } },
      { upsert: true },
    );
    const inserted = Boolean(result.upsertedCount || result.upsertedId);
    if (inserted) {
      await logAuditEvent({
        actor: actorFromSession(auth.session, request),
        entityType: "department",
        entityId: trimmed,
        entityLabel: trimmed,
        department: trimmed,
        action: "created",
        fieldsChanged: ["name"],
        updatedValues: { name: trimmed },
      });
    }
    return NextResponse.json({ department: trimmed, created: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to add department" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { oldName, newName } = await request.json();
    const trimmedOld = oldName?.trim();
    const trimmedNew = newName?.trim();
    if (!trimmedOld || !trimmedNew) {
      return NextResponse.json({ error: "Both oldName and newName are required" }, { status: 400 });
    }
    if (trimmedOld === trimmedNew) {
      return NextResponse.json({ error: "New name is the same as the current name" }, { status: 400 });
    }

    // Check new name doesn't already exist
    const exists = await Department.exists({ name: trimmedNew });
    const inSops = await SOP.exists({ department: trimmedNew });
    if (exists || inSops) {
      return NextResponse.json({ error: "A department with that name already exists" }, { status: 409 });
    }

    // Rename in Department collection and all SOPs atomically
    await Promise.all([
      Department.updateOne({ name: trimmedOld }, { $set: { name: trimmedNew } }),
      SOP.updateMany({ department: trimmedOld }, { $set: { department: trimmedNew } }),
    ]);

    await logAuditEvent({
      actor: actorFromSession(auth.session, request),
      entityType: "department",
      entityId: trimmedNew,
      entityLabel: trimmedNew,
      department: trimmedNew,
      action: "renamed",
      fieldsChanged: ["name"],
      previousValues: { name: trimmedOld },
      updatedValues: { name: trimmedNew },
      summary: `Renamed department ${trimmedOld} → ${trimmedNew}`,
    });

    return NextResponse.json({ oldName: trimmedOld, newName: trimmedNew, renamed: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to rename department" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { name, password } = await request.json();
    const trimmed = name?.trim();
    if (!trimmed) {
      return NextResponse.json({ error: "Department name required" }, { status: 400 });
    }

    if (password !== DELETE_PASSWORD) {
      return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
    }

    // Refuse deletion if any active SOPs still belong to this department
    const sopCount = await SOP.countDocuments({ department: trimmed, isObsolete: { $ne: true } });
    if (sopCount > 0) {
      return NextResponse.json(
        { error: `Cannot delete: ${sopCount} SOP(s) still assigned to this department` },
        { status: 409 },
      );
    }

    await Department.deleteOne({ name: trimmed });
    await logAuditEvent({
      actor: actorFromSession(auth.session, request),
      entityType: "department",
      entityId: trimmed,
      entityLabel: trimmed,
      department: trimmed,
      action: "deleted",
      fieldsChanged: ["name"],
      previousValues: { name: trimmed },
    });
    return NextResponse.json({ department: trimmed, deleted: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete department" },
      { status: 500 },
    );
  }
}
