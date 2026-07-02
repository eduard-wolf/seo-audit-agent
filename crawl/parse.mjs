/**
 * crawl/parse.mjs — Head-parser and body-signal extractor (Unit C2).
 *
 * parsePage(html, url) → fields
 *
 * Regex/string-based only — no DOM library, no npm dependencies.
 * HTML entities in text fields are decoded so downstream consumers
 * (Unit G renderer) receive the raw strings they must escape.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUrl } from './linkgraph.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Additional authoritative domains beyond .gov / .edu / wikipedia.org */
const AUTHORITATIVE_DOMAINS = JSON.parse(
  readFileSync(path.resolve(__dirname, '../config/authoritative-domains.json'), 'utf8'),
);

// ── Generic / empty anchor detection ────────────────────────────────────────────

// Generic, non-descriptive link texts (WCAG F84 anti-pattern; DE + EN). Lowercased exact match.
const GENERIC_ANCHOR_TEXTS = new Set([
  'hier', 'hier klicken', 'klicken sie hier', 'klick hier', 'mehr', 'mehr erfahren',
  'mehr lesen', 'mehr dazu', 'weiterlesen', 'weiter', 'link',
  'click here', 'click', 'here', 'read more', 'more', 'learn more', 'this link',
]);

// ── Entity decoder ──────────────────────────────────────────────────────────────

/**
 * Decode HTML entities in a string (minimal set for text fields).
 * Decodes &amp; last to avoid double-decode of e.g. &amp;lt;.
 *
 * @param {string} str
 * @returns {string}
 */
function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, ' ')   // non-breaking space — so trim() and \s collapse it
    .replace(/&amp;/g, '&');
}

// ── Meta / link attribute helpers ───────────────────────────────────────────────

/**
 * Build a Map of <meta> name/property → content in a SINGLE pass over the HTML.
 *
 * The key is the lowercased `name` attribute, or the `property` attribute when
 * `name` is absent. Matching both is required because Open Graph / article:*
 * meta tags (e.g. `article:published_time`) use `property=`, not `name=`.
 * First occurrence wins — preserving the original getMetaContent semantics where
 * the first matching <meta> was returned. Content is '' when the matched tag has
 * no `content=` attribute (distinct from an absent key, which lookups map to null).
 *
 * Replaces the previous per-call full-document matchAll (getMetaContent ran ~9x
 * per page); callers now read this prebuilt Map.
 *
 * @param {string} html
 * @returns {Map<string,string>}
 */
function buildMetaMap(html) {
  const map = new Map();
  for (const [, attrs] of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const nameM =
      attrs.match(/\bname=["']([^"']*)["']/i) ??
      attrs.match(/\bproperty=["']([^"']*)["']/i);
    if (!nameM) continue;
    const key = nameM[1].toLowerCase();
    if (map.has(key)) continue;          // first occurrence wins
    const contentM = attrs.match(/\bcontent=["']([^"']*)["']/i);
    map.set(key, contentM ? contentM[1] : '');
  }
  return map;
}

/**
 * Look up a meta value by name/property (case-insensitive) in a prebuilt metaMap.
 * Returns the content string, or null when the key is absent.
 *
 * @param {Map<string,string>} metaMap
 * @param {string} name
 * @returns {string|null}
 */
function getMetaContent(metaMap, name) {
  const lc = name.toLowerCase();
  return metaMap.has(lc) ? metaMap.get(lc) : null;
}

/**
 * Return the href of the first <link rel="canonical"> tag, or empty string.
 * Reads a prebuilt list of <link> attribute matches (single document scan).
 *
 * @param {Array<RegExpMatchArray>} linkMatches
 * @returns {string}
 */
function getCanonical(linkMatches) {
  for (const [, attrs] of linkMatches) {
    const relM = attrs.match(/\brel=["']([^"']*)["']/i);
    if (relM && relM[1].toLowerCase() === 'canonical') {
      const hrefM = attrs.match(/\bhref=["']([^"']*)["']/i);
      return hrefM ? hrefM[1] : '';
    }
  }
  return '';
}

// ── Authoritative domain check ──────────────────────────────────────────────────

/**
 * Return true if the hostname is considered authoritative:
 *   - TLD is .gov or .edu
 *   - Is wikipedia.org or a subdomain thereof
 *   - Listed in config/authoritative-domains.json
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isAuthoritative(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  if (h.endsWith('.gov') || h === 'gov') return true;
  if (h.endsWith('.edu') || h === 'edu') return true;
  if (h === 'wikipedia.org' || h.endsWith('.wikipedia.org')) return true;
  return AUTHORITATIVE_DOMAINS.some(d => h === d || h.endsWith('.' + d));
}

// ── JSON-LD helpers ─────────────────────────────────────────────────────────────

/**
 * Recursively collect @type string values from a parsed JSON-LD object.
 * Traverses @graph and all nested object/array values.
 *
 * @param {unknown} obj
 * @returns {string[]}
 */
function extractLdTypes(obj) {
  if (!obj || typeof obj !== 'object') return [];
  // Array-root JSON-LD: iterate items and collect types from each
  if (Array.isArray(obj)) {
    const types = [];
    for (const item of obj) types.push(...extractLdTypes(item));
    return types;
  }
  const types = [];

  const t = obj['@type'];
  if (t) {
    if (Array.isArray(t)) types.push(...t.map(String));
    else types.push(String(t));
  }

  // @graph is an array of top-level nodes
  if (Array.isArray(obj['@graph'])) {
    for (const item of obj['@graph']) {
      types.push(...extractLdTypes(item));
    }
  }

  // Recurse into all non-@ properties
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('@')) continue;
    if (val && typeof val === 'object') {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object') types.push(...extractLdTypes(item));
        }
      } else {
        types.push(...extractLdTypes(val));
      }
    }
  }
  return types;
}

/**
 * Return true if any Organization node in a parsed LD object (or array)
 * has a non-null `sameAs` property. Recurses into @graph and all nested objects.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
function orgHasSameAs(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some(orgHasSameAs);
  const type = obj['@type'];
  const types = Array.isArray(type) ? type.map(String) : type ? [String(type)] : [];
  if (types.includes('Organization') && obj.sameAs != null) return true;
  if (Array.isArray(obj['@graph']) && obj['@graph'].some(orgHasSameAs)) return true;
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('@')) continue;
    if (val && typeof val === 'object' && orgHasSameAs(val)) return true;
  }
  return false;
}

/**
 * Walk a parsed LD object (or array) and return the first Offer node found.
 *
 * @param {unknown} obj
 * @returns {object|null}
 */
function findOffer(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findOffer(item);
      if (r) return r;
    }
    return null;
  }
  if (obj['@type'] === 'Offer') return obj;
  if (obj.offers) {
    const o = Array.isArray(obj.offers) ? obj.offers : [obj.offers];
    for (const item of o) {
      if (item && item['@type'] === 'Offer') return item;
    }
  }
  // Recurse into @graph nodes (covers Yoast/WordPress @graph payloads)
  if (Array.isArray(obj['@graph'])) {
    for (const item of obj['@graph']) {
      const r = findOffer(item);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Walk a parsed LD object (or array) and return the first AggregateRating node found,
 * either as a standalone top-level node or via the `aggregateRating` property.
 *
 * @param {unknown} obj
 * @returns {object|null}
 */
function findAggregateRating(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) { const r = findAggregateRating(item); if (r) return r; }
    return null;
  }
  const t = obj['@type'];
  const types = Array.isArray(t) ? t.map(String) : (t ? [String(t)] : []);
  if (types.includes('AggregateRating')) return obj;
  if (obj.aggregateRating && typeof obj.aggregateRating === 'object') {
    const ar = Array.isArray(obj.aggregateRating) ? obj.aggregateRating[0] : obj.aggregateRating;
    if (ar && (ar['@type'] === 'AggregateRating' || ar.ratingValue != null)) return ar;
  }
  if (Array.isArray(obj['@graph'])) {
    for (const item of obj['@graph']) { const r = findAggregateRating(item); if (r) return r; }
  }
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('@')) continue;
    if (key === 'aggregateRating') continue;   // already handled by the fast-path above
    if (val && typeof val === 'object') { const r = findAggregateRating(val); if (r) return r; }
  }
  return null;
}

/**
 * Return true if any Organization node in a parsed LD object (or array)
 * carries a non-null value for the given `prop`. Recurses into @graph and all nested objects.
 * Generalizes the existing orgHasSameAs helper without modifying it.
 *
 * @param {unknown} obj
 * @param {string}  prop
 * @returns {boolean}
 */
function orgHasProperty(obj, prop) {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some(o => orgHasProperty(o, prop));
  const type  = obj['@type'];
  const types = Array.isArray(type) ? type.map(String) : type ? [String(type)] : [];
  if (types.includes('Organization') && obj[prop] != null) return true;
  if (Array.isArray(obj['@graph']) && obj['@graph'].some(o => orgHasProperty(o, prop))) return true;
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('@')) continue;
    if (val && typeof val === 'object' && orgHasProperty(val, prop)) return true;
  }
  return false;
}

/**
 * Extract a date field (datePublished / dateModified) from a parsed LD object,
 * recursing into @graph so Yoast/WordPress @graph payloads are handled correctly.
 *
 * @param {unknown} obj    — parsed JSON-LD object or array
 * @param {string}  field  — 'datePublished' or 'dateModified'
 * @returns {string}
 */
function extractLdDate(obj, field) {
  if (!obj || typeof obj !== 'object') return '';
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const v = extractLdDate(item, field);
      if (v) return v;
    }
    return '';
  }
  if (obj[field]) return String(obj[field]);
  if (Array.isArray(obj['@graph'])) {
    for (const item of obj['@graph']) {
      const v = extractLdDate(item, field);
      if (v) return v;
    }
  }
  return '';
}

// ── Text / word-count helpers ───────────────────────────────────────────────────

/** Count whitespace-separated tokens in a string. */
function countWords(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Produce visible text from comment-stripped body HTML:
 * strips <script>/<style> blocks (with content) → strips tags.
 * The caller passes a body that has ALREADY had HTML comments removed (computed
 * once in parsePage and shared with rawBodyText / the DOM-node scan).
 *
 * @param {string} bodyNoComments
 * @returns {string}
 */
function visibleText(bodyNoComments) {
  return bodyNoComments
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Produce raw body text from comment-stripped body HTML (keeps script/style text,
 * strips only tags). The caller passes a body with comments already removed.
 *
 * @param {string} bodyNoComments
 * @returns {string}
 */
function rawBodyText(bodyNoComments) {
  return bodyNoComments
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Null-result helper ──────────────────────────────────────────────────────────

function emptyResult() {
  return {
    title: '', titleLen: 0, metaDesc: '', metaDescLen: 0, metaMissing: 1,
    canonical: '', canonSelf: 0, robotsMeta: '', htmlLang: '',
    hreflangCount: 0, hreflang: '', hreflangLinks: '',
    h1: '', h1Count: 0, headingOutline: '',
    ldTypes: '', ldValid: 1, ldContextOk: '',
    hasProduct: 0, hasAgg: 0, hasBreadcrumb: 0, hasOrg: 0, hasOrgSameAs: 0, hasFAQ: 0, hasAuthor: 0,
    hasMicrodata: 0, hasRdfa: 0, resourcePaths: '',
    datePublished: '', dateModified: '', offerPrice: '', availability: '',
    imgTotal: 0, imgNoAlt: 0, imgJpg: 0, imgWebp: 0, imgAvif: 0,
    outlinksInternal: 0, outlinksAuthoritative: 0,
    wordCount: 0, rawWordCount: 0,
    mixedContent: 0,
    viewportContent: '',
    charsetOk: '0',
    ogTitle: '', ogImage: '', ogUrl: '',
    hasFavicon: 0,
    canonicalCount: 0,
    imgNoDimensions: 0,
    firstImgLazy: 0,
    domNodeCount: 0,
    headBlockingScripts: 0,
    headBlockingStyles: 0,
    genericAnchorCount: 0,
    emptyLinkCount: 0,
    unlabeledControlCount: 0,
    aggRatingValue: '', aggRatingCount: '',
    hasShippingDetails: 0, hasReturnPolicy: 0,
    hasOrgLogo: 0, hasOrgContactPoint: 0,
    internalLinks: [],
    isEmpty: true,
  };
}

// ── Main export ─────────────────────────────────────────────────────────────────

/**
 * Parse HTML signals from a fetched page.
 *
 * Returns all COLS fields that C2 is responsible for, plus:
 *   - `internalLinks`  {string[]} deduplicated absolute same-origin URLs (for link-graph)
 *   - `isEmpty`        {boolean}  true when rawWordCount < 10 (JS-shell guard)
 *
 * @param {string|null} html  Raw HTML of the page (null → empty result)
 * @param {string}      url   Final URL (after redirects) — used for relative link resolution
 * @returns {object}
 */
export function parsePage(html, url) {
  if (!html || typeof html !== 'string') return emptyResult();

  // ── Body extraction ──────────────────────────────────────────────────────────
  const bodyM = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyM ? bodyM[1] : html;

  // ── Comment-stripped body (computed ONCE, reused) ──────────────────────────
  // visibleText, rawBodyText and the DOM-node scan all begin by removing HTML
  // comments from the body. Strip once and share so the comment regex runs a
  // single time over the body instead of three times (byte-identical result).
  const bodyNoComments = bodyHtml.replace(/<!--[\s\S]*?-->/g, ' ');

  // ── Comment-stripped HTML for head scans ──────────────────────────────────
  // Strip HTML comments once so that commented-out head elements (canonical,
  // JSON-LD blocks, meta tags) are not accidentally parsed as live markup.
  // The body extraction and word-count paths are unaffected — they already
  // strip comments via bodyNoComments above.
  const strippedHtml = html.replace(/<!--[\s\S]*?-->/g, ' ');

  // ── Single-pass meta + link extraction (read by helpers/loops below) ───────
  // getMetaContent ran a full-document <meta> matchAll ~9x/page and the full
  // <link> matchAll ran ~4x. Build each structure ONCE over strippedHtml and
  // have the canonical/hreflang/favicon/canonicalCount/meta lookups read these.
  const metaMap     = buildMetaMap(strippedHtml);
  const linkMatches = [...strippedHtml.matchAll(/<link\b([^>]*)>/gi)];

  // ── Title ────────────────────────────────────────────────────────────────────
  const titleM = strippedHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeEntities(titleM[1].trim()) : '';
  const titleLen = title.length;

  // ── Meta description ─────────────────────────────────────────────────────────
  const rawDesc = getMetaContent(metaMap, 'description');
  const metaDesc = rawDesc !== null ? decodeEntities(rawDesc) : '';
  const metaDescLen = metaDesc.length;
  const metaMissing = rawDesc === null ? 1 : 0;

  // ── Canonical ────────────────────────────────────────────────────────────────
  const canonical = getCanonical(linkMatches);
  let canonSelf = 0;
  if (canonical && url) {
    try {
      // Resolve canonical against the page URL so relative hrefs (e.g. "/p")
      // are handled correctly. Google officially supports relative canonicals.
      // Compare on origin + pathname only (IGNORE the query string), after the
      // existing trailing-slash strip so /page/ and /page are equivalent.
      // A page at /p?utm=x whose rel=canonical is /p IS self-canonical — tracking
      // params (utm/gclid/fbclid …) must not produce a false tech:canonical-nonself.
      // Cross-host or different-path canonicals still differ (origin/pathname change)
      // and remain correctly non-self.
      const cu = new URL(canonical, url);
      const pu = new URL(url);
      const normC = (cu.origin + cu.pathname).replace(/\/$/, '');
      const normU = (pu.origin + pu.pathname).replace(/\/$/, '');
      canonSelf = normC === normU ? 1 : 0;
    } catch {
      canonSelf = canonical === url ? 1 : 0;
    }
  }

  // ── Robots meta ──────────────────────────────────────────────────────────────
  const robotsMeta = getMetaContent(metaMap, 'robots') ?? '';

  // ── HTML lang ────────────────────────────────────────────────────────────────
  const langM = strippedHtml.match(/<html\b[^>]*\blang=["']([^"']*)["']/i);
  const htmlLang = langM ? langM[1] : '';

  // ── Hreflang ─────────────────────────────────────────────────────────────────
  const hreflangValues = [];
  const hreflangLinkPairs = []; // {lang, href} for cross-page reciprocity check
  for (const [, attrs] of linkMatches) {
    const relM = attrs.match(/\brel=["']alternate["']/i);
    if (!relM) continue;
    const hlM = attrs.match(/\bhreflang=["']([^"']*)["']/i);
    if (!hlM) continue;
    hreflangValues.push(hlM[1]);
    const hrefM = attrs.match(/\bhref=["']([^"']*)["']/i);
    hreflangLinkPairs.push({ lang: hlM[1], href: hrefM ? decodeEntities(hrefM[1]) : '' });
  }
  const hreflangCount = hreflangValues.length;
  const hreflang = hreflangValues.join(',');
  const hreflangLinks = hreflangLinkPairs.map(p => `${p.lang}=${p.href}`).join('|');

  // ── Headings ─────────────────────────────────────────────────────────────────
  const headingLevels = [];
  for (const [, lv] of bodyHtml.matchAll(/<(h[1-6])\b[^>]*>/gi)) {
    headingLevels.push(lv.toLowerCase());
  }
  const headingOutline = headingLevels.join(',');

  const h1Matches = [...bodyHtml.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
  const h1Count = h1Matches.length;
  const h1 = h1Count > 0
    ? decodeEntities(h1Matches[0][1].replace(/<[^>]+>/g, '').trim())
    : '';

  // ── JSON-LD ───────────────────────────────────────────────────────────────────
  const ldBlockPat = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldValid = 1;
  const ldParsed = [];
  const ldTypesSet = new Set();
  // @context validity: track parseable blocks and whether any parseable JSON-LD object
  // is missing a schema.org @context. Google requires @context to reference schema.org for
  // the structured data to be eligible; a wrong/absent @context silently voids it.
  let ldBlockCount = 0;
  let ldContextBad = false;

  for (const [, content] of strippedHtml.matchAll(ldBlockPat)) {
    // Strip CDATA and surrounding JS-comment wrappers before parsing.
    // Legitimate CMS patterns: //<![CDATA[ … //]]>  and  /*<![CDATA[*/ … /*]]>*/
    // Only run each strip when its marker is actually present (plain JSON-LD skips both),
    // and de-ambiguate the whitespace so the regexes stay LINEAR: the earlier
    // `\s*(?:comment)?\s*` form had two \s* around an optional token → O(n²) catastrophic
    // backtracking on a whitespace-padded block (a single crafted page could stall the
    // synchronous parser for minutes). The trailing whitespace is handled by .trim() below,
    // so the closing strip no longer needs a leading \s*.
    let ldContent = content;
    if (ldContent.includes('<![CDATA[')) {
      ldContent = ldContent.replace(/^\s*(?:(?:\/\/|\/\*)\s*)?<!\[CDATA\[(?:\*\/)?\s*/i, '');
    }
    if (ldContent.includes(']]>')) {
      ldContent = ldContent.replace(/(?:(?:\/\/|\/\*)\s*)?\]\]>\s*(?:\*\/|\/\/)?\s*$/i, '');
    }
    ldContent = ldContent.trim();
    try {
      const obj = JSON.parse(ldContent);
      ldParsed.push(obj);
      ldBlockCount++;
      // A block may be a single object OR a top-level array of objects; each top-level
      // object must carry a schema.org @context (a @graph wrapper carries one @context).
      for (const o of (Array.isArray(obj) ? obj : [obj])) {
        const ctx = o && typeof o === 'object' ? o['@context'] : undefined;
        if (ctx == null || !/schema\.org/i.test(JSON.stringify(ctx))) ldContextBad = true;
      }
      for (const t of extractLdTypes(obj)) ldTypesSet.add(t);
    } catch {
      ldValid = 0;
      // Best-effort: extract @type values via regex from the unparseable block
      for (const [, t] of ldContent.matchAll(/"@type"\s*:\s*"([^"]+)"/g)) {
        ldTypesSet.add(t);
      }
      ldParsed.push(null);
    }
  }

  const ldTypes = [...ldTypesSet].join(',');
  // '' when there is no parseable JSON-LD (rule not applicable), 1 when every parseable block
  // has a schema.org @context, 0 when a parseable block is missing/has a wrong @context.
  const ldContextOk = ldBlockCount === 0 ? '' : (ldContextBad ? 0 : 1);
  const hasProduct    = ldTypesSet.has('Product')          ? 1 : 0;
  const hasAgg        = ldTypesSet.has('AggregateRating')  ? 1 : 0;
  const hasBreadcrumb = ldTypesSet.has('BreadcrumbList')   ? 1 : 0;
  const hasOrg        = ldTypesSet.has('Organization')     ? 1 : 0;
  // hasOrgSameAs: 1 when any Organization node (anywhere in LD) carries sameAs.
  // Used by schema:org-missing-same-as to detect entity-disambiguation gaps.
  const hasOrgSameAs  = ldParsed.filter(Boolean).some(orgHasSameAs) ? 1 : 0;
  const hasFAQ        = ldTypesSet.has('FAQPage')          ? 1 : 0;
  const hasAuthor     = (ldTypesSet.has('Author') || ldTypesSet.has('Person')) ? 1 : 0;

  // ── Microdata / RDFa structured-data presence (NON-JSON-LD) ──────────────────
  // The JSON-LD scan above only sees <script type="application/ld+json"> blocks.
  // A site marked up entirely in Microdata or RDFa yields an empty ldTypes/hasOrg,
  // which would make the schema:* ABSENCE detectors misfire. Detect the two other
  // formats Google officially supports (Search Central — Structured data intro:
  // JSON-LD, Microdata AND RDFa are all supported) so those detectors can gate.
  // Regex over the as-served, comment-stripped HTML (deterministic).
  //   hasMicrodata — an `itemscope` AND an `itemtype` whose value contains schema.org.
  //   hasRdfa      — a `typeof=` or `vocab=` attribute (RDFa Lite core vocabulary hooks).
  const hasMicrodata = (/(?<![-\w])itemscope\b/i.test(strippedHtml)
    && /(?<![-\w])itemtype\s*=\s*["'][^"']*schema\.org/i.test(strippedHtml)) ? 1 : 0;
  const hasRdfa = /(?<![-\w])(?:typeof|vocab)\s*=\s*["']/i.test(strippedHtml) ? 1 : 0;

  // ── Dates ────────────────────────────────────────────────────────────────────
  let datePublished = '';
  let dateModified  = '';
  for (const obj of ldParsed) {
    if (!obj) continue;
    if (!datePublished) {
      const v = extractLdDate(obj, 'datePublished');
      if (v) datePublished = v;
    }
    if (!dateModified) {
      const v = extractLdDate(obj, 'dateModified');
      if (v) dateModified = v;
    }
  }
  if (!datePublished) {
    const m = getMetaContent(metaMap, 'article:published_time')
           ?? getMetaContent(metaMap, 'datePublished');
    if (m) datePublished = m;
  }
  if (!dateModified) {
    const m = getMetaContent(metaMap, 'article:modified_time')
           ?? getMetaContent(metaMap, 'dateModified');
    if (m) dateModified = m;
  }

  // ── Offer price / availability ────────────────────────────────────────────────
  let offerPrice   = '';
  let availability = '';
  for (const obj of ldParsed) {
    if (!obj) continue;
    const offer = findOffer(obj);
    if (offer) {
      if (offer.price != null) offerPrice   = String(offer.price);
      if (offer.availability)  availability = String(offer.availability);
      break;
    }
  }

  // ── AggregateRating completeness ──────────────────────────────────────────────
  let aggRatingValue = '', aggRatingCount = '';
  for (const obj of ldParsed) {
    if (!obj) continue;
    const ar = findAggregateRating(obj);
    if (ar) {
      if (ar.ratingValue != null) aggRatingValue = String(ar.ratingValue);
      const cnt = ar.ratingCount ?? ar.reviewCount;          // either satisfies Google
      if (cnt != null) aggRatingCount = String(cnt);
      break;
    }
  }

  // ── Merchant shipping / returns (on the Offer) ────────────────────────────────
  let hasShippingDetails = 0, hasReturnPolicy = 0;
  for (const obj of ldParsed) {
    if (!obj) continue;
    const offer = findOffer(obj);
    if (offer) {
      if (offer.shippingDetails != null)         hasShippingDetails = 1;
      if (offer.hasMerchantReturnPolicy != null) hasReturnPolicy    = 1;
      break;
    }
  }

  // ── Organization logo / contactPoint (any Organization node) ─────────────────
  const hasOrgLogo         = ldParsed.filter(Boolean).some(o => orgHasProperty(o, 'logo'))         ? 1 : 0;
  const hasOrgContactPoint = ldParsed.filter(Boolean).some(o => orgHasProperty(o, 'contactPoint')) ? 1 : 0;

  // ── Images ───────────────────────────────────────────────────────────────────
  const imgMatches = [...bodyHtml.matchAll(/<img\b([^>]*)>/gi)];
  const imgTotal = imgMatches.length;
  let imgNoAlt = 0, imgJpg = 0, imgWebp = 0, imgAvif = 0;

  for (const [, attrs] of imgMatches) {
    const altM = attrs.match(/\balt=["']([^"']*)["']/i);
    if (!altM || altM[1].trim() === '') imgNoAlt++;

    const srcM = attrs.match(/\bsrc=["']([^"']*)["']/i);
    if (srcM) {
      const src = srcM[1].toLowerCase();
      if (/\.jpe?g(\?|#|$)/.test(src))   imgJpg++;
      else if (/\.webp(\?|#|$)/.test(src)) imgWebp++;
      else if (/\.avif(\?|#|$)/.test(src)) imgAvif++;
    }
  }

  // ── <source> and <img srcset> — modern format alternatives ──────────────────
  // web.dev / MDN best practice: <picture><source type="image/webp" srcset="…">
  // <img src="…jpg"></picture>.  The <img src> counts as imgJpg above, but the
  // <source type> is never reached by the <img> loop — scan it separately so
  // imgWebp/imgAvif reflect the presence of a modern-format source.
  // Also handles <img srcset="x.webp 800w, …"> without an explicit type attr.
  for (const [, srcAttrs] of bodyHtml.matchAll(/<source\b([^>]*)>/gi)) {
    const typeM   = srcAttrs.match(/\btype=["']([^"']*)["']/i);
    const srcsetM = srcAttrs.match(/\bsrcset=["']([^"']*)["']/i);
    if (typeM) {
      const t = typeM[1].toLowerCase();
      if (t === 'image/webp')       imgWebp++;
      else if (t === 'image/avif')  imgAvif++;
      // type is authoritative — no need to also inspect srcset
      continue;
    }
    if (srcsetM) {
      const s = srcsetM[1].toLowerCase();
      if (/\.webp(?:[?#\s,]|$)/.test(s))       imgWebp++;
      else if (/\.avif(?:[?#\s,]|$)/.test(s))  imgAvif++;
    }
  }

  // <img srcset> — responsive images without a <picture> wrapper
  for (const [, attrs] of imgMatches) {
    const srcsetM = attrs.match(/\bsrcset=["']([^"']*)["']/i);
    if (!srcsetM) continue;
    const s = srcsetM[1].toLowerCase();
    if (/\.webp(?:[?#\s,]|$)/.test(s))       imgWebp++;
    else if (/\.avif(?:[?#\s,]|$)/.test(s))  imgAvif++;
  }

  // ── Image dimensions + first-image lazy ──────────────────────────────────────
  // imgNoDimensions: count of <img> tags lacking an explicit width AND/OR height attribute.
  // Uses a negative-lookbehind boundary so data-width/data-height do NOT mask real attrs.
  // firstImgLazy: 1 iff the FIRST <img> in body order has loading="lazy".
  let imgNoDimensions = 0;
  for (const [, attrs] of imgMatches) {
    const hasWidth  = /(?<![-\w])width\s*=/i.test(attrs);
    const hasHeight = /(?<![-\w])height\s*=/i.test(attrs);
    if (!hasWidth || !hasHeight) imgNoDimensions++;
  }

  let firstImgLazy = 0;
  if (imgMatches.length > 0) {
    const firstAttrs = imgMatches[0][1];
    if (/(?<![-\w])loading\s*=\s*["']?\s*lazy/i.test(firstAttrs)) firstImgLazy = 1;
  }

  // ── DOM node count proxy (over bodyHtml) ──────────────────────────────────────
  // Strip comments + <script>/<style> blocks so tag-like text inside them is not counted,
  // then count opening element tags. This is a Lighthouse-style proxy (HTML opening tags
  // ≠ live DOM) — see rule onpage:excessive-dom for the caveat note.
  const domScan = bodyNoComments
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const domNodeCount = (domScan.match(/<[a-zA-Z][a-zA-Z0-9-]*[\s/>]/g) || []).length;

  // ── Head extraction (for render-blocking resource checks) ─────────────────────
  // Use strippedHtml (comments already removed) to avoid parsing commented-out elements.
  const headM    = strippedHtml.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const headHtml = headM ? headM[1] : '';

  // ── headScan: preserve opening tags, clear script/style bodies ───────────────
  // Inline scripts/styles can embed tag-like string literals (e.g. a script that
  // document.write('<script src="x.js">')) which would be wrongly counted as
  // blocking resources. Clearing only the BODY (preserving the opening tag) lets
  // real external scripts (<script src="a.js"></script> → <script src="a.js">)
  // remain visible and countable while preventing literal tag strings from firing.
  const headScan = headHtml
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1')
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, '$1');

  // ── Render-blocking head scripts ──────────────────────────────────────────────
  // Count <script> tags in HEAD that have a src and are NOT async/defer/module.
  // Inline scripts (no src) and ld+json blocks must NOT count.
  let headBlockingScripts = 0;
  for (const [, attrs] of headScan.matchAll(/<script\b([^>]*)>/gi)) {
    if (!/(?<![-\w])src\s*=/i.test(attrs)) continue;                       // inline / no src → skip
    if (/(?<![-\w])(?:async|defer)\b/i.test(attrs)) continue;              // async/defer → non-blocking
    if (/(?<![-\w])type\s*=\s*["']?\s*module\b/i.test(attrs)) continue;   // module → deferred by default
    headBlockingScripts++;
  }

  // ── Render-blocking head stylesheets ──────────────────────────────────────────
  // Count <link rel="stylesheet"> in HEAD, excluding media="print".
  let headBlockingStyles = 0;
  for (const [, attrs] of headScan.matchAll(/<link\b([^>]*)>/gi)) {
    const relM = attrs.match(/\brel=["']([^"']*)["']/i);
    if (!relM || relM[1].toLowerCase() !== 'stylesheet') continue;
    const mediaM = attrs.match(/\bmedia=["']([^"']*)["']/i);
    if (mediaM && mediaM[1].toLowerCase().trim() === 'print') continue;    // print → non-blocking
    headBlockingStyles++;
  }

  // ── Generic / empty anchor counting ─────────────────────────────────────────────
  // Counts anchors with generic/non-descriptive visible text (WCAG F84 anti-pattern) and
  // anchors with an empty accessible name (WCAG 2.4.4 / 4.1.2 failure).
  // Only real links (have an href attribute) are considered.
  // Links with a descriptive aria-label/title or an inner <img> with non-empty alt are not counted.
  let genericAnchorCount = 0;
  let emptyLinkCount = 0;
  for (const m of bodyHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const aAttrs = m[1], inner = m[2];
    if (!/(?<![-\w])href\s*=/i.test(aAttrs)) continue;             // only real links (have href)
    const text = decodeEntities(inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).toLowerCase();
    const hasName = /(?<![-\w])(?:aria-label|title)\s*=\s*["'][^"']*\S[^"']*["']/i.test(aAttrs);
    const innerImgAlt = /<img\b[^>]*(?<![-\w])alt\s*=\s*["'][^"']*\S[^"']*["']/i.test(inner);
    if (text === '' && !hasName && !innerImgAlt) {
      emptyLinkCount++;
    } else if (text !== '' && !hasName && GENERIC_ANCHOR_TEXTS.has(text)) {
      genericAnchorCount++;
    }
  }

  // ── Unlabeled controls (iframe + button only) ────────────────────────────────────
  // Counts <iframe> without title/aria-label and <button> with no visible text, no
  // aria-label/aria-labelledby/title, and no inner <img alt>.
  // Scope is intentionally limited to the high-precision WCAG-4.1.2 subset.
  // Generic form-field label association is DEFERRED (too false-positive-prone statically).
  let unlabeledControlCount = 0;
  for (const m of bodyHtml.matchAll(/<iframe\b([^>]*)>/gi)) {
    const attrs = m[1];
    const hasName = /(?<![-\w])(?:title|aria-label)\s*=\s*["'][^"']*\S[^"']*["']/i.test(attrs);
    if (!hasName) unlabeledControlCount++;
  }
  for (const m of bodyHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const attrs = m[1], inner = m[2];
    const text = decodeEntities(inner).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const hasName = /(?<![-\w])(?:aria-label|aria-labelledby|title)\s*=\s*["'][^"']*\S[^"']*["']/i.test(attrs);
    const innerImgAlt = /<img\b[^>]*(?<![-\w])alt\s*=\s*["'][^"']*\S[^"']*["']/i.test(inner);
    if (text === '' && !hasName && !innerImgAlt) unlabeledControlCount++;
  }

  // ── Links ─────────────────────────────────────────────────────────────────────
  let pageOrigin = '';
  try { if (url) pageOrigin = new URL(url).origin; } catch { /* ignore */ }

  let outlinksInternal      = 0;
  let outlinksAuthoritative = 0;
  const internalLinksSet = new Set();
  const internalLinks    = [];

  for (const [, attrs] of bodyHtml.matchAll(/<a\b([^>]*)>/gi)) {
    const hrefM = attrs.match(/\bhref=["']([^"']*)["']/i);
    if (!hrefM) continue;
    // HTML-decode the href before URL parsing so &amp; in attribute values
    // (e.g. /s?q=a&amp;p=2) is resolved to the actual URL /s?q=a&p=2.
    const href = decodeEntities(hrefM[1]);
    if (!href || href.startsWith('#') || /^(?:javascript|mailto|tel):/i.test(href)) continue;

    let resolved;
    try {
      resolved = new URL(href, url || 'http://localhost/');
    } catch {
      continue;
    }

    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;

    if (pageOrigin && resolved.origin === pageOrigin) {
      outlinksInternal++;
      // Apply canonical normalisation (trailing slash, /index.html, lowercase host)
      // so the link key is consistent with the page.url key used in linkgraph.mjs.
      const norm = normalizeUrl(resolved.origin + resolved.pathname + resolved.search);
      if (!internalLinksSet.has(norm)) {
        internalLinksSet.add(norm);
        internalLinks.push(norm);
      }
    } else {
      if (isAuthoritative(resolved.hostname)) outlinksAuthoritative++;
    }
  }

  // ── Same-origin render resources (script src + stylesheet href) ───────────────
  // Google cannot render JS/CSS it is not allowed to fetch (mobile-first: keep CSS
  // & JS accessible to Googlebot). Collect SAME-ORIGIN <script src> and
  // <link rel="stylesheet" href> reference paths (pathname+search) in document
  // order so tech:robots-blocked-resources can test each via the robots matcher.
  // Single combined pass over <script|link> keeps true document order; capped and
  // deduplicated for determinism + a bloat bound (pipe-joined into one CSV field).
  const RESOURCE_PATH_CAP = 20;
  const resourcePathList  = [];
  const resourceSeen      = new Set();
  for (const [, tag, rAttrs] of strippedHtml.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    if (resourcePathList.length >= RESOURCE_PATH_CAP) break;
    let rawRef = null;
    if (tag.toLowerCase() === 'script') {
      const m = rAttrs.match(/(?<![-\w])src\s*=\s*["']([^"']*)["']/i);
      if (m) rawRef = m[1];
    } else {
      const relM = rAttrs.match(/\brel=["']([^"']*)["']/i);
      if (!relM || relM[1].toLowerCase() !== 'stylesheet') continue;
      const m = rAttrs.match(/(?<![-\w])href\s*=\s*["']([^"']*)["']/i);
      if (m) rawRef = m[1];
    }
    if (!rawRef) continue;
    const ref = decodeEntities(rawRef);
    if (!ref || /^(?:data|javascript|mailto|tel):/i.test(ref)) continue;
    let resolved;
    try { resolved = new URL(ref, url || 'http://localhost/'); } catch { continue; }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    if (!pageOrigin || resolved.origin !== pageOrigin) continue;   // same-origin only
    const p = resolved.pathname + resolved.search;
    if (!resourceSeen.has(p)) { resourceSeen.add(p); resourcePathList.push(p); }
  }
  const resourcePaths = resourcePathList.join('|');

  // ── Word counts ───────────────────────────────────────────────────────────────
  const wordCount    = countWords(visibleText(bodyNoComments));
  const rawWordCount = countWords(rawBodyText(bodyNoComments));

  // ── Mixed content ─────────────────────────────────────────────────────────────
  // Detects blockable mixed content (passive + active) on https pages.
  //
  // Tag list extended to cover all resource-loading elements:
  //   img, script, link, iframe, video, audio, source, object, embed, form, track
  //
  // Attribute boundary (negative lookbehind (?<![-\w])) ensures only the real
  // resource attribute (src, href, poster, srcset, action) matches — not data-src,
  // data-href, or other data-* / custom attributes.
  //
  // Known residual limitation: <link rel=canonical href="http://…"> can still
  // match here because rel-aware filtering would require a multi-pass parse.
  // This is acceptable: an http canonical on an https page is itself a defect.
  let mixedContent = 0;
  if (url && url.startsWith('https://')) {
    if (/<(?:img|script|link|iframe|video|audio|source|object|embed|form|track)\b[^>]*(?<![-\w])(?:src|href|poster|srcset|action)\s*=\s*["']http:\/\//i.test(strippedHtml)) {
      mixedContent = 1;
    }
  }

  // ── Viewport ──────────────────────────────────────────────────────────────────
  // Extract the `content` attribute of <meta name="viewport">. Empty string if absent.
  const viewportContent = getMetaContent(metaMap, 'viewport') ?? '';

  // ── Charset OK ────────────────────────────────────────────────────────────────
  // Detect a UTF-8 charset declaration in the first 1024 raw bytes of HTML.
  // Uses raw `html` (not strippedHtml) because charset is byte-position relevant.
  // Matches: <meta charset="utf-8">, <meta charset="utf8">, and the http-equiv
  // Content-Type variant (charset=utf-8 inside the content attribute value).
  // Case-insensitive per HTML Living Standard (WHATWG, 2026-06).
  const htmlPrefix = html.slice(0, 1024);
  const charsetOk = /<meta\b[^>]*charset=["']?\s*utf-?8\s*["']?/i.test(htmlPrefix) ? '1' : '0';

  // ── Open Graph ────────────────────────────────────────────────────────────────
  const ogTitle = getMetaContent(metaMap, 'og:title') ?? '';
  const ogImage = getMetaContent(metaMap, 'og:image') ?? '';
  const ogUrl   = getMetaContent(metaMap, 'og:url')   ?? '';

  // ── Favicon presence ──────────────────────────────────────────────────────────
  let hasFavicon = 0;
  for (const [, attrs] of linkMatches) {
    const relM = attrs.match(/\brel=["']([^"']*)["']/i);
    if (relM && relM[1].toLowerCase().includes('icon')) { hasFavicon = 1; break; }
  }

  // ── Distinct canonical count ───────────────────────────────────────────────────
  // Separate from getCanonical() (which still returns the first href for canonical/canonSelf).
  // Counts DISTINCT non-empty rel=canonical href values (deduplicated).
  const canonicalHrefs = new Set();
  for (const [, attrs] of linkMatches) {
    const relM = attrs.match(/\brel=["']([^"']*)["']/i);
    if (relM && relM[1].toLowerCase() === 'canonical') {
      const hrefM = attrs.match(/\bhref=["']([^"']*)["']/i);
      const href  = hrefM ? hrefM[1].trim() : '';
      if (href !== '') canonicalHrefs.add(href);
    }
  }
  const canonicalCount = canonicalHrefs.size;

  // ── Empty / JS-guard ──────────────────────────────────────────────────────────
  // rawWordCount < 10 catches JS-SPA shells without flagging legitimate thin pages
  const isEmpty = rawWordCount < 10;

  return {
    title, titleLen,
    metaDesc, metaDescLen, metaMissing,
    canonical, canonSelf,
    robotsMeta,
    htmlLang,
    hreflangCount, hreflang, hreflangLinks,
    h1, h1Count, headingOutline,
    ldTypes, ldValid, ldContextOk,
    hasProduct, hasAgg, hasBreadcrumb, hasOrg, hasOrgSameAs, hasFAQ, hasAuthor,
    hasMicrodata, hasRdfa, resourcePaths,
    datePublished, dateModified,
    offerPrice, availability,
    imgTotal, imgNoAlt, imgJpg, imgWebp, imgAvif,
    outlinksInternal, outlinksAuthoritative,
    wordCount, rawWordCount,
    mixedContent,
    viewportContent,
    charsetOk,
    ogTitle, ogImage, ogUrl,
    hasFavicon,
    canonicalCount,
    imgNoDimensions,
    firstImgLazy,
    domNodeCount,
    headBlockingScripts,
    headBlockingStyles,
    genericAnchorCount,
    emptyLinkCount,
    unlabeledControlCount,
    aggRatingValue, aggRatingCount,
    hasShippingDetails, hasReturnPolicy,
    hasOrgLogo, hasOrgContactPoint,
    internalLinks,
    isEmpty,
  };
}
