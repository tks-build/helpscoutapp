/**
 * Exchanges Help Scout's signed panel URL for a short-lived session token.
 *
 *   POST /api/session   { query: "<window.location.search>" }
 *
 * See lib/session.js for what the signature does and does not prove.
 * On failure the reply names the parameters received and whether a signature
 * was present — enough to diagnose a mismatch, with nothing secret in it.
 */

import { issueToken, sessionConfigured, verifySignedQuery } from '../lib/session.js';

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!sessionConfigured()) {
    return res.status(503).json({ error: 'HELPSCOUT_SECRET is not set', configured: false });
  }

  const query = typeof req.body?.query === 'string' ? req.body.query.slice(0, 4000) : '';
  const check = verifySignedQuery(query);

  if (!check.ok) {
    console.warn('Help Scout signature not accepted', JSON.stringify({ hasSignature: check.hasSignature, paramNames: check.paramNames }));
    return res.status(401).json({
      error: check.hasSignature ? 'Signature did not match' : 'No Help Scout signature on this page',
      configured: true,
      hasSignature: check.hasSignature,
      paramNames: check.paramNames,
    });
  }

  console.log(`Help Scout signature accepted (${check.matched})`);
  return res.status(200).json({ ...issueToken(), matched: check.matched });
}
