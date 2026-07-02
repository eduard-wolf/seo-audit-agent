/**
 * analyze/detectors/tech-index.mjs — detectors for config/rules/tech-index.json.
 *
 * Split out of analyze/engine.mjs verbatim (behaviour-neutral). Each entry is
 * [id, detector]; engine.mjs imports `detectors` and registers them into the registry.
 * Detector contract: (ctx, params) → { count, affectedUrls[], detail } | { skipped:true }.
 */

import { isPathAllowed } from '../../crawl/robots-match.mjs';
import {
  isNoindex,
  contentRows,
  pathname,
  rowsByPathname,
  siteHosts,
  isErrorStatusRow,
  isRedirectSourceRow,
} from './_shared.mjs';

export const detectors = [

// crawl:client-rendered — pages where js-guard fired (error=js-guard:empty-body)
['crawl:client-rendered', (ctx) => {
  const affected = ctx.rows.filter(r => r.error === 'js-guard:empty-body');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Client-seitig gerenderte Seiten ohne SSR-Fallback erkannt',
  };
}],

// tech:non-2xx — final status outside 200-299
['tech:non-2xx', (ctx) => {
  const affected = ctx.rows.filter(r => {
    const s = parseInt(r.status, 10);
    return !isNaN(s) && (s < 200 || s >= 300);
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// tech:redirect-chain — redirectChain (pipe-separated) has ≥ params.minChainLength entries (default 2)
['tech:redirect-chain', (ctx, params) => {
  const minChainLength = params?.minChainLength ?? 2;
  const affected = ctx.rows.filter(r => {
    if (!r.redirectChain) return false;
    return r.redirectChain.split('|').filter(Boolean).length >= minChainLength;
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// tech:canonical-missing — canonical tag is absent (empty string) on an INDEXABLE 2xx content
// page. Gated on contentRows (like its canonical siblings): a 410/error page or a js-guard
// (empty as-served body) page has no business being flagged for a missing canonical — that was a
// false positive on non-content rows.
['tech:canonical-missing', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => !r.canonical || r.canonical === '');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Kein rel=canonical gefunden (as-served HTML — bei JS-injizierten Tags ggf. False Positive)',
  };
}],

// tech:canonical-nonself — canonical is set but does not self-reference (canonSelf=0)
// Redirect rows (redirected='1') are excluded: the canonical they carry comes from the
// redirect destination and will never match the original URL, so they always produce
// false positives here.
['tech:canonical-nonself', (ctx) => {
  const affected = ctx.rows.filter(
    r => r.redirected !== '1' && r.canonical && r.canonical !== '' && r.canonSelf === '0',
  );
  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// tech:noindex-conflict — page has noindex AND its pathname is in sitemapUrls
['tech:noindex-conflict', (ctx) => {
  // Build a set of pathname strings from the sitemap URLs
  const sitemapPaths = new Set(
    (ctx.signals.sitemapUrls || [])
      .map(u => pathname(u))
      .filter(Boolean),
  );

  const affected = ctx.rows.filter(r => {
    const hasNoindex = isNoindex(r.robotsMeta);
    if (!hasNoindex) return false;
    const p = pathname(r.url);
    return p !== '' && sitemapPaths.has(p);
  });

  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// tech:sitemap-quality — sitemap URLs whose crawled rows are non-2xx, noindex, or redirected.
//
// Note: non-self-canonical (canonSelf=0) is intentionally excluded here because it is
// already covered by tech:canonical-nonself. Including it would duplicate findings and,
// in test environments where crawl host ≠ canonical host, would create false positives
// for every page in the sitemap.
['tech:sitemap-quality', (ctx) => {
  // Index crawled rows by pathname for O(1) lookup
  /** @type {Map<string, object>} */
  const rowByPath = new Map();
  for (const row of ctx.rows) {
    const p = pathname(row.url);
    if (p) rowByPath.set(p, row);
  }

  const affectedUrls = [];
  for (const sitemapUrl of (ctx.signals.sitemapUrls || [])) {
    const p = pathname(sitemapUrl);
    if (!p) continue;
    const row = rowByPath.get(p);
    if (!row) continue; // not crawled (e.g. robots-disallowed)

    const s          = parseInt(row.status, 10);
    const non2xx     = !isNaN(s) && (s < 200 || s >= 300);
    const noindex    = isNoindex(row.robotsMeta);
    // A sitemap URL that was redirected is itself a bad sitemap entry:
    // the sitemap should list the final canonical URL, not an intermediate redirect.
    const redirected = row.redirected === '1';

    if (non2xx || noindex || redirected) {
      affectedUrls.push(row.url);
    }
  }

  return { count: affectedUrls.length, affectedUrls, detail: '' };
}],

// tech:canonical-target-broken — a page's rel=canonical points to an INTERNAL URL whose own
// crawled row is broken: HTTP >= 400, a redirect SOURCE (redirected/redirectChain), or noindex.
// Google discards a canonical hint whose target is an error/redirect/noindex → the intended
// consolidation/indexing does not take effect. Indexing/consolidation ELIGIBILITY, NOT a ranking
// factor. Targets are matched by pathname (host-ignored, like tech:sitemap-quality), so a canonical
// to the production host resolves to its crawled row; cross-host/uncrawled targets are not found →
// skipped (not flagged). A SELF-referential canonical to the page's own noindex row is NOT reported
// here — that exact situation is owned by tech:noindex-canonical-conflict (page has noindex AND
// declares a canonical), so reporting it here too would be a redundant double-fire. Cross-TARGET
// noindex (a canonical pointing at a DIFFERENT noindex page) still fires.
['tech:canonical-target-broken', (ctx) => {
  const rowByPath = rowsByPathname(ctx.rows);
  const hosts     = siteHosts(ctx.rows);
  const affected  = [];
  for (const r of contentRows(ctx.rows)) {
    if (!r.canonical || r.canonical === '') continue;     // no canonical → not applicable
    let targetUrl;
    try { targetUrl = new URL(r.canonical, r.url); } catch { continue; }
    if (!hosts.has(targetUrl.host)) continue;              // foreign cross-host target → cannot verify → skip
    const target = rowByPath.get(targetUrl.pathname);
    if (!target) continue;                                 // uncrawled path on a known host → cannot verify → skip
    // Self-referential canonical whose ONLY defect is noindex → tech:noindex-canonical-conflict owns it.
    if (target.url === r.url && isNoindex(target.robotsMeta) &&
        !isErrorStatusRow(target) && !isRedirectSourceRow(target)) continue;
    if (isErrorStatusRow(target) || isRedirectSourceRow(target) || isNoindex(target.robotsMeta)) {
      affected.push(r.url);
    }
  }
  return {
    count:        affected.length,
    affectedUrls: affected,
    detail:       'Das rel=canonical dieser Seite zeigt auf eine interne URL, deren eigene gecrawlte Zeile fehlerhaft ist: HTTP ≥ 400, selbst eine Weiterleitung (Redirect-Quelle laut redirected/redirectChain) oder noindex. Google verwirft einen Canonical-Hinweis, dessen Ziel ein Fehler/Redirect/noindex ist — die beabsichtigte Konsolidierung/Indexierung greift dann nicht (die Seite wird ggf. nicht der gewünschten kanonischen URL zugeordnet). Wichtig: geprüft wird die ZEILE des Ziels selbst (redirected/redirectChain), nicht nur dessen finaler Status — der Crawler folgt Redirects, daher zeigt eine Redirect-Quelle als Ziel meist finalen 200. Betrifft die Indexierungs-/Konsolidierungs-Eignung, KEIN Ranking-Faktor. Nur intern gecrawlte Ziele werden geprüft (Cross-Host-Canonicals sind nicht verifizierbar → kein Befund).',
  };
}],

// tech:https — httpsOk=0 OR mixedContent=1
['tech:https', (ctx) => {
  const affected = ctx.rows.filter(
    r => r.httpsOk === '0' || r.mixedContent === '1',
  );
  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// tech:noindex-canonical-conflict — page has noindex AND declares a rel=canonical.
// A noindex removes the page from the index entirely while canonical signals a preferred
// index version — the combination is contradictory and Google recommends against it.
['tech:noindex-canonical-conflict', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    return isNoindex(r.robotsMeta) && r.canonical && r.canonical !== '';
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Seite trägt noindex UND ein rel=canonical — widersprüchliche Indexierungssignale: noindex blockiert die Seite komplett aus der Suche, während canonical eine bevorzugte Index-Version signalisiert. Google empfiehlt, noindex nicht mit rel=canonical zu kombinieren.',
  };
}],

// tech:robots-sitemap-conflict — sitemap URLs whose path is blocked by robots.txt
// for the generic User-agent: *, using RFC-9309 matcher (Allow + wildcards + longest-match).
// Gate on exists===true (like robots-site-blocked/-no-sitemap): an UNREACHABLE robots.txt
// fail-closes to {exists:false, disallow:['/']}, which is a crawler-internal safety, not a
// real site directive — it must not flag every sitemap URL as blocked.
['tech:robots-sitemap-conflict', (ctx) => {
  const sig = ctx.signals.robots;
  const disallow = sig?.disallow ?? [];
  if (sig?.exists !== true || disallow.length === 0) return { count: 0, affectedUrls: [], detail: '' };
  const robots = {
    disallow,
    allow: sig.allow ?? [],
  };
  const affected = [];
  for (const u of (ctx.signals.sitemapUrls ?? [])) {
    let p;
    try {
      const parsed = new URL(u);
      p = parsed.pathname + parsed.search;
    } catch {
      continue; // malformed sitemap URL — skip
    }
    if (!isPathAllowed(p, robots)) affected.push(u);
  }
  return {
    count:        affected.length,
    affectedUrls: affected,
    detail:       'Die Sitemap enthält URL(s), die robots.txt (User-agent: *) per Disallow blockiert — widersprüchliches Signal („indexieren wollen" vs. „crawlen verbieten") und verschwendetes Crawl-Budget. Sitemaps sollten nur crawlbare, indexierbare URLs listen.',
  };
}],

// tech:robots-site-blocked — the generic User-agent: * group disallows the WHOLE site.
// Reuses the RFC-9309 matcher so an overriding `Allow: /` that re-permits the root is
// honored (a bare `Disallow: /` with `Allow: /` is NOT a full block). Gated on exists===true
// so an unreachable robots.txt (fail-closed to {exists:false, disallow:['/']}) does NOT
// produce a false "deliberate block" — see the exists guard below.
['tech:robots-site-blocked', (ctx) => {
  const robots = ctx.signals?.robots;
  // Gate on exists===true: an UNREACHABLE robots.txt fail-closes to {exists:false, disallow:['/']}
  // (RFC 9309 §2.3.1.4). That is NOT a deliberate site-wide block — it is a fetch failure already
  // surfaced by the empty-crawl / pageCount===0 CLI warning — so it must not fire here.
  if (!robots || robots.exists !== true) return { count: 0, affectedUrls: [], detail: '' };
  // isPathAllowed reads robots.disallow / robots.allow (the User-agent: * group).
  if (isPathAllowed('/', robots) !== false) return { count: 0, affectedUrls: [], detail: '' };
  return {
    count:        1,
    affectedUrls: [],
    detail:       'robots.txt sperrt für User-agent: * die gesamte Site (Disallow: / ohne überschreibendes Allow: /, RFC-9309-Matcher). Das verhindert das CRAWLEN sämtlicher URLs durch Suchmaschinen — extern verlinkte URLs können zwar weiterhin URL-only (ohne Titel/Snippet) im Index erscheinen, ihr Inhalt wird aber nicht abgerufen. Betrifft die Crawl-/Indexierungs-Eignung, KEIN Ranking-Faktor. Falls beabsichtigt (z. B. Staging-Umgebung), kann der Befund ignoriert werden.',
  };
}],

// tech:robots-noindex-directive — robots.txt carries a line-anchored `noindex:` directive.
// Google dropped support for the unofficial robots.txt `noindex` directive effective
// 2019-09-01, so the line is INEFFECTIVE (it does NOT deindex). Line-anchored + case-insensitive
// so a commented (`# noindex: …`) or in-value (`Disallow: /noindex/`) occurrence does not match.
['tech:robots-noindex-directive', (ctx) => {
  const raw = ctx.signals?.robots?.raw ?? '';
  if (!/^[ \t]*noindex[ \t]*:/im.test(raw)) return { count: 0, affectedUrls: [], detail: '' };
  return {
    count:        1,
    affectedUrls: [],
    detail:       'robots.txt enthält eine noindex:-Zeile. Google hat die Unterstützung für die inoffizielle robots.txt-noindex-Direktive zum 2019-09-01 eingestellt — die Zeile ist daher WIRKUNGSLOS und entfernt die betroffenen URLs NICHT aus dem Index (sie suggeriert nur fälschlich eine Deindexierung). Zum Deindexieren stattdessen meta-robots noindex oder den HTTP-Header X-Robots-Tag: noindex verwenden. Betrifft die Indexierungs-Eignung, KEIN Ranking-Faktor.',
  };
}],

// tech:robots-no-sitemap — robots.txt declares no `Sitemap:` directive (sitemapRefs empty).
// A Sitemap reference in robots.txt lets crawlers discover the sitemap autonomously; it is
// RECOMMENDED, not an error (severity niedrig). Guarded on robots presence so synthetic test
// contexts without a robots object yield a positive rather than a spurious finding.
['tech:robots-no-sitemap', (ctx) => {
  const robots = ctx.signals?.robots;
  // Gate on exists===true: don't claim "no Sitemap directive" when robots.txt was simply
  // unreachable (fail-closed {exists:false, sitemapRefs:[]}) — that is a fetch failure, not a
  // missing directive.
  if (!robots || robots.exists !== true) return { count: 0, affectedUrls: [], detail: '' };
  if ((robots.sitemapRefs ?? []).length > 0) return { count: 0, affectedUrls: [], detail: '' };
  return {
    count:        1,
    affectedUrls: [],
    detail:       'robots.txt enthält keine Sitemap:-Direktive. Eine Sitemap-Referenz in robots.txt hilft Suchmaschinen, die Sitemap autonom zu finden (empfohlen, kein Fehler). Empfehlung: eine Zeile „Sitemap: <absolute-URL>" ergänzen — zusätzlich (nicht alternativ) zur Einreichung in der Search Console. Betrifft die Crawl-Discovery, KEIN Ranking-Faktor.',
  };
}],

// tech:robots-blocked-resources — pages whose referenced SAME-ORIGIN CSS/JS resource
// paths (parse-time `resourcePaths`) are Disallow-blocked for User-agent: * per the
// RFC-9309 matcher. Google cannot render JS/CSS it is not allowed to fetch, so the
// page may render incompletely (mobile-first: keep CSS & JS crawlable). Mirrors
// tech:robots-sitemap-conflict: gate on exists===true so a fail-closed unreachable
// robots.txt (disallow:['/']) does not flag every render resource off a synthetic directive.
['tech:robots-blocked-resources', (ctx) => {
  const sig = ctx.signals.robots;
  const disallow = sig?.disallow ?? [];
  if (sig?.exists !== true || disallow.length === 0) return { count: 0, affectedUrls: [], detail: '' };
  const robots = { disallow, allow: sig.allow ?? [] };
  const affected = contentRows(ctx.rows).filter(r => {
    const paths = (r.resourcePaths ?? '').split('|').filter(Boolean);
    return paths.some(p => !isPathAllowed(p, robots));
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Referenzierte gleich-origin CSS-/JS-Ressource(n) sind in robots.txt (User-agent: *) per Disallow gesperrt — Google kann blockierte Render-Ressourcen nicht abrufen und die Seite ggf. nicht vollständig rendern. Hinweis (as-served): erkannt wird die TATSACHE einer gesperrten Ressource im ausgelieferten HTML, NICHT deren Render-Kritikalität — Eignungs-/Rendering-Risiko, KEIN Ranking-Faktor. Empfehlung: Disallow für die referenzierten CSS-/JS-Pfade entfernen, damit der Googlebot rendern kann.',
  };
}],

// tech:sitemap-scale-limit — site-level: a single sitemap file exceeds the 50,000-URL limit.
// count is 0 or 1; affectedUrls is always empty (site-level finding, no per-URL data).
// When sitemapFiles is present (U3.1+) we check the per-file locCount to avoid false positives
// on multi-file sitemapindex sites whose union exceeds maxLoc but no individual file does.
// Fallback: use sitemapUrls.length (legacy signals without sitemapFiles, e.g. old test ctx).
['tech:sitemap-scale-limit', (ctx, params) => {
  const maxLoc = params?.maxLoc ?? 50000;
  const files = ctx.signals.sitemapFiles;
  if (Array.isArray(files) && files.length > 0) {
    // Per-file path: fire only if at least one file exceeds maxLoc.
    let maxCount = 0;
    let worstUrl = '';
    for (const f of files) {
      if (f.locCount > maxCount) {
        maxCount = f.locCount;
        worstUrl = f.url;
      }
    }
    if (maxCount <= maxLoc) return { count: 0, affectedUrls: [], detail: '' };
    return {
      count:        1,
      affectedUrls: [],
      detail:       `Die Sitemap-Datei ${worstUrl} enthält ${maxCount} URLs (> ${maxLoc}) — das Protokoll (sitemaps.org) erlaubt max. 50.000 URLs / 50 MB pro Datei; darüber wird die Datei nicht vollständig verarbeitet. Lösung: in mehrere Sitemaps + einen Sitemap-Index aufteilen.`,
    };
  }
  // Fallback: no sitemapFiles present (legacy signals or plain urlset without index).
  const n = (ctx.signals.sitemapUrls ?? []).length;
  if (n <= maxLoc) return { count: 0, affectedUrls: [], detail: '' };
  return {
    count:        1,
    affectedUrls: [],
    detail:       `Eine einzelne Sitemap-Datei enthält ${n} URLs (> ${maxLoc}) — das Protokoll (sitemaps.org) erlaubt max. 50.000 URLs / 50 MB pro Datei; darüber wird die Datei nicht vollständig verarbeitet. Lösung: in mehrere Sitemaps + einen Sitemap-Index aufteilen.`,
  };
}],

// tech:viewport-missing — contentRows pages where viewportContent is empty.
// A missing viewport meta prevents mobile browsers from rendering pages at the
// correct scale. Source: Google Mobile-First Indexing Best Practices (2025-12).
// Framed as mobile-usability prerequisite — NOT a direct ranking score claim.
['tech:viewport-missing', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => (r.viewportContent ?? '') === '');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Fehlendes <meta name="viewport"> — mobile Browser können die Seite nicht korrekt skalieren (Responsive-Design-Voraussetzung). (as-served HTML — bei JS-injizierten Tags ggf. False Positive)',
  };
}],

// tech:charset-missing — contentRows pages where charsetOk is not '1'.
// Per the WHATWG HTML Living Standard the charset declaration must appear
// within the first 1024 bytes of the document.
['tech:charset-missing', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => r.charsetOk !== '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Keine UTF-8-Charset-Deklaration in den ersten 1024 Bytes des HTML gefunden — Browser müssen die Kodierung erraten (Risiko: Darstellungsfehler, Sonderzeichen-Encoding-Bugs). Empfehlung: <meta charset="utf-8"> als erstes Element im <head>. (as-served HTML — bei JS-injizierten Tags ggf. False Positive)',
  };
}],

// tech:canonical-multiple — page declares >1 DISTINCT rel=canonical href. Google then ignores
// ALL canonical hints on the page and falls back to its own canonicalization → consolidation
// defect. Identical duplicate canonicals (distinct count 1) are harmless and do not fire.
// Source: Google Search Central "5 common mistakes with rel=canonical" (2013-04) +
// "How to specify a canonical" (2026-03).
['tech:canonical-multiple', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => Number(r.canonicalCount ?? 0) > 1);
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Seite deklariert mehrere rel=canonical-Tags mit unterschiedlichen Ziel-URLs — Google ignoriert dann laut Dokumentation ALLE Canonical-Hinweise dieser Seite und fällt auf die eigene Kanonisierung zurück. Die beabsichtigte kanonische URL wird möglicherweise nicht konsolidiert (Indexierungs-/Konsolidierungsdefekt). Mehrere identische Canonicals sind unkritisch.',
  };
}],

// tech:x-robots-noindex — X-Robots-Tag response header contains noindex or none.
// Reuses the existing isNoindex() helper (same tokenisation as meta-robots).
// The header is invisible in View Source — often an unintentional CDN/staging guard.
['tech:x-robots-noindex', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => isNoindex(r.xRobotsTag));
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'HTTP-Header X-Robots-Tag: noindex (oder none) erkannt — die Seite wird wie bei einem meta-robots-noindex aus dem Google-Index ausgeschlossen. Der Header liegt im HTTP-Response, nicht im HTML, ist daher bei „View Source" unsichtbar und oft unbeabsichtigt. Falls beabsichtigt (z. B. Staging-/CDN-Guard), kann der Befund ignoriert werden. KEIN Ranking-Signal.',
  };
}],

// tech:hsts-missing — HTTPS page without Strict-Transport-Security header.
// Gated on httpsOk='1': HTTP pages cannot send HSTS (RFC 6797 forbids it).
['tech:hsts-missing', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => r.httpsOk === '1' && r.hstsPresent !== '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'HTTPS-Seite ohne Strict-Transport-Security-Header (HSTS). HSTS erzwingt HTTPS im Browser und verhindert Protocol-Downgrade-/SSL-Stripping-Angriffe — eine Sicherheits-Härtungsmaßnahme. KEIN Google-Ranking-Signal (John Mueller: „HSTS does not affect Search").',
  };
}],

// tech:frame-protection-missing — page has neither X-Frame-Options nor CSP frame-ancestors.
// Both protect against Clickjacking; CSP frame-ancestors is the modern successor.
['tech:frame-protection-missing', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => r.frameProtection !== '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Seite ohne Clickjacking-Schutz: weder X-Frame-Options noch CSP frame-ancestors gesetzt. Ohne einen dieser Header kann die Seite in fremde <iframe>s eingebettet werden (Clickjacking-Risiko). CSP frame-ancestors ist der moderne Nachfolger von X-Frame-Options; einer genügt. Sicherheitsbefund, KEIN Ranking-Signal.',
  };
}],

// tech:nosniff-missing — response lacks X-Content-Type-Options: nosniff.
['tech:nosniff-missing', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => r.nosniffPresent !== '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Antwort ohne X-Content-Type-Options: nosniff. Ohne diesen Header darf der Browser den MIME-Type per Content-Sniffing erraten — das kann z. B. hochgeladene Dateien als ausführbares Skript interpretieren (MIME-Confusion-/XSS-Risiko). Setze X-Content-Type-Options: nosniff. KEIN Ranking-Signal — Trust/Security-Härtung (keine Rich-Result-Eignung).',
  };
}],

// tech:referrer-policy-missing — response lacks a Referrer-Policy header.
['tech:referrer-policy-missing', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => r.referrerPolicyPresent !== '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Antwort ohne Referrer-Policy-Header. Ohne explizite Policy kann der vollständige Referer (inkl. Pfad/Query) an Drittseiten übertragen werden und so interne URLs/Tokens leaken. Empfehlung: z. B. strict-origin-when-cross-origin. KEIN Ranking-Signal — Trust/Security-Härtung (keine Rich-Result-Eignung).',
  };
}],

// tech:permissions-policy-missing — response lacks a Permissions-Policy header.
['tech:permissions-policy-missing', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => r.permissionsPolicyPresent !== '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Antwort ohne Permissions-Policy-Header. Dieser Header schränkt ein, welche Browser-Features (Kamera, Mikrofon, Geolocation, Payment usw.) die Seite und ihre eingebetteten Drittinhalte nutzen dürfen. Fehlt er, gelten die Default-Berechtigungen — größere Angriffsfläche bei kompromittierten Skripten/Frames. KEIN Ranking-Signal — Trust/Security-Härtung (keine Rich-Result-Eignung).',
  };
}],

// tech:csp-missing — response lacks a Content-Security-Policy header (overall presence).
// Distinct from tech:frame-protection-missing, which only checks CSP frame-ancestors.
['tech:csp-missing', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => r.cspPresent !== '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Antwort ohne Content-Security-Policy (CSP). CSP ist die wichtigste Abwehrschicht gegen Cross-Site-Scripting und Daten-Injection: sie schränkt ein, aus welchen Quellen Skripte/Styles/Frames geladen werden dürfen. (Hinweis: separat zu prüfen vom Clickjacking-Schutz frame-ancestors.) KEIN Ranking-Signal — Trust/Security-Härtung (keine Rich-Result-Eignung).',
  };
}],

// tech:cookie-insecure — a served Set-Cookie misses Secure/HttpOnly/SameSite.
// Gated in fetch.mjs: cookieInsecure='1' ONLY when a Set-Cookie was served and is
// insecure; without any Set-Cookie the flag is '0', so the rule does not fire.
['tech:cookie-insecure', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => r.cookieInsecure === '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Set-Cookie ohne vollständige Schutz-Attribute: mindestens ein Cookie fehlt Secure, HttpOnly oder SameSite. Secure verhindert Übertragung über unverschlüsseltes HTTP, HttpOnly schützt vor JS-Zugriff (XSS-Cookie-Diebstahl), SameSite mindert CSRF. Session-Cookies sollten alle drei setzen. KEIN Ranking-Signal — Trust/Security-Härtung (keine Rich-Result-Eignung).',
  };
}],

// tech:version-disclosure — Server (with version token) or X-Powered-By exposes software/version.
['tech:version-disclosure', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => r.versionDisclosure === '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Response-Header legt Server-Software/Version offen (Server: …/<Version> oder X-Powered-By). Solche Banner erleichtern Angreifern das gezielte Ausnutzen versionsspezifischer Schwachstellen — Best Practice ist das Entfernen/Verschleiern. KEIN Ranking-Signal — Trust/Security-Härtung (keine Rich-Result-Eignung).',
  };
}],

// tech:http-not-redirected — the http:// origin serves content (2xx) WITHOUT a 301/308 to https, while
// an https version exists. Google recommends the http→https redirect as the strongest canonicalization
// signal + for security. Gated on "https exists" so it never overlaps tech:https (no-HTTPS-at-all).
// HTTPS is a weak ranking signal; the redirect itself is best-practice, NOT a separate ranking factor.
['tech:http-not-redirected', (ctx) => {
  const probe = ctx.signals?.httpProbe;
  if (!probe || !probe.reachable) return { count: 0, affectedUrls: [], detail: '' };
  const hasHttps = (ctx.rows ?? []).some(r => r.httpsOk === '1');   // https version exists
  if (!hasHttps || probe.redirectsToHttps) return { count: 0, affectedUrls: [], detail: '' };
  return {
    count: 1,
    affectedUrls: [],
    detail: 'Die HTTP-Version der Domain liefert Inhalte (2xx) ohne serverseitige Weiterleitung (30x) zur HTTPS-Version, obwohl eine HTTPS-Version existiert. Google empfiehlt die HTTP→HTTPS-Weiterleitung als stärkstes Kanonisierungssignal und zur Vermeidung unsicherer Verbindungen; ohne sie werden Signale über beide Protokoll-Varianten gesplittet und Nutzende landen ggf. auf der unverschlüsselten Version. HTTPS ist ein schwaches Ranking-Signal — die Weiterleitung selbst ist eine Sicherheits-/Kanonisierungs-Best-Practice, KEIN eigenständiger Ranking-Faktor. (Geprüft via einmaliger HTTP-Origin-Probe.)',
  };
}],

// tech:tls-cert-expiring — the TLS leaf cert is expired / expiring (≤14d) / hostname-mismatch / untrusted.
// Runtime overlay (only when enriched). A broken cert triggers a hard browser block → security/availability
// issue, NOT a ranking factor (HTTPS is only a light signal). Provenance: gemessen (TLS handshake).
['tech:tls-cert-expiring', (ctx, params) => {
  const t = ctx.runtimeSignals?.tls;
  if (!t?.available || !t.data) return { skipped: true };                   // not enriched → not evaluated
  if (!(t.data.issues?.length > 0)) return { count: 0, affectedUrls: [], detail: '' }; // measured-ok → positive
  const labels = { expired: 'abgelaufen', expiring: `läuft in ${t.data.daysLeft} Tagen ab`, mismatch: 'Hostname-Mismatch', untrusted: 'Vertrauenskette ungültig' };
  const parts = t.data.issues.map(i => labels[i] ?? i);
  return {
    count: 1,
    affectedUrls: [],
    detail: `TLS-Zertifikat (${t.data.host}): ${parts.join('; ')} (gültig bis ${t.data.validTo ?? 'unbekannt'}). Ein abgelaufenes/ungültiges Zertifikat löst in modernen Browsern eine harte Sicherheitswarnung aus, die den Seitenaufruf blockiert — ein Sicherheits-/Verfügbarkeitsproblem, das organischen Traffic auf Null ziehen kann. HTTPS ist nur ein leichtes Google-Ranking-Signal; ein Zertifikatsfehler ist primär ein Sicherheits-/UX-Defekt, KEIN Ranking-Faktor. (Geprüft via TLS-Handshake zum Abfragezeitpunkt.)`,
  };
}],

// tech:safe-browsing-flagged — the origin is flagged by Google Safe Browsing (MALWARE / SOCIAL_ENGINEERING
// / UNWANTED_SOFTWARE). Runtime overlay (only when enriched, key-gated). Serious security/trust signal —
// Chrome shows warning interstitials and GSC Security Issues can limit visibility. Point-in-time lookup.
['tech:safe-browsing-flagged', (ctx, params) => {
  const sb = ctx.runtimeSignals?.safeBrowsing;
  if (!sb?.available) return { skipped: true };                  // not enriched → not evaluated
  if (!sb.data?.flagged) return { count: 0, affectedUrls: [], detail: '' }; // measured-clean → positive
  return {
    count: 1,
    affectedUrls: [],
    detail: `Die geprüfte URL (${sb.data.target ?? 'Origin'}) wurde von Google Safe Browsing als Bedrohung markiert: ${(sb.data.threatTypes ?? []).join(', ') || 'unbekannt'}. Ein positiver Befund ist ein ERNSTES Sicherheits- und Vertrauenssignal — Chrome zeigt aktive Warn-Interstitials und Google Search Console kann bei Security Issues die Suchsichtbarkeit einschränken. Punktzeit-Lookup zum Abfragezeitpunkt; ein negativer Befund schließt eine spätere Kompromittierung nicht aus. (Gemessen via Safe-Browsing-API.)`,
  };
}],

];
