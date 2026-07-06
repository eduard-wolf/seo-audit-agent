/**
 * test/enrich-review.test.mjs — review-2026-07-06 enrich hardening.
 *   1. CrUX + Safe-Browsing POST clients had no request timeout.
 *   2. A fetch-error reason could persist the API key (which lives in the URL).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCruxOrigin } from '../crawl/crux.mjs';
import { fetchSafeBrowsing } from '../crawl/safe-browsing.mjs';

describe('enrich clients — request timeout armed', () => {
  it('CrUX passes an AbortSignal to fetch', async () => {
    let sig;
    const mock = async (_u, opts) => { sig = opts.signal; return { status: 200, json: async () => ({ record: { metrics: { largest_contentful_paint: { percentiles: { p75: 1000 } } } } }) }; };
    await fetchCruxOrigin('https://x/', 'k', mock);
    assert.ok(sig instanceof AbortSignal, 'CrUX must arm a timeout AbortSignal');
  });

  it('Safe Browsing passes an AbortSignal to fetch', async () => {
    let sig;
    const mock = async (_u, opts) => { sig = opts.signal; return { status: 200, json: async () => ({}) }; };
    await fetchSafeBrowsing('https://x/', 'k', mock);
    assert.ok(sig instanceof AbortSignal, 'Safe Browsing must arm a timeout AbortSignal');
  });
});

describe('enrich clients — TimeoutError normalisation', () => {
  it('CrUX normalises a TimeoutError to a stable reason', async () => {
    const mock = async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; };
    const r = await fetchCruxOrigin('https://x/', 'k', mock);
    assert.equal(r.reason, 'fetch-error: timeout');
  });
  it('Safe Browsing normalises a TimeoutError to a stable reason', async () => {
    const mock = async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; };
    const r = await fetchSafeBrowsing('https://x/', 'k', mock);
    assert.equal(r.reason, 'fetch-error: timeout');
  });
});

describe('enrich clients — API key redaction in error reason', () => {
  it('CrUX redacts the key from a fetch-error reason', async () => {
    const mock = async () => { throw new Error('connect refused key=SECRET-CRUX'); };
    const r = await fetchCruxOrigin('https://x/', 'SECRET-CRUX', mock);
    assert.equal(r.ok, false);
    assert.ok(!r.reason.includes('SECRET-CRUX'), `key must be redacted: ${r.reason}`);
  });

  it('Safe Browsing redacts the key from a fetch-error reason', async () => {
    const mock = async () => { throw new Error('connect refused key=SECRET-SB'); };
    const r = await fetchSafeBrowsing('https://x/', 'SECRET-SB', mock);
    assert.equal(r.ok, false);
    assert.ok(!r.reason.includes('SECRET-SB'), `key must be redacted: ${r.reason}`);
  });
});
