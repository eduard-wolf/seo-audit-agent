/**
 * test/safe-browsing.test.mjs — Unit tests for crawl/safe-browsing.mjs.
 * All tests are PURE / MOCKED — NEVER real network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySafeBrowsingResponse, fetchSafeBrowsing } from '../crawl/safe-browsing.mjs';

// ── classifySafeBrowsingResponse ──────────────────────────────────────────────

describe('classifySafeBrowsingResponse', () => {
  it('returns {flagged:false, threatTypes:[]} for empty object {}', () => {
    const result = classifySafeBrowsingResponse({});
    assert.deepStrictEqual(result, { flagged: false, threatTypes: [] });
  });

  it('returns {flagged:false, threatTypes:[]} for null', () => {
    const result = classifySafeBrowsingResponse(null);
    assert.deepStrictEqual(result, { flagged: false, threatTypes: [] });
  });

  it('returns {flagged:false, threatTypes:[]} for {matches:[]}', () => {
    const result = classifySafeBrowsingResponse({ matches: [] });
    assert.deepStrictEqual(result, { flagged: false, threatTypes: [] });
  });

  it('returns flagged:true with deduped threatTypes for matches with duplicates', () => {
    const json = {
      matches: [
        { threatType: 'MALWARE', platformType: 'ANY_PLATFORM', threatEntryType: 'URL' },
        { threatType: 'MALWARE', platformType: 'ANY_PLATFORM', threatEntryType: 'URL' },
        { threatType: 'SOCIAL_ENGINEERING', platformType: 'ANY_PLATFORM', threatEntryType: 'URL' },
      ],
    };
    const result = classifySafeBrowsingResponse(json);
    assert.strictEqual(result.flagged, true);
    assert.deepStrictEqual(result.threatTypes, ['MALWARE', 'SOCIAL_ENGINEERING']);
  });

  it('filters out matches with no threatType', () => {
    const json = {
      matches: [
        { platformType: 'ANY_PLATFORM' }, // no threatType
        { threatType: 'UNWANTED_SOFTWARE' },
      ],
    };
    const result = classifySafeBrowsingResponse(json);
    assert.strictEqual(result.flagged, true);
    assert.deepStrictEqual(result.threatTypes, ['UNWANTED_SOFTWARE']);
  });
});

// ── fetchSafeBrowsing ─────────────────────────────────────────────────────────

describe('fetchSafeBrowsing', () => {
  it('returns {ok:false} when no apiKey provided', async () => {
    const result = await fetchSafeBrowsing('https://example.com', null);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason, 'reason should be present');
  });

  it('returns {ok:false} when apiKey is empty string', async () => {
    const result = await fetchSafeBrowsing('https://example.com', '');
    assert.strictEqual(result.ok, false);
  });

  it('returns {ok:true, flagged:false, threatTypes:[]} on 200 + clean response {}', async () => {
    const mockFetch = async () => ({
      status: 200,
      json: async () => ({}),
    });
    const result = await fetchSafeBrowsing('https://example.com', 'test-key', mockFetch);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.flagged, false);
    assert.deepStrictEqual(result.threatTypes, []);
  });

  it('returns {ok:true, flagged:true, threatTypes:[...]} on 200 + matches response', async () => {
    const mockFetch = async () => ({
      status: 200,
      json: async () => ({
        matches: [
          { threatType: 'MALWARE', platformType: 'ANY_PLATFORM' },
          { threatType: 'SOCIAL_ENGINEERING', platformType: 'ANY_PLATFORM' },
        ],
      }),
    });
    const result = await fetchSafeBrowsing('https://example.com', 'test-key', mockFetch);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.flagged, true);
    assert.deepStrictEqual(result.threatTypes, ['MALWARE', 'SOCIAL_ENGINEERING']);
  });

  it('returns {ok:false} on HTTP 500', async () => {
    const mockFetch = async () => ({
      status: 500,
      json: async () => ({ error: 'server error' }),
    });
    const result = await fetchSafeBrowsing('https://example.com', 'test-key', mockFetch);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes('500'), `reason should mention 500: ${result.reason}`);
  });

  it('returns {ok:false} on HTTP 403', async () => {
    const mockFetch = async () => ({
      status: 403,
      json: async () => ({ error: 'forbidden' }),
    });
    const result = await fetchSafeBrowsing('https://example.com', 'test-key', mockFetch);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes('403'));
  });

  it('returns {ok:false} on fetch error (network failure)', async () => {
    const mockFetch = async () => { throw new Error('network failure'); };
    const result = await fetchSafeBrowsing('https://example.com', 'test-key', mockFetch);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes('fetch-error'), `reason should include fetch-error: ${result.reason}`);
  });

  it('returns {ok:false, reason:"safebrowsing-bad-json"} when response.json() throws', async () => {
    const mockFetch = async () => ({
      status: 200,
      json: async () => { throw new Error('bad json'); },
    });
    const result = await fetchSafeBrowsing('https://example.com', 'test-key', mockFetch);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'safebrowsing-bad-json');
  });
});
