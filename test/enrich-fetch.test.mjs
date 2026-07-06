/**
 * test/enrich-fetch.test.mjs — shared timeout-armed, key-redacting fetch helper
 * used by the CrUX and Safe-Browsing enrich clients (DRY, security-sensitive).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout } from '../crawl/enrich-fetch.mjs';

describe('fetchWithTimeout', () => {
  it('returns {ok:true, res} and arms an AbortSignal on success', async () => {
    let sig;
    const mock = async (_u, opts) => { sig = opts.signal; return { status: 200 }; };
    const r = await fetchWithTimeout(mock, 'https://x/', { method: 'POST' }, { apiKey: 'k', timeoutMs: 8000 });
    assert.equal(r.ok, true);
    assert.equal(r.res.status, 200);
    assert.ok(sig instanceof AbortSignal, 'a timeout AbortSignal must be passed to fetch');
  });

  it('normalises a TimeoutError to reason "fetch-error: timeout"', async () => {
    const mock = async () => { const e = new Error('The operation was aborted'); e.name = 'TimeoutError'; throw e; };
    const r = await fetchWithTimeout(mock, 'https://x/', {}, { apiKey: 'k', timeoutMs: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'fetch-error: timeout');
  });

  it('redacts the apiKey from a generic error reason', async () => {
    const mock = async () => { throw new Error('connect refused key=SECRET'); };
    const r = await fetchWithTimeout(mock, 'https://x/', {}, { apiKey: 'SECRET', timeoutMs: 1 });
    assert.equal(r.ok, false);
    assert.ok(!r.reason.includes('SECRET'), `key must be redacted: ${r.reason}`);
    assert.ok(r.reason.startsWith('fetch-error:'));
  });
});
