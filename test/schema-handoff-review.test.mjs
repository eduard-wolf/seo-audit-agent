/**
 * test/schema-handoff-review.test.mjs — review-2026-07-06 contract hardening.
 *
 *   1. meta.sampleSize and confidence.sampleSize describe the same crawl and must
 *      agree — otherwise the deterministic anti-overclaim cap (minNMet gate) is
 *      bypassable by declaring a large confidence.sampleSize over a tiny crawl.
 *   2. Findings may carry a first-class `ruleIds: string[]`; the handoff ledger
 *      prefers it over scraping `ruleId=` tokens out of free-text `beleg`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFindings } from '../lib/findings-schema.mjs';
import { extractInterpretedRuleIds } from '../bin/handoff.mjs';

const finding = (extra = {}) => ({
  id: 'f-1', title: 'T', category: 'tech-index', severity: 'mittel', prov: 'gemessen',
  befund: 'b', beleg: 'analysis.json ruleId=tech:foo', evidence: 'e', auswirkung: 'a', empfehlung: 'emp',
  ice: { i: 2, c: 2, e: 2, score: 8 }, kbSources: [], ...extra,
});

const base = (extra = {}) => ({
  meta: { url: 'https://x.example/', crawledAt: '2026-01-01', modelId: 'm', rulesetVersion: '1.7.0', sampleSize: 10, coveragePct: 100, siteType: 'server-rendered' },
  execSummary: { metrics: [], patterns: [], quickWins: [] },
  sections: [{ id: 'sec-1', num: 1, title: 'S', findings: [finding()] }],
  positives: [],
  strategy: { levers: [], todos: [] },
  confidence: { sampleSize: 10, minNMet: true, caveats: [] },
  ...extra,
});

describe('validateFindings — sampleSize cross-check', () => {
  it('the baseline object is valid', () => {
    assert.equal(validateFindings(base()).valid, true);
  });

  it('rejects meta.sampleSize !== confidence.sampleSize', () => {
    const obj = base({ meta: { ...base().meta, sampleSize: 3 } }); // confidence.sampleSize stays 10
    const { valid, errors } = validateFindings(obj);
    assert.equal(valid, false);
    assert.ok(errors.some(e => /sampleSize/.test(e)), `expected a sampleSize error; got: ${errors.join(' | ')}`);
  });
});

describe('validateFindings — optional ruleIds field', () => {
  it('accepts a finding with a valid ruleIds string array', () => {
    const obj = base();
    obj.sections[0].findings[0] = finding({ ruleIds: ['tech:foo', 'tech:bar'] });
    assert.equal(validateFindings(obj).valid, true);
  });

  it('rejects ruleIds that is not an array', () => {
    const obj = base();
    obj.sections[0].findings[0] = finding({ ruleIds: 'tech:foo' });
    assert.equal(validateFindings(obj).valid, false);
  });

  it('rejects a non-string ruleIds element', () => {
    const obj = base();
    obj.sections[0].findings[0] = finding({ ruleIds: ['tech:foo', 123] });
    assert.equal(validateFindings(obj).valid, false);
  });
});

describe('handoff ledger — prefers first-class ruleIds over beleg scraping', () => {
  it('uses finding.ruleIds when present (beleg carries no token)', () => {
    const findings = { sections: [{ findings: [{ ruleIds: ['tech:a', 'tech:b'], beleg: 'crawl.csv rows 3-14' }] }] };
    assert.deepEqual(extractInterpretedRuleIds(findings), ['tech:a', 'tech:b']);
  });

  it('still falls back to beleg ruleId= tokens when ruleIds is absent', () => {
    const findings = { sections: [{ findings: [{ beleg: 'analysis.json ruleId=tech:c' }] }] };
    assert.deepEqual(extractInterpretedRuleIds(findings), ['tech:c']);
  });
});
