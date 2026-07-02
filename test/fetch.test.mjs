/**
 * test/fetch.test.mjs — Unit tests for politeFetch response-header capture (U4.7).
 *
 * Verifies that the four response-header fields (xRobotsTag, hstsPresent,
 * frameProtection, contentEncoding) are correctly captured from the HTTP
 * response and returned by politeFetch.  Also verifies that gzip-encoded
 * responses are transparently decoded so `html` still contains the correct
 * markup (undici decode path).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './fixture-server.mjs';
import { politeFetch } from '../crawl/fetch.mjs';

// ── U4.7 — header-capture plumbing: well-configured server ───────────────────

describe('politeFetch — response-header capture (well-configured server)', () => {
  let srv;

  before(async () => {
    srv = await startFixtureServer({
      responseHeaders: {
        'X-Robots-Tag':              'noindex',
        'Strict-Transport-Security': 'max-age=63072000',
        'X-Frame-Options':           'SAMEORIGIN',
      },
      compress: true,
    });
  });

  after(() => srv.close());

  it('xRobotsTag === "noindex" from injected X-Robots-Tag header', async () => {
    const result = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(result.xRobotsTag, 'noindex',
      `xRobotsTag should be "noindex", got: ${JSON.stringify(result.xRobotsTag)}`);
  });

  it('hstsPresent === 1 from injected Strict-Transport-Security header', async () => {
    const result = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(result.hstsPresent, 1,
      `hstsPresent should be 1, got: ${result.hstsPresent}`);
  });

  it('frameProtection === 1 from injected X-Frame-Options header', async () => {
    const result = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(result.frameProtection, 1,
      `frameProtection should be 1, got: ${result.frameProtection}`);
  });

  it('contentEncoding === "gzip" when compress:true and client sent Accept-Encoding', async () => {
    const result = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(result.contentEncoding, 'gzip',
      `contentEncoding should be "gzip", got: ${JSON.stringify(result.contentEncoding)}`);
  });

  it('html still contains decoded perfect.html markup (undici transparent gzip decode)', async () => {
    const result = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.ok(result.html && result.html.length > 100,
      `html should be non-empty decoded markup, got length: ${result.html?.length}`);
    assert.ok(result.html.includes('<html'),
      `html should contain "<html", got start: ${result.html?.slice(0, 200)}`);
  });
});

// ── U4.7 — frameProtection via CSP frame-ancestors (no X-Frame-Options) ──────

describe('politeFetch — frameProtection === 1 from CSP frame-ancestors (no X-Frame-Options)', () => {
  let srv;

  before(async () => {
    srv = await startFixtureServer({
      responseHeaders: { 'Content-Security-Policy': "frame-ancestors 'self'" },
    });
  });

  after(() => srv.close());

  it('frameProtection === 1 when only CSP frame-ancestors is sent (no X-Frame-Options)', async () => {
    const result = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(result.frameProtection, 1,
      `frameProtection should be 1 from CSP frame-ancestors, got: ${result.frameProtection}`);
  });
});

// ── U4.7 — header-capture plumbing: default server (no opts) ─────────────────

describe('politeFetch — response-header capture (default server, no response headers)', () => {
  let srv;

  before(async () => {
    srv = await startFixtureServer(); // default — no responseHeaders, no compress
  });

  after(() => srv.close());

  it('xRobotsTag === "" when no X-Robots-Tag header sent', async () => {
    const result = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(result.xRobotsTag, '',
      `xRobotsTag should be "" on default server, got: ${JSON.stringify(result.xRobotsTag)}`);
  });

  it('hstsPresent === 0 when no Strict-Transport-Security header sent', async () => {
    const result = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(result.hstsPresent, 0,
      `hstsPresent should be 0 on default server, got: ${result.hstsPresent}`);
  });

  it('frameProtection === 0 when neither X-Frame-Options nor CSP sent', async () => {
    const result = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(result.frameProtection, 0,
      `frameProtection should be 0 on default server, got: ${result.frameProtection}`);
  });

  it('contentEncoding === "" when no compression applied', async () => {
    const result = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(result.contentEncoding, '',
      `contentEncoding should be "" on default server, got: ${JSON.stringify(result.contentEncoding)}`);
  });

  // ── Batch 4b: security/trust header capture — all absent on default server ──
  it('nosniffPresent/referrerPolicyPresent/permissionsPolicyPresent/cspPresent === 0 by default', async () => {
    const r = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(r.nosniffPresent, 0,           `nosniffPresent should be 0, got ${r.nosniffPresent}`);
    assert.strictEqual(r.referrerPolicyPresent, 0,    `referrerPolicyPresent should be 0, got ${r.referrerPolicyPresent}`);
    assert.strictEqual(r.permissionsPolicyPresent, 0, `permissionsPolicyPresent should be 0, got ${r.permissionsPolicyPresent}`);
    assert.strictEqual(r.cspPresent, 0,               `cspPresent should be 0, got ${r.cspPresent}`);
  });

  it('cookieInsecure === 0 and versionDisclosure === 0 by default (no Set-Cookie / no Server banner)', async () => {
    const r = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(r.cookieInsecure, 0,    `cookieInsecure should be 0 with no Set-Cookie, got ${r.cookieInsecure}`);
    assert.strictEqual(r.versionDisclosure, 0, `versionDisclosure should be 0 with no banner, got ${r.versionDisclosure}`);
  });
});

// ── Batch 4b — security/trust header capture: hardened server (all present) ──

describe('politeFetch — security/trust header capture (hardened server, secure cookie)', () => {
  let srv;

  before(async () => {
    srv = await startFixtureServer({
      responseHeaders: {
        'X-Content-Type-Options':  'nosniff',
        'Referrer-Policy':         'strict-origin-when-cross-origin',
        'Permissions-Policy':      'geolocation=()',
        'Content-Security-Policy': "default-src 'self'",
        'Set-Cookie':              'sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax',
      },
    });
  });

  after(() => srv.close());

  it('all four presence headers captured as 1', async () => {
    const r = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(r.nosniffPresent, 1,           `nosniffPresent should be 1, got ${r.nosniffPresent}`);
    assert.strictEqual(r.referrerPolicyPresent, 1,    `referrerPolicyPresent should be 1, got ${r.referrerPolicyPresent}`);
    assert.strictEqual(r.permissionsPolicyPresent, 1, `permissionsPolicyPresent should be 1, got ${r.permissionsPolicyPresent}`);
    assert.strictEqual(r.cspPresent, 1,               `cspPresent should be 1, got ${r.cspPresent}`);
  });

  it('cookieInsecure === 0 for a fully-flagged Secure/HttpOnly/SameSite cookie', async () => {
    const r = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(r.cookieInsecure, 0,
      `cookieInsecure should be 0 for a secure cookie, got ${r.cookieInsecure}`);
  });
});

// ── Batch 4b — insecure cookie + version-banner capture ──────────────────────

describe('politeFetch — insecure Set-Cookie + Server/X-Powered-By version banner', () => {
  let srv;

  before(async () => {
    srv = await startFixtureServer({
      responseHeaders: {
        'Set-Cookie':   'sid=abc; Path=/',
        'Server':       'nginx/1.18.0',
        'X-Powered-By': 'PHP/7.4.3',
      },
    });
  });

  after(() => srv.close());

  it('cookieInsecure === 1 when Set-Cookie misses Secure/HttpOnly/SameSite', async () => {
    const r = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(r.cookieInsecure, 1,
      `cookieInsecure should be 1 for a bare cookie, got ${r.cookieInsecure}`);
  });

  it('versionDisclosure === 1 when Server carries a version token / X-Powered-By present', async () => {
    const r = await politeFetch(srv.baseUrl + '/perfect.html', { backoffBaseMs: 10 });
    assert.strictEqual(r.versionDisclosure, 1,
      `versionDisclosure should be 1 for nginx/1.18.0 + X-Powered-By, got ${r.versionDisclosure}`);
  });
});
