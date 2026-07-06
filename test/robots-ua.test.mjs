/**
 * test/robots-ua.test.mjs — review-2026-07-06: robots.txt must honour the group
 * matching THIS crawler's product token, not only `User-agent: *`
 * (RFC 9309 §2.2.1 — most-specific matching group wins).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots } from '../crawl/sitefetch.mjs';

describe('parseRobots — product-token group precedence', () => {
  it('a group targeting our product token overrides the * group', () => {
    const raw = [
      'User-agent: seo-audit-agent',
      'Disallow: /',
      '',
      'User-agent: *',
      'Disallow: /private/',
    ].join('\n');
    const r = parseRobots(raw, 'seo-audit-agent');
    assert.deepEqual(r.disallow, ['/'], 'the bot-specific Disallow: / must be enforced, not the * group');
  });

  it('falls back to the * group when no token-specific group exists', () => {
    const raw = ['User-agent: *', 'Disallow: /private/', 'Allow: /public/'].join('\n');
    const r = parseRobots(raw, 'seo-audit-agent');
    assert.deepEqual(r.disallow, ['/private/']);
    assert.deepEqual(r.allow, ['/public/']);
  });

  it('matches a prefix product-token group (RFC 9309 prefix rule)', () => {
    const raw = ['User-agent: seo', 'Disallow: /x', '', 'User-agent: *', 'Disallow: /y'].join('\n');
    const r = parseRobots(raw, 'seo-audit-agent');
    assert.deepEqual(r.disallow, ['/x']);
  });

  it('picks the LONGEST matching group among several prefixes', () => {
    const raw = [
      'User-agent: seo', 'Disallow: /a', '',
      'User-agent: seo-audit-agent', 'Disallow: /b', '',
      'User-agent: *', 'Disallow: /c',
    ].join('\n');
    const r = parseRobots(raw, 'seo-audit-agent');
    assert.deepEqual(r.disallow, ['/b']);
  });

  it('honours a group that lists our token alongside other agents', () => {
    const raw = [
      'User-agent: googlebot',
      'User-agent: seo-audit-agent',
      'Disallow: /shared',
    ].join('\n');
    const r = parseRobots(raw, 'seo-audit-agent');
    assert.deepEqual(r.disallow, ['/shared']);
  });
});
