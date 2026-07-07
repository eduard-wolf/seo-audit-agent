/**
 * eval/lib/fixtures.mjs — Fixture, run, and verdict loaders for the eval harness.
 *
 * No npm dependencies — pure Node.js.
 */

import fs from 'node:fs';
import path from 'node:path';

const RUN_DIR_RE = /^run-(\d+)$/;
const HEADER_LINE = 'ruleId,url';

/**
 * List fixture names under a fixtures directory (its immediate subdirectories).
 *
 * @param {string} fixturesDir
 * @returns {string[]} sorted fixture names
 */
export function listFixtures(fixturesDir) {
  return fs.readdirSync(fixturesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

/**
 * Load a single fixture: its analysis.json, expected-findings.json, and
 * (optionally) the parsed affected-urls.csv sidecar.
 *
 * @param {string} fixturesDir
 * @param {string} name
 * @returns {{ name: string, analysis: object, expected: object, affectedUrls: {ruleId:string,url:string}[] }}
 */
export function loadFixture(fixturesDir, name) {
  const dir = path.join(fixturesDir, name);
  const analysis = JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected-findings.json'), 'utf8'));
  const csvPath = path.join(dir, 'affected-urls.csv');
  const affectedUrls = fs.existsSync(csvPath)
    ? parseAffectedUrls(fs.readFileSync(csvPath, 'utf8'))
    : [];
  return { name, analysis, expected, affectedUrls };
}

/**
 * Parse an affected-urls.csv body into `{ruleId,url}` rows.
 * Drops the `ruleId,url` header line and any blank lines; splits each
 * remaining line on its first comma only (urls may themselves contain commas).
 *
 * @param {string} csvText
 * @returns {{ ruleId: string, url: string }[]}
 */
export function parseAffectedUrls(csvText) {
  const rows = [];
  for (const rawLine of String(csvText).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === HEADER_LINE) continue;
    const idx = rawLine.indexOf(',');
    if (idx === -1) continue;
    rows.push({ ruleId: rawLine.slice(0, idx), url: rawLine.slice(idx + 1) });
  }
  return rows;
}

/**
 * Load every run's findings.json for a fixture, sorted by run number.
 *
 * @param {string} runsDir
 * @param {string} name — fixture name
 * @returns {{ run: number, findings: object }[]}
 */
export function loadRuns(runsDir, name) {
  return loadRunArtifact(runsDir, name, 'findings.json', 'findings');
}

/**
 * Load every run's judge.json verdicts for a fixture, sorted by run number.
 * Runs without a judge.json are skipped (judging is optional per run).
 *
 * @param {string} runsDir
 * @param {string} name — fixture name
 * @returns {{ run: number, verdicts: object }[]}
 */
export function loadVerdicts(runsDir, name) {
  return loadRunArtifact(runsDir, name, 'judge.json', 'verdicts');
}

/**
 * Shared implementation for loadRuns/loadVerdicts: scan the run-N subdirectories
 * of `runsDir/name/` for a given artifact file, parse it, and return sorted
 * `{run, [key]}` entries.
 *
 * @param {string} runsDir
 * @param {string} name
 * @param {string} fileName
 * @param {string} key — property name to attach the parsed JSON under
 * @returns {{ run: number }[]}
 */
function loadRunArtifact(runsDir, name, fileName, key) {
  const dir = path.join(runsDir, name);
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const m = RUN_DIR_RE.exec(d.name);
    if (!m) continue;
    const filePath = path.join(dir, d.name, fileName);
    if (!fs.existsSync(filePath)) continue;
    entries.push({ run: Number(m[1]), [key]: JSON.parse(fs.readFileSync(filePath, 'utf8')) });
  }
  entries.sort((a, b) => a.run - b.run);
  return entries;
}
