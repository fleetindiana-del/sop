import { createHash, randomBytes } from "crypto";
import type { NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { actorFromSession, type AuditActor } from "@/lib/audit-log";
import { isAdmin } from "@/lib/roles";
import type { AppRole } from "@/lib/auth";
import ApiKey from "@/models/ApiKey";
import User from "@/models/User";

export const API_KEY_SCOPES = [
  "sops:read",
  "sops:write",
  "media:write",
  "compliance:read",
  "compliance:run",
  "mcq:read",
  "ai:work",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Same gate as the dashboard upload routes, which require an admin role. AI answers become saved reports and MCQs. */
const ADMIN_ONLY_SCOPES: ApiKeyScope[] = ["sops:write", "media:write", "ai:work"];

const KEY_PREFIX = "sopk_";

export type ApiKeyPrincipal = {
  keyId: string;
  keyName: string;
  scopes: ApiKeyScope[];
  user: {
    id: string;
    name: string;
    username: string;
    role: AppRole;
    department?: string;
    pageAccess?: string[];
  };
};

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey() {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, keyHash: hashApiKey(key), displayPrefix: key.slice(0, 12) };
}

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

export function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

export async function verifyApiKey(token: string | undefined): Promise<ApiKeyPrincipal | null> {
  if (!token?.startsWith(KEY_PREFIX)) return null;

  await connectDB();
  const key = await ApiKey.findOne({ keyHash: hashApiKey(token), revokedAt: null }).lean();
  if (!key) return null;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;

  const user = await User.findById(key.userId)
    .select("name username role department pageAccess")
    .lean();
  if (!user) return null;

  const role = user.role as AppRole;
  const scopes = key.scopes
    .filter(isApiKeyScope)
    .filter((scope) => isAdmin(role) || !ADMIN_ONLY_SCOPES.includes(scope));

  void ApiKey.updateOne({ _id: key._id }, { lastUsedAt: new Date() }).catch(() => {});

  return {
    keyId: String(key._id),
    keyName: key.name,
    scopes,
    user: {
      id: String(user._id),
      name: user.name,
      username: user.username,
      role,
      department: user.department,
      pageAccess: user.pageAccess,
    },
  };
}

export function hasScope(principal: ApiKeyPrincipal, scope: ApiKeyScope): boolean {
  return principal.scopes.includes(scope);
}

export function actorFromApiKey(principal: ApiKeyPrincipal, req?: NextRequest | null): AuditActor {
  return actorFromSession(
    { user: { ...principal.user, name: `${principal.user.name} (via ${principal.keyName})` } },
    req,
  );
}
