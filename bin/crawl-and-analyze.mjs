#!/usr/bin/env node
/**
 * bin/crawl-and-analyze.mjs — Deterministic bookend convenience CLI.
 *
 * Usage:
 *   node bin/crawl-and-analyze.mjs <url> [--profile <quick-scan|standard|full-audit>] [--max <n>] [--rps <n>] [--resume]
 *
 * Ties the two deterministic, dependency-free steps together so the agent can
 * run them with a single command:
 *
 *   1. runCrawl(origin, opts)                  → data/<host>/crawl.csv + signals.json
 *   2. analyzeFromFiles(csvPath, signalsPath)  → analysisObj
 *   3. persist analysisObj                      → data/<host>/analysis.json
 *
 * Prints the absolute path of the written analysis.json. From there the agentic
 * step (skills/interpret.md) takes over: it reads analysis.json, grounds each
 * finding in the knowledge base via kb/retrieve.mjs, and emits the schema-valid
 * data/<host>/findings.json.
 *
 * No npm dependencies — pure Node.js.
 */

import fs from 'node:fs';
import path from 'node:path';

import { runCrawl } from '../crawl/run.mjs';
import { analyzeFromFiles } from '../analyze/analyze.mjs';
import { loadProfile, DEFAULT_PROFILE, PROFILE_NAMES } from '../crawl/profiles.mjs';

/**
 * Run the deterministic bookend and persist analysis.json next to crawl.csv.
 *
 * @param {string} origin — e.g. 'https://example.com' or 'http://127.0.0.1:3000'
 * @param {object} [opts] — forwarded to runCrawl (maxUrls, rps, …)
 * @returns {Promise<{ analysisPath: string, analysis: object,
 *                     csvPath: string, signalsPath: string, siteType: string }>}
 */
export async function crawlAndAnalyze(origin, opts = {}) {
  const { csvPath, signalsPath, siteType } = await runCrawl(origin, opts);
  const analysis = await analyzeFromFiles(csvPath, signalsPath);

  // analysis.json lives in the same data/<host>/ directory as its inputs.
  const analysisPath = path.join(path.dirname(csvPath), 'analysis.json');
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf8');

  return { analysisPath, analysis, csvPath, signalsPath, siteType };
}

const USAGE = 'Usage: node bin/crawl-and-analyze.mjs <url> [--profile <quick-scan|standard|full-audit>] [--max <n>] [--rps <n>] [--resume]';

/**
 * Parse a `--max`-style flag value: must be a positive integer.
 * Throws (mirroring loadProfile / URL validation) so bare Number() coercions —
 * NaN/negative/zero/fractional — can no longer silently disable the page cap.
 *
 * @param {string} raw — the raw argv token following the flag
 * @returns {number}
 */
function positiveInt(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`--max must be a positive integer, got: "${raw}"`);
  }
  return n;
}

/**
 * Parse a `--rps`-style flag value: must be a positive (possibly fractional) number.
 * Throws on NaN/negative/zero so the politeness throttle can't be silently disabled
 * (crawl/throttle.mjs uses 1000/rps; a non-finite or <=0 rps breaks the limiter).
 *
 * @param {string} raw — the raw argv token following the flag
 * @returns {number}
 */
function positiveNumber(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--rps must be a positive number, got: "${raw}"`);
  }
  return n;
}

/**
 * Flag parser: <url> [--profile <name>] [--max <n>] [--rps <n>].
 * Resolves opts from the named profile; explicit --max/--rps override the profile.
 * Throws on unknown profile (via loadProfile) or invalid --max/--rps.
 *
 * @param {string[]} argv — process.argv.slice(2)
 * @returns {{ url: string|undefined, opts: object, profile: string }}
 */
export function parseArgs(argv) {
  let url, profileName;
  const overrides = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile')   { profileName = argv[++i]; }
    else if (arg === '--max')  { overrides.maxUrls = positiveInt(argv[++i]); }
    else if (arg === '--rps')  { overrides.rps = positiveNumber(argv[++i]); }
    else if (arg === '--resume') { overrides.resume = true; }
    else if (!arg.startsWith('--') && url === undefined) { url = arg; }
  }
  const base = loadProfile(profileName ?? DEFAULT_PROFILE);   // throws on unknown profile
  const opts = { ...base, ...overrides };
  return { url, opts, profile: profileName ?? DEFAULT_PROFILE };
}

// ── CLI entry point ───────────────────────────────────────────────────────────
// Only runs when invoked directly (node bin/crawl-and-analyze.mjs …), not on import.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);

  // --help/-h: print usage to STDOUT and succeed, BEFORE any other parsing
  // (otherwise the lone --flag leaves url undefined and we'd exit 1).
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const { url, opts, profile } = parsed;

  if (!url) {
    console.error(USAGE);
    process.exit(1);
  }

  try {
    new URL(url);
  } catch {
    console.error(`Invalid URL: ${url}`);
    process.exit(1);
  }

  crawlAndAnalyze(url, opts)
    .then(({ analysisPath, analysis }) => {
      const { findings = [], positives = [] } = analysis;
      const pageCount = analysis.meta?.pageCount ?? 0;
      const host = analysis.meta?.host;
      console.error(
        `profile=${profile} crawled host=${host} pages=${pageCount} ` +
        `findings=${findings.length} positives=${positives.length} minNMet=${analysis.meta?.minNMet}`,
      );
      // stdout = the one machine-readable line: the analysis.json path (always
      // printed so the artifact stays discoverable even on the degenerate path).
      console.log(analysisPath);

      // Degenerate crawl: nothing reachable / fully disallowed. The artifact is
      // still written above; exit 2 to distinguish from exit-1 input/runtime errors.
      if (pageCount === 0 || !host) {
        console.error('WARNING: 0 pages crawled — host unreachable or fully disallowed');
        process.exit(2);
      }
    })
    .catch((err) => {
      console.error(`crawl-and-analyze failed: ${err?.stack || err}`);
      process.exit(1);
    });
}
