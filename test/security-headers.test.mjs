/**
 * test/security-headers.test.mjs — Batch 4b coverage.
 *
 * Two layers:
 *   1. Pure-helper unit tests for computeCookieInsecure / computeVersionDisclosure
 *      (exported from crawl/fetch.mjs) — edge cases that are awkward to express
 *      through the fixture server (multiple Set-Cookie headers, bare Server tokens).
 *   2. End-to-end integration (runCrawl → analyzeFromFiles) proving the six new
 *      Trust/Security rules fire/don't-fire correctly when the columns are threaded
 *      through the full pipeline (fetch → crawl → run → CSV → analyzer).
 *
 * All six rules are Trust/Security hardening signals — NOT ranking factors and
 * NOT rich-result eligibility (the detector details carry "KEIN Ranking-Signal").
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from './fixture-server.mjs';
import { runCrawl } from '../crawl/run.mjs';
import { analyzeFromFiles } from '../analyze/analyze.mjs';
import { computeCookieInsecure, computeVersionDisclosure, computeNosniffPresent } from '../crawl/fetch.mjs';

const TMP_DATA_DIRS = [];
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sechdr-'));
  TMP_DATA_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TMP_DATA_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

/** Build a Headers object; arrays append multiple values (e.g. several Set-Cookie). */
function mkHeaders(obj) {
  const h = new Headers();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) v.forEach(x => h.append(k, x));
    else h.set(k, v);
  }
  return h;
}

// ── computeCookieInsecure ────────────────────────────────────────────────────

describe('computeCookieInsecure — pure helper', () => {
  it('confirms getSetCookie() is available on this Node runtime', () => {
    assert.strictEqual(typeof new Headers().getSetCookie, 'function',
      'Headers.getSetCookie should be present on Node v24 (undici)');
  });

  it('false when NO Set-Cookie is served (rule must not fire without a cookie)', () => {
    assert.strictEqual(computeCookieInsecure(mkHeaders({})), false);
  });

  it('false for a fully-flagged cookie (Secure + HttpOnly + SameSite)', () => {
    const h = mkHeaders({ 'Set-Cookie': 'sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax' });
    assert.strictEqual(computeCookieInsecure(h), false);
  });

  it('true when Secure is missing', () => {
    const h = mkHeaders({ 'Set-Cookie': 'sid=abc; Path=/; HttpOnly; SameSite=Lax' });
    assert.strictEqual(computeCookieInsecure(h), true);
  });

  it('true when HttpOnly is missing', () => {
    const h = mkHeaders({ 'Set-Cookie': 'sid=abc; Path=/; Secure; SameSite=Strict' });
    assert.strictEqual(computeCookieInsecure(h), true);
  });

  it('true when SameSite is missing', () => {
    const h = mkHeaders({ 'Set-Cookie': 'sid=abc; Path=/; Secure; HttpOnly' });
    assert.strictEqual(computeCookieInsecure(h), true);
  });

  it('true when ANY of multiple Set-Cookie headers is insecure (read individually via getSetCookie)', () => {
    const h = mkHeaders({ 'Set-Cookie': [
      'a=1; Path=/; Secure; HttpOnly; SameSite=Lax',  // secure
      'b=2; Path=/',                                   // insecure
    ] });
    assert.strictEqual(computeCookieInsecure(h), true);
  });

  it('case-insensitive attribute matching (lowercase flags)', () => {
    const h = mkHeaders({ 'Set-Cookie': 'sid=abc; path=/; secure; httponly; samesite=lax' });
    assert.strictEqual(computeCookieInsecure(h), false);
  });
});

// ── computeVersionDisclosure ─────────────────────────────────────────────────

describe('computeVersionDisclosure — pure helper', () => {
  it('false when neither Server nor X-Powered-By is present', () => {
    assert.strictEqual(computeVersionDisclosure(mkHeaders({})), false);
  });

  it('false for a bare Server token without a version (e.g. "cloudflare")', () => {
    assert.strictEqual(computeVersionDisclosure(mkHeaders({ Server: 'cloudflare' })), false);
  });

  it('true when Server carries a version token (nginx/1.18.0)', () => {
    assert.strictEqual(computeVersionDisclosure(mkHeaders({ Server: 'nginx/1.18.0' })), true);
  });

  it('true when Server is "Apache/2.4.41 (Ubuntu)"', () => {
    assert.strictEqual(computeVersionDisclosure(mkHeaders({ Server: 'Apache/2.4.41 (Ubuntu)' })), true);
  });

  it('true when X-Powered-By is present (even without a Server version)', () => {
    assert.strictEqual(computeVersionDisclosure(mkHeaders({ 'X-Powered-By': 'Express' })), true);
  });

  it('false for a non-version slash token (e.g. an Amazon edge id "ECS (dcb/7F83)")', () => {
    // A slash followed by a non-version token (hex edge id) is NOT a software version
    // and must not trip version-disclosure — only a digit.digit token counts.
    assert.strictEqual(computeVersionDisclosure(mkHeaders({ Server: 'ECS (dcb/7F83)' })), false);
  });

  it('true for Microsoft-IIS/10.0 (real version behind the slash)', () => {
    assert.strictEqual(computeVersionDisclosure(mkHeaders({ Server: 'Microsoft-IIS/10.0' })), true);
  });
});

// ── computeNosniffPresent ────────────────────────────────────────────────────

describe('computeNosniffPresent — pure helper', () => {
  it('true for a single X-Content-Type-Options: nosniff', () => {
    assert.strictEqual(computeNosniffPresent(mkHeaders({ 'X-Content-Type-Options': 'nosniff' })), true);
  });

  it('false when the header is absent', () => {
    assert.strictEqual(computeNosniffPresent(mkHeaders({})), false);
  });

  it('true when the header is duplicated ("nosniff, nosniff") — token-split, protection is active', () => {
    // A doubled/appended header reads back comma-joined via Headers.get(); an exact-string
    // compare would falsely report nosniff absent even though browsers honour any token.
    const h = mkHeaders({ 'X-Content-Type-Options': ['nosniff', 'nosniff'] });
    assert.strictEqual(computeNosniffPresent(h), true);
  });

  it('false for a non-nosniff value (e.g. "sniff")', () => {
    assert.strictEqual(computeNosniffPresent(mkHeaders({ 'X-Content-Type-Options': 'sniff' })), false);
  });
});

// ── Integration: full pipeline (runCrawl → analyzeFromFiles) ──────────────────

const NEW_RULES = [
  'tech:nosniff-missing',
  'tech:referrer-policy-missing',
  'tech:permissions-policy-missing',
  'tech:csp-missing',
  'tech:cookie-insecure',
  'tech:version-disclosure',
];

async function crawlAnalyze(opts) {
  const srv = await startFixtureServer(opts);
  const cr = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
  const analysis = await analyzeFromFiles(cr.csvPath, cr.signalsPath);
  await srv.close();
  return analysis;
}

const fires = (a, id) => Boolean(a.findings.find(f => f.ruleId === id));
const isPositive = (a, id) => Boolean(a.positives.find(p => p.ruleId === id));

describe('Batch 4b integration — default fixture (no security headers)', () => {
  let a;
  before(async () => { a = await crawlAnalyze(); });

  it('the four missing-presence rules FIRE (headers absent on default fixture)', () => {
    for (const id of ['tech:nosniff-missing', 'tech:referrer-policy-missing', 'tech:permissions-policy-missing', 'tech:csp-missing']) {
      assert.ok(fires(a, id), `${id} should fire on the default fixture`);
    }
  });

  it('tech:cookie-insecure does NOT fire (fixture serves no Set-Cookie)', () => {
    assert.strictEqual(fires(a, 'tech:cookie-insecure'), false);
    assert.ok(isPositive(a, 'tech:cookie-insecure'), 'tech:cookie-insecure should be a positive');
  });

  it('tech:version-disclosure does NOT fire (fixture serves no Server / X-Powered-By)', () => {
    assert.strictEqual(fires(a, 'tech:version-disclosure'), false);
    assert.ok(isPositive(a, 'tech:version-disclosure'), 'tech:version-disclosure should be a positive');
  });
});

describe('Batch 4b integration — hardened server (all headers + secure cookie)', () => {
  let a;
  before(async () => {
    a = await crawlAnalyze({
      responseHeaders: {
        'X-Content-Type-Options':  'nosniff',
        'Referrer-Policy':         'strict-origin-when-cross-origin',
        'Permissions-Policy':      'geolocation=()',
        'Content-Security-Policy': "default-src 'self'",
        'Set-Cookie':              'sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax',
      },
    });
  });

  it('NONE of the six new rules fire when headers are correctly set', () => {
    for (const id of NEW_RULES) {
      assert.strictEqual(fires(a, id), false, `${id} must NOT fire when the header is present/secure`);
      assert.ok(isPositive(a, id), `${id} should appear as a positive`);
    }
  });
});

describe('Batch 4b integration — insecure cookie + version banner', () => {
  let a;
  before(async () => {
    a = await crawlAnalyze({
      responseHeaders: {
        'Set-Cookie':   'sid=abc; Path=/',
        'Server':       'nginx/1.18.0',
        'X-Powered-By': 'PHP/7.4.3',
      },
    });
  });

  it('tech:cookie-insecure fires for a bare Set-Cookie', () => {
    assert.ok(fires(a, 'tech:cookie-insecure'), 'tech:cookie-insecure should fire for an unflagged cookie');
  });

  it('tech:version-disclosure fires for nginx/1.18.0 + X-Powered-By', () => {
    assert.ok(fires(a, 'tech:version-disclosure'), 'tech:version-disclosure should fire for a version banner');
  });
});
