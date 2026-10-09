/**
 * Tests for lib/session.js — the Help Scout signature check and the session
 * token. Run from the project folder with:  node --test
 *
 * lib/session.js reads its environment variables when it loads, so every case
 * runs in a fresh Node process with exactly the environment it needs. All
 * secrets here are dummy values.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = pathToFileURL(fileURLToPath(new URL('../lib/session.js', import.meta.url))).href;
const OUR_VARS = /^(HELPSCOUT_SECRET|HELPSCOUT_SECRET_TEST|VERCEL_ENV|REQUIRE_SESSION)$/;

/** Runs `body` in a child process with lib/session.js loaded as `s`; returns its JSON result. */
function inChild(env, body) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !OUR_VARS.test(key)));
  const script = `const s = await import(${JSON.stringify(LIB)}); console.log(JSON.stringify(await (async () => { ${body} })()));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...inherited, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(output.trim());
}

const hmac = (secret, data) => crypto.createHmac('sha1', secret).update(data).digest('base64');

/** A query string signed over `data` (defaults to the JSON Help Scout uses). */
function signedQuery(secret, params, data = JSON.stringify(params)) {
  return `?${new URLSearchParams({ ...params, 'X-HelpScout-Signature': hmac(secret, data) })}`;
}

const LIVE = { HELPSCOUT_SECRET: 'live-secret' };
const verify = (env, query) => inChild(env, `return s.verifySignedQuery(${JSON.stringify(query)});`);

// --------------------------------------------------------- the narrowed check

test('accepts Help Scout\'s plain JSON signature and reports "json"', () => {
  const params = { mailboxId: '123', userId: '42', url: 'https://example.com/a' };
  const result = verify(LIVE, signedQuery('live-secret', params));
  assert.equal(result.ok, true);
  assert.equal(result.matched, 'json');
  assert.deepEqual(result.paramNames, ['mailboxId', 'userId', 'url']);
});

test('rejects every encoding the check no longer tries', () => {
  const params = { userId: '42', url: 'https://example.com/a', name: 'Zoë' };
  const removed = {
    'php-escaped': JSON.stringify(params).replace(/\//g, '\\/').replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
    'numeric ids': '{"userId":42,"url":"https://example.com/a","name":"Zoë"}',
    'sorted keys': JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))),
  };
  for (const [name, data] of Object.entries(removed)) {
    assert.notEqual(data, JSON.stringify(params), `${name} fixture must differ from plain JSON`);
    assert.equal(verify(LIVE, signedQuery('live-secret', params, data)).ok, false, `${name} should be rejected`);
  }
});

test('a "+" in the signature survives URL decoding', () => {
  let params;
  let signature;
  let n = 0;
  do {
    n += 1;
    params = { userId: String(n) };
    signature = hmac('live-secret', JSON.stringify(params));
  } while (!signature.includes('+'));
  // Raw "+" (not %2B), as some clients send it.
  const query = `?userId=${n}&X-HelpScout-Signature=${signature.replace(/=/g, '%3D')}`;
  assert.equal(verify(LIVE, query).ok, true);
});

test('rejects a changed parameter, a wrong secret, and a missing signature', () => {
  const params = { userId: '42' };
  assert.equal(verify(LIVE, signedQuery('live-secret', params).replace('userId=42', 'userId=43')).ok, false);
  assert.equal(verify(LIVE, signedQuery('another-secret', params)).ok, false);

  const unsigned = verify(LIVE, '?email=a%40b.co');
  assert.deepEqual(unsigned, { ok: false, matched: null, paramNames: ['email'], hasSignature: false });
});

test('the result sent to the browser never contains the signature', () => {
  const query = signedQuery('live-secret', { userId: '42' });
  const signature = new URLSearchParams(query.slice(1)).get('X-HelpScout-Signature');
  assert.equal(JSON.stringify(verify(LIVE, query)).includes(signature), false);
});

// ------------------------------------------------- which secret is in force

const both = { HELPSCOUT_SECRET: 'live-secret', HELPSCOUT_SECRET_TEST: 'test-secret' };
const accepts = (env) => ({
  live: verify(env, signedQuery('live-secret', { userId: '1' })).ok,
  test: verify(env, signedQuery('test-secret', { userId: '1' })).ok,
});

test('production ignores HELPSCOUT_SECRET_TEST', () => {
  assert.deepEqual(accepts({ ...both, VERCEL_ENV: 'production' }), { live: true, test: false });
});

test('production with only HELPSCOUT_SECRET_TEST set stays switched off', () => {
  const env = { HELPSCOUT_SECRET_TEST: 'test-secret', VERCEL_ENV: 'production' };
  assert.equal(inChild(env, 'return s.sessionConfigured();'), false);
});

test('a preview deployment uses HELPSCOUT_SECRET_TEST when it is set', () => {
  assert.deepEqual(accepts({ ...both, VERCEL_ENV: 'preview' }), { live: false, test: true });
});

test('a preview without (or with an empty) HELPSCOUT_SECRET_TEST falls back', () => {
  assert.deepEqual(accepts({ ...LIVE, VERCEL_ENV: 'preview' }), { live: true, test: false });
  assert.deepEqual(accepts({ ...LIVE, HELPSCOUT_SECRET_TEST: '', VERCEL_ENV: 'preview' }), { live: true, test: false });
});

test('local runs and `vercel dev` ignore HELPSCOUT_SECRET_TEST', () => {
  assert.deepEqual(accepts(both), { live: true, test: false });
  assert.deepEqual(accepts({ ...both, VERCEL_ENV: 'development' }), { live: true, test: false });
});

// ------------------------------------------------------------------ tokens

test('tokens round-trip, expire, and resist tampering', () => {
  const result = inChild(LIVE, `
    const { token, expiresAt } = s.issueToken(1000);
    const [, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ exp: 9e15 })).toString('base64url') + '.' + mac;
    return {
      fresh: s.verifyToken(token, 2000),
      expired: s.verifyToken(token, expiresAt + 1),
      tampered: s.verifyToken(token + 'x', 2000),
      forged: s.verifyToken(forged, 2000),
    };
  `);
  assert.deepEqual(result, { fresh: true, expired: false, tampered: false, forged: false });
});

test('a token issued with one secret is refused under another', () => {
  const token = inChild(LIVE, 'return s.issueToken().token;');
  assert.equal(inChild({ HELPSCOUT_SECRET: 'rotated-secret' }, `return s.verifyToken(${JSON.stringify(token)});`), false);
});

test('requireSession: 503 with no secret, 401 without a token, passes with one', () => {
  const reply = 'const r = { code: 0, status(c) { this.code = c; return this; }, json() { return this; } };';
  assert.equal(inChild({}, `${reply} s.requireSession({ headers: {} }, r); return r.code;`), 503);
  assert.equal(inChild(LIVE, `${reply} s.requireSession({ headers: {} }, r); return r.code;`), 401);
  assert.deepEqual(
    inChild(LIVE, `${reply} const ok = s.requireSession({ headers: { authorization: 'Bearer ' + s.issueToken().token } }, r); return [ok, r.code];`),
    [true, 0],
  );
});
