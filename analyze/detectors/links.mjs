/**
 * analyze/detectors/links.mjs — detectors for config/rules/links.json.
 *
 * Split out of analyze/engine.mjs verbatim (behaviour-neutral). Each entry is
 * [id, detector]; engine.mjs imports `detectors` and registers them into the registry.
 */

import { normalizeUrl } from '../../crawl/linkgraph.mjs';
import {
  contentRows,
  rowsByNorm,
  isErrorStatusRow,
  isRedirectSourceRow,
} from './_shared.mjs';

export const detectors = [

// crawl:orphan-page — pages with 0 internal inlinks (from linkgraph.orphans).
// Orphans receive no link equity and are hard for crawlers to discover without sitemap.
['crawl:orphan-page', (ctx) => {
  const orphans = ctx.linkgraph?.orphans ?? [];
  // Only LIVE (2xx), non-redirected HTML pages can be genuine orphans worth fixing.
  // contentRows() already excludes js-guard / non-HTML / redirect-source rows; the
  // status < 400 guard additionally drops error rows (e.g. 410 Gone) that still carry
  // parsed HTML. A 410 page or a redirect source has no internal-link-equity defect to
  // act on, so reporting it as an orphan is a false positive.
  const candidates = contentRows(ctx.rows).filter(r => {
    const s = parseInt(r.status, 10);
    return !isNaN(s) && s < 400;
  });
  // Build the lookup set in normalized key-space so it matches the normalized
  // orphan keys produced by buildLinkGraph (trailing-slash / index.html variants
  // would otherwise never match and genuine orphans would be silently suppressed).
  const candNormSet = new Set(candidates.map(r => normalizeUrl(r.url)));
  // Only report pages that are actually present (and live) in the crawl output.
  // affectedUrls uses the raw r.url for display; we do the match via normalized keys.
  const affectedNorm = new Set(orphans.filter(u => candNormSet.has(u)));
  const affected = candidates
    .filter(r => affectedNorm.has(normalizeUrl(r.url)))
    .map(r => r.url);
  return {
    count:        affected.length,
    affectedUrls: affected,
    detail:       'Seiten ohne interne Eingangslinks',
  };
}],

// links:deep — pages deeper than params.maxDepth (default 4) click-steps from root.
// NOTE: depthByUrl is persisted in signals.json (crawl/run.mjs) → rule is active.
// The detector gracefully returns count=0 when depthByUrl is unavailable
// (e.g. on partial crawl outputs; such pages then appear as positives).
['links:deep', (ctx, params) => {
  const maxDepth   = (params && params.maxDepth != null) ? params.maxDepth : 4;
  const depthByUrl = ctx.linkgraph?.depthByUrl ?? {};
  const affected   = ctx.rows.filter(r => {
    // Normalize r.url for the key lookup: depthByUrl is stored in normalized
    // key-space by buildLinkGraph, so trailing-slash / index.html variants in
    // raw r.url would never match without this normalization step.
    const d = depthByUrl[normalizeUrl(r.url)];
    return typeof d === 'number' && d > maxDepth;
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       `Klicktiefe größer als ${maxDepth} Schritte von der Startseite`,
  };
}],

// links:dead-end — content pages with 0 outgoing internal links (link-equity heuristic).
// Distinct from crawl:orphan-page (0 incoming); this is 0 outgoing.
// NOTE: Google's official docs address incoming links (reachability), not outgoing.
// Zero-outgoing-internal-links is a PageRank/link-equity heuristic, NOT a stated Google prohibition.
['links:dead-end', (ctx) => {
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => parseInt(r.outlinksInternal, 10) === 0);
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Keine ausgehenden internen Links — Sackgasse im Crawl-Graphen; interne Link-Equity fließt von hier nicht weiter (Heuristik, kein von Google benanntes Verbot)',
  };
}],

// links:generic-anchor — links with a generic/non-descriptive text or an empty accessible name.
// Empty links fail WCAG 2.2 SC 2.4.4 (Level A) + 4.1.2; generic text is a usability heuristic
// (W3C F84 / SC 2.4.9 AAA + Google descriptive-link guidance) — NOT a ranking signal. Links with a
// descriptive aria-label/title are not counted.
['links:generic-anchor', (ctx, params) => {
  const minCount = params?.minCount ?? 1;
  const affected = contentRows(ctx.rows).filter(r =>
    (Number(r.genericAnchorCount ?? 0) + Number(r.emptyLinkCount ?? 0)) >= minCount);
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Links mit leerem zugänglichem Namen oder rein generischem Linktext (z. B. „hier", „mehr", „weiterlesen", „click here", „read more"). Leere Links ohne Namen verstoßen gegen WCAG 2.2 SC 2.4.4 (Level A) und 4.1.2; generischer Linktext ist ein Usability-/Klarheits-Hinweis (W3C F84 / SC 2.4.9 AAA) und wird von Google als Empfehlung für beschreibenden Linktext genannt — KEIN dokumentierter Ranking-Faktor. Empfehlung: aussagekräftigen Linktext setzen. (Links mit beschreibendem aria-label/title werden nicht gezählt.)',
  };
}],

// links:internal-broken — a content page whose persisted internal-link adjacency
// (signals.linkGraph.edges) contains an <a href> TARGET whose own crawled row is 4xx/5xx.
// affectedUrls lists the SOURCE pages (where the offending href lives — that's the fix site).
// Sources restricted to contentRows so a redirect-source row (whose adjacency was parsed from the
// redirect DESTINATION) is not mis-attributed. Targets matched in the normalized link-graph
// key-space (same as buildLinkGraph). Crawl-quality/reachability, NOT a direct ranking factor.
['links:internal-broken', (ctx) => {
  const rowByNorm    = rowsByNorm(ctx.rows);
  const linksByNorm  = new Map();
  for (const e of (ctx.linkgraph?.edges ?? [])) linksByNorm.set(normalizeUrl(e.url), e.internalLinks ?? []);
  const affected = [];
  for (const r of contentRows(ctx.rows)) {
    const links = linksByNorm.get(normalizeUrl(r.url));
    if (!links || links.length === 0) continue;
    if (links.some(link => isErrorStatusRow(rowByNorm.get(normalizeUrl(link))))) affected.push(r.url);
  }
  return {
    count:        affected.length,
    affectedUrls: affected,
    detail:       'Mindestens ein interner <a href>-Link dieser Seite zeigt auf eine gleich-origin URL, deren gecrawlte Zeile 4xx/5xx liefert (toter interner Link). Tote interne Links verschwenden Crawl-Budget, vererben keine Link-Equity und verschlechtern Nutzer-/Crawler-Navigation. Empfehlung: den Link auf eine funktionierende URL korrigieren oder entfernen. Betrifft Crawl-Qualität/Erreichbarkeit, KEIN direkter Ranking-Faktor. (Geprüft gegen die gecrawlte Zeile des Linkziels.)',
  };
}],

// links:internal-redirect — a content page whose internal-link adjacency contains an <a href>
// TARGET that is itself a redirect SOURCE (redirected/redirectChain). Linking to a redirect costs
// an extra hop and dilutes internal link-equity — link the FINAL URL instead. affectedUrls lists
// the SOURCE pages. Keys off the target row's redirected/redirectChain (NOT its final status — the
// crawler follows redirects, so a redirected target's row shows the final 2xx). Crawl-quality/
// link-equity, NOT a direct ranking factor.
['links:internal-redirect', (ctx) => {
  const rowByNorm    = rowsByNorm(ctx.rows);
  const linksByNorm  = new Map();
  for (const e of (ctx.linkgraph?.edges ?? [])) linksByNorm.set(normalizeUrl(e.url), e.internalLinks ?? []);
  const affected = [];
  for (const r of contentRows(ctx.rows)) {
    const links = linksByNorm.get(normalizeUrl(r.url));
    if (!links || links.length === 0) continue;
    if (links.some(link => isRedirectSourceRow(rowByNorm.get(normalizeUrl(link))))) affected.push(r.url);
  }
  return {
    count:        affected.length,
    affectedUrls: affected,
    detail:       'Mindestens ein interner <a href>-Link dieser Seite zeigt auf eine gleich-origin URL, die selbst eine Weiterleitung ist (Redirect-Quelle laut redirected/redirectChain). Auf eine Redirect-Quelle zu verlinken kostet einen zusätzlichen Hop, verzögert das Laden und verwässert die interne Link-Equity — direkt auf die finale Ziel-URL verlinken. Geprüft wird die ZEILE des Linkziels selbst (redirected/redirectChain), nicht nur dessen finaler Status. Betrifft Crawl-Qualität/Link-Equity, KEIN direkter Ranking-Faktor.',
  };
}],

];
