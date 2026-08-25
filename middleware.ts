import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { AppRole } from "@/lib/auth";
import { canAccessPath, landingPathForRole } from "@/lib/page-access";

function isPublicPath(pathname: string): boolean {
  return pathname === "/compliance/label" || pathname.startsWith("/compliance/label/");
}

export default withAuth(
  function middleware(req) {
    const path = req.nextUrl.pathname;
    if (isPublicPath(path)) {
      return NextResponse.next();
    }

    const role = (req.nextauth.token?.role as AppRole | undefined) ?? "viewer";
    const pageAccess = req.nextauth.token?.pageAccess as string[] | undefined;

    // Page permissions come from lib/page-registry.ts, managed at /admin/access.
    // Learner-only logins land in the LMS instead of the dashboard, which they
    // cannot reach either.
    if (!canAccessPath(role, pageAccess, path)) {
      const url = new URL(landingPathForRole(role), req.url);
      url.searchParams.set("denied", path);
      return NextResponse.redirect(url);
    }

    return NextResponse.next();
  },
  {
    pages: {
      signIn: "/login",
    },
    callbacks: {
      authorized: ({ token, req }) => {
        if (isPublicPath(req.nextUrl.pathname)) return true;
        return !!token;
      },
    },
  },
);

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/admin/:path*",
    "/training-matrix/:path*",
    "/induction-training-matrix/:path*",
    "/employees/:path*",
    "/compliance/:path*",
    "/sop-scheduler/:path*",
    "/training-content/:path*",
    "/bunny-files/:path*",
    "/mcq-bank/:path*",
    "/sop-compliance-sync/:path*",
    // Learner /lms accepts either login (lib/lmsIdentity), so it stays off the
    // next-auth matcher; only the LMS admin screens require a next-auth session.
    "/lms/admin/:path*",
  ],
};
