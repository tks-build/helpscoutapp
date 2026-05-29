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
      {profiles.map((profile, index) => (
        <ProfilePanel
          key={profile.customer?.id || index}
          profile={profile}
          showEmail={index > 0}
        />
      ))}
    </>
  );
}

function ProfilePanel({ profile, showEmail }) {
  const customer = profile.customer;
  const fields = customer?.fields || {};
  const age = fields.Age;
  const phone = fields['Phone Number'];
  const clientFlag = fields['Client Flag'];
  const notFit = Boolean(fields['Not a Fit']);
  const leads = profile.leads || [];
  const bookings = profile.bookings || {};

  return (
    <section className="profilePanel">
      {notFit && <div className="alert">Not a Fit</div>}
      {clientFlag && <TextBlock label="Client Flag" value={clientFlag} tone="warning" />}

      <section className="summaryStack">
        {showEmail && <InfoRow label="Email" value={customer?.matchedEmail || fields['Client Email']} />}
        <div className="infoGrid">
          <PhoneRow value={phone} />
          <InfoRow label="Age" value={age} />
          {customer?.stackerUrl && (
            <a className="iconButton stackerInlineButton" href={customer.stackerUrl} rel="noreferrer" target="_blank" title="Open customer in Stacker">
              <span aria-hidden="true">&rarr;</span>
            </a>
          )}
        </div>
      </section>

      <TripsSection bookings={bookings} />
      <LeadsTable leads={leads} />

      <a className="primaryButton" href={customer?.calendlyUrl} rel="noreferrer" target="_blank">
        Calendly link
      </a>
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
          <div className="tableRow" key={lead.id}>
            <span className="mainCell">{lead.trip}</span>
            <span>{lead.status}</span>
            <span>{lead.dateAdded}</span>
            <ExternalLink href={lead.stackerUrl} label="Open lead" />
          </div>
        ))}
      </div>
    </section>
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

function BookingRow({ booking }) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(booking.notes || '');
  const [saveStatus, setSaveStatus] = useState(null);

  async function handleSave() {
    setSaveStatus('saving');
    try {
      const res = await fetch('/api/airtable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId: booking.id, notes }),
      });
      if (!res.ok) throw new Error('Failed');
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch {
      setSaveStatus('error');
    }
  }

  const saveLabel = saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? 'Error' : 'Save';

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
          <ExternalLink href={booking.stackerUrl} label="Open booking" />
        </div>
      </div>
      {expanded && (
        <div className="notesPanel">
          <textarea
            className="notesTextarea"
            placeholder="Booking Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <button className="saveNotesButton" disabled={saveStatus === 'saving'} onClick={handleSave}>
            {saveLabel}
          </button>
        </div>
      )}
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
