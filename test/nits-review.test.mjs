/**
 * test/nits-review.test.mjs — review-2026-07-06 low-severity fixes.
 *   1. effectiveIntervalMs(0) returned Infinity (1000/0) → guard rps <= 0.
 *   2. robots-match compilePattern is memoised (correctness must be unchanged).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveIntervalMs } from '../crawl/throttle.mjs';
import { isPathAllowed } from '../crawl/robots-match.mjs';

describe('throttle — rps <= 0 guard', () => {
  it('effectiveIntervalMs(0) is finite (no throttle), not Infinity', () => {
    assert.ok(Number.isFinite(effectiveIntervalMs(0)), 'rps=0 must not yield an Infinite interval');
    assert.equal(effectiveIntervalMs(0), 0);
  });
  it('a positive rps still yields the expected interval', () => {
    assert.equal(effectiveIntervalMs(2), 500);
    assert.equal(effectiveIntervalMs(4), 250);
  });
});

describe('robots-match — memoised compilePattern keeps correct results', () => {
  it('longest-match precedence and wildcards still resolve correctly (repeated calls)', () => {
    const robots = { disallow: ['/private/', '/*.pdf$'], allow: ['/private/public/'] };
    // Repeated calls exercise the cache path.
    for (let i = 0; i < 3; i++) {
      assert.equal(isPathAllowed('/private/secret', robots), false);
      assert.equal(isPathAllowed('/private/public/ok', robots), true, 'longer Allow wins the tie-break');
      assert.equal(isPathAllowed('/doc.pdf', robots), false, '$-anchored wildcard matches');
      assert.equal(isPathAllowed('/index.html', robots), true);
    }
  });
});
