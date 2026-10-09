/**
 * Proves a request came from the panel running inside Help Scout.
 *
 * Help Scout signs the URL it loads the app with: an X-HelpScout-Signature
 * query parameter holding base64(HMAC-SHA1(secret key, JSON of the other
 * parameters)). The page is static, so the browser hands that query string to
 * /api/session, which checks it here and issues a short-lived token. Every
 * other route can then require the token instead of answering anyone who
 * knows the URL.
 *
 * Limits worth knowing: the signature carries no timestamp, so a leaked panel
 * URL stays valid until the app's secret key is changed in Help Scout. This
 * keeps out anonymous callers; it is not per-user authentication.
 *
 * Help Scout does not document the exact JSON encoding. Six plausible forms
 * were tried until live signatures showed which one it uses: plain
 * JSON.stringify of the other parameters ("json"). Only that one is accepted.
 */

import crypto from 'node:crypto';

const SIGNATURE_PARAM = 'x-helpscout-signature';
// Reported as "matched" so the success log line reads as it always has.
const SIGNED_ENCODING = 'json';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const { HELPSCOUT_SECRET, HELPSCOUT_SECRET_TEST, REQUIRE_SESSION } = process.env;

/**
 * The secret Help Scout signs with. A preview deployment may use a separate
 * HELPSCOUT_SECRET_TEST, so a test app in Help Scout can have its own Content
 * signature key. Everywhere else — production, local dev — that variable is
 * ignored and HELPSCOUT_SECRET is used exactly as before. Never logged.
 */
const SIGNING_SECRET = process.env.VERCEL_ENV === 'preview' && HELPSCOUT_SECRET_TEST
  ? HELPSCOUT_SECRET_TEST
  : HELPSCOUT_SECRET;

export const sessionConfigured = () => Boolean(SIGNING_SECRET);

const sign = (secret, data) => crypto.createHmac('sha1', secret).update(data).digest('base64');

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Checks a raw query string ("?a=1&X-HelpScout-Signature=...").
 * Returns { ok, matched, paramNames, hasSignature } — safe to send to the browser.
 */
export function verifySignedQuery(query, secret = SIGNING_SECRET) {
  const search = new URLSearchParams(String(query || '').replace(/^\?/, ''));
  const params = {};
  let signature = '';

  for (const [key, value] of search) {
    if (key.toLowerCase() === SIGNATURE_PARAM) {
      // A raw "+" in base64 is read as a space by URL decoding.
      signature = value.replace(/ /g, '+');
    } else {
      params[key] = value;
    }
  }

  const result = { ok: false, matched: null, paramNames: Object.keys(params), hasSignature: Boolean(signature) };
  if (!secret || !signature) return result;

  // Help Scout signs the remaining parameters as plain JSON, in the order they
  // appear in the URL, values as strings. Confirmed against live signatures
  // on 2026-10-09; the other encodings this once tried have been removed.
  if (safeEqual(sign(secret, JSON.stringify(params)), signature)) {
    return { ...result, ok: true, matched: SIGNED_ENCODING };
  }
  return result;
}

// ---------------------------------------------------------------- tokens

const tokenKey = () => crypto.createHmac('sha256', SIGNING_SECRET).update('guest-panel-session').digest();
const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

export function issueToken(now = Date.now()) {
  const body = b64url(JSON.stringify({ exp: now + TOKEN_TTL_MS }));
  const mac = b64url(crypto.createHmac('sha256', tokenKey()).update(body).digest());
  return { token: `${body}.${mac}`, expiresAt: now + TOKEN_TTL_MS };
}

export function verifyToken(token, now = Date.now()) {
  if (!SIGNING_SECRET || typeof token !== 'string') return false;
  const [body, mac] = token.split('.');
  if (!body || !mac) return false;

  const expected = b64url(crypto.createHmac('sha256', tokenKey()).update(body).digest());
  if (!safeEqual(expected, mac)) return false;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > now;
  } catch {
    return false;
  }
}

function bearer(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function deny(res, status, error) {
  if (typeof res.status === 'function') return res.status(status).json({ error });
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error }));
  return undefined;
}

/**
 * For routes that must never be public — anything that writes, or reads a
 * conversation. Returns true when the request may proceed; otherwise it has
 * already replied.
 */
export function requireSession(req, res) {
  if (!SIGNING_SECRET) {
    deny(res, 503, 'HELPSCOUT_SECRET is not set, so this route is switched off.');
    return false;
  }
  if (!verifyToken(bearer(req))) {
    deny(res, 401, 'Session missing or expired.');
    return false;
  }
  return true;
}

/**
 * For the routes that were already live and public. A no-op until
 * REQUIRE_SESSION=true is set in Vercel, so turning verification on is a
 * deliberate switch made after the signature check is proven in production —
 * never a side effect of deploying this file.
 */
export function requireSessionIfEnabled(req, res) {
  if (REQUIRE_SESSION !== 'true') return true;
  return requireSession(req, res);
}
