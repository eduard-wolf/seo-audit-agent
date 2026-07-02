/**
 * analyze/engine.mjs — Rule-runner engine for Unit D1.
 *
 * Exports:
 *   runRules(ctx, rules)      → { findings[], positives[], affectedUrlsByRule }
 *   loadRules(dir)            → rules[]
 *   registeredDetectorIds()   → string[]
 *
 * ctx = { rows, signals, linkgraph }
 *   rows      — array of CSV row objects (all field values are strings)
 *   signals   — parsed signals.json object (includes robots, llms, sitemapUrls, linkGraph)
 *   linkgraph — signals.linkGraph sub-object (orphans, orphanCount, totalPages)
 *
 * Detectors are pure functions registered by rule id. Each detector:
 *   (ctx, params) → { count, affectedUrls[], detail }
 * count===0  → positive entry (no finding emitted)
 * count > 0  → finding entry with affectedUrls capped at 10
 *
 * The detector implementations live in analyze/detectors/<category>.mjs — one module per
 * config/rules/*.json category. Each module exports `detectors`, an array of [id, fn] pairs.
 * This orchestrator imports all ten modules and registers them into the DETECTORS registry in
 * a deterministic order (mirroring the sorted config-file order). registeredDetectorIds() and
 * the rule↔detector parity test therefore see exactly the same id set as before the split.
 */

import fs   from 'node:fs';
import path from 'node:path';

import { detectors as a11yDetectors }           from './detectors/a11y.mjs';
import { detectors as geoDetectors }            from './detectors/geo.mjs';
import { detectors as hygieneDetectors }        from './detectors/hygiene.mjs';
import { detectors as i18nDetectors }           from './detectors/i18n.mjs';
import { detectors as linksDetectors }          from './detectors/links.mjs';
import { detectors as onPageDetectors }         from './detectors/on-page.mjs';
import { detectors as performanceDetectors }    from './detectors/performance.mjs';
import { detectors as structuredDataDetectors } from './detectors/structured-data.mjs';
import { detectors as techIndexDetectors }      from './detectors/tech-index.mjs';
import { detectors as trustDetectors }          from './detectors/trust.mjs';

// ── Detector registry ────────────────────────────────────────────────────────

/** @type {Map<string, (ctx: object, params: object) => {count:number, affectedUrls:string[], detail:string}>} */
const DETECTORS = new Map();

// Register every category module's detectors in a deterministic order (sorted config-file
// order). Order does not affect runRules (keyed lookup) nor the parity test (set comparison);
// it is fixed here purely for a stable registeredDetectorIds() snapshot.
const DETECTOR_MODULES = [
  a11yDetectors,
  geoDetectors,
  hygieneDetectors,
  i18nDetectors,
  linksDetectors,
  onPageDetectors,
  performanceDetectors,
  structuredDataDetectors,
  techIndexDetectors,
  trustDetectors,
];
for (const mod of DETECTOR_MODULES) {
  for (const [id, fn] of mod) DETECTORS.set(id, fn);
}

// ── Engine helpers ────────────────────────────────────────────────────────────

/**
 * Deterministic stratified sample of up to n URLs, evenly spaced across the list
 * (preserves order, dedupes collisions). For len <= n returns all (== old slice).
 */
function stratifiedSample(urls, n) {
  if (n <= 1) return urls.slice(0, Math.max(0, n)); // guard: n=0 → [], n=1 → first url (avoids /0)
  if (urls.length <= n) return urls.slice();
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (urls.length - 1)) / (n - 1));
    const u = urls[idx];
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

/**
 * Deterministic top-K path-prefix clusters. Groups URLs by their first path
 * segment as `/seg/*` (root path → `/`); counts; returns the K largest as
 * [{pattern, count}], sorted by count desc then pattern asc. Unparseable URLs
 * bucket under `(other)`.
 */
function pathCluster(urls, k) {
  const counts = new Map();
  for (const u of urls) {
    let key;
    try {
      const seg = new URL(u).pathname.split('/').filter(Boolean)[0];
      key = seg ? `/${seg}/*` : '/';
    } catch { key = '(other)'; }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => (b.count - a.count) || (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0))
    .slice(0, k);
}

const CLUSTER_K = 5;

// ── Engine ───────────────────────────────────────────────────────────────────

/**
 * Run all rules against the crawl context.
 *
 * @param {{ rows: object[], signals: object, linkgraph: object }} ctx
 * @param {object[]} rules  — loaded rule descriptors (from config/rules/*.json)
 * @returns {{ findings: object[], positives: object[], affectedUrlsByRule: object }}
 */
export function runRules(ctx, rules) {
  const pageCount = ctx.rows.length;
  const minNMet   = pageCount >= 5;

  /** @type {object[]} */
  const findings  = [];
  /** @type {object[]} */
  const positives = [];
  /** @type {object} */
  const affectedUrlsByRule = {};

  for (const rule of rules) {
    const detector = DETECTORS.get(rule.id);
    if (!detector) continue; // no detector registered yet (D2 rules etc.)

    let result;
    try {
      result = detector(ctx, rule.params ?? {});
    } catch (err) {
      // Guard against detector bugs — treat as if rule fired nothing, but surface the
      // error on stderr so a throwing detector is diagnosable (stdout/artifact bytes are
      // unaffected: this writes to stderr only, never to crawl.csv/signals/analysis.json).
      console.error(`[rule ${rule.id}] detector error: ${err?.message || err}`);
      continue;
    }

    if (result?.skipped) continue;          // not evaluated → neither finding nor positive
    if (!result || result.count === 0) {
      positives.push({ ruleId: rule.id, title: rule.title });
      continue;
    }

    const pctOfPages = minNMet
      ? +((result.count / pageCount) * 100).toFixed(1)
      : null;

    const detail = minNMet
      ? (result.detail ?? '')
      : `kleine Stichprobe (N=${pageCount}), absolute Zahlen statt Quoten`;

    const fullUrls = result.affectedUrls ?? [];
    findings.push({
      ruleId:       rule.id,
      kategorie:    rule.kategorie,
      scope:        rule.scope,
      severity:     rule.severity,
      title:        rule.title,
      count:        result.count,
      pctOfPages,
      affectedUrls: stratifiedSample(fullUrls, 10),   // stratified ≤10 sample (was first-10 slice)
      clusters:     pathCluster(fullUrls, CLUSTER_K), // NEW: deterministic top-K path clusters
      detail,
      quelle:       rule.quelle,
      datum:        rule.datum,
    });
    affectedUrlsByRule[rule.id] = fullUrls;            // full list → sidecar (NOT into analysis.json)
  }

  return { findings, positives, affectedUrlsByRule };
}

/**
 * Load all rule descriptors from JSON files in `dir`.
 * Each JSON file must be an array of rule objects.
 *
 * @param {string} dir  — absolute or relative path to the rules directory
 * @returns {object[]}
 */
export function loadRules(dir) {
  const absDir = path.resolve(dir);
  const files  = fs.readdirSync(absDir)
    .filter(f => f.endsWith('.json'))
    .sort(); // deterministic order

  const rules = [];
  for (const f of files) {
    const raw  = fs.readFileSync(path.join(absDir, f), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      rules.push(...data);
    }
  }
  return rules;
}

/**
 * Enumerate the ids of all registered detectors. Read-only snapshot of the
 * registry keys (no side effects) — used by the rule↔detector parity test to
 * assert every config rule id has a detector and vice-versa.
 *
 * @returns {string[]}
 */
export function registeredDetectorIds() {
  return [...DETECTORS.keys()];
}
