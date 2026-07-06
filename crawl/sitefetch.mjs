/**
 * crawl/sitefetch.mjs — Site-level signal collector.
 *
 * fetchSiteSignals(origin, fetchImpl) fetches robots.txt, llms.txt, and
 * sitemap.xml and returns structured data used by crawl.mjs and C2.
 *
 * AI-bot categories come from config/ai-bots.json (add entries there, not here).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { politeFetch } from './fetch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {Array<{agent: string, operator: string, kategorie: string}>} */
const AI_BOTS = JSON.parse(
  readFileSync(path.resolve(__dirname, '../config/ai-bots.json'), 'utf8'),
);

// Lookup: lowercase agent name → full entry
const BOT_MAP = new Map(AI_BOTS.map(b => [b.agent.toLowerCase(), b]));

// ── robots.txt parser ─────────────────────────────────────────────────────────

/**
 * @param {string} raw
 * @returns {{
 *   disallow: string[],
 *   allow: string[],
 *   aiBots: Array<{agent:string, disallowAll:boolean, disallowPaths:string[], kategorie:string, operator:string}>,
 *   sitemapRefs: string[],
 *   crawlDelay: number|undefined
 * }}
 */
export function parseRobots(raw, productToken = 'seo-audit-agent') {
  // Per-agent groups: lowercased agent token → { disallow, allow }. RFC 9309
  // §2.2.1: enforce the most-specific group whose user-agent value is a
  // case-insensitive prefix of our product token; fall back to `*`.
  const groups = new Map();
  const groupFor = (agentLower) => {
    let g = groups.get(agentLower);
    if (!g) { g = { disallow: [], allow: [] }; groups.set(agentLower, g); }
    return g;
  };
  const aiBots = [];
  const sitemapRefs = [];
  /** @type {number|undefined} */
  let crawlDelay; // undefined if no Crawl-delay directive for user-agent: *

  const lines = raw.split(/\r?\n/);
  let currentAgents = [];
  let inDirectives = false;

  for (const line of lines) {
    // Strip inline comments (robots.txt allows # at any position)
    const trimmed = line.split('#')[0].trim();

    if (!trimmed) {
      // Blank line ends the current group
      currentAgents = [];
      inDirectives = false;
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const val = trimmed.slice(colonIdx + 1).trim();

    switch (key) {
      case 'user-agent':
        if (inDirectives) {
          // New group starts — reset agents
          currentAgents = [];
          inDirectives = false;
        }
        currentAgents.push(val);
        break;

      case 'disallow':
        inDirectives = true;
        for (const agent of currentAgents) {
          if (val) groupFor(agent.toLowerCase()).disallow.push(val);
          // AI-bot categorization (report-only; independent of enforcement).
          if (agent !== '*') {
            const botDef = BOT_MAP.get(agent.toLowerCase());
            if (botDef) {
              let entry = aiBots.find(b => b.agent === agent);
              if (!entry) {
                entry = { agent, disallowAll: false, disallowPaths: [], kategorie: botDef.kategorie, operator: botDef.operator };
                aiBots.push(entry);
              }
              if (val === '/') entry.disallowAll = true;
              if (val) entry.disallowPaths.push(val);
            }
          }
        }
        break;

      case 'allow':
        inDirectives = true;
        for (const agent of currentAgents) {
          if (val) groupFor(agent.toLowerCase()).allow.push(val);
        }
        break;

      case 'crawl-delay':
        inDirectives = true;
        // Only honour Crawl-delay for the wildcard agent group.
        // First valid numeric value wins (some sites repeat it).
        for (const agent of currentAgents) {
          if (agent === '*' && crawlDelay === undefined) {
            const n = parseFloat(val);
            if (Number.isFinite(n) && n > 0) crawlDelay = n;
          }
        }
        break;

      case 'sitemap':
        if (val) sitemapRefs.push(val);
        break;

      default:
        break;
    }
  }

  // Select the effective group for our product token (most-specific prefix match,
  // else the wildcard group). RFC 9309: a robots user-agent value matches when it
  // is a case-insensitive prefix of the crawler's product token.
  const pt = productToken.toLowerCase();
  let bestToken = null;
  for (const token of groups.keys()) {
    if (token === '*') continue;
    if (pt.startsWith(token) && (bestToken === null || token.length > bestToken.length)) {
      bestToken = token;
    }
  }
  const eff = groups.get(bestToken ?? '*') ?? { disallow: [], allow: [] };

  return { disallow: eff.disallow, allow: eff.allow, aiBots, sitemapRefs, crawlDelay };
}

// ── llms.txt validator ────────────────────────────────────────────────────────

/**
 * Validate llms.txt structure per https://llmstxt.org spec:
 *   - must start with `# ` (H1 heading)
 *   - must contain at least one `> ` (blockquote summary)
 *
 * @param {string} raw
 * @returns {{ exists: true, valid: boolean, problems: string[], raw: string }}
 */
function validateLlms(raw) {
  const problems = [];
  const lines = raw.split(/\r?\n/);

  const firstNonEmpty = lines.find(l => l.trim() !== '');
  if (!firstNonEmpty?.startsWith('# ')) {
    problems.push('missing-h1: first non-empty line must start with "# " (H1 heading)');
  }

  if (!lines.some(l => l.startsWith('> '))) {
    problems.push('missing-blockquote: no "> " summary line found');
  }

  return { exists: true, valid: problems.length === 0, problems, raw };
}

// ── sitemap parser ────────────────────────────────────────────────────────────

/** Maximum child sitemaps to fetch from a sitemapindex. */
const MAX_SITEMAPS = 50;

/**
 * sitemaps.org hard limit: a single sitemap file may contain at most 50,000
 * <loc> entries. parseSitemap truncates anything beyond this in DOCUMENT ORDER
 * (the first 50,000 non-empty locs are kept) so a pathological/oversized file
 * cannot blow up memory.
 */
export const MAX_LOCS_PER_FILE = 50_000;

/**
 * Total-ingestion residency cap across an entire sitemapindex expansion. Bounds
 * the unioned <loc> set so a malicious index (≤50 children × ≤50k each ⇒ 2.5M
 * theoretical) cannot exhaust memory. Equal to one full spec-compliant file and
 * far above any realistic audit need. expandSitemap truncates in index/document
 * order once the union reaches this size.
 */
export const MAX_TOTAL_LOCS = 50_000;

/**
 * Extract all <loc> text values from a sitemap XML string (low-level helper).
 * Works for both <urlset> and <sitemapindex> elements — returns whatever <loc>
 * elements are present without interpreting the document type.
 *
 * Enforces the sitemaps.org per-file 50,000-loc limit (MAX_LOCS_PER_FILE):
 * collection stops, in document order, once that many non-empty locs are kept.
 *
 * @param {string} xml
 * @returns {string[]}
 */
export function parseSitemap(xml) {
  const urls = [];
  for (const match of xml.matchAll(/<loc[^>]*>\s*([^<]+)\s*<\/loc>/g)) {
    if (urls.length >= MAX_LOCS_PER_FILE) break;   // per-file residency cap
    const url = match[1].trim();
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * Expand a sitemap XML, fetching one level of sitemapindex children inline.
 *
 * - If the root element is <urlset>: returns the content <loc> URLs and one
 *   file entry { url: sitemapUrl, locCount }.
 * - If the root element is <sitemapindex>: fetches each same-host child sitemap
 *   (up to MAX_SITEMAPS), deduplicates child URLs, and unions all <urlset> locs.
 *   Child sitemaps that are themselves sitemapindexes are skipped (childIsIndex
 *   guard below) — sitemaps.org forbids nested indexes.
 *
 * Expansion is inline (one level only, no recursion). Union ordering is
 * deterministic: child sitemaps are processed in index order; locs within each
 * child maintain document order. Deduplication uses a Set that preserves
 * insertion order.
 *
 * @param {string} xml        — XML body of the root sitemap
 * @param {string} sitemapUrl — absolute URL from which xml was fetched
 * @param {typeof politeFetch} fetchImpl
 * @returns {Promise<{ urls: string[], files: Array<{url: string, locCount: number}> }>}
 */
export async function expandSitemap(xml, sitemapUrl, fetchImpl) {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);

  if (!isIndex) {
    // Plain urlset — return its locs and one file record.
    const locs = parseSitemap(xml);
    return {
      urls:  locs,
      files: [{ url: sitemapUrl, locCount: locs.length }],
    };
  }

  // Sitemapindex: extract child sitemap <loc> values.
  let rootHost;
  try {
    rootHost = new URL(sitemapUrl).host;
  } catch {
    return { urls: [], files: [] };
  }

  const rawChildren = parseSitemap(xml);

  // Dedupe child URLs, skip self-references, enforce same-host, cap at MAX_SITEMAPS.
  const seen = new Set();
  const children = [];
  for (const child of rawChildren) {
    if (child === sitemapUrl) continue;
    if (seen.has(child)) continue;
    let childHost;
    try { childHost = new URL(child).host; } catch { continue; }
    if (childHost !== rootHost) continue;
    seen.add(child);
    children.push(child);
    if (children.length >= MAX_SITEMAPS) break;
  }

  // Fetch each child and union their locs.
  const allUrls = [];
  const allFiles = [];
  const urlDedup = new Set();

  for (const childUrl of children) {
    // Total-ingestion residency cap: stop fetching further children once the
    // unioned loc set is full (truncation in deterministic index order).
    if (allUrls.length >= MAX_TOTAL_LOCS) break;

    const res = await fetchImpl(childUrl);
    if (res.status !== 200 || res.body == null) continue;

    // Per spec, children of a sitemapindex must be urlsets (not nested indexes).
    // If a child is itself a sitemapindex, skip it (depth would exceed limit).
    const childIsIndex = /<sitemapindex[\s>]/i.test(res.body);
    if (childIsIndex) continue;

    const locs = parseSitemap(res.body);
    allFiles.push({ url: childUrl, locCount: locs.length });
    for (const loc of locs) {
      if (allUrls.length >= MAX_TOTAL_LOCS) break;   // total residency cap
      if (!urlDedup.has(loc)) {
        urlDedup.add(loc);
        allUrls.push(loc);
      }
    }
  }

  return { urls: allUrls, files: allFiles };
}

// ── http-scheme probe ─────────────────────────────────────────────────────────

/**
 * Probe whether the http:// version of an origin redirects to https://.
 * @param {string} origin  the crawl origin (any scheme; the host is reused over http)
 * @param {(url:string)=>Promise<{status:number, finalUrl:string}>} fetchImpl  injected fetcher (politeFetch closure)
 * @returns {Promise<{reachable:boolean, redirectsToHttps:boolean, status:number}>}
 */
export async function probeHttpScheme(origin, fetchImpl) {
  let host;
  try { host = new URL(origin).host; } catch { return { reachable: false, redirectsToHttps: false, status: 0 }; }
  let res;
  try { res = await fetchImpl(`http://${host}/`); }
  catch { return { reachable: false, redirectsToHttps: false, status: 0 }; }
  const status   = res?.status ?? 0;
  const finalUrl = typeof res?.finalUrl === 'string' ? res.finalUrl : '';
  const reachable = status >= 200 && status < 400;
  // politeFetch follows redirects: if http redirected to https, finalUrl is the https URL.
  const redirectsToHttps = finalUrl.startsWith('https://');
  return { reachable, redirectsToHttps, status };
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * @param {string} origin  — scheme + host (+ port), no trailing slash
 * @param {typeof politeFetch} [fetchImpl]
 * @returns {Promise<{
 *   robots: {
 *     exists: boolean, raw: string, disallow: string[], allow: string[],
 *     aiBots: Array<{agent:string, disallowAll:boolean, disallowPaths:string[], kategorie:string, operator:string}>,
 *     sitemapRefs: string[]
 *   },
 *   llms: { exists: boolean, valid: boolean, problems: string[], raw: string },
 *   sitemapUrls: string[],
 *   sitemapFiles: Array<{url: string, locCount: number}>
 * }>}
 */
export async function fetchSiteSignals(origin, fetchImpl = politeFetch) {
  const base = origin.replace(/\/$/, '');

  // ── robots.txt ─────────────────────────────────────────────────────────────

  const robotsResult = await fetchImpl(`${base}/robots.txt`);
  let robots = { exists: false, raw: '', disallow: [], allow: [], aiBots: [], sitemapRefs: [], crawlDelay: undefined };

  if (robotsResult.status === 200 && robotsResult.body != null) {
    const parsed = parseRobots(robotsResult.body);
    robots = { exists: true, raw: robotsResult.body, ...parsed };
  } else if (robotsResult.status >= 500 || robotsResult.status === 0) {
    // RFC 9309 §2.3.1.4: robots.txt unreachable (5xx / network failure) → assume complete disallow.
    robots = { exists: false, raw: '', disallow: ['/'], allow: [], aiBots: [], sitemapRefs: [], crawlDelay: undefined };
  }

  // ── llms.txt ───────────────────────────────────────────────────────────────

  const llmsResult = await fetchImpl(`${base}/llms.txt`);
  let llms = { exists: false, valid: false, problems: [], raw: '' };

  if (llmsResult.status === 200 && llmsResult.body != null) {
    llms = validateLlms(llmsResult.body);
  }

  // ── sitemap.xml ────────────────────────────────────────────────────────────

  // Try ${origin}/sitemap.xml first (canonical location), then fall back to
  // any Sitemap: directives found in robots.txt.
  let sitemapUrls = [];
  let sitemapFiles = [];

  const sitemapCandidates = [
    `${base}/sitemap.xml`,
    ...robots.sitemapRefs,
  ];

  for (const candidate of sitemapCandidates) {
    const res = await fetchImpl(candidate);
    if (res.status === 200 && res.body != null) {
      const { urls, files } = await expandSitemap(res.body, candidate, fetchImpl);
      if (urls.length > 0) {
        sitemapUrls = urls;
        sitemapFiles = files;
        break;
      }
    }
  }

  return { robots, llms, sitemapUrls, sitemapFiles };
}
