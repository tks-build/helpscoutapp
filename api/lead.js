/**
 * The HelpScout Extractor extension's "add / update customer" form, server-side.
 *
 *   GET  /api/lead   the form's options: trips, tags, team members, statuses
 *   POST /api/lead   submit — forwards to the same two Zapier catch hooks the
 *                    extension called, with the same body (lib/leadPayload.js)
 *
 * The extension kept an Airtable token and both hook URLs in files on every
 * BM's machine. Here they are Vercel environment variables:
 *   ZAPIER_CREATE_CUSTOMER_HOOK, ZAPIER_UPDATE_CUSTOMER_HOOK
 *
 * Nothing here writes to Airtable directly, and nothing writes to Help Scout.
 * The Zaps do the writing, exactly as before.
 *
 * Set LEAD_DRY_RUN=true (e.g. on Preview) to validate and echo the payload
 * without calling Zapier — preview deployments share the live Zaps, so a
 * real submit from a preview creates a real customer.
 */

import Airtable from 'airtable';
import { LEAD_STATUSES, buildLeadPayload } from '../lib/leadPayload.js';
import { requireSession } from '../lib/session.js';

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  TABLE_CUSTOMERS,
  TABLE_TRIPS,
  TABLE_BOOKING_MANAGERS,
  TABLE_BOOKING_CRM,
  TABLE_LEADS,
  AIRTABLE_CUSTOMERS_EMAIL_FIELD = 'Client Email',
  ZAPIER_CREATE_CUSTOMER_HOOK,
  ZAPIER_UPDATE_CUSTOMER_HOOK,
  LEAD_DRY_RUN,
  // The view the extension read its trip list from.
  LEAD_TRIPS_VIEW = 'HelpScout Extension[All Trips]',
} = process.env;

const FIELDS = {
  tripTitle: 'Trip Title & Code',
  teamMemberName: 'Name',
  // Multi-select on Booking CRM; its choices are the tag list.
  leadTags: 'D-Future-Trip-Tags',
};

const OPTIONS_TTL_MS = 10 * 60 * 1000;
let optionsCache = null;
let optionsCacheExpiry = 0;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (!requireSession(req, res)) return undefined;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Airtable environment variables are not configured' });
  }

  const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await loadOptions(base));
    }
    return await submit(base, req, res);
  } catch (error) {
    console.error('Lead route failed', error?.message);
    return res.status(500).json({ error: 'Something went wrong', details: error?.message || 'Unknown error' });
  }
}

// ------------------------------------------------------------------ options

/**
 * Three reads, cached for ten minutes so a busy inbox does not spend the
 * base's 5-requests-per-second allowance on dropdown contents. Each list
 * fails on its own: a missing view or token scope empties one dropdown and
 * says why, rather than taking the form down.
 */
async function loadOptions(base) {
  const now = Date.now();
  if (optionsCache && now < optionsCacheExpiry) return optionsCache;

  const warnings = [];
  const attempt = async (label, load) => {
    try {
      return await load();
    } catch (error) {
      console.warn(`${label} could not be loaded`, error?.message);
      warnings.push(`${label} could not be loaded.`);
      return [];
    }
  };

  const [trips, teamMembers, tags] = await Promise.all([
    attempt('Trips', async () => {
      const records = await base(TABLE_TRIPS).select({ view: LEAD_TRIPS_VIEW, fields: [FIELDS.tripTitle] }).all();
      return records
        .map((record) => ({ id: record.id, name: String(record.get(FIELDS.tripTitle) || '').trim() }))
        .filter((trip) => trip.name);
    }),
    attempt('Team contacts', async () => {
      const records = await base(TABLE_BOOKING_MANAGERS).select({ fields: [FIELDS.teamMemberName] }).all();
      return records
        .map((record) => ({ id: record.id, name: String(record.get(FIELDS.teamMemberName) || '').trim() }))
        .filter((member) => member.name)
        .sort((a, b) => a.name.localeCompare(b.name));
    }),
    attempt('Tags', loadTagChoices),
  ]);

  optionsCache = {
    trips,
    teamMembers,
    tags,
    statuses: LEAD_STATUSES,
    warnings,
    dryRun: LEAD_DRY_RUN === 'true',
  };
  // A partial result is retried sooner than a complete one.
  optionsCacheExpiry = now + (warnings.length ? 60 * 1000 : OPTIONS_TTL_MS);
  return optionsCache;
}

/**
 * Tag names are the choices of a multi-select field, which only the schema
 * endpoint exposes. Needs the schema.bases:read scope on the Airtable token.
 */
async function loadTagChoices() {
  const response = await fetch(`https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Airtable schema request returned ${response.status}`);

  const { tables = [] } = await response.json();
  const leadTable = TABLE_BOOKING_CRM || TABLE_LEADS;
  const table = tables.find((item) => item.id === leadTable || item.name === leadTable) || tables.find((item) => item.name === 'Booking CRM');
  const field = table?.fields.find((item) => item.name === FIELDS.leadTags);
  if (!field) throw new Error(`Field ${FIELDS.leadTags} not found`);

  return (field.options?.choices || []).map((choice) => choice.name).filter(Boolean);
}

// ------------------------------------------------------------------- submit

async function submit(base, req, res) {
  const { payload, action, error } = buildLeadPayload(req.body || {});
  if (error) return res.status(400).json({ error });

  // The extension matched emails exactly, so a stray space or capital made an
  // existing guest look new and created a duplicate. Check once more here,
  // and send the BM to the real record instead of guessing which fields to
  // overwrite on it.
  if (action === 'create') {
    const existing = await findCustomerByEmail(base, payload['Client Email']);
    if (existing) {
      return res.status(409).json({
        error: 'A customer with this email already exists.',
        existingEmail: payload['Client Email'],
      });
    }
  }

  if (LEAD_DRY_RUN === 'true') {
    return res.status(200).json({ ok: true, action, dryRun: true, payload });
  }

  const hook = action === 'create' ? ZAPIER_CREATE_CUSTOMER_HOOK : ZAPIER_UPDATE_CUSTOMER_HOOK;
  if (!hook || !hook.startsWith('https://hooks.zapier.com/')) {
    return res.status(503).json({ error: `The Zapier hook for "${action}" is not configured.` });
  }

  const response = await fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error(`Zapier ${action} hook returned ${response.status}`);
    return res.status(502).json({ error: `Zapier did not accept the ${action} (HTTP ${response.status}).` });
  }

  return res.status(200).json({ ok: true, action });
}

const formulaString = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function findCustomerByEmail(base, email) {
  if (!TABLE_CUSTOMERS) return null;
  const needle = formulaString(email.trim().toLowerCase());
  const formulaFor = (names) => `OR(${names.map((name) => `LOWER(TRIM({${name}})) = ${needle}`).join(', ')})`;
  const run = (names) => base(TABLE_CUSTOMERS).select({ maxRecords: 1, filterByFormula: formulaFor(names) }).firstPage();

  let records;
  try {
    records = await run([AIRTABLE_CUSTOMERS_EMAIL_FIELD, 'Alt Email', 'Alt Email 2']);
  } catch {
    // Same fallback as the panel: an alternate-email field that does not
    // exist fails the whole formula.
    records = await run([AIRTABLE_CUSTOMERS_EMAIL_FIELD]);
  }
  return records[0] || null;
}
