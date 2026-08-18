import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { AppRole } from "@/lib/auth";
import { canAccessPath } from "@/lib/page-access";

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
    if (!canAccessPath(role, pageAccess, path)) {
      const url = new URL("/dashboard", req.url);
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
    "/mcq-review/:path*",
    "/sop-compliance-sync/:path*",
    // Learner /lms uses its own cookie session (lib/lms-session), not next-auth.
    "/lms/admin/:path*",
  ],
};
