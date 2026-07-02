/**
 * crawl/linkgraph.mjs — Internal link-graph analysis (Unit C2).
 *
 * buildLinkGraph(origin, pages, parsedByUrl) consumes the internalLinks arrays
 * produced by parsePage and computes:
 *   - inlinkCounts  — how many pages link TO each URL
 *   - depthByUrl    — BFS click-depth from the origin root
 *   - orphans       — crawled pages with 0 inlinks (excluding the root)
 */

/**
 * Canonical URL form used for all link-graph key comparisons.
 *
 * Rules (dependency-free, regex/string only):
 *   1. Lowercase the hostname.
 *   2. Resolve `/index.html` → `/` and `/dir/index.html` → `/dir`.
 *   3. Remove a trailing slash unless the pathname is the root `/`.
 *
 * Applied identically to `internalLinks` values in parse.mjs AND to
 * `page.url` keys in buildLinkGraph, so trailing-slash mismatches
 * (`/about` vs `/about/`) and index.html variants never cause
 * false-positive orphans or wrong click-depths.
 *
 * @param {string} u  Absolute URL string.
 * @returns {string}  Normalised URL string, or `u` unchanged on parse error.
 */
export function normalizeUrl(u) {
  try {
    const obj = new URL(u);
    obj.hostname = obj.hostname.toLowerCase();
    // /index.html → / ;  /dir/index.html → /dir/ (trailing slash removed below)
    if (obj.pathname.endsWith('/index.html')) {
      obj.pathname = obj.pathname.slice(0, -'index.html'.length) || '/';
    }
    // Remove trailing slash except for the root path
    if (obj.pathname.length > 1 && obj.pathname.endsWith('/')) {
      obj.pathname = obj.pathname.slice(0, -1);
    }
    return obj.origin + obj.pathname + obj.search;
  } catch {
    return u;
  }
}

/**
 * Build the internal link graph.
 *
 * @param {string} origin
 *   The crawl origin (scheme+host+port, no trailing slash).
 * @param {Array<{url: string}>} pages
 *   Pages returned by the crawler (only `url` is consumed here).
 * @param {Record<string, {internalLinks?: string[]}>} parsedByUrl
 *   Map of URL → parsePage result; must have `internalLinks` arrays.
 * @returns {{
 *   orphans:      string[],
 *   depthByUrl:   Record<string, number>,
 *   inlinkCounts: Record<string, number>
 * }}
 */
export function buildLinkGraph(origin, pages, parsedByUrl) {
  // ── 1. Inlink counts ─────────────────────────────────────────────────────────
  /** @type {Record<string, number>} */
  const inlinkCounts = {};

  for (const page of pages) {
    const parsed = parsedByUrl[page.url];
    if (!parsed) continue;
    for (const link of (parsed.internalLinks ?? [])) {
      inlinkCounts[link] = (inlinkCounts[link] ?? 0) + 1;
    }
  }

  // ── 2. BFS click-depth from the root URL ─────────────────────────────────────
  // The root URL is the first page whose URL equals origin, origin+'/' or
  // new URL(origin).origin+'/'. Fall back to origin+'/' if none found.
  let baseOrigin;
  try { baseOrigin = new URL(origin).origin; } catch { baseOrigin = origin; }
  const rootCandidates = new Set([origin, origin + '/', baseOrigin, baseOrigin + '/']);

  const rootPage = pages.find((p) => rootCandidates.has(p.url));
  const rootUrl  = rootPage ? rootPage.url : (baseOrigin + '/');

  // Use the normalised form as the canonical BFS key so trailing-slash and
  // index.html variants resolve to the same node.
  const normRootUrl = normalizeUrl(rootUrl);

  /** @type {Record<string, number>} */
  const depthByUrl = { [normRootUrl]: 0 };

  // Build adjacency from internalLinks of each crawled page.
  // Page URLs are normalised so that a page crawled as /about/ is keyed the
  // same way as a link targeting /about.  internalLinks from parsePage are
  // already normalised (normalizeUrl applied on write).
  // Pages not in the crawl set are still reachable in the BFS (we may have
  // their depth even if they were never fetched), but only crawled pages
  // contribute outbound edges.
  /** @type {Map<string, string[]>} */
  const adjacency = new Map();
  for (const page of pages) {
    const parsed = parsedByUrl[page.url];
    adjacency.set(normalizeUrl(page.url), parsed?.internalLinks ?? []);
  }

  const queue = [normRootUrl];
  let qi = 0;
  while (qi < queue.length) {
    const current = queue[qi++];
    const depth   = depthByUrl[current];
    for (const link of (adjacency.get(current) ?? [])) {
      if (!(link in depthByUrl)) {
        depthByUrl[link] = depth + 1;
        queue.push(link);
      }
    }
  }

  // ── 3. Orphans ────────────────────────────────────────────────────────────────
  // A crawled page is an orphan if it has 0 inlinks AND is not the root.
  // Page URLs are normalised before lookup so /about/ and /about are treated
  // as the same node — eliminating false-positive orphans from URL mismatches.
  const rootSet = new Set([...rootCandidates, rootUrl].map(normalizeUrl));
  // Normalise each page URL once (was called ~3x/page across filter + map).
  const orphans = [];
  for (const p of pages) {
    const norm = normalizeUrl(p.url);
    if (!rootSet.has(norm) && !inlinkCounts[norm]) orphans.push(norm);
  }

  return { orphans, depthByUrl, inlinkCounts };
}
