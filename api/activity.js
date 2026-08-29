/**
 * Activity feed — read and write.
 *
 * Backed by Postgres (Supabase) rather than Airtable, because the feed is
 * append-only and unbounded. See db/schema.sql for the reasoning.
 *
 * Reached over Supabase's REST interface rather than a Postgres driver, for
 * two reasons: no dependency to add, and no connection pool to exhaust. Every
 * Vercel invocation is a separate process, and direct Postgres connections
 * from serverless functions run out of pool long before they run out of load.
 *
 * Requires:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (server only — never expose to the browser)
 */

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

const TABLE = 'activity_entries';
const SOURCE = 'helpscout';

export default async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(res, 501, {
      error: 'Activity store is not configured',
      details: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    });
  }

  if (req.method === 'GET') return listEntries(req, res);
  if (req.method === 'POST') return createEntry(req, res);
  if (req.method === 'DELETE') return softDeleteEntry(req, res);

  return sendJson(res, 405, { error: 'Method Not Allowed' });
}

async function listEntries(req, res) {
  const customerRef = String(req.query.customerRef || '').trim();
  const email = normaliseEmail(req.query.email);

  if (!customerRef && !email) {
    return sendJson(res, 400, { error: 'Need customerRef or email' });
  }

  // Matched on either identifier, so entries survive the Airtable -> TRTL
  // change of customer_ref meaning.
  const identityFilter = [
    customerRef ? `customer_ref.eq.${encodeURIComponent(customerRef)}` : null,
    email ? `customer_email.eq.${encodeURIComponent(email)}` : null,
  ].filter(Boolean).join(',');

  const params = new URLSearchParams({
    select: '*',
    deleted_at: 'is.null',
    order: 'occurred_at.desc',
    limit: '200',
  });
  params.set('or', `(${identityFilter})`);

  try {
    const rows = await supabase(`/${TABLE}?${params}`);
    return sendJson(res, 200, { entries: rows.map(shapeEntry) });
  } catch (error) {
    return sendJson(res, 500, { error: 'Could not read activity', details: error.message });
  }
}

async function createEntry(req, res) {
  const {
    customerRef,
    customerEmail,
    bookingRef,
    body,
    type,
    authorName,
    authorEmail,
    sourceRef,
    occurredAt,
    metadata,
  } = req.body || {};

  if (!String(body || '').trim()) {
    return sendJson(res, 400, { error: 'An entry needs a body' });
  }

  if (!customerRef && !customerEmail) {
    return sendJson(res, 400, { error: 'An entry needs a customer reference or email' });
  }

  const row = {
    customer_ref: customerRef || null,
    customer_email: normaliseEmail(customerEmail) || null,
    booking_ref: bookingRef || null,
    type: type || 'note',
    body: String(body).trim(),
    author_name: authorName || null,
    author_email: authorEmail || null,
    source: SOURCE,
    source_ref: sourceRef || null,
    occurred_at: occurredAt || new Date().toISOString(),
    metadata: metadata || {},
  };

  try {
    // merge-duplicates makes a repeated write with the same source_ref update
    // rather than duplicate — which is what stops a double-clicked "copy last
    // reply" appearing twice.
    const rows = await supabase(`/${TABLE}`, {
      method: 'POST',
      body: JSON.stringify(row),
      headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
    });

    return sendJson(res, 200, { ok: true, entry: shapeEntry(rows[0]) });
  } catch (error) {
    return sendJson(res, 500, { error: 'Could not save activity', details: error.message });
  }
}

async function softDeleteEntry(req, res) {
  const id = String(req.query.id || '').trim();
  if (!id) return sendJson(res, 400, { error: 'Missing id' });

  try {
    await supabase(`/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ deleted_at: new Date().toISOString() }),
    });
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 500, { error: 'Could not remove entry', details: error.message });
  }
}

async function supabase(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text.slice(0, 300)}`);
  }

  return text ? JSON.parse(text) : [];
}

function shapeEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    body: row.body,
    author: row.author_name || '',
    source: row.source,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function normaliseEmail(value) {
  if (Array.isArray(value)) return normaliseEmail(value[0]);
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function sendJson(res, statusCode, body) {
  if (typeof res.status === 'function') {
    return res.status(statusCode).json(body);
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
