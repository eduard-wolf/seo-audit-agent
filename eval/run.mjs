#!/usr/bin/env node
/**
 * eval/run.mjs — Orchestrator for the eval harness: loads fixtures + committed
 * runs/verdicts, runs every scorer, aggregates into a deterministic report,
 * and applies the pass/fail gate (hard invariants + no-regression + floor).
 *
 * `runEval()` is a pure function (no fs writes, no process.exit) so it can be
 * unit-tested against scratch trees. The CLI entry point at the bottom of this
 * file is the only part that touches the filesystem for writes or exits the
 * process — it resolves the default `eval/fixtures` + `eval/runs` directories,
 * reads `eval/gate.json` (required) and `eval/baseline.json` (optional), calls
 * `runEval()`, writes `eval/report/latest.{json,md}`, and exits non-zero on a
 * gate failure so CI fails loudly.
 *
 * DETERMINISM: no Date.now()/Math.random() anywhere in this module. Fixture
 * order is sorted (via `listFixtures`), every per-fixture/per-run array is
 * built in a fixed, sorted order, and every report object is assembled with a
 * fixed key-insertion order — so `JSON.stringify(report)` is byte-identical
 * across repeated runs on the same on-disk inputs.
 *
 * No npm dependencies — pure Node.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from '../crawl/run.mjs';
import { listFixtures, loadFixture, loadRuns, loadVerdicts } from './lib/fixtures.mjs';
import { buildCitationAllowlist } from './lib/kb-citations.mjs';
import { scoreSchema } from './scorers/schema.mjs';
import { scoreRecall } from './scorers/recall.mjs';
import { scoreCitations } from './scorers/citation.mjs';
import { scoreFabrication } from './scorers/fabrication.mjs';
import { scoreProvenance } from './scorers/provenance.mjs';
import { scoreStability } from './scorers/stability.mjs';
import { scoreFaithfulness } from './scorers/faithfulness.mjs';

const EPS = 1e-9;

/**
 * Mean of a numeric array, or null if the array is empty.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Score a single fixture: loads its runs + verdicts, scores every run with
 * every scorer, and rolls the results up into the fixed-shape per-fixture
 * report object plus the raw per-run totals the caller needs for the
 * cross-fixture aggregate (citation/fabrication/faithfulness sums).
 *
 * @param {string} fixturesDir
 * @param {string} runsDir
 * @param {string} name — fixture name
 * @param {{ urls: Set<string>, basenames: Set<string> }} allowlist
 * @returns {{ fixtureReport: object, totals: { schemaValids: boolean[], citationTotal: number, citationValid: number, fabrications: number, verdictTotal: number, verdictSupported: number, hasRuns: boolean, recallMean: number|null, passK: number|null } }}
 */
function scoreFixture(fixturesDir, runsDir, name, allowlist) {
  const fixture = loadFixture(fixturesDir, name);
  const runs = loadRuns(runsDir, name);
  const verdictRuns = loadVerdicts(runsDir, name);

  const schemaValids = [];
  const perRunRecall = [];
  let citationTotal = 0;
  let citationValid = 0;
  let fabrications = 0;
  const provenanceIssues = [];

  for (const r of runs) {
    const schemaResult = scoreSchema(r.findings);
    schemaValids.push(schemaResult.valid);

    perRunRecall.push(scoreRecall(r.findings, fixture.expected).recall);

    const citeResult = scoreCitations(r.findings, allowlist);
    citationTotal += citeResult.total;
    citationValid += citeResult.valid;

    const fabResult = scoreFabrication(r.findings, fixture.expected, fixture.analysis);
    fabrications += fabResult.fabrications;

    const provResult = scoreProvenance(r.findings);
    for (const issue of provResult.issues) provenanceIssues.push({ run: r.run, issue });
  }

  const stability = scoreStability(perRunRecall);
  const faithfulness = scoreFaithfulness(verdictRuns.map(v => v.verdicts));
  const recallMean = mean(perRunRecall);
  const schemaAllValid = schemaValids.every(Boolean); // vacuously true when runs.length === 0

  const fixtureReport = {
    name,
    runs: runs.length,
    schemaAllValid,
    recall: { mean: recallMean, perRun: perRunRecall },
    citation: {
      total: citationTotal,
      valid: citationValid,
      validity: citationTotal === 0 ? 1 : citationValid / citationTotal,
    },
    fabrications,
    provenance: { issues: provenanceIssues },
    stability,
    faithfulness,
  };

  const totals = {
    schemaValids,
    citationTotal,
    citationValid,
    fabrications,
    verdictTotal: faithfulness.total,
    verdictSupported: faithfulness.supported,
    hasRuns: runs.length > 0,
    recallMean,
    passK: stability.passK,
  };

  return { fixtureReport, totals };
}

/**
 * Evaluate every soft (floor + no-regression) gate metric and every hard
 * invariant, and combine them into the gate result.
 *
 * @param {{ recall: number|null, citationValidity: number, fabrications: number, faithfulness: number|null, stabilityPassK: number|null, schemaValid: boolean }} aggregate
 * @param {{ floors?: Record<string, number> }} gate
 * @param {{ aggregate?: Record<string, number> }|null} baseline
 * @returns {{ passed: boolean, hardFailures: string[], softFailures: string[] }}
 */
function buildGateResult(aggregate, gate, baseline) {
  const hardFailures = [];
  const softFailures = [];

  if (aggregate.schemaValid !== true) {
    hardFailures.push('hard invariant violated: not every run is schema-valid (schemaValid !== true)');
  }
  if (aggregate.fabrications !== 0) {
    hardFailures.push(`hard invariant violated: fabrications !== 0 (found ${aggregate.fabrications})`);
  }
  if (aggregate.citationValidity < 1 - EPS) {
    hardFailures.push(`hard invariant violated: citationValidity < 1 (got ${aggregate.citationValidity})`);
  }

  const floors = (gate && gate.floors) || {};
  const baselineAgg = (baseline && baseline.aggregate) || null;

  // Soft metric spec: [report.aggregate key, gate.floors key]. The baseline key
  // is IDENTICAL to the aggregate key (baseline.json is expected to store the
  // report's own aggregate verbatim, so its stability field is "stabilityPassK",
  // never the shorter "stability") — no accept-either fallback.
  const softMetrics = [
    { aggKey: 'recall', floorKey: 'recall' },
    { aggKey: 'faithfulness', floorKey: 'faithfulness' },
    { aggKey: 'stabilityPassK', floorKey: 'stability' },
  ];

  for (const { aggKey, floorKey } of softMetrics) {
    const current = aggregate[aggKey];
    if (current === null) continue; // absent data — cannot gate

    const floor = floors[floorKey];
    if (typeof floor === 'number' && current < floor - EPS) {
      softFailures.push(`${aggKey} (${current}) is below the gate floor for "${floorKey}" (${floor})`);
    }

    const baselineValue = baselineAgg ? baselineAgg[aggKey] : undefined;
    if (typeof baselineValue === 'number' && current < baselineValue - EPS) {
      softFailures.push(`${aggKey} (${current}) regressed vs baseline "${aggKey}" (${baselineValue})`);
    }
  }

  return { passed: hardFailures.length === 0 && softFailures.length === 0, hardFailures, softFailures };
}

/**
 * Run the full eval harness over a fixtures/runs tree: score every fixture's
 * every run with every scorer, aggregate into a deterministic report, and
 * apply the gate. Pure — performs only fs reads (via the loaders), never
 * writes and never exits the process.
 *
 * @param {{ fixturesDir: string, runsDir: string, gate: { floors?: Record<string, number> }, baseline: { aggregate?: Record<string, number> }|null }} opts
 * @returns {{ report: object, gateResult: { passed: boolean, hardFailures: string[], softFailures: string[] } }}
 */
export function runEval({ fixturesDir, runsDir, gate, baseline }) {
  const allowlist = buildCitationAllowlist();
  const names = fs.existsSync(fixturesDir) ? listFixtures(fixturesDir) : [];

  const fixtures = [];
  const allSchemaValids = [];
  let citationTotal = 0;
  let citationValid = 0;
  let fabrications = 0;
  let verdictTotal = 0;
  let verdictSupported = 0;
  const perFixtureRecallMeans = [];
  const perFixturePassK = [];

  for (const name of names) {
    const { fixtureReport, totals } = scoreFixture(fixturesDir, runsDir, name, allowlist);
    fixtures.push(fixtureReport);

    allSchemaValids.push(...totals.schemaValids);
    citationTotal += totals.citationTotal;
    citationValid += totals.citationValid;
    fabrications += totals.fabrications;
    verdictTotal += totals.verdictTotal;
    verdictSupported += totals.verdictSupported;
    if (totals.hasRuns) {
      perFixtureRecallMeans.push(totals.recallMean);
      perFixturePassK.push(totals.passK);
    }
  }

  const aggregate = {
    recall: mean(perFixtureRecallMeans),
    citationValidity: citationTotal === 0 ? 1 : citationValid / citationTotal,
    fabrications,
    faithfulness: verdictTotal === 0 ? null : verdictSupported / verdictTotal,
    stabilityPassK: mean(perFixturePassK),
    schemaValid: allSchemaValids.every(Boolean), // vacuously true with zero runs anywhere
  };

  const report = { aggregate, fixtures };
  const gateResult = buildGateResult(aggregate, gate, baseline);

  return { report, gateResult };
}

/**
 * Format a metric value for the markdown report: null renders as "n/a",
 * booleans render verbatim, numbers are rounded to 4 decimal places with
 * trailing zeros trimmed (display-only — never affects the JSON report).
 *
 * @param {number|boolean|null} value
 * @returns {string}
 */
function fmt(value) {
  if (value === null) return 'n/a';
  if (typeof value === 'boolean') return String(value);
  return String(Math.round(value * 10000) / 10000);
}

/**
 * Build a deterministic, human-readable markdown summary of a report + gate
 * result. No timestamps — same report/gateResult always renders identically.
 *
 * @param {object} report — as returned by runEval()
 * @param {{ passed: boolean, hardFailures: string[], softFailures: string[] }} gateResult
 * @returns {string}
 */
export function buildReportMarkdown(report, gateResult) {
  const a = report.aggregate;
  const lines = [];

  lines.push('# Eval Report', '');
  lines.push('## Aggregate', '');
  lines.push('| Metric | Value |', '| --- | --- |');
  lines.push(`| Recall | ${fmt(a.recall)} |`);
  lines.push(`| Citation validity | ${fmt(a.citationValidity)} |`);
  lines.push(`| Fabrications | ${fmt(a.fabrications)} |`);
  lines.push(`| Faithfulness | ${fmt(a.faithfulness)} |`);
  lines.push(`| Stability (pass^k) | ${fmt(a.stabilityPassK)} |`);
  lines.push(`| Schema valid | ${fmt(a.schemaValid)} |`);
  lines.push('');

  lines.push('## Fixtures', '');
  if (report.fixtures.length === 0) {
    lines.push('_No fixtures present._', '');
  } else {
    lines.push('| Fixture | Runs | Schema valid | Recall (mean) | Citation validity | Fabrications | Stability (pass^k) | Faithfulness |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const f of report.fixtures) {
      lines.push(
        `| ${f.name} | ${f.runs} | ${fmt(f.schemaAllValid)} | ${fmt(f.recall.mean)} | ${fmt(f.citation.validity)} | ${fmt(f.fabrications)} | ${fmt(f.stability.passK)} | ${fmt(f.faithfulness.passRate)} |`,
      );
    }
    lines.push('');
  }

  lines.push(`## GATE: ${gateResult.passed ? 'PASS' : 'FAIL'}`, '');
  if (gateResult.hardFailures.length > 0) {
    lines.push('Hard failures:');
    for (const failure of gateResult.hardFailures) lines.push(`- ${failure}`);
    lines.push('');
  }
  if (gateResult.softFailures.length > 0) {
    lines.push('Soft failures:');
    for (const failure of gateResult.softFailures) lines.push(`- ${failure}`);
    lines.push('');
  }
  if (gateResult.hardFailures.length === 0 && gateResult.softFailures.length === 0) {
    lines.push('No gate failures.', '');
  }

  return lines.join('\n');
}

// ── CLI entry point ────────────────────────────────────────────────────────
// Only runs when invoked directly (node eval/run.mjs), not on import.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const evalDir = path.dirname(fileURLToPath(import.meta.url));
  const fixturesDir = path.join(evalDir, 'fixtures');
  const runsDir = path.join(evalDir, 'runs');
  const gatePath = path.join(evalDir, 'gate.json');
  const baselinePath = path.join(evalDir, 'baseline.json');
  const reportDir = path.join(evalDir, 'report');

  try {
    const gate = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
    const baseline = fs.existsSync(baselinePath)
      ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
      : null;

    const { report, gateResult } = runEval({ fixturesDir, runsDir, gate, baseline });
    const markdown = buildReportMarkdown(report, gateResult);

    fs.mkdirSync(reportDir, { recursive: true });
    writeFileAtomic(path.join(reportDir, 'latest.json'), JSON.stringify(report, null, 2));
    writeFileAtomic(path.join(reportDir, 'latest.md'), markdown);

    console.log(markdown);
    process.exit(gateResult.passed ? 0 : 1);
  } catch (err) {
    console.error(`eval run failed: ${err?.message || err}`);
    process.exit(1);
  }
}
