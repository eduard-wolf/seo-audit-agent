/**
 * test/report-clarity.test.mjs — Verständlichkeits-Rubrik im Renderer + Schema.
 *
 * Drei Concerns:
 *   1. Schema     — optionales `wer`-Feld (nicht-leerer String, wenn vorhanden);
 *                   Abwesenheit bleibt valide (Rückwärtskompatibilität der
 *                   committeten Eval-Runs).
 *   2. Ableitung  — der Renderer leitet Aufwand (aus ice.e) und Priorität
 *                   (aus ice.score) DETERMINISTISCH ab: Alltagssprache ohne
 *                   neue, erfundene Zahlen. Feste Buckets:
 *                   e: 3→gering, 2→mittel, 1→groß;
 *                   score: ≥18→hoch, ≥8→mittel, sonst→niedrig.
 *   3. Laien-UI   — Klartext-Feldlabels, Lese-Anleitung (Legende) mit
 *                   Provenienz-Erklärung, Wer-Badge nur wenn vorhanden,
 *                   Escaping auch für `wer`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateFindings } from '../lib/findings-schema.mjs';
import { render } from '../report/build-report.mjs';

const finding = (extra = {}) => ({
  id: 'f-1', title: 'T', category: 'tech-index', severity: 'mittel', prov: 'gemessen',
  befund: 'b', beleg: 'crawl.csv', evidence: 'e', auswirkung: 'a', empfehlung: 'emp',
  ice: { i: 2, c: 2, e: 2, score: 8 }, kbSources: [], ...extra,
});
const base = (findings = [finding()]) => ({
  meta: { url: 'https://x.example/', crawledAt: '2026-01-01', modelId: 'm', rulesetVersion: '1.7.0', sampleSize: 10, coveragePct: 100, siteType: 'server-rendered' },
  execSummary: { metrics: [], patterns: [], quickWins: [] },
  sections: [{ id: 'sec-1', num: 1, title: 'S', findings }],
  positives: [],
  strategy: { levers: [], todos: [] },
  confidence: { sampleSize: 10, minNMet: true, caveats: [] },
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Schema — optionales `wer`
// ─────────────────────────────────────────────────────────────────────────────
describe('validateFindings — optionales wer-Feld', () => {
  it('accepts a finding without wer (backward compatible)', () => {
    assert.equal(validateFindings(base()).valid, true);
  });

  it('accepts wer as a non-empty string', () => {
    const obj = base([finding({ wer: 'Entwicklung' })]);
    assert.equal(validateFindings(obj).valid, true);
  });

  it('accepts combined responsibilities as free text', () => {
    const obj = base([finding({ wer: 'Entwicklung + Redaktion' })]);
    assert.equal(validateFindings(obj).valid, true);
  });

  it('rejects wer as an empty/whitespace string', () => {
    const { valid, errors } = validateFindings(base([finding({ wer: '   ' })]));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('wer')), `errors should name wer: ${errors}`);
  });

  it('rejects wer as a non-string', () => {
    const { valid, errors } = validateFindings(base([finding({ wer: 3 })]));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('wer')), `errors should name wer: ${errors}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Deterministische Ableitung: Aufwand (ice.e) + Priorität (ice.score)
// ─────────────────────────────────────────────────────────────────────────────
describe('render — abgeleitete Aufwand-/Prioritäts-Badges', () => {
  const htmlFor = (ice) => render(base([finding({ ice })]));

  it('score 27 / e=3 → Priorität hoch, Aufwand gering (mit Klartext-Hinweis)', () => {
    const html = htmlFor({ i: 3, c: 3, e: 3, score: 27 });
    assert.ok(html.includes('Priorität: hoch'), 'Priorität hoch bei score 27');
    assert.ok(html.includes('Aufwand: gering'), 'Aufwand gering bei e=3');
    assert.ok(html.includes('schnell erledigt'), 'Klartext-Hinweis für geringen Aufwand');
  });

  it('Bucket-Grenzen: 18→hoch, 12→mittel, 8→mittel, 6→niedrig, 1→niedrig', () => {
    assert.ok(htmlFor({ i: 2, c: 3, e: 3, score: 18 }).includes('Priorität: hoch'));
    assert.ok(htmlFor({ i: 2, c: 2, e: 3, score: 12 }).includes('Priorität: mittel'));
    assert.ok(htmlFor({ i: 2, c: 2, e: 2, score: 8 }).includes('Priorität: mittel'));
    assert.ok(htmlFor({ i: 2, c: 1, e: 3, score: 6 }).includes('Priorität: niedrig'));
    assert.ok(htmlFor({ i: 1, c: 1, e: 1, score: 1 }).includes('Priorität: niedrig'));
  });

  it('Aufwand-Grenzen: e=2→mittel, e=1→groß', () => {
    assert.ok(htmlFor({ i: 2, c: 2, e: 2, score: 8 }).includes('Aufwand: mittel'));
    assert.ok(htmlFor({ i: 3, c: 3, e: 1, score: 9 }).includes('Aufwand: groß'));
  });

  it('Priorität/Aufwand sind reine Ableitungen — die ICE-Badge bleibt sichtbar', () => {
    const html = htmlFor({ i: 3, c: 3, e: 3, score: 27 });
    assert.ok(/3\s*[×x]\s*3\s*[×x]\s*3\s*=\s*27/.test(html), 'ICE-Arithmetik weiterhin sichtbar');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Laien-UI: Wer-Badge, Klartext-Labels, Lese-Anleitung, Escaping
// ─────────────────────────────────────────────────────────────────────────────
describe('render — Wer-Badge (nur wenn vorhanden)', () => {
  it('renders the wer value when present', () => {
    const html = render(base([finding({ wer: 'Entwicklung' })]));
    assert.ok(html.includes('Wer: Entwicklung'), 'Wer-Badge mit Wert');
  });

  it('renders no Wer badge when absent (old findings still render)', () => {
    const html = render(base());
    assert.ok(!html.includes('Wer:'), 'kein leeres Wer-Badge');
  });

  it('HTML-escapes a hostile wer value', () => {
    const html = render(base([finding({ wer: '<script>alert(1)</script>' })]));
    assert.ok(!/<script>alert/.test(html), 'kein aktives Script aus wer');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'wer wird escaped');
  });
});

describe('render — Klartext-Labels + Lese-Anleitung', () => {
  const html = render(base([finding({ wer: 'Redaktion' })]));

  it('labels the finding fields in plain language', () => {
    assert.ok(html.includes('Das Problem'), 'Klartext-Label für befund');
    assert.ok(html.includes('Was das für Sie bedeutet'), 'Klartext-Label für auswirkung');
    assert.ok(html.includes('Was zu tun ist'), 'Klartext-Label für empfehlung');
  });

  it('keeps the evidence visible (Beleg bleibt sichtbar — nicht verhandelbar)', () => {
    assert.ok(html.includes('e</dd>') || html.includes('>e<'), 'evidence-Wert gerendert');
    assert.ok(html.includes('crawl.csv'), 'beleg-Wert gerendert');
  });

  it('ships a reading guide that explains the provenance values in lay terms', () => {
    assert.ok(html.includes('So lesen Sie diesen Report'), 'Lese-Anleitung vorhanden');
    assert.ok(html.includes('direkt gemessen'), 'gemessen erklärt');
    assert.ok(html.includes('fachliche Einschätzung'), 'geschätzt erklärt');
  });

  it('bleibt byte-deterministisch (zweimal rendern → identisch)', () => {
    const obj = base([finding({ wer: 'Agentur' })]);
    assert.equal(render(obj), render(obj));
  });
});

describe('render — Kritik-getriebene Laien-Features', () => {
  it('nummeriert Befunde sichtbar (num.index) — Querverweise werden auflösbar', () => {
    const obj = base([finding({ id: 'f-1' }), finding({ id: 'f-2', title: 'Zweiter' })]);
    const html = render(obj);
    assert.ok(/<h3[^>]*>1\.1 T<\/h3>/.test(html), 'erster Befund als 1.1');
    assert.ok(/<h3[^>]*>1\.2 Zweiter<\/h3>/.test(html), 'zweiter Befund als 1.2');
  });

  it('zeigt die ICE-Skala (max. 27) an der Badge', () => {
    assert.ok(render(base()).includes('(max. 27)'), 'Skala sichtbar — 27 ist einordbar');
  });

  it('übersetzt Kategorie-Kürzel in Klartext (fixed vocabulary, Fallback escaped)', () => {
    const html = render(base([finding({ category: 'tech-index' })]));
    assert.ok(html.includes('Technik &amp; Indexierung'), 'tech-index → Klartext');
    const fallback = render(base([finding({ category: '<kat>' })]));
    assert.ok(fallback.includes('&lt;kat&gt;'), 'unbekannte Kategorie wird escaped durchgereicht');
  });

  it('formatiert das Crawl-Datum im Hero deutsch, Footer behält den Rohwert', () => {
    const html = render(base());
    assert.ok(html.includes('01.01.2026'), 'Hero zeigt DD.MM.YYYY');
    assert.ok(html.includes('2026-01-01'), 'Footer behält den Roh-Zeitstempel (Nachvollziehbarkeit)');
  });

  it('CAT_LABEL ist prototype-sicher: category "constructor" rendert den Slug, kein Objekt-Member', () => {
    const html = render(base([finding({ category: 'constructor' })]));
    assert.ok(html.includes('Kategorie: constructor'), 'Slug wird durchgereicht');
    assert.ok(!html.includes('native code'), 'kein Object.prototype-Member im Output');
  });

  it('Fußzeilen-ICE-Erklärung stimmt mit der Legende überein (Leichtigkeit, nicht "Aufwand")', () => {
    const html = render(base());
    assert.ok(html.includes('Leichtigkeit der Umsetzung'), 'Footer nutzt die Legende-Formulierung');
    assert.ok(!html.includes('× Konfidenz × Aufwand'), 'alte, missverständliche Formel entfernt');
  });

  it('Site-Typ trägt einen Laien-Hinweis (fixed vocabulary)', () => {
    assert.ok(render(base()).includes('fertig vom Server'), 'server-rendered wird erklärt');
  });
});

describe('render + Schema — keinHandlungsbedarf (No-Action-Marker)', () => {
  it('Schema: boolean erlaubt, non-boolean abgelehnt', () => {
    assert.equal(validateFindings(base([finding({ keinHandlungsbedarf: true })])).valid, true);
    const { valid, errors } = validateFindings(base([finding({ keinHandlungsbedarf: 'ja' })]));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('keinHandlungsbedarf')));
  });

  it('ersetzt die Handlungs-Badges durch ein einzelnes No-Action-Badge', () => {
    const html = render(base([finding({ keinHandlungsbedarf: true, wer: 'Agentur' })]));
    assert.ok(html.includes('Kein Handlungsbedarf'), 'No-Action-Badge vorhanden');
    assert.ok(!html.includes('Priorität:'), 'keine widersprüchliche Prioritäts-Badge');
    assert.ok(!html.includes('Aufwand:'), 'keine widersprüchliche Aufwands-Badge');
    assert.ok(!html.includes('Wer:'), 'keine widersprüchliche Wer-Badge');
    assert.ok(/Schweregrad/.test(html), 'Audit-Badges bleiben erhalten');
  });
});
