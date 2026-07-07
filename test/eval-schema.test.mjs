/**
 * test/eval-schema.test.mjs — Unit tests for eval expected-findings + judge-verdict validators.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateExpected } from '../eval/schema/expected-schema.mjs';

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
