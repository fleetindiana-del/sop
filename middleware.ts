import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware() {
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
  ],
};
