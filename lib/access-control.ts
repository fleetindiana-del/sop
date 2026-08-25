import { NextResponse } from "next/server";
import type { AppRole } from "@/lib/auth";
import { isAdmin } from "@/lib/roles";

/** Roles that only see assigned-department data (not the full admin dashboard). */
export function isDeptScopedRole(role: AppRole): boolean {
  return role === "trainer" || role === "viewer";
}

/** Super Admin and SOP Admin both get the unscoped dashboard. */
export function hasFullDashboardAccess(role: AppRole): boolean {
  return isAdmin(role);
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

/**
 * Normalise submitted department(s) into the comma-separated form
 * `User.department` stores. Accepts an array (multi-select) or a single string,
 * so both the user-setup form and older single-value callers work unchanged.
 * Returns `undefined` when nothing is assigned.
 */
export function serializeAssignedDepartments(value: unknown): string | undefined {
  const list = Array.isArray(value)
    ? value.map((d) => String(d ?? "").trim())
    : parseAssignedDepartments(String(value ?? ""));
  const unique: string[] = [];
  for (const name of list) {
    if (!name) continue;
    if (unique.some((d) => departmentsMatch(d, name))) continue;
    unique.push(name);
  }
  return unique.length ? unique.join(", ") : undefined;
}

export function canAccessDepartment(
  role: AppRole,
  userDepartment: string | undefined | null,
  targetDepartment: string | undefined | null,
): boolean {
  if (isAdmin(role)) return true;
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
  if (isAdmin(role)) return items;
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
