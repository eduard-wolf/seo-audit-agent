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
function validFindings(ruleId) {
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
            kbSources: [],
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
 * Write a single-fixture scratch tree (fixtures/<name> + runs/<name>/run-1) and
 * return its {fixturesDir, runsDir}. The fixture's analysis.json declares one
 * real finding (ruleId 'a:real'); `runFindings` is committed as run-1's findings.json.
 *
 * @param {object} runFindings
 * @returns {{ fixturesDir: string, runsDir: string, fixtureName: string }}
 */
function buildTree(runFindings) {
  const root = scratch();
  const fixtureName = 'fix1';
  const fixturesDir = path.join(root, 'fixtures');
  const runsDir = path.join(root, 'runs');

  fs.mkdirSync(path.join(fixturesDir, fixtureName), { recursive: true });
  fs.writeFileSync(
    path.join(fixturesDir, fixtureName, 'analysis.json'),
    JSON.stringify({ findings: [{ ruleId: 'a:real' }], positives: [] }),
  );
  fs.writeFileSync(
    path.join(fixturesDir, fixtureName, 'expected-findings.json'),
    JSON.stringify({ fixture: fixtureName, mustContain: [{ ruleId: 'a:real' }], mustNotContain: [] }),
  );

  fs.mkdirSync(path.join(runsDir, fixtureName, 'run-1'), { recursive: true });
  fs.writeFileSync(
    path.join(runsDir, fixtureName, 'run-1', 'findings.json'),
    JSON.stringify(runFindings),
  );

  return { fixturesDir, runsDir, fixtureName };
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

  it('produces a byte-identical report on repeated runs (determinism)', () => {
    const clean = buildTree(validFindings('a:real'));
    const runOnce = () => runEval({ fixturesDir: clean.fixturesDir, runsDir: clean.runsDir, gate: GATE, baseline: null });
    const { report: reportA } = runOnce();
    const { report: reportB } = runOnce();
    assert.equal(
      JSON.stringify(reportA),
      JSON.stringify(reportB),
      'runEval must produce a byte-identical report across repeated runs on the same inputs',
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
