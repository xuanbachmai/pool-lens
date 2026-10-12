/*
 * Email sign-in, with a six-digit code.
 *
 * Deliberately stateless, because this app has no database and adding one to hold two short
 * strings would be the largest piece of infrastructure in the project. Both halves are derived
 * rather than stored:
 *
 *   the code     HMAC(AUTH_SECRET, email + time window), truncated to six digits. Verifying
 *                means recomputing it, so nothing has to be written down between the two
 *                requests. The current and previous window both pass, so a code requested at
 *                9:59 still works at 10:01.
 *
 *   the session  a signed token in an httpOnly cookie: base64(payload).HMAC(payload). The
 *                signature is what makes it trustworthy; the payload is readable but not
 *                forgeable without the secret.
 *
 * What that costs, stated plainly because it is the kind of thing that should not be discovered
 * later:
 *
 *   - A code is valid for its whole window rather than for one use. Someone who intercepts a
 *     code can use it until the window closes, and a second attempt with the same code also
 *     works. Single-use needs somewhere to record "used", which is the database this avoids.
 *   - Sessions cannot be revoked one at a time. Rotating AUTH_SECRET invalidates every session
 *     at once, which is the only revocation available here.
 *   - Rate limiting per address needs a counter, so there is none. The window is short and the
 *     code goes only to the address that owns it, which contains the exposure without removing
 *     it.
 *
 * Those are acceptable for gating a yield screener. They would not be acceptable for anything
 * holding funds, and SESSION_STORE below marks where a real store slots in.
 *
 * Needs: AUTH_SECRET (any long random string) and RESEND_API_KEY to actually send mail.
 */
import {
  codeFor, issueSession, readSession, currentWindow, setCookie, normaliseEmail,
  looksLikeEmail, WINDOW_SECONDS, SESSION_DAYS
} from '../lib/session.js';

/* -------------------------------------------------------------------- mail */

/**
 * Send the code. Resend today; the shape is small enough that another sender is a few lines.
 *
 * With no key configured this refuses rather than pretending to have sent something, except in
 * local development where it hands the code back so the flow can be exercised. That branch is
 * guarded on not being a deployment, because returning a sign-in code in an HTTP response is
 * exactly the bug this comment exists to prevent.
 */
async function sendCode(email, code) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.AUTH_FROM_EMAIL || 'Pool Lens <onboarding@resend.dev>';

  if (!key) {
    const isDeployed = !!process.env.VERCEL;
    if (isDeployed) {
      return { ok: false, reason: 'RESEND_API_KEY is not set on this deployment, so no email ' +
        'could be sent. Add it in the project settings, or sign-in cannot complete.' };
    }
    return { ok: true, devCode: code };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `${code} is your Pool Lens sign-in code`,
      text: `Your sign-in code is ${code}.\n\n` +
            `It works for the next ten minutes. If you did not ask to sign in, ignore this ` +
            `message — nobody can sign in without the code.`
    })
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.message || ''; } catch { /* body is not json */ }
    return { ok: false, reason: `The email provider returned HTTP ${res.status}. ${detail}`.trim() };
  }
  return { ok: true };
}

/* ----------------------------------------------------------------- handler */

export default async function handler(req, res) {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    return res.status(500).json({
      error: 'not_configured',
      message: 'AUTH_SECRET is not set on this deployment, or is too short. Sign-in needs a ' +
        'long random string there before it can work.'
    });
  }

  const action = String(req.query?.action || '');

  if (action === 'me') {
    const s = readSession(req, secret);
    return res.status(200).json({ signedIn: !!s, email: s ? s.e : null,
      expiresAt: s ? s.exp : null });
  }

  if (action === 'signout') {
    setCookie(res, '', 0);
    return res.status(200).json({ signedIn: false });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method', message: 'Use POST.' });
  }

  const email = normaliseEmail(req.body?.email);
  if (!looksLikeEmail(email)) {
    return res.status(400).json({ error: 'bad_email',
      message: 'That does not look like an email address.' });
  }

  if (action === 'request') {
    const code = codeFor(secret, email, currentWindow());
    const sent = await sendCode(email, code);
    if (!sent.ok) {
      return res.status(502).json({ error: 'send_failed', message: sent.reason });
    }
    return res.status(200).json({
      ok: true,
      message: 'Check your email for a six-digit code. It works for ten minutes.',
      // Present only when running locally with no mail provider configured.
      devCode: sent.devCode
    });
  }

  if (action === 'verify') {
    const given = String(req.body?.code || '').replace(/\D/g, '');
    if (given.length !== 6) {
      return res.status(400).json({ error: 'bad_code', message: 'Enter the six-digit code.' });
    }
    const now = currentWindow();
    // The previous window too, so a code that arrives near the boundary still works.
    const ok = safeEqual(given, codeFor(secret, email, now)) ||
               safeEqual(given, codeFor(secret, email, now - 1));
    if (!ok) {
      return res.status(401).json({ error: 'wrong_code',
        message: 'That code is wrong or has expired. Request a new one.' });
    }
    setCookie(res, issueSession(secret, email), SESSION_DAYS * 86400);
    return res.status(200).json({ signedIn: true, email });
  }

  return res.status(400).json({ error: 'bad_action',
    message: 'action must be one of: request, verify, me, signout.' });
}
