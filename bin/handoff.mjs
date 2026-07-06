#!/usr/bin/env node
/**
 * bin/handoff.mjs — Deterministic context-rotation packet generator.
 *
 * This is the executable spec of `skills/context-handoff.md`: it regenerates the
 * resume packet **purely from the on-disk artifacts** (never from chat memory),
 * so a fresh session can continue a long audit losslessly.
 *
 * Usage:
 *   node bin/handoff.mjs <data/<host> | path/to/findings.json | path/to/analysis.json>
 *
 * It reads:
 *   - data/<host>/analysis.json   (required — supplies meta + the full ruleId set)
 *   - data/<host>/findings.json   (optional — supplies the interpreted ruleIds)
 *
 * Progress ledger (derived from files, per skills/interpret.md):
 *   - interpreted ruleIds = the rule ids appearing in `ruleId=…` clauses of each
 *     finding's `beleg` field (the convention every analysis-backed beleg follows).
 *   - remaining ruleIds  = analysis.findings[].ruleId  MINUS  interpreted.
 *
 * DETERMINISM: no Date, no Math.random; every id list is sorted. The same on-disk
 * state always produces a byte-identical packet.
 *
 * No npm dependencies — pure Node.js.
 */

import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS = ['crawl.csv', 'signals.json', 'analysis.json', 'findings.json'];

/**
 * Resolve the caller's argument to the data/<host>/ directory.
 * Accepts the directory itself, or a path to any *.json artifact inside it.
 *
 * @param {string} arg
 * @returns {string} absolute-or-relative directory path
 */
export function resolveDir(arg) {
  if (!arg) throw new Error('missing argument: pass data/<host> or a path to findings.json/analysis.json');
  let stat = null;
  try { stat = fs.statSync(arg); } catch { /* may not exist yet */ }
  if (stat && stat.isDirectory()) return arg;
  if (arg.endsWith('.json')) return path.dirname(arg);
  return arg; // treat as a directory path (downstream load will error if absent)
}

/**
 * Extract the set of interpreted ruleIds from a findings object.
 *
 * Convention: each finding's `beleg` references the rule(s) it covers via a
 * `ruleId=<id>` clause, e.g. `analysis.json ruleId=meta:missing` or a folded list
 * `ruleId=tech:sitemap-quality (count=3) + tech:noindex-conflict; analysis.json …`.
 * We read each `ruleId=` clause (up to the next `;` or end of string) and collect
 * every rule-id-shaped token (`namespace:id`) inside it — so folded rules joined
 * by ` + ` are all captured.
 *
 * @param {object|null} findings
 * @returns {string[]} sorted, de-duplicated ruleIds
 */
export function extractInterpretedRuleIds(findings) {
  const ids = new Set();
  if (!findings || !Array.isArray(findings.sections)) return [];
  const clauseRe = /ruleId=([^;]*)/g;          // clause body up to next ';' or end
  const idRe = /[a-z][a-z0-9]*:[a-z0-9:_-]+/g;  // namespace:id shaped token
  for (const section of findings.sections) {
    if (!section || !Array.isArray(section.findings)) continue;
    for (const f of section.findings) {
      // First-class `ruleIds` is authoritative when present — no prose scraping.
      if (f && Array.isArray(f.ruleIds)) {
        for (const r of f.ruleIds) if (typeof r === 'string' && r) ids.add(r);
        continue;
      }
      // Backward-compatible fallback: scrape `ruleId=` clauses from free-text beleg.
      const beleg = f && typeof f.beleg === 'string' ? f.beleg : '';
      let clause;
      while ((clause = clauseRe.exec(beleg)) !== null) {
        const body = clause[1];
        let m;
        while ((m = idRe.exec(body)) !== null) ids.add(m[0]);
      }
    }
  }
  return [...ids].sort();
}

/**
 * Compute the full handoff ledger from the two artifact objects.
 *
 * @param {object} analysis  — parsed analysis.json
 * @param {object|null} findings — parsed findings.json (or null if absent)
 * @returns {{
 *   host: string, profile: object, sections: {num:number,title:string,id:string}[],
 *   interpreted: string[], remaining: string[], allRuleIds: string[],
 *   findingsPresent: boolean, strategyEmpty: boolean
 * }}
 */
export function computeLedger(analysis, findings) {
  const meta = (analysis && analysis.meta) || {};
  const allRuleIds = Array.isArray(analysis && analysis.findings)
    ? [...new Set(analysis.findings.map(f => f && f.ruleId).filter(Boolean))].sort()
    : [];

  const interpreted = extractInterpretedRuleIds(findings);
  const interpretedSet = new Set(interpreted);
  const remaining = allRuleIds.filter(id => !interpretedSet.has(id)).sort();

  const sections = (findings && Array.isArray(findings.sections) ? findings.sections : [])
    .map(s => ({
      num: typeof s.num === 'number' ? s.num : 0,
      title: typeof s.title === 'string' ? s.title : '(untitled)',
      id: typeof s.id === 'string' ? s.id : '(no-id)',
    }))
    .sort((a, b) => (a.num - b.num) || a.id.localeCompare(b.id));

  const strat = (findings && findings.strategy) || null;
  const strategyEmpty = !strat ||
    ((!Array.isArray(strat.levers) || strat.levers.length === 0) &&
     (!Array.isArray(strat.todos) || strat.todos.length === 0));

  return {
    host: meta.host || '(unknown)',
    profile: {
      siteType: meta.siteType ?? '(unknown)',
      sampleSize: meta.sampleSize ?? '(unknown)',
      coveragePct: meta.coveragePct ?? '(unknown)',
      minNMet: meta.minNMet ?? '(unknown)',
    },
    sections,
    interpreted,
    remaining,
    allRuleIds,
    findingsPresent: !!findings,
    strategyEmpty,
  };
}

/**
 * Load artifacts from a data/<host>/ directory.
 * analysis.json is required; findings.json is optional.
 *
 * @param {string} dir
 * @returns {{ dir: string, analysis: object, findings: object|null, present: Record<string, boolean> }}
 */
export function loadArtifacts(dir) {
  const present = {};
  for (const name of ARTIFACTS) present[name] = fs.existsSync(path.join(dir, name));

  const analysisPath = path.join(dir, 'analysis.json');
  if (!present['analysis.json']) {
    throw new Error(`analysis.json not found in ${dir} — run bin/crawl-and-analyze.mjs first`);
  }
  const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));

  let findings = null;
  if (present['findings.json']) {
    findings = JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8'));
  }
  return { dir, analysis, findings, present };
}

/**
 * Render the deterministic resume packet (skills/context-handoff.md template).
 *
 * @param {string} dir — data/<host>/ directory
 * @returns {string}
 */
export function renderPacket(dir) {
  const { analysis, findings, present } = loadArtifacts(dir);
  const led = computeLedger(analysis, findings);

  const tick = (b) => (b ? '✓' : '✗');
  const findingsStatus = !led.findingsPresent
    ? 'none'
    : (led.remaining.length === 0 ? 'complete' : 'partial');

  const sectionsLine = led.sections.length
    ? led.sections.map(s => `#${s.num} ${s.title} (${s.id})`).join('; ')
    : 'none';

  const interpretedLine = led.interpreted.length ? led.interpreted.join(', ') : 'none';
  const remainingLine = led.remaining.length
    ? led.remaining.join(', ')
    : 'none — all analysis ruleIds interpreted';

  let nextStep;
  if (!led.findingsPresent) {
    nextStep = 'no findings.json yet — apply skills/interpret.md to all analysis ruleIds';
  } else if (led.remaining.length > 0) {
    nextStep = `apply skills/interpret.md to the ${led.remaining.length} remaining ruleId(s) above, then re-run validateFindings`;
  } else if (led.strategyEmpty) {
    nextStep = 'all ruleIds interpreted — run skills/strategy.md, then validateFindings';
  } else {
    nextStep = 'all ruleIds interpreted and strategy present — run validateFindings and render the report';
  }

  return [
    `Resume SEO audit for host: ${led.host}  (artifacts in ${dir})`,
    `Site profile: siteType=${led.profile.siteType} sampleSize=${led.profile.sampleSize} coveragePct=${led.profile.coveragePct} minNMet=${led.profile.minNMet}`,
    `Artifacts present: crawl.csv ${tick(present['crawl.csv'])}  signals.json ${tick(present['signals.json'])}  analysis.json ${tick(present['analysis.json'])}  findings.json ${findingsStatus}`,
    '',
    'Done so far (from findings.json):',
    `  - sections written: ${sectionsLine}`,
    `  - ruleIds interpreted (${led.interpreted.length}): ${interpretedLine}`,
    '',
    'Remaining (from analysis.json minus findings.json):',
    `  - ruleIds not yet interpreted (${led.remaining.length}): ${remainingLine}`,
    `  - next step: ${nextStep}`,
    '',
    'Rules of engagement: read the data/<host>/*.json artifacts as ground truth; do',
    'NOT invent numbers; follow skills/interpret.md (ICE anchors, provenance, KB',
    'grounding via kb/retrieve.mjs, validateFindings before done). Use a current',
    'model in thinking mode; Anthropic docs are the source of truth for Claude',
    'specifics.',
    '',
  ].join('\n');
}

// ── CLI entry point ───────────────────────────────────────────────────────────
// Only runs when invoked directly (node bin/handoff.mjs …), not on import.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (!arg || arg === '--help' || arg === '-h') {
    console.log('Usage: node bin/handoff.mjs <data/<host> | path/to/findings.json | path/to/analysis.json>');
    process.exit(arg ? 0 : 1);
  }
  try {
    const dir = resolveDir(arg);
    process.stdout.write(renderPacket(dir));
  } catch (err) {
    console.error(`handoff failed: ${err?.message || err}`);
    process.exit(1);
  }
}
