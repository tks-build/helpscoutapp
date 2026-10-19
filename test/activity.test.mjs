/**
 * Tests for the activity route's Supabase auth headers. Run from the project
 * folder with:  node --test
 *
 * api/activity.js reads its environment when it loads, so route cases run in
 * a fresh Node process with Supabase replaced by a stub that records what it
 * was sent. All keys here are dummy values.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { supabaseAuthHeaders } from '../lib/supabaseAuth.js';

const ROUTE = pathToFileURL(fileURLToPath(new URL('../api/activity.js', import.meta.url))).href;
const SECRET = 'sb_secret_dummy0123456789abcdef';
const LEGACY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl';

// ------------------------------------------------------------- the helper

test('a secret key goes in the apikey header only', () => {
  assert.deepEqual(supabaseAuthHeaders(SECRET), { apikey: SECRET });
});

test('the legacy service_role JWT goes in both headers, as before', () => {
  assert.deepEqual(supabaseAuthHeaders(LEGACY), { apikey: LEGACY, Authorization: `Bearer ${LEGACY}` });
});

test('stray whitespace from a pasted key is trimmed', () => {
  assert.deepEqual(supabaseAuthHeaders(`  ${SECRET}\n`), { apikey: SECRET });
});

test('dotted values that are not JWTs are treated as secret keys', () => {
  assert.deepEqual(supabaseAuthHeaders('sb_secret_a.b.c'), { apikey: 'sb_secret_a.b.c' });
  assert.deepEqual(supabaseAuthHeaders('eyJ.not a jwt.x'), { apikey: 'eyJ.not a jwt.x' });
});

test('no key, no headers', () => {
  assert.deepEqual(supabaseAuthHeaders(''), {});
  assert.deepEqual(supabaseAuthHeaders(undefined), {});
});

// --------------------------------------------- the route, Supabase stubbed

/** Calls the real handler with Supabase stubbed; returns the reply and what Supabase was sent. */
function callRoute(env, request) {
  const script = `
    const sent = [];
    globalThis.fetch = async (url, options = {}) => {
      sent.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {} });
      return { ok: true, status: 200, text: async () => '[{"id":"1","type":"note","body":"hi","source":"helpscout"}]' };
    };
    const { default: handler } = await import(${JSON.stringify(ROUTE)});
    const reply = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler(${JSON.stringify(request)}, reply);
    console.log(JSON.stringify({ code: reply.code, body: reply.body, sent }));
  `;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUPABASE_|REQUIRE_SESSION|HELPSCOUT_)/.test(key)));
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...inherited, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(output.trim().split('\n').pop());
}

const configured = (key) => ({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: key });
const read = { method: 'GET', query: { customerRef: 'recAAAAAAAAAAAAAA', email: 'guest@example.com' }, headers: {} };

test('reading with a secret key sends no Authorization header', () => {
  const { code, sent } = callRoute(configured(SECRET), read);
  assert.equal(code, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /^https:\/\/example\.supabase\.co\/rest\/v1\/activity_entries\?/);
  assert.equal(sent[0].headers.apikey, SECRET);
  assert.equal('Authorization' in sent[0].headers, false);
});

test('reading with the legacy key still sends both headers', () => {
  const { sent } = callRoute(configured(LEGACY), read);
  assert.equal(sent[0].headers.apikey, LEGACY);
  assert.equal(sent[0].headers.Authorization, `Bearer ${LEGACY}`);
});

test('writes keep their own headers alongside the key', () => {
  const write = { method: 'POST', query: {}, headers: {}, body: { customerRef: 'recAAAAAAAAAAAAAA', body: 'Called guest', authorName: 'Test BM' } };
  const { code, sent } = callRoute(configured(SECRET), write);
  assert.equal(code, 200);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].headers.apikey, SECRET);
  assert.equal(sent[0].headers['Content-Type'], 'application/json');
  assert.match(sent[0].headers.Prefer, /merge-duplicates/);
  assert.equal('Authorization' in sent[0].headers, false);
});

test('soft delete is an update, never a DELETE', () => {
  const { sent } = callRoute(configured(SECRET), { method: 'DELETE', query: { id: 'abc' }, headers: {} });
  assert.equal(sent[0].method, 'PATCH');
});

test('without Supabase settings the route says so and calls nothing', () => {
  const { code, sent } = callRoute({}, read);
  assert.equal(code, 501);
  assert.equal(sent.length, 0);
});
