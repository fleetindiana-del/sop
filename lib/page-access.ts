import { getPage, matchPage, type AppPage } from "@/lib/page-registry";
import { parseAssignedDepartments, departmentsMatch } from "@/lib/access-control";

type RoleLike = string | undefined | null;

/** The LMS learner module — the only area a learner-only login reaches. */
export const LMS_LANDING_PATH = "/lms";

/**
 * Roles that run the application: Super Admin, SOP Admin and Trainer. Everyone
 * else (i.e. `viewer`) is a learner — they sign in to take their allocated
 * exams and trainings, not to administer SOPs.
 */
const PRIVILEGED_ROLES = new Set(["admin", "sop_admin", "trainer"]);

export function isPrivilegedRole(role: RoleLike): boolean {
  return PRIVILEGED_ROLES.has(String(role || ""));
}

/** A login with no application sections — LMS only. */
export function isLearnerOnly(role: RoleLike): boolean {
  return !isPrivilegedRole(role);
}

/** Where a login lands after sign-in, and where a denied request is sent. */
export function landingPathForRole(role: RoleLike): string {
  return isLearnerOnly(role) ? LMS_LANDING_PATH : "/dashboard";
}

/**
 * Page-level access.
 *
 * - Super Admin reaches everything; SOP Admin everything except the pages
 *   flagged `superAdminOnly` (user administration).
 * - An explicit grant in `pageAccess` always wins, whatever the role.
 * - A learner-only role (see {@link isLearnerOnly}) reaches nothing else in the
 *   registry — not even the pages flagged `alwaysAllowed`. `/lms` itself is not
 *   a registry page, so it stays open to them.
 * - A privileged user whose `pageAccess` was never configured
 *   (`undefined`/`null`) keeps the legacy role behaviour: every page except the
 *   admin-only ones and those flagged `restrictedByDefault`.
 * - Once `pageAccess` is set (an array, possibly empty) it is the allowlist,
 *   plus pages flagged `alwaysAllowed` in the registry.
 * - Paths not present in the registry are not gated here.
 */
export function canAccessPageKey(
  role: RoleLike,
  pageAccess: string[] | null | undefined,
  page: AppPage,
): boolean {
  // Checked before the blanket admin allow so SOP Admin cannot reach user
  // administration and grant itself more access.
  if (page.superAdminOnly) return role === "admin";
  if (role === "admin" || role === "sop_admin") return true;
  if (page.adminOnly) return false;
  // An administrator can still hand a learner a specific page.
  if (Array.isArray(pageAccess) && pageAccess.includes(page.key)) return true;
  if (isLearnerOnly(role)) return false;
  if (page.alwaysAllowed) return true;
  if (!Array.isArray(pageAccess)) return !page.restrictedByDefault;
  return false;
}

export function canAccessPath(
  role: RoleLike,
  pageAccess: string[] | null | undefined,
  pathname: string,
): boolean {
  const page = matchPage(pathname);
  if (!page) return true;
  return canAccessPageKey(role, pageAccess, page);
}

/** Users who can execute the Compliance Engine (admins + granted users). */
export function isComplianceOperator(
  role: RoleLike,
  pageAccess: string[] | null | undefined,
): boolean {
  const page = getPage("compliance");
  if (!page) return role === "admin" || role === "sop_admin";
  return canAccessPageKey(role, pageAccess, page);
}

/** Effective page keys for a user — what the UI should show as granted. */
export function effectivePageKeys(
  role: RoleLike,
  pageAccess: string[] | null | undefined,
  pages: AppPage[],
): string[] {
  return pages.filter((page) => canAccessPageKey(role, pageAccess, page)).map((p) => p.key);
}

/**
 * Department-level access for a page-scoped view.
 * Admins see all; everyone else is limited to their assigned departments.
 */
export function allowedDepartments(
  role: RoleLike,
  userDepartment: string | null | undefined,
  allDepartments: string[],
): string[] {
  if (role === "admin" || role === "sop_admin") return allDepartments;
  const assigned = parseAssignedDepartments(userDepartment);
  if (!assigned.length) return [];
  return allDepartments.filter((name) => assigned.some((d) => departmentsMatch(d, name)));
}
