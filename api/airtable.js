import Airtable from 'airtable';

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  TABLE_CUSTOMERS,
  TABLE_BOOKINGS,
  TABLE_TRIPS,
  TABLE_BOOKING_CRM,
  TABLE_BOOKING_MANAGERS,
  TABLE_LEADS,
  AIRTABLE_CUSTOMERS_EMAIL_FIELD = 'Client Email',
  CALENDLY_URLS,
  // Base URL of whichever CRM is current. Stacker today, TRTL later — swapping
  // the two is an environment variable change, not a code change.
  CRM_BASE_URL = 'https://leatherbacktravel.stackerhq.com',
} = process.env;

let calendlyMap = {};
try {
  if (CALENDLY_URLS) calendlyMap = JSON.parse(CALENDLY_URLS);
} catch {
  console.warn('CALENDLY_URLS is not valid JSON');
}

/**
 * Every Airtable field name the app reads, in one place.
 *
 * If a field is renamed in Airtable, change it here and nowhere else. Names
 * marked TODO are ones I guessed from screenshots — please correct them.
 * A wrong name fails quietly (the value renders empty), it will not error.
 */
const FIELDS = {
  customer: {
    email: AIRTABLE_CUSTOMERS_EMAIL_FIELD,
    preferredName: 'Preferred Name',
    dob: 'DOB',
    age: 'Age',
    phone: 'Phone Number',
    state: 'State',
    country: 'Country',
    // Optional. An IANA zone name such as "America/Los_Angeles". When present
    // it wins over the state/country lookup, which removes the guesswork for
    // guests in countries that span several zones. Safe to leave uncreated —
    // the panel falls back to state/country.
    timezone: 'Time-zone',
    clientFlag: 'Client Flag',
    notAFit: 'Not a Fit',
    // Auto-rendered into the amber "must know" block whenever populated.
    dietary: 'Dietary Restrictions',
    medical: 'Medical & Other',
    // SF card, in render order: pinned (human, capped at 5) -> about guest
    // (human, verbatim) -> summary (machine, overwritten weekly).
    aboutGuest: 'About Guest', // TODO confirm exact name
    sfPinned: 'SF Pinned', // TODO create in Airtable
    sfSummary: 'SF Summary', // TODO create in Airtable
    sfSummaryUpdated: 'SF Summary Updated', // TODO create in Airtable
    fitnessLevel: 'Fitness Level',
    fitnessNotes: 'Fitness Level Notes',
    fitnessFromGuest: 'Fitness Details from Guest',
    hikingFitness: 'Hiking Fitness Level',
    frequentTravelFriends: 'Frequent Travel Friends',
  },
  booking: {
    notes: 'Booking Notes',
    bookingType: 'Booking Type',
    roommateRequest: 'Roommate Request',
    bookingThroughAgent: 'Booking through Agent',
    // Ops requested these directly beneath Booking Notes on upcoming trips.
    coordDecision: 'Coord Decision',
    lastChased: 'Last Chased',
    lastChasedNotes: 'Last Chased Notes',
    // Post-trip feedback. Shown on past bookings only.
    internalRating: 'Internal Rating out of 5',
    groupDynamicsRating: 'Group Dynamics Rating out of 5 (by guest)',
    feedbackCallDate: 'Feedback Call Date',
    feedbackCallHeldBy: 'Feedback Call Held By',
    feedbackSummary: 'Summary (Summary & Other Feedback)',
  },
};

/** Shown when a past booking row is expanded. Order is the render order. */
const FEEDBACK_SUMMARY_FIELDS = [
  ['guide', 'Summary of Guide Feedback'],
  ['accommodation', 'Summary of Accommodation Feedback'],
  ['food', 'Summary of Food Feedback'],
  ['activities', 'Summary of Activities Feedback'],
];

/** Candidates for pinning up into Flag Notes — "critical" pre-sorts these. */
const FEEDBACK_CRITICAL_FIELDS = [
  ['guides', 'Guides Critical Feedback'],
  ['accommodation', 'Accommodation Critical Feedback'],
  ['food', 'Food Critical Feedback'],
  ['activities', 'Activities Critical Feedback'],
  ['pacing', 'Pacing Critical Feedback'],
  ['suggestions', 'Guest Suggestions Critical Feedback'],
  ['other', 'Other Comments Critical Feedback'],
];

const OPEN_LEAD_STATUSES = [
  'Future Interest',
  'Registration of Interest',
  'Waitlist',
  'Strong Interest',
  'Pending Deposit',
  'Deposit Received',
  'Ready to Process',
  'Closed Come Back',
  'Closed Lost',
];

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { bookingId, notes } = req.body || {};
    if (!bookingId) return sendJson(res, 400, { error: 'Missing bookingId' });
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !TABLE_BOOKINGS) {
      return sendJson(res, 500, { error: 'Airtable environment variables are not configured' });
    }
    try {
      const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
      await base(TABLE_BOOKINGS).update(bookingId, { [FIELDS.booking.notes]: notes || '' });
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 500, { error: 'Failed to save notes', details: getErrorMessage(error) });
    }
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  const emails = parseEmails(req.query.email);
  const mailboxId = String(req.query.mailboxId || '');
  if (!emails.length) {
    return sendJson(res, 400, { error: 'Missing email query parameter' });
  }

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !TABLE_CUSTOMERS) {
    return sendJson(res, 500, { error: 'Airtable environment variables are not configured' });
  }

  try {
    const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
    const customerMatches = await Promise.all(emails.map((email) => fetchCustomersByEmail(base, email)));
    const customers = uniqueCustomerMatches(customerMatches.flat());

    if (!customers.length) {
      return sendJson(res, 200, { email: emails[0], emails, records: [], profiles: [] });
    }

    const profiles = await Promise.all(customers.map(({ customer, email }) => shapeProfile(base, customer, email, mailboxId)));
    const firstProfile = profiles[0];

    return sendJson(res, 200, {
      email: emails[0],
      emails,
      records: profiles.map((profile) => ({ id: profile.customer.id, fields: profile.customer.fields })),
      profiles,
      customer: firstProfile.customer,
      leads: firstProfile.leads,
      bookings: firstProfile.bookings,
    });
  } catch (error) {
    console.error('Airtable lookup failed', error);
    return sendJson(res, 500, {
      error: 'Airtable lookup failed',
      details: getErrorMessage(error),
    });
  }
}

async function fetchCustomersByEmail(base, email) {
  const customers = await base(TABLE_CUSTOMERS)
    .select({
      maxRecords: 3,
      filterByFormula: `LOWER({${AIRTABLE_CUSTOMERS_EMAIL_FIELD}}) = '${escapeFormulaString(email)}'`,
    })
    .firstPage();

  return customers.map((customer) => ({ customer, email }));
}

async function shapeProfile(base, customer, email, mailboxId) {
  const fields = customer.fields;
  const bookingCrmTable = TABLE_BOOKING_CRM || TABLE_LEADS;
  const [bookings, leads] = await Promise.all([
    fetchRecordsByIds(base, TABLE_BOOKINGS, asArray(fields.Bookings)),
    fetchRecordsByIds(base, bookingCrmTable, asArray(fields['Booking CRM'])),
  ]);

  const tripIds = unique([
    ...asArray(fields['Current Trips']).filter(isRecordId),
    ...asArray(fields['Past Trips']).filter(isRecordId),
    ...bookings.flatMap((booking) => asArray(booking.fields.Trip)),
    ...leads.flatMap((lead) => asArray(lead.fields.Trips)),
  ]);
  const [trips, bookingManagers] = await Promise.all([
    fetchRecordsByIds(base, TABLE_TRIPS, tripIds),
    fetchAllRecords(base, TABLE_BOOKING_MANAGERS),
  ]);
  const tripMap = new Map(trips.map((trip) => [trip.id, trip]));

  const coordinatorMap = new Map();
  for (const bm of bookingManagers) {
    const name = firstValue(bm.fields['Name']);
    for (const tripId of asArray(bm.fields['Trips']).filter(isRecordId)) {
      coordinatorMap.set(tripId, name);
    }
  }

  const C = FIELDS.customer;
  const shapedBookings = shapeBookings(bookings, tripMap, coordinatorMap);

  const shapedCustomer = {
    id: customer.id,
    fields,
    matchedEmail: email,
    crmUrl: `${CRM_BASE_URL}/crm/customers/view/cus_${customer.id}`,
    calendlyUrl: buildCalendlyUrl(mailboxId, fields['Client Email'] || email),

    // --- SF "Good to know" card -------------------------------------------
    sf: {
      // Human, curated, capped at 5 by the UI. Never touched by the weekly job.
      pinned: splitLines(fields[C.sfPinned]),
      // Human, verbatim. Also an input to the weekly generator.
      aboutGuest: firstValue(fields[C.aboutGuest]),
      // Machine, overwritten weekly.
      summary: firstValue(fields[C.sfSummary]),
      summaryUpdated: formatShortDate(fields[C.sfSummaryUpdated]),
    },

    // --- amber "must know" block ------------------------------------------
    // These are already curated in the CRM, so they render automatically
    // rather than needing a human to pin them.
    flags: {
      clientFlag: firstValue(fields[C.clientFlag]),
      dietary: firstValue(fields[C.dietary]),
      medical: firstValue(fields[C.medical]),
      notAFit: Boolean(fields[C.notAFit]),
    },

    // --- everything the SF grid shows -------------------------------------
    profile: {
      preferredName: firstValue(fields[C.preferredName]),
      dob: formatShortDate(fields[C.dob]),
      age: firstValue(fields[C.age]),
      phone: firstValue(fields[C.phone]),
      state: firstValue(fields[C.state]),
      country: firstValue(fields[C.country]),
      timezone: firstValue(fields[C.timezone]),
      frequentTravelFriends: firstValue(fields[C.frequentTravelFriends]),
      // Per-booking in Airtable, but a BM about to dial needs to know before
      // they dial — so it is surfaced here if any live trip is agent-booked.
      viaAgent: [...(shapedBookings.upcoming || []), ...(shapedBookings.active || [])]
        .some((booking) => booking.viaAgent),
      fitnessLevel: firstValue(fields[C.fitnessLevel]),
      fitnessNotes: firstValue(fields[C.fitnessNotes]),
      fitnessFromGuest: firstValue(fields[C.fitnessFromGuest]),
      hikingFitness: firstValue(fields[C.hikingFitness]),
    },

    // Stats for the SF tiles. Derived, so they cannot drift from the trip list.
    stats: buildStats(shapedBookings),

    // The BM(s) running this guest's upcoming trips. Falls back to the most
    // recent past coordinator, flagged so the UI can label it differently.
    bookingManagers: buildBookingManagers(shapedBookings),
  };

  return {
    customer: shapedCustomer,
    leads: shapeLeads(leads, tripMap),
    bookings: shapedBookings,
  };
}

function buildStats(bookings) {
  const completed = [...(bookings.past || []), ...(bookings.active || [])];
  const rated = completed.map((b) => b.feedback?.internalRating).filter((n) => typeof n === 'number');
  const average = rated.length ? rated.reduce((sum, n) => sum + n, 0) / rated.length : null;

  return {
    tripsDone: (bookings.past || []).length,
    upcoming: (bookings.upcoming || []).length,
    cancelled: (bookings.cancelled || []).length,
    avgRating: average === null ? null : Math.round(average * 10) / 10,
    ratedCount: rated.length,
  };
}

function buildBookingManagers(bookings) {
  const upcoming = unique((bookings.upcoming || []).map((b) => b.coordinator));
  if (upcoming.length) return { names: upcoming, current: true };

  const active = unique((bookings.active || []).map((b) => b.coordinator));
  if (active.length) return { names: active, current: true };

  // No live trip — show who ran the last one, but let the UI say so.
  const previous = (bookings.past || []).map((b) => b.coordinator).filter(Boolean);
  return { names: previous.length ? [previous[0]] : [], current: false };
}

/** Long-text fields hold one pinned item per line. */
function splitLines(value) {
  return String(firstValue(value) || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function fetchAllRecords(base, tableName) {
  if (!tableName) return [];
  try {
    return await base(tableName).select().all();
  } catch (error) {
    console.warn(`Could not fetch all records from ${tableName}`, getErrorMessage(error));
    return [];
  }
}

async function fetchRecordsByIds(base, tableName, ids) {
  if (!tableName || !ids.length) return [];
  const records = await Promise.all(
    unique(ids)
      .filter(isRecordId)
      .map(async (id) => {
        try {
          return await base(tableName).find(id);
        } catch (error) {
          console.warn(`Could not fetch ${tableName} record ${id}`, getErrorMessage(error));
          return null;
        }
      })
  );
  return records.filter(Boolean);
}

function shapeLeads(records, tripMap) {
  return records
    .map((record) => {
      const fields = record.fields;
      const status = String(fields.Status || '');
      const trip = tripMap.get(asArray(fields.Trips)[0]);
      const dateRaw = firstValue(fields['Date Created'] || fields['Date Added']);
      return {
        id: record.id,
        status,
        trip: firstValue(trip?.fields['Trip Title & Code']) || firstValue(fields['D-Future-Trip-Requests']) || formatValue(fields['D-Future-Trip-Tags']) || 'Trip not set',
        dateAdded: formatShortDate(dateRaw),
        dateAddedTimestamp: parseDate(dateRaw)?.getTime() || 0,
        crmUrl: `${CRM_BASE_URL}/crm/booking-crm/view/bcr_${record.id}`,
        futureTripRequests: firstValue(fields['D-Future-Trip-Requests']) || formatValue(fields['D-Future-Trip-Tags']),
      };
    })
    .filter((lead) => OPEN_LEAD_STATUSES.includes(lead.status))
    .sort((a, b) => b.dateAddedTimestamp - a.dateAddedTimestamp);
}

function shapeBookings(records, tripMap, coordinatorMap) {
  const today = startOfDay(new Date());
  const rows = records.map((record) => {
    const fields = record.fields;
    const trip = tripMap.get(asArray(fields.Trip)[0]);
    const tripFields = trip?.fields || {};
    const startDateRaw = firstValue(fields['Trip Start Date'] || tripFields['Start Date']);
    const endDateRaw = firstValue(fields['AUT: Trip End Date'] || fields['Finish Date (from Trip)'] || tripFields['Finish Date']);
    const startDate = parseDate(startDateRaw);
    const endDate = parseDate(endDateRaw);
    const cancelled = Boolean(fields.Cancelled);
    const group = getBookingGroup({ cancelled, startDate, endDate, today });

    const B = FIELDS.booking;

    return {
      id: record.id,
      name: firstValue(tripFields['Trip Title & Code']) || firstValue(fields['Trip Title']) || firstValue(fields['Booking ID']) || 'Trip not set',
      coordinator: coordinatorMap.get(trip?.id) || '',
      notes: firstValue(fields[B.notes]) || '',
      startDate: formatShortDate(startDateRaw),
      endDate: formatShortDate(endDateRaw),
      startTimestamp: startDate?.getTime() || 0,
      endTimestamp: endDate?.getTime() || 0,
      group,
      crmUrl: `${CRM_BASE_URL}/crm/bookings/view/boo_${record.id}`,

      bookingType: firstValue(fields[B.bookingType]),
      roommateRequest: firstValue(fields[B.roommateRequest]),
      viaAgent: Boolean(fields[B.bookingThroughAgent]),

      // Ops fields. Rendered under Booking Notes on upcoming trips only.
      ops: {
        coordDecision: firstValue(fields[B.coordDecision]),
        lastChased: formatShortDate(fields[B.lastChased]),
        lastChasedNotes: firstValue(fields[B.lastChasedNotes]),
      },

      feedback: shapeFeedback(fields),
    };
  });

  return {
    active: rows.filter((row) => row.group === 'active' || row.group === 'recent').sort((a, b) => a.endTimestamp - b.endTimestamp),
    upcoming: rows.filter((row) => row.group === 'upcoming').sort((a, b) => a.startTimestamp - b.startTimestamp),
    past: rows.filter((row) => row.group === 'past').sort((a, b) => b.endTimestamp - a.endTimestamp),
    cancelled: rows.filter((row) => row.group === 'cancelled').sort((a, b) => b.startTimestamp - a.startTimestamp),
  };
}

/**
 * Post-trip feedback for one booking.
 *
 * `summary` and the ratings show on the collapsed row; `summaries` and
 * `critical` appear when it is expanded. `critical` entries are the ones a BM
 * can pin up into Flag Notes, which is why they are kept separate.
 *
 * Returns null when a feedback call has not happened, so the UI can skip the
 * block entirely rather than render empty labels.
 */
function shapeFeedback(fields) {
  const B = FIELDS.booking;

  const summaries = FEEDBACK_SUMMARY_FIELDS
    .map(([key, name]) => ({ key, label: name.replace(/^Summary of /, '').replace(/ Feedback$/, ''), text: firstValue(fields[name]) }))
    .filter((item) => item.text);

  const critical = FEEDBACK_CRITICAL_FIELDS
    .map(([key, name]) => ({ key, label: name.replace(/ Critical Feedback$/, ''), text: firstValue(fields[name]) }))
    .filter((item) => item.text);

  const feedback = {
    internalRating: toNumber(fields[B.internalRating]),
    groupDynamicsRating: toNumber(fields[B.groupDynamicsRating]),
    callDate: formatShortDate(fields[B.feedbackCallDate]),
    callHeldBy: firstValue(fields[B.feedbackCallHeldBy]),
    summary: firstValue(fields[B.feedbackSummary]),
    summaries,
    critical,
  };

  const hasAnything = feedback.internalRating !== null
    || feedback.groupDynamicsRating !== null
    || feedback.summary
    || summaries.length
    || critical.length;

  return hasAnything ? feedback : null;
}

function toNumber(value) {
  const raw = firstValue(value);
  if (raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function getBookingGroup({ cancelled, startDate, endDate, today }) {
  if (cancelled) return 'cancelled';
  if (startDate && endDate && startDate <= today && endDate >= today) return 'active';
  if (endDate && endDate < today && daysBetween(endDate, today) <= 30) return 'recent';
  if (startDate && startDate > today) return 'upcoming';
  return 'past';
}

function buildShortTripName(leadFields, tripFields = {}) {
  const name = firstValue(leadFields['AUT: Nice Name']) || firstValue(tripFields['AUT: Nice Name']) || firstValue(tripFields['Trip Title & Code']) || firstValue(leadFields['Trip Name']);
  const date = firstValue(leadFields['Trip Start Date']) || firstValue(tripFields['Start Date']);
  return [name, formatShortDate(date)].filter(Boolean).join(' ');
}

function buildCalendlyUrl(mailboxId, email) {
  const base = calendlyMap[mailboxId] || calendlyMap['default'] || '';
  if (!base) return '';
  const emailParam = `email=${encodeURIComponent(String(email || ''))}`;
  return base.includes('?') ? `${base}&${emailParam}` : `${base}?${emailParam}`;
}

function firstValue(value) {
  if (Array.isArray(value)) return firstValue(value[0]);
  if (value && typeof value === 'object') return value.name || value.email || value.url || JSON.stringify(value);
  return value ? String(value) : '';
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueCustomerMatches(matches) {
  const seen = new Set();
  const uniqueMatches = [];
  for (const match of matches) {
    if (seen.has(match.customer.id)) continue;
    seen.add(match.customer.id);
    uniqueMatches.push(match);
  }
  return uniqueMatches;
}

function isRecordId(value) {
  return typeof value === 'string' && /^rec[a-zA-Z0-9]+$/.test(value);
}

function formatShortDate(value) {
  const raw = value instanceof Date ? value.toISOString() : firstValue(value);
  if (!raw) return '';

  const date = parseDate(raw);
  if (!date) return raw;

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function parseDate(value) {
  const raw = firstValue(value);
  if (!raw) return null;

  const friendlyMatch = raw.match(/\(([^)]+)\)/);
  const date = new Date(friendlyMatch?.[1] || raw);
  return Number.isNaN(date.getTime()) ? null : startOfDay(date);
}

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetween(start, end) {
  return Math.floor((end.getTime() - start.getTime()) / 86400000);
}

function formatValue(value) {
  if (Array.isArray(value)) return value.map(firstValue).filter(Boolean).join(', ');
  return firstValue(value);
}

function sendJson(res, statusCode, body) {
  if (typeof res.status === 'function') {
    return res.status(statusCode).json(body);
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function normalizeEmail(value) {
  if (Array.isArray(value)) return normalizeEmail(value[0]);
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function parseEmails(value) {
  const values = Array.isArray(value) ? value : [value];
  return unique(
    values
      .flatMap((item) => String(item || '').split(','))
      .map((item) => normalizeEmail(item))
      .filter(Boolean)
  );
}

function escapeFormulaString(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getErrorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error.message === 'string') return error.message;
  if (typeof error.error === 'string') return error.error;
  return 'Unknown error';
}
