import crypto from 'crypto';

const SECRET = process.env.DOCX_VIEWER_SECRET || process.env.NEXTAUTH_SECRET || 'sop-lms-media-secret';
const TTL_MS = 30 * 60 * 1000;

type Payload = { url: string; exp: number };

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Buffer {
  const pad = 4 - (str.length % 4);
  const b64 = (str + (pad === 4 ? '' : '='.repeat(pad))).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

/** Short-lived HMAC token so LMS iframes never point at a raw CDN download URL. */
export function signLmsMediaToken(url: string): string {
  const payload: Payload = { url: String(url || '').trim(), exp: Date.now() + TTL_MS };
  const data = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest();
  return `${b64url(Buffer.from(data, 'utf8'))}.${b64url(sig)}`;
}

export function verifyLmsMediaToken(token: string): string | null {
  try {
    const [raw, sig] = String(token || '').split('.');
    if (!raw || !sig) return null;
    const data = b64urlDecode(raw).toString('utf8');
    const expected = b64url(crypto.createHmac('sha256', SECRET).update(data).digest());
    if (expected !== sig) return null;
    const payload = JSON.parse(data) as Payload;
    if (!payload.url || payload.exp < Date.now()) return null;
    if (!/^https?:\/\//i.test(payload.url)) return null;
    return payload.url;
  } catch {
    return null;
  }
}
