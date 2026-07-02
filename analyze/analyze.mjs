/**
 * analyze/analyze.mjs — Orchestrator for the SEO Rule Analyzer (Unit D1).
 *
 * Exports:
 *   analyze(rows, signals, linkgraph, rules)       → analysisObj
 *   analyzeFromFiles(csvPath, signalsPath)         → Promise<analysisObj>
 *
 * analysisObj shape:
 * {
 *   meta: { origin, host, crawledAt, pageCount, sampleSize, siteType, coveragePct, minNMet },
 *   rulesetVersion: string,
 *   findings:  [ { ruleId, kategorie, scope, severity, title, count, pctOfPages,
 *                  affectedUrls, detail, quelle, datum } ],
 *   positives: [ { ruleId, title } ],
 *   signals:   { robots, llms, aiBots }
 * }
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv, csvEscape } from '../crawl/schema.mjs';
import { MAX_TOTAL_LOCS } from '../crawl/sitefetch.mjs';
import { runRules, loadRules } from './engine.mjs';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR  = path.resolve(__dirname, '../config/rules');
const VERSION_FILE = path.resolve(__dirname, '../config/rules-version.json');

/** Cached ruleset version string — read once at module load. */
const RULESET_VERSION = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).version;

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Determine site type from crawl rows:
 * 'client-rendered' when >50 % of rows are js-guard pages, else 'server-rendered'.
 *
 * @param {object[]} rows
 * @returns {'server-rendered'|'client-rendered'}
 */
function deriveSiteType(rows) {
  if (rows.length === 0) return 'server-rendered';
  const jsGuard = rows.filter(r => r.error === 'js-guard:empty-body').length;
  return jsGuard / rows.length > 0.5 ? 'client-rendered' : 'server-rendered';
}

/**
 * Extract origin and host from the first row's URL.
 *
 * @param {object[]} rows
 * @returns {{ origin: string, host: string }}
 */
function originFromRows(rows) {
  for (const row of rows) {
    try {
      const u = new URL(row.url);
      return { origin: u.origin, host: u.hostname };
    } catch { /* skip */ }
  }
  return { origin: '', host: '' };
}

// ── main exports ─────────────────────────────────────────────────────────────

/**
 * Analyze crawl data and return a structured analysis object.
 *
 * @param {object[]} rows            — CSV row objects (all field values are strings)
 * @param {object}   signals         — parsed signals.json (robots, llms, sitemapUrls, linkGraph …)
 * @param {object}   linkgraph       — signals.linkGraph sub-object (orphans, totalPages …)
 * @param {object[]} rules           — loaded rule descriptors from config/rules/
 * @param {object|null} [runtimeSignals=null] — optional runtime overlay (from runtime-signals.json)
 * @returns {object}  analysisObj
 */
export function analyze(rows, signals, linkgraph, rules, runtimeSignals = null) {
  const pageCount = rows.length;
  const minNMet   = pageCount >= 5;

  const { origin, host } = originFromRows(rows);
  const siteType = deriveSiteType(rows);

  // Build context for the engine
  const ctx = { rows, signals, linkgraph, runtimeSignals };

  // Run all rules
  const { findings, positives, affectedUrlsByRule } = runRules(ctx, rules);

  // ── Coverage (geschätzt) ──────────────────────────────────────────────────
  // Provenienz: „geschätzt" — Sitemaps können unvollständig oder veraltet sein;
  // der BFS-Wert ist eine Obergrenze (discoveredSet ist durch maxDepth/maxUrls begrenzt).
  const fetched    = signals.crawlMeta?.fetched ?? rows.length;
  const discovered = signals.crawlMeta?.discovered;

  let coveragePct;
  if (signals.sitemapUrls?.length >= MAX_TOTAL_LOCS) {
    // The sitemap URL set is truncated at MAX_TOTAL_LOCS (crawl/sitefetch.mjs). At the cap the
    // real sitemap may be larger than the set we counted, so fetched/cappedTotal would OVERSTATE
    // coverage (e.g. 25k/50k = 50% while true coverage against a 200k sitemap is 12.5%). Report
    // null rather than an inflated number (anti-overclaim / provenance honesty).
    coveragePct = null;
  } else if (signals.sitemapUrls?.length > 0) {
    // Sitemap als Nenner: echte Coverage gegen bekannten URL-Raum
    coveragePct = Math.min(100, Math.round(fetched / signals.sitemapUrls.length * 100));
  } else if (typeof discovered === 'number' && discovered > 0) {
    // BFS ohne Sitemap: discovered ist Obergrenze des sichtbaren URL-Raums
    coveragePct = Math.min(100, Math.round(fetched / discovered * 100));
  } else {
    // Kein Nenner verfügbar — null als konservativer Fallback (kein Overclaim)
    coveragePct = null;
  }

  return {
    meta: {
      origin,
      host,
      crawledAt:    signals.crawlMeta?.crawledAt ?? null,
      pageCount,
      sampleSize:   pageCount,
      siteType,
      coveragePct,
      capped:       signals.crawlMeta?.capped ?? false,
      fetched,
      discovered:   discovered ?? null,
      sitemapTotal: signals.sitemapUrls?.length ?? null,
      minNMet,
    },
    rulesetVersion: RULESET_VERSION,
    findings,
    positives,
    signals: {
      robots: signals.robots  ?? null,
      llms:   signals.llms    ?? null,
      aiBots: signals.robots?.aiBots ?? [],
    },
    affectedUrlsByRule,
  };
}

/**
 * Load crawl output from files, run the full rule set, and return the analysis.
 *
 * @param {string} csvPath      — absolute path to crawl.csv
 * @param {string} signalsPath  — absolute path to signals.json
 * @returns {Promise<object>}   analysisObj
 */
export async function analyzeFromFiles(csvPath, signalsPath) {
  const csv    = fs.readFileSync(csvPath, 'utf8');
  const rows   = parseCsv(csv);

  const sigRaw = fs.readFileSync(signalsPath, 'utf8');
  const sigObj = JSON.parse(sigRaw);

  // linkgraph is embedded in signals.json by runCrawl
  const linkgraph = sigObj.linkGraph ?? {};

  const rules = loadRules(RULES_DIR);

  let runtimeSignals = null;
  const rsPath = path.join(path.dirname(csvPath), 'runtime-signals.json');
  if (fs.existsSync(rsPath)) { try { runtimeSignals = JSON.parse(fs.readFileSync(rsPath, 'utf8')); } catch { /* ignore */ } }

  const { affectedUrlsByRule, ...analysis } = analyze(rows, sigObj, linkgraph, rules, runtimeSignals);
  const sidecarPath = path.join(path.dirname(csvPath), 'affected-urls.csv');
  const lines = ['ruleId,url'];
  for (const [ruleId, urls] of Object.entries(affectedUrlsByRule)) {
    for (const u of urls) lines.push(`${csvEscape(ruleId)},${csvEscape(u)}`);
  }
  fs.writeFileSync(sidecarPath, lines.join('\n'), 'utf8');
  return analysis;   // analysis.json (written by bin) stays lean — full lists live in the sidecar
}
