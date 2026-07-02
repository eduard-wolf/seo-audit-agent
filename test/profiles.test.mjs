/**
 * test/profiles.test.mjs — TDD for crawl/profiles.mjs (Welle 5 U5.1, RED first).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadProfile, DEFAULT_PROFILE, PROFILE_NAMES } from '../crawl/profiles.mjs';

describe('crawl profiles', () => {
  it('DEFAULT_PROFILE is "standard"', () => {
    assert.strictEqual(DEFAULT_PROFILE, 'standard');
  });

  it('PROFILE_NAMES contains exactly the three known profiles', () => {
    assert.deepStrictEqual([...PROFILE_NAMES].sort(), ['full-audit', 'quick-scan', 'standard']);
  });

  it('loadProfile("quick-scan") returns numeric fields and no description', () => {
    const p = loadProfile('quick-scan');
    assert.strictEqual(typeof p.maxUrls, 'number');
    assert.strictEqual(typeof p.maxDepth, 'number');
    assert.strictEqual(typeof p.rps, 'number');
    assert.strictEqual(typeof p.concurrency, 'number');
    assert.strictEqual(typeof p.wallClockMs, 'number');
    assert.ok(!('description' in p), 'description should be stripped from opts');
    assert.strictEqual(p.maxUrls, 50);
  });

  it('loadProfile("standard") has correct maxUrls and maxDepth', () => {
    const p = loadProfile('standard');
    assert.strictEqual(p.maxUrls, 300);
    assert.strictEqual(p.maxDepth, 4);
    assert.ok(!('description' in p));
  });

  it('loadProfile("full-audit") has correct maxUrls', () => {
    const p = loadProfile('full-audit');
    assert.strictEqual(p.maxUrls, 25000);
    assert.ok(!('description' in p));
  });

  it('loadProfile throws on unknown profile name', () => {
    assert.throws(
      () => loadProfile('nope'),
      (err) => {
        assert.ok(err.message.includes('Unknown crawl profile'));
        return true;
      },
    );
  });
});
