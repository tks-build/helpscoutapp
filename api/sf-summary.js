/**
 * Weekly SF "Good to know" generator.
 *
 * Reads each guest's About Guest note and their post-trip feedback, writes a
 * short paragraph into SF Summary. The panel displays that field; nothing has
 * been writing to it until now, which is why the section has been empty for
 * guests who plainly have history.
 *
 * Runs on a schedule rather than on demand, deliberately:
 *   - generating on panel load would mean a model call every time a BM opens a
 *     conversation, and two BMs would see different text for the same guest
 *   - the field is stored in Airtable, so Stacker and later TRTL get it free
 *
 * Processes a bounded batch per run and picks up where it left off, so it
 * cannot exceed the function timeout however many customers exist.
 *
 * Environment:
 *   ANTHROPIC_API_KEY  required
 *   CRON_SECRET        required in production; Vercel sends it as a bearer token
 *   SF_BATCH_SIZE      optional, defaults to 25
 */

import Airtable from 'airtable';

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  TABLE_CUSTOMERS,
  TABLE_BOOKINGS,
  ANTHROPIC_API_KEY,
  CRON_SECRET,
  SF_BATCH_SIZE,
} = process.env;

const MODEL = 'claude-haiku-4-5-20251001';
const BATCH_SIZE = Number(SF_BATCH_SIZE) || 25;
/**
 * Backfill only, by decision: every guest gets a summary once, and nothing is
 * regenerated afterwards until a refresh policy is agreed.
 *
 * That makes this job self-terminating. Once every guest has been looked at,
 * the queue is empty and each run costs one Airtable query and nothing else,
 * so the schedule can be left in place harmlessly.
 *
 * The refresh logic to add later, when it is settled, is: regenerate when the
 * customer record or any of their bookings has changed since SF Summary
 * Checked. That needs a rollup on Customers of MAX(Bookings -> Last Modified
 * Time), because feedback lives on bookings and editing one does not touch the
 * customer record — which is exactly when a summary goes stale.
 */

// Leave headroom under the function timeout so a slow run finishes cleanly
// rather than being killed mid-write.
const TIME_BUDGET_MS = 45000;

/** Guests handled in parallel. Kept low so Airtable stays under 5 req/sec. */
const CONCURRENCY = 3;

const FIELDS = {
  aboutGuest: 'About Guest',
  summary: 'SF Summary',
  summaryUpdated: 'SF Summary Updated',
  preferredName: 'Preferred Name',
  bookings: 'Bookings',
  pastTrips: 'Past Trips #',
  // Stamped on every attempt, including ones that produce nothing. Without it
  // a guest with no material stays blank and is retried every run forever,
  // consuming a batch slot and a model call each time.
  summaryChecked: 'SF Summary Checked',
};

/** Feedback fields read from each booking, in the order they are given to the model. */
const FEEDBACK_FIELDS = [
  ['Trip', 'Trip Title'],
  ['Internal rating', 'Internal Rating out of 5'],
  ['Summary', 'Summary & Other Feedback'],
  ['Guide', 'Guide Feedback'],
  ['Accommodation', 'Accommodation Feedback'],
  ['Food', 'Food Feedback'],
  ['Activities', 'Activities Feedback'],
  ['Destination', 'Destination Feedback'],
  ['Pace', 'Pace of Trip'],
  ['Group dynamics', 'Group Dynamics Comments'],
  ['Guest suggestions', 'Guest Suggestions'],
  ['Other comments', 'Other Comments'],
];

const SYSTEM_PROMPT = `You write short internal notes that help a travel Booking Manager prepare for a phone call with a guest.

You are given a guest's "About Guest" note and the feedback they gave after previous trips. Write one paragraph, 40-80 words, telling the BM what they need to know before speaking to this person.

Rules:
- Write only what the source material supports. Never invent preferences, traits or history.
- Prefer patterns that repeat across trips over one-off remarks.
- Lead with anything that changes how the BM should sell or serve: what they consistently love, what they complain about, how they like to be contacted, who they travel with.
- Plain British English. No headings, no bullet points, no preamble, no sign-off.
- Write about the guest, not about the feedback. Not "feedback indicates the guest enjoyed" but "loves a long rail day".
- If the material is too thin to say anything useful, reply with exactly: INSUFFICIENT`;

export default async function handler(req, res) {
  if (!isAuthorised(req)) {
    return sendJson(res, 401, { error: 'Unauthorised' });
  }

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !TABLE_CUSTOMERS || !TABLE_BOOKINGS) {
    return sendJson(res, 500, { error: 'Airtable environment variables are not configured' });
  }

  if (!ANTHROPIC_API_KEY) {
    return sendJson(res, 501, { error: 'ANTHROPIC_API_KEY is not set' });
  }

  const startedAt = Date.now();
  const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

  const stats = { considered: 0, written: 0, insufficient: 0, failed: 0, skipped: 0 };

  try {
    const customers = await findCustomersNeedingSummary(base);
    stats.considered = customers.length;

    // Processed a few at a time. Each guest is mostly waiting — on Airtable,
    // then on the model — so running them strictly one after another leaves
    // the function idle for most of its budget. Kept low so the Airtable
    // calls underneath stay within five requests a second.
    const queue = [...customers];

    const worker = async () => {
      while (queue.length) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) return;
        const customer = queue.shift();
        if (!customer) return;

        await processCustomer(base, customer, stats);
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    stats.skipped = queue.length;

    return sendJson(res, 200, { ok: true, ...stats });
  } catch (error) {
    console.error('SF summary run failed', getErrorMessage(error));
    return sendJson(res, 500, { error: 'Run failed', details: getErrorMessage(error) });
  }
}

async function processCustomer(base, customer, stats) {
  const today = new Date().toISOString().slice(0, 10);

  try {
    const material = await gatherMaterial(base, customer);

    // Nothing to summarise. The summary stays blank — the panel shows nothing
    // rather than "no information available" — but the guest is still marked
    // as checked so they leave the queue.
    if (!material) {
      await base(TABLE_CUSTOMERS).update(customer.id, { [FIELDS.summaryChecked]: today });
      stats.insufficient += 1;
      return;
    }

    const summary = await generateSummary(material);

    if (!summary || summary === 'INSUFFICIENT') {
      await base(TABLE_CUSTOMERS).update(customer.id, { [FIELDS.summaryChecked]: today });
      stats.insufficient += 1;
      return;
    }

    await base(TABLE_CUSTOMERS).update(customer.id, {
      [FIELDS.summary]: summary,
      [FIELDS.summaryChecked]: today,
    });
    stats.written += 1;
  } catch (error) {
    // One bad record must not stop the batch. Deliberately not stamped as
    // checked, so a transient failure is retried on the next run.
    console.error(`SF summary failed for ${customer.id}:`, getErrorMessage(error));
    stats.failed += 1;
  }
}

/** Most-travelled guests who have never been looked at. */
async function findCustomersNeedingSummary(base) {
  // Never looked at, and has something to look at.
  const formula = `AND(
    {${FIELDS.summaryChecked}} = BLANK(),
    OR(
      {${FIELDS.aboutGuest}} != BLANK(),
      COUNTA({${FIELDS.bookings}}) > 0
    )
  )`;

  // Most-travelled first. They have the richest feedback to draw on and are
  // the guests a BM most needs briefing about, so they are worth doing before
  // someone with a single trip.
  //
  // This cannot starve anyone: the filter above already excludes guests whose
  // summary is current, so a frequent traveller drops out of the queue as soon
  // as theirs is written. Oldest-summary-first breaks ties, which keeps
  // never-generated guests ahead of ones being refreshed.
  return base(TABLE_CUSTOMERS)
    .select({
      maxRecords: BATCH_SIZE,
      filterByFormula: formula,
      sort: [{ field: FIELDS.pastTrips, direction: 'desc' }],
    })
    .firstPage();
}

/** The guest's own note plus whatever their past trips recorded. */
async function gatherMaterial(base, customer) {
  const aboutGuest = firstValue(customer.fields[FIELDS.aboutGuest]);
  const bookingIds = asArray(customer.fields[FIELDS.bookings]).filter(isRecordId);

  // One query for all of a guest's bookings rather than one request each.
  // Fetching a dozen individually fires a dozen calls against Airtable's
  // 5-per-second limit, and the resulting backoff was most of the run time.
  const wanted = bookingIds.slice(0, 12);
  const bookings = wanted.length
    ? await base(TABLE_BOOKINGS)
      .select({
        maxRecords: wanted.length,
        filterByFormula: `OR(${wanted.map((id) => `RECORD_ID() = '${id}'`).join(',')})`,
      })
      .firstPage()
      .catch(() => [])
    : [];

  const trips = bookings
    .map((booking) => {
      const lines = FEEDBACK_FIELDS
        .map(([label, field]) => {
          const value = firstValue(booking.fields[field]);
          return value ? `${label}: ${value}` : '';
        })
        .filter(Boolean);

      return lines.length > 1 ? lines.join('\n') : '';
    })
    .filter(Boolean);

  if (!aboutGuest && trips.length === 0) return null;

  const name = firstValue(customer.fields[FIELDS.preferredName]) || 'This guest';

  return [
    `Guest: ${name}`,
    aboutGuest ? `\nAbout Guest note:\n${aboutGuest}` : '',
    trips.length ? `\nPast trip feedback:\n\n${trips.join('\n\n---\n\n')}` : '',
  ].filter(Boolean).join('\n');
}

async function generateSummary(material) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: material }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic responded ${response.status}`);
  }

  const payload = await response.json();
  return (payload?.content?.[0]?.text || '').trim();
}

/**
 * Vercel sends CRON_SECRET as a bearer token on scheduled invocations. Without
 * this the endpoint would be a public button that spends money.
 */
function isAuthorised(req) {
  if (!CRON_SECRET) {
    // Allowed only where no secret is configured at all, i.e. local runs.
    return process.env.NODE_ENV !== 'production';
  }

  const header = req.headers?.authorization || '';
  return header === `Bearer ${CRON_SECRET}`;
}

function firstValue(value) {
  if (Array.isArray(value)) return firstValue(value[0]);
  if (value && typeof value === 'object') {
    if ('state' in value || 'isStale' in value) {
      return typeof value.value === 'string' ? value.value : '';
    }
    return value.name || value.email || '';
  }
  return value === undefined || value === null ? '' : String(value);
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecordId(value) {
  return typeof value === 'string' && /^rec[a-zA-Z0-9]+$/.test(value);
}

function getErrorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error.message === 'string') return error.message;
  return 'Unknown error';
}

function sendJson(res, statusCode, body) {
  if (typeof res.status === 'function') {
    return res.status(statusCode).json(body);
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
