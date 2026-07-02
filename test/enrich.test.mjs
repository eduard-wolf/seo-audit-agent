/**
 * test/enrich.test.mjs — Unit tests for bin/enrich.mjs.
 * All tests use MOCKED fetch and a temp dir — NEVER real network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { enrich } from '../bin/enrich.mjs';

/** Create a temp dir with a minimal signals.json and return its path. */
function makeTempDir(origin = 'https://example.com') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-test-'));
  const signals = { origin, meta: { origin }, crawlMeta: {} };
  fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify(signals), 'utf8');
  return dir;
}

/** Stub probeImpl that skips real TLS — keeps existing CrUX-only tests offline. */
const noTlsProbe = async () => ({ error: 'tls-test-skip' });

// ── no-key path ───────────────────────────────────────────────────────────────

describe('enrich — no API key', () => {
  it('writes runtime-signals.json with available:false when no key', async () => {
    const dir = makeTempDir();
    try {
      // apiKey: null (NOT undefined) — undefined would trigger the `= process.env.CRUX_API_KEY`
      // destructuring default and could hit the real CrUX API if the env var is set. null forces the no-key path.
      const result = await enrich(dir, { apiKey: null, probeImpl: noTlsProbe, sbApiKey: null });
      assert.strictEqual(result.available, false);
      assert.ok(result.reason, 'reason should be present');
      // File must exist
      const filePath = path.join(dir, 'runtime-signals.json');
      assert.ok(fs.existsSync(filePath), 'runtime-signals.json should be written');
      const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.strictEqual(written.available, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes {available:false} when apiKey is empty string', async () => {
    const dir = makeTempDir();
    try {
      const result = await enrich(dir, { apiKey: '', probeImpl: noTlsProbe, sbApiKey: null });
      assert.strictEqual(result.available, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── with-key path (mocked fetch) ─────────────────────────────────────────────

describe('enrich — with API key + mocked fetch', () => {
  it('writes {available:true, crux:{lcp,...}} on successful CrUX response', async () => {
    const dir = makeTempDir('https://example.com');
    const mockCruxJson = {
      record: {
        metrics: {
          largest_contentful_paint: { percentiles: { p75: 2200 } },
          interaction_to_next_paint: { percentiles: { p75: 180 } },
          cumulative_layout_shift: { percentiles: { p75: '0.08' } },
        },
      },
    };
    const mockFetch = async () => ({
      status: 200,
      json: async () => mockCruxJson,
    });
    try {
      const result = await enrich(dir, {
        apiKey: 'test-key',
        fetchImpl: mockFetch,
        nowIso: '2026-06-29T00:00:00Z',
        probeImpl: noTlsProbe,
        sbApiKey: null,
      });
      assert.strictEqual(result.available, true);
      assert.ok(result.crux, 'crux should be present');
      assert.ok(result.crux.lcp, 'lcp should be present');
      assert.strictEqual(result.crux.lcp.p75, 2200);
      assert.strictEqual(result.crux.lcp.category, 'good');
      assert.strictEqual(result.generatedAt, '2026-06-29T00:00:00Z');
      assert.strictEqual(result.origin, 'https://example.com');
      assert.strictEqual(result.source, 'CrUX');
      // Verify file written correctly
      const filePath = path.join(dir, 'runtime-signals.json');
      assert.ok(fs.existsSync(filePath));
      const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.strictEqual(written.available, true);
      assert.strictEqual(written.crux.lcp.p75, 2200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes {available:true, crux:{noData:true}} when CrUX 404', async () => {
    const dir = makeTempDir();
    const mockFetch = async () => ({ status: 404, json: async () => ({}) });
    try {
      const result = await enrich(dir, { apiKey: 'test-key', fetchImpl: mockFetch, probeImpl: noTlsProbe, sbApiKey: null });
      assert.strictEqual(result.available, true);
      assert.strictEqual(result.crux.noData, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes {available:false} when CrUX returns error status', async () => {
    const dir = makeTempDir();
    const mockFetch = async () => ({ status: 403, json: async () => ({}) });
    try {
      const result = await enrich(dir, { apiKey: 'test-key', fetchImpl: mockFetch, probeImpl: noTlsProbe, sbApiKey: null });
      assert.strictEqual(result.available, false);
      assert.ok(result.reason, 'reason should be set');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to analysis.json origin when signals.json has no origin', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-test-fallback-'));
    // signals.json without origin
    fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify({ crawlMeta: {} }), 'utf8');
    // analysis.json with origin
    fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify({ meta: { origin: 'https://fallback.com' } }), 'utf8');
    let capturedOrigin;
    const mockFetch = async (_url, opts) => {
      capturedOrigin = JSON.parse(opts.body).origin;
      return { status: 200, json: async () => ({ record: { metrics: { largest_contentful_paint: { percentiles: { p75: 1000 } } } } }) };
    };
    try {
      await enrich(dir, { apiKey: 'test-key', fetchImpl: mockFetch, probeImpl: async () => ({ error: 'tls-test-skip' }), sbApiKey: null });
      assert.strictEqual(capturedOrigin, 'https://fallback.com');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── TLS part ──────────────────────────────────────────────────────────────────

describe('enrich — tls part: http origin → not-https', () => {
  it('out.tls = {available:false, reason:"origin not https"} for http origin', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-tls-http-'));
    const signals = { origin: 'http://example.com', meta: { origin: 'http://example.com' }, crawlMeta: {} };
    fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify(signals), 'utf8');
    try {
      const result = await enrich(dir, { apiKey: null, sbApiKey: null });
      assert.ok(result.tls, 'tls field should be present');
      assert.strictEqual(result.tls.available, false);
      assert.strictEqual(result.tls.reason, 'origin not https');
      // CrUX field still present
      assert.strictEqual(result.available, false);
      // Verify file written
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'runtime-signals.json'), 'utf8'));
      assert.strictEqual(written.tls.available, false);
      assert.strictEqual(written.tls.reason, 'origin not https');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('enrich — tls part: https origin + mock probe → available:true', () => {
  it('out.tls.available===true with issues when probe returns cert with problems', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-tls-https-'));
    const signals = { origin: 'https://example.com', meta: { origin: 'https://example.com' }, crawlMeta: {} };
    fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify(signals), 'utf8');
    // nowMs: set to a point in the future relative to an "expiring" cert
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    // cert that expired yesterday
    const expiredDate = new Date(nowMs - 86400000).toUTCString();
    const fakeCert = { valid_to: expiredDate, subjectaltname: 'DNS:example.com' };
    const mockProbe = async (_host, _port, _connectImpl) => ({
      cert: fakeCert,
      authorizationError: 'CERT_HAS_EXPIRED',
    });
    try {
      const result = await enrich(dir, {
        apiKey: null,
        nowIso: '2026-06-29T00:00:00Z',
        nowMs,
        probeImpl: mockProbe,
        sbApiKey: null,
      });
      assert.ok(result.tls, 'tls field should be present');
      assert.strictEqual(result.tls.available, true);
      assert.ok(result.tls.data, 'tls.data should be present');
      assert.ok(Array.isArray(result.tls.data.issues), 'tls.data.issues should be array');
      assert.ok(result.tls.data.issues.includes('expired'), `expected expired issue, got ${JSON.stringify(result.tls.data.issues)}`);
      assert.strictEqual(result.tls.data.host, 'example.com');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('out.tls.available===true with issues:[] for a healthy cert', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-tls-ok-'));
    const signals = { origin: 'https://example.com', meta: { origin: 'https://example.com' }, crawlMeta: {} };
    fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify(signals), 'utf8');
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    const futureDate = new Date(nowMs + 100 * 86400000).toUTCString();
    const fakeCert = { valid_to: futureDate, subjectaltname: 'DNS:example.com' };
    const mockProbe = async () => ({ cert: fakeCert, authorizationError: null });
    try {
      const result = await enrich(dir, {
        apiKey: null,
        nowIso: '2026-06-29T00:00:00Z',
        nowMs,
        probeImpl: mockProbe,
        sbApiKey: null,
      });
      assert.strictEqual(result.tls.available, true);
      assert.deepStrictEqual(result.tls.data.issues, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('out.tls = {available:false, reason:...} when probe returns error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-tls-err-'));
    const signals = { origin: 'https://example.com', meta: { origin: 'https://example.com' }, crawlMeta: {} };
    fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify(signals), 'utf8');
    const mockProbe = async () => ({ error: 'tls-timeout' });
    try {
      const result = await enrich(dir, {
        apiKey: null,
        probeImpl: mockProbe,
        sbApiKey: null,
      });
      assert.strictEqual(result.tls.available, false);
      assert.strictEqual(result.tls.reason, 'tls-timeout');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Safe Browsing part ────────────────────────────────────────────────────────

describe('enrich — safeBrowsing part: no SB key → available:false', () => {
  it('out.safeBrowsing = {available:false} when sbApiKey is null', async () => {
    const dir = makeTempDir('https://example.com');
    try {
      const result = await enrich(dir, { apiKey: null, probeImpl: noTlsProbe, sbApiKey: null });
      assert.ok(result.safeBrowsing, 'safeBrowsing field should be present');
      assert.strictEqual(result.safeBrowsing.available, false);
      assert.ok(result.safeBrowsing.reason, 'reason should be present');
      // File written with safeBrowsing field
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'runtime-signals.json'), 'utf8'));
      assert.strictEqual(written.safeBrowsing.available, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('enrich — safeBrowsing part: with sbApiKey + mocked sbFetchImpl → flagged', () => {
  it('out.safeBrowsing.available===true, data.flagged===true when SB mock returns matches', async () => {
    const dir = makeTempDir('https://example.com');
    const sbMockFetch = async () => ({
      status: 200,
      json: async () => ({
        matches: [
          { threatType: 'MALWARE', platformType: 'ANY_PLATFORM' },
          { threatType: 'SOCIAL_ENGINEERING', platformType: 'ANY_PLATFORM' },
        ],
      }),
    });
    try {
      const result = await enrich(dir, {
        apiKey: null,
        probeImpl: noTlsProbe,
        sbApiKey: 'test-sb-key',
        sbFetchImpl: sbMockFetch,
      });
      assert.ok(result.safeBrowsing, 'safeBrowsing field should be present');
      assert.strictEqual(result.safeBrowsing.available, true);
      assert.ok(result.safeBrowsing.data, 'safeBrowsing.data should be present');
      assert.strictEqual(result.safeBrowsing.data.flagged, true);
      assert.ok(Array.isArray(result.safeBrowsing.data.threatTypes), 'threatTypes should be array');
      assert.ok(result.safeBrowsing.data.threatTypes.includes('MALWARE'));
      assert.strictEqual(result.safeBrowsing.data.target, 'https://example.com');
      // File written with correct safeBrowsing
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'runtime-signals.json'), 'utf8'));
      assert.strictEqual(written.safeBrowsing.available, true);
      assert.strictEqual(written.safeBrowsing.data.flagged, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('out.safeBrowsing.data.flagged===false when SB mock returns clean {}', async () => {
    const dir = makeTempDir('https://example.com');
    const sbMockFetch = async () => ({
      status: 200,
      json: async () => ({}),
    });
    try {
      const result = await enrich(dir, {
        apiKey: null,
        probeImpl: noTlsProbe,
        sbApiKey: 'test-sb-key',
        sbFetchImpl: sbMockFetch,
      });
      assert.strictEqual(result.safeBrowsing.available, true);
      assert.strictEqual(result.safeBrowsing.data.flagged, false);
      assert.deepStrictEqual(result.safeBrowsing.data.threatTypes, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('enrich — tls part: existing CrUX assertions still pass with probeImpl injected', () => {
  it('CrUX {available:true, crux:{lcp,...}} still works when probeImpl injected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-crux-tls-'));
    const signals = { origin: 'https://example.com', meta: { origin: 'https://example.com' }, crawlMeta: {} };
    fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify(signals), 'utf8');
    const mockCruxJson = {
      record: {
        metrics: {
          largest_contentful_paint: { percentiles: { p75: 2200 } },
          interaction_to_next_paint: { percentiles: { p75: 180 } },
          cumulative_layout_shift: { percentiles: { p75: '0.08' } },
        },
      },
    };
    const mockFetch = async () => ({ status: 200, json: async () => mockCruxJson });
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    const futureDate = new Date(nowMs + 100 * 86400000).toUTCString();
    const mockProbe = async () => ({
      cert: { valid_to: futureDate, subjectaltname: 'DNS:example.com' },
      authorizationError: null,
    });
    try {
      const result = await enrich(dir, {
        apiKey: 'test-key',
        fetchImpl: mockFetch,
        nowIso: '2026-06-29T00:00:00Z',
        nowMs,
        probeImpl: mockProbe,
        sbApiKey: null,
      });
      // CrUX fields unchanged
      assert.strictEqual(result.available, true);
      assert.ok(result.crux, 'crux should be present');
      assert.strictEqual(result.crux.lcp.p75, 2200);
      // TLS field also present
      assert.ok(result.tls, 'tls should be present');
      assert.strictEqual(result.tls.available, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 3-vehicle composition: CrUX + TLS + SB all present ───────────────────────

describe('enrich — 3-vehicle composition: CrUX + TLS + Safe Browsing all present', () => {
  it('runtime-signals.json has crux, tls.available===true, and safeBrowsing.available===true', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-3vehicle-'));
    const signals = { origin: 'https://example.com', meta: { origin: 'https://example.com' }, crawlMeta: {} };
    fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify(signals), 'utf8');
    const mockCruxJson = {
      record: {
        metrics: {
          largest_contentful_paint: { percentiles: { p75: 2200 } },
          interaction_to_next_paint: { percentiles: { p75: 180 } },
          cumulative_layout_shift: { percentiles: { p75: '0.08' } },
        },
      },
    };
    const mockFetch = async () => ({ status: 200, json: async () => mockCruxJson });
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    const futureDate = new Date(nowMs + 100 * 86400000).toUTCString();
    const mockProbe = async () => ({
      cert: { valid_to: futureDate, subjectaltname: 'DNS:example.com' },
      authorizationError: null,
    });
    const sbMockFetch = async () => ({ status: 200, json: async () => ({}) }); // clean SB response
    try {
      const result = await enrich(dir, {
        apiKey: 'x',
        fetchImpl: mockFetch,
        nowIso: '2026-06-29T00:00:00Z',
        nowMs,
        probeImpl: mockProbe,
        sbApiKey: 'y',
        sbFetchImpl: sbMockFetch,
      });
      // All 3 vehicles present
      assert.ok(result.crux, 'crux field should be present');
      assert.strictEqual(result.tls.available, true, 'tls.available should be true');
      assert.strictEqual(result.safeBrowsing.available, true, 'safeBrowsing.available should be true');
      // Verify written file has all 3
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'runtime-signals.json'), 'utf8'));
      assert.ok(written.crux, 'written crux should be present');
      assert.strictEqual(written.tls.available, true, 'written tls.available should be true');
      assert.strictEqual(written.safeBrowsing.available, true, 'written safeBrowsing.available should be true');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
