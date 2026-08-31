"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

/**
 * NextAuth session client. Keep `basePath` on the App Router auth catch-all
 * (`/api/auth`). If `/api/auth/session` ever returns HTML (compile/runtime
 * error page), next-auth logs CLIENT_FETCH_ERROR — that is a symptom of the
 * app being broken, not a missing login.
 *
 * `refetchInterval` is what makes an administrative change to someone's role or
 * page access reach an already-open tab: each refetch re-runs the `jwt`
 * callback in `lib/auth.ts`, which re-reads role/department/pageAccess and
 * rewrites the JWT cookie the middleware gates on. With no interval the tab
 * kept the designation it signed in with until the window was refocused.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider basePath="/api/auth" refetchOnWindowFocus refetchInterval={15}>
      {children}
    </SessionProvider>
  );
}
