import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { AppRole } from "@/lib/auth";
import { canAccessPath } from "@/lib/page-access";

export default withAuth(
  function middleware(req) {
    const role = (req.nextauth.token?.role as AppRole | undefined) ?? "viewer";
    const pageAccess = req.nextauth.token?.pageAccess as string[] | undefined;
    const path = req.nextUrl.pathname;

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
