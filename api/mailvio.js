/**
 * Mailvio subscription management for the guest panel.
 *
 * Replaces the ActiveCampaign subscribe/unsubscribe Slack commands. All calls
 * are made here rather than from the browser so the API key never reaches the
 * client — same reasoning as the Airtable and Help Scout routes.
 *
 * Environment:
 *   MAILVIO_API_KEY   single key, used when no per-brand map is set
 *   MAILVIO_API_KEYS  optional JSON map of Help Scout mailbox id -> key, with
 *                     a "default" fallback. Mirrors how CALENDLY_URLS works,
 *                     for when brands have separate Mailvio accounts.
 *   MAILVIO_BASE_URL  optional override, defaults to the documented base
 */

const { MAILVIO_API_KEY, MAILVIO_API_KEYS, MAILVIO_BASE_URL } = process.env;

const BASE_URL = MAILVIO_BASE_URL || 'https://apiv2.mailvio.com';
const TIMEOUT_MS = 10000;

let keyMap = {};
try {
  if (MAILVIO_API_KEYS) keyMap = JSON.parse(MAILVIO_API_KEYS);
} catch {
  console.warn('MAILVIO_API_KEYS is not valid JSON');
}

export default async function handler(req, res) {
  const mailboxId = String(req.query.mailboxId || readBody(req).mailboxId || '');
  const apiKey = resolveApiKey(mailboxId);

  if (!apiKey) {
    return sendJson(res, 501, {
      error: 'Mailvio is not configured',
      details: 'Set MAILVIO_API_KEY (or MAILVIO_API_KEYS) to enable subscriptions.',
    });
  }

  try {
    if (req.method === 'GET') return await listSubscriptions(req, res, apiKey);
    if (req.method === 'POST') return await addToGroup(req, res, apiKey);
    if (req.method === 'DELETE') return await removeFromGroup(req, res, apiKey);
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  } catch (error) {
    // Deliberately generic: upstream errors can echo request details back, and
    // those must not reach the panel.
    console.error('Mailvio request failed', safeMessage(error));
    return sendJson(res, 502, { error: 'Mailvio request failed', details: safeMessage(error) });
  }
}

/** Every group in the account, plus whether this contact is in each one. */
async function listSubscriptions(req, res, apiKey) {
  const email = normaliseEmail(req.query.email);
  if (!email) return sendJson(res, 400, { error: 'Missing email' });

  const groups = await fetchGroups(apiKey);
  const subscriber = await findSubscriber(apiKey, email);

  if (!subscriber) {
    // Not an error — plenty of guests have never been added to a list.
    return sendJson(res, 200, {
      subscriberExists: false,
      subscriberId: null,
      groups: groups.map((group) => ({ id: group.id, name: group.name, subscribed: false })),
    });
  }

  const knownIds = new Set(groups.map((group) => String(group.id)));
  const detail = await fetchSubscriberDetail(apiKey, subscriber.id);

  // Mailvio returns memberships as GroupSubscribers join rows. The scan is
  // kept as a fallback in case that changes.
  const memberships = Array.isArray(detail.GroupSubscribers) && detail.GroupSubscribers.length
    ? detail.GroupSubscribers
    : findMembershipArrays(detail, knownIds);

  const identities = memberships.map(groupIdentity).filter((item) => item.active !== false);

  // Matched on id, falling back to name. If Mailvio ever returns ids in a
  // shape we don't recognise, the names still line up and the panel stays
  // correct rather than quietly showing everyone as unsubscribed.
  const memberIds = new Set(identities.map((item) => item.id).filter(Boolean));
  const memberNames = new Set(
    identities.map((item) => item.name?.trim().toLowerCase()).filter(Boolean),
  );

  return sendJson(res, 200, {
    subscriberExists: true,
    subscriberId: subscriber.id,
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      subscribed: memberIds.has(String(group.id))
        || memberNames.has(String(group.name).trim().toLowerCase()),
    })),
  });
}

async function addToGroup(req, res, apiKey) {
  const { email, groupId, firstName, lastName } = readBody(req);
  const cleanEmail = normaliseEmail(email);

  if (!cleanEmail || !isEmail(cleanEmail)) return sendJson(res, 400, { error: 'A valid email is required' });
  if (!(await isKnownGroup(apiKey, groupId))) return sendJson(res, 400, { error: 'Unknown group' });

  // Only send names we actually have — Mailvio stores blanks otherwise.
  const customFields = {};
  if (firstName) customFields.FIRSTNAME = String(firstName);
  if (lastName) customFields.LASTNAME = String(lastName);

  await mailvio(apiKey, `/group/${encodeURIComponent(groupId)}/subscriber`, {
    method: 'POST',
    body: JSON.stringify({
      emailAddress: cleanEmail,
      blackListed: false,
      ...(Object.keys(customFields).length ? { customFields } : {}),
    }),
  });

  return sendJson(res, 200, { ok: true });
}

async function removeFromGroup(req, res, apiKey) {
  const body = readBody(req);
  const email = normaliseEmail(body.email || req.query.email);
  const groupId = body.groupId || req.query.groupId;

  if (!email || !isEmail(email)) return sendJson(res, 400, { error: 'A valid email is required' });
  if (!(await isKnownGroup(apiKey, groupId))) return sendJson(res, 400, { error: 'Unknown group' });

  await mailvio(apiKey, `/group/${encodeURIComponent(groupId)}/subscriber`, {
    method: 'DELETE',
    body: JSON.stringify({ emailAddresses: [email] }),
  });

  return sendJson(res, 200, { ok: true });
}

/* ------------------------------------------------------------ Mailvio API */

async function fetchGroups(apiKey) {
  const payload = await mailvio(apiKey, '/group');
  const rows = payload?.Groups || payload?.groups || (Array.isArray(payload) ? payload : []);

  return rows
    .map((row) => ({
      id: row.id ?? row.groupId,
      name: row.groupName || row.name || 'Unnamed group',
      totalSubscribers: row.totalSubscribers,
    }))
    .filter((group) => group.id != null);
}

/**
 * Search returns partial matches, so the address is compared exactly and
 * case-insensitively. Without this, searching "kay@x.com" could return
 * "kay@xy.com" and we would edit the wrong person's subscriptions.
 */
async function findSubscriber(apiKey, email) {
  const payload = await mailvio(
    apiKey,
    `/subscriber?search=${encodeURIComponent(email)}&limit=20&offset=0`,
  );

  const rows = payload?.Subscribers || payload?.subscribers || [];
  const match = rows.find((row) => normaliseEmail(row.emailAddress) === email);
  return match || null;
}

async function fetchSubscriberDetail(apiKey, subscriberId) {
  const payload = await mailvio(apiKey, `/subscriber/${encodeURIComponent(subscriberId)}`);
  return payload?.Subscriber || payload?.subscriber || payload || {};
}

/**
 * Finds the group memberships anywhere in a subscriber payload.
 *
 * The documented `Subscriber.Groups` came back empty for a contact who is
 * demonstrably in a group, so rather than keep guessing key names this walks
 * the object and picks out any array that looks like a list of groups: either
 * objects carrying a group name or id, or bare ids matching the account's
 * known groups.
 */
function findMembershipArrays(node, knownIds, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return [];

  const found = [];

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      if (value.length && looksLikeGroups(value, knownIds)) found.push(...value);
      // Arrays of objects may still contain the groups further down.
      for (const entry of value) found.push(...findMembershipArrays(entry, knownIds, depth + 1));
    } else if (value && typeof value === 'object') {
      found.push(...findMembershipArrays(value, knownIds, depth + 1));
    }
  }

  return found;
}

function looksLikeGroups(array, knownIds) {
  return array.some((entry) => {
    if (entry === null || entry === undefined) return false;

    if (typeof entry === 'number' || typeof entry === 'string') {
      return knownIds.has(String(entry));
    }

    if (typeof entry !== 'object') return false;

    const source = entry.Group || entry.group || entry;
    const hasName = Boolean(source.groupName || source.GroupName);
    const id = source.GroupId ?? source.groupId ?? source.group_id ?? source.id;
    return hasName || (id !== undefined && knownIds.has(String(id)));
  });
}

/**
 * Pulls an id and a name out of a group entry, whatever shape it arrives in.
 *
 * Mailvio's docs don't pin this down, and the first implementation assumed
 * `{ id }` — which silently produced "member of nothing" for people who were
 * plainly subscribed. Handles bare ids, `groupId`, and a nested Group object.
 */
function groupIdentity(entry) {
  if (entry === null || entry === undefined) return {};

  if (typeof entry === 'number' || typeof entry === 'string') {
    return { id: String(entry), active: true };
  }

  const source = entry.Group || entry.group || entry;

  // GroupId before id, deliberately. A GroupSubscribers row carries its own
  // `id` for the join record, which is not a group id — reading that first is
  // what made a subscribed contact look like a member of nothing.
  const id = source.GroupId ?? source.groupId ?? source.group_id ?? source.id;
  const name = source.groupName || source.GroupName || source.name;

  // A row can outlive the membership: Mailvio keeps it and flags it. Presence
  // in the array is not the same as being subscribed.
  const active = entry.unsubscribe === true ? false : entry.active !== false;

  return {
    id: id === undefined || id === null ? undefined : String(id),
    name: name ? String(name) : undefined,
    active,
  };
}

/** Group ids from the browser are never trusted — they must exist in the account. */
async function isKnownGroup(apiKey, groupId) {
  if (groupId === undefined || groupId === null || groupId === '') return false;
  const groups = await fetchGroups(apiKey);
  return groups.some((group) => String(group.id) === String(groupId));
}

async function mailvio(apiKey, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'x-access-token': apiKey,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    const text = await response.text();

    if (!response.ok) {
      // Status only. The body can contain the request we sent, including the
      // contact's details, and that should not travel back to the panel.
      throw new Error(`Mailvio responded ${response.status}`);
    }

    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- helpers */

function resolveApiKey(mailboxId) {
  return keyMap[mailboxId] || keyMap.default || MAILVIO_API_KEY || '';
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function normaliseEmail(value) {
  if (Array.isArray(value)) return normaliseEmail(value[0]);
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Never let an API key surface in a message, however it got there. */
function safeMessage(error) {
  const message = error && typeof error.message === 'string' ? error.message : 'Unknown error';
  if (error?.name === 'AbortError') return 'Mailvio did not respond in time';
  return message.replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]');
}

function sendJson(res, statusCode, body) {
  if (typeof res.status === 'function') {
    return res.status(statusCode).json(body);
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
