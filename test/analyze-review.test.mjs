/**
 * test/analyze-review.test.mjs — review-2026-07-06 detector fixes.
 *   1. Site-level findings (empty affectedUrls) reported a nonsensical pctOfPages
 *      (count / pageCount) — e.g. "30 % of pages" for a robots.txt directive.
 *   2. geo:missing-citations flagged any page with zero AUTHORITATIVE outlinks,
 *      firing on pages that DO cite non-authoritative sources → high false-positive
 *      rate. Now gated on the new outlinksExternal signal (no external links at all).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runRules } from '../analyze/engine.mjs';
import { detectors as geoDetectors } from '../analyze/detectors/geo.mjs';

const geo = new Map(geoDetectors);

describe('engine — site-level findings get pctOfPages null', () => {
  it('geo:ai-bot-blocked (empty affectedUrls, count>1) does not report a percentage', () => {
    const ctx = {
      rows: Array.from({ length: 10 }, (_, i) => ({ url: `http://x/${i}` })),
      signals: {
        robots: { aiBots: [
          { agent: 'GPTBot', disallowAll: true, kategorie: 'training' },
          { agent: 'ClaudeBot', disallowAll: true, kategorie: 'ai-search' },
        ] },
        llms: null,
      },
    };
    const rule = { id: 'geo:ai-bot-blocked', kategorie: 'geo', scope: 'site', severity: 'hoch', title: 'T', quelle: 'q', datum: 'd' };
    const { findings } = runRules(ctx, [rule]);
    const f = findings.find(x => x.ruleId === 'geo:ai-bot-blocked');
    assert.ok(f, 'the rule should fire');
    assert.equal(f.count, 2);
    assert.equal(f.pctOfPages, null, 'a site-level finding must not report count/pageCount as pctOfPages');
  });
});

describe('geo:missing-citations — gated on outlinksExternal', () => {
  const missingCitations = geo.get('geo:missing-citations');
  const row = (url, ext, auth) => ({
    url, error: '', redirected: '0', wordCount: '100',
    outlinksAuthoritative: String(auth), outlinksExternal: String(ext),
  });

  it('does NOT flag a page that cites non-authoritative external sources', () => {
    const ctx = { rows: [row('http://x/a', 2, 0), row('http://x/b', 0, 0)] };
    const r = missingCitations(ctx, {});
    assert.deepEqual(r.affectedUrls, ['http://x/b'], 'only the page with zero external links is flagged');
    assert.equal(r.count, 1);
  });
});
