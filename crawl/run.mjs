/**
 * crawl/run.mjs — Full-pipeline orchestrator (Unit C2).
 *
 * runCrawl(origin, opts) ties together:
 *   1. crawl()       (Unit C1) — fetches pages, streams via onPage callback
 *   2. parsePage()   (Unit C2) — extracts head/body signals per page (inline, HTML discarded)
 *   3. buildLinkGraph()        — computes orphans / click-depth / inlink counts
 *   4. Writes data/<host>/crawl.csv  (atomically at end — byte-identical to old path)
 *   5. Writes data/<host>/crawl-state.json (checkpoint written via onCheckpoint)
 *   6. Writes data/<host>/signals.json (site-level + link-graph summary)
 *   7. Returns { csvPath, signalsPath, siteType, stats }
 *
 * Checkpoint / resume (U5.3):
 *   opts.resume=true   — if crawl-state.json exists and done!==true, continue
 *                        the previous crawl: restore frontier + edges/counters,
 *                        accumulate new rows in memory, write final CSV atomically
 *                        (existingText + newRows) — byte-identical to a fresh run.
 *   opts.checkpointEvery — forwarded to crawl(); default 25.
 *
 * Output directory: by default crawl.csv / crawl-state.json / signals.json are
 * written under data/<host>/ (host derived from the origin). Pass opts.dataDir
 * to redirect all three artifacts to a caller-supplied directory instead.
 *
 * Concurrency / isolation: the CSV write is an atomic tmp+rename (writeFileAtomic),
 * which only guards against a single run's own write being torn —
 * it provides NO cross-process isolation. Two runs that share the same output
 * directory (e.g. parallel test files, which all derive host '127.0.0.1' from the
 * loopback fixture server) will clobber each other's files. Callers that may run
 * concurrently against the same host MUST pass a unique opts.dataDir (or run
 * serially).
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { crawl }          from './crawl.mjs';
import { parsePage }      from './parse.mjs';
import { buildLinkGraph } from './linkgraph.mjs';
import { COLS, toCsvRow, parseCsv } from './schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.resolve(__dirname, '../data');

/**
 * Write a file atomically: write to a sibling *.tmp, then rename over the target.
 * rename(2) is atomic within a filesystem, so a crash mid-write leaves either the
 * old file or the complete new one — never a torn/truncated artifact. (Bare
 * writeFileSync truncates-then-writes and can leave a partial file on crash.)
 *
 * @param {string} file
 * @param {string} data
 */
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Build a single CSV row from a page (C1 fields) and its parsed result (C2 fields).
 *
 * @param {{ url:string, type:string, status:number, finalUrl:string,
 *            redirected:boolean, redirectChain:string[]|string, httpsOk:boolean,
 *            error:string|null, xRobotsTag:string, hstsPresent:number,
 *            frameProtection:number, contentEncoding:string,
 *            nosniffPresent:number, referrerPolicyPresent:number,
 *            permissionsPolicyPresent:number, cspPresent:number,
 *            cookieInsecure:number, versionDisclosure:number }} page
 * @param {object} parsed — result of parsePage(), or {} when html was null
 * @returns {object} — plain object with keys matching COLS
 */
export function buildRow(page, parsed) {
  const p = parsed ?? {};
  return {
    // C1 fields
    url:           page.url,
    type:          page.type          ?? '',
    status:        page.status        ?? '',
    finalUrl:      page.finalUrl      ?? '',
    redirected:    page.redirected    ? 1 : 0,
    redirectChain: Array.isArray(page.redirectChain)
      ? page.redirectChain.join('|')
      : (page.redirectChain ?? ''),
    httpsOk:       page.httpsOk      ? 1 : 0,
    // Inject js-guard signal for JS-shell pages that have no real C1 error
    error:         page.error        ? page.error
      : (p.isEmpty ? 'js-guard:empty-body' : ''),

    // C2 fields
    title:                 p.title                ?? '',
    titleLen:              p.titleLen             ?? '',
    metaDesc:              p.metaDesc             ?? '',
    metaDescLen:           p.metaDescLen          ?? '',
    metaMissing:           p.metaMissing          ?? '',
    canonical:             p.canonical            ?? '',
    canonSelf:             p.canonSelf            ?? '',
    robotsMeta:            p.robotsMeta           ?? '',
    htmlLang:              p.htmlLang             ?? '',
    hreflangCount:         p.hreflangCount        ?? '',
    hreflang:              p.hreflang             ?? '',
    h1:                    p.h1                   ?? '',
    h1Count:               p.h1Count              ?? '',
    headingOutline:        p.headingOutline       ?? '',
    ldTypes:               p.ldTypes              ?? '',
    ldValid:               p.ldValid              ?? '',
    ldContextOk:           p.ldContextOk          ?? '',
    hasProduct:            p.hasProduct           ?? '',
    hasAgg:                p.hasAgg               ?? '',
    hasBreadcrumb:         p.hasBreadcrumb        ?? '',
    hasOrg:                p.hasOrg               ?? '',
    hasOrgSameAs:          p.hasOrgSameAs         ?? '',
    hasFAQ:                p.hasFAQ               ?? '',
    hasAuthor:             p.hasAuthor            ?? '',
    datePublished:         p.datePublished        ?? '',
    dateModified:          p.dateModified         ?? '',
    offerPrice:            p.offerPrice           ?? '',
    availability:          p.availability         ?? '',
    imgTotal:              p.imgTotal             ?? '',
    imgNoAlt:              p.imgNoAlt             ?? '',
    imgJpg:                p.imgJpg               ?? '',
    imgWebp:               p.imgWebp              ?? '',
    imgAvif:               p.imgAvif              ?? '',
    outlinksInternal:      p.outlinksInternal     ?? '',
    outlinksAuthoritative: p.outlinksAuthoritative ?? '',
    outlinksExternal:      p.outlinksExternal     ?? '',
    wordCount:             p.wordCount            ?? '',
    rawWordCount:          p.rawWordCount         ?? '',
    mixedContent:          p.mixedContent         ?? '',
    viewportContent:       p.viewportContent      ?? '',
    charsetOk:             p.charsetOk            ?? '',
    ogTitle:               p.ogTitle              ?? '',
    ogImage:               p.ogImage              ?? '',
    ogUrl:                 p.ogUrl                ?? '',
    hasFavicon:            p.hasFavicon           ?? '',
    canonicalCount:        p.canonicalCount       ?? '',
    imgNoDimensions:       p.imgNoDimensions      ?? '',
    firstImgLazy:          p.firstImgLazy         ?? '',
    domNodeCount:          p.domNodeCount         ?? '',
    headBlockingScripts:   p.headBlockingScripts   ?? '',
    headBlockingStyles:    p.headBlockingStyles    ?? '',
    genericAnchorCount:    p.genericAnchorCount    ?? '',
    emptyLinkCount:        p.emptyLinkCount        ?? '',
    unlabeledControlCount: p.unlabeledControlCount ?? '',
    aggRatingValue:        p.aggRatingValue        ?? '',
    aggRatingCount:        p.aggRatingCount        ?? '',
    hasShippingDetails:    p.hasShippingDetails    ?? '',
    hasReturnPolicy:       p.hasReturnPolicy       ?? '',
    hasOrgLogo:            p.hasOrgLogo            ?? '',
    hasOrgContactPoint:    p.hasOrgContactPoint    ?? '',
    hasMicrodata:          p.hasMicrodata          ?? '',
    hasRdfa:               p.hasRdfa               ?? '',
    resourcePaths:         p.resourcePaths         ?? '',

    // C1 header fields (from fetch layer — NOT from parsePage)
    xRobotsTag:      page.xRobotsTag      ?? '',
    hstsPresent:     page.hstsPresent     ?? '',
    frameProtection: page.frameProtection ?? '',
    contentEncoding: page.contentEncoding ?? '',

    // C1 security/trust header fields (Batch 4b — from fetch layer)
    nosniffPresent:           page.nosniffPresent           ?? '',
    referrerPolicyPresent:    page.referrerPolicyPresent    ?? '',
    permissionsPolicyPresent: page.permissionsPolicyPresent ?? '',
    cspPresent:               page.cspPresent               ?? '',
    cookieInsecure:           page.cookieInsecure           ?? '',
    versionDisclosure:        page.versionDisclosure        ?? '',

    hreflangLinks:   p.hreflangLinks      ?? '',
  };
}

/**
 * Parse one page's HTML, catching ANY parser error so a single malformed page
 * cannot abort the whole crawl (a crawler hitting arbitrary HTML will meet
 * corrupted/adversarial markup). Returns {} — the same shape the null-HTML path
 * uses, which buildRow renders as an empty-signal row — and warns on stderr.
 * `parseFn` is injectable for testing the failure path.
 *
 * @param {string} html
 * @param {string} url
 * @param {(html:string,url:string)=>object} [parseFn]
 * @returns {object}
 */
export function safeParse(html, url, parseFn = parsePage) {
  try {
    return parseFn(html, url);
  } catch (err) {
    console.error(`parse failed for ${url}: ${err?.message || err} — page skipped (empty row)`);
    return {};
  }
}

/**
 * @param {string} origin — e.g. 'http://127.0.0.1:3000'
 * @param {object} [opts] — forwarded to crawl(); also accepts:
 *   resume?:          boolean  — if true, continue from crawl-state.json
 *   checkpointEvery?: number   — forwarded to crawl() (default 25)
 *   dataDir?:         string   — output directory override; when set, crawl.csv /
 *                                crawl-state.json / signals.json are written here
 *                                instead of data/<host>/ (pure path override)
 *   crawledAt?:       string   — override the SINGLE wall-clock provenance field
 *                                (signals.crawlMeta.crawledAt). When ABSENT, defaults
 *                                to new Date().toISOString(), so the default crawl is
 *                                byte-identical to today; inject a fixed ISO string for
 *                                reproducible runs. Mirrors bin/enrich.mjs's nowIso.
 *   now?:             string   — alias for crawledAt (crawledAt wins if both set).
 * @returns {Promise<{
 *   csvPath:     string,
 *   signalsPath: string,
 *   siteType:    'server-rendered'|'client-rendered',
 *   stats:       object
 * }>}
 */
export async function runCrawl(origin, opts = {}) {
  const { resume = false, checkpointEvery, dataDir } = opts;

  // crawledAt — the SINGLE intentional wall-clock provenance field. It is the one
  // value in an otherwise byte-identical crawl that is NOT reproducible by design: it
  // flows to signals.crawlMeta.crawledAt → analysis.meta.crawledAt and is deliberately
  // EXCLUDED from the byte-identical guarantee (and correctly absent from crawl.csv).
  // Injectable (opts.crawledAt, alias opts.now) for reproducible runs; when ABSENT we
  // fall back to new Date().toISOString() so DEFAULT behaviour is byte-identical to today.
  // Captured before the crawl so the timestamp marks the run's START, not its end.
  const crawledAt = opts.crawledAt ?? opts.now ?? new Date().toISOString();

  // ── Paths (moved to top so resume can reference them before crawl) ─────────
  // dataDir override (when provided) wins over the hostname-derived default; this
  // is a pure path override — no behavioural/output change beyond the directory.
  let host;
  try { host = new URL(origin).hostname; } catch { host = 'unknown'; }

  const hostDir    = dataDir ?? path.join(DATA_DIR, host);
  fs.mkdirSync(hostDir, { recursive: true });

  const csvPath     = path.join(hostDir, 'crawl.csv');
  const statePath   = path.join(hostDir, 'crawl-state.json');
  const signalsPath = path.join(hostDir, 'signals.json');

  // ── Resume wiring ─────────────────────────────────────────────────────────
  // edges — [{url, internalLinks}] — accumulated across run-A and run-B on
  // resume; used for both checkpoint persistence and final link-graph build.
  let edges        = [];
  let htmlPageCount = 0;
  let emptyCount   = 0;

  // existingCsvText: the header + rows from run-A; on resume we append new rows.
  // On a fresh run this stays null and we write the full CSV from newRows.
  let existingCsvText = null;
  let resumeState     = undefined;

  if (resume && fs.existsSync(statePath)) {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (saved.done !== true) {
      // Restore run-side accumulated data from the checkpoint
      edges         = saved.edges         ?? [];
      htmlPageCount = saved.htmlPageCount ?? 0;
      emptyCount    = saved.emptyCount    ?? 0;

      // Read existing crawl.csv for:
      //   (a) doneSet  — belt-and-suspenders against crash between flush and checkpoint
      //   (b) text to prepend when writing the final CSV
      existingCsvText = fs.existsSync(csvPath)
        ? fs.readFileSync(csvPath, 'utf8')
        : COLS.join(',');

      // Build as a Set so .size is available for the hard-crash guard below.
      // When crawl.csv is missing, parseCsv of the header-only text yields [],
      // giving an empty set (size 0) — the guard fires correctly in that case too.
      const doneSet = new Set(parseCsv(existingCsvText).map(r => r.url).filter(Boolean));

      // crawl.csv is written atomically at a clean stop (cap/wallClock/drain); crawl-state.json is also
      // written at intermediate checkpoints. If the checkpoint records MORE fetched pages than crawl.csv
      // has rows, the previous run was hard-killed (kill -9) between a checkpoint and the clean end — the
      // in-progress rows are unrecoverable. Refuse to resume so the failure is LOUD, not silent corruption.
      if ((saved.fetchedCount ?? 0) > doneSet.size) {
        throw new Error(
          `Resume aborted: checkpoint records ${saved.fetchedCount} fetched pages but crawl.csv has only ` +
          `${doneSet.size} rows (likely a hard crash mid-run). crawl.csv is only persisted at a clean stop — ` +
          `re-run a fresh crawl (without --resume) for this host.`,
        );
      }

      resumeState = {
        queue:        saved.queue,
        qi:           saved.qi,
        depths:       saved.depths,
        discovered:   saved.discovered,
        bfsMode:      saved.bfsMode,
        fetchedCount: saved.fetchedCount,
        productCount: saved.productCount,
        // Intentionally NOT restoring saved.capped: it reflected run-A's cap;
        // run-B starts fresh so queueDrained is calculated correctly.
        doneSet: [...doneSet],  // array form — crawl.mjs wraps it in new Set()
      };
    }
  }

  // ── Accumulate new rows in memory ─────────────────────────────────────────
  // Both fresh and resume paths collect rows as objects and write the CSV in a
  // single atomic tmp+rename (writeFileAtomic) at the end, so a given run's own
  // write is never torn. This does NOT isolate concurrent runs sharing the output
  // directory — cross-run isolation is the caller's job via opts.dataDir.
  const newRows = [];  // Array<object> — result of buildRow()

  // ── 1. Crawl (streaming via onPage) ──────────────────────────────────────
  const { signals, stats } = await crawl(origin, {
    ...opts,
    resumeState,
    checkpointEvery,
    // Checkpoint callback: merge run-side data and persist crawl-state.json.
    // Called every checkpointEvery pages AND once after the loop ends.
    onCheckpoint(crawlState) {
      writeFileAtomic(
        statePath,
        JSON.stringify({ ...crawlState, edges, htmlPageCount, emptyCount }),
      );
    },
    onPage(page) {
      const pageUrl = page.finalUrl || page.url;
      const parsed  = page.html ? safeParse(page.html, pageUrl) : {};

      newRows.push(buildRow(page, parsed));

      // Accumulate edges for checkpoint + final link-graph (ALL pages, A + B)
      edges.push({ url: page.url, internalLinks: parsed.internalLinks ?? [] });

      if (page.html !== null && page.html !== undefined) {
        htmlPageCount++;
        if (parsed.isEmpty) emptyCount++;
      }
      // page (incl. page.html) is released after this callback — NOT retained
    },
  });

  // ── 2. Write crawl.csv (atomic single write) ───────────────────────────────
  // Fresh run:  header + all rows (byte-identical to old [header,...].join('\n'))
  // Resume run: existing text (header + run-A rows) + new rows
  {
    const newLines = newRows.map(toCsvRow);
    let csvContent;
    if (existingCsvText === null) {
      // Fresh (non-resume) — exactly as before
      csvContent = [COLS.join(','), ...newLines].join('\n');
    } else {
      // Resume — append new rows after the existing content
      csvContent = existingCsvText + (newLines.length > 0 ? '\n' + newLines.join('\n') : '');
    }
    writeFileAtomic(csvPath, csvContent);
  }

  // ── 3. Link graph ─────────────────────────────────────────────────────────
  // Build over ALL edges (run-A restored from checkpoint + run-B new edges)
  const pagesLite  = edges.map(e => ({ url: e.url }));
  const parsedByUrl = {};
  for (const e of edges) parsedByUrl[e.url] = { internalLinks: e.internalLinks };
  const linkGraph = buildLinkGraph(origin, pagesLite, parsedByUrl);

  // ── 4. Determine siteType ─────────────────────────────────────────────────
  // 'client-rendered' when the majority of HTML pages have isEmpty=true (JS-shell)
  const emptyRatio = htmlPageCount > 0 ? emptyCount / htmlPageCount : 0;
  const siteType   = emptyRatio > 0.5 ? 'client-rendered' : 'server-rendered';

  // ── 5. Write signals.json ─────────────────────────────────────────────────
  const signalsOut = {
    ...signals,
    crawlMeta: {
      crawledAt,
      discovered: stats.discovered,
      fetched:    stats.fetched,
      capped:     stats.capped,
    },
    linkGraph: {
      orphanCount: linkGraph.orphans.length,
      orphans:     linkGraph.orphans,
      totalPages:  pagesLite.length,
      depthByUrl:  linkGraph.depthByUrl,
      // Per-page internal-link adjacency, emitted in STABLE crawl/document order
      // (the order edges were accumulated in onPage — identical CSV row order), so
      // two runs produce byte-identical signals.json. `url` is the original crawled
      // URL; `internalLinks` are the deduplicated, normalized same-origin targets
      // (normalizeUrl already applied in parse.mjs). Consumed by the link-integrity
      // detectors (links:internal-broken / links:internal-redirect).
      edges:       edges.map(e => ({ url: e.url, internalLinks: e.internalLinks ?? [] })),
    },
  };
  writeFileAtomic(signalsPath, JSON.stringify(signalsOut, null, 2));

  return { csvPath, signalsPath, siteType, stats };
}
