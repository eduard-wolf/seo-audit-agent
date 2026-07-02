/**
 * crawl/crawl.mjs — Main crawler.
 *
 * crawl(origin, opts) discovers URLs via sitemap (default) or BFS fallback,
 * respects robots.txt Disallow rules, applies caps, and returns per-page
 * C1 data (raw HTML + status/redirect fields). Head signals are filled later
 * by C2.
 *
 * Politeness (U3.8):
 *   backoffBaseMs — passed through to every politeFetch call so the whole run
 *                   shares the same backoff base. Default 1000 ms (≥1 s).
 *                   Tests inject a small value (e.g. 10) for speed.
 *   Crawl-delay   — signals.robots.crawlDelay wired into makeLimiter as
 *                   crawlDelaySec floor after signals are fetched.
 *   429 tracking  — ≥2 page-level 429 responses (after all retries) trigger
 *                   limit.slowDown(2) once, halving effective rps for the rest.
 *
 * Checkpoint / resume (U5.3):
 *   resumeState     — when provided, restores queue/frontier/counters from a
 *                     saved checkpoint instead of building them fresh.
 *   onCheckpoint    — async callback(crawlState) called every checkpointEvery
 *                     pages AND once after the loop ends; run.mjs merges
 *                     edges/counters before writing crawl-state.json.
 *   checkpointEvery — interval in pages between intermediate checkpoints. When not
 *                     passed explicitly it scales as max(25, floor(maxUrls/40)) so the
 *                     checkpoint COUNT (and thus cumulative write volume) stays bounded
 *                     at full-audit scale; defaults to 25 for maxUrls≤1000.
 */

import { politeFetch } from './fetch.mjs';
import { makeLimiter } from './throttle.mjs';
import { fetchSiteSignals, probeHttpScheme } from './sitefetch.mjs';
import { isPathAllowed } from './robots-match.mjs';

/** Minimum 429 responses observed before slowing the limiter. */
const SLOW_DOWN_THRESHOLD = 2;

/**
 * Extract same-origin <a href> links from an HTML string.
 *
 * @param {string} html
 * @param {string} baseUrl  — absolute URL used to resolve relative hrefs
 * @param {string} origin   — scheme+host+port to filter by
 * @returns {string[]}      — deduplicated list of absolute same-origin URLs
 */
function extractLinks(html, baseUrl, origin) {
  const seen = new Set();
  const links = [];

  for (const [, href] of html.matchAll(/<a\s[^>]*\bhref=["']([^"']+)["']/gi)) {
    let resolved;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue; // malformed href
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    if (resolved.origin !== origin) continue;
    // Drop fragment; keep path+search only
    const canonical = resolved.origin + resolved.pathname + resolved.search;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      links.push(canonical);
    }
  }

  return links;
}

/**
 * Classify a URL into a content type string.
 * Uses opts.classifyConfig (array of {pattern, type}) if provided,
 * otherwise returns 'page' for everything (generic default).
 *
 * @param {string} url
 * @param {Array<{pattern:string, type:string}>|null} [classifyConfig]
 * @returns {string}
 */
function classifyUrl(url, classifyConfig) {
  if (classifyConfig?.length) {
    let pathname;
    try { pathname = new URL(url).pathname; } catch { pathname = ''; }
    for (const { pattern, type } of classifyConfig) {
      if (new RegExp(pattern).test(pathname)) return type;
    }
  }
  return 'page';
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * @param {string} origin
 * @param {{
 *   maxUrls?:         number,
 *   maxDepth?:        number,
 *   maxProducts?:     number,
 *   wallClockMs?:     number,
 *   useSitemap?:      boolean,
 *   rps?:             number,
 *   classifyConfig?:  Array<{pattern:string,type:string}>|null,
 *   backoffBaseMs?:   number,
 *   concurrency?:     number,
 *   resumeState?:     object,
 *   onCheckpoint?:    (state:object) => Promise<void>,
 *   checkpointEvery?: number,
 * }} [opts]
 * @returns {Promise<{
 *   origin: string,
 *   pages: Array<{
 *     url:string, type:string, status:number, finalUrl:string,
 *     redirected:boolean, redirectChain:string[], httpsOk:boolean,
 *     mixedContent:null, error:string|null, html:string|null,
 *     xRobotsTag:string, hstsPresent:number, frameProtection:number, contentEncoding:string,
 *     nosniffPresent:number, referrerPolicyPresent:number, permissionsPolicyPresent:number,
 *     cspPresent:number, cookieInsecure:number, versionDisclosure:number
 *   }>,
 *   signals: object,
 *   stats: {
 *     discovered:number, fetched:number, capped:boolean, durationMs:number,
 *     slowDownTriggered:boolean
 *   }
 * }>}
 */
export async function crawl(origin, opts = {}) {
  const {
    maxUrls           = 200,
    maxDepth          = 4,
    maxProducts       = 600,
    wallClockMs       = 1_500_000,
    useSitemap        = true,
    rps               = 2,
    classifyConfig    = null,
    backoffBaseMs     = 1000,
    concurrency       = 1,
    onPage,
    resumeState,
    onCheckpoint,
    checkpointEvery: checkpointEveryOpt,
  } = opts;

  // Scale the checkpoint interval with maxUrls so the TOTAL number of checkpoints
  // (each re-dumps the growing queue + edges → cumulative O(N²) at full-audit) stays
  // bounded at ~maxUrls/40, keeping cumulative checkpoint write volume ~O(N) while
  // preserving resume capability (a checkpoint still exists). An explicit
  // opts.checkpointEvery always wins (tests force small values to exercise mid-crawl
  // checkpoints). At the default maxUrls=200 this is 25 (unchanged); for maxUrls≤1000
  // it stays 25; at fixture scale (≤21 pages < 25) no intermediate checkpoint fires.
  const checkpointEvery = checkpointEveryOpt ?? Math.max(25, Math.floor(maxUrls / 40));

  const startTime = Date.now();

  // Normalise origin to scheme+host+port only
  const baseOrigin = new URL(origin).origin;

  // The authorized seed host: seedHost is passed as allowedHost to every
  // politeFetch call. The SSRF guard (crawl/ssrf-guard.mjs) blocks only hops
  // into PRIVATE address ranges that differ from seedHost — public cross-host
  // redirects are still followed (no host clamp on public targets).
  const seedHost = new URL(baseOrigin).hostname;

  // ── 1. Site-level signals ─────────────────────────────────────────────────
  // A separate early limiter is needed here because crawlDelay (used by the
  // page limiter below) comes from robots.txt — which is itself a site-signal
  // fetch (chicken-and-egg). signalLimit throttles robots/llms/sitemap fetches
  // including the up-to-50 child-sitemap fetches from expandSitemap (U3.9).
  // backoffBaseMs is threaded into the fetchImpl closure so the whole run uses
  // the same backoff base (analogous to allowedHost threading).

  const signalLimit = makeLimiter({ rps });
  const siteFetch = (u) => signalLimit(() => politeFetch(u, { allowedHost: seedHost, backoffBaseMs }));
  const signals = await fetchSiteSignals(baseOrigin, siteFetch);
  signals.httpProbe = await probeHttpScheme(baseOrigin, siteFetch);   // NEW — site-level http→https probe

  // ── 2. Initialise limiter — after signals so we can use crawlDelay ─────────
  // Crawl-delay from robots.txt is honoured as a floor on the request interval.
  // This page limiter is separate from signalLimit above.

  const limit = makeLimiter({ rps, crawlDelaySec: signals.robots.crawlDelay });

  // 429 adaptive throttling state
  let total429s = 0;
  let slowedDown = false;

  // ── 3. Build initial URL queue ────────────────────────────────────────────

  let queue;
  const discoveredSet = new Set();
  let bfsMode;

  if (resumeState) {
    // Resume: restore frontier from checkpoint
    queue   = resumeState.queue;
    bfsMode = resumeState.bfsMode;
    for (const u of (resumeState.discovered ?? [])) discoveredSet.add(u);
  } else {
    // Fresh: build queue from sitemap or BFS seed
    queue   = [];
    bfsMode = !useSitemap || signals.sitemapUrls.length === 0;

    if (!bfsMode) {
      // Rewrite sitemap URLs to the actual crawl origin (same path, different host)
      for (const rawUrl of signals.sitemapUrls) {
        let rewritten;
        try {
          const parsed = new URL(rawUrl);
          rewritten = baseOrigin + parsed.pathname + (parsed.search || '');
        } catch {
          continue;
        }
        if (!discoveredSet.has(rewritten)) {
          discoveredSet.add(rewritten);
          queue.push(rewritten);
        }
      }
    } else {
      // BFS: start from the site root
      const startUrl = baseOrigin + '/';
      discoveredSet.add(startUrl);
      queue.push(startUrl);
    }
  }

  // ── 4. Crawl loop ─────────────────────────────────────────────────────────

  const pages = [];
  let fetchedCount = resumeState?.fetchedCount ?? 0;
  let productCount = resumeState?.productCount ?? 0;
  const seen = new Set(); // URLs attempted in this run (intra-run dedup)
  let capped = resumeState?.capped ?? false;
  let qi     = resumeState?.qi ?? 0;

  // BFS depth tracking — restored from checkpoint on resume
  const depths = new Map();
  if (resumeState) {
    for (const [k, v] of Object.entries(resumeState.depths ?? {})) depths.set(k, v);
  } else if (bfsMode) {
    depths.set(baseOrigin + '/', 0);
  }

  // Belt-and-suspenders: skip URLs already present in crawl.csv on resume
  const doneSet = resumeState?.doneSet
    ? new Set(resumeState.doneSet)
    : null;

  let pagesSinceCheckpoint = 0;

  /**
   * Capture crawl-side state (does NOT include run.mjs edges/counters).
   * run.mjs merges those before writing crawl-state.json.
   *
   * @param {boolean} done — true only when queue fully drained (not capped)
   * @returns {object}
   */
  function captureState(done) {
    return {
      queue,
      qi,
      depths:       Object.fromEntries(depths),
      discovered:   [...discoveredSet],
      bfsMode,
      fetchedCount,
      productCount,
      capped,
      done,
    };
  }

  /**
   * Process one fetched page: 429 adaptive throttling, page build, counters,
   * onPage/buffer, and BFS link expansion.  Shared by both the sequential and
   * the batch path so the two are structurally identical.
   *
   * @param {string} url
   * @param {string} type      — classifyUrl result, captured at selection time
   * @param {number} depthForBfs — queue depth of url, captured at selection time
   * @param {object} result    — politeFetch result
   */
  async function processPage(url, type, depthForBfs, result) {
    // 429 adaptive throttling (unchanged logic)
    if (result.status === 429 && !slowedDown) {
      total429s++;
      if (total429s >= SLOW_DOWN_THRESHOLD) { limit.slowDown(2); slowedDown = true; }
    }

    const page = {
      url,
      type,
      status:          result.status,
      finalUrl:        result.finalUrl,
      redirected:      result.redirected,
      redirectChain:   result.redirectChain,
      httpsOk:         result.httpsOk,
      mixedContent:    null,  // C2 fills this in
      error:           result.error,
      html:            result.html,
      xRobotsTag:      result.xRobotsTag,
      hstsPresent:     result.hstsPresent,
      frameProtection: result.frameProtection,
      contentEncoding: result.contentEncoding,
      nosniffPresent:           result.nosniffPresent,
      referrerPolicyPresent:    result.referrerPolicyPresent,
      permissionsPolicyPresent: result.permissionsPolicyPresent,
      cspPresent:               result.cspPresent,
      cookieInsecure:           result.cookieInsecure,
      versionDisclosure:        result.versionDisclosure,
    };

    fetchedCount++;
    if (type === 'product') productCount++;
    if (onPage) { await onPage(page); } else { pages.push(page); }

    // BFS: extract links from successfully fetched HTML pages.
    // Uses the page's OWN depth captured at selection time (depthForBfs) so
    // the batch path produces the same queue evolution as the sequential path.
    if (bfsMode && result.html) {
      if (depthForBfs < maxDepth) {
        const links = extractLinks(result.html, result.finalUrl, baseOrigin);
        for (const link of links) {
          if (!discoveredSet.has(link)) {
            discoveredSet.add(link);
            queue.push(link);
            depths.set(link, depthForBfs + 1);
          }
        }
      }
    }
  }

  while (qi < queue.length) {
    // Wall-clock cap (checked at top of every outer iteration)
    if (Date.now() - startTime > wallClockMs) {
      capped = true;
      break;
    }

    if (concurrency <= 1) {
      // ── SEQUENTIAL PATH (default, concurrency ≤ 1) ───────────────────────
      // Behaviour is unchanged from before the processPage refactor.
      const url = queue[qi++];

      if (seen.has(url)) continue;
      seen.add(url);

      // Robots enforcement (RFC 9309: path+query as match target; parse error → skip)
      let pathAndQuery;
      try {
        const parsed = new URL(url);
        pathAndQuery = parsed.pathname + parsed.search;
      } catch {
        continue; // malformed URL — cannot derive robots path; skip
      }
      if (!isPathAllowed(pathAndQuery, signals.robots)) continue;

      // Belt-and-suspenders: skip URLs already in crawl.csv from a previous run
      if (doneSet?.has(url)) continue;

      // maxUrls cap — back up qi so the resume path re-tries this URL
      if (fetchedCount >= maxUrls) {
        capped = true;
        qi--;
        break;
      }

      // Classify before fetch so we can apply product cap
      const type = classifyUrl(url, classifyConfig);

      // maxProducts cap
      // latent: unreachable at defaults (maxProducts 600 > maxUrls 200) — a
      // maxProducts-only queue drain would set capped=true but done would read
      // false (queue not fully drained); comment only, do NOT change flag logic.
      if (type === 'product' && productCount >= maxProducts) {
        capped = true;
        continue;
      }

      // Throttled fetch
      const result = await limit(() => politeFetch(url, { allowedHost: seedHost, backoffBaseMs }));
      await processPage(url, type, depths.get(url) ?? 0, result);

      // Emit intermediate checkpoint every checkpointEvery pages
      pagesSinceCheckpoint++;
      if (onCheckpoint && pagesSinceCheckpoint >= checkpointEvery) {
        await onCheckpoint(captureState(false));
        pagesSinceCheckpoint = 0;
      }
    } else {
      // ── BATCH PATH (concurrency > 1) ──────────────────────────────────────
      // Select up to `concurrency` fetchable URLs in queue order, applying the
      // same skip conditions as the sequential path so the discovered set /
      // queue / depths evolve identically.

      const batch = [];
      let predProduct = productCount; // predict product cap exactly as sequential would

      while (qi < queue.length && batch.length < concurrency && fetchedCount + batch.length < maxUrls) {
        const url = queue[qi];
        if (seen.has(url)) { qi++; continue; }

        let pathAndQuery;
        try { const u = new URL(url); pathAndQuery = u.pathname + u.search; }
        catch { qi++; continue; } // malformed — skip (matches sequential continue)

        if (!isPathAllowed(pathAndQuery, signals.robots)) { qi++; continue; }

        // Belt-and-suspenders: skip URLs already in crawl.csv from a previous run
        if (doneSet?.has(url)) { qi++; continue; }

        const type = classifyUrl(url, classifyConfig);
        if (type === 'product' && predProduct >= maxProducts) { capped = true; qi++; continue; }

        // seen.add at accept-time (batch path) vs examine-time (sequential path)
        // — the difference is invisible to output (monotonic skip states): both
        // paths skip duplicate URLs the same way. "seen" means "fetchable" here,
        // "examined" in the sequential path.
        seen.add(url);
        batch.push({ url, type, depth: depths.get(url) ?? 0 });
        if (type === 'product') predProduct++;
        qi++;
      }

      // Cap when batch will exhaust the maxUrls quota but more URLs remain
      if (fetchedCount + batch.length >= maxUrls && qi < queue.length) capped = true;

      // batch.length === 0: all queue items from qi onward were skipped (seen/
      // robots/doneSet). BFS items added by a prior batch's processPage are
      // already in the queue and were visible to the inner while — if none were
      // accepted, the queue is truly exhausted for this run.
      if (batch.length === 0) break;

      // Fetch batch concurrently (rps-gated via limit — starts are staggered,
      // in-flight fetches overlap; limit already supports this pattern).
      const results = await Promise.all(
        batch.map(b => limit(() => politeFetch(b.url, { allowedHost: seedHost, backoffBaseMs }))),
      );

      // Process results IN QUEUE ORDER → deterministic rows + BFS expansion
      for (let j = 0; j < batch.length; j++) {
        await processPage(batch[j].url, batch[j].type, batch[j].depth, results[j]);

        pagesSinceCheckpoint++;
        if (onCheckpoint && pagesSinceCheckpoint >= checkpointEvery) {
          await onCheckpoint(captureState(false));
          pagesSinceCheckpoint = 0;
        }
      }
    }
  }

  // Final checkpoint — done=true only when the queue fully drained (not capped)
  if (onCheckpoint) {
    const queueDrained = qi >= queue.length && !capped;
    await onCheckpoint(captureState(queueDrained));
  }

  return {
    origin: baseOrigin,
    pages,                                // [] in streaming mode; populated in buffered mode
    signals,
    stats: {
      discovered:        discoveredSet.size,
      fetched:           fetchedCount,
      capped,
      durationMs:        Date.now() - startTime,
      slowDownTriggered: slowedDown,
    },
  };
}
