import crypto from 'crypto';

/**
 * Lightweight signed session for learning-module (employee) logins.
 *
 * This is intentionally separate from the NextAuth admin session: employees are
 * not `User` records and must not gain access to the admin app. We issue our own
 * HMAC-signed token in an httpOnly cookie rather than minting a NextAuth session.
 */

export const LMS_COOKIE = 'lms_session';
const MAX_AGE_SECONDS = 12 * 60 * 60; // 12h

interface LmsTokenPayload {
  sub: string; // employee _id
  name: string;
  exp: number; // unix seconds
  /**
   * The application login (`User._id`) that was signed in when this token was
   * issued, or null for a pure learner sign-in with no app session.
   *
   * The cookie outlives an app sign-out, so without this a leftover token would
   * keep opening the previous person's training record for whoever signs in
   * next on the same browser. `lib/lmsIdentity.ts` rejects the token when this
   * no longer matches the current app session.
   */
  uid?: string | null;
}

function secret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error('NEXTAUTH_SECRET is not set');
  return s;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string): string {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

export function createLmsToken(
  employeeId: string,
  name: string,
  appUserId?: string | null,
): { token: string; maxAge: number } {
  const payload: LmsTokenPayload = {
    sub: employeeId,
    name,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
    uid: appUserId || null,
  };
  const body = b64url(JSON.stringify(payload));
  const token = `${body}.${sign(body)}`;
  return { token, maxAge: MAX_AGE_SECONDS };
}

export type { LmsTokenPayload };

export function verifyLmsToken(token: string | undefined | null): LmsTokenPayload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const expected = sign(body);
  // Constant-time comparison; lengths must match first.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as LmsTokenPayload;
    if (!payload.sub || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
