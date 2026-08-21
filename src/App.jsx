import HelpScout from '@helpscout/javascript-sdk';
import { DefaultStyle, Heading, Spinner, Text, useSetAppHeight } from '@helpscout/ui-kit';
import { useEffect, useMemo, useState } from 'react';

function App() {
  const appRef = useSetAppHeight();
  const [context, setContext] = useState(null);
  const [customerData, setCustomerData] = useState(null);
  const [status, setStatus] = useState('loading-context');
  const [error, setError] = useState('');

  const emails = useMemo(() => getCustomerEmails(context?.customer), [context]);
  const emailQuery = emails.join(',');
  const mailboxId = context?.conversation?.mailboxId ?? null;

  useEffect(() => {
    let active = true;
    const localEmail = new URLSearchParams(window.location.search).get('email');

    if (localEmail) {
      setContext({ customer: { email: localEmail } });
      setStatus('ready');
      return () => {
        active = false;
      };
    }

    HelpScout.getApplicationContext()
      .then((nextContext) => {
        if (!active) return;
        setContext(nextContext);
        setStatus('ready');
      })
      .catch(() => {
        if (!active) return;
        setStatus('context-error');
        setError('Could not read Help Scout conversation context.');
      });

    const unsubscribe = HelpScout.watchApplicationContext?.((nextContext) => {
      setContext(nextContext);
    });

    return () => {
      active = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!emailQuery) {
      if (status === 'ready') setCustomerData(null);
      return;
    }

    let active = true;
    setStatus('loading-airtable');
    setError('');

    const params = new URLSearchParams({ email: emailQuery });
    if (mailboxId) params.set('mailboxId', String(mailboxId));
    fetch(`/api/airtable?${params}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error([body.error, body.details].filter(Boolean).join(': ') || 'Airtable lookup failed.');
        }
        return body;
      })
      .then((body) => {
        if (!active) return;
        setCustomerData(body);
        setStatus('ready');
      })
      .catch((lookupError) => {
        if (!active) return;
        setCustomerData(null);
        setStatus('airtable-error');
        setError(lookupError.message);
      });

    return () => {
      active = false;
    };
  }, [emailQuery, mailboxId]);

  const record = customerData?.records?.[0];
  const customer = customerData?.customer;
  const fields = customer?.fields || record?.fields || {};

  return (
    <main className="app" ref={appRef}>
      <DefaultStyle />

      {status === 'loading-context' || status === 'loading-airtable' ? (
        <LoadingState />
      ) : error ? (
        <Message title="Could not load customer" text={error} />
      ) : !emailQuery ? (
        <Message title="No customer email" text="This Help Scout conversation does not include an email address yet." />
      ) : !record ? (
        <Message title="No Airtable match" text="No customer record was found for this email address." />
      ) : (
        <HomePage customerData={customerData} />
      )}
    </main>
  );
}

function HomePage({ customerData }) {
  const profiles = customerData?.profiles?.length
    ? customerData.profiles
    : [{ customer: customerData.customer, leads: customerData.leads, bookings: customerData.bookings }];

  return (
    <>
      {profiles.length > 1 && (
        <div className="multiMatch">
          {profiles.length} customer records share this email address — shown below, most active first.
        </div>
      )}
      {profiles.map((profile, index) => (
        <ProfilePanel
          key={profile.customer?.id || index}
          profile={profile}
          showEmail={profiles.length > 1}
        />
      ))}
    </>
  );
}

function ProfilePanel({ profile, showEmail }) {
  const customer = profile.customer;
  const fields = customer?.fields || {};
  // The API now shapes these. Fall back to raw fields so the panel still
  // renders if the frontend deploys ahead of the API.
  const flags = customer?.flags || { clientFlag: fields['Client Flag'], notAFit: Boolean(fields['Not a Fit']) };
  const leads = profile.leads || [];
  const bookings = profile.bookings || {};

  return (
    <section className="profilePanel">
      {flags.notAFit && <div className="alert">Not a Fit</div>}

      <SFCard customer={customer} showEmail={showEmail} />
      <FlagBlock flags={flags} />
      <ContactCard customer={customer} />

      <TripsSection bookings={bookings} />
      <LeadsTable leads={leads} />

      <a className="primaryButton" href={customer?.calendlyUrl} rel="noreferrer" target="_blank">
        Calendly link
      </a>
    </section>
  );
}

/**
 * SF — Good to know. Sits at the top because it is what a BM needs before
 * they say anything, rather than after they have gone looking.
 */
function SFCard({ customer, showEmail }) {
  const sf = customer?.sf || {};
  const p = customer?.profile || {};
  const stats = customer?.stats || {};
  const managers = customer?.bookingManagers || { names: [], current: true };

  const subtitle = [
    [p.state, p.country].filter(Boolean).join(', '),
    managers.names.length
      ? `${managers.current ? 'BM' : 'Last BM'}: ${managers.names.join(', ')}`
      : '',
  ].filter(Boolean).join(' · ');

  return (
    <section className="sfCard">
      <div className="sfHead">
        <span className="label sfEyebrow">SF · Good to know</span>
        {stats.tripsDone > 1 && (
          <span className="chip chipGreen">Repeat guest · {stats.tripsDone} trips</span>
        )}
      </div>

      {p.preferredName && <div className="sfName">{p.preferredName}</div>}
      {subtitle && <div className="sfSub">{subtitle}</div>}
      {showEmail && (
        <div className="sfSub">{customer?.matchedEmail}</div>
      )}

      <div className="statGrid">
        <Stat value={stats.tripsDone} label="Trips done" />
        <Stat value={stats.upcoming} label="Upcoming" />
        <Stat value={stats.avgRating} label="Avg rating" />
        {/* DOB rides along with Age rather than taking a row of its own —
            they are the same fact, and the duplicate left a dead column. */}
        <Stat value={p.age} label="Age" note={p.dob} />
      </div>

      <div className="touchGrid">
        <Touch
          label="Room"
          value={p.usuallyBooks?.type}
          note={p.usuallyBooks && `${p.usuallyBooks.count} of ${p.usuallyBooks.total} trips`}
        />
        <Touch label="Dietary" value={p.dietary} />
        <Touch label="Medical & other" value={p.medical} />
        <Touch label="Interests" value={p.interests} />
        {/* Travel friends hidden pending a decision on how to display linked
            guests. The API still resolves the names — only the row is off. */}
        <Touch label="Departs" value={p.departureAirport} />
      </div>

      {/* Fitness gets the full width: the notes run to several lines, and
          pairing them with a short field left half the row empty. */}
      <div className="touchGrid touchGridWide">
        <Touch label="Fitness" value={p.fitnessLevel} note={p.fitnessNotes || p.fitnessFromGuest} />
        <Touch label="Hiking fitness" value={p.hikingFitness} />
      </div>

      {p.traits?.length > 0 && (
        <div className="traitRow">
          {p.traits.map((trait) => (
            <span className="chip traitChip" key={trait}>{trait}</span>
          ))}
        </div>
      )}

      {sf.aboutGuest && (
        <div className="sfNote">
          <span className="label">About guest</span>
          <div className="plainText multiline">{sf.aboutGuest}</div>
        </div>
      )}

      {sf.summary && (
        <div className="sfNote sfGenerated">
          <div className="plainText multiline">{sf.summary}</div>
          {sf.summaryUpdated && <div className="sfStamp">Generated {sf.summaryUpdated}</div>}
        </div>
      )}
    </section>
  );
}

function Stat({ value, label, note }) {
  if (!hasValue(value)) return null;
  return (
    <div className="stat">
      <div className="statValue">{formatValue(value)}</div>
      <div className="statLabel">{label}</div>
      {hasValue(note) && <div className="statNote">{formatValue(note)}</div>}
    </div>
  );
}

function Touch({ label, value, note }) {
  if (!hasValue(value)) return null;
  return (
    <div className="touch">
      <span className="touchLabel">{label}</span>
      <span className="touchValue">{formatValue(value)}</span>
      {note && <span className="touchNote">{formatValue(note)}</span>}
    </div>
  );
}

/**
 * The amber "read this before you speak to them" block. These fields are
 * already curated by a human in the CRM, so they render automatically.
 */
function FlagBlock({ flags }) {
  if (!hasValue(flags.clientFlag)) return null;

  return (
    <section className="copyBlock warningBlock">
      <span className="label">Client flag</span>
      <div className="plainText multiline">{formatValue(flags.clientFlag)}</div>
    </section>
  );
}

function ContactCard({ customer }) {
  const p = customer?.profile || {};
  const phone = p.phone || customer?.fields?.['Phone Number'];

  return (
    <section className="summaryStack">
      {p.viaAgent && (
        <div className="agentNotice">
          Booked through a travel agent — check before contacting the guest directly
        </div>
      )}
      <div className="infoGrid contactGrid">
        <PhoneRow value={phone} />
        <LocalTime state={p.state} country={p.country} timezone={p.timezone} />
        {crmUrl(customer) && (
          <a className="iconButton crmInlineButton" href={crmUrl(customer)} rel="noreferrer" target="_blank" title="Open customer in CRM">
            <span aria-hidden="true">&rarr;</span>
          </a>
        )}
      </div>
    </section>
  );
}

function LeadsTable({ leads }) {
  if (!leads?.length) return null;

  return (
    <section className="section">
      <div className="dataTable leadsTable">
        <div className="tableHeader">
          <span>Lead Trip</span>
          <span>Status</span>
          <span>Date</span>
          <span />
        </div>
        {leads.map((lead) => (
          <LeadRow key={lead.id} lead={lead} />
        ))}
      </div>
    </section>
  );
}

function LeadRow({ lead }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bookingRowWrapper">
      <div className="tableRow">
        <span className="mainCell">{lead.trip}</span>
        <span>{lead.status}</span>
        <span>{lead.dateAdded}</span>
        <div className="rowActions">
          <button className="chevronButton" onClick={() => setExpanded(!expanded)} title="Booking notes">
            {expanded ? '▲' : '▼'}
          </button>
          <ExternalLink href={crmUrl(lead)} label="Open lead in CRM" />
        </div>
      </div>
      {expanded && (
        <NotesEditor
          recordId={lead.id}
          recordType="lead"
          initialNotes={lead.notes}
          placeholder="Booking Notes"
        />
      )}
    </div>
  );
}

function TripsSection({ bookings }) {
  const active = bookings.active || [];
  const upcoming = bookings.upcoming || [];
  const past = bookings.past || [];
  const cancelled = bookings.cancelled || [];

  if (!active.length && !upcoming.length && !past.length && !cancelled.length) return null;

  return (
    <section className="tripsSection">
      <div className="tripGroups">
        <TripGroup rows={active} title="Active Trips" />
        <TripGroup rows={upcoming} title="Upcoming Trips" />
        <TripGroup rows={past} title="Past Trips" />
        <TripGroup rows={cancelled} title="Cancelled Trips" />
      </div>
    </section>
  );
}

function TripGroup({ rows, title }) {
  if (!rows?.length) return null;

  return (
    <div className="tripGroup">
      <div className="groupTitle">{title}</div>
      <div className="dataTable tripsTable">
        {rows.map((booking) => (
          <BookingRow key={booking.id} booking={booking} />
        ))}
      </div>
    </div>
  );
}

/**
 * Editable notes, shared by bookings and leads. Both write to a native long
 * text field; only the record type differs, and the API whitelists which
 * table and field each type maps to.
 */
function NotesEditor({ recordId, recordType, initialNotes, placeholder }) {
  const [notes, setNotes] = useState(initialNotes || '');
  const [saveStatus, setSaveStatus] = useState(null);

  async function handleSave() {
    setSaveStatus('saving');
    try {
      const res = await fetch('/api/airtable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId, recordType, notes }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.details || body.error || 'Failed');
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus('error');
      console.error('Save failed:', err.message);
    }
  }

  const saveLabel = saveStatus === 'saving' ? 'Saving...'
    : saveStatus === 'saved' ? 'Saved'
    : saveStatus === 'error' ? 'Error'
    : 'Save';

  return (
    <div className="notesPanel">
      <textarea
        className="notesTextarea"
        placeholder={placeholder}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />
      <button className="saveNotesButton" disabled={saveStatus === 'saving'} onClick={handleSave}>
        {saveLabel}
      </button>
    </div>
  );
}

function BookingRow({ booking }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bookingRowWrapper">
      <div className={`tableRow tripRow ${booking.group}`}>
        <span className="mainCell">
          {booking.name}
          {booking.coordinator && <span className="coordinatorName">{booking.coordinator}</span>}
        </span>
        <span>{booking.startDate}</span>
        <div className="rowActions">
          <button className="chevronButton" onClick={() => setExpanded(!expanded)} title="Booking notes">
            {expanded ? '▲' : '▼'}
          </button>
          <ExternalLink href={crmUrl(booking)} label="Open booking in CRM" />
        </div>
      </div>
      {expanded && (
        <NotesEditor
          recordId={booking.id}
          recordType="booking"
          initialNotes={booking.notes}
          placeholder="Booking Notes"
        />
      )}
    </div>
  );
}

/**
 * Guest local time, so a BM knows whether it is a reasonable hour to ring
 * before they ring. IANA zone names are used rather than fixed offsets, so
 * daylight saving is handled by the browser rather than by us.
 *
 * States are resolved WITHIN a country, never globally. WA is both Western
 * Australia and Washington State; NT is both Northern Territory and Northwest
 * Territories. A flat lookup would put a Seattle guest in Perth.
 *
 * Written as zone -> states so the table stays readable, then flattened.
 * Both abbreviations and full names are listed because the field holds either.
 */
function flattenZoneGroups(groups) {
  const lookup = {};
  for (const [zone, names] of Object.entries(groups)) {
    for (const name of names) lookup[name.toUpperCase()] = zone;
  }
  return lookup;
}

const STATE_ZONES = {
  AUSTRALIA: flattenZoneGroups({
    'Australia/Sydney': ['NSW', 'New South Wales', 'ACT', 'Australian Capital Territory'],
    'Australia/Melbourne': ['VIC', 'Victoria'],
    'Australia/Brisbane': ['QLD', 'Queensland'],
    'Australia/Adelaide': ['SA', 'South Australia'],
    'Australia/Perth': ['WA', 'Western Australia'],
    'Australia/Hobart': ['TAS', 'Tasmania'],
    'Australia/Darwin': ['NT', 'Northern Territory'],
  }),
  'UNITED STATES': flattenZoneGroups({
    'America/New_York': ['CT', 'Connecticut', 'DE', 'Delaware', 'DC', 'District of Columbia', 'FL', 'Florida', 'GA', 'Georgia', 'IN', 'Indiana', 'KY', 'Kentucky', 'ME', 'Maine', 'MD', 'Maryland', 'MA', 'Massachusetts', 'MI', 'Michigan', 'NH', 'New Hampshire', 'NJ', 'New Jersey', 'NY', 'New York', 'NC', 'North Carolina', 'OH', 'Ohio', 'PA', 'Pennsylvania', 'RI', 'Rhode Island', 'SC', 'South Carolina', 'VT', 'Vermont', 'VA', 'Virginia', 'WV', 'West Virginia'],
    'America/Chicago': ['AL', 'Alabama', 'AR', 'Arkansas', 'IL', 'Illinois', 'IA', 'Iowa', 'KS', 'Kansas', 'LA', 'Louisiana', 'MN', 'Minnesota', 'MS', 'Mississippi', 'MO', 'Missouri', 'NE', 'Nebraska', 'ND', 'North Dakota', 'OK', 'Oklahoma', 'SD', 'South Dakota', 'TN', 'Tennessee', 'TX', 'Texas', 'WI', 'Wisconsin'],
    'America/Denver': ['CO', 'Colorado', 'ID', 'Idaho', 'MT', 'Montana', 'NM', 'New Mexico', 'UT', 'Utah', 'WY', 'Wyoming'],
    // Arizona does not observe daylight saving, so it needs its own zone.
    'America/Phoenix': ['AZ', 'Arizona'],
    'America/Los_Angeles': ['CA', 'California', 'NV', 'Nevada', 'OR', 'Oregon', 'WA', 'Washington'],
    'America/Anchorage': ['AK', 'Alaska'],
    'Pacific/Honolulu': ['HI', 'Hawaii'],
  }),
  CANADA: flattenZoneGroups({
    'America/Vancouver': ['BC', 'British Columbia'],
    'America/Edmonton': ['AB', 'Alberta'],
    // Saskatchewan does not observe daylight saving.
    'America/Regina': ['SK', 'Saskatchewan'],
    'America/Winnipeg': ['MB', 'Manitoba'],
    'America/Toronto': ['ON', 'Ontario', 'QC', 'Quebec', 'Québec'],
    'America/Halifax': ['NB', 'New Brunswick', 'NS', 'Nova Scotia', 'PE', 'PEI', 'Prince Edward Island'],
    'America/St_Johns': ['NL', 'Newfoundland', 'Newfoundland and Labrador'],
    'America/Whitehorse': ['YT', 'Yukon'],
    'America/Yellowknife': ['NT', 'Northwest Territories'],
    'America/Iqaluit': ['NU', 'Nunavut'],
  }),
  MEXICO: flattenZoneGroups({
    'America/Tijuana': ['Baja California'],
    'America/Mazatlan': ['BCS', 'Baja California Sur', 'Sinaloa', 'Nayarit'],
    'America/Hermosillo': ['Sonora'],
    'America/Cancun': ['Quintana Roo'],
  }),
};

/**
 * State abbreviations that mean different places in different countries.
 * Only consulted when Country is blank, where we have no way to choose.
 */
const STATE_AMBIGUOUS_WITHOUT_COUNTRY = new Set(['WA', 'NT']);

/** Free-text country values normalised to the keys used above. */
const COUNTRY_ALIASES = {
  AU: 'AUSTRALIA', AUS: 'AUSTRALIA', AUSTRALIA: 'AUSTRALIA',
  US: 'UNITED STATES', USA: 'UNITED STATES', 'U.S.': 'UNITED STATES',
  'UNITED STATES': 'UNITED STATES', 'UNITED STATES OF AMERICA': 'UNITED STATES', AMERICA: 'UNITED STATES',
  CA: 'CANADA', CAN: 'CANADA', CANADA: 'CANADA',
  MX: 'MEXICO', MEX: 'MEXICO', MEXICO: 'MEXICO',
  NZ: 'NEW ZEALAND', 'NEW ZEALAND': 'NEW ZEALAND',
  UK: 'UNITED KINGDOM', GB: 'UNITED KINGDOM', 'UNITED KINGDOM': 'UNITED KINGDOM',
  'GREAT BRITAIN': 'UNITED KINGDOM', ENGLAND: 'UNITED KINGDOM',
  SCOTLAND: 'UNITED KINGDOM', WALES: 'UNITED KINGDOM', 'NORTHERN IRELAND': 'UNITED KINGDOM',
  IRELAND: 'IRELAND', IE: 'IRELAND',
  SINGAPORE: 'SINGAPORE', 'SOUTH AFRICA': 'SOUTH AFRICA',
};

/**
 * Country-level fallback. `spans` marks countries covering several zones —
 * only those produce the "zone assumed" caveat, because only those are a
 * guess. New Zealand and the UK are single-zone, so no caveat is warranted.
 */
const COUNTRY_ZONES = {
  AUSTRALIA: { zone: 'Australia/Sydney', spans: true },
  'UNITED STATES': { zone: 'America/New_York', spans: true },
  CANADA: { zone: 'America/Toronto', spans: true },
  MEXICO: { zone: 'America/Mexico_City', spans: true },
  'NEW ZEALAND': { zone: 'Pacific/Auckland' },
  'UNITED KINGDOM': { zone: 'Europe/London' },
  IRELAND: { zone: 'Europe/Dublin' },
  SINGAPORE: { zone: 'Asia/Singapore' },
  'SOUTH AFRICA': { zone: 'Africa/Johannesburg' },
};

/** True only for zone names this browser actually recognises. */
function isValidZone(zone) {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function resolveTimeZone(state, country, explicitZone) {
  // An explicit Timezone field on the customer wins over everything else.
  // Validated first, so a typo falls back rather than crashing the panel.
  if (isValidZone(explicitZone)) {
    return { zone: explicitZone, approximate: false };
  }

  const rawCountry = String(country || '').trim().toUpperCase();
  const normalisedState = String(state || '').trim().toUpperCase();

  // Country is captured on every lead enquiry (phone country code + IP), so a
  // blank one means a legacy or broken record rather than a domestic guest.
  // Rather than assume Australia, resolve only from a state that could not
  // belong anywhere else — WA and NT are excluded because they are also
  // Washington and Northwest Territories.
  if (!rawCountry) {
    const zone = STATE_ZONES.AUSTRALIA[normalisedState];
    if (zone && !STATE_AMBIGUOUS_WITHOUT_COUNTRY.has(normalisedState)) {
      return { zone, approximate: false };
    }
    return null;
  }

  const normalisedCountry = COUNTRY_ALIASES[rawCountry];
  if (!normalisedCountry) return null;

  // State resolved inside its own country. Exact, so no caveat.
  const zoneFromState = STATE_ZONES[normalisedCountry]?.[normalisedState];
  if (zoneFromState) return { zone: zoneFromState, approximate: false };

  const match = COUNTRY_ZONES[normalisedCountry];
  if (!match) return null;

  return { zone: match.zone, approximate: Boolean(match.spans) };
}

/**
 * 24h clock in the guest's zone, without doing offset maths ourselves.
 * The zone abbreviation is included deliberately — seeing AEDT rather than
 * AEST in November is how a BM can tell daylight saving is being handled.
 */
function readZoneTime(timeZone) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(new Date());

  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const abbrev = parts.find((part) => part.type === 'timeZoneName')?.value || '';
  const suffix = hour < 12 ? 'am' : 'pm';
  const display = `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, '0')} ${suffix}`;

  const base = { display, abbrev };
  if (hour >= 5 && hour < 8) return { ...base, band: 'Early morning', call: 'edge' };
  if (hour >= 8 && hour < 12) return { ...base, band: 'Morning', call: 'ok' };
  if (hour >= 12 && hour < 16) return { ...base, band: 'Afternoon', call: 'ok' };
  if (hour >= 16 && hour < 19) return { ...base, band: 'Late afternoon', call: 'ok' };
  if (hour >= 19 && hour < 22) return { ...base, band: 'Evening', call: 'edge' };
  return { ...base, band: 'Night', call: 'no' };
}

function LocalTime({ state, country, timezone }) {
  const resolved = useMemo(
    () => resolveTimeZone(state, country, timezone),
    [state, country, timezone],
  );
  const zone = resolved?.zone || null;
  const [now, setNow] = useState(() => (zone ? readZoneTime(zone) : null));

  useEffect(() => {
    if (!zone) {
      setNow(null);
      return undefined;
    }
    setNow(readZoneTime(zone));
    const id = setInterval(() => setNow(readZoneTime(zone)), 30000);
    return () => clearInterval(id);
  }, [zone]);

  // No state or country on the record — show nothing rather than guess.
  // A wrong time is worse than no time; someone would ring at 6am on it.
  if (!zone || !now) return null;

  const callLabel = now.call === 'ok' ? 'Good time to call'
    : now.call === 'edge' ? 'Early / late'
    : 'Middle of the night';

  return (
    <div className="infoRow localTime">
      <div>
        <Text size={11} className="label">Guest time</Text>
        <span>{now.display} {now.abbrev}</span>
      </div>
      <span className={`chip callChip call-${now.call}`}>{callLabel}</span>
      <span className="localTimeBand">
        {now.band}
        {resolved.approximate && (
          <span className="zoneCaveat" title={`Zone assumed from country only (${zone}). Confirm with the guest.`}>
            {' '}· zone assumed from country
          </span>
        )}
      </span>
    </div>
  );
}

function InfoRow({ label, value }) {
  if (!hasValue(value)) return null;

  return (
    <div className="infoRow">
      <Text size={11} className="label">{label}</Text>
      <span>{formatValue(value)}</span>
    </div>
  );
}

function PhoneRow({ value }) {
  if (!hasValue(value)) return null;
  const text = formatValue(value);

  return (
    <div className="infoRow phoneRow">
      <div>
        <Text size={11} className="label">Phone</Text>
        <span>{text}</span>
      </div>
      <button className="copyIconButton" onClick={() => copyText(text)} title="Copy phone" type="button">
        Copy
      </button>
    </div>
  );
}

function ExternalLink({ href, label }) {
  return (
    <a className="rowLink" href={href} rel="noreferrer" target="_blank" title={label}>
      &rarr;
    </a>
  );
}

function TextBlock({ label, value, tone }) {
  if (!hasValue(value)) return null;
  return (
    <section className={tone === 'warning' ? 'copyBlock warningBlock' : 'copyBlock'}>
      <Text size={11} className="label">{label}</Text>
      <div className="plainText multiline">{formatValue(value)}</div>
    </section>
  );
}

function LoadingState() {
  return (
    <div className="message">
      <Spinner />
      <Text>Loading customer data...</Text>
    </div>
  );
}

function Message({ title, text }) {
  return (
    <section className="message">
      <Heading level="h2">{title}</Heading>
      <Text>{text}</Text>
    </section>
  );
}

function getCustomerEmails(customer) {
  if (!customer) return [];
  const emails = [];
  if (typeof customer.email === 'string') emails.push(customer.email);

  for (const item of customer.emails || []) {
    if (typeof item === 'string') emails.push(item);
    if (typeof item?.value === 'string') emails.push(item.value);
    if (typeof item?.email === 'string') emails.push(item.email);
  }

  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

// The API renamed stackerUrl -> crmUrl so the CRM can be swapped via env var.
// The fallback keeps links working if the frontend deploys ahead of the API.
function crmUrl(entity) {
  return entity?.crmUrl || entity?.stackerUrl || '';
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== '';
}

function formatValue(value) {
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return value.name || value.email || value.url || JSON.stringify(value);
  return String(value ?? '');
}

function copyText(text) {
  if (HelpScout.setClipboardText) {
    HelpScout.setClipboardText(text, 'Phone copied');
    return;
  }

  navigator.clipboard?.writeText(text);
}

export default App;
