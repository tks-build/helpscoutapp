/**
 * Builds the body sent to the two Zapier catch hooks.
 *
 * The Zaps are live and shared, so this reproduces the HelpScout Extractor
 * extension (v6.1.5) byte for byte: same keys, same order, same quirks.
 *
 *   - Record ids carry Stacker-style prefixes: cus_, tri_, tme_.
 *   - Trips and Team Contact are one-element arrays, or null when unset.
 *   - Tags is ONE string: tag names joined by newlines, most recently picked
 *     first, "" when none. (The extension sent its dropdown's visible text;
 *     confirmed by running that dropdown in a browser.)
 *   - An update carries "id" first; a create has no "id" key at all.
 *
 * Do not "tidy" any of this without changing the Zaps to match.
 */

export const LEAD_STATUSES = [
  'Future Interest',
  'Waitlist',
  'Registration of Interest',
  'Strong Interest',
  'Pending Deposit',
];

const isRecordId = (value) => typeof value === 'string' && /^rec[a-zA-Z0-9]{14}$/.test(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Checks a submission the way the extension's form did — email, team contact
 * and status are required — and returns { payload, action } or { error }.
 */
export function buildLeadPayload(input = {}) {
  const email = text(input.email);
  if (!email) return { error: 'Email is required.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'That email address does not look right.' };

  if (!isRecordId(input.teamContactId)) return { error: 'Choose a team contact.' };
  if (!LEAD_STATUSES.includes(input.status)) return { error: 'Choose a status.' };
  if (input.tripId && !isRecordId(input.tripId)) return { error: 'Choose a trip from the list, or leave it blank.' };
  if (input.customerId && !isRecordId(input.customerId)) return { error: 'Unknown customer record.' };

  const tags = Array.isArray(input.tags) ? input.tags.map(text).filter(Boolean) : [];

  const body = {
    'First Name': text(input.firstName),
    'Preferred Name': text(input.preferredName),
    Surname: text(input.surname),
    'Client Email': email,
    'Alt Email': text(input.altEmail),
    'Alt Email 2': text(input.altEmail2),
    'Phone Number': text(input.phone),
    Trips: input.tripId ? [`tri_${input.tripId}`] : null,
    // `tags` arrives in the order picked; the extension listed newest first.
    Tags: [...tags].reverse().join('\n'),
    'Team Contact': [`tme_${input.teamContactId}`],
    Status: input.status,
  };

  if (input.customerId) {
    return { action: 'update', payload: { id: `cus_${input.customerId}`, ...body } };
  }
  return { action: 'create', payload: body };
}
