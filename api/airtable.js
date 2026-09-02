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
  TABLE_ACTIVITY_LOG,
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
    // Primary field on Customers, used to turn linked records (travel friends)
    // into readable names. TODO confirm the real name of this field.
    name: 'Name',
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
    // These sit in the SF grid as ordinary detail. BMs copy anything that
    // genuinely needs the amber treatment into Client Flag themselves, so the
    // panel does not second-guess which allergy is severe.
    dietary: 'Dietary Restrictions',
    medical: 'Medical & Other',
    departureAirport: 'Departure Airport',
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
    // Multi-select. Short, shared vocabulary rendered as chips in the SF card.
    traits: 'Guest Traits',
    interests: 'Interests',
    // Reverse of the Customer link on Activity Log. Airtable creates this
    // automatically when that link field is added.
    activityLog: 'Activity Log',
  },
  booking: {
    notes: 'Booking Notes',
    bookingType: 'Booking Type',
    roommateRequest: 'Roommate Request',
    bookingThroughAgent: 'Booking through Agent',
    // Ops fields, shown beneath Booking Notes on upcoming trips.
    coordDecision: 'Coord Decision',
    // Both are read: "Chased Date" may or may not exist, and reading a field
    // that is absent simply returns nothing rather than erroring. Whichever is
    // populated wins, so it works either way.
    chasedDate: 'Chased Date',
    lastChased: 'Last Chased',            // Date
    lastChasedNotes: 'Last Chased Notes', // Long text
    // Ops banner on upcoming trips.
    paymentPending: 'Payment Pending',   // Formula, currency. 0 when paid or cancelled.
    daysUntilStart: 'Days Until Start',  // Lookup from Trip
    // What the guest still owes us, e.g. "1 details remaining — Insurance
    // Details". The single most actionable thing to have in front of a BM
    // who happens to be on the phone with them.
    remainingDetails: 'Remaining Details',
    detailsDueDate: 'Customer Details Due Date',
    // "Extras" itself is a link field and returns record ids, so the lookup of
    // the category is used instead. Extras Cost is a rollup of the whole
    // booking, not per extra.
    extras: 'Extras (from Extras)',
    extrasCost: 'Extras Cost',
    extrasNotes: 'Extras Notes',
    // Post-trip feedback. Shown on past bookings only.
    internalRating: 'Internal Rating out of 5',
    groupDynamicsRating: 'Group Dynamics Rating out of 5 (by guest)',
    feedbackCallDate: 'Feedback Call Date',
    feedbackCallHeldBy: 'Feedback Call Held By',
    // The human-written summary, which is populated. The AI field below
    // summarises it and is currently ungenerated across the base, so it is
    // only a fallback.
    feedbackSummary: 'Summary & Other Feedback',
    feedbackSummaryAi: 'Summary (Summary & Other Feedback)',
  },
  lead: {
    // Native long text on Booking CRM — editable, so the panel can write to it
    // exactly as it does for booking notes.
    notes: 'Booking Notes',
    // Tags are a short controlled list and belong in the Lead Trip column.
    // Requests is free prose a BM has typed and belongs in the expanded row.
    tags: 'D-Future-Trip-Tags',
    requests: 'D-Future-Trip-Requests',
  },
  activity: {
    customer: 'Customer',
    booking: 'Booking',
    type: 'Type',
    body: 'Body',
    author: 'Author',
    source: 'Source',
    created: 'Created',
  },
};

/** Written to Source so machine-written entries can be told apart later. */
const ACTIVITY_SOURCE = 'Help Scout';

/**
 * The only records this endpoint will write to, and the only field it will
 * write on each. Whitelisted so a crafted request cannot point the write at an
 * arbitrary table or field.
 */
const WRITE_TARGETS = {
  booking: { table: () => TABLE_BOOKINGS, field: () => FIELDS.booking.notes },
  lead: { table: () => TABLE_BOOKING_CRM || TABLE_LEADS, field: () => FIELDS.lead.notes },
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

/**
 * Lead statuses, grouped by what a BM should do about them.
 *
 * Anything not listed here counts as open — including a blank status, which is
 * an oversight rather than a decision and should stay visible.
 *
 * Previously the panel showed lost leads and hid converted ones, which meant a
 * lead's preliminary notes became unreachable the moment it succeeded.
 */
const CONVERTED_LEAD_STATUSES = ['Done'];
const CLOSED_LEAD_STATUSES = ['Closed Come Back', 'Closed Lost'];

function getLeadGroup(status) {
  if (CONVERTED_LEAD_STATUSES.includes(status)) return 'converted';
  if (CLOSED_LEAD_STATUSES.includes(status)) return 'closed';
  return 'open';
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { bookingId, recordId, recordType, notes } = req.body || {};

    // Activity now lives in Postgres — see api/activity.js. Kept as an
    // explicit error rather than silently falling through, in case an older
    // frontend is still deployed and pointing here.
    if (recordType === 'activity') {
      return sendJson(res, 410, { error: 'Activity entries moved to /api/activity' });
    }

    // `bookingId` is the original shape and still accepted, so an older
    // frontend deployed against a newer API keeps working.
    const type = recordType || (bookingId ? 'booking' : null);
    const id = recordId || bookingId;

    const target = WRITE_TARGETS[type];
    if (!id || !target) {
      return sendJson(res, 400, { error: 'Missing or unknown record to update' });
    }

    const tableName = target.table();
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !tableName) {
      return sendJson(res, 500, { error: 'Airtable environment variables are not configured' });
    }

    try {
      const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
      await base(tableName).update(id, { [target.field()]: notes || '' });
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

    // One email can match several customers — a couple sharing an inbox, or a
    // referral using a friend's address before giving us their own. Order by
    // how much history each record carries so the substantive one leads,
    // rather than whichever Airtable happened to return first.
    profiles.sort((a, b) => scoreProfileRelevance(b) - scoreProfileRelevance(a));
    const firstProfile = profiles[0];

    return sendJson(res, 200, {
      email: emails[0],
      emails,
      matchCount: profiles.length,
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

/**
 * Rough measure of how much a customer record matters to a BM right now.
 *
 * A live or upcoming trip dominates everything else — that is the person the
 * conversation is almost certainly about. Past trips come next, then open
 * leads. An empty record sorts last, which is what we want: a half-created
 * referral should never sit above a guest with five trips behind them.
 */
function scoreProfileRelevance(profile) {
  const bookings = profile.bookings || {};
  const live = (bookings.upcoming || []).length + (bookings.active || []).length;
  const past = (bookings.past || []).length;
  const leads = (profile.leads || []).length;

  return live * 1000 + past * 10 + leads;
}

/**
 * Creates one Activity Log entry.
 *
 * Author comes from the Help Scout user context rather than being typed, and
 * Source records where the entry originated so machine-written entries can be
 * distinguished from human ones later — which matters once Aircall summaries
 * start writing here too.
 */
async function createActivityEntry(req, res) {
  const { customerId, bookingId, body, type, author } = req.body || {};

  if (!customerId || !String(body || '').trim()) {
    return sendJson(res, 400, { error: 'An activity entry needs a customer and a body' });
  }

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !TABLE_ACTIVITY_LOG) {
    return sendJson(res, 500, { error: 'TABLE_ACTIVITY_LOG is not configured' });
  }

  const A = FIELDS.activity;
  const record = {
    [A.customer]: [customerId],
    [A.body]: String(body).trim(),
    [A.type]: type || 'Note',
    [A.source]: ACTIVITY_SOURCE,
  };

  if (bookingId) record[A.booking] = [bookingId];
  if (author) record[A.author] = String(author);

  try {
    const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
    const created = await base(TABLE_ACTIVITY_LOG).create(record);
    return sendJson(res, 200, { ok: true, id: created.id });
  } catch (error) {
    return sendJson(res, 500, { error: 'Failed to write activity entry', details: getErrorMessage(error) });
  }
}

/**
 * Every field a guest's address might be stored in.
 *
 * Guests routinely write in from an address that is not their primary one, so
 * searching only Client Email silently reports "no match" for people who are
 * plainly in the CRM.
 */
const CUSTOMER_EMAIL_FIELDS = [
  AIRTABLE_CUSTOMERS_EMAIL_FIELD,
  'Alt Email',
  'Alt Email 2',
];

function buildEmailFormula(fieldNames, email) {
  const escaped = escapeFormulaString(email);
  // TRIM guards against trailing spaces in the stored value, which are
  // invisible in Airtable and defeat an exact comparison.
  const clauses = fieldNames.map((name) => `LOWER(TRIM({${name}})) = '${escaped}'`);
  return clauses.length === 1 ? clauses[0] : `OR(${clauses.join(', ')})`;
}

async function fetchCustomersByEmail(base, email) {
  const runQuery = (fieldNames) => base(TABLE_CUSTOMERS)
    .select({ maxRecords: 3, filterByFormula: buildEmailFormula(fieldNames, email) })
    .firstPage();

  let customers;
  try {
    customers = await runQuery(CUSTOMER_EMAIL_FIELDS);
  } catch (error) {
    // A field name that does not exist makes Airtable reject the whole
    // formula, which would break the lookup for every guest rather than just
    // this one. Fall back to the primary field so the panel keeps working.
    console.warn('Multi-field email lookup failed, falling back to primary field', getErrorMessage(error));
    customers = await runQuery([AIRTABLE_CUSTOMERS_EMAIL_FIELD]);
  }

  return customers.map((customer) => ({ customer, email }));
}

async function shapeProfile(base, customer, email, mailboxId) {
  const fields = customer.fields;
  const bookingCrmTable = TABLE_BOOKING_CRM || TABLE_LEADS;
  // Activity is no longer read from here — it lives in Postgres and the panel
  // fetches it separately. Dropping it also removes a request per panel load,
  // which matters against Airtable's 5-per-second cap.
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
  // Frequent Travel Friends is a link field, so it arrives as record IDs.
  // Resolve them to names — showing "rec8fUMOfXbpRHBcg" to a BM is useless.
  const travelFriendIds = asArray(fields[FIELDS.customer.frequentTravelFriends]).filter(isRecordId);

  const [trips, bookingManagers, travelFriends] = await Promise.all([
    fetchRecordsByIds(base, TABLE_TRIPS, tripIds),
    fetchAllRecords(base, TABLE_BOOKING_MANAGERS),
    fetchRecordsByIds(base, TABLE_CUSTOMERS, travelFriendIds),
  ]);
  const tripMap = new Map(trips.map((trip) => [trip.id, trip]));

  const coordinatorMap = new Map();
  // Booking manager record id -> name, so link fields pointing at this table
  // can be resolved without another request. Used for "Feedback Call Held By",
  // which would otherwise render as recXXXXXXXX.
  const managerNameById = new Map();

  for (const bm of bookingManagers) {
    const name = firstValue(bm.fields['Name']);
    managerNameById.set(bm.id, name);
    for (const tripId of asArray(bm.fields['Trips']).filter(isRecordId)) {
      coordinatorMap.set(tripId, name);
    }
  }

  const C = FIELDS.customer;
  const shapedBookings = shapeBookings(bookings, tripMap, coordinatorMap, managerNameById);

  const shapedCustomer = {
    id: customer.id,
    fields,
    matchedEmail: email,
    crmUrl: `${CRM_BASE_URL}/crm/customers/view/cus_${customer.id}`,
    // Stacker addresses its record tabs with a fragment. Kept here beside the
    // base URL so the whole pattern changes in one place when TRTL lands.
    crmActivityUrl: `${CRM_BASE_URL}/crm/customers/view/cus_${customer.id}#Activity`,
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
    // Client Flag only. BMs decide what warrants the amber treatment and copy
    // it in themselves, which keeps the alert meaningful — if every dietary
    // note triggered it, people would stop reading it.
    flags: {
      clientFlag: firstValue(fields[C.clientFlag]),
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
      frequentTravelFriends: resolveTravelFriends(fields[C.frequentTravelFriends], travelFriends),
      // Multi-select arrives as an array; keep it as one so the UI can chip it.
      traits: asArray(fields[C.traits]).map(firstValue).filter(Boolean),
      interests: formatValue(fields[C.interests]),
      dietary: firstValue(fields[C.dietary]),
      medical: firstValue(fields[C.medical]),
      departureAirport: firstValue(fields[C.departureAirport]),
      // "Usually books: Private supplement (5 of 6 trips)" — derived, because
      // Booking Type lives per-booking and a single value would be a guess.
      usuallyBooks: buildBookingTypeSummary(shapedBookings),
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

/**
 * Activity entries, newest first.
 *
 * Author and timestamp are fields rather than text baked into the body, so the
 * panel can render them consistently. The old Stacker convention of typing
 * "19AUG26 FP:" at the start of every note drifted — "20 AUG CJ", "08JUL26 FP:"
 * — because it depended on each person remembering the format.
 */
function shapeActivity(records) {
  return records
    .map((record) => {
      const A = FIELDS.activity;
      const createdRaw = firstValue(record.fields[A.created]) || record._rawJson?.createdTime || '';

      return {
        id: record.id,
        type: firstValue(record.fields[A.type]) || 'Note',
        body: firstValue(record.fields[A.body]) || '',
        author: firstValue(record.fields[A.author]) || '',
        source: firstValue(record.fields[A.source]) || '',
        createdIso: createdRaw,
        created: formatShortDate(createdRaw),
        createdTimestamp: new Date(createdRaw).getTime() || 0,
      };
    })
    .filter((entry) => entry.body)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
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

/**
 * Most frequent Booking Type across a guest's real trips.
 *
 * Cancelled bookings are excluded — a room type they never actually travelled
 * in says nothing about what they prefer. Returns null rather than a fabricated
 * default when no booking carries a type.
 */
/**
 * Turns a Frequent Travel Friends value into readable names.
 *
 * If the field holds links, the fetched records supply the names. If it holds
 * plain text, that text is used as-is. Record IDs are never shown — if a name
 * cannot be resolved the entry is dropped, because "rec8fUMOfXbpRHBcg" tells a
 * BM less than nothing.
 */
function resolveTravelFriends(rawValue, friendRecords) {
  const C = FIELDS.customer;
  const values = asArray(rawValue);
  if (!values.length) return '';

  const looksLinked = values.some((value) => isRecordId(value));
  if (!looksLinked) return formatValue(rawValue);

  const names = friendRecords
    .map((record) => firstValue(record.fields[C.name]) || firstValue(record.fields[C.preferredName]))
    .filter(Boolean);

  return names.join(', ');
}

function buildBookingTypeSummary(bookings) {
  const relevant = [
    ...(bookings.past || []),
    ...(bookings.active || []),
    ...(bookings.upcoming || []),
  ].filter((booking) => booking.bookingType);

  if (!relevant.length) return null;

  const counts = new Map();
  for (const booking of relevant) {
    counts.set(booking.bookingType, (counts.get(booking.bookingType) || 0) + 1);
  }

  const [type, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { type, count, total: relevant.length };
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
      const L = FIELDS.lead;
      const fields = record.fields;
      const status = String(fields.Status || '');
      const trip = tripMap.get(asArray(fields.Trips)[0]);
      const dateRaw = firstValue(fields['Date Created'] || fields['Date Added']);

      const tripTitle = firstValue(trip?.fields['Trip Title & Code']);
      const tags = formatValue(fields[L.tags]);
      const requests = firstValue(fields[L.requests]);

      return {
        id: record.id,
        status,
        // Column shows a trip name or short tags only. Free prose used to land
        // here when neither existed, which read as a very odd trip title.
        trip: tripTitle || tags || 'Trip not set',
        tags,
        requests,
        dateAdded: formatShortDate(dateRaw),
        dateAddedTimestamp: parseDate(dateRaw)?.getTime() || 0,
        notes: firstValue(fields[L.notes]) || '',
        group: getLeadGroup(status),
        crmUrl: `${CRM_BASE_URL}/crm/booking-crm/view/bcr_${record.id}`,
      };
    })
    .sort((a, b) => b.dateAddedTimestamp - a.dateAddedTimestamp);
}

function shapeBookings(records, tripMap, coordinatorMap, managerNameById) {
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
        lastChased: formatShortDate(fields[B.chasedDate]) || formatShortDate(fields[B.lastChased]),
        lastChasedNotes: firstValue(fields[B.lastChasedNotes]),
        // Zero means paid in full or cancelled, so it is treated as nothing
        // owing — "Payment pending $0" would be noise on every booking.
        paymentPending: formatCurrency(toNumber(fields[B.paymentPending])),
        // Raw number too, so the UI can decide on emphasis without parsing a
        // formatted currency string back into a value.
        paymentPendingAmount: toNumber(fields[B.paymentPending]),
        daysUntilStart: toNumber(fields[B.daysUntilStart]),
        remainingDetails: firstValue(fields[B.remainingDetails]),
        detailsDueDate: formatShortDate(fields[B.detailsDueDate]),
        detailsOverdue: isPastDate(fields[B.detailsDueDate]),
        // Lookups arrive as arrays.
        extras: unique(asArray(fields[B.extras]).map(firstValue).filter(Boolean)),
        extrasCost: formatCurrency(toNumber(fields[B.extrasCost])),
        extrasNotes: asArray(fields[B.extrasNotes]).map(firstValue).filter(Boolean).join(' · '),
      },

      feedback: shapeFeedback(fields, managerNameById),
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
function shapeFeedback(fields, managerNameById = new Map()) {
  const B = FIELDS.booking;

  // Link field, so it arrives as a record id. Resolved against the booking
  // managers already in memory; if it points at some other table we show
  // nothing rather than a raw record id, which tells a BM less than nothing.
  const heldByRaw = asArray(fields[B.feedbackCallHeldBy]);
  const callHeldBy = heldByRaw
    .map((value) => (isRecordId(value) ? managerNameById.get(value) || '' : firstValue(value)))
    .filter(Boolean)
    .join(', ');

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
    callHeldBy,
    summary: firstValue(fields[B.feedbackSummary]) || firstValue(fields[B.feedbackSummaryAi]),
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

/**
 * Whole-dollar currency. Zero is shown rather than hidden — "$0 pending" is a
 * useful confirmation to Ops that a booking is settled, which is different
 * from the field being blank.
 */
function formatCurrency(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    maximumFractionDigits: 0,
  }).format(amount);
}

/** A deadline that has already passed reads very differently from one that has not. */
function isPastDate(value) {
  const date = parseDate(value);
  if (!date) return false;
  return date < startOfDay(new Date());
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

  if (value && typeof value === 'object') {
    // Airtable AI fields return { state, value, isStale, errorType } rather
    // than a string. state is 'generated', 'empty' or 'error' — anything but a
    // real string means there is nothing to show yet.
    if ('state' in value || 'isStale' in value) {
      return typeof value.value === 'string' ? value.value : '';
    }

    // Collaborators, attachments and similar.
    // Never JSON.stringify as a fallback: raw JSON in the panel is worse than
    // an empty field, because it looks like corruption to whoever sees it.
    return value.name || value.email || value.url || '';
  }

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
