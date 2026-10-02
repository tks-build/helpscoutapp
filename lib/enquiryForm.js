/**
 * Reads the website's trip-enquiry form out of a Help Scout thread body.
 *
 * The form arrives as a table (id="trip-enquiry") laid out vertically: a label
 * cell in one row, its value in the next. Brands differ — some labels carry a
 * colon, SMS Consent only exists on the US forms, and the trip can be blank —
 * so nothing here depends on row count, order, or the table's id. Cells are
 * read as one flat sequence and a value is simply "the cell after a label",
 * which also copes with a side-by-side layout should a form ever use one.
 *
 * Pure: no network, no DOM. Tested with anonymised fixtures.
 */

const LABELS = {
  name: 'name',
  email: 'email',
  telephone: 'phone',
  phone: 'phone',
  'telephone (inc area code)': 'phone',
  'which trip are you interested in?': 'trip',
  message: 'message',
  'sms consent': 'smsConsent',
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Cell HTML to plain text. Line breaks survive, so a message keeps its paragraphs. */
function cellText(html) {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(text)
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function labelFor(text) {
  const key = text.replace(/\s+/g, ' ').trim().replace(/:$/, '').trim().toLowerCase();
  return LABELS[key] || null;
}

/**
 * Returns { name, email, phone, trip, message, smsConsent } with empty strings
 * for anything absent, or null when the body holds no enquiry form.
 */
export function parseEnquiryForm(html) {
  const cells = [...String(html || '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => cellText(match[1]));

  const found = {};
  for (let i = 0; i < cells.length; i += 1) {
    const field = labelFor(cells[i]);
    if (!field || field in found) continue;

    const next = cells[i + 1];
    // A label followed directly by another label means the value was left blank.
    found[field] = next !== undefined && !labelFor(next) ? next : '';
  }

  // One stray "Name" cell in a signature is not a form.
  if (Object.keys(found).length < 2) return null;

  return {
    name: found.name || '',
    email: (found.email || '').toLowerCase(),
    phone: found.phone || '',
    trip: found.trip || '',
    message: found.message || '',
    smsConsent: found.smsConsent || '',
  };
}

/** "Lynn Starr" -> { firstName: "Lynn", surname: "Starr" }, as the extension split it. */
export function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', surname: parts.slice(1).join(' ') };
}
