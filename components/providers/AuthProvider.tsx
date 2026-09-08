"use client";

import { SessionProvider } from "next-auth/react";
import { useEffect, useState, type ReactNode } from "react";

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
const REFETCH_SECONDS = 15;

export function AuthProvider({ children }: { children: ReactNode }) {
  // Poll only while the tab is actually being looked at. next-auth's timer runs
  // regardless of visibility, so a tab left open in the background spent all
  // day re-running the `jwt` callback — one authenticated request and one
  // `User.findById` every 15 seconds — competing with the requests of whatever
  // page the user was really using. Nothing is lost by pausing: nobody is
  // reading a hidden tab, and `refetchOnWindowFocus` re-syncs it the instant it
  // comes back, which is sooner than the next poll would have.
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return (
    <SessionProvider
      basePath="/api/auth"
      refetchOnWindowFocus
      refetchInterval={visible ? REFETCH_SECONDS : 0}
    >
      {children}
    </SessionProvider>
  );
}
