/**
 * test/eval-schema.test.mjs — Unit tests for eval expected-findings + judge-verdict validators.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateExpected } from '../eval/schema/expected-schema.mjs';
import { validateVerdicts } from '../eval/schema/verdict-schema.mjs';

describe('eval/schema/expected-schema', () => {
  it('accepts a minimal valid expected-findings object', () => {
    const r = validateExpected({ fixture: 'ecommerce',
      mustContain: [{ ruleId: 'schema:product-no-aggregate', urlAnchor: '/product/' }],
      mustNotContain: [{ ruleId: 'onpage:title-missing', reason: 'all titles present' }] });
    assert.equal(r.valid, true, `expected valid, got errors: ${r.errors.join('; ')}`);
  });
  it('collects errors for missing fixture and malformed mustContain', () => {
    const r = validateExpected({ mustContain: [{ note: 'no ruleId' }], mustNotContain: [] });
    assert.equal(r.valid, false, 'missing fixture + ruleId-less entry must be invalid');
    assert.ok(r.errors.some(e => /fixture/.test(e)), 'reports missing fixture');
    assert.ok(r.errors.some(e => /ruleId/.test(e)), 'reports mustContain entry missing ruleId');
  });
});

describe('eval/schema/verdict-schema', () => {
  const ok = { fixture: 'geo', run: 1, judgeModel: 'claude-x', promptVersion: 'judge-v1',
    verdicts: [{ findingId: 'f-1', supported: true, provenanceCorrect: true, fabricatedNumbers: false, verdict: 'pass', rationale: 'ok' }] };
  it('accepts a well-formed verdict file', () => {
    const r = validateVerdicts(ok);
    assert.equal(r.valid, true, `expected valid, got: ${r.errors.join('; ')}`);
  });
  it('rejects a bad verdict enum and non-boolean supported', () => {
    const bad = structuredClone(ok);
    bad.verdicts[0].verdict = 'maybe'; bad.verdicts[0].supported = 'yes';
    const r = validateVerdicts(bad);
    assert.equal(r.valid, false, 'bad enum + non-boolean must fail');
    assert.ok(r.errors.some(e => /verdict/.test(e)), 'reports bad verdict enum');
  });
});
