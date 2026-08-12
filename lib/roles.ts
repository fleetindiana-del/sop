import type { AppRole } from "@/lib/auth";

/** Upload / registry mutate / management actions — Admin only. */
export function canMutate(role: AppRole) {
  return role === "admin";
}

export function isAdmin(role: AppRole) {
  return role === "admin";
}

/** Trainer and Viewer see department-scoped SOP data only. */
export function isDeptScopedRole(role: AppRole) {
  return role === "trainer" || role === "viewer";
}

export function hasFullDashboardAccess(role: AppRole) {
  return role === "admin";
}

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
