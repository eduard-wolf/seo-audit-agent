/**
 * analyze/detectors/i18n.mjs — detectors for config/rules/i18n.json.
 *
 * Split out of analyze/engine.mjs verbatim (behaviour-neutral). Each entry is
 * [id, detector]; engine.mjs imports `detectors` and registers them into the registry.
 */

import { normalizeUrl } from '../../crawl/linkgraph.mjs';
import {
  isNoindex,
  contentRows,
  isValidHreflang,
  rowsByPathname,
  siteHosts,
  isErrorStatusRow,
  isRedirectSourceRow,
} from './_shared.mjs';

export const detectors = [

// i18n:hreflang-invalid-code — pages whose hreflang annotation contains at least one
// value that does not conform to Google's required format (ISO 639-1 lang + optional
// ISO 3166-1 Alpha-2 region, or x-default). Structural regex is provably insufficient;
// uses the enumerated ISO allowlist loaded at module scope.
['i18n:hreflang-invalid-code', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    if (!r.hreflang) return false;
    const values = r.hreflang.split(',').map(s => s.trim()).filter(Boolean);
    return values.some(v => !isValidHreflang(v));
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url),
    detail: 'Ungültige hreflang-Werte gefunden — gültig sind nur ISO-639-1-Sprachcode (optional + ISO-3166-1-Alpha-2-Region) oder x-default. Typische Fehler: Unterstrich (en_US statt en-US), Nicht-ISO-Region (en-UK statt en-GB, en-EU), M.49-Region (es-419 wird von Google nicht unterstützt), reine Region.' };
}],

// i18n:hreflang-no-x-default — pages that carry hreflang annotations but none is
// x-default. x-default is RECOMMENDED (not required) by Google for the language-
// selection fallback page. Severity info to reflect recommendation, not requirement.
['i18n:hreflang-no-x-default', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    if (!r.hreflang) return false;
    const values = r.hreflang.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (values.length === 0) return false;
    return !values.includes('x-default');
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url),
    detail: 'hreflang-Annotationen ohne x-default — x-default ist von Google für die Fallback-/Sprachwahl-Seite empfohlen (nicht erforderlich)' };
}],

// i18n:hreflang-on-noindex — pages that bear hreflang annotations AND a noindex
// directive. A noindex page cannot be indexed, so it cannot be a valid member of a
// hreflang language cluster. Logical inference; no direct Google statement is cited.
['i18n:hreflang-on-noindex', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    const count = parseInt(r.hreflangCount, 10);
    if (isNaN(count) || count < 1) return false;
    return isNoindex(r.robotsMeta);
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url),
    detail: 'Seite trägt hreflang-Annotationen UND noindex — eine nicht-indexierbare Seite kann kein gültiges Mitglied eines hreflang-Sprach-Clusters sein' };
}],

// i18n:hreflang-canonical-conflict — pages that have hreflang annotations AND a
// rel=canonical pointing to a different URL (canonSelf='0'). Google recommends a
// self-canonical for each page in a hreflang cluster; a cross-URL canonical
// effectively discards the hreflang annotations for that page.
['i18n:hreflang-canonical-conflict', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    const count = parseInt(r.hreflangCount, 10);
    if (isNaN(count) || count < 1) return false;
    return r.canonical && r.canonical !== '' && r.canonSelf === '0';
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url),
    detail: 'Seite trägt hreflang-Annotationen, aber das rel=canonical zeigt auf eine andere URL — Google empfiehlt ein Self-Canonical (gleiche Sprache); ein fremdes Canonical verwirft die hreflang-Annotationen dieser URL' };
}],

// i18n:hreflang-not-reciprocal — a page's hreflang annotation violates a Google MUST:
//   (a) a target href is not a fully-qualified absolute URL, OR
//   (b) the page does not list ITSELF among its hreflang set (self-reference), OR
//   (c) a link to a CRAWLED target is not reciprocated (that target doesn't link back).
// Google: non-reciprocal/relative/non-self-ref hreflang is IGNORED → wrong localized URL may be served.
// Targeting signal, NOT a ranking factor. Reciprocity only checked for crawled targets (else unverifiable).
['i18n:hreflang-not-reciprocal', (ctx, params) => {
  const rows = contentRows(ctx.rows);
  const parsePairs = s => (s ?? '').split('|').filter(Boolean).map(p => {
    const i = p.indexOf('='); return { lang: p.slice(0, i), href: p.slice(i + 1) };
  });
  const declaredBy = new Map(); // normUrl → Set<normTargetUrl>
  for (const r of rows) {
    declaredBy.set(normalizeUrl(r.url),
      new Set(parsePairs(r.hreflangLinks).map(p => normalizeUrl(p.href)).filter(Boolean)));
  }
  const affected = rows.filter(r => {
    const pairs = parsePairs(r.hreflangLinks);
    if (pairs.length === 0) return false; // no hreflang → not applicable
    const nu = normalizeUrl(r.url);
    const hasRelative   = pairs.some(p => !/^https?:\/\//i.test(p.href));      // (a) absolute MUST
    const selfMissing   = !declaredBy.get(nu).has(nu);                          // (b) self-ref MUST
    let   nonReciprocal = false;                                               // (c) reciprocity MUST (crawled only)
    for (const t of declaredBy.get(nu)) {
      if (t === nu) continue;
      if (declaredBy.has(t) && !declaredBy.get(t).has(nu)) { nonReciprocal = true; break; }
    }
    return hasRelative || selfMissing || nonReciprocal;
  });
  return {
    count: affected.length,
    affectedUrls: affected.map(r => r.url),
    detail: 'Fehlerhafte hreflang-Annotation: relativer (nicht voll-qualifizierter) Ziel-URL, fehlende Self-Referenz, oder nicht-reziproke Verknüpfung zu einer ebenfalls gecrawlten Seite. Google verlangt voll-qualifizierte absolute URLs, dass jede Sprachversion sich selbst UND alle anderen listet, und beidseitige Reziprozität — sonst wird die Annotation ignoriert und ggf. die falsche Sprachversion ausgeliefert. Reziprozität wird NUR für ebenfalls gecrawlte Ziel-URLs geprüft (nicht-gecrawlte Ziele sind nicht verifizierbar → kein Befund). hreflang ist ein Targeting-Signal, KEIN Ranking-Faktor.',
  };
}],

// i18n:hreflang-target-broken — a page's hreflang annotation points to an INTERNAL URL whose own
// crawled row is broken: HTTP >= 400 OR a redirect SOURCE (redirected/redirectChain). Google ignores
// hreflang whose target is an error/redirect → the wrong language/region version may be served.
// Targeting ELIGIBILITY, NOT a ranking factor. Targets matched by pathname (host-ignored, like
// tech:sitemap-quality); cross-host/uncrawled targets are not found → skipped (not flagged). noindex
// targets are intentionally NOT included here (the source-noindex case is owned by
// i18n:hreflang-on-noindex); this rule scopes to non-2xx/redirecting targets per spec.
['i18n:hreflang-target-broken', (ctx) => {
  const rowByPath = rowsByPathname(ctx.rows);
  const hosts     = siteHosts(ctx.rows);
  const affected  = [];
  for (const r of contentRows(ctx.rows)) {
    const pairs = (r.hreflangLinks ?? '').split('|').filter(Boolean);
    if (pairs.length === 0) continue;                      // no hreflang → not applicable
    let isBroken = false;
    for (const pair of pairs) {
      const eq   = pair.indexOf('=');
      const href = eq >= 0 ? pair.slice(eq + 1) : '';
      if (!href) continue;
      let targetUrl;
      try { targetUrl = new URL(href, r.url); } catch { continue; }
      if (!hosts.has(targetUrl.host)) continue;            // foreign cross-host target → cannot verify → skip
      const target = rowByPath.get(targetUrl.pathname);
      if (!target) continue;                               // uncrawled path on a known host → skip
      // A self-hreflang target resolves to this same contentRow (2xx, non-redirect) → never broken.
      if (isErrorStatusRow(target) || isRedirectSourceRow(target)) { isBroken = true; break; }
    }
    if (isBroken) affected.push(r.url);
  }
  return {
    count:        affected.length,
    affectedUrls: affected,
    detail:       'Mindestens ein hreflang-Ziel dieser Seite zeigt auf eine interne URL, deren eigene gecrawlte Zeile fehlerhaft ist: HTTP ≥ 400 oder selbst eine Weiterleitung (Redirect-Quelle laut redirected/redirectChain). Google ignoriert hreflang-Annotationen, deren Ziel ein Fehler/Redirect ist — die korrekte Sprach-/Regionsversion wird dann ggf. nicht ausgeliefert. Geprüft wird die ZEILE des Ziels selbst (redirected/redirectChain), nicht nur dessen finaler Status (der Crawler folgt Redirects). hreflang ist ein Targeting-Signal, KEIN Ranking-Faktor. Nur intern gecrawlte Ziele werden geprüft (nicht-gecrawlte/Cross-Host-Ziele sind nicht verifizierbar → kein Befund).',
  };
}],

// i18n:html-lang-hreflang-mismatch — the SELF-referential hreflang (the entry whose target is
// this page's own URL) declares a primary language that disagrees with the page's <html lang>.
// Both signals are already collected (htmlLang + hreflangLinks columns); zero new extraction.
// Google requires the self-referential hreflang to match the page's actual language — a mismatch
// is a data-quality/localization defect, NOT a ranking factor. Redirect/js-guard rows excluded.
['i18n:html-lang-hreflang-mismatch', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    const htmlLang = (r.htmlLang ?? '').trim().toLowerCase();
    if (!htmlLang) return false;                            // no html lang → onpage:html-lang-missing owns that
    const pairs = (r.hreflangLinks ?? '').split('|').filter(Boolean);
    if (pairs.length === 0) return false;                   // no hreflang → not applicable
    let selfUrl;
    try { selfUrl = new URL(r.url).href; } catch { return false; }
    for (const pair of pairs) {
      const eq   = pair.indexOf('=');
      const lang = eq >= 0 ? pair.slice(0, eq).trim().toLowerCase() : '';
      const href = eq >= 0 ? pair.slice(eq + 1) : '';
      if (!lang || lang === 'x-default' || !href) continue;
      let targetUrl;
      try { targetUrl = new URL(href, r.url).href; } catch { continue; }
      if (targetUrl !== selfUrl) continue;                  // not the self entry
      // Self hreflang found: its primary language subtag must match html lang's.
      if (lang.split('-')[0] !== htmlLang.split('-')[0]) return true;
    }
    return false;
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Der self-referenzielle hreflang-Eintrag dieser Seite (das hreflang, dessen Ziel die eigene URL ist) deklariert eine andere Primärsprache als das <html lang>-Attribut. Google verlangt, dass der self-referenzielle hreflang zur tatsächlichen Seitensprache passt — ein Widerspruch ist ein Lokalisierungs-/Datenqualitäts-Defekt (die falsche Sprachversion kann ausgeliefert werden). KEIN Ranking-Faktor.',
  };
}],

];
