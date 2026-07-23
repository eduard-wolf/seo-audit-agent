#!/usr/bin/env node
/**
 * report/build-report.mjs — Unit G: deterministic HTML report renderer (Layer 5).
 *
 * Turns a schema-valid findings.json (LLM output, Layer 3) into the delivered,
 * self-contained HTML report — the visible artifact. Two non-negotiables:
 *
 *   1. SECURITY. The report embeds crawled, UNTRUSTED strings (foreign titles,
 *      meta descriptions, …). Every string that originates from findings/crawl
 *      is HTML-escaped before it touches the document. No exceptions.
 *   2. Self-contained, no script/external resources; ships a strict CSP
 *      (style-src 'unsafe-inline' for the single inline <style>). Inline CSS
 *      only, no <script> with logic, no inline event handlers,
 *      <meta robots=noindex>. The report is a static document that can be
 *      hosted behind a gate.
 *
 * API:
 *   render(findings) → htmlString     // validates first; throws on invalid input
 *   findChrome(opts) → path | null    // locate an installed Chrome/Chromium
 *   printToPdf(chrome, html, pdf)     // headless-Chrome print; throws on failure
 *
 * CLI:
 *   node report/build-report.mjs <path/to/findings.json> [--no-pdf] [--chrome <pfad>]
 *     → writes report/<host>/index.html, then — as the integrated final step —
 *       prints it to report/<host>/report.pdf via an INSTALLED Chrome/Chromium
 *       in headless mode (--headless --print-to-pdf); LAST, it prints the
 *       HTML path as the single machine-readable stdout line (after the PDF
 *       step, so consumers reading stdout wait for the complete build).
 *       Deliberately NOT Puppeteer/Playwright:
 *       the core stays 0-npm-dependency. Chrome is auto-detected per platform
 *       (macOS/Linux/Windows), overridable via --chrome <pfad> or $CHROME_PATH.
 *       Graceful degradation: no Chrome found → the HTML report ships normally,
 *       the PDF is skipped with a loud warning, exit stays 0. --no-pdf skips
 *       deliberately.
 *
 * Determinism: render() derives the whole document from `findings` alone — no
 * clock, no randomness — so the same findings.json always yields byte-identical
 * HTML. (The underlying LLM synthesis is non-deterministic; the report is the
 * frozen, representative snapshot of one run, as stamped in the footer.)
 * The PDF is a faithful print of that byte-deterministic HTML — same
 * findings.json, same content — but its *bytes* vary across runs (Chrome embeds
 * creation timestamps); byte-level determinism lives in the HTML artifact.
 *
 * No npm dependencies — pure Node.js plus, for the PDF step only, whatever
 * Chrome/Chromium the machine already has.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateFindings } from '../lib/findings-schema.mjs';

// ── escaping ──────────────────────────────────────────────────────────────────

/**
 * HTML-escape an arbitrary value. The single security primitive of this module:
 * every untrusted string passes through here before entering the document.
 * Order matters — `&` must be replaced first.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── small render helpers ───────────────────────────────────────────────────────

/** Escaped <ul> from a list of strings. Returns '' for an empty list. */
function ul(items, cls = '') {
  if (!Array.isArray(items) || items.length === 0) return '';
  const classAttr = cls ? ` class="${cls}"` : '';
  return `<ul${classAttr}>${items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>`;
}

/** Fixed-vocabulary class suffix lookups — never interpolate free text into a class. */
const SEV_CLASS = { hoch: 'hoch', mittel: 'mittel', niedrig: 'niedrig' };
const PROV_CLASS = { gemessen: 'gemessen', beobachtet: 'beobachtet', 'geschätzt': 'geschaetzt' };

/** Severity → German short rationale shown next to the label (text, not colour-only). */
const SEV_HINT = { hoch: 'kritisch', mittel: 'relevant', niedrig: 'gering' };

/** Provenance → lay explanation shown next to the tag (Verständlichkeits-Rubrik). */
const PROV_HINT = {
  gemessen: 'direkt gemessen',
  beobachtet: 'aus den Daten abgelesen',
  'geschätzt': 'fachliche Einschätzung',
};

/** Category slug → lay label (fixed vocabulary; unknown slugs render escaped as-is). */
const CAT_LABEL = {
  geo: 'KI-Sichtbarkeit (GEO)',
  'tech-index': 'Technik & Indexierung',
  'structured-data': 'Strukturierte Daten',
  'on-page': 'Inhalte & Seitentexte',
  performance: 'Ladezeit & Technik',
  crawl: 'Erreichbarkeit & Verlinkung',
  trust: 'Vertrauen & Recht',
  hygiene: 'Technische Hygiene',
  i18n: 'Sprachversionen',
  links: 'Interne Verlinkung',
  a11y: 'Barrierefreiheit',
};

/** siteType → lay hint shown in the hero (fixed vocabulary; unknown types get no hint). */
const SITE_TYPE_HINT = {
  'server-rendered': 'Seiten kommen fertig vom Server — gut für Suchmaschinen',
  'client-rendered': 'Inhalte entstehen erst im Browser — riskant für Suchmaschinen',
};

/**
 * Format an ISO-ish date string as a German date (DD.MM.YYYY) for the hero.
 * Pure string transform — no Date object, no clock, stays deterministic.
 * Non-matching strings render unchanged; the footer keeps the raw value.
 */
function formatDateDE(value) {
  const m = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value;
}

/**
 * Deterministic lay-language derivations from the ICE anchors — no new numbers,
 * only a relabelling of values the interpret step already scored (§2 of
 * skills/interpret.md). Fixed buckets, documented in the report legend:
 *   Aufwand   ← ice.e     (3 = gering, 2 = mittel, 1 = groß)
 *   Priorität ← ice.score (≥18 hoch, ≥8 mittel, sonst niedrig)
 */
const AUFWAND_LABEL = {
  3: ['gering', 'schnell erledigt'],
  2: ['mittel', 'überschaubares Projekt'],
  1: ['groß', 'größeres Vorhaben'],
};
function prioritaetOf(score) {
  if (score >= 18) return ['hoch', 'zuerst angehen'];
  if (score >= 8) return ['mittel', 'bald einplanen'];
  return ['niedrig', 'bei Gelegenheit'];
}

// ── section renderers ──────────────────────────────────────────────────────────

/**
 * Lay-facing action badges: Priorität + Aufwand (derived), Wer (optional field).
 * A finding flagged `keinHandlungsbedarf` renders a single no-action badge
 * instead — Priorität/Aufwand/Wer would contradict its own "nichts zu tun" text.
 */
function renderActionBadges(f) {
  if (f.keinHandlungsbedarf === true) {
    return `<p class="badges badges--action">
        <span class="badge badge--noaction">Kein Handlungsbedarf — dient nur der Einordnung</span>
      </p>`;
  }
  const [prio, prioHint] = prioritaetOf(f.ice.score);
  const [aufwand, aufwandHint] = AUFWAND_LABEL[f.ice.e] || AUFWAND_LABEL[2];
  const wer = (typeof f.wer === 'string' && f.wer.trim() !== '')
    ? `\n        <span class="badge badge--wer">Wer: ${esc(f.wer)}</span>`
    : '';
  return `<p class="badges badges--action">
        <span class="badge badge--prio-${prio}">Priorität: ${prio} — ${prioHint}</span>
        <span class="badge badge--aufwand">Aufwand: ${aufwand} — ${aufwandHint}</span>${wer}
      </p>`;
}

/** Audit-metadata badges: Schweregrad, Provenienz (mit Klartext-Hinweis), ICE, Kategorie. */
function renderAuditBadges(f) {
  const sev = SEV_CLASS[f.severity] || 'mittel';
  const prov = PROV_CLASS[f.prov] || 'geschaetzt';
  const { i, c, e, score } = f.ice;
  return `<p class="badges badges--audit">
        <span class="badge badge--sev-${sev}">Schweregrad: ${esc(f.severity)} (${esc(SEV_HINT[f.severity] || '')})</span>
        <span class="badge badge--prov-${prov}">Provenienz: ${esc(f.prov)} — ${esc(PROV_HINT[f.prov] || '')}</span>
        <span class="badge badge--ice"><abbr title="Impact × Confidence × Ease">ICE</abbr> ${esc(i)} × ${esc(c)} × ${esc(e)} = ${esc(score)} (max. 27)</span>
        <span class="badge badge--cat">Kategorie: ${esc(Object.hasOwn(CAT_LABEL, f.category) ? CAT_LABEL[f.category] : f.category)}</span>
      </p>`;
}

function renderKbSources(kbSources) {
  if (!Array.isArray(kbSources) || kbSources.length === 0) return '';
  const items = kbSources.map((src) => {
    const parts = [src.source, src.heading, src.date]
      .filter((p) => p !== undefined && p !== null && p !== '')
      .map((p) => esc(p));
    return `<li>${parts.join(' · ')}</li>`;
  });
  return `<div class="kb">
          <p class="kb-label">Quellen dieser Empfehlung</p>
          <ul class="kb-list">${items.join('')}</ul>
        </div>`;
}

function renderFinding(f, sectionNum, index) {
  // Lay reading order: Problem → Bedeutung → To-do; the evidence stays fully
  // visible below (non-negotiable), the artifact pointer (beleg) renders muted.
  // The visible "num.index" makes cross-references between findings resolvable.
  const nr = (sectionNum !== undefined && index !== undefined) ? `${esc(sectionNum)}.${esc(index + 1)} ` : '';
  return `<article class="finding finding--sev-${SEV_CLASS[f.severity] || 'mittel'}" id="${esc(f.id)}" aria-labelledby="h-${esc(f.id)}">
      <h3 id="h-${esc(f.id)}" class="finding-title">${nr}${esc(f.title)}</h3>
      ${renderActionBadges(f)}
      <dl class="finding-body">
        <dt>Das Problem</dt><dd>${esc(f.befund)}</dd>
        <dt>Was das für Sie bedeutet</dt><dd>${esc(f.auswirkung)}</dd>
        <dt>Was zu tun ist</dt><dd>${esc(f.empfehlung)}</dd>
        <dt>Zahlen &amp; betroffene Seiten</dt><dd>${esc(f.evidence)}</dd>
        <dt>Datenquelle</dt><dd class="beleg">${esc(f.beleg)}</dd>
      </dl>
      ${renderAuditBadges(f)}
      ${renderKbSources(f.kbSources)}
    </article>`;
}

function renderSection(section) {
  const findings = Array.isArray(section.findings) ? section.findings : [];
  return `<section class="section" id="${esc(section.id)}" aria-labelledby="h-${esc(section.id)}">
      <h2 id="h-${esc(section.id)}" class="section-title">${esc(section.num)}. ${esc(section.title)}</h2>
      ${findings.map((f, i) => renderFinding(f, section.num, i)).join('\n      ')}
    </section>`;
}

function renderToc(sections, { hasStrategy } = {}) {
  // Exec/Konfidenz/Positives always render (their renderers always emit a
  // section); Strategie only when it has content. Link only what is rendered.
  const items = [
    `<li><a href="#h-exec">Zusammenfassung</a></li>`,
    `<li><a href="#h-legend">So lesen Sie diesen Report</a></li>`,
    ...sections.map((s) => `<li><a href="#${esc(s.id)}">${esc(s.num)}. ${esc(s.title)}</a></li>`),
    `<li><a href="#h-conf">Konfidenz</a></li>`,
    `<li><a href="#h-pos">Positives</a></li>`,
    ...(hasStrategy ? [`<li><a href="#h-strat">Strategie</a></li>`] : []),
  ].join('');
  return `<nav class="toc" aria-label="Inhaltsverzeichnis">
      <h2 class="section-title">Inhaltsverzeichnis</h2>
      <ol class="toc-list">${items}</ol>
    </nav>`;
}

/** Count findings by severity across all sections — input to the SVG distribution chart. */
function countSeverities(sections) {
  const counts = { hoch: 0, mittel: 0, niedrig: 0 };
  for (const section of Array.isArray(sections) ? sections : []) {
    for (const f of Array.isArray(section.findings) ? section.findings : []) {
      if (counts[f.severity] !== undefined) counts[f.severity] += 1;
    }
  }
  return counts;
}

/**
 * Deterministic inline SVG stacked-bar of the severity distribution.
 * Segment widths are derived purely from the integer counts (Math.round over a
 * fixed viewBox width — no clock, no randomness), so the same findings.json
 * yields byte-identical SVG. CSP-compatible: inline shapes only, no script.
 * Colour is one channel; the figcaption carries the same counts as text.
 */
function renderSeverityChart(counts) {
  const total = counts.hoch + counts.mittel + counts.niedrig;
  if (total === 0) return '';
  const W = 600;
  const H = 28;
  const segs = [
    { key: 'hoch', fill: 'var(--sev-hoch-bd)' },
    { key: 'mittel', fill: 'var(--sev-mittel-bd)' },
    { key: 'niedrig', fill: 'var(--sev-niedrig-bd)' },
  ];
  let x = 0;
  let acc = 0;
  const rects = [];
  for (const seg of segs) {
    const n = counts[seg.key];
    acc += n;
    const xEnd = Math.round((W * acc) / total);
    const w = xEnd - x;
    if (w > 0) {
      // fill is a fixed-vocabulary CSS var; n/x/w/H are escaped per discipline.
      rects.push(`<rect x="${esc(x)}" y="0" width="${esc(w)}" height="${esc(H)}" fill="${seg.fill}"><title>${esc(seg.key)}: ${esc(n)}</title></rect>`);
    }
    x = xEnd;
  }
  const desc = `Schweregrad-Verteilung: ${esc(counts.hoch)} hoch, ${esc(counts.mittel)} mittel, ${esc(counts.niedrig)} niedrig (${esc(total)} Befunde gesamt).`;
  return `<figure class="sev-dist">
        <svg class="sev-chart" role="img" viewBox="0 0 ${esc(W)} ${esc(H)}" preserveAspectRatio="none" aria-label="${desc}"><title>${desc}</title>${rects.join('')}</svg>
        <figcaption class="sev-dist-legend">Schweregrade — hoch: ${esc(counts.hoch)} · mittel: ${esc(counts.mittel)} · niedrig: ${esc(counts.niedrig)}</figcaption>
      </figure>`;
}

function renderExecSummary(es, sevCounts) {
  const tiles = (es.metrics || [])
    .map((m) => `<div class="tile">${esc(m)}</div>`)
    .join('');
  return `<section class="exec" aria-labelledby="h-exec">
      <h2 id="h-exec" class="section-title">Das Wichtigste in Kürze (Executive Summary)</h2>
      <div class="tiles">${tiles}</div>
      ${renderSeverityChart(sevCounts)}
      <div class="cols">
        <div class="col">
          <h3>Muster</h3>
          ${ul(es.patterns)}
        </div>
        <div class="col">
          <h3>Quick Wins</h3>
          ${ul(es.quickWins, 'wins')}
        </div>
      </div>
    </section>`;
}

/**
 * Static reading guide (Verständlichkeits-Rubrik): explains every badge and
 * field label of the finding cards in lay language. Pure static markup —
 * deterministic by construction.
 */
function renderLegend() {
  return `<section class="legend" aria-labelledby="h-legend">
      <h2 id="h-legend" class="section-title">So lesen Sie diesen Report</h2>
      <p>Jeder Befund beantwortet vier Fragen: <strong>Was ist das Problem?</strong> ·
      <strong>Was bedeutet es für Ihr Geschäft?</strong> ·
      <strong>Was ist zu tun — und wer macht es?</strong> ·
      <strong>Wie dringend und wie aufwendig ist es?</strong>
      Unter „Zahlen &amp; betroffene Seiten“ steht der gemessene Beleg zu jedem Befund —
      keine Empfehlung ohne Beleg. Wo eine Adress-Liste gekürzt ist, liegt die vollständige
      Liste in der Begleitdatei <code>affected-urls.csv</code> (bekommen Sie zusammen mit
      diesem Report bzw. von Ihrer Agentur).</p>
      <dl class="legend-list">
        <div><dt>Priorität</dt><dd>Empfohlene Reihenfolge, abgeleitet aus der ICE-Bewertung: <strong>hoch</strong> = zuerst angehen, <strong>mittel</strong> = bald einplanen, <strong>niedrig</strong> = bei Gelegenheit.</dd></div>
        <div><dt>Aufwand</dt><dd>Grobe Größenordnung der Umsetzung: <strong>gering</strong> = schnell erledigt (oft eine einzelne Einstellung), <strong>mittel</strong> = überschaubares Projekt, <strong>groß</strong> = größeres Vorhaben.</dd></div>
        <div><dt>Wer</dt><dd>Wer die Umsetzung typischerweise übernimmt: <strong>Entwicklung</strong> (Technik/Programmierung), <strong>Redaktion</strong> (Texte/Inhalte) oder <strong>Agentur</strong> (SEO-Betreuung).</dd></div>
        <div><dt>Schweregrad</dt><dd>Wie ernst das Problem fachlich ist — unabhängig davon, wie leicht es sich beheben lässt.</dd></div>
        <div><dt>Provenienz</dt><dd>Woher wir es wissen: <em>gemessen</em> = direkt gemessen beim Abruf Ihrer Seiten, <em>beobachtet</em> = aus den Daten abgelesen, <em>geschätzt</em> = fachliche Einschätzung ohne direkte Messung.</dd></div>
        <div><dt>ICE</dt><dd>Interne Bewertungsformel: Impact × Confidence × Ease (Wirkung × Sicherheit der Aussage × Leichtigkeit der Umsetzung, je 1–3 Punkte). Aus ihr werden Priorität und Aufwand abgeleitet — keine zusätzlich erfundenen Zahlen.</dd></div>
      </dl>
    </section>`;
}

function renderPositives(positives) {
  return `<section class="positives" aria-labelledby="h-pos">
      <h2 id="h-pos" class="section-title">Was bereits gut ist</h2>
      ${ul(positives, 'positives-list') || '<p>Keine positiven Befunde erfasst.</p>'}
    </section>`;
}

/** Whether the strategy section renders — single source of truth for renderer + TOC. */
function strategyHasContent(strategy) {
  return !!(strategy && ((strategy.levers && strategy.levers.length) || (strategy.todos && strategy.todos.length)));
}

function renderStrategy(strategy) {
  if (!strategyHasContent(strategy)) return '';
  return `<section class="strategy" aria-labelledby="h-strat">
      <h2 id="h-strat" class="section-title">Strategie</h2>
      <div class="cols">
        <div class="col"><h3>Hebel</h3>${ul(strategy.levers)}</div>
        <div class="col"><h3>To-dos</h3>${ul(strategy.todos)}</div>
      </div>
    </section>`;
}

function renderConfidence(conf) {
  const warn = conf.minNMet === false;
  const banner = warn
    ? `<p class="warn"><strong>Achtung:</strong> Mindest-Stichprobe nicht erreicht — die Befunde sind indikativ, nicht repräsentativ.</p>`
    : '';
  return `<section class="confidence${warn ? ' confidence--warn' : ''}" aria-labelledby="h-conf">
      <h2 id="h-conf" class="section-title">Konfidenz &amp; Einschränkungen — wie belastbar sind diese Ergebnisse?</h2>
      ${banner}
      <p class="conf-meta">Geprüfte Seiten: ${esc(conf.sampleSize)} · genug für belastbare Aussagen: ${warn ? 'nein' : 'ja'}</p>
      ${ul(conf.caveats) || '<p>Keine zusätzlichen Einschränkungen.</p>'}
    </section>`;
}

function renderHero(meta, host) {
  const coverageStr = (meta.coveragePct == null) ? 'n. v.' : `${esc(meta.coveragePct)} %`;
  const crawledAtStr = (meta.crawledAt == null || meta.crawledAt === '') ? 'unbekannt' : esc(formatDateDE(meta.crawledAt));
  return `<header class="hero">
      <p class="eyebrow">SEO-Audit-Report</p>
      <h1>SEO-Audit: ${esc(host)}</h1>
      <dl class="hero-meta">
        <div><dt>Adresse</dt><dd>${esc(meta.url)}</dd></div>
        <div><dt>Site-Typ</dt><dd>${esc(meta.siteType)}${Object.hasOwn(SITE_TYPE_HINT, meta.siteType) ? ` (${SITE_TYPE_HINT[meta.siteType]})` : ''}</dd></div>
        <div><dt>Geprüfte Seiten</dt><dd>${esc(meta.sampleSize)}</dd></div>
        <div><dt>Abdeckung</dt><dd>${coverageStr} der bekannten Seiten</dd></div>
        <div><dt>Geprüft am (Crawl-Zeitpunkt)</dt><dd>${crawledAtStr}</dd></div>
      </dl>
    </header>`;
}

function renderFooter(meta) {
  const crawledAtFooter = (meta.crawledAt == null || meta.crawledAt === '') ? 'unbekannt' : esc(meta.crawledAt);
  return `<footer class="stamp">
      <p class="stamp-line">Erzeugt aus <code>findings.json</code> · Modell <strong>${esc(meta.modelId)}</strong> · Regelwerk <strong>${esc(meta.rulesetVersion)}</strong> · Crawl <strong>${crawledAtFooter}</strong></p>
      <p class="note">Eingefrorener, repräsentativer Lauf — die LLM-Synthese ist <strong>nicht-deterministisch</strong>. Dieser Report ist eine eingefrorene Momentaufnahme genau dieses Laufs. Für Leser ohne Technik-Hintergrund: Alle Messwerte stammen aus der automatischen, wiederholbaren Prüfung; nur die Formulierung der Bewertung kann zwischen Läufen variieren.</p>
      <p class="note">Bewusst <code>noindex</code>: der Report kann gegatet gehostet werden und soll nicht in Suchmaschinen erscheinen.</p>
      <p class="note legend-ice"><abbr title="Impact × Confidence × Ease">ICE</abbr> = Impact × Confidence × Ease — Bewertung je Befund (Wirkung × Sicherheit der Aussage × Leichtigkeit der Umsetzung, je 1–3).</p>
    </footer>`;
}

// ── stylesheet (inline, CSP-pure) ──────────────────────────────────────────────

const STYLES = `
  :root {
    --bg: #f6f7f9; --surface: #ffffff; --ink: #1a2230; --muted: #5a6573;
    --line: #e3e7ec; --accent: #1f3a8a; --accent-soft: #eef2ff;
    --sev-hoch-bg: #fef3f2; --sev-hoch-bd: #f0998c; --sev-hoch-fg: #97180c;
    --sev-mittel-bg: #fffaeb; --sev-mittel-bd: #f3c34a; --sev-mittel-fg: #93500b;
    --sev-niedrig-bg: #eff8ff; --sev-niedrig-bd: #7cc0f5; --sev-niedrig-fg: #0e4b9b;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 920px; margin: 0 auto; padding: 0 20px 64px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover, a:focus { text-decoration: underline; }
  code { background: #eef1f4; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
  h1, h2, h3 { line-height: 1.25; color: var(--ink); }
  h2.section-title { font-size: 1.4rem; margin: 0 0 16px; padding-bottom: 8px; border-bottom: 2px solid var(--line); }
  h3 { font-size: 1.05rem; margin: 0 0 8px; }

  .hero { background: var(--ink); color: #fff; border-radius: var(--radius); padding: 32px; margin: 28px 0; }
  .hero h1 { color: #fff; margin: 4px 0 18px; font-size: 1.9rem; }
  .eyebrow { text-transform: uppercase; letter-spacing: .14em; font-size: .72rem; color: #aeb9cc; margin: 0; }
  .hero-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin: 0; }
  .hero-meta div { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 10px 12px; }
  .hero-meta dt { font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; color: #aeb9cc; margin: 0 0 3px; }
  .hero-meta dd { margin: 0; font-weight: 600; word-break: break-word; }

  section, .toc { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 24px; margin: 18px 0; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .tile { background: var(--accent-soft); border: 1px solid #d3ddf7; border-radius: 8px; padding: 14px 16px; font-weight: 600; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .col h3 { color: var(--muted); font-size: .82rem; text-transform: uppercase; letter-spacing: .06em; }
  ul, ol { margin: 0; padding-left: 20px; }
  li { margin: 4px 0; }
  ul.wins li { list-style: none; position: relative; padding-left: 22px; }
  ul.wins li::before { content: "→"; position: absolute; left: 0; color: var(--accent); font-weight: 700; }

  .toc-list { columns: 2; column-gap: 28px; }
  @media (max-width: 640px) { .cols, .toc-list { grid-template-columns: 1fr; columns: 1; } }

  .finding { border: 1px solid var(--line); border-left: 5px solid var(--line); border-radius: 8px; padding: 18px 20px; margin: 16px 0; background: #fff; }
  .finding--sev-hoch { border-left-color: var(--sev-hoch-bd); }
  .finding--sev-mittel { border-left-color: var(--sev-mittel-bd); }
  .finding--sev-niedrig { border-left-color: var(--sev-niedrig-bd); }
  .finding-title { word-break: break-word; }

  .badges { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; }
  .badge { display: inline-block; font-size: .76rem; font-weight: 700; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line); background: #f1f3f6; color: var(--ink); }
  .badges--audit { margin: 14px 0 0; }
  .badges--audit .badge { font-weight: 600; opacity: .85; }
  .badge--prio-hoch { background: var(--sev-hoch-bg); border-color: var(--sev-hoch-bd); color: var(--sev-hoch-fg); }
  .badge--prio-mittel { background: var(--sev-mittel-bg); border-color: var(--sev-mittel-bd); color: var(--sev-mittel-fg); }
  .badge--prio-niedrig { background: var(--sev-niedrig-bg); border-color: var(--sev-niedrig-bd); color: var(--sev-niedrig-fg); }
  .badge--aufwand { background: var(--accent-soft); border-color: #d3ddf7; color: var(--accent); }
  .badge--wer { background: #ecfdf3; border-color: #6cd699; color: #066034; }
  .badge--noaction { background: #f1f3f6; border-color: var(--line); color: var(--muted); border-style: dashed; }
  .badge--sev-hoch { background: var(--sev-hoch-bg); border-color: var(--sev-hoch-bd); color: var(--sev-hoch-fg); }
  .badge--sev-mittel { background: var(--sev-mittel-bg); border-color: var(--sev-mittel-bd); color: var(--sev-mittel-fg); }
  .badge--sev-niedrig { background: var(--sev-niedrig-bg); border-color: var(--sev-niedrig-bd); color: var(--sev-niedrig-fg); }
  .badge--prov-gemessen { background: #ecfdf3; border-color: #6cd699; color: #066034; }
  .badge--prov-beobachtet { background: #eef4ff; border-color: #9bb8f0; color: #1d3c87; }
  .badge--prov-geschaetzt { background: #f8f6ef; border-color: #d8cba2; color: #6b5a1e; border-style: dashed; }
  .badge--ice { background: var(--ink); border-color: var(--ink); color: #fff; }
  .badge--cat { background: #f1f3f6; border-color: var(--line); color: var(--muted); }

  .finding-body { display: grid; grid-template-columns: 130px 1fr; gap: 4px 16px; margin: 0; }
  .finding-body dt { font-weight: 700; color: var(--muted); font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; padding-top: 2px; }
  .finding-body dd { margin: 0; }
  @media (max-width: 560px) { .finding-body { grid-template-columns: 1fr; } .finding-body dt { margin-top: 8px; } }

  .finding-body dd.beleg { color: var(--muted); font-size: .84rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-word; }

  .legend-list { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; margin: 14px 0 0; }
  .legend-list div { background: #f7f8fa; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .legend-list dt { font-weight: 700; font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 4px; }
  .legend-list dd { margin: 0; font-size: .92rem; }
  @media (max-width: 640px) { .legend-list { grid-template-columns: 1fr; } }

  .kb { margin-top: 14px; padding: 10px 14px; background: #f7f8fa; border: 1px dashed var(--line); border-radius: 8px; }
  .kb-label { margin: 0 0 4px; font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 700; }
  .kb-list { font-size: .9rem; color: var(--muted); }

  .positives { border-left: 5px solid #6cd699; }
  ul.positives-list li::marker { color: #15a05a; }

  .confidence--warn { border-left: 5px solid var(--sev-hoch-bd); }
  .warn { background: var(--sev-hoch-bg); border: 1px solid var(--sev-hoch-bd); color: var(--sev-hoch-fg); padding: 10px 14px; border-radius: 8px; }
  .conf-meta { color: var(--muted); }

  .stamp { margin-top: 28px; padding: 20px 24px; border-top: 2px solid var(--line); color: var(--muted); font-size: .86rem; }
  .stamp-line { margin: 0 0 8px; }
  .note { margin: 4px 0; }
  .legend-ice abbr { text-decoration: none; font-weight: 700; color: var(--ink); }

  .skip-link { position: absolute; left: -9999px; top: 0; z-index: 100; background: var(--accent); color: #fff; padding: 10px 16px; border-radius: 0 0 8px 0; font-weight: 700; }
  .skip-link:focus { left: 0; }

  .sev-dist { margin: 0 0 20px; }
  .sev-chart { display: block; width: 100%; height: 28px; border-radius: 6px; overflow: hidden; border: 1px solid var(--line); }
  .sev-dist-legend { margin: 6px 0 0; font-size: .8rem; color: var(--muted); }

  /* ── Print / PDF (DIN A4) ───────────────────────────────────────────────────
     Layout contract of the integrated Chrome-headless PDF step (CLI below):
     Chrome runs with --no-pdf-header-footer, so @page owns size, margins and
     the running page counter. The margin boxes (@bottom-*) are CSS Paged
     Media — Chrome ≥ 131 renders them, older engines ignore them silently.
     Static strings only: nothing untrusted is ever interpolated into CSS. */
  @page {
    size: A4;
    margin: 16mm 15mm 18mm;
    @bottom-left { content: "SEO-Audit-Report"; font-size: 8pt; color: #5a6573; }
    @bottom-right { content: counter(page) " / " counter(pages); font-size: 8pt; color: #5a6573; }
  }
  @media print {
    /* Severity colours are an information channel — they must survive print. */
    html { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    body { background: #fff; font-size: 10.5pt; }
    .wrap { max-width: none; padding: 0; }
    .skip-link { display: none; }
    /* Static document: anchors render as plain text, not as interactive links. */
    a { color: var(--ink); text-decoration: none; }
    p, li, dd { orphans: 3; widows: 3; }
    .cols, .toc-list { grid-template-columns: 1fr; columns: 1; }
    section, .toc { padding: 18px 20px; margin: 12px 0; }
    /* No section title orphaned at a page bottom, no card torn across pages. */
    h2.section-title, h3 { break-after: avoid; }
    .finding, .tile, .hero-meta div, .legend-list div, .kb, .sev-dist, .warn, .toc { break-inside: avoid; }
  }
`;

// ── main render ────────────────────────────────────────────────────────────────

/**
 * Render a findings object to a self-contained HTML document.
 *
 * @param {object} findings — must satisfy lib/findings-schema.mjs#validateFindings
 * @returns {string} HTML
 * @throws {Error} if `findings` is schema-invalid (all errors reported)
 */
export function render(findings) {
  const { valid, errors } = validateFindings(findings);
  if (!valid) {
    throw new Error(`Invalid findings.json — cannot render report:\n  - ${errors.join('\n  - ')}`);
  }

  const { meta, execSummary, sections, positives, strategy, confidence } = findings;
  const host = hostOf(meta.url);
  const sevCounts = countSeverities(sections);
  const hasStrategy = strategyHasContent(strategy);

  // <header> is a sibling BEFORE <main> and <footer> a sibling AFTER it, so they
  // map to the banner/contentinfo landmarks (a <header>/<footer> nested in <main>
  // would degrade to role=generic). The .wrap centering/padding moves to the
  // surrounding div, keeping the rendered layout identical.
  const mainContent = `${renderExecSummary(execSummary, sevCounts)}
      ${renderToc(sections, { hasStrategy })}
      ${renderLegend()}
      ${renderConfidence(confidence)}
      ${sections.map(renderSection).join('\n      ')}
      ${renderPositives(positives)}
      ${renderStrategy(strategy)}`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>SEO-Audit-Report — ${esc(host)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <a class="skip-link" href="#h-exec">Zum Inhalt springen</a>
  <div class="wrap">
    ${renderHero(meta, host)}
    <main>
      ${mainContent}
    </main>
    ${renderFooter(meta)}
  </div>
</body>
</html>
`;
}

/**
 * Extract a filesystem-safe host label from the audited URL.
 * Falls back to a slugified URL when it is not parseable.
 *
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
  let h;
  try {
    h = new URL(url).hostname || 'report';
  } catch {
    h = String(url).replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'report';
  }
  // Never let a path-traversal ('.', '..') or separator-bearing component reach the
  // filesystem writer, which does path.resolve(reportDir, host) — a crafted meta.url
  // with hostname '..' would otherwise write one directory above report/<host>/.
  if (h === '.' || h === '..' || h === '' || /[/\\]/.test(h)) return 'report';
  return h;
}

// ── PDF export (integrated final build step) ──────────────────────────────────
//
// Deliberately NOT Puppeteer/Playwright — the core stays 0-npm-dependency. An
// INSTALLED Chrome/Chromium prints the self-contained, JS-free HTML to a real
// vector PDF (selectable text) via its own CLI: --headless --print-to-pdf.
// The HTML report is the gate artifact; the PDF is the delivery copy — every
// failure path below therefore degrades instead of failing the build.

/** Well-known absolute install locations per platform, checked in order. */
function chromeCandidatePaths(platform, env) {
  if (platform === 'darwin') {
    const home = env.HOME || '';
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ...(home ? [path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')] : []),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      // Edge is Chromium-based and prints identical PDFs — a common fallback.
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((root) => [
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(root, 'Chromium', 'Application', 'chrome.exe'),
      path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]);
  }
  // Linux & friends resolve via $PATH below.
  return [];
}

/** Binary names looked up on $PATH (Linux distros, Homebrew, custom installs). */
const CHROME_PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

/** Minimal which(1): scan $PATH (with $PATHEXT on Windows) for `name`. */
function whichSync(name, env, platform) {
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Locate an installed Chrome/Chromium binary.
 *
 * An `explicit` path (--chrome flag or $CHROME_PATH) is a pin, not a hint: if
 * it does not exist the result is null — we never silently substitute a
 * different browser for one the user named.
 *
 * @param {{explicit?: string|null, platform?: string, env?: object}} [opts]
 * @returns {string|null} absolute path to the binary, or null if none found
 */
export function findChrome({ explicit = null, platform = process.platform, env = process.env } = {}) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  for (const candidate of chromeCandidatePaths(platform, env)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const name of CHROME_PATH_NAMES) {
    const hit = whichSync(name, env, platform);
    if (hit) return hit;
  }
  return null;
}

/**
 * Cheap completeness probe for a written PDF: `%PDF-` magic at byte 0 and a
 * `%%EOF` trailer near the end. Not a full parse — just enough to tell a
 * fully flushed file from a torso after a killed Chrome.
 */
export function pdfLooksComplete(pdfPath) {
  let fd;
  try {
    fd = fs.openSync(pdfPath, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(5, size));
    fs.readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(64, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return head.toString('latin1') === '%PDF-' && tail.toString('latin1').includes('%%EOF');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Print a self-contained HTML file to PDF with installed headless Chrome.
 * Vector output (selectable text), DIN A4 via the @page rule in STYLES;
 * Chrome's own header/footer is disabled so the print stylesheet owns the
 * page. No --user-data-dir: headless mode uses an ephemeral profile of its
 * own (no clash with a running desktop Chrome), and pinning a fresh profile
 * dir makes Chrome on macOS hang at exit AFTER successfully writing the PDF
 * (observed with 141/150).
 *
 * That failure mode also motivates the salvage path: if Chrome errors or
 * hangs past the timeout but the PDF on disk is demonstrably complete
 * (pdfLooksComplete), the artifact is kept and a warning string is returned.
 *
 * @param {string} chromePath — binary from findChrome()
 * @param {string} htmlPath   — the freshly written report HTML
 * @param {string} pdfPath    — destination; caller removes stale copies first
 * @returns {string|null} null on a clean run; a warning note when the PDF was
 *   salvaged from an unclean Chrome exit
 * @throws {Error} when Chrome fails AND no complete PDF was written
 */
export function printToPdf(chromePath, htmlPath, pdfPath, { timeoutMs = 120_000 } = {}) {
  try {
    execFileSync(chromePath, [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-pdf-header-footer',
      '--generate-pdf-document-outline',
      `--print-to-pdf=${path.resolve(pdfPath)}`,
      pathToFileURL(path.resolve(htmlPath)).href,
    ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
  } catch (err) {
    if (pdfLooksComplete(pdfPath)) {
      return `Chrome beendete sich nicht sauber (${err?.code || err?.status || 'Fehler'}), das PDF wurde aber vollständig geschrieben und wird verwendet.`;
    }
    // Drop a partial/torso PDF (Chrome killed mid-write) — an incomplete
    // artifact must never sit next to fresh HTML. Best-effort: a failing
    // removal must not mask the original Chrome error.
    try { fs.rmSync(pdfPath, { force: true }); } catch { /* keep original error */ }
    const stderr = err?.stderr ? String(err.stderr).trim() : '';
    throw new Error(`Chrome headless fehlgeschlagen (${chromePath}): ${err?.message || err}${stderr ? `\n${stderr}` : ''}`);
  }
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`Chrome meldete Erfolg, aber ${pdfPath} wurde nicht geschrieben`);
  }
  return null;
}

// ── CLI entry point ─────────────────────────────────────────────────────────────
// Only runs when invoked directly, not on import.
// pathToFileURL (not `file://${argv[1]}`) so the guard also matches on Windows
// (drive letter + backslashes) — otherwise the CLI would be a silent no-op there.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let inPath = null;
  let noPdf = false;
  let chromeFlag = null;
  let argError = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-pdf') noPdf = true;
    else if (arg === '--chrome') {
      // A following flag is NOT a path — refuse instead of eating the flag
      // (`--chrome --no-pdf` must error, not pin Chrome to "--no-pdf").
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) argError = '--chrome braucht einen Pfad';
      else { chromeFlag = next; i += 1; }
    } else if (arg.startsWith('--chrome=')) {
      chromeFlag = arg.slice('--chrome='.length);
      // An empty value must error like the bare form — never silently fall
      // through to $CHROME_PATH/auto-detect (the pin contract of findChrome).
      if (chromeFlag === '') argError = '--chrome braucht einen Pfad';
    } else if (arg.startsWith('--')) argError = `Unbekanntes Flag: ${arg}`;
    else if (inPath === null) inPath = arg;
    else argError = `Unerwartetes Argument: ${arg}`;
  }
  if (!inPath || argError) {
    if (argError) console.error(argError);
    console.error('Usage: node report/build-report.mjs <path/to/findings.json> [--no-pdf] [--chrome <pfad>]');
    process.exit(1);
  }

  let findings;
  try {
    findings = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  } catch (err) {
    console.error(`Cannot read/parse ${inPath}: ${err?.message || err}`);
    process.exit(1);
  }

  let html;
  try {
    html = render(findings);
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }

  const host = hostOf(findings.meta?.url);
  const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), host);
  const outFile = path.join(outDir, 'index.html');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, html, 'utf8');

  console.error(`report written: host=${host} bytes=${Buffer.byteLength(html, 'utf8')}`);

  // Integrated final step: print the just-written HTML to report/<host>/report.pdf.
  // First drop any stale PDF — an outdated report.pdf next to fresher HTML is a
  // delivery hazard on every path below (skip, degrade, failure). The removal
  // itself must also degrade: a locked/undeletable stale PDF (EBUSY on Windows
  // while open in a viewer, EACCES on a read-only dir) may never abort the
  // build after gate-ready HTML was written.
  const pdfFile = path.join(outDir, 'report.pdf');
  try {
    fs.rmSync(pdfFile, { force: true });
  } catch (err) {
    console.error(`WARNUNG: altes report.pdf konnte nicht entfernt werden (${err?.code || err}) — es kann veraltet sein und passt evtl. nicht zum frischen HTML.`);
  }
  if (noPdf) {
    console.error('pdf: übersprungen (--no-pdf)');
  } else {
    const explicit = chromeFlag || process.env.CHROME_PATH || null;
    const chrome = findChrome({ explicit });
    if (!chrome) {
      console.error(explicit
        ? `WARNUNG: PDF übersprungen — angegebener Chrome-Pfad existiert nicht: ${explicit} (--chrome/$CHROME_PATH prüfen). HTML-Report liegt vor.`
        : 'WARNUNG: PDF übersprungen — kein installiertes Chrome/Chromium gefunden. HTML-Report liegt vor; für das PDF Chrome installieren oder den Pfad per --chrome/$CHROME_PATH setzen.');
    } else {
      try {
        const note = printToPdf(chrome, outFile, pdfFile);
        if (note) console.error(`WARNUNG: ${note}`);
        console.error(`pdf written: ${pdfFile} bytes=${fs.statSync(pdfFile).size}`);
      } catch (err) {
        console.error(`WARNUNG: PDF-Erzeugung fehlgeschlagen — HTML-Report liegt trotzdem vor.\n${err?.message || err}`);
      }
    }
  }

  console.log(outFile); // stdout = the one machine-readable line: the written path
}
