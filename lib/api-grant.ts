import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { headers } from "next/headers";
import type { Session } from "next-auth";
import { hasScope, verifyApiKeyId } from "@/lib/api-keys";

/**
 * Lets the MCP `call_api` tool reach the regular session-protected GET routes
 * as the API key's owner. The grant is minted server-side for a single GET
 * request and never shown to the bot, so it cannot be replayed on write routes.
 */
export const API_GRANT_HEADER = "x-sop-api-grant";
const GRANT_TTL_MS = 60_000;

function sign(payload: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not set");
  return createHmac("sha256", secret).update(`api-grant:${payload}`).digest("base64url");
}

export function signApiGrant(keyId: string): string {
  const payload = `${keyId}.${Date.now() + GRANT_TTL_MS}.${randomBytes(8).toString("hex")}`;
  return `${payload}.${sign(payload)}`;
}

export async function sessionFromApiGrant(): Promise<Session | null> {
  let grant: string | null = null;
  try {
    grant = (await headers()).get(API_GRANT_HEADER);
  } catch {
    return null;
  }
  if (!grant) return null;

  const cut = grant.lastIndexOf(".");
  if (cut <= 0) return null;
  const payload = grant.slice(0, cut);
  const signature = Buffer.from(grant.slice(cut + 1));
  const expected = Buffer.from(sign(payload));
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;

  const [keyId, expiresAt] = payload.split(".");
  if (!(Number(expiresAt) > Date.now())) return null;

  const principal = await verifyApiKeyId(keyId);
  if (!principal || !hasScope(principal, "api:read")) return null;
  return { user: principal.user, expires: new Date(Number(expiresAt)).toISOString() };
}
