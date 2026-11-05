import { after, type NextRequest } from "next/server";
import { cookies, headers } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { connectDB } from "@/lib/mongodb";
import { clientIp } from "@/lib/audit-log";
import { LMS_COOKIE, verifyLmsToken } from "@/lib/lms-session";
import { matchPage } from "@/lib/page-registry";
import ActivityLog from "@/models/ActivityLog";

const SECRET_PARAM = /token|secret|password|key|^t$|^sig/i;
const MAX_ERROR_CHARS = 500;

function redactedQuery(url: URL): string | undefined {
  const params = new URLSearchParams(url.search);
  for (const name of [...params.keys()]) {
    if (SECRET_PARAM.test(name)) params.set(name, "[redacted]");
  }
  const text = params.toString();
  return text || undefined;
}

function pageFor(referer: string | null): { pageKey: string; pageLabel: string } {
  if (!referer) return { pageKey: "api", pageLabel: "API (no page)" };
  let pathname: string;
  try {
    pathname = new URL(referer).pathname;
  } catch {
    return { pageKey: "api", pageLabel: "API (no page)" };
  }
  const page = matchPage(pathname);
  if (page) return { pageKey: page.key, pageLabel: page.label };
  if (pathname === "/lms" || pathname.startsWith("/lms/")) return { pageKey: "lms", pageLabel: "LMS (learner)" };
  return { pageKey: pathname, pageLabel: pathname };
}

async function errorText(response: Response | undefined, thrown: unknown): Promise<string | undefined> {
  if (thrown) return (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, MAX_ERROR_CHARS);
  if (!response || response.ok) return undefined;
  if (!response.headers.get("content-type")?.includes("application/json")) return undefined;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    const message = body?.error ?? body?.message;
    return message == null ? undefined : String(message).slice(0, MAX_ERROR_CHARS);
  } catch {
    return undefined;
  }
}

async function actor() {
  const session = await getServerSession(authOptions).catch(() => null);
  if (session?.user) {
    return {
      userId: session.user.id,
      userName: session.user.name?.trim() || session.user.username || "Unknown",
      userRole: session.user.role,
      userDepartment: session.user.department,
      via: "web" as const,
    };
  }
  const learner = verifyLmsToken((await cookies()).get(LMS_COOKIE)?.value);
  if (learner) {
    return { userId: learner.sub, userName: learner.name, userRole: "learner", userDepartment: undefined, via: "lms" as const };
  }
  return { userId: undefined, userName: "Anonymous", userRole: "anonymous", userDepartment: undefined, via: "api" as const };
}

async function record(request: Request, response: Response | undefined, thrown: unknown, startedAt: number) {
  try {
    const url = new URL(request.url);
    const head = await headers();
    const status = response?.status ?? 500;
    const who = await actor();
    await connectDB();
    await ActivityLog.create({
      timestamp: new Date(startedAt),
      method: request.method,
      path: url.pathname,
      query: redactedQuery(url),
      ...pageFor(head.get("referer")),
      status,
      ok: !thrown && status < 400,
      error: await errorText(response, thrown),
      durationMs: Date.now() - startedAt,
      ...who,
      department: url.searchParams.get("department") || undefined,
      ipAddress: clientIp(request as NextRequest),
      userAgent: head.get("user-agent") ?? undefined,
    });
  } catch (error) {
    console.error("[activity-log] failed to write entry:", error);
  }
}

/**
 * Wrap a route's POST / PUT / PATCH / DELETE export so every call is written to
 * the activity log after the response is sent: who, from which page, which
 * endpoint, and whether it succeeded.
 */
export function withActivityLog<A extends unknown[], R extends Response>(
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const request = args[0] instanceof Request ? args[0] : undefined;
    const startedAt = Date.now();
    let response: R | undefined;
    let thrown: unknown;
    try {
      response = await handler(...args);
      return response;
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      if (request) {
        const failedJson =
          response && !response.ok && response.headers.get("content-type")?.includes("application/json")
            ? response.clone()
            : response;
        try {
          after(() => record(request, failedJson, thrown, startedAt));
        } catch (error) {
          console.error("[activity-log] could not schedule entry:", error);
        }
      }
    }
  };
}
