import { getPage, matchPage, type AppPage } from "@/lib/page-registry";
import { parseAssignedDepartments, departmentsMatch } from "@/lib/access-control";

type RoleLike = string | undefined | null;

/**
 * Page-level access.
 *
 * - Admins can reach everything.
 * - A user whose `pageAccess` was never configured (`undefined`/`null`) keeps
 *   the legacy role behaviour: every page except the admin-only ones and those
 *   flagged `restrictedByDefault`.
 * - Once `pageAccess` is set (an array, possibly empty) it is the allowlist,
 *   plus pages flagged `alwaysAllowed` in the registry.
 * - Paths not present in the registry are not gated here.
 */
export function canAccessPageKey(
  role: RoleLike,
  pageAccess: string[] | null | undefined,
  page: AppPage,
): boolean {
  if (role === "admin") return true;
  if (page.adminOnly) return false;
  if (page.alwaysAllowed) return true;
  if (!Array.isArray(pageAccess)) return !page.restrictedByDefault;
  return pageAccess.includes(page.key);
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
  if (!page) return role === "admin";
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
  if (role === "admin") return allDepartments;
  const assigned = parseAssignedDepartments(userDepartment);
  if (!assigned.length) return [];
  return allDepartments.filter((name) => assigned.some((d) => departmentsMatch(d, name)));
}
