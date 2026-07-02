/**
 * analyze/detectors/on-page.mjs — detectors for config/rules/on-page.json.
 *
 * Split out of analyze/engine.mjs verbatim (behaviour-neutral). Each entry is
 * [id, detector]; engine.mjs imports `detectors` and registers them into the registry.
 */

import { contentRows, pathname } from './_shared.mjs';

export const detectors = [

// onpage:title-missing — no <title> element
['onpage:title-missing', (ctx) => {
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => !r.title || r.title === '');
  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// onpage:title-long — titleLen > params.maxTitle (default 60)
['onpage:title-long', (ctx, params) => {
  const max      = (params && params.maxTitle) ? params.maxTitle : 60;
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => {
    const len = parseInt(r.titleLen, 10);
    return !isNaN(len) && len > max;
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       `Titel länger als ${max} Zeichen — Heuristik: 60 Zeichen ist eine SERP-Pixel-Faustregel, kein von Google genannter Grenzwert.`,
  };
}],

// onpage:title-dup — same title on >1 URL
['onpage:title-dup', (ctx) => {
  const rows = contentRows(ctx.rows).filter(r => r.title && r.title !== '');
  /** @type {Map<string, string[]>} */
  const titleMap = new Map();
  for (const r of rows) {
    if (!titleMap.has(r.title)) titleMap.set(r.title, []);
    titleMap.get(r.title).push(r.url);
  }
  const affectedUrls = [];
  for (const [, urls] of titleMap) {
    if (urls.length > 1) affectedUrls.push(...urls);
  }
  return { count: affectedUrls.length, affectedUrls, detail: '' };
}],

// onpage:meta-missing — metaMissing=1
['onpage:meta-missing', (ctx) => {
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => r.metaMissing === '1');
  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// onpage:meta-dup — same meta description on >1 URL
['onpage:meta-dup', (ctx) => {
  const rows = contentRows(ctx.rows).filter(
    r => r.metaMissing !== '1' && r.metaDesc && r.metaDesc !== '',
  );
  /** @type {Map<string, string[]>} */
  const descMap = new Map();
  for (const r of rows) {
    if (!descMap.has(r.metaDesc)) descMap.set(r.metaDesc, []);
    descMap.get(r.metaDesc).push(r.url);
  }
  const affectedUrls = [];
  for (const [, urls] of descMap) {
    if (urls.length > 1) affectedUrls.push(...urls);
  }
  return { count: affectedUrls.length, affectedUrls, detail: '' };
}],

// onpage:h1-missing — no H1 OR empty first H1 on a parsed HTML page.
// Fires when:
//   • h1Count===0  — no H1 element at all, or
//   • h1Count===1 AND r.h1.trim()==='' — H1 element present but contains only whitespace
//     (e.g. <h1></h1> or <h1>   </h1>): a common CMS/theme defect that renders as a
//     missing heading visually and for screen readers.
// h1Count==='' is a parser edge (html was null / field not populated): not flagged,
// because contentRows() already excludes wordCount='' rows, but this guard makes
// the intent explicit and safe for future callers that bypass contentRows.
['onpage:h1-missing', (ctx) => {
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => {
    if (r.h1Count === '') return false; // parser edge — field not populated
    const n = parseInt(r.h1Count, 10);
    if (isNaN(n)) return false;
    if (n === 0) return true;  // no H1 element
    // H1 present but first H1 text is empty/whitespace → treat as missing
    return n >= 1 && (r.h1 ?? '').trim() === '';
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// onpage:h1-multi — h1Count > 1
['onpage:h1-multi', (ctx) => {
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => parseInt(r.h1Count, 10) > 1);
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Mehrere H1 sind laut Google kein Ranking-Problem; Hinweis auf Dokumentstruktur/Barrierefreiheit',
  };
}],

// onpage:heading-skip — headingOutline jumps more than 1 level (e.g. h1→h3)
['onpage:heading-skip', (ctx) => {
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => {
    if (!r.headingOutline) return false;
    const levels = r.headingOutline
      .split(',')
      .map(h => { const n = parseInt(h[1], 10); return isNaN(n) ? null : n; })
      .filter(n => n !== null);
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] > levels[i - 1] + 1) return true;
    }
    return false;
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// onpage:alt-missing — imgNoAlt > 0
['onpage:alt-missing', (ctx) => {
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => {
    const n = parseInt(r.imgNoAlt, 10);
    return !isNaN(n) && n > 0;
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// onpage:thin — wordCount < params.minWords (default 100); js-guard already excluded
['onpage:thin', (ctx, params) => {
  const min  = (params && params.minWords) ? params.minWords : 100;
  // contentRows already excludes js-guard AND non-HTML rows (wordCount='')
  const rows = contentRows(ctx.rows);
  const affected = rows
    .filter(r => {
      const n = parseInt(r.wordCount, 10);
      return !isNaN(n) && n < min;
    })
    // Sort thinnest-first so the most problematic pages appear within the 10-URL cap
    .sort((a, b) => parseInt(a.wordCount, 10) - parseInt(b.wordCount, 10));
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       `Wenig Text (< ${min} Wörter) — Kandidat für manuelle Inhaltsprüfung; Google nutzt keine Wortzahl-Schwelle`,
  };
}],

// onpage:html-lang-missing — <html> element has no lang attribute (htmlLang='')
['onpage:html-lang-missing', (ctx) => {
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => (r.htmlLang ?? '').trim() === '');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       '<html> ohne lang-Attribut — Screenreader und Suchmaschinen können die Seitensprache nicht zuverlässig bestimmen. (as-served HTML — bei JS-injizierten Tags ggf. False Positive)',
  };
}],

// onpage:meta-desc-length — meta description outside params.min–params.max (default 70–160)
['onpage:meta-desc-length', (ctx, params) => {
  const min  = params?.min ?? 70;
  const max  = params?.max ?? 160;
  const rows = contentRows(ctx.rows);
  const affected = rows.filter(r => {
    if (r.metaMissing === '1') return false;          // missing is covered by onpage:meta-missing
    const len = parseInt(r.metaDescLen, 10);
    return !isNaN(len) && (len < min || len > max);
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       `Meta-Beschreibung außerhalb ${min}–${max} Zeichen — Heuristik: Google legt keine feste Länge fest; sehr kurze/lange Snippets werden in den Suchergebnissen gekürzt oder beschreiben die Seite unzureichend`,
  };
}],

// onpage:title-short — titleLen >= 1 AND < params.minTitle (default 30); symmetric counterpart to onpage:title-long
['onpage:title-short', (ctx, params) => {
  const min  = params?.minTitle ?? 30;
  const rows = contentRows(ctx.rows);
  const affected = rows.filter(r => {
    const len = parseInt(r.titleLen, 10);
    return !isNaN(len) && len >= 1 && len < min;       // len 0 is "missing", covered by onpage:title-missing
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       `Titel kürzer als ${min} Zeichen — Heuristik (Google schreibt keine Mindestlänge vor); sehr kurze Titel beschreiben den Seiteninhalt oft unzureichend`,
  };
}],

// onpage:viewport-zoom-disabled — viewport present AND zoom is suppressed.
// Fires when user-scalable=no OR maximum-scale < params.minScale (default 2).
// Source: WCAG 2.2 SC 1.4.4 Resize Text (W3C WAI) — text must be enlargeable
// to 200% (= scale 2) without loss of content. user-scalable=no OR
// maximum-scale < 2 violates this. Pages with maximum-scale ≥ 2 are
// WCAG-compliant and must NOT be flagged (anti-overclaim).
// NOT a Google ranking signal — pure accessibility obligation.
['onpage:viewport-zoom-disabled', (ctx, params) => {
  const minScale = params?.minScale ?? 2;
  const affected = contentRows(ctx.rows).filter(r => {
    const vc = (r.viewportContent ?? '').toLowerCase();
    if (vc === '') return false; // absent viewport is handled by tech:viewport-missing
    // user-scalable=no explicitly forbids pinch-zoom
    if (/user-scalable\s*=\s*no\b/.test(vc)) return true;
    // maximum-scale < minScale: zoom restricted below WCAG 200% threshold
    const msMatch = vc.match(/maximum-scale\s*=\s*([\d.]+)/);
    if (msMatch) {
      const ms = parseFloat(msMatch[1]);
      if (!isNaN(ms) && ms < minScale) return true;
    }
    return false;
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       `Viewport unterdrückt Zoom (user-scalable=no oder maximum-scale < ${minScale}) — verletzt WCAG 2.2 SC 1.4.4 „Resize Text" (Level AA): Nutzende müssen Text auf ${minScale * 100} % (= scale ${minScale}) vergrößern können. Barrierefreiheitsproblem — kein Google-Ranking-Signal.`,
  };
}],

// onpage:og-missing — incomplete Open Graph: ≥1 of the 3 core OG props present but ≥1 missing.
// Frames as degraded social/link-preview quality — NOT a Google ranking signal.
// Source: Open Graph Protocol (ogp.me); Google Search Central "Influencing Title Links" (2025-12).
['onpage:og-missing', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => {
    const present = [r.ogTitle, r.ogImage, r.ogUrl].filter(v => (v ?? '') !== '').length;
    return present >= 1 && present < 3;
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Unvollständiges Open-Graph-Markup (mindestens eine Core-Property vorhanden, aber og:title, og:image oder og:url fehlt) — verschlechterte Social-/Link-Previews (LinkedIn, Slack, iMessage usw.). Google kann og:title als mögliche Quelle für den Title-Link nutzen; Open Graph ist KEIN Ranking-Signal. (as-served HTML — bei JS-injizierten Tags ggf. False Positive)',
  };
}],

// onpage:favicon-missing — homepage declares no <link rel=icon> (icon/shortcut/apple-touch).
// Google reads the favicon only from the home page; it is a SERP presentation element, NOT a
// ranking signal. Caveat: this inspects HTML only — a /favicon.ico at the root may still be used.
// Source: Google Search Central "Define a favicon to show in search results" (2026-02-04).
['onpage:favicon-missing', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => pathname(r.url) === '/' && r.hasFavicon !== '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Auf der Startseite wurde kein <link rel="icon"> (bzw. "shortcut icon"/"apple-touch-icon") gefunden. Google liest das Favicon nur von der Homepage und zeigt es als visuelles Attributionselement in den Suchergebnissen — kein Ranking-Signal. Hinweis: Diese Prüfung analysiert nur das HTML; liegt eine /favicon.ico im Site-Root, kann Google trotzdem ein Favicon anzeigen.',
  };
}],

// onpage:img-missing-dimensions — pages with ≥1 <img> lacking explicit width AND/OR height.
// Missing intrinsic dimensions prevent the browser from reserving layout space → Cumulative
// Layout Shift (CLS, a Core Web Vital). Source: web.dev "Optimize CLS" (2025-02).
// Caveat: images sized via CSS aspect-ratio are unaffected — the tool sees only HTML attributes.
['onpage:img-missing-dimensions', (ctx, params) => {
  const minCount = params?.minCount ?? 1;
  const affected = contentRows(ctx.rows).filter(r => Number(r.imgNoDimensions ?? 0) >= minCount);
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Mindestens ein <img> ohne explizite width-/height-Attribute — der Browser kann den Layout-Platz nicht vorab reservieren, was zu Layout-Shift (CLS, Core Web Vital) führen kann. Empfehlung: width und height (oder CSS aspect-ratio) setzen. Hinweis: per CSS aspect-ratio dimensionierte Bilder sind nicht betroffen; diese Prüfung sieht nur HTML-Attribute — bei CSS-seitigem Sizing sind False Positives möglich (per Lighthouse/DevTools verifizieren).',
  };
}],

// onpage:lcp-image-lazy — the FIRST content <img> uses loading="lazy". If that image is the LCP
// element (common for hero images), lazy-loading delays Largest Contentful Paint (a Core Web Vital).
// Source: web.dev "Optimize LCP" (2025-03). Heuristic: the first <img> ≈ LCP candidate.
['onpage:lcp-image-lazy', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => r.firstImgLazy === '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Das erste Content-<img> der Seite nutzt loading="lazy". Ist dieses Bild das LCP-Element (häufig bei Hero-Bildern), verzögert Lazy-Loading den Largest Contentful Paint (Core Web Vital), da die Anfrage erst nach dem CSS-Parsing startet. Empfehlung: das LCP-Bild eager laden (kein loading=lazy), idealerweise mit fetchpriority="high". Heuristik: das erste <img> ist nur ein LCP-Kandidat — per Messung (PageSpeed Insights/DevTools) verifizieren.',
  };
}],

// onpage:excessive-dom — DOM node count (proxy from HTML opening tags) exceeds the Lighthouse
// "excessive DOM size" threshold. Large DOM raises memory/style/layout cost and can hurt INP.
// Source: Lighthouse "Avoid an excessive DOM size" (2024-06). Performance heuristic, NOT a ranking signal.
['onpage:excessive-dom', (ctx, params) => {
  const maxNodes = params?.maxNodes ?? 1400;
  const affected = contentRows(ctx.rows).filter(r => Number(r.domNodeCount ?? 0) > maxNodes);
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       `Die Seite enthält mehr als ${maxNodes} DOM-Knoten (Proxy aus HTML-Opening-Tags) — Lighthouse markiert ab ~800 Knoten als Warnung, ab ~1.400 als kritisch: ein großer DOM erhöht Speicher-, Style- und Layout-Kosten und kann die Interaktivität (INP) verschlechtern. Performance-Heuristik, KEIN Google-Ranking-Signal. Hinweis: der Wert ist ein Proxy und kann vom tatsächlich gerenderten DOM abweichen.`,
  };
}],

// onpage:render-blocking-head — a synchronous <head> <script src> without async/defer/module
// (blocks the HTML parser) OR ≥ maxStyles separate render-blocking stylesheets (a soft hint at
// missing CSS bundling — one/few head stylesheets is NORMAL, not a defect).
// Source: MDN <script> (async/defer; module deferred by default, 2026-05) + web.dev Critical
// Rendering Path. Spec/performance behavior, NOT a Google ranking signal.
['onpage:render-blocking-head', (ctx, params) => {
  const maxStyles = params?.maxStyles ?? 4;
  const affected = contentRows(ctx.rows).filter(r =>
    Number(r.headBlockingScripts ?? 0) >= 1 || Number(r.headBlockingStyles ?? 0) >= maxStyles);
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       `Render-blockierende Ressourcen im <head>: ein synchrones <script src> ohne async/defer (blockiert den HTML-Parser) und/oder ≥ ${maxStyles} separate render-blockierende Stylesheets (möglicher Hinweis auf fehlendes CSS-Bundling — kein Fehler, ein oder wenige Stylesheets sind normal und nötig). Spec-/Performance-Verhalten, KEIN Google-Ranking-Signal. Empfehlung: Head-Scripts mit async/defer versehen oder ans Body-Ende verschieben; nicht-kritisches CSS bündeln/deferren. (type=module ist standardmäßig deferred, media=print ist nicht render-blockierend.)`,
  };
}],

];
