/**
 * test/eval-review.test.mjs — Meta-review guarding the eval harness's docs,
 * provenance, and gate honesty (mirrors the repo's *-review.test.mjs pattern).
 *
 * These are not scorer tests (those live in test/eval-*.test.mjs); they assert
 * that the committed eval snapshot stays honestly documented and that the gate's
 * floor really is a conservative safety net below the measured baseline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

describe('eval-review: eval/README.md honesty', () => {
  const doc = read('eval/README.md');
  it('documents the "curated expectations + grounding, not the truth" caveat', () => {
    assert.match(doc, /kuratierte Erwartungen/i, 'must state it measures against curated expectations');
    assert.match(doc, /nicht.*(die )?Wahrheit/is, 'must disclaim measuring absolute truth');
  });
  it('states the key-free / no-API-key rail', () => {
    assert.match(doc, /key-frei/i, 'must state npm run eval is key-free');
    assert.match(doc, /kein.*API-Key|keinen API-Key/i, 'must state no API key is used');
  });
  it('documents the manual baseline-refresh ritual', () => {
    assert.match(doc, /Baseline erneuern/i, 'must document the refresh ritual');
    assert.match(doc, /validateFindings/, 'refresh ritual must require schema validation of runs');
    assert.match(doc, /validateVerdicts/, 'refresh ritual must require verdict validation');
  });
  it('discloses the cross-model-within-Claude bias limitation', () => {
    assert.match(doc, /Self-Preference-Bias/i, 'must name the self-preference bias it mitigates');
    assert.match(doc, /Fremd-Anbieter/i, 'must acknowledge a fully independent judge would reduce it further');
  });
  it('names the pinned interpret + judge models', () => {
    assert.match(doc, /claude-opus-4-8/, 'names the interpret model');
    assert.match(doc, /claude-sonnet-5/, 'names the cross-model judge');
  });
});

describe('eval-review: README.md Evals section', () => {
  const readme = read('README.md');
  it('has an Evals section that points at eval/README.md', () => {
    assert.match(readme, /^##\s+Evals/im, 'README must have an "## Evals" section');
    assert.match(readme, /eval\/README\.md/, 'Evals section must link the methodology doc');
    assert.match(readme, /npm run eval/, 'Evals section must show how to run it');
  });
  it('keeps the honesty framing (not "measures correctness absolutely")', () => {
    assert.match(readme, /nicht gegen absolute\s+Wahrheit|absolut/i, 'must keep the anti-overclaim framing');
  });
});

describe('eval-review: baseline provenance', () => {
  const baseline = readJson('eval/baseline.json');
  it('records generatedWith provenance (models, prompt version, k)', () => {
    const g = baseline.generatedWith;
    assert.ok(g && typeof g === 'object', 'baseline.generatedWith must be present');
    assert.equal(typeof g.interpretModel, 'string', 'records interpret model');
    assert.equal(typeof g.judgeModel, 'string', 'records judge model');
    assert.equal(typeof g.promptVersion, 'string', 'records judge prompt version');
    assert.equal(typeof g.k, 'number', 'records k');
    assert.notEqual(g.interpretModel, g.judgeModel, 'judge must be a different model than interpret (cross-model)');
  });
  it('aggregate carries the strict keys the gate reads', () => {
    const a = baseline.aggregate;
    for (const key of ['recall', 'citationValidity', 'fabrications', 'faithfulness', 'stabilityPassK', 'schemaValid']) {
      assert.ok(key in a, `baseline.aggregate must carry "${key}"`);
    }
  });
});

describe('eval-review: gate floor is a conservative safety net', () => {
  const floors = readJson('eval/gate.json').floors;
  const agg = readJson('eval/baseline.json').aggregate;
  it('every soft-metric floor sits strictly below the committed baseline', () => {
    assert.ok(floors.recall < agg.recall, `recall floor ${floors.recall} must be < baseline ${agg.recall}`);
    assert.ok(floors.faithfulness < agg.faithfulness, `faithfulness floor ${floors.faithfulness} must be < baseline ${agg.faithfulness}`);
    assert.ok(floors.stability < agg.stabilityPassK, `stability floor ${floors.stability} must be < baseline ${agg.stabilityPassK}`);
  });
});
