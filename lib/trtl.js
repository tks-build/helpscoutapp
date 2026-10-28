/**
 * Server-side calls to TRTL's panel endpoint, where the Activity Log lives.
 *
 * Requires TRTL_PANEL_KEY (the same value as in TRTL's Vercel settings).
 * TRTL_URL is optional and defaults to the live TRTL. Never log the key or
 * the Authorization header.
 */

const ENDPOINT = '/api/panel/activity';

export function trtlConfigured() {
  return Boolean(process.env.TRTL_PANEL_KEY);
}

/** Calls TRTL's panel endpoint. `query` is for GET; `body` makes it a POST. */
export async function trtlActivity({ query, body } = {}) {
  const base = (process.env.TRTL_URL || 'https://trtl.leatherbacktravel.com').replace(/\/+$/, '');
  const search = query ? `?${new URLSearchParams(query)}` : '';
  const response = await fetch(`${base}${ENDPOINT}${search}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${process.env.TRTL_PANEL_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`TRTL ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}
