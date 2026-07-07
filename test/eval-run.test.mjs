/**
 * test/eval-run.test.mjs — Integration test for the eval runner + gate + report determinism.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runEval, buildReportMarkdown } from '../eval/run.mjs';
import { validateFindings } from '../lib/findings-schema.mjs';

const GATE = { floors: { recall: 0.5, faithfulness: 0.6, stability: 0.4 } };

const tmps = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-eval-')); tmps.push(d); return d; }
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

// Minimal schema-valid findings factory (fill required fields) — implementer completes to satisfy validateFindings.
// `kbSources` defaults to [] (no citations to check); pass entries like
// `[{ source: 'https://example.com/fabricated' }]` to exercise the citation scorer.
function validFindings(ruleId, kbSources = []) {
  return {
    meta: {
      url: 'http://example.test',
      crawledAt: '2026-01-01T00:00:00.000Z',
      modelId: 'test-model',
      rulesetVersion: '1.0.0',
      sampleSize: 5,
      coveragePct: 100,
      siteType: 'server-rendered',
    },
    execSummary: { metrics: [], patterns: [], quickWins: [] },
    sections: [
      {
        id: 'sec-test',
        num: 1,
        title: 'Test Section',
        findings: [
          {
            id: 'f-1',
            title: 'Test finding',
            category: 'tech',
            severity: 'niedrig',
            prov: 'gemessen',
            befund: 'Test befund text.',
            beleg: `analysis.json ruleId=${ruleId}`,
            evidence: 'Test evidence text.',
            auswirkung: 'Test auswirkung text.',
            empfehlung: 'Test empfehlung text.',
            ice: { i: 1, c: 1, e: 1, score: 1 },
            kbSources,
          },
        ],
      },
    ],
    positives: [],
    strategy: { levers: [], todos: [] },
    confidence: { sampleSize: 5, minNMet: true, caveats: [] },
  };
}

/**
 * Write a single-fixture scratch tree (fixtures/<name> + runs/<name>/run-N) with
 * a configurable set of "real" ruleIds (each becomes both an analysis.json
 * finding and an expected-findings.json mustContain anchor) and one findings.json
 * per run. General-purpose helper behind `buildTree()`.
 *
 * @param {{ ruleIds: string[], runsFindings: object[] }} opts
 * @returns {{ fixturesDir: string, runsDir: string, fixtureName: string }}
 */
function writeTree({ ruleIds, runsFindings }) {
  const root = scratch();
  const fixtureName = 'fix1';
  const fixturesDir = path.join(root, 'fixtures');
  const runsDir = path.join(root, 'runs');

  fs.mkdirSync(path.join(fixturesDir, fixtureName), { recursive: true });
  fs.writeFileSync(
    path.join(fixturesDir, fixtureName, 'analysis.json'),
    JSON.stringify({ findings: ruleIds.map(ruleId => ({ ruleId })), positives: [] }),
  );
  fs.writeFileSync(
    path.join(fixturesDir, fixtureName, 'expected-findings.json'),
    JSON.stringify({ fixture: fixtureName, mustContain: ruleIds.map(ruleId => ({ ruleId })), mustNotContain: [] }),
  );

  runsFindings.forEach((runFindings, i) => {
    const runDir = path.join(runsDir, fixtureName, `run-${i + 1}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify(runFindings));
  });

  return { fixturesDir, runsDir, fixtureName };
}

/**
 * Write a single-fixture scratch tree (fixtures/<name> + runs/<name>/run-1) and
 * return its {fixturesDir, runsDir}. The fixture's analysis.json declares one
 * real finding (ruleId 'a:real'); `runFindings` is committed as run-1's findings.json.
 *
 * @param {object} runFindings
 * @returns {{ fixturesDir: string, runsDir: string, fixtureName: string }}
 */
function buildTree(runFindings) {
  return writeTree({ ruleIds: ['a:real'], runsFindings: [runFindings] });
}

describe('eval/run', () => {
  it('validFindings factory produces a schema-valid findings object', () => {
    const result = validateFindings(validFindings('a:x'));
    assert.equal(result.valid, true, `validFindings factory must be schema-valid, got errors: ${JSON.stringify(result.errors)}`);
  });

  it('passes the gate on a clean committed snapshot and fails when a fabrication is injected', () => {
    const clean = buildTree(validFindings('a:real'));
    const { report: cleanReport, gateResult: cleanGate } = runEval({
      fixturesDir: clean.fixturesDir,
      runsDir: clean.runsDir,
      gate: GATE,
      baseline: null,
    });
    assert.equal(cleanGate.passed, true, `clean snapshot should pass the gate, got hardFailures=${JSON.stringify(cleanGate.hardFailures)} softFailures=${JSON.stringify(cleanGate.softFailures)}`);
    assert.equal(cleanReport.aggregate.fabrications, 0, 'clean snapshot should have zero fabrications');
    assert.equal(cleanReport.aggregate.schemaValid, true, 'clean snapshot should be schema-valid');

    const fabricated = buildTree(validFindings('ghost:invented'));
    const { gateResult: fabGate } = runEval({
      fixturesDir: fabricated.fixturesDir,
      runsDir: fabricated.runsDir,
      gate: GATE,
      baseline: null,
    });
    assert.equal(fabGate.passed, false, 'fabricated snapshot should fail the gate');
    assert.ok(
      fabGate.hardFailures.some(f => /fabricat/i.test(f)),
      `hardFailures should mention fabrication, got ${JSON.stringify(fabGate.hardFailures)}`,
    );

    const md = buildReportMarkdown(cleanReport, cleanGate);
    assert.ok(md.includes('PASS'), 'markdown summary should mention PASS for the clean gate result');
  });

  it('produces a byte-identical report and markdown on repeated runs (determinism)', () => {
    const clean = buildTree(validFindings('a:real'));
    const runOnce = () => runEval({ fixturesDir: clean.fixturesDir, runsDir: clean.runsDir, gate: GATE, baseline: null });
    const { report: reportA, gateResult: gateA } = runOnce();
    const { report: reportB, gateResult: gateB } = runOnce();
    assert.equal(
      JSON.stringify(reportA),
      JSON.stringify(reportB),
      'runEval must produce a byte-identical report across repeated runs on the same inputs',
    );
    assert.equal(
      buildReportMarkdown(reportA, gateA),
      buildReportMarkdown(reportB, gateB),
      'buildReportMarkdown must render byte-identical markdown across repeated runs on the same inputs',
    );
  });

  it('fails the gate on a no-regression violation even when the floor itself is met', () => {
    // Two must-contain anchors, but only one run covering one of them: recall = 0.5,
    // which meets the floor (0.5) exactly but regresses against a baseline of 1.0.
    const tree = writeTree({ ruleIds: ['a:real', 'b:real'], runsFindings: [validFindings('a:real')] });
    const { gateResult } = runEval({
      fixturesDir: tree.fixturesDir,
      runsDir: tree.runsDir,
      gate: GATE,
      baseline: { aggregate: { recall: 1.0 } },
    });
    assert.equal(gateResult.passed, false, 'a recall regression vs. baseline must fail the gate even though the floor is met');
    assert.ok(
      gateResult.softFailures.some(f => /regress/i.test(f) && /recall/i.test(f)),
      `softFailures should contain a recall regression entry, got ${JSON.stringify(gateResult.softFailures)}`,
    );
  });

  it('skips a null current metric against baseline instead of treating it as a regression', () => {
    // Single anchor, single run, full recall and passK=1 so recall/stability exactly
    // meet their baseline values — only faithfulness (no judge.json anywhere, so null)
    // is under test here.
    const clean = buildTree(validFindings('a:real'));
    const { gateResult } = runEval({
      fixturesDir: clean.fixturesDir,
      runsDir: clean.runsDir,
      gate: GATE,
      baseline: { aggregate: { recall: 1.0, faithfulness: 0.99, stabilityPassK: 1.0 } },
    });
    assert.ok(
      !gateResult.softFailures.some(f => /faithfulness/i.test(f)),
      `a null current faithfulness must be skipped, not compared against the baseline, got ${JSON.stringify(gateResult.softFailures)}`,
    );
  });

  it('fails the gate on a hard citation-validity violation (fabricated kbSource)', () => {
    const tree = buildTree(validFindings('a:real', [{ source: 'https://example.com/fabricated' }]));
    const { gateResult } = runEval({
      fixturesDir: tree.fixturesDir,
      runsDir: tree.runsDir,
      gate: GATE,
      baseline: null,
    });
    assert.equal(gateResult.passed, false, 'a fabricated kbSource citation should fail the gate');
    assert.ok(
      gateResult.hardFailures.some(f => /citation/i.test(f)),
      `hardFailures should mention citation validity, got ${JSON.stringify(gateResult.hardFailures)}`,
    );
  });

  it('fails the gate on a hard schema-validity violation (empty findings object)', () => {
    const tree = buildTree({});
    const { gateResult } = runEval({
      fixturesDir: tree.fixturesDir,
      runsDir: tree.runsDir,
      gate: GATE,
      baseline: null,
    });
    assert.equal(gateResult.passed, false, 'a schema-invalid run findings.json should fail the gate');
    assert.ok(
      gateResult.hardFailures.some(f => /schema/i.test(f)),
      `hardFailures should mention schema validity, got ${JSON.stringify(gateResult.hardFailures)}`,
    );
  });

  it('returns an empty, gate-passing report when the fixtures directory is absent', () => {
    const root = scratch();
    const { report, gateResult } = runEval({
      fixturesDir: path.join(root, 'no-such-fixtures'),
      runsDir: path.join(root, 'no-such-runs'),
      gate: GATE,
      baseline: null,
    });
    assert.deepEqual(report.fixtures, [], 'no fixtures dir should yield an empty fixtures array');
    assert.equal(gateResult.passed, true, 'no fixtures should pass the gate vacuously');
    assert.equal(gateResult.hardFailures.length, 0, 'no hard failures with no data');
    assert.equal(gateResult.softFailures.length, 0, 'no soft failures with no data (all metrics null)');
  });
});
