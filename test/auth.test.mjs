/*
 * Tests for email sign-in.
 *
 * This is the only part of the app where a bug is a security bug rather than a wrong number,
 * so the tests are adversarial: they try to forge a session, replay a tampered one, present a
 * code for a different address, and reuse one past its window. A test that only checks the
 * happy path would pass against an implementation that accepted anything.
 */
import { codeFor, issueSession, readSession, currentWindow } from '../api/auth.js';
import { suite, check, report } from './harness.mjs';

const SECRET = 'test-secret-that-is-long-enough-to-be-accepted';
const OTHER = 'a-completely-different-secret-value-here';
const EMAIL = 'someone@example.com';

/** A fake request carrying one cookie, which is all readSession looks at. */
const reqWith = (token) => ({ headers: { cookie: 'pl_session=' + encodeURIComponent(token) } });

/* -------------------------------------------------------------------- codes */

suite('auth codes');
{
  const w = currentWindow();
  const code = codeFor(SECRET, EMAIL, w);
  check('a code is six digits', /^\d{6}$/.test(code), code);
  check('and is stable for the same inputs', codeFor(SECRET, EMAIL, w) === code);
  check('a different address gets a different code',
    codeFor(SECRET, 'other@example.com', w) !== code);
  check('a different window gets a different code', codeFor(SECRET, EMAIL, w + 1) !== code);
  check('a different secret gets a different code', codeFor(OTHER, EMAIL, w) !== code);
}
{
  // Every digit should come from the digest; a truncation bug often pins the leading ones.
  const w = currentWindow();
  const codes = [];
  for (let i = 0; i < 300; i++) codes.push(codeFor(SECRET, 'u' + i + '@example.com', w));
  check('codes are not all the same', new Set(codes).size > 290, new Set(codes).size + ' distinct');
  const leading = new Set(codes.map((c) => c[0]));
  check('the leading digit varies', leading.size >= 8, [...leading].join(''));
  check('codes use the whole range',
    codes.some((c) => c[0] === '0') && codes.some((c) => parseInt(c, 10) > 900000));
}

/* ----------------------------------------------------------------- sessions */

suite('auth sessions');
{
  const token = issueSession(SECRET, EMAIL);
  const s = readSession(reqWith(token), SECRET);
  check('a fresh session reads back', s !== null);
  check('and carries the address', s.e === EMAIL);
  check('and expires in the future', s.exp > Math.floor(Date.now() / 1000));
  check('two sessions for one address differ',
    issueSession(SECRET, EMAIL) !== issueSession(SECRET, EMAIL));
}

suite('auth forgery');
{
  const token = issueSession(SECRET, EMAIL);
  const [payload, sig] = [token.slice(0, token.lastIndexOf('.')), token.slice(token.lastIndexOf('.') + 1)];

  check('no cookie means no session', readSession({ headers: {} }, SECRET) === null);
  check('an empty cookie jar means no session',
    readSession({ headers: { cookie: '' } }, SECRET) === null);
  check('a session signed with another secret is refused',
    readSession(reqWith(token), OTHER) === null);
  check('an unsigned payload is refused', readSession(reqWith(payload), SECRET) === null);
  check('a payload with no signature separator is refused',
    readSession(reqWith('justsomegarbage'), SECRET) === null);
  check('a truncated signature is refused',
    readSession(reqWith(payload + '.' + sig.slice(0, -4)), SECRET) === null);
  check('a signature from a different session is refused',
    readSession(reqWith(payload + '.' + issueSession(SECRET, 'x@example.com').split('.')[1]),
      SECRET) === null);
}
{
  /*
   * The attack that matters: edit the address in the payload and keep the old signature. If
   * this passed, anyone could sign in as anyone.
   */
  const token = issueSession(SECRET, EMAIL);
  const dot = token.lastIndexOf('.');
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  decoded.e = 'attacker@example.com';
  const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url');

  check('swapping the address invalidates the signature',
    readSession(reqWith(forged + '.' + sig), SECRET) === null);

  // And extending the expiry the same way.
  const extended = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  extended.exp = extended.exp + 86400 * 3650;
  const forged2 = Buffer.from(JSON.stringify(extended)).toString('base64url');
  check('extending the expiry invalidates the signature',
    readSession(reqWith(forged2 + '.' + sig), SECRET) === null);
}
{
  // An expired session must be refused even though its signature is perfectly valid.
  const past = Buffer.from(JSON.stringify({
    e: EMAIL, exp: Math.floor(Date.now() / 1000) - 60, id: 'aaaaaa'
  })).toString('base64url');
  const { createHmac } = await import('node:crypto');
  const sig = createHmac('sha256', SECRET).update(past).digest().toString('base64url');
  const s = readSession(reqWith(past + '.' + sig), SECRET);
  check('a correctly signed but expired session is refused', s === null);

  // The same payload still inside its window must pass, or the test above proves nothing.
  const live = Buffer.from(JSON.stringify({
    e: EMAIL, exp: Math.floor(Date.now() / 1000) + 60, id: 'aaaaaa'
  })).toString('base64url');
  const sig2 = createHmac('sha256', SECRET).update(live).digest().toString('base64url');
  check('and the same shape inside its window passes',
    readSession(reqWith(live + '.' + sig2), SECRET) !== null);
}
{
  // Malformed payloads must return null rather than throwing, which would 500 the endpoint.
  const { createHmac } = await import('node:crypto');
  const sign = (p) => p + '.' + createHmac('sha256', SECRET).update(p).digest().toString('base64url');
  const notJson = Buffer.from('this is not json').toString('base64url');
  const noEmail = Buffer.from(JSON.stringify({ exp: 9e9 })).toString('base64url');
  const nullish = Buffer.from(JSON.stringify(null)).toString('base64url');

  check('a signed non-JSON payload is refused, not thrown',
    readSession(reqWith(sign(notJson)), SECRET) === null);
  check('a signed payload with no address is refused',
    readSession(reqWith(sign(noEmail)), SECRET) === null);
  check('a signed null payload is refused', readSession(reqWith(sign(nullish)), SECRET) === null);
}
{
  // Other cookies on the same host must not confuse it.
  const token = issueSession(SECRET, EMAIL);
  const req = { headers: { cookie: 'other=1; pl_session=' + encodeURIComponent(token) + '; x=2' } };
  check('the session is found among other cookies', readSession(req, SECRET) !== null);
  const decoy = { headers: { cookie: 'not_pl_session=' + encodeURIComponent(token) } };
  check('a similarly named cookie is not mistaken for it', readSession(decoy, SECRET) === null);
}

report();
