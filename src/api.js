/**
 * Calls to the panel's own /api routes, carrying the Help Scout session.
 *
 * Help Scout signs the URL it loads the panel with. That query string is
 * exchanged once for a short-lived token (see lib/session.js) and the token
 * rides on every request. Routes that existed before the session did still
 * answer without it until REQUIRE_SESSION is switched on, so a failed
 * handshake costs the lead form and nothing else.
 */

let token = null;
let handshake = null;
let lastFailure = '';

/** Resolves to true when a session is held. Safe to call repeatedly. */
export function startSession() {
  if (!handshake) {
    handshake = fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: window.location.search }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (response.ok && body.token) {
          token = body.token;
          lastFailure = '';
          return true;
        }
        token = null;
        lastFailure = describeFailure(response.status, body);
        return false;
      })
      .catch(() => {
        token = null;
        lastFailure = 'The panel could not reach its server.';
        return false;
      });
  }
  return handshake;
}

/** Why there is no session, in words a BM can pass on. Empty when there is one. */
export function sessionFailure() {
  return lastFailure;
}

function describeFailure(status, body) {
  if (status === 503) return 'Not switched on yet (HELPSCOUT_SECRET is missing in Vercel).';
  if (body?.hasSignature === false) return 'Help Scout did not sign this page, so the panel cannot prove where it is running.';
  if (status === 401) return 'Help Scout’s signature did not match the secret key in Vercel.';
  return body?.error || 'The session could not be started.';
}

/** fetch() for /api routes. Renews the session once if the token has lapsed. */
export async function apiFetch(url, options = {}, retried = false) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { ...options, headers });
  if (response.status !== 401 || retried) return response;

  // A token was sent and refused, so it has lapsed: ask for a new one.
  // No token sent means the first handshake is still in flight — wait for it.
  if (headers.Authorization) handshake = null;
  return (await startSession()) ? apiFetch(url, options, true) : response;
}
