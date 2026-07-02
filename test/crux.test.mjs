/**
 * test/crux.test.mjs — Unit tests for crawl/crux.mjs (CrUX client).
 * All tests use MOCKED fetch — NEVER real network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeCwv, parseCruxRecord, fetchCruxOrigin } from '../crawl/crux.mjs';

// ── categorizeCwv ─────────────────────────────────────────────────────────────

describe('categorizeCwv', () => {
  it('LCP 2500 → good (at threshold)', () => {
    assert.strictEqual(categorizeCwv('lcp', 2500), 'good');
  });

  it('LCP 2499 → good (below threshold)', () => {
    assert.strictEqual(categorizeCwv('lcp', 2499), 'good');
  });

  it('LCP 2501 → needs-improvement (above good, below poor)', () => {
    assert.strictEqual(categorizeCwv('lcp', 2501), 'needs-improvement');
  });

  it('LCP 4000 → needs-improvement (at poor threshold)', () => {
    assert.strictEqual(categorizeCwv('lcp', 4000), 'needs-improvement');
  });

  it('LCP 4001 → poor (above poor threshold)', () => {
    assert.strictEqual(categorizeCwv('lcp', 4001), 'poor');
  });

  it('INP 200 → good', () => {
    assert.strictEqual(categorizeCwv('inp', 200), 'good');
  });

  it('INP 201 → needs-improvement', () => {
    assert.strictEqual(categorizeCwv('inp', 201), 'needs-improvement');
  });

  it('INP 500 → needs-improvement', () => {
    assert.strictEqual(categorizeCwv('inp', 500), 'needs-improvement');
  });

  it('INP 501 → poor', () => {
    assert.strictEqual(categorizeCwv('inp', 501), 'poor');
  });

  it('CLS 0.10 → good (at threshold)', () => {
    assert.strictEqual(categorizeCwv('cls', 0.10), 'good');
  });

  it('CLS 0.05 → good', () => {
    assert.strictEqual(categorizeCwv('cls', 0.05), 'good');
  });

  it('CLS 0.11 → needs-improvement', () => {
    assert.strictEqual(categorizeCwv('cls', 0.11), 'needs-improvement');
  });

  it('CLS 0.25 → needs-improvement (at poor threshold)', () => {
    assert.strictEqual(categorizeCwv('cls', 0.25), 'needs-improvement');
  });

  it('CLS 0.26 → poor', () => {
    assert.strictEqual(categorizeCwv('cls', 0.26), 'poor');
  });

  it('unknown metric → null', () => {
    assert.strictEqual(categorizeCwv('fid', 100), null);
  });

  it('null p75 → null', () => {
    assert.strictEqual(categorizeCwv('lcp', null), null);
  });

  it('NaN p75 → null', () => {
    assert.strictEqual(categorizeCwv('lcp', NaN), null);
  });
});

// ── parseCruxRecord ──────────────────────────────────────────────────────────

describe('parseCruxRecord', () => {
  it('parses a realistic CrUX JSON with numeric p75 values', () => {
    const json = {
      record: {
        metrics: {
          largest_contentful_paint: { percentiles: { p75: 2800 } },
          interaction_to_next_paint: { percentiles: { p75: 180 } },
          cumulative_layout_shift: { percentiles: { p75: 0.08 } },
        },
      },
    };
    const result = parseCruxRecord(json);
    assert.ok(result, 'should return a result');
    assert.strictEqual(result.lcp.p75, 2800);
    assert.strictEqual(result.lcp.category, 'needs-improvement');
    assert.strictEqual(result.inp.p75, 180);
    assert.strictEqual(result.inp.category, 'good');
    assert.strictEqual(result.cls.p75, 0.08);
    assert.strictEqual(result.cls.category, 'good');
  });

  it('parses a CrUX JSON with string CLS p75 (real API returns strings)', () => {
    const json = {
      record: {
        metrics: {
          largest_contentful_paint: { percentiles: { p75: 3200 } },
          interaction_to_next_paint: { percentiles: { p75: 250 } },
          cumulative_layout_shift: { percentiles: { p75: '0.15' } },
        },
      },
    };
    const result = parseCruxRecord(json);
    assert.ok(result, 'should return a result');
    assert.strictEqual(result.cls.p75, 0.15);
    assert.strictEqual(result.cls.category, 'needs-improvement');
  });

  it('returns null for missing record', () => {
    assert.strictEqual(parseCruxRecord(null), null);
    assert.strictEqual(parseCruxRecord({}), null);
    assert.strictEqual(parseCruxRecord({ record: {} }), null);
  });

  it('returns null when all metrics are absent', () => {
    const json = { record: { metrics: {} } };
    assert.strictEqual(parseCruxRecord(json), null);
  });

  it('handles partial metrics (only LCP present)', () => {
    const json = {
      record: {
        metrics: {
          largest_contentful_paint: { percentiles: { p75: 1200 } },
        },
      },
    };
    const result = parseCruxRecord(json);
    assert.ok(result, 'should return a result');
    assert.ok(result.lcp, 'lcp should be present');
    assert.strictEqual(result.inp, null);
    assert.strictEqual(result.cls, null);
  });
});

// ── fetchCruxOrigin ──────────────────────────────────────────────────────────

describe('fetchCruxOrigin', () => {
  it('returns {ok:false, reason} when no apiKey', async () => {
    const result = await fetchCruxOrigin('https://example.com', undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'CRUX_API_KEY not set');
  });

  it('returns {ok:false, reason} when apiKey is empty string', async () => {
    const result = await fetchCruxOrigin('https://example.com', '');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'CRUX_API_KEY not set');
  });

  it('returns {ok:true, crux} on 200 with a valid record', async () => {
    const mockJson = {
      record: {
        metrics: {
          largest_contentful_paint: { percentiles: { p75: 1800 } },
          interaction_to_next_paint: { percentiles: { p75: 150 } },
          cumulative_layout_shift: { percentiles: { p75: '0.05' } },
        },
      },
    };
    const mockFetch = async (_url, _opts) => ({
      status: 200,
      json: async () => mockJson,
    });
    const result = await fetchCruxOrigin('https://example.com', 'test-key', mockFetch);
    assert.strictEqual(result.ok, true);
    assert.ok(result.crux, 'crux should be present');
    assert.strictEqual(result.crux.lcp.p75, 1800);
    assert.strictEqual(result.crux.lcp.category, 'good');
    assert.strictEqual(result.crux.inp.category, 'good');
    assert.strictEqual(result.crux.cls.category, 'good');
    assert.strictEqual(result.crux.formFactor, 'PHONE');
  });

  it('returns {ok:true, noData:true} on 404', async () => {
    const mockFetch = async (_url, _opts) => ({ status: 404, json: async () => ({}) });
    const result = await fetchCruxOrigin('https://unknown.example.com', 'test-key', mockFetch);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.noData, true);
  });

  it('returns {ok:false} on 500', async () => {
    const mockFetch = async (_url, _opts) => ({ status: 500, json: async () => ({}) });
    const result = await fetchCruxOrigin('https://example.com', 'test-key', mockFetch);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes('500'), `reason should mention status: ${result.reason}`);
  });

  it('returns {ok:false} on network error', async () => {
    const mockFetch = async () => { throw new Error('network-fail'); };
    const result = await fetchCruxOrigin('https://example.com', 'test-key', mockFetch);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes('network-fail'), `reason should mention error: ${result.reason}`);
  });

  it('returns {ok:true, noData:true} when CrUX returns no metrics', async () => {
    const mockFetch = async () => ({ status: 200, json: async () => ({ record: { metrics: {} } }) });
    const result = await fetchCruxOrigin('https://example.com', 'test-key', mockFetch);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.noData, true);
  });

  it('uses the provided formFactor', async () => {
    let capturedBody;
    const mockFetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { status: 200, json: async () => ({ record: { metrics: {} } }) };
    };
    await fetchCruxOrigin('https://example.com', 'test-key', mockFetch, 'DESKTOP');
    assert.strictEqual(capturedBody.formFactor, 'DESKTOP');
  });
});
