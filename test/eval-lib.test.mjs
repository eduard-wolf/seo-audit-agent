/**
 * test/eval-lib.test.mjs — Unit tests for eval/lib helpers (ruleids, kb-citations, fixtures).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findingRuleIds, producedRuleIds, analysisRuleIds, positiveRuleIds } from '../eval/lib/ruleids.mjs';
import { extractInterpretedRuleIds } from '../bin/handoff.mjs';

describe('eval/lib/ruleids', () => {
  it('findingRuleIds prefers first-class ruleIds[]', () => {
    assert.deepEqual(findingRuleIds({ ruleIds: ['b:y', 'a:x'] }), ['a:x', 'b:y'],
      'ruleIds[] should be used verbatim, sorted+deduped');
  });
  it('findingRuleIds scrapes ruleId= clauses from beleg (folded ids captured)', () => {
    const f = { beleg: 'analysis.json ruleId=tech:sitemap-quality + tech:noindex-conflict; more text' };
    assert.deepEqual(findingRuleIds(f), ['tech:noindex-conflict', 'tech:sitemap-quality'],
      'both folded rule ids inside the ruleId= clause must be captured');
  });
  it('producedRuleIds matches the canonical handoff extractor on the real golden findings', () => {
    const g = JSON.parse(fs.readFileSync(new URL('../examples/example-run/findings.json', import.meta.url), 'utf8'));
    assert.deepEqual(producedRuleIds(g), extractInterpretedRuleIds(g),
      'eval producedRuleIds must agree with bin/handoff.mjs extractInterpretedRuleIds (parity)');
    assert.ok(producedRuleIds(g).length > 0, 'golden findings must yield rule ids');
  });
  it('analysisRuleIds / positiveRuleIds read the deterministic analysis shape', () => {
    const a = { findings: [{ ruleId: 'a:1' }, { ruleId: 'a:1' }, { ruleId: 'b:2' }], positives: [{ ruleId: 'c:3' }] };
    assert.deepEqual(analysisRuleIds(a), ['a:1', 'b:2'], 'analysis rule ids sorted+deduped');
    assert.deepEqual(positiveRuleIds(a), ['c:3'], 'positive rule ids sorted+deduped');
  });
});
