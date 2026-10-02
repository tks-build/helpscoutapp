/**
 * The website enquiry form for a conversation, read from the thread body.
 *
 *   GET /api/enquiry?conversationId=123
 *
 * The sidebar payload has the guest's name and email but no message bodies,
 * so the form's telephone, trip, message and SMS consent only exist here.
 * Returns { enquiry: {...} } or { enquiry: null, reason } — a conversation
 * without a form is normal, not an error.
 *
 * Reads a conversation, so it always requires a session.
 */

import { parseEnquiryForm } from '../lib/enquiryForm.js';
import { fetchThreads, mailboxApiConfigured } from '../lib/mailboxApi.js';
import { requireSession } from '../lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (!requireSession(req, res)) return undefined;

  const conversationId = String(req.query.conversationId || '').trim();
  if (!/^\d+$/.test(conversationId)) {
    return res.status(400).json({ error: 'Missing conversationId' });
  }

  if (!mailboxApiConfigured()) {
    return res.status(200).json({ enquiry: null, reason: 'mailbox-api-not-configured' });
  }

  try {
    const threads = await fetchThreads(conversationId);

    // Oldest first: the form is the message that opened the conversation.
    // Later threads can quote it, and a quoted copy may be an edited one.
    for (const thread of [...threads].reverse()) {
      if (thread.type !== 'customer') continue;
      const enquiry = parseEnquiryForm(thread.body);
      if (enquiry) return res.status(200).json({ enquiry });
    }

    return res.status(200).json({ enquiry: null, reason: 'no-form' });
  } catch (error) {
    console.error('Enquiry lookup failed', error?.message);
    return res.status(200).json({ enquiry: null, reason: 'lookup-failed' });
  }
}
