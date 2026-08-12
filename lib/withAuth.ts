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
import { canMutate as canMutateRole, isAdmin as isAdminRole } from "@/lib/roles";

type RouteHandler = (
  req: NextRequest,
  context?: { params: Promise<Record<string, string>> },
) => Promise<Response> | Response;

export async function requireAuth(allowedRoles?: AppRole[]) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (allowedRoles && !allowedRoles.includes(session.user.role)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
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

export {
  canAccessDepartment,
  filterByAssignedDepartments,
  forbidUnlessDepartmentAccess,
  isDeptScopedRole,
  parseAssignedDepartments,
};
