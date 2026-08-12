import { NextResponse } from "next/server";
import type { AppRole } from "@/lib/auth";

/** Roles that only see assigned-department data (not the full admin dashboard). */
export function isDeptScopedRole(role: AppRole): boolean {
  return role === "trainer" || role === "viewer";
}

export function hasFullDashboardAccess(role: AppRole): boolean {
  return role === "admin";
}

/**
 * Parse assigned department(s) from the user record.
 * Supports a single value or comma-separated list.
 */
export function parseAssignedDepartments(department?: string | null): string[] {
  if (!department?.trim()) return [];
  return department
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

export function departmentsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function canAccessDepartment(
  role: AppRole,
  userDepartment: string | undefined | null,
  targetDepartment: string | undefined | null,
): boolean {
  if (role === "admin") return true;
  if (!targetDepartment?.trim()) return false;
  const assigned = parseAssignedDepartments(userDepartment);
  if (!assigned.length) return false;
  return assigned.some((d) => departmentsMatch(d, targetDepartment));
}

export function filterByAssignedDepartments<T extends { department?: string | null }>(
  role: AppRole,
  userDepartment: string | undefined | null,
  items: T[],
): T[] {
  if (role === "admin") return items;
  const assigned = parseAssignedDepartments(userDepartment);
  if (!assigned.length) return [];
  return items.filter(
    (item) =>
      Boolean(item.department) &&
      assigned.some((d) => departmentsMatch(d, String(item.department))),
  );
}

/** 403 when a dept-scoped user requests a department outside their assignment. */
export function forbidUnlessDepartmentAccess(
  role: AppRole,
  userDepartment: string | undefined | null,
  targetDepartment: string | undefined | null,
): NextResponse | null {
  if (canAccessDepartment(role, userDepartment, targetDepartment)) return null;
  return NextResponse.json(
    { error: "Forbidden: department access denied" },
    { status: 403 },
  );
}
