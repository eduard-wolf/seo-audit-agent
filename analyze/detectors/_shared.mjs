/**
 * analyze/detectors/_shared.mjs — shared helpers for the per-category detector modules.
 *
 * Extracted VERBATIM from analyze/engine.mjs during the behaviour-neutral category split.
 * These helpers are imported by the category modules under analyze/detectors/*.mjs. No
 * detector logic lives here; only the cross-detector primitives (hreflang validation, row
 * filtering, redirect/error/target-integrity predicates, and the module-scope ARTICLE_TYPES
 * set). Determinism-sensitive: no clock/random reads.
 */

import fs from 'node:fs';
import { normalizeUrl } from '../../crawl/linkgraph.mjs';

// ISO 639-1 (language) + ISO 3166-1 alpha-2 (region) allowlists for hreflang validation.
// Structural validation is insufficient (cannot reject UK/EU/es-419); Google requires codes
// from exactly these two standards (developers.google.com/.../international/localized-versions).
const ISO_CODES   = JSON.parse(fs.readFileSync(new URL('../../config/iso-codes.json', import.meta.url), 'utf8'));
const ISO_LANGS   = new Set(ISO_CODES.languages);
const ISO_REGIONS = new Set(ISO_CODES.regions);

// Validate a single hreflang value per Google's BCP-47 format:
//   language[-Script][-Region]  or the literal "x-default". Case-insensitive.
// • language — ISO 639-1 two-letter code (allowlist)
// • Script   — optional ISO 15924 four-letter code (e.g. Hant/Hans/Latn/Cyrl)
// • Region   — optional ISO 3166-1 Alpha-2 code (allowlist; NOT M.49 numeric like 419,
//              NOT non-ISO-3166-1 codes like UK/EU/UN)
// Rejects: underscore (en_US), M.49 numeric region (es-419 — Google explicitly unsupported),
// non-ISO-3166-1 regions (UK/EU/UN), region-only codes, unknown language codes.
export function isValidHreflang(value) {
  const v = (value ?? '').trim();
  if (v === '') return false;
  if (v.toLowerCase() === 'x-default') return true;
  const parts = v.split('-');
  if (parts.length < 1 || parts.length > 3) return false;
  if (!ISO_LANGS.has(parts[0].toLowerCase())) return false;
  let i = 1;
  // optional script subtag: exactly 4 ASCII letters (ISO 15924), e.g. Hant/Hans/Latn/Cyrl
  if (i < parts.length && /^[A-Za-z]{4}$/.test(parts[i])) i++;
  // optional region subtag: ISO 3166-1 Alpha-2 (NOT M.49 numeric like 419, NOT UK/EU/UN)
  if (i < parts.length) {
    if (!ISO_REGIONS.has(parts[i].toUpperCase())) return false;
    i++;
  }
  if (i !== parts.length) return false; // leftover parts → invalid
  return true;
}

// Article-like JSON-LD types per Google's Article structured-data doc
// (https://developers.google.com/search/docs/appearance/structured-data/article):
// "Article objects must be based on one of: Article, NewsArticle, BlogPosting."
// Shared by structured-data (schema:missing-dates, schema:article-no-author) and
// geo (geo:content-stale).
export const ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'BlogPosting']);

/**
 * Returns true when a robots-meta value signals noindex.
 * Tokenises the value so that only exact directives match.
 * Covers both `noindex` and `none` (Google: `none` ≡ `noindex, nofollow`).
 * Source: https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag
 *
 * @param {string|null|undefined} robotsMeta
 * @returns {boolean}
 */
export function isNoindex(robotsMeta) {
  if (!robotsMeta) return false;
  const tokens = robotsMeta.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return tokens.includes('noindex') || tokens.includes('none');
}

/**
 * Filter rows to only those that are real HTML pages (parsePage was called),
 * are not js-guard suppressed, and are not redirect rows.
 *
 * Non-HTML rows (error pages returning text/plain etc.) have wordCount='' in the CSV.
 * JS-guard rows have error='js-guard:empty-body'.
 * Redirect rows have redirected='1' — they carry parsed content from the final
 * destination and would produce false positives in content-level rules
 * (e.g. onpage:title-dup, onpage:thin) if not excluded here.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
export function contentRows(rows) {
  return rows.filter(
    r => r.error !== 'js-guard:empty-body' && r.wordCount !== '' && r.redirected !== '1',
  );
}

/**
 * Extract pathname from a URL string; returns '' on parse failure.
 *
 * **Multi-subdomain limit:** Matching is done on pathname only (host is ignored).
 * This is intentional for tests where the crawl host (127.0.0.1) differs from
 * the sitemap/canonical host (demo.example). In production, if a site uses
 * multiple subdomains with identical paths (e.g. /about on both blog.example
 * and shop.example), the first crawled row wins. Callers that need host-aware
 * matching must not use this helper.
 *
 * @param {string} urlStr
 * @returns {string}
 */
export function pathname(urlStr) {
  try { return new URL(urlStr).pathname; } catch { return ''; }
}

// ── Shared helpers: link-graph TARGET integrity (Batch 4d) ───────────────────
// Cross-reference a canonical / hreflang / <a href> TARGET against that target's
// OWN crawled row. The "broken" predicates key off the target row's own fields.

/**
 * True when a crawled target ROW is itself a redirect SOURCE: redirected='1' OR a
 * non-empty pipe-separated redirectChain. CRITICAL: this keys off the target row's
 * redirected/redirectChain fields, NOT its final status — the crawler FOLLOWS
 * redirects, so a redirected target's row typically shows the final 2xx status.
 *
 * @param {object|undefined} row
 * @returns {boolean}
 */
export function isRedirectSourceRow(row) {
  if (!row) return false;
  if (row.redirected === '1') return true;
  return (row.redirectChain ?? '').split('|').filter(Boolean).length > 0;
}

/**
 * True when a crawled target ROW has an error final status (HTTP >= 400).
 *
 * @param {object|undefined} row
 * @returns {boolean}
 */
export function isErrorStatusRow(row) {
  if (!row) return false;
  const s = parseInt(row.status, 10);
  return !isNaN(s) && s >= 400;
}

/**
 * Index crawled rows by raw pathname (first crawled wins) — the host-ignored
 * matching used by tech:sitemap-quality. Used to resolve canonical / hreflang
 * TARGET pathnames (which legitimately point to the production host) back to their
 * crawled row. See pathname()'s multi-subdomain caveat.
 *
 * @param {object[]} rows
 * @returns {Map<string, object>}
 */
export function rowsByPathname(rows) {
  const m = new Map();
  for (const row of rows) {
    const p = pathname(row.url);
    if (p && !m.has(p)) m.set(p, row);
  }
  return m;
}

/**
 * The set of hosts the crawl treats as "this site", for host-aware resolution of
 * canonical / hreflang TARGETS (which are matched by pathname via rowsByPathname).
 * Contains:
 *   • every crawled row's own host — in a production audit the crawl host IS the
 *     canonical host, so this alone resolves same-site targets; and
 *   • any host used in a SELF-referential canonical (canonical pathname === the row's
 *     own pathname). This lets a site declare its production host (e.g. demo.example)
 *     even when crawled under a different host (e.g. 127.0.0.1) WITHOUT admitting
 *     genuinely foreign hosts.
 *
 * A canonical/hreflang target whose host is NOT in this set is truly cross-host and
 * cannot be verified against a crawled row — even if its pathname happens to collide
 * with an unrelated broken internal path. Gating target resolution on this set is what
 * keeps a foreign target (e.g. a syndication canonical to an external publisher) from
 * being mis-resolved to a colliding internal row.
 *
 * @param {object[]} rows
 * @returns {Set<string>}
 */
export function siteHosts(rows) {
  const hosts = new Set();
  for (const row of rows) {
    let ownPath = null;
    try { const u = new URL(row.url); hosts.add(u.host); ownPath = u.pathname; } catch { /* unparseable row url → skip */ }
    if (ownPath !== null && row.canonical) {
      try {
        const c = new URL(row.canonical, row.url);
        if (c.pathname === ownPath) hosts.add(c.host);
      } catch { /* unparseable canonical → skip */ }
    }
  }
  return hosts;
}

/**
 * Index crawled rows by normalized URL (the link-graph key-space; first wins).
 * Used to resolve internal <a href> TARGETS (already normalized in parse.mjs) to
 * their crawled row, consistent with buildLinkGraph's normalization.
 *
 * @param {object[]} rows
 * @returns {Map<string, object>}
 */
export function rowsByNorm(rows) {
  const m = new Map();
  for (const row of rows) {
    const k = normalizeUrl(row.url);
    if (!m.has(k)) m.set(k, row);
  }
  return m;
}
