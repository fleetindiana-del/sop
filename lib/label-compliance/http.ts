import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DEFAULT_FREE_COMPLIANCE_MODEL } from "@/lib/gemini-free-models";

export function requireGeminiConfigured(): NextResponse | null {
  if (!process.env.GEMINI_API_KEY?.trim()) {
    return NextResponse.json(
      {
        error:
          "Gemini is not configured on this host. Set GEMINI_API_KEY (and optionally GEMINI_MODEL) in the environment.",
      },
      { status: 503 },
    );
  }
  return null;
}

export function geminiLabelModel(): string {
  return (
    process.env.COMPLIANCE_GEMINI_MODEL ??
    process.env.GEMINI_MODEL ??
    DEFAULT_FREE_COMPLIANCE_MODEL
  );
}

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip") || "unknown";
}

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/**
 * In-process rate limit for the public label APIs. Enough to stop casual
 * abuse on a single Node/Fluid instance; not a substitute for an edge WAF.
 */
export function rateLimitLabelApi(
  req: NextRequest,
  action: string,
  limit: number,
  windowMs = 15 * 60 * 1000,
): NextResponse | null {
  const key = `${action}:${clientIp(req)}`;
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  current.count += 1;
  if (current.count > limit) {
    return NextResponse.json(
      { error: "Too many label checks from this network. Wait a few minutes and try again." },
      { status: 429 },
    );
  }
  return null;
}

export function parseRequestedIds(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 30);
}
