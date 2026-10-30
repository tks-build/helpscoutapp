/**
 * Tests for the activity route (which forwards to TRTL) and the Supabase key helper. Run from the project
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

// ------------------------------------------------ the route, TRTL stubbed

/** Calls the real handler with TRTL stubbed; returns the reply and what TRTL was sent. */
function callRoute(env, request) {
  const script = `
    const sent = [];
    globalThis.fetch = async (url, options = {}) => {
      sent.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body || null });
      return { ok: true, status: 200, text: async () => '{"entries":[{"id":"1","type":"note","body":"hi","author":"A","occurredAt":"2026-10-28T00:00:00Z"}]}' };
    };
    const { default: handler } = await import(${JSON.stringify(ROUTE)});
    const reply = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler(${JSON.stringify(request)}, reply);
    console.log(JSON.stringify({ code: reply.code, body: reply.body, sent }));
  `;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TRTL_|SUPABASE_|REQUIRE_SESSION|HELPSCOUT_)/.test(key)));
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...inherited, ...env },
    encoding: "utf8",
  });
  return JSON.parse(output.trim().split("\n").pop());
}

const PANEL_KEY = "dummy-panel-key";
const configured = { TRTL_PANEL_KEY: PANEL_KEY };
const read = { method: "GET", query: { customerRef: "recAAAAAAAAAAAAAA" }, headers: {} };

test("reading asks TRTL for the guest, with the panel key", () => {
  const { code, body, sent } = callRoute(configured, read);
  assert.equal(code, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://trtl.leatherbacktravel.com/api/panel/activity?customerRef=recAAAAAAAAAAAAAA");
  assert.equal(sent[0].headers.Authorization, `Bearer ${PANEL_KEY}`);
  assert.equal(body.entries[0].author, "A");
});

test("TRTL_URL overrides the address", () => {
  const { sent } = callRoute({ ...configured, TRTL_URL: "https://trtl.example.test/" }, read);
  assert.ok(sent[0].url.startsWith("https://trtl.example.test/api/panel/activity?"));
});

test("writing posts the note and author to TRTL", () => {
  const write = { method: "POST", query: {}, headers: {}, body: { customerRef: "recAAAAAAAAAAAAAA", customerEmail: "guest@example.com", body: " Called guest ", authorName: "Test BM", authorEmail: "bm@example.com" } };
  const { code, sent } = callRoute(configured, write);
  assert.equal(code, 200);
  assert.equal(sent[0].method, "POST");
  assert.deepEqual(JSON.parse(sent[0].body), { customerRef: "recAAAAAAAAAAAAAA", body: "Called guest", authorName: "Test BM", authorEmail: "bm@example.com" });
});

test("a blank note or missing guest is refused without calling TRTL", () => {
  const blank = callRoute(configured, { method: "POST", query: {}, headers: {}, body: { customerRef: "recAAAAAAAAAAAAAA", body: "  " } });
  assert.equal(blank.code, 400);
  const noGuest = callRoute(configured, { method: "POST", query: {}, headers: {}, body: { body: "hi" } });
  assert.equal(noGuest.code, 400);
  assert.equal(blank.sent.length + noGuest.sent.length, 0);
});

test("deleting is not offered", () => {
  const { code, sent } = callRoute(configured, { method: "DELETE", query: { id: "abc" }, headers: {} });
  assert.equal(code, 405);
  assert.equal(sent.length, 0);
});

test("without the panel key the route says so and calls nothing", () => {
  const { code, sent } = callRoute({}, read);
  assert.equal(code, 501);
  assert.equal(sent.length, 0);
});
