import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Random opaque tokens (stored hashed) and short-lived HMAC-signed payloads for multi-step flows. */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Signs a small JSON payload with an expiry. Used for the TOTP step, OIDC state and consent forms. */
export function signPayload(key: Buffer, payload: Record<string, unknown>, ttlMs: number, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: nowMs + ttlMs })).toString('base64url');
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyPayload<T extends Record<string, unknown>>(
  key: Buffer,
  token: string | undefined,
  nowMs = Date.now(),
): T | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(createHmac('sha256', key).update(body).digest('base64url'));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
    if (typeof payload.exp !== 'number' || payload.exp < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
