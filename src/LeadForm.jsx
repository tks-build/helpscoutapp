import { useEffect, useId, useMemo, useState } from 'react';
import { apiFetch, sessionFailure, startSession } from './api.js';
import { suggestTrips } from './tripMatch.js';

/**
 * Add or update a customer and lead — the HelpScout Extractor extension's
 * form, moved into the panel.
 *
 * The extension read the guest's details off the Help Scout page, which broke
 * whenever Help Scout changed its layout. Here they come from the app payload
 * and, for website enquiries, from the form in the email itself (via
 * /api/enquiry). Submitting goes through /api/lead to the same Zaps as before.
 *
 * Fields, required fields and status list are the extension's, unchanged.
 */

// Trip suggestions shown as buttons. More than this crowds a narrow sidebar;
// the rest are a few keystrokes away in the Trip field's own search.
const MAX_TRIP_CHIPS = 4;

// One fetch of the dropdown contents per panel load, shared by every form.
let optionsRequest = null;
function loadOptions() {
  if (!optionsRequest) {
    optionsRequest = apiFetch('/api/lead')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'The form options could not be loaded.');
        return body;
      })
      .catch((error) => {
        optionsRequest = null;
        throw error;
      });
  }
  return optionsRequest;
}

const text = (value) => {
  if (Array.isArray(value)) return text(value[0]);
  return value === undefined || value === null ? '' : String(value).trim();
};

function splitName(fullName) {
  const parts = text(fullName).split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', surname: parts.slice(1).join(' ') };
}

/**
 * What the form opens with.
 *
 * Existing customer: the CRM's own values, so an update never silently
 * replaces a name with whatever Help Scout happens to hold. A blank CRM field
 * falls back to the enquiry, which is how a missing phone number gets filled.
 *
 * New customer: the enquiry form first, then the Help Scout profile. If the
 * two emails differ, the form's becomes the main one and the profile's the
 * alternate — the guest chose to be contacted on the one they typed.
 */
function initialValues({ customer, enquiry, context }) {
  const fields = customer?.fields || {};
  const hs = context?.customer || {};
  const fromForm = splitName(enquiry?.name);
  const profileEmail = text(hs.emails?.[0]?.value || hs.emails?.[0] || hs.email).toLowerCase();
  const profilePhone = text(hs.phones?.[0]?.value || hs.phones?.[0]);

  if (customer?.id) {
    return {
      firstName: text(fields['First Name']) || fromForm.firstName || text(hs.firstName),
      preferredName: text(fields['Preferred Name']),
      surname: text(fields.Surname) || fromForm.surname || text(hs.lastName),
      email: text(fields['Client Email']) || text(customer.matchedEmail),
      altEmail: text(fields['Alt Email']),
      altEmail2: text(fields['Alt Email 2']),
      phone: text(fields['Phone Number']) || text(enquiry?.phone) || profilePhone,
    };
  }

  const email = text(enquiry?.email) || profileEmail;
  return {
    firstName: fromForm.firstName || text(hs.firstName),
    preferredName: '',
    surname: fromForm.surname || text(hs.lastName),
    email,
    altEmail: profileEmail && profileEmail !== email ? profileEmail : '',
    altEmail2: '',
    phone: text(enquiry?.phone) || profilePhone,
  };
}

export default function LeadForm({ customer, enquiry, context, onSubmitted, onExistingCustomer }) {
  const isUpdate = Boolean(customer?.id);
  const tripListId = useId();

  const [values, setValues] = useState(() => initialValues({ customer, enquiry, context }));
  const [touched, setTouched] = useState(false);
  const [tripName, setTripName] = useState('');
  const [tags, setTags] = useState([]);
  const [tagFilter, setTagFilter] = useState('');
  const [tagsOpen, setTagsOpen] = useState(false);
  const [teamContactId, setTeamContactId] = useState('');
  const [status, setStatus] = useState('');
  const [options, setOptions] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [submitState, setSubmitState] = useState({ phase: 'idle' });
  const [showErrors, setShowErrors] = useState(false);

  // The enquiry arrives a moment after the panel. Fill it in when it does,
  // unless the BM has already started typing.
  useEffect(() => {
    if (!touched) setValues(initialValues({ customer, enquiry, context }));
  }, [customer, enquiry, context, touched]);

  useEffect(() => {
    let active = true;
    startSession()
      .then((ok) => {
        if (!ok) throw new Error(sessionFailure() || 'The lead form is not available.');
        return loadOptions();
      })
      .then((body) => active && setOptions(body))
      .catch((error) => active && setLoadError(error.message));
    return () => {
      active = false;
    };
  }, []);

  // Default the team contact to whoever is signed in to Help Scout, when
  // their name matches a booking manager exactly.
  useEffect(() => {
    if (!options || teamContactId) return;
    const me = [context?.user?.firstName, context?.user?.lastName].map(text).filter(Boolean).join(' ').toLowerCase();
    const match = me && options.teamMembers.find((member) => member.name.toLowerCase() === me);
    if (match) setTeamContactId(match.id);
  }, [options, context, teamContactId]);

  const trip = useMemo(
    () => options?.trips.find((item) => item.name === tripName.trim()) || null,
    [options, tripName],
  );

  // Trips whose title matches what the guest typed on the enquiry form.
  const tripSuggestions = useMemo(
    () => (options && !trip ? suggestTrips(options.trips, enquiry?.trip) : []),
    [options, enquiry, trip],
  );

  const errors = {
    email: !values.email.trim(),
    trip: Boolean(tripName.trim()) && !trip,
    teamContact: !teamContactId,
    status: !status,
  };
  const invalid = Object.values(errors).some(Boolean);

  const set = (key) => (event) => {
    setTouched(true);
    setValues((current) => ({ ...current, [key]: event.target.value }));
  };

  const toggleTag = (name) => {
    setTags((current) => (current.includes(name) ? current.filter((tag) => tag !== name) : [...current, name]));
  };

  async function submit(event) {
    event.preventDefault();
    setShowErrors(true);
    if (invalid || submitState.phase === 'sending') return;

    setSubmitState({ phase: 'sending' });
    try {
      const response = await apiFetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: customer?.id || '',
          ...values,
          tripId: trip?.id || '',
          tags,
          teamContactId,
          status,
        }),
      });
      const body = await response.json().catch(() => ({}));

      if (response.status === 409) {
        setSubmitState({ phase: 'exists', email: body.existingEmail || values.email });
        return;
      }
      if (!response.ok) throw new Error(body.error || 'The lead could not be sent.');

      setSubmitState({ phase: 'done', action: body.action, dryRun: body.dryRun, payload: body.payload });
      if (!body.dryRun) onSubmitted?.(body.action);
    } catch (error) {
      setSubmitState({ phase: 'error', message: error.message });
    }
  }

  if (loadError) {
    return <div className="leadNotice leadNoticeError">Lead form unavailable. {loadError}</div>;
  }
  if (!options) {
    return <div className="leadNotice">Loading the lead form…</div>;
  }

  const visibleTags = options.tags.filter((name) => name.toLowerCase().includes(tagFilter.trim().toLowerCase()));

  return (
    <form className="leadForm" noValidate onSubmit={submit}>
      {options.warnings?.length ? <div className="leadNotice leadNoticeWarn">{options.warnings.join(' ')}</div> : null}

      <div className="leadGrid">
        <Field label="First name" value={values.firstName} onChange={set('firstName')} />
        <Field label="Preferred name" value={values.preferredName} onChange={set('preferredName')} />
        <Field label="Surname" value={values.surname} onChange={set('surname')} wide />
        <Field
          label="Email"
          value={values.email}
          onChange={set('email')}
          type="email"
          wide
          error={showErrors && errors.email ? 'Required' : ''}
        />
        <Field label="Alternate email 1" value={values.altEmail} onChange={set('altEmail')} type="email" wide />
        <Field label="Alternate email 2" value={values.altEmail2} onChange={set('altEmail2')} type="email" wide />
        <Field label="Phone number" value={values.phone} onChange={set('phone')} wide />
      </div>

      <label className="leadField">
        <span className="leadLabel">
          Trip
          {showErrors && errors.trip ? <span className="leadError">Pick one from the list</span> : null}
        </span>
        <input
          className={`leadInput ${showErrors && errors.trip ? 'invalid' : ''}`}
          list={tripListId}
          onChange={(event) => setTripName(event.target.value)}
          placeholder="Type to search trips"
          value={tripName}
        />
        <datalist id={tripListId}>
          {options.trips.map((item) => <option key={item.id} value={item.name} />)}
        </datalist>
      </label>
      {tripSuggestions.length ? (
        <div className="leadSuggest">
          <span className="leadSuggestLabel">Asked about “{text(enquiry?.trip)}”:</span>
          {tripSuggestions.slice(0, MAX_TRIP_CHIPS).map((item) => (
            <button className="leadChip" key={item.id} onClick={() => setTripName(item.name)} type="button">
              {item.name}
            </button>
          ))}
          {tripSuggestions.length > MAX_TRIP_CHIPS ? (
            <span className="leadSuggestLabel">
              +{tripSuggestions.length - MAX_TRIP_CHIPS} more — type in Trip to see them all
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="leadField">
        <button className="leadTagsToggle" onClick={() => setTagsOpen(!tagsOpen)} type="button">
          <span className="leadLabel">Tags</span>
          <span className="leadTagsSummary">{tags.length ? tags.join(', ') : 'None selected'}</span>
          <span className="activityChevron">{tagsOpen ? '▲' : '▼'}</span>
        </button>
        {tagsOpen ? (
          <div className="leadTags">
            <input
              className="leadInput"
              onChange={(event) => setTagFilter(event.target.value)}
              placeholder="Filter tags"
              value={tagFilter}
            />
            <div className="leadTagList">
              {visibleTags.map((name) => (
                <label className="leadTagOption" key={name}>
                  <input checked={tags.includes(name)} onChange={() => toggleTag(name)} type="checkbox" />
                  {name}
                </label>
              ))}
              {!visibleTags.length ? <span className="leadMuted">No tags match.</span> : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="leadGrid">
        <label className="leadField">
          <span className="leadLabel">
            Team contact
            {showErrors && errors.teamContact ? <span className="leadError">Required</span> : null}
          </span>
          <select
            className={`leadInput ${showErrors && errors.teamContact ? 'invalid' : ''}`}
            onChange={(event) => setTeamContactId(event.target.value)}
            value={teamContactId}
          >
            <option value="">Choose…</option>
            {options.teamMembers.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
        </label>
        <label className="leadField">
          <span className="leadLabel">
            Status
            {showErrors && errors.status ? <span className="leadError">Required</span> : null}
          </span>
          <select
            className={`leadInput ${showErrors && errors.status ? 'invalid' : ''}`}
            onChange={(event) => setStatus(event.target.value)}
            value={status}
          >
            <option value="">Choose…</option>
            {options.statuses.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>

      <button className="primaryButton leadSubmit" disabled={submitState.phase === 'sending'} type="submit">
        {submitState.phase === 'sending' ? 'Sending…' : isUpdate ? 'Update customer & add lead' : 'Add customer & lead'}
      </button>
      {options.dryRun ? <div className="leadNotice leadNoticeWarn">Test mode: nothing is sent to Zapier.</div> : null}

      <SubmitResult state={submitState} onExistingCustomer={onExistingCustomer} />
    </form>
  );
}

function Field({ label, value, onChange, type = 'text', wide = false, error = '' }) {
  return (
    <label className={`leadField ${wide ? 'wide' : ''}`}>
      <span className="leadLabel">
        {label}
        {error ? <span className="leadError">{error}</span> : null}
      </span>
      <input
        autoComplete="off"
        className={`leadInput ${error ? 'invalid' : ''}`}
        onChange={onChange}
        type={type}
        value={value}
      />
    </label>
  );
}

function SubmitResult({ state, onExistingCustomer }) {
  if (state.phase === 'error') {
    return <div className="leadNotice leadNoticeError">{state.message}</div>;
  }

  if (state.phase === 'exists') {
    return (
      <div className="leadNotice leadNoticeWarn">
        A customer with {state.email} already exists, so nothing was sent.{' '}
        <button className="leadLinkButton" onClick={() => onExistingCustomer?.(state.email)} type="button">
          Show that customer
        </button>
      </div>
    );
  }

  if (state.phase === 'done' && state.dryRun) {
    return (
      <div className="leadNotice">
        Test mode — this is what would be sent to the “{state.action}” Zap:
        <pre className="leadPayload">{JSON.stringify(state.payload, null, 2)}</pre>
      </div>
    );
  }

  if (state.phase === 'done') {
    return (
      <div className="leadNotice leadNoticeOk">
        {state.action === 'create'
          ? 'Customer sent to the CRM. Their record will appear here in a few seconds.'
          : 'Update sent to the CRM. The new lead will appear here shortly.'}
      </div>
    );
  }

  return null;
}

/**
 * The website enquiry, as the guest filled it in. Shown above the form so a
 * BM can read the question without scrolling the thread, and so it is clear
 * where the prefilled values came from.
 */
export function EnquiryCard({ enquiry }) {
  if (!enquiry) return null;

  const rows = [
    ['Trip', enquiry.trip],
    ['Phone', enquiry.phone],
    ['SMS consent', enquiry.smsConsent],
  ].filter(([, value]) => value);

  if (!rows.length && !enquiry.message) return null;

  return (
    <section className="enquiryCard">
      <span className="label">Website enquiry</span>
      {rows.map(([label, value]) => (
        <div className="enquiryRow" key={label}>
          <span className="enquiryLabel">{label}</span>
          <span className="enquiryValue">{value}</span>
        </div>
      ))}
      {enquiry.message ? <p className="enquiryMessage">{enquiry.message}</p> : null}
    </section>
  );
}
