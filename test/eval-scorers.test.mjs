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
