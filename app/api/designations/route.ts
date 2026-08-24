import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/mongodb";
import Designation from "@/models/Designation";
import Employee from "@/models/Employee";
import TrainerEmployee from "@/models/lms/TrainerEmployee";
import { requireAuth, canManageDesignations } from "@/lib/withAuth";
import { actorFromSession, logAuditEvent } from "@/lib/audit-log";
import { invalidateEmployeeDerivedCaches } from "@/lib/employeeCacheInvalidation";

export const dynamic = "force-dynamic";

type DesignationLean = {
  _id: unknown;
  name: string;
  description?: string;
  isActive: boolean;
  createdBy: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
};

function forbidden() {
  return NextResponse.json(
    { error: "Forbidden: Designation Master is restricted to Super Admin and SOP Admin" },
    { status: 403 },
  );
}

/** Employees currently holding this designation (case-insensitive exact match). */
function employeeNameFilter(name: string) {
  return { designation: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") };
}

/**
 * GET /api/designations
 *
 * Readable by any signed-in user — the Edit Employee dropdown needs the list.
 * `?withCounts=1` adds the number of active employees per designation and is
 * what the Designation Master screen uses; it is restricted like the rest of
 * the master because headcount per title is management data.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const withCounts = request.nextUrl.searchParams.get("withCounts") === "1";
    const includeInactive = request.nextUrl.searchParams.get("includeInactive") === "1";

    if (withCounts && !canManageDesignations(auth.session.user.role)) return forbidden();

    const filter = includeInactive ? {} : { isActive: true };
    const rows = await Designation.find(filter)
      .sort({ name: 1 })
      .lean<DesignationLean[]>();

    if (!withCounts) {
      return NextResponse.json({
        designations: rows.map((d) => ({ id: String(d._id), name: d.name, isActive: d.isActive })),
      });
    }

    // One grouped pass over Employee rather than a query per designation.
    const counts = await Employee.aggregate<{ _id: string; count: number }>([
      { $match: { isActive: true } },
      { $group: { _id: { $toLower: { $trim: { input: "$designation" } } }, count: { $sum: 1 } } },
    ]);
    const countByName = new Map(counts.map((c) => [c._id, c.count]));

    return NextResponse.json({
      designations: rows.map((d) => ({
        id: String(d._id),
        name: d.name,
        description: d.description || "",
        isActive: d.isActive,
        employeeCount: countByName.get(d.name.trim().toLowerCase()) || 0,
        createdBy: d.createdBy,
        updatedBy: d.updatedBy,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch designations" },
      { status: 500 },
    );
  }
}

/** POST /api/designations — create a designation. */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  if (!canManageDesignations(auth.session.user.role)) return forbidden();

  try {
    await connectDB();
    const body = await request.json();
    const name = String(body.name ?? "").trim();
    const description = String(body.description ?? "").trim();
    if (!name) {
      return NextResponse.json({ error: "Designation name is required" }, { status: 400 });
    }

    const exists = await Designation.exists({ nameLower: name.toLowerCase() });
    if (exists) {
      return NextResponse.json(
        { error: "A designation with that name already exists" },
        { status: 409 },
      );
    }

    const actorName = auth.session.user.name || auth.session.user.username || "Unknown";
    const created = await Designation.create({
      name,
      nameLower: name.toLowerCase(),
      description: description || undefined,
      isActive: true,
      createdBy: actorName,
    });

    await logAuditEvent({
      actor: actorFromSession(auth.session, request),
      entityType: "designation",
      entityId: String(created._id),
      entityLabel: name,
      action: "created",
      fieldsChanged: description ? ["name", "description"] : ["name"],
      updatedValues: { name, ...(description ? { description } : {}) },
    });

    return NextResponse.json(
      { designation: { id: String(created._id), name, description, isActive: true, employeeCount: 0 } },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create designation" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/designations — rename a designation, edit its description, or
 * activate/deactivate it.
 *
 * A rename cascades to every employee CURRENTLY holding the title, because
 * Employee Master must keep pointing at a designation that exists. Historical
 * training / attendance / assessment / certificate records are deliberately not
 * touched: they record the title held at the time.
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  if (!canManageDesignations(auth.session.user.role)) return forbidden();

  try {
    await connectDB();
    const body = await request.json();
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const existing = await Designation.findById(id);
    if (!existing) {
      return NextResponse.json({ error: "Designation not found" }, { status: 404 });
    }

    const previous = {
      name: existing.name,
      description: existing.description || "",
      isActive: existing.isActive,
    };

    const nextName = body.name !== undefined ? String(body.name).trim() : previous.name;
    const nextDescription =
      body.description !== undefined ? String(body.description).trim() : previous.description;
    const nextIsActive = body.isActive !== undefined ? body.isActive === true : previous.isActive;
    const assignedEmployeeIds: string[] = Array.isArray(body.assignedEmployeeIds)
      ? [...new Set<string>(body.assignedEmployeeIds.map((value: unknown) => String(value).trim()).filter(Boolean))]
      : [];
    const assignedEmployeeObjectIds = assignedEmployeeIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    if (!nextName) {
      return NextResponse.json({ error: "Designation name is required" }, { status: 400 });
    }

    const renamed = nextName.toLowerCase() !== previous.name.toLowerCase();
    if (renamed) {
      const clash = await Designation.exists({
        _id: { $ne: existing._id },
        nameLower: nextName.toLowerCase(),
      });
      if (clash) {
        return NextResponse.json(
          { error: "A designation with that name already exists" },
          { status: 409 },
        );
      }
    }

    const fieldsChanged: string[] = [];
    if (nextName !== previous.name) fieldsChanged.push("name");
    if (nextDescription !== previous.description) fieldsChanged.push("description");
    if (nextIsActive !== previous.isActive) fieldsChanged.push("isActive");

    if (fieldsChanged.length === 0 && assignedEmployeeIds.length === 0) {
      return NextResponse.json({ designation: { id, ...previous }, changed: false });
    }

    const actorName = auth.session.user.name || auth.session.user.username || "Unknown";
    existing.name = nextName;
    existing.nameLower = nextName.toLowerCase();
    existing.description = nextDescription || undefined;
    existing.isActive = nextIsActive;
    existing.updatedBy = actorName;
    await existing.save();

    // Carry the rename onto employees who hold it right now.
    let employeesUpdated = 0;
    if (nextName !== previous.name) {
      const result = await Employee.updateMany(employeeNameFilter(previous.name), {
        $set: {
          designation: nextName,
          previousDesignation: previous.name,
          designationUpdatedAt: new Date(),
        },
      });
      employeesUpdated = result.modifiedCount || 0;
      if (employeesUpdated > 0) {
        await logAuditEvent({
          actor: actorFromSession(auth.session, request),
          entityType: "employee",
          entityId: `designation:${existing._id}`,
          entityLabel: nextName,
          action: "updated",
          fieldsChanged: ["designation"],
          previousValues: { designation: previous.name },
          updatedValues: { designation: nextName },
          summary:
            `Designation rename applied to ${employeesUpdated} employee(s): ` +
            `${previous.name} → ${nextName}`,
        });
      }
    }

    let employeesAssigned = 0;
    if (assignedEmployeeObjectIds.length > 0) {
      const now = new Date();
      const candidates = await Employee.find({
        _id: { $in: assignedEmployeeObjectIds },
        isActive: true,
        designation: { $not: employeeNameFilter(nextName).designation },
      })
        .select("_id name department designation")
        .lean<Array<{ _id: Types.ObjectId; name: string; department: string; designation: string }>>();

      if (candidates.length > 0) {
        const result = await Employee.bulkWrite(
          candidates.map((employee) => ({
            updateOne: {
              filter: { _id: employee._id },
              update: {
                $set: {
                  designation: nextName,
                  previousDesignation: employee.designation || "",
                  designationUpdatedAt: now,
                },
              },
            },
          })),
        );
        employeesAssigned = result.modifiedCount || 0;
        await TrainerEmployee.updateMany(
          { employeeId: { $in: candidates.map((employee) => String(employee._id)) } },
          { $set: { designation: nextName } },
        );
        await logAuditEvent({
          actor: actorFromSession(auth.session, request),
          entityType: "employee",
          entityId: `designation:${existing._id}:assignments`,
          entityLabel: nextName,
          action: "updated",
          fieldsChanged: ["designation"],
          previousValues: {
            employees: candidates.map((employee) => ({
              id: String(employee._id),
              name: employee.name,
              designation: employee.designation || "",
            })),
          },
          updatedValues: { designation: nextName },
          summary: `Assigned ${employeesAssigned} employee(s) to ${nextName}`,
        });
      }
    }

    if (fieldsChanged.length > 0) {
      await logAuditEvent({
        actor: actorFromSession(auth.session, request),
        entityType: "designation",
        entityId: String(existing._id),
        entityLabel: nextName,
        action: nextName !== previous.name ? "renamed" : "updated",
        fieldsChanged,
        previousValues: previous,
        updatedValues: { name: nextName, description: nextDescription, isActive: nextIsActive },
        summary:
          nextName !== previous.name
            ? `Renamed designation ${previous.name} → ${nextName}` +
              (employeesUpdated ? ` (${employeesUpdated} employee(s) updated)` : "")
            : `Updated ${fieldsChanged.join(", ")} on designation ${nextName}`,
      });
    }

    invalidateEmployeeDerivedCaches();

    return NextResponse.json({
      designation: {
        id: String(existing._id),
        name: nextName,
        description: nextDescription,
        isActive: nextIsActive,
      },
      employeesUpdated,
      employeesAssigned,
      changed: true,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update designation" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/designations?id=...
 *
 * Refused while any active employee still holds the title — reassign them
 * first. Historical records that reference the name are unaffected either way.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  if (!canManageDesignations(auth.session.user.role)) return forbidden();

  try {
    await connectDB();
    const id = String(request.nextUrl.searchParams.get("id") ?? "").trim();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const existing = await Designation.findById(id);
    if (!existing) {
      return NextResponse.json({ error: "Designation not found" }, { status: 404 });
    }

    const inUse = await Employee.countDocuments({
      ...employeeNameFilter(existing.name),
      isActive: true,
    });
    if (inUse > 0) {
      return NextResponse.json(
        {
          error:
            `Cannot delete: ${inUse} active employee(s) still hold "${existing.name}". ` +
            "Reassign them first, or deactivate this designation instead.",
        },
        { status: 409 },
      );
    }

    await Designation.deleteOne({ _id: existing._id });

    await logAuditEvent({
      actor: actorFromSession(auth.session, request),
      entityType: "designation",
      entityId: String(existing._id),
      entityLabel: existing.name,
      action: "deleted",
      fieldsChanged: ["name"],
      previousValues: { name: existing.name, description: existing.description || "" },
    });

    invalidateEmployeeDerivedCaches();

    return NextResponse.json({ id, name: existing.name, deleted: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete designation" },
      { status: 500 },
    );
  }
}
