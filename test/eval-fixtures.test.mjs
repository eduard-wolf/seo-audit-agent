/**
 * test/eval-fixtures.test.mjs — Integrity test for the eval-harness golden
 * fixtures under eval/fixtures/.
 *
 * These fixtures are the deterministic INPUT (analysis.json) + golden
 * expectations (expected-findings.json) the interpret step and scorers grade
 * against, so a drifted or self-inconsistent fixture would silently corrupt the
 * whole eval signal. For EVERY fixture directory this asserts:
 *   (a) analysis.json parses and every findings[].ruleId exists in
 *       config/rules/*.json with a MATCHING kategorie and severity;
 *   (b) minNMet === (sampleSize >= 5) and sampleSize <= pageCount;
 *   (c) every site-level sentinel (count === 1 && affectedUrls === []) has
 *       pctOfPages === null;
 *   (d) expected-findings.json passes validateExpected;
 *   (e) every mustContain[].ruleId is present in the analysis findings ruleIds;
 *   (f) every mustNotContain[].ruleId is ABSENT from the analysis findings
 *       ruleIds (a real trap, not a demand the fixture also fulfils).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listFixtures, loadFixture } from '../eval/lib/fixtures.mjs';
import { validateExpected } from '../eval/schema/expected-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(REPO, 'eval', 'fixtures');
const RULES_DIR = path.join(REPO, 'config', 'rules');

// The six fixtures this suite is expected to guard — a guard against a silent
// zero-fixture (vacuously passing) run.
const EXPECTED_FIXTURES = ['broken', 'clean', 'ecommerce', 'editorial', 'example-run', 'geo'];

/**
 * Load every rule definition under config/rules/*.json into a Map by id.
 *
 * @returns {Map<string, object>}
 */
function loadRuleMap() {
  const map = new Map();
  for (const file of fs.readdirSync(RULES_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    for (const r of JSON.parse(fs.readFileSync(path.join(RULES_DIR, file), 'utf8'))) {
      map.set(r.id, r);
    }
  }
  return map;
}

const RULES = loadRuleMap();
const fixtureNames = listFixtures(FIXTURES_DIR);

describe('eval/fixtures integrity', () => {
  it('exposes the six expected fixtures (no silent zero-fixture pass)', () => {
    assert.deepEqual(fixtureNames, EXPECTED_FIXTURES,
      `eval/fixtures should hold exactly ${EXPECTED_FIXTURES.join(', ')}`);
  });

  for (const name of fixtureNames) {
    describe(`fixture: ${name}`, () => {
      const { analysis, expected } = loadFixture(FIXTURES_DIR, name);
      const analysisRuleIds = new Set((analysis.findings || []).map(f => f.ruleId));

      // (a) findings reference real rules with matching kategorie + severity
      it('(a) every finding ruleId exists in config/rules with matching kategorie + severity', () => {
        assert.ok(Array.isArray(analysis.findings), `${name}: analysis.findings must be an array`);
        for (const f of analysis.findings) {
          const rule = RULES.get(f.ruleId);
          assert.ok(rule, `${name}: finding ruleId "${f.ruleId}" is not defined in config/rules/*.json`);
          assert.equal(f.kategorie, rule.kategorie,
            `${name}: ${f.ruleId} kategorie "${f.kategorie}" != config "${rule.kategorie}"`);
          assert.equal(f.severity, rule.severity,
            `${name}: ${f.ruleId} severity "${f.severity}" != config "${rule.severity}"`);
        }
      });

      // (b) sample-size invariants
      it('(b) minNMet === (sampleSize >= 5) and sampleSize <= pageCount', () => {
        const { minNMet, sampleSize, pageCount } = analysis.meta;
        assert.equal(minNMet, sampleSize >= 5,
          `${name}: minNMet (${minNMet}) must equal sampleSize>=5 (sampleSize=${sampleSize})`);
        assert.ok(sampleSize <= pageCount,
          `${name}: sampleSize (${sampleSize}) must be <= pageCount (${pageCount})`);
      });

      // (c) site-level sentinels have null pctOfPages
      it('(c) site-level sentinels (count===1 && affectedUrls===[]) have pctOfPages === null', () => {
        for (const f of analysis.findings) {
          const isSentinel = f.count === 1 && Array.isArray(f.affectedUrls) && f.affectedUrls.length === 0;
          if (isSentinel) {
            assert.equal(f.pctOfPages, null,
              `${name}: sentinel ${f.ruleId} must have pctOfPages === null (got ${f.pctOfPages})`);
          }
        }
      });

      // (d) expected-findings.json conforms to the contract
      it('(d) expected-findings.json passes validateExpected', () => {
        const { valid, errors } = validateExpected(expected);
        assert.ok(valid, `${name}: expected-findings.json invalid: ${errors.join('; ')}`);
        assert.equal(expected.fixture, name,
          `${name}: expected.fixture "${expected.fixture}" should match the directory name`);
      });

      // (e) mustContain ⊆ analysis findings ruleIds
      it('(e) every mustContain ruleId is present in analysis findings', () => {
        for (const { ruleId } of expected.mustContain) {
          assert.ok(analysisRuleIds.has(ruleId),
            `${name}: mustContain "${ruleId}" is not among analysis.findings ruleIds`);
        }
      });

      // (f) mustNotContain ∩ analysis findings ruleIds === ∅
      it('(f) every mustNotContain ruleId is absent from analysis findings', () => {
        for (const { ruleId } of expected.mustNotContain) {
          assert.ok(!analysisRuleIds.has(ruleId),
            `${name}: mustNotContain "${ruleId}" must NOT appear in analysis.findings (it does)`);
        }
      });
    });
  }
});
