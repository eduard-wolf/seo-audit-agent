/**
 * test/report-review.test.mjs — review-2026-07-06 renderer hardening.
 *   1. hostOf() could return a path-traversal component ('..') → CLI wrote outside report/.
 *   2. Attribute-context (double-quote breakout) escaping was untested.
 *   3. Dead `img-src data:` CSP directive (no <img> is ever emitted).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, hostOf } from '../report/build-report.mjs';

const finding = (extra = {}) => ({
  id: 'f-1', title: 'T', category: 'tech-index', severity: 'mittel', prov: 'gemessen',
  befund: 'b', beleg: 'crawl.csv', evidence: 'e', auswirkung: 'a', empfehlung: 'emp',
  ice: { i: 2, c: 2, e: 2, score: 8 }, kbSources: [], ...extra,
});
const base = () => ({
  meta: { url: 'https://x.example/', crawledAt: '2026-01-01', modelId: 'm', rulesetVersion: '1.7.0', sampleSize: 10, coveragePct: 100, siteType: 'server-rendered' },
  execSummary: { metrics: [], patterns: [], quickWins: [] },
  sections: [{ id: 'sec-1', num: 1, title: 'S', findings: [finding()] }],
  positives: [],
  strategy: { levers: [], todos: [] },
  confidence: { sampleSize: 10, minNMet: true, caveats: [] },
});

describe('hostOf — path-traversal safe', () => {
  it('a degenerate ".." / "." host cannot escape the report dir', () => {
    assert.equal(hostOf('http://../x'), 'report');
    assert.equal(hostOf('http://./y'), 'report');
  });
  it('a normal host is preserved', () => {
    assert.equal(hostOf('http://127.0.0.1:8080/a'), '127.0.0.1');
    assert.equal(hostOf('https://example.com/'), 'example.com');
  });
});

describe('render — attribute-context escaping (quote breakout)', () => {
  it('a "-breakout payload in section.id / finding.id cannot break out of an id attribute', () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const f = base();
    f.sections[0].id = payload;
    f.sections[0].findings[0].id = payload;
    const html = render(f);
    assert.ok(!/<img[^>]*onerror=/i.test(html), 'no live <img onerror> may be emitted');
    assert.ok(html.includes('&quot;'), 'the double-quote must be entity-escaped (pins esc() quote branch)');
  });
});

describe('render — CSP', () => {
  it('drops the dead img-src directive but keeps the strict base policy', () => {
    const html = render(base());
    assert.ok(!/img-src/.test(html), 'no dead img-src directive (renderer emits no <img>)');
    assert.ok(html.includes("default-src 'none'"), 'default-src stays locked to none');
    assert.ok(html.includes("style-src 'unsafe-inline'"), 'inline <style> still allowed');
  });
});
