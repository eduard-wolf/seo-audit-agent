/**
 * test/tls-check.test.mjs — Unit tests for crawl/tls-check.mjs.
 * All tests are PURE (injected now/mocked connectImpl) — NEVER real network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSans, hostMatchesSans, classifyCert, probeTlsCert } from '../crawl/tls-check.mjs';

// ── parseSans ────────────────────────────────────────────────────────────────

describe('parseSans', () => {
  it('returns [] for null/undefined/empty', () => {
    assert.deepStrictEqual(parseSans(null), []);
    assert.deepStrictEqual(parseSans(undefined), []);
    assert.deepStrictEqual(parseSans(''), []);
  });

  it('parses single DNS entry', () => {
    assert.deepStrictEqual(parseSans('DNS:example.com'), ['example.com']);
  });

  it('parses multiple DNS entries with spaces', () => {
    assert.deepStrictEqual(
      parseSans('DNS:example.com, DNS:www.example.com, DNS:*.example.com'),
      ['example.com', 'www.example.com', '*.example.com'],
    );
  });

  it('strips DNS: prefix case-insensitively', () => {
    assert.deepStrictEqual(parseSans('dns:foo.com'), ['foo.com']);
  });

  it('filters empty entries', () => {
    assert.deepStrictEqual(parseSans('DNS:a.com,,DNS:b.com'), ['a.com', 'b.com']);
  });
});

// ── hostMatchesSans ───────────────────────────────────────────────────────────

describe('hostMatchesSans', () => {
  it('exact match returns true', () => {
    assert.strictEqual(hostMatchesSans('example.com', ['example.com']), true);
  });

  it('exact match is case-insensitive', () => {
    assert.strictEqual(hostMatchesSans('EXAMPLE.COM', ['example.com']), true);
  });

  it('wildcard matches one-level subdomain', () => {
    assert.strictEqual(hostMatchesSans('www.example.com', ['*.example.com']), true);
  });

  it('wildcard does NOT match bare domain', () => {
    assert.strictEqual(hostMatchesSans('example.com', ['*.example.com']), false);
  });

  it('wildcard does NOT match two-level subdomain', () => {
    assert.strictEqual(hostMatchesSans('a.b.example.com', ['*.example.com']), false);
  });

  it('returns false when no match', () => {
    assert.strictEqual(hostMatchesSans('other.com', ['example.com', '*.example.com']), false);
  });

  it('returns false for empty sans', () => {
    assert.strictEqual(hostMatchesSans('example.com', []), false);
  });

  it('returns false for empty host', () => {
    assert.strictEqual(hostMatchesSans('', ['example.com']), false);
  });
});

// ── classifyCert ─────────────────────────────────────────────────────────────

describe('classifyCert — expired', () => {
  it('issues [expired] when valid_to is in the past', () => {
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    const cert = { valid_to: 'Jun 28 00:00:00 2026 GMT', subjectaltname: 'DNS:example.com' };
    const r = classifyCert(cert, 'example.com', null, nowMs);
    assert.ok(r.issues.includes('expired'), `expected expired, got ${JSON.stringify(r.issues)}`);
    assert.ok(r.daysLeft !== null);
    assert.ok(r.daysLeft < 0, `daysLeft should be negative for expired cert, got ${r.daysLeft}`);
    assert.strictEqual(r.validTo, 'Jun 28 00:00:00 2026 GMT');
  });

  it('does NOT add untrusted when authorizationError is CERT_HAS_EXPIRED', () => {
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    const cert = { valid_to: 'Jun 28 00:00:00 2026 GMT', subjectaltname: 'DNS:example.com' };
    const r = classifyCert(cert, 'example.com', 'CERT_HAS_EXPIRED', nowMs);
    assert.ok(r.issues.includes('expired'));
    assert.ok(!r.issues.includes('untrusted'), 'should not double-add untrusted for CERT_HAS_EXPIRED');
  });
});

describe('classifyCert — expiring', () => {
  it('issues [expiring] when valid_to is within warnDays', () => {
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    // 10 days out — within default 14-day warn window
    const futureMs = nowMs + 10 * 86400000;
    const futureDate = new Date(futureMs).toUTCString();
    const cert = { valid_to: futureDate, subjectaltname: 'DNS:example.com' };
    const r = classifyCert(cert, 'example.com', null, nowMs);
    assert.ok(r.issues.includes('expiring'), `expected expiring, got ${JSON.stringify(r.issues)}`);
    assert.ok(r.daysLeft !== null);
    assert.ok(r.daysLeft >= 9 && r.daysLeft <= 10, `daysLeft should be ~10, got ${r.daysLeft}`);
  });
});

describe('classifyCert — ok', () => {
  it('issues [] when cert is valid and not expiring', () => {
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    const futureMs = nowMs + 100 * 86400000;
    const futureDate = new Date(futureMs).toUTCString();
    const cert = { valid_to: futureDate, subjectaltname: 'DNS:example.com' };
    const r = classifyCert(cert, 'example.com', null, nowMs);
    assert.deepStrictEqual(r.issues, [], `expected no issues, got ${JSON.stringify(r.issues)}`);
    assert.ok(r.daysLeft !== null && r.daysLeft >= 99);
  });
});

describe('classifyCert — mismatch', () => {
  it('issues [mismatch] when host is not in SANs', () => {
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    const futureMs = nowMs + 100 * 86400000;
    const futureDate = new Date(futureMs).toUTCString();
    const cert = { valid_to: futureDate, subjectaltname: 'DNS:other.com' };
    const r = classifyCert(cert, 'example.com', null, nowMs);
    assert.ok(r.issues.includes('mismatch'), `expected mismatch, got ${JSON.stringify(r.issues)}`);
    assert.ok(!r.issues.includes('expired'));
    assert.ok(!r.issues.includes('expiring'));
  });

  it('does NOT issue mismatch when SANs are empty', () => {
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    const futureMs = nowMs + 100 * 86400000;
    const futureDate = new Date(futureMs).toUTCString();
    const cert = { valid_to: futureDate };
    const r = classifyCert(cert, 'example.com', null, nowMs);
    assert.ok(!r.issues.includes('mismatch'), 'no mismatch when SANs absent');
  });
});

describe('classifyCert — untrusted', () => {
  it('issues [untrusted] for self-signed cert (not expired)', () => {
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    const futureMs = nowMs + 100 * 86400000;
    const futureDate = new Date(futureMs).toUTCString();
    const cert = { valid_to: futureDate, subjectaltname: 'DNS:example.com' };
    const r = classifyCert(cert, 'example.com', 'DEPTH_ZERO_SELF_SIGNED_CERT', nowMs);
    assert.ok(r.issues.includes('untrusted'), `expected untrusted, got ${JSON.stringify(r.issues)}`);
    assert.ok(!r.issues.includes('expired'));
  });
});

describe('classifyCert — null/missing cert fields', () => {
  it('returns issues:[], daysLeft:null, validTo:null when cert is null', () => {
    const nowMs = Date.parse('2026-06-29T00:00:00Z');
    const r = classifyCert(null, 'example.com', null, nowMs);
    assert.deepStrictEqual(r.issues, []);
    assert.strictEqual(r.daysLeft, null);
    assert.strictEqual(r.validTo, null);
  });
});

// ── probeTlsCert ──────────────────────────────────────────────────────────────

describe('probeTlsCert — mock connectImpl', () => {
  it('resolves {cert, authorizationError:null} on successful handshake', async () => {
    const fakeCert = { valid_to: 'Dec 31 00:00:00 2026 GMT', subjectaltname: 'DNS:example.com' };
    const mockSocket = {
      getPeerCertificate: () => fakeCert,
      authorizationError: null,
      destroy: () => {},
      setTimeout: () => {},
      on: () => {},
    };
    const mockConnect = (_opts, cb) => {
      // Call the connect callback asynchronously
      setImmediate(cb);
      return mockSocket;
    };
    const result = await probeTlsCert('example.com', 443, mockConnect);
    assert.ok(!result.error, `should not have error, got: ${result.error}`);
    assert.deepStrictEqual(result.cert, fakeCert);
    assert.strictEqual(result.authorizationError, null);
  });

  it('resolves {cert, authorizationError} when socket has authorizationError', async () => {
    const fakeCert = { valid_to: 'Dec 31 00:00:00 2026 GMT', subjectaltname: 'DNS:example.com' };
    const mockSocket = {
      getPeerCertificate: () => fakeCert,
      authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      destroy: () => {},
      setTimeout: () => {},
      on: () => {},
    };
    const mockConnect = (_opts, cb) => {
      setImmediate(cb);
      return mockSocket;
    };
    const result = await probeTlsCert('example.com', 443, mockConnect);
    assert.strictEqual(result.authorizationError, 'DEPTH_ZERO_SELF_SIGNED_CERT');
    assert.deepStrictEqual(result.cert, fakeCert);
  });

  it('resolves {error} when socket emits error', async () => {
    let errorHandler;
    const mockSocket = {
      setTimeout: () => {},
      on: (event, fn) => { if (event === 'error') errorHandler = fn; },
    };
    const mockConnect = (_opts, _cb) => {
      // emit error asynchronously after registering listeners
      setImmediate(() => errorHandler?.(new Error('ECONNREFUSED')));
      return mockSocket;
    };
    const result = await probeTlsCert('example.com', 443, mockConnect);
    assert.ok(result.error, 'should have error');
    assert.ok(result.error.includes('ECONNREFUSED'), `error should mention ECONNREFUSED: ${result.error}`);
  });

  it('resolves {error} when connectImpl throws synchronously', async () => {
    const mockConnect = () => { throw new Error('sync-throw'); };
    const result = await probeTlsCert('example.com', 443, mockConnect);
    assert.ok(result.error, 'should have error');
    assert.ok(result.error.includes('sync-throw'), `error should mention sync-throw: ${result.error}`);
  });
});
