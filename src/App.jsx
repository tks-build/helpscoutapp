import HelpScout from '@helpscout/javascript-sdk';
import { DefaultStyle, Heading, Spinner, Text, useSetAppHeight } from '@helpscout/ui-kit';
import { useEffect, useMemo, useState } from 'react';

/**
 * Activity log rollout flags.
 *
 * BMs are still writing into Stacker's native activity feed, so the panel must
 * not offer a second place to write — notes split across two systems are worse
 * than notes in the wrong one, because neither is complete.
 *
 * The Postgres store, API and UI are built and working. Set these to true when
 * the team moves across. The link through to Stacker stays visible either way.
 */
const ACTIVITY_WRITE_ENABLED = false;
const ACTIVITY_COPY_REPLY_ENABLED = false;

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
        <HomePage customerData={customerData} context={context} />
      )}
    </main>
  );
}

function HomePage({ customerData, context }) {
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
          context={context}
        />
      ))}
    </>
  );
}

function ProfilePanel({ profile, showEmail, context }) {
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

      <ActivityLog
        customerId={customer?.id}
        customerEmail={customer?.matchedEmail || fields['Client Email']}
        context={context}
        crmUrl={customer?.crmActivityUrl || crmUrl(customer)}
      />

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

  // Older API responses have no group, in which case everything is open.
  const open = leads.filter((lead) => !lead.group || lead.group === 'open');
  const converted = leads.filter((lead) => lead.group === 'converted');
  const closed = leads.filter((lead) => lead.group === 'closed');

  return (
    <section className="section">
      <LeadGroup leads={open} title="Open leads" defaultOpen />
      <LeadGroup leads={converted} title="Converted" />
      <LeadGroup leads={closed} title="Closed" />
    </section>
  );
}

/**
 * Converted and closed leads stay reachable but collapsed. A repeat guest can
 * carry a dozen of each, and the lead record holds the preliminary notes a BM
 * wrote before the trip was booked — losing that at conversion loses the story.
 */
function LeadGroup({ leads, title, defaultOpen = false }) {
  if (!leads.length) return null;

  return (
    <CollapsibleGroup title={title} count={leads.length} defaultOpen={defaultOpen}>
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
    </CollapsibleGroup>
  );
}

/**
 * Shared collapsible section header, used by both trip and lead groups so the
 * two read identically. Groups needing action open by default; history does not.
 */
function CollapsibleGroup({ title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="collapsibleGroup">
      <button className="activityToggle" onClick={() => setOpen(!open)} type="button">
        <span className="activityChevron">{open ? '▲' : '▼'}</span>
        {title}
        {count > 0 && <span className="activityCount">{count}</span>}
      </button>
      {open && children}
    </div>
  );
}

/**
 * Activity Log — a composer over a newest-first feed.
 *
 * Author and timestamp are recorded as fields rather than typed into the body,
 * so entries stay consistent instead of drifting between "19AUG26 FP:" and
 * "20 AUG CJ" depending on who wrote them.
 */
function ActivityLog({ customerId, customerEmail, context, crmUrl: crmLink }) {
  const [feed, setFeed] = useState([]);
  const [body, setBody] = useState('');
  const [status, setStatus] = useState(null);
  // Collapsed by default. The feed grows without limit and would otherwise
  // push everything else off the bottom of the sidebar.
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Fetched separately from the Airtable profile, because the feed lives in
  // Postgres. Only loaded once the section is opened — most conversations
  // never need it, and it keeps the panel's first paint fast.
  useEffect(() => {
    if (!open || !customerId) return undefined;

    let active = true;
    const params = new URLSearchParams();
    if (customerId) params.set('customerRef', customerId);
    if (customerEmail) params.set('email', customerEmail);

    fetch(`/api/activity?${params}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        setFeed(payload.entries || []);
      })
      .catch((error) => console.error('Could not load activity:', error.message));

    return () => { active = false; };
  }, [open, customerId, customerEmail]);

  const user = context?.user;
  // Some Help Scout profiles carry a placeholder surname like "." — including
  // it produces authors called "Kat .", so drop parts with no letters in them.
  const authorName = [user?.firstName, user?.lastName]
    .filter((part) => /\p{L}/u.test(String(part || '')))
    .join(' ');
  const conversationId = context?.conversation?.id;

  if (!customerId) return null;

  async function handlePost() {
    const text = body.trim();
    if (!text) return;

    setStatus('saving');
    try {
      const res = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerRef: customerId,
          customerEmail,
          body: text,
          type: 'note',
          authorName,
          authorEmail: user?.email,
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.details || payload.error || 'Failed');

      // Shown immediately rather than waiting for a refetch — the entry is
      // already saved, and a BM mid-call should see it land.
      setFeed([payload.entry, ...feed]);
      setBody('');
      setStatus(null);
    } catch (err) {
      setStatus('error');
      console.error('Activity save failed:', err.message);
    }
  }

  async function handleCopyReply() {
    if (!conversationId) return;
    setStatus('fetching');
    try {
      const res = await fetch(`/api/helpscout?conversationId=${conversationId}`);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.details || payload.error || 'Failed');
      if (!payload.reply) {
        setStatus('no-reply');
        return;
      }
      // Dropped into the composer rather than posted straight away, so it can
      // be trimmed before it becomes a permanent record.
      setBody(payload.reply.text);
      setStatus(null);
    } catch (err) {
      setStatus('error');
      console.error('Could not read last reply:', err.message);
    }
  }

  const statusMessage = status === 'error' ? 'Something went wrong — try again'
    : status === 'no-reply' ? 'No sent reply found on this conversation'
    : null;

  const visible = showAll ? feed : feed.slice(0, 5);

  return (
    <section className="activitySection">
      <div className="activityHeader">
        {ACTIVITY_WRITE_ENABLED ? (
          <button className="activityToggle" onClick={() => setOpen(!open)} type="button">
            <span className="activityChevron">{open ? '▲' : '▼'}</span>
            Activity log
            {feed.length > 0 && <span className="activityCount">{feed.length}</span>}
          </button>
        ) : (
          <span className="groupTitle">Activity log</span>
        )}
        {crmLink && (
          <a
            className="iconButton"
            href={crmLink}
            rel="noreferrer"
            target="_blank"
            title="Open activity in CRM"
          >
            <span aria-hidden="true">&rarr;</span>
          </a>
        )}
      </div>

      {!ACTIVITY_WRITE_ENABLED || !open ? null : (
      <>
      <div className="activityComposer">
        <textarea
          className="notesTextarea"
          placeholder="Add a note…"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <div className="activityActions">
          {ACTIVITY_COPY_REPLY_ENABLED && conversationId && (
            <button className="chevronButton activityCopyButton" onClick={handleCopyReply} type="button">
              {status === 'fetching' ? 'Loading…' : 'Copy last reply'}
            </button>
          )}
          <button
            className="saveNotesButton"
            disabled={status === 'saving' || !body.trim()}
            onClick={handlePost}
            type="button"
          >
            {status === 'saving' ? 'Posting…' : 'Post'}
          </button>
        </div>
        {statusMessage && <div className="activityStatus">{statusMessage}</div>}
      </div>

      {visible.map((entry) => (
        <div className="activityEntry" key={entry.id}>
          <div className="activityMeta">
            <span className="activityAuthor">{entry.author || 'Unknown'}</span>
            <span className="activityTime">{relativeTime(entry.occurredAt)}</span>
          </div>
          <div className="plainText multiline">{entry.body}</div>
        </div>
      ))}

      {feed.length > 5 && (
        <button className="activityMore" onClick={() => setShowAll(!showAll)} type="button">
          {showAll ? 'Show fewer' : `Show all ${feed.length} entries`}
        </button>
      )}
      </>
      )}
    </section>
  );
}

/** Matches how the Stacker feed reads — "2 days ago" rather than a date. */
function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!then) return '';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.round(hours / 24);
  if (days < 31) return days === 1 ? 'yesterday' : `${days} days ago`;

  const months = Math.round(days / 30);
  if (months < 12) return months === 1 ? 'a month ago' : `${months} months ago`;

  const years = Math.round(months / 12);
  return years === 1 ? 'a year ago' : `${years} years ago`;
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
        <>
          {/* Free-text interest note. Read-only here — it is maintained in the
              CRM, and it used to be shown as though it were a trip name. */}
          {hasValue(lead.requests) && (
            <div className="leadRequests">
              <span className="label">Guest interest</span>
              <div className="plainText multiline">{formatValue(lead.requests)}</div>
            </div>
          )}
          <NotesEditor
            recordId={lead.id}
            recordType="lead"
            initialNotes={lead.notes}
            placeholder="Booking Notes"
          />
        </>
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
        {/* Live and upcoming trips are what a BM acts on, so they stay open.
            History collapses — a ten-trip guest is otherwise most of the panel. */}
        <TripGroup rows={active} title="Active Trips" defaultOpen />
        <TripGroup rows={upcoming} title="Upcoming Trips" defaultOpen />
        <TripGroup rows={past} title="Past Trips" />
        <TripGroup rows={cancelled} title="Cancelled Trips" />
      </div>
    </section>
  );
}

function TripGroup({ rows, title, defaultOpen = false }) {
  if (!rows?.length) return null;

  return (
    <CollapsibleGroup title={title} count={rows.length} defaultOpen={defaultOpen}>
      <div className="dataTable tripsTable">
        {rows.map((booking) => (
          <BookingRow key={booking.id} booking={booking} />
        ))}
      </div>
    </CollapsibleGroup>
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
      <OpsBanner booking={booking} />
      <div className={`tableRow tripRow ${booking.group}`}>
        <span className="mainCell">
          {booking.name}
          <span className="coordinatorName">
            {booking.coordinator}
            {booking.feedback?.internalRating != null && (
              <span className={`ratingChip ${ratingTone(booking.feedback.internalRating)}`}>
                {booking.feedback.internalRating}/5
              </span>
            )}
          </span>
          {/* One-line summary on the collapsed row so a poor trip is visible
              without opening anything. Truncated by CSS rather than by us,
              so the full text is still there when expanded. */}
          {booking.feedback?.summary && (
            <span className="feedbackTeaser">{booking.feedback.summary}</span>
          )}
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
        <>
          {/* Past trips open onto their feedback rather than an editor —
              nobody is updating booking notes on a trip that has finished, and
              what they actually want is what the guest said about it.
              "Recent" trips keep the editor: they have only just ended and
              feedback usually has not been collected yet. */}
          {booking.group !== 'past' && (
            <NotesEditor
              recordId={booking.id}
              recordType="booking"
              initialNotes={booking.notes}
              placeholder="Booking Notes"
            />
          )}
          <BookingExtras booking={booking} />
          <BookingFeedback feedback={booking.feedback} />
          {booking.group === 'past' && !booking.feedback && (
            <div className="bookingExtras">
              <div className="noFeedback">No feedback given</div>
              {booking.notes && <Touch label="Booking notes" value={booking.notes} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ratingTone(rating) {
  if (rating >= 4.75) return 'ratingGood';
  if (rating < 4) return 'ratingPoor';
  return '';
}

/**
 * Ops fields and the roommate request, directly beneath Booking Notes.
 *
 * Ops asked for the chasing fields on upcoming trips specifically — on a past
 * booking they are history nobody acts on.
 */
function BookingExtras({ booking }) {
  const ops = booking.ops || {};
  const isUpcoming = booking.group === 'upcoming' || booking.group === 'active';
  const showOps = isUpcoming && (ops.coordDecision || ops.lastChased || ops.lastChasedNotes);

  if (!showOps && !booking.roommateRequest && !booking.bookingType) return null;

  return (
    <div className="bookingExtras">
      {booking.bookingType && <Touch label="Booking type" value={booking.bookingType} />}
      {booking.roommateRequest && <Touch label="Roommate request" value={booking.roommateRequest} />}
      {showOps && (
        <>
          <Touch label="Coord decision" value={ops.coordDecision} />
          <Touch label="Last chased" value={ops.lastChased} note={ops.lastChasedNotes} />
        </>
      )}
      {ops.extrasNotes && <Touch label="Extras notes" value={ops.extrasNotes} />}
    </div>
  );
}

/**
 * Ops banner, on upcoming trips only.
 *
 * Sits above the booking notes rather than inside the expanded detail: money
 * owed and days remaining are the things someone needs to see while scanning,
 * not after deciding to look closer.
 *
 * Extras show as categories. Price is only attached to the ones where it
 * changes what Ops do — extra nights and extensions.
 */
const PRICED_EXTRAS = ['Arrival Hotel Nights', 'Departure Hotel Nights', 'Trip Extension'];

function OpsBanner({ booking }) {
  const ops = booking.ops || {};
  const isUpcoming = booking.group === 'upcoming' || booking.group === 'active';
  if (!isUpcoming) return null;

  const extras = ops.extras || [];
  const hasAnything = ops.paymentPending || ops.daysUntilStart != null || extras.length > 0;
  if (!hasAnything) return null;

  // Amber only when something is actually owed. $0 still shows, in neutral —
  // it confirms the booking is settled rather than leaving Ops to wonder.
  const owes = (ops.paymentPendingAmount || 0) > 0;

  return (
    <div className="opsBanner">
      {ops.paymentPending && (
        <span className={`chip opsChip ${owes ? 'opsMoney' : ''}`}>
          {ops.paymentPending} pending
        </span>
      )}
      {ops.daysUntilStart != null && (
        <span className="chip opsChip">{ops.daysUntilStart} days to start</span>
      )}
      {extras.map((extra) => (
        <span className="chip opsChip" key={extra}>{extra}</span>
      ))}
    </div>
  );
}

/**
 * Post-trip feedback. Ratings and the headline summary show immediately; the
 * per-area detail sits behind a further toggle, because a BM checking a guest
 * before a call wants the shape of the trip, not the transcript.
 */
function BookingFeedback({ feedback }) {
  const [showDetail, setShowDetail] = useState(false);
  if (!feedback) return null;

  const hasDetail = feedback.summaries?.length > 0 || feedback.critical?.length > 0;

  return (
    <div className="bookingFeedback">
      <div className="feedbackRatings">
        {feedback.internalRating != null && (
          <span className={`ratingChip ${ratingTone(feedback.internalRating)}`}>
            Internal {feedback.internalRating}/5
          </span>
        )}
        {feedback.groupDynamicsRating != null && (
          <span className="ratingChip">Group {feedback.groupDynamicsRating}/5</span>
        )}
        {feedback.callDate && (
          <span className="feedbackCall">
            Call {feedback.callDate}{feedback.callHeldBy ? ` · ${feedback.callHeldBy}` : ''}
          </span>
        )}
      </div>

      {feedback.summary && <div className="plainText multiline">{feedback.summary}</div>}

      {hasDetail && (
        <button className="activityMore" onClick={() => setShowDetail(!showDetail)} type="button">
          {showDetail ? 'Hide detail' : 'Full feedback'}
        </button>
      )}

      {showDetail && (
        <>
          {feedback.summaries.map((item) => (
            <Touch key={item.key} label={item.label} value={item.text} />
          ))}
          {feedback.critical.map((item) => (
            <div className="criticalNote" key={item.key}>
              <span className="label">{item.label}</span>
              <div className="plainText multiline">{item.text}</div>
            </div>
          ))}
        </>
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
