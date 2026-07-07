/**
 * test/eval-scorers.test.mjs — Unit tests for the deterministic eval scorers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scoreRecall } from '../eval/scorers/recall.mjs';
import { scoreCitations } from '../eval/scorers/citation.mjs';
import { buildCitationAllowlist } from '../eval/lib/kb-citations.mjs';
import { scoreSchema } from '../eval/scorers/schema.mjs';
import { scoreFabrication } from '../eval/scorers/fabrication.mjs';
import { scoreProvenance } from '../eval/scorers/provenance.mjs';
import { scoreStability, anchorStability } from '../eval/scorers/stability.mjs';
import { scoreFaithfulness } from '../eval/scorers/faithfulness.mjs';

const golden = JSON.parse(fs.readFileSync(new URL('../examples/example-run/findings.json', import.meta.url), 'utf8'));

describe('eval/scorers/recall', () => {
  it('full recall when every must-contain ruleId is covered by the golden findings', () => {
    // pick two rule ids that the golden run demonstrably covers via beleg
    const expected = { fixture: 'x', mustContain: [
      { ruleId: 'geo:missing-citations' }, { ruleId: 'crawl:orphan-page' }], mustNotContain: [] };
    const r = scoreRecall(golden, expected);
    assert.equal(r.recall, 1, `expected recall 1, missed: ${r.missed.join(',')}`);
  });
  it('partial recall reports the missed anchor', () => {
    const expected = { fixture: 'x', mustContain: [
      { ruleId: 'geo:missing-citations' }, { ruleId: 'zzz:does-not-exist' }], mustNotContain: [] };
    const r = scoreRecall(golden, expected);
    assert.equal(r.total, 2, 'two anchors expected');
    assert.equal(r.recall, 0.5, 'one of two covered');
    assert.deepEqual(r.missed, ['zzz:does-not-exist'], 'reports the uncovered anchor');
  });
});

describe('eval/scorers/citation', () => {
  const allow = buildCitationAllowlist();
  it('golden findings cite only real corpus URLs → 100% validity', () => {
    const r = scoreCitations(golden, allow);
    assert.ok(r.total > 0, 'golden has citations');
    assert.equal(r.validity, 1, `all golden citations must be valid; invalid: ${JSON.stringify(r.invalid)}`);
  });
  it('flags a fabricated citation', () => {
    const bad = { sections: [{ findings: [{ id: 'f-x', kbSources: [{ source: 'https://example.com/nope' }] }] }] };
    const r = scoreCitations(bad, allow);
    assert.equal(r.validity, 0, 'fabricated citation is invalid');
    assert.deepEqual(r.invalid, [{ findingId: 'f-x', source: 'https://example.com/nope' }], 'reports offender');
  });
});

describe('eval/scorers/schema', () => {
  it('golden findings are schema-valid', () => {
    assert.equal(scoreSchema(golden).valid, true, 'golden must validate');
  });
  it('an empty object is schema-invalid with errors', () => {
    const r = scoreSchema({});
    assert.equal(r.valid, false, 'empty object invalid'); assert.ok(r.errors.length > 0, 'has errors');
  });
});

describe('eval/scorers/fabrication', () => {
  const analysis = { findings: [{ ruleId: 'a:real' }], positives: [{ ruleId: 'p:passed' }] };
  const expected = { fixture: 'x', mustContain: [], mustNotContain: [{ ruleId: 'trap:x' }] };
  it('zero fabrications when findings reference only real analysis rule ids', () => {
    const f = { sections: [{ findings: [{ id: 'f1', beleg: 'analysis.json ruleId=a:real' }] }] };
    assert.equal(scoreFabrication(f, expected, analysis).fabrications, 0, 'a:real is in analysis');
  });
  it('flags invented ruleId, positive-claim, and must-not-contain trap', () => {
    const f = { sections: [{ findings: [
      { id: 'f2', beleg: 'x ruleId=ghost:invented' },
      { id: 'f3', beleg: 'x ruleId=p:passed' },
      { id: 'f4', beleg: 'x ruleId=trap:x' }] }] };
    const r = scoreFabrication(f, expected, analysis);
    assert.equal(r.fabrications, 3, 'three distinct fabrication/precision violations');
    assert.ok(r.items.some(i => i.kind === 'not-in-analysis' && i.ruleId === 'ghost:invented'), 'invented flagged');
    assert.ok(r.items.some(i => i.kind === 'on-positive' && i.ruleId === 'p:passed'), 'positive-claim flagged');
    assert.ok(r.items.some(i => i.kind === 'must-not-contain' && i.ruleId === 'trap:x'), 'trap flagged');
  });
});

describe('eval/scorers/provenance', () => {
  it('golden findings satisfy all provenance/anti-overclaim invariants', () => {
    const r = scoreProvenance(golden);
    assert.deepEqual(r.issues, [], `golden must be clean; issues: ${r.issues.join('; ')}`);
  });
  it('detects a c-cap violation under a sub-minimum sample', () => {
    const bad = { meta: { sampleSize: 3 }, confidence: { sampleSize: 3, minNMet: false },
      sections: [{ findings: [{ prov: 'gemessen', severity: 'hoch', ice: { i: 3, c: 2, e: 1, score: 6 } }] }] };
    const r = scoreProvenance(bad);
    assert.equal(r.checks.cCapOk, false, 'c=2 with minNMet=false violates the cap');
  });
});

describe('eval/scorers/stability', () => {
  it('pass^k = fraction of runs with recall 1', () => {
    const r = scoreStability([1, 1, 0.5, 1]);
    assert.equal(r.k, 4, 'k = number of runs');
    assert.equal(r.passK, 0.75, 'three of four runs fully recalled');
    assert.equal(r.recallMin, 0.5, 'min recall');
  });
  it('anchorStability reports per-anchor coverage fraction', () => {
    const r = anchorStability([['a:1', 'b:2'], ['a:1']], ['a:1', 'b:2']);
    assert.deepEqual(r, [{ ruleId: 'a:1', coveredFraction: 1 }, { ruleId: 'b:2', coveredFraction: 0.5 }],
      'a:1 in both runs, b:2 in one');
  });
});

describe('eval/scorers/faithfulness', () => {
  it('aggregates committed judge verdicts across runs', () => {
    const runs = [
      { verdicts: [{ findingId: 'a', supported: true, provenanceCorrect: true, fabricatedNumbers: false, verdict: 'pass', rationale: '' },
                   { findingId: 'b', supported: false, provenanceCorrect: true, fabricatedNumbers: true, verdict: 'fail', rationale: '' }] },
      { verdicts: [{ findingId: 'a', supported: true, provenanceCorrect: false, fabricatedNumbers: false, verdict: 'warn', rationale: '' }] },
    ];
    const r = scoreFaithfulness(runs);
    assert.equal(r.total, 3, 'three verdicts total');
    // passRate is the STRICT rate: fraction with verdict === 'pass' (all three
    // judge axes satisfied), not merely supported. Here only 1 of 3 is a pass.
    assert.equal(r.passed, 1, 'one strict pass (verdict === "pass")');
    assert.equal(r.warned, 1, 'one warn');
    assert.equal(r.failed, 1, 'one fail');
    assert.equal(r.passRate, 1 / 3, 'passRate is passed/total (strict, all three axes)');
    // supported/provenance/fabricatedNumbers remain as diagnostics.
    assert.equal(r.supported, 2, 'two supported (diagnostic)');
    assert.equal(r.fabricatedNumbers, 1, 'one invented-number (diagnostic)');
    assert.equal(r.provenanceIssues, 1, 'one provenance issue (diagnostic)');
  });
});
