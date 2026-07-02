/**
 * analyze/detectors/performance.mjs — detectors for config/rules/performance.json.
 *
 * Split out of analyze/engine.mjs verbatim (behaviour-neutral). Each entry is
 * [id, detector]; engine.mjs imports `detectors` and registers them into the registry.
 */

import { contentRows } from './_shared.mjs';

export const detectors = [

// onpage:non-modern-image-format — pages with JPG images but no WebP/AVIF alternative.
// Switching to WebP/AVIF reduces image payload by 25-50 % and improves CWV (LCP).
// NOTE: CrUX/PSI field data (real-user CWV) is Roadmap/optional and NOT part of D2.
['onpage:non-modern-image-format', (ctx) => {
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => {
    const jpg  = parseInt(r.imgJpg,  10);
    const webp = parseInt(r.imgWebp, 10);
    const avif = parseInt(r.imgAvif, 10);
    if (isNaN(jpg) || jpg === 0) return false;
    return (isNaN(webp) || webp === 0) && (isNaN(avif) || avif === 0);
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Bilder in Legacy-Format (JPG) ohne WebP/AVIF-Alternative',
  };
}],

// perf:text-compression-missing — HTML response without text compression (no gzip/br/deflate/zstd).
// Uncompressed HTML increases transfer size and slows page load. Performance heuristic, NOT a ranking signal.
// Source: Lighthouse / Chrome DevTools "Enable text compression" (uses-text-compression).
['perf:text-compression-missing', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => {
    const enc = (r.contentEncoding ?? '').toLowerCase();
    return !/\b(gzip|br|deflate|zstd)\b/.test(enc);
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'HTML-Antwort ohne Text-Kompression (kein Content-Encoding gzip/br/deflate/zstd) — unkomprimiertes HTML erhöht die Transfergröße und verlangsamt das Laden. Empfehlung: gzip oder Brotli serverseitig aktivieren. Performance-Heuristik, KEIN Google-Ranking-Signal. Hinweis: erkannt wird nur der Content-Encoding-Header der gecrawlten Antwort.',
  };
}],

// perf:cwv-field-fail — a Core Web Vital's field p75 (CrUX, real Chrome users, 28-day rollup) is NOT in
// "good" (needs-improvement or poor). Runtime/external overlay (only when enriched). Provenance: gemessen.
// Measured perf issue — NOT a ranking-magnitude claim.
['perf:cwv-field-fail', (ctx, params) => {
  const rs = ctx.runtimeSignals;
  const crux = rs?.crux;
  if (!rs?.available || !crux || crux.noData) return { skipped: true }; // not enriched → not evaluated
  const labels = { lcp: 'LCP', inp: 'INP', cls: 'CLS' };
  const fails = ['lcp', 'inp', 'cls']
    .map(m => crux[m] && crux[m].category && crux[m].category !== 'good'
      ? `${labels[m]} p75=${crux[m].p75} (${crux[m].category})` : null)
    .filter(Boolean);
  if (fails.length === 0) return { count: 0, affectedUrls: [], detail: '' };
  return {
    count: 1,
    affectedUrls: [],
    detail: `Laut CrUX-Felddaten (echte Chrome-Nutzer, 28-Tage-Rollup, Form-Factor ${crux.formFactor ?? 'PHONE'}, Stand ${rs.generatedAt ?? 'unbekannt'}) liegen folgende Core-Web-Vitals-p75-Werte NICHT im »good«-Bereich: ${fails.join('; ')}. Schwellen (web.dev): LCP ≤ 2500 ms, INP ≤ 200 ms, CLS ≤ 0,10. Direkt GEMESSENER Performance-Mangel (Feld-/Realnutzerdaten) — keine Aussage über das Ausmaß eines Ranking-Einflusses. Hinweis: Felddaten ändern sich über das 28-Tage-Fenster.`,
  };
}],

];
