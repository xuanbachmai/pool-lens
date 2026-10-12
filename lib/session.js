/*
 * Session and one-time-code primitives.
 *
 * This lives in lib/ rather than api/ for a concrete reason: every file under api/ is built as
 * its own isolated serverless function, and importing one route from another is fragile --
 * api/ask.js importing api/auth.js is what failed the deploy that introduced sign-in. Shared
 * code outside api/ is traced and bundled into whichever functions import it, which is the
 * supported shape.
 *
 * Both halves are derived rather than stored, so the app needs no database:
 *
 *   the code     HMAC(AUTH_SECRET, email + time window), truncated to six digits. Verifying
 *                means recomputing it, so nothing is written down between the two requests.
 *
 *   the session  base64(payload).HMAC(payload) in an httpOnly cookie. The signature is what
 *                makes it trustworthy; the payload is readable but not forgeable.
 *
 * The costs, stated because they should not be discovered later: a code is valid for its whole
 * window rather than for one use, sessions cannot be revoked individually (rotating AUTH_SECRET
 * invalidates all of them), and there is no per-address rate limit because a counter needs
 * somewhere to live. Acceptable for gating a screener; not for anything holding funds.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const WINDOW_SECONDS = 600;              // a code lives ten minutes
export const SESSION_DAYS = 30;
const COOKIE = 'pl_session';

/* ------------------------------------------------------------------ helpers */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hmac(secret, data) {
  return createHmac('sha256', secret).update(data).digest();
}

/** Constant-time compare that cannot throw on a length mismatch. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const normaliseEmail = (e) => String(e || '').trim().toLowerCase();

// Deliberately permissive: the real check is that the code only reaches a working inbox.
export const looksLikeEmail = (e) => /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(e);

/** The six-digit code for an address in a given time window. */
export function codeFor(secret, email, window) {
  const digest = hmac(secret, `otp:${email}:${window}`);
  // Standard HOTP-style dynamic truncation, so every digit comes from the digest.
  const offset = digest[digest.length - 1] & 0x0f;
  const bin = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) |
              (digest[offset + 2] << 8) | digest[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export function currentWindow() { return Math.floor(Date.now() / 1000 / WINDOW_SECONDS); }

/* ----------------------------------------------------------------- sessions */

export function issueSession(secret, email) {
  const payload = b64url(JSON.stringify({
    e: email,
    exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400,
    // Random id so two sessions for one address are distinguishable in logs.
    id: randomBytes(6).toString('hex')
  }));
  return payload + '.' + b64url(hmac(secret, payload));
}

/** @returns the session payload, or null if absent, malformed, unsigned or expired. */
export function readSession(req, secret) {
  const raw = (req.headers?.cookie || '')
    .split(';').map((c) => c.trim())
    .find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;

  const token = decodeURIComponent(raw.slice(COOKIE.length + 1));
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, b64url(hmac(secret, payload)))) return null;

  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return null; }

  if (!data || typeof data.e !== 'string') return null;
  if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}

export function setCookie(res, value, maxAgeSeconds) {
  const bits = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  // Secure everywhere except plain-http local development, where it would stop the cookie.
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}
