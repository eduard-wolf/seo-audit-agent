/**
 * test/eval-scorers.test.mjs — Unit tests for the deterministic eval scorers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scoreRecall } from '../eval/scorers/recall.mjs';

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
