"use client";

import { signIn, useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { canAccessPath, landingPathForRole } from "@/lib/page-access";

function safeCallbackUrl(raw: string | null): string | null {
  if (!raw) return null;
  // Only allow same-origin relative paths (block open redirects).
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

/**
 * Where this login belongs after signing in.
 *
 * Admins / SOP Admins / Trainers land on the dashboard; every other login is a
 * learner and goes straight to the LMS with their allocated exams and
 * trainings. A `callbackUrl` is honoured only when the role can actually reach
 * it — otherwise middleware would just bounce them back here.
 */
function destinationFor(
  role: string | undefined,
  pageAccess: string[] | undefined,
  rawCallbackUrl: string | null,
): string {
  const requested = safeCallbackUrl(rawCallbackUrl);
  const pathname = requested ? requested.split(/[?#]/)[0] : "";
  if (requested && canAccessPath(role, pageAccess, pathname)) return requested;
  return landingPathForRole(role);
}

function LoginForm() {
  const { data: session, status } = useSession();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status === "authenticated" && session) {
      const next = destinationFor(
        session.user?.role,
        session.user?.pageAccess,
        searchParams.get("callbackUrl"),
      );
      window.location.replace(next);
    }
  }, [session, status, searchParams]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#e4ebf3]">
        <Loader2 className="h-8 w-8 animate-spin text-violet-600" />
      </div>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");
    const rawCallbackUrl = searchParams.get("callbackUrl");
    try {
      const result = await signIn("credentials", {
        username: username.trim(),
        password,
        redirect: false,
        callbackUrl: safeCallbackUrl(rawCallbackUrl) ?? undefined,
      });

      if (!result) {
        setError("Sign-in failed — no response from the server. Please try again.");
        return;
      }
      if (result.error) {
        setError(
          result.error === "CredentialsSignin"
            ? "Invalid username or password"
            : `Sign-in failed: ${result.error}`,
        );
        return;
      }
      if (result.ok === false) {
        setError("Invalid username or password");
        return;
      }

      // The role decides the landing page, so read the freshly issued session
      // before navigating.
      let role: string | undefined;
      let pageAccess: string[] | undefined;
      try {
        const fresh = await fetch("/api/auth/session").then((r) => r.json());
        role = fresh?.user?.role;
        pageAccess = fresh?.user?.pageAccess;
      } catch {
        /* fall back to the default landing page */
      }

      // Hard navigation so the session cookie is always picked up by middleware.
      window.location.assign(destinationFor(role, pageAccess, rawCallbackUrl));
    } catch (err) {
      console.error("[login] signIn error:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Could not reach the sign-in service. Check your connection and try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#e4ebf3] via-violet-50 to-sky-100 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-violet-900">SOP Control</h1>
            <p className="mt-1 text-sm text-slate-500">
              Use your dashboard or LMS username — trainers share one password for both.
            </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Username</span>
            <input
              type="text"
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-60"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-60"
            />
          </label>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !username.trim() || !password}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#e4ebf3]">
          <Loader2 className="h-8 w-8 animate-spin text-violet-600" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
