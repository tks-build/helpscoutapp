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
 * Help Scout does not document the exact JSON encoding, so the plausible
 * forms are all tried. Which one matched is reported (never the secret or the
 * signature) so the encoding can be pinned down from a preview deployment.
 */

import crypto from 'node:crypto';

const SIGNATURE_PARAM = 'x-helpscout-signature';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const { HELPSCOUT_SECRET, REQUIRE_SESSION } = process.env;

export const sessionConfigured = () => Boolean(HELPSCOUT_SECRET);

/** PHP's json_encode escapes "/" and non-ASCII; Help Scout's examples are PHP. */
const phpJson = (value) => JSON.stringify(value)
  .replace(/\//g, '\\/')
  .replace(/[\u0080-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

const numeric = (params) => Object.fromEntries(
  Object.entries(params).map(([key, value]) => [key, /^-?\d+$/.test(value) && value.length < 16 ? Number(value) : value]),
);

function candidates(params) {
  const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
  return [
    ['json', JSON.stringify(params)],
    ['json-php', phpJson(params)],
    ['json-numeric', JSON.stringify(numeric(params))],
    ['json-numeric-php', phpJson(numeric(params))],
    ['json-sorted', JSON.stringify(sorted)],
    ['json-sorted-php', phpJson(sorted)],
  ];
}

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
export function verifySignedQuery(query, secret = HELPSCOUT_SECRET) {
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

  for (const [name, data] of candidates(params)) {
    if (safeEqual(sign(secret, data), signature)) {
      return { ...result, ok: true, matched: name };
    }
  }
  return result;
}

// ---------------------------------------------------------------- tokens

const tokenKey = () => crypto.createHmac('sha256', HELPSCOUT_SECRET).update('guest-panel-session').digest();
const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

export function issueToken(now = Date.now()) {
  const body = b64url(JSON.stringify({ exp: now + TOKEN_TTL_MS }));
  const mac = b64url(crypto.createHmac('sha256', tokenKey()).update(body).digest());
  return { token: `${body}.${mac}`, expiresAt: now + TOKEN_TTL_MS };
}

export function verifyToken(token, now = Date.now()) {
  if (!HELPSCOUT_SECRET || typeof token !== 'string') return false;
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
  if (!HELPSCOUT_SECRET) {
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
