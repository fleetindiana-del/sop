import { NextResponse } from "next/server";
import { connectDB, isMongoConnectivityError } from "@/lib/mongodb";
import Department from "@/models/Department";
import { buildDashboardStats, sortByDeptOrder } from "@/lib/sop-utils";
import { loadGroupedRegistry } from "@/lib/dashboardRegistrySource";
import { isDashboardDepartmentName } from "@/lib/dashboardDepartments";
import {
  filterByAssignedDepartments,
  isDeptScopedRole,
  requireAuth,
} from "@/lib/withAuth";
import { parseAssignedDepartments } from "@/lib/roles";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();

    const role = auth.session.user.role;
    const userDepartment = auth.session.user.department;
    const registry = filterByAssignedDepartments(
      role,
      userDepartment,
      await loadGroupedRegistry(),
    );

    // Fetch persisted department names (empty departments created via the UI)
    let persistedDepts = (await Department.distinct("name")) as string[];
    if (isDeptScopedRole(role)) {
      const assigned = parseAssignedDepartments(userDepartment);
      persistedDepts = persistedDepts.filter((name) =>
        assigned.some((d) => d.toLowerCase() === name.toLowerCase()),
      );
    }

    const stats = buildDashboardStats(registry, persistedDepts);

    // departmentList = union of SOP-derived and persisted (for dropdowns)
    const sopDepts = registry
      .filter((r) => !r.isObsolete)
      .map((r) => r.department)
      .filter(isDashboardDepartmentName);
    const departmentList = sortByDeptOrder([
      ...new Set([...sopDepts, ...persistedDepts.filter(isDashboardDepartmentName)]),
    ]);

    // Drop Other/Unknown capsules so dashboard matches LMS / MCQ department universe.
    const departments = (stats.departments ?? []).filter(
      (d) => d.department === "Total" || isDashboardDepartmentName(d.department),
    );

    return NextResponse.json(
      { ...stats, departments, departmentList },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("GET /api/sops/stats error:", error);
    const dbDown = isMongoConnectivityError(error);
    return NextResponse.json(
      {
        error: dbDown
          ? "Database is temporarily unreachable. Check your network or MongoDB Atlas IP allowlist."
          : error instanceof Error
            ? error.message
            : "Failed to fetch stats",
      },
      { status: dbDown ? 503 : 500 },
    );
  }
}
