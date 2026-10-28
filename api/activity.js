/**
 * Activity feed — read and write, stored in TRTL.
 *
 * The Activity Log's home is TRTL (decided 28 Oct 2026; see
 * ACTIVITY_LOG_HANDOVER.md). This route passes the panel's requests to TRTL's
 * panel endpoint, server to server, so the TRTL key never reaches the
 * browser. The reply keeps the shape the panel already shows.
 *
 * Requires:
 *   TRTL_PANEL_KEY   the same value as TRTL_PANEL_KEY in TRTL's Vercel
 *                    settings. Server only — never expose to the browser.
 *   TRTL_URL         optional; defaults to https://trtl.leatherbacktravel.com
 *
 * TRTL trusts the author name and email sent here, so REQUIRE_SESSION must be
 * on before this is switched on for BMs.
 */

import { requireSessionIfEnabled } from '../lib/session.js';
import { trtlActivity, trtlConfigured } from '../lib/trtl.js';

export default async function handler(req, res) {
  // No-op until REQUIRE_SESSION=true is set in Vercel. See lib/session.js.
  if (!requireSessionIfEnabled(req, res)) return undefined;
  if (!trtlConfigured()) {
    return sendJson(res, 501, {
      error: 'Activity store is not configured',
      details: 'Set TRTL_PANEL_KEY.',
    });
  }

  if (req.method === 'GET') return listEntries(req, res);
  if (req.method === 'POST') return createEntry(req, res);

  return sendJson(res, 405, { error: 'Method Not Allowed' });
}

async function listEntries(req, res) {
  const customerRef = firstString(req.query.customerRef);
  if (!customerRef) return sendJson(res, 400, { error: 'Need customerRef' });

  try {
    const payload = await trtlActivity({ query: { customerRef } });
    return sendJson(res, 200, { entries: payload.entries || [] });
  } catch (error) {
    return sendJson(res, 502, { error: 'Could not read activity', details: error.message });
  }
}

async function createEntry(req, res) {
  const { customerRef, body, authorName, authorEmail } = req.body || {};

  if (!String(body || '').trim()) {
    return sendJson(res, 400, { error: 'An entry needs a body' });
  }
  if (!customerRef) {
    return sendJson(res, 400, { error: 'An entry needs a customer reference' });
  }

  try {
    const payload = await trtlActivity({
      body: {
        customerRef,
        body: String(body).trim(),
        authorName: String(authorName || '').trim() || 'Unknown',
        ...(authorEmail ? { authorEmail: String(authorEmail).trim() } : {}),
      },
    });
    return sendJson(res, 200, { ok: true, entry: payload.entry });
  } catch (error) {
    return sendJson(res, 502, { error: 'Could not save activity', details: error.message });
  }
}

function firstString(value) {
  if (Array.isArray(value)) return firstString(value[0]);
  return typeof value === 'string' ? value.trim() : '';
}

function sendJson(res, statusCode, body) {
  if (typeof res.status === 'function') {
    return res.status(statusCode).json(body);
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
