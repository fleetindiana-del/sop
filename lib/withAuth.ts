import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions, type AppRole } from "@/lib/auth";
import {
  canAccessDepartment,
  filterByAssignedDepartments,
  forbidUnlessDepartmentAccess,
  isDeptScopedRole,
  parseAssignedDepartments,
} from "@/lib/access-control";
import {
  canMutate as canMutateRole,
  isAdmin as isAdminRole,
  isSuperAdmin as isSuperAdminRole,
  canManageDesignations as canManageDesignationsRole,
} from "@/lib/roles";

type RouteHandler = (
  req: NextRequest,
  context?: { params: Promise<Record<string, string>> },
) => Promise<Response> | Response;

/**
 * SOP Admin has every administrative capability except user administration, so
 * anywhere a route admits "admin" it also admits "sop_admin". Routes that must
 * stay Super-Admin-only call {@link requireSuperAdmin} instead — that is the
 * single place the distinction is drawn, so a new admin route cannot silently
 * hand user administration to SOP Admin.
 */
function roleSatisfies(allowedRoles: AppRole[], role: AppRole): boolean {
  if (allowedRoles.includes(role)) return true;
  return role === "sop_admin" && allowedRoles.includes("admin");
}

export async function requireAuth(allowedRoles?: AppRole[]) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (allowedRoles && !roleSatisfies(allowedRoles, session.user.role)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session };
}

/**
 * Super Admin only — creating logins, resetting passwords, granting page and
 * department access. Deliberately excludes SOP Admin so it cannot widen its
 * own permissions.
 */
export async function requireSuperAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (session.user.role !== "admin") {
    return {
      error: NextResponse.json(
        { error: "Forbidden: Super Admin only" },
        { status: 403 },
      ),
    };
  }
  return { session };
}

export function withAuth(handler: RouteHandler, allowedRoles?: AppRole[]): RouteHandler {
  return async (req, context) => {
    const auth = await requireAuth(allowedRoles);
    if (auth.error) return auth.error;
    return handler(req, context);
  };
}

export function canMutate(role: AppRole) {
  return canMutateRole(role);
}

export function isAdmin(role: AppRole) {
  return isAdminRole(role);
}

export function isSuperAdmin(role: AppRole) {
  return isSuperAdminRole(role);
}

export function canManageDesignations(role: AppRole) {
  return canManageDesignationsRole(role);
}

export {
  canAccessDepartment,
  filterByAssignedDepartments,
  forbidUnlessDepartmentAccess,
  isDeptScopedRole,
  parseAssignedDepartments,
};
