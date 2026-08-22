/**
 * Fetches the most recent reply on a conversation, for the "copy last reply
 * to Activity Log" flow.
 *
 * Why this exists as a server route rather than a browser call:
 *
 * The Help Scout sidebar SDK gives us conversation id, subject, tags, status
 * and customers — but no thread bodies and no access to an unsent draft. So a
 * panel cannot read what a BM is currently typing. The nearest useful thing is
 * the last message they actually sent, and that only comes from the Mailbox
 * API, which needs credentials that must never reach the browser.
 *
 * Requires two environment variables, from an OAuth2 app created under
 * Help Scout > My Apps:
 *   HELPSCOUT_APP_ID
 *   HELPSCOUT_APP_SECRET
 */

const TOKEN_URL = 'https://api.helpscout.net/v2/oauth2/token';
const API_BASE = 'https://api.helpscout.net/v2';

const { HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET } = process.env;

// Access tokens last two hours. Cached in module scope so a warm serverless
// instance reuses one rather than authenticating on every request.
let cachedToken = null;
let cachedTokenExpiry = 0;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  const conversationId = String(req.query.conversationId || '').trim();
  if (!conversationId) {
    return sendJson(res, 400, { error: 'Missing conversationId' });
  }

  if (!HELPSCOUT_APP_ID || !HELPSCOUT_APP_SECRET) {
    return sendJson(res, 501, {
      error: 'Help Scout API credentials are not configured',
      details: 'Set HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET to enable copying replies.',
    });
  }

  try {
    const token = await getAccessToken();
    const response = await fetch(`${API_BASE}/conversations/${conversationId}/threads`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      return sendJson(res, response.status, {
        error: 'Could not read the conversation',
        details: `Help Scout returned ${response.status}`,
      });
    }

    const payload = await response.json();
    const threads = payload?._embedded?.threads || [];
    const reply = findLastOutgoingReply(threads);

    if (!reply) {
      return sendJson(res, 200, { reply: null });
    }

    return sendJson(res, 200, { reply });
  } catch (error) {
    return sendJson(res, 500, { error: 'Help Scout lookup failed', details: getErrorMessage(error) });
  }
}

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

  if (!response.ok) {
    throw new Error(`Token request failed with ${response.status}`);
  }

  const payload = await response.json();
  cachedToken = payload.access_token;
  // Expire a minute early so a token cannot lapse mid-request.
  cachedTokenExpiry = now + ((payload.expires_in || 7200) - 60) * 1000;
  return cachedToken;
}

/**
 * The most recent message sent by a team member.
 *
 * Threads come back newest first. We skip notes (internal), customer messages,
 * and system line items like "assigned to" — we want what the guest actually
 * received.
 */
function findLastOutgoingReply(threads) {
  const reply = threads.find(
    (thread) => thread.type === 'message' && thread.createdBy?.type === 'user',
  );

  if (!reply) return null;

  return {
    id: reply.id,
    author: [reply.createdBy?.first, reply.createdBy?.last].filter(Boolean).join(' '),
    createdAt: reply.createdAt,
    text: stripHtml(reply.body || ''),
  };
}

/**
 * Help Scout returns HTML. The Activity Log stores plain text, and quoted
 * history is dropped — a log entry repeating the whole thread is unreadable,
 * and the thread itself is one click away in Help Scout.
 */
function stripHtml(html) {
  return html
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sendJson(res, statusCode, body) {
  if (typeof res.status === 'function') {
    return res.status(statusCode).json(body);
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getErrorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error.message === 'string') return error.message;
  return 'Unknown error';
}
