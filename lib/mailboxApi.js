/**
 * Minimal Help Scout Mailbox API client: an OAuth2 client-credentials token
 * and one read. Used to fetch a conversation's threads, because the sidebar
 * payload carries no message bodies.
 *
 * Needs HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET (an OAuth2 app under
 * Help Scout > Profile > My Apps). Server only.
 */

const TOKEN_URL = 'https://api.helpscout.net/v2/oauth2/token';
const API_BASE = 'https://api.helpscout.net/v2';

const { HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET } = process.env;

export const mailboxApiConfigured = () => Boolean(HELPSCOUT_APP_ID && HELPSCOUT_APP_SECRET);

// Tokens last two hours. Cached so a warm function authenticates once.
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) return cachedToken;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: HELPSCOUT_APP_ID,
      client_secret: HELPSCOUT_APP_SECRET,
    }),
  });
  if (!response.ok) throw new Error(`Help Scout token request failed with ${response.status}`);

  const payload = await response.json();
  cachedToken = payload.access_token;
  // Expire a minute early so a token cannot lapse mid-request.
  cachedTokenExpiry = now + ((payload.expires_in || 7200) - 60) * 1000;
  return cachedToken;
}

/** Threads for a conversation, newest first, as Help Scout returns them. */
export async function fetchThreads(conversationId) {
  const token = await getAccessToken();
  const response = await fetch(`${API_BASE}/conversations/${encodeURIComponent(conversationId)}/threads`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const error = new Error(`Help Scout returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  return payload?._embedded?.threads || [];
}
