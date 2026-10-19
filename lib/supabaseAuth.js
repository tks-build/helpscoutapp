/**
 * Auth headers for Supabase's REST API (PostgREST), for the server's own key.
 *
 * Supabase has two kinds of server key:
 *   - secret keys, "sb_secret_…" — current. Not JWTs: they go in the apikey
 *     header only. Sent as "Authorization: Bearer" too, Supabase rejects the
 *     request with "Invalid JWT".
 *   - the legacy service_role key — a JWT, sent in both headers. Supabase is
 *     retiring these by the end of 2026.
 *
 * Either works here, so the key can be swapped without a code change.
 * Never log the key or these headers.
 */

/** True for a JWT (three base64url parts, header starting "eyJ"). */
function isJwt(key) {
  const parts = key.split('.');
  return parts.length === 3 && key.startsWith('eyJ') && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part));
}

export function supabaseAuthHeaders(key) {
  const value = String(key || '').trim();
  if (!value) return {};
  return isJwt(value) ? { apikey: value, Authorization: `Bearer ${value}` } : { apikey: value };
}
