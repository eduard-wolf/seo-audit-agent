/**
 * analyze/detectors/hygiene.mjs — detectors for config/rules/hygiene.json.
 *
 * Split out of analyze/engine.mjs verbatim (behaviour-neutral). Each entry is
 * [id, detector]; engine.mjs imports `detectors` and registers them into the registry.
 */

import { isNoindex, contentRows } from './_shared.mjs';

export const detectors = [

// hygiene:oos-noindexed — product pages where availability is OutOfStock or SoldOut
// AND the page carries noindex. Google (Mueller) treats noindex like 404: rankings and
// backlinks are lost. Temporarily-OOS pages must stay indexed (HTTP 200 + availability schema).
// Redirect rows excluded via contentRows(): availability/robotsMeta from the redirect destination
// must not be mis-attributed to the original redirect URL.
['hygiene:oos-noindexed', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    const avail   = r.availability ?? '';
    const isOos   = avail.includes('OutOfStock') || avail.includes('SoldOut');
    if (!isOos) return false;
    return isNoindex(r.robotsMeta);
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Temporär ausverkaufte Produkte mit noindex: Google behandelt noindex wie 404 (Ranking-/Backlink-Verlust) — temporär-OOS-Seiten indexiert lassen (HTTP 200 + availability-Schema)',
  };
}],

// hygiene:duplicate-content — structural duplicates: >1 URL shares identical title
// AND meta description. Catches http/https or trailing-slash variants if both are
// crawled. Distinct from onpage:title-dup / onpage:meta-dup which check each field
// individually. Limitation: semantic duplicates (different text, same meaning) and
// near-duplicate bodies are not detected — those require body-hash comparison (D3+).
['hygiene:duplicate-content', (ctx) => {
  const rows = contentRows(ctx.rows).filter(
    r => r.title && r.title !== '' &&
         r.metaMissing !== '1' && r.metaDesc && r.metaDesc !== '',
  );
  /** @type {Map<string, string[]>} */
  const comboMap = new Map();
  for (const r of rows) {
    const key = `${r.title}\x00${r.metaDesc}`;
    if (!comboMap.has(key)) comboMap.set(key, []);
    comboMap.get(key).push(r.url);
  }
  const affectedUrls = [];
  for (const [, urls] of comboMap) {
    if (urls.length > 1) affectedUrls.push(...urls);
  }
  return {
    count:        affectedUrls.length,
    affectedUrls,
    detail:       'Identischer Titel und Meta-Beschreibung auf mehreren URLs (strukturelle Dublette)',
  };
}],

// hygiene:url-inconsistency — site-level URL hygiene / host-canonicalization (Batch 4a).
// Reuses already-collected crawl.csv columns (url/finalUrl/status/redirected); no new crawl.
// Only URLs that directly serve 2xx (redirect SOURCES excluded — a 301 that consolidates
// variants is CORRECT, not an inconsistency) participate in the host / trailing-slash checks.
//   (1) www vs non-www: the same registrable host serves 2xx under both www. and bare forms
//       (canonicalization ambiguity / split signals / wasted crawl budget).
//   (2) trailing-slash: the same host+path serves 2xx both with AND without a trailing slash
//       (two URLs, one resource → duplicate-URL ambiguity).
//   (3) per-URL hygiene HEURISTIC: uppercase letters in the path, underscores, session-id-like
//       params (;jsessionid= / sid= / phpsessid= / sessionid=), or over-length (> maxUrlLength).
// EXPLICITLY a heuristic and NOT a ranking factor: Google's URL-structure guidance targets
// human-readability + de-duplication, not weighting. (Uppercase check strips %XX percent-octets
// first — URL normalization upper-cases hex, which would otherwise false-positive on e.g. /über.)
['hygiene:url-inconsistency', (ctx, params) => {
  const maxLen = params?.maxUrlLength ?? 115;
  const rows   = ctx.rows ?? [];

  /** @type {{url:string, host:string, path:string}[]} */
  const parsed = [];
  for (const r of rows) {
    if (r.redirected === '1') continue;                 // redirect source → consolidating, fine
    const s = parseInt(r.status, 10);
    if (isNaN(s) || s < 200 || s >= 300) continue;      // only live 2xx URLs
    let u;
    try { u = new URL(r.url); } catch { continue; }     // unparseable → skip
    parsed.push({ url: r.url, host: u.host.toLowerCase(), path: u.pathname });
  }

  const issues   = [];
  const affected = new Set();

  // (1) www vs non-www host mix (both serving 2xx)
  const variantsByBase = new Map();
  for (const p of parsed) {
    const base = p.host.replace(/^www\./, '');
    if (!variantsByBase.has(base)) variantsByBase.set(base, new Set());
    variantsByBase.get(base).add(p.host);
  }
  for (const [, variants] of variantsByBase) {
    if (variants.size > 1) {
      issues.push(`www-/Non-www-Mix (${[...variants].sort().join(' + ')}) liefert beide 2xx`);
      for (const p of parsed) if (variants.has(p.host)) affected.add(p.url);
    }
  }

  // (2) trailing-slash inconsistency (same host+path served with AND without a trailing slash)
  const slashGroups = new Map();                        // host|path-without-trailing-slash → Map<path, url>
  for (const p of parsed) {
    if (p.path === '/') continue;                       // root has no trailing-slash twin
    const key = `${p.host}|${p.path.replace(/\/+$/, '')}`;
    if (!slashGroups.has(key)) slashGroups.set(key, new Map());
    slashGroups.get(key).set(p.path, p.url);
  }
  let slashPairs = 0;
  for (const [, forms] of slashGroups) {
    if (forms.size > 1) { slashPairs++; for (const u of forms.values()) affected.add(u); }
  }
  if (slashPairs > 0) {
    issues.push(`Trailing-Slash-Inkonsistenz: ${slashPairs} Pfad(e) werden mit und ohne abschließenden Slash mit 2xx ausgeliefert`);
  }

  // (3) per-URL hygiene heuristic
  let hygCount = 0;
  for (const p of parsed) {
    const reasons = [];
    const decodedPath = p.path.replace(/%[0-9A-Fa-f]{2}/g, ''); // drop percent-octets (always upper-hex)
    if (/[A-Z]/.test(decodedPath)) reasons.push('Großbuchstaben');
    if (p.path.includes('_'))      reasons.push('Unterstriche');
    if (/[;?&](jsessionid|phpsessid|sessionid|sid)=/i.test(p.url)) reasons.push('Session-ID-Parameter');
    if (p.url.length > maxLen)     reasons.push('Überlänge');
    if (reasons.length > 0) { affected.add(p.url); hygCount++; }
  }
  if (hygCount > 0) {
    issues.push(`${hygCount} URL(s) mit Hygiene-Mängeln (Großbuchstaben/Unterstriche/Session-IDs/Länge > ${maxLen} Zeichen)`);
  }

  if (issues.length === 0) return { count: 0, affectedUrls: [], detail: '' };
  return {
    count:        affected.size,
    affectedUrls: [...affected],
    detail:       `URL-Hygiene-/Host-Kanonisierungs-Inkonsistenzen (HEURISTIK, KEIN Ranking-Faktor — Googles URL-Struktur-Leitfaden zielt auf Lesbarkeit und Deduplizierung, nicht auf Gewichtung): ${issues.join('; ')}. Empfehlung: eine kanonische Host- und Trailing-Slash-Variante per 301 erzwingen; sprechende, kleingeschriebene URLs ohne Session-IDs bevorzugen. Mehrdeutige Varianten splitten Signale und verschwenden Crawl-Budget.`,
  };
}],

];
