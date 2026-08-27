import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import Employee from "@/models/Employee";
import { requireAuth, canManageDesignations } from "@/lib/withAuth";

export const dynamic = "force-dynamic";

/**
 * GET /api/designations/employees?name=<designation>
 *
 * The people currently holding a designation, for the drill-down behind the
 * headcount chip on the Designation Master. Reads Employee Master directly —
 * that is the source of truth for who holds what right now.
 *
 * Restricted like the rest of the master: headcount-by-title is management data.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  if (!canManageDesignations(auth.session.user.role)) {
    return NextResponse.json(
      { error: "Forbidden: Designation Master is restricted to Super Admin and SOP Admin" },
      { status: 403 },
    );
  }

  try {
    await connectDB();
    const name = String(request.nextUrl.searchParams.get("name") ?? "").trim();
    const all = request.nextUrl.searchParams.get("all") === "1";
    if (!name && !all) return NextResponse.json({ error: "name is required" }, { status: 400 });

    // Inactive employees are included but flagged, so a headcount of 0 with
    // former holders still explains why a delete may feel surprising.
    const includeInactive =
      request.nextUrl.searchParams.get("includeInactive") === "1";

    const filter: Record<string, unknown> = {};
    if (!all) {
      filter.designation = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    }
    if (!includeInactive) filter.isActive = true;
    filter.isDeleted = { $ne: true };

    const rows = await Employee.find(filter)
      .select(
        "_id name employeeId department designation previousDesignation " +
        "designationUpdatedAt isActive isTrainer",
      )
      .sort({ department: 1, name: 1 })
      .lean<Array<{
        _id: unknown;
        name?: string;
        employeeId?: string;
        department?: string;
        designation?: string;
        previousDesignation?: string;
        designationUpdatedAt?: Date;
        isActive?: boolean;
        isTrainer?: boolean;
      }>>();

    return NextResponse.json({
      designation: name,
      employees: rows.map((r) => ({
        id: String(r._id),
        name: String(r.name || "").trim(),
        employeeCode: r.employeeId ? String(r.employeeId).trim() : "",
        department: String(r.department || "").trim(),
        designation: String(r.designation || "").trim(),
        isActive: r.isActive !== false,
        isTrainer: Boolean(r.isTrainer),
        previousDesignation: r.previousDesignation || "",
        designationUpdatedAt: r.designationUpdatedAt
          ? new Date(r.designationUpdatedAt).toISOString()
          : undefined,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load employees" },
      { status: 500 },
    );
  }
}
