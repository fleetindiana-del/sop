import type { AppRole } from "@/lib/auth";

/**
 * Role model
 *
 * - `admin`     — Super Admin. Everything, including user administration
 *                 (Login & Passwords, Access Management).
 * - `sop_admin` — SOP Admin. Everything a Super Admin can do EXCEPT user
 *                 administration. Manages SOPs, employees and the Designation
 *                 Master.
 * - `trainer` / `viewer` — department-scoped read/training roles.
 *
 * Use `isSuperAdmin` for anything that grants or revokes access to the system
 * itself; use `isAdminRole` for ordinary administrative capability.
 */

/** Super Admin only — user administration and permission granting. */
export function isSuperAdmin(role: AppRole) {
  return role === "admin";
}

/** Super Admin or SOP Admin. */
export function isAdmin(role: AppRole) {
  return role === "admin" || role === "sop_admin";
}

/** Upload / registry mutate / management actions — Super Admin and SOP Admin. */
export function canMutate(role: AppRole) {
  return isAdmin(role);
}

/** Who may view and manage the Designation Master. */
export function canManageDesignations(role: AppRole) {
  return isAdmin(role);
}

/** Trainer and Viewer see department-scoped SOP data only. */
export function isDeptScopedRole(role: AppRole) {
  return role === "trainer" || role === "viewer";
}

export function hasFullDashboardAccess(role: AppRole) {
  return isAdmin(role);
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
  if (isAdmin(role)) return true;
  if (!targetDepartment?.trim()) return false;
  const assigned = parseAssignedDepartments(userDepartment);
  if (!assigned.length) return false;
  return assigned.some((d) => departmentsMatch(d, targetDepartment));
}

/** Human-readable role label for admin screens and audit entries. */
export const ROLE_LABELS: Record<AppRole, string> = {
  admin: "Super Admin",
  sop_admin: "SOP Admin",
  trainer: "Trainer",
  viewer: "Viewer",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as AppRole] ?? role;
}
