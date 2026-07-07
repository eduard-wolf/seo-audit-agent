#!/usr/bin/env node
/**
 * eval/fixtures/_build.mjs — Deterministic synthetic-fixture generator for the
 * eval-harness golden dataset (Phase B, Task 14).
 *
 * Emits the FIVE synthetic archetype fixtures — `ecommerce`, `editorial`,
 * `broken`, `geo`, `clean` — each as an `analysis.json` (the deterministic
 * input the interpret step consumes) plus its `expected-findings.json` (the
 * golden expectations the eval scorers grade against). The SIXTH fixture,
 * `example-run`, is a verbatim copy of the real committed run under
 * `examples/example-run/` (analysis.json + affected-urls.csv) whose
 * `expected-findings.json` is hand-authored here from that run's real findings.
 *
 * WHY A GENERATOR (not hand-written JSON): every finding's `kategorie`,
 * `scope`, `severity`, `title`, `quelle`, and `datum` are pulled from the
 * SOURCE rule definitions in `config/rules/*.json`, and `rulesetVersion` from
 * `config/rules-version.json` — so the fixtures can never drift from the rule
 * config, and `pctOfPages` is COMPUTED (never invented). Compact per-fixture
 * specs (below) carry only the archetype-specific facts (which rules fire, on
 * how many/which synthetic URLs, and the expected mustContain/mustNotContain).
 *
 * DETERMINISM: no Date.now()/Math.random(); every object is built with a fixed
 * key-insertion order and every array in a fixed order, and output is written
 * via `writeFileAtomic` as `JSON.stringify(x, null, 2) + '\n'`. Re-running
 * `node eval/fixtures/_build.mjs` is therefore byte-identical.
 *
 * INVARIANTS baked in (also asserted by test/eval-fixtures.test.mjs):
 *   - finding metadata matches the config rule (kategorie/severity/…);
 *   - `minNMet === (sampleSize >= 5)` and `sampleSize <= pageCount`;
 *   - a site-level sentinel (count === 1 && affectedUrls === []) gets
 *     `pctOfPages === null`; every other finding gets round(count/pageCount*100,1);
 *   - mustContain ⊆ analysis.findings ruleIds; mustNotContain ∩ that set = ∅.
 *
 * Fixtures are neutral/synthetic — the origins are reserved `.test` hosts, with
 * no real domains and no client references.
 *
 * No npm dependencies — pure Node.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from '../../crawl/run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const RULES_DIR = path.join(REPO, 'config', 'rules');
const RULES_VERSION_PATH = path.join(REPO, 'config', 'rules-version.json');
const EXAMPLE_SRC = path.join(REPO, 'examples', 'example-run');
const FIXTURES_DIR = __dirname;

// ── Rule config (single source of truth for finding metadata) ────────────────

/**
 * Load every rule definition under config/rules/*.json into a Map by id.
 * Files are read in sorted order for deterministic Map iteration.
 *
 * @returns {Map<string, object>}
 */
function loadRules() {
  const map = new Map();
  for (const file of fs.readdirSync(RULES_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    const rules = JSON.parse(fs.readFileSync(path.join(RULES_DIR, file), 'utf8'));
    for (const r of rules) map.set(r.id, r);
  }
  return map;
}

const RULES = loadRules();
const RULESET_VERSION = JSON.parse(fs.readFileSync(RULES_VERSION_PATH, 'utf8')).version;

/**
 * Resolve a rule definition by id, throwing loudly on an unknown id so a typo
 * in a fixture spec fails the build instead of silently emitting a bad fixture.
 *
 * @param {string} id
 * @returns {object}
 */
function rule(id) {
  const r = RULES.get(id);
  if (!r) throw new Error(`unknown ruleId in fixture spec: "${id}" (not in config/rules)`);
  return r;
}

/** Round to one decimal place (matches analyze's pctOfPages precision). */
function round1(n) {
  return Math.round(n * 10) / 10;
}

// ── Compact spec → analysis.json shapes ──────────────────────────────────────

/**
 * A page-scoped finding spec: fires on `paths` (relative to the fixture
 * origin). `count` equals the number of affected pages (all ≤ 10 here, so the
 * affectedUrls sample is complete). `pctOfPages` is computed downstream.
 *
 * @param {string} ruleId
 * @param {string[]} paths — page paths (each prefixed with the origin)
 * @param {string} [detail]
 * @returns {{ ruleId: string, paths: string[], detail: string }}
 */
function page(ruleId, paths, detail = '') {
  return { ruleId, paths, detail };
}

/**
 * A site-level sentinel finding spec: count === 1, no affectedUrls, so
 * `pctOfPages` renders as null (e.g. geo:ai-bot-blocked, geo:no-faq-howto).
 *
 * @param {string} ruleId
 * @param {string} [detail]
 * @returns {{ ruleId: string, siteLevel: true, detail: string }}
 */
function site(ruleId, detail = '') {
  return { ruleId, siteLevel: true, detail };
}

/**
 * Materialise one finding object (fixed key order) from a compact spec,
 * pulling all rule metadata from config and computing count/pctOfPages.
 *
 * @param {string} origin
 * @param {{ ruleId: string, paths?: string[], siteLevel?: boolean, detail?: string }} spec
 * @param {number} pageCount
 * @returns {object}
 */
function buildFinding(origin, spec, pageCount) {
  const r = rule(spec.ruleId);
  const affectedUrls = spec.siteLevel ? [] : spec.paths.map(p => origin + p);
  const count = spec.siteLevel ? 1 : affectedUrls.length;
  const isSentinel = count === 1 && affectedUrls.length === 0;
  const pctOfPages = isSentinel ? null : round1((count / pageCount) * 100);
  return {
    ruleId: r.id,
    kategorie: r.kategorie,
    scope: r.scope,
    severity: r.severity,
    title: r.title,
    count,
    pctOfPages,
    affectedUrls,
    clusters: [],
    detail: spec.detail || '',
    quelle: r.quelle,
    datum: r.datum,
  };
}

/**
 * Materialise one positive object (fixed key order) from a ruleId, pulling the
 * title from config.
 *
 * @param {string} ruleId
 * @returns {{ ruleId: string, title: string }}
 */
function buildPositive(ruleId) {
  return { ruleId: rule(ruleId).id, title: rule(ruleId).title };
}

/**
 * Assemble a full analysis.json object (fixed key order) from a fixture spec.
 * Derives `minNMet` from `sampleSize` so the invariant can never be violated.
 *
 * @param {object} fx — fixture spec
 * @returns {object}
 */
function buildAnalysis(fx) {
  const { origin } = fx.meta;
  const host = origin.replace(/^https?:\/\//, '');
  const { pageCount, sampleSize } = fx.meta;
  const meta = {
    origin,
    host,
    crawledAt: null,
    pageCount,
    sampleSize,
    siteType: fx.meta.siteType,
    coveragePct: fx.meta.coveragePct,
    capped: fx.meta.capped,
    fetched: fx.meta.fetched,
    discovered: fx.meta.discovered,
    sitemapTotal: fx.meta.sitemapTotal,
    minNMet: sampleSize >= 5,
  };
  return {
    meta,
    rulesetVersion: RULESET_VERSION,
    findings: fx.findings.map(spec => buildFinding(origin, spec, pageCount)),
    positives: fx.positives.map(buildPositive),
    signals: fx.signals,
  };
}

/**
 * Assemble a full expected-findings.json object (fixed key order) from a spec.
 *
 * @param {string} name
 * @param {{ mustContain: object[], mustNotContain: object[] }} expected
 * @returns {object}
 */
function buildExpected(name, expected) {
  return {
    fixture: name,
    mustContain: expected.mustContain,
    mustNotContain: expected.mustNotContain,
  };
}

/** Stringify with fixed 2-space indent + trailing newline (byte-stable). */
function toJson(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

// ── The five synthetic archetype specs ───────────────────────────────────────

const FIXTURES = [
  // ── ecommerce — structured-data heavy product catalogue ──────────────────
  {
    name: 'ecommerce',
    meta: {
      origin: 'https://example-shop.test', siteType: 'server-rendered',
      pageCount: 15, sampleSize: 15, coveragePct: 94, capped: false,
      fetched: 15, discovered: 16, sitemapTotal: 16,
    },
    findings: [
      page('schema:product-no-aggregate', [
        '/produkt/espresso-crema', '/produkt/hausmischung', '/produkt/entkoffeiniert',
        '/produkt/geschenkbox', '/produkt/filterkaffee', '/produkt/cold-brew',
        '/produkt/kapseln', '/produkt/probierset', '/produkt/abo-box',
      ], 'Produktseiten ohne AggregateRating-Markup (nur mit echten Bewertungen ergänzen).'),
      page('schema:offer-no-price', [
        '/produkt/geschenkbox', '/produkt/abo-box', '/produkt/probierset', '/produkt/kapseln',
      ], 'Offer-Objekt ohne price — nicht für Merchant-Rich-Results qualifiziert.'),
      page('onpage:title-dup', [
        '/produkt/espresso-crema', '/produkt/hausmischung', '/produkt/entkoffeiniert',
        '/produkt/filterkaffee', '/produkt/cold-brew', '/produkt/kapseln',
      ], 'Sechs Produktseiten teilen denselben generischen Seitentitel.'),
      page('onpage:alt-missing', [
        '/produkt/espresso-crema', '/produkt/hausmischung', '/produkt/entkoffeiniert',
        '/produkt/geschenkbox', '/produkt/filterkaffee', '/produkt/cold-brew',
        '/produkt/kapseln', '/produkt/probierset',
      ], 'Produktbilder ohne alt-Attribut.'),
      page('schema:organization-logo', ['/'],
        'Organization-Schema auf der Startseite ohne logo-Eigenschaft.'),
      page('hygiene:oos-noindexed', ['/produkt/saisonale-edition', '/produkt/limited-drop'],
        'Temporär ausverkaufte Produkte fälschlich auf noindex gesetzt.'),
    ],
    positives: [
      'schema:no-organization', 'schema:invalid', 'tech:https',
      'onpage:h1-missing', 'tech:canonical-missing', 'links:internal-broken',
    ],
    signals: { robots: { exists: true }, llms: { exists: false }, aiBots: [] },
    expected: {
      mustContain: [
        { ruleId: 'schema:product-no-aggregate', urlAnchor: 'https://example-shop.test/produkt/espresso-crema', note: 'dominant structured-data gap across the product catalogue' },
        { ruleId: 'schema:offer-no-price', note: 'missing price blocks merchant listing rich results' },
        { ruleId: 'onpage:alt-missing', note: 'image accessibility + image SEO on product pages' },
        { ruleId: 'onpage:title-dup', note: 'duplicate titles across product pages' },
      ],
      mustNotContain: [
        { ruleId: 'schema:invalid', reason: 'JSON-LD parses cleanly (in positives) — must not claim a parse error' },
        { ruleId: 'onpage:title-missing', reason: 'titles exist (duplicated, not missing)' },
        { ruleId: 'tech:noindex-conflict', reason: 'absent from analysis — no noindex-in-sitemap conflict' },
      ],
    },
  },

  // ── editorial — blog/content site ────────────────────────────────────────
  {
    name: 'editorial',
    meta: {
      origin: 'https://example-journal.test', siteType: 'server-rendered',
      pageCount: 12, sampleSize: 12, coveragePct: 92, capped: false,
      fetched: 12, discovered: 13, sitemapTotal: 13,
    },
    findings: [
      page('schema:article-no-author', [
        '/artikel/roestprofile', '/artikel/herkunftslaender', '/artikel/bruehmethoden',
        '/artikel/mahlgrad', '/artikel/lagerung', '/artikel/entkoffeinierung', '/artikel/wasserqualitaet',
      ], 'Artikel-Schema ohne author (E-E-A-T-Signal fehlt).'),
      page('geo:missing-citations', [
        '/artikel/roestprofile', '/artikel/herkunftslaender', '/artikel/bruehmethoden',
        '/artikel/mahlgrad', '/artikel/wasserqualitaet', '/artikel/koffein-mythen',
      ], 'Substanzielle Artikel ohne jegliche externe Quellenangabe (kein Outlink zu einer anderen Domain).'),
      page('geo:content-stale', [
        '/artikel/roestprofile', '/artikel/herkunftslaender', '/artikel/lagerung',
        '/artikel/entkoffeinierung', '/artikel/koffein-mythen',
      ], 'Artikel ohne dateModified — Recency-Signal fehlt.'),
      page('onpage:thin', [
        '/artikel/kurznotiz', '/artikel/pressemitteilung', '/artikel/oeffnungszeiten', '/artikel/danksagung',
      ], 'Sehr kurze Inhaltsseiten — manueller Review-Hinweis.'),
      page('links:deep', [
        '/artikel/archiv/2019/notizen', '/artikel/archiv/2018/rueckblick', '/artikel/archiv/2017/anfaenge',
      ], 'Archivseiten jenseits der maximalen Klicktiefe von der Startseite.'),
      page('crawl:orphan-page', ['/artikel/verwaist', '/artikel/alte-aktion'],
        'Seiten ohne interne Eingangslinks.'),
    ],
    positives: [
      'onpage:title-missing', 'schema:invalid', 'tech:https',
      'onpage:h1-missing', 'geo:ai-bot-blocked', 'schema:no-organization',
    ],
    signals: { robots: { exists: true }, llms: { exists: false }, aiBots: [] },
    expected: {
      mustContain: [
        { ruleId: 'geo:missing-citations', urlAnchor: 'https://example-journal.test/artikel/roestprofile', note: 'strongest GEO lever — content without external citations' },
        { ruleId: 'schema:article-no-author', note: 'E-E-A-T author signal missing across the article set' },
        { ruleId: 'geo:content-stale', note: 'articles lack dateModified recency signal' },
        { ruleId: 'onpage:thin', note: 'several near-empty content pages' },
      ],
      mustNotContain: [
        { ruleId: 'schema:invalid', reason: 'JSON-LD valid (in positives) — no parse error' },
        { ruleId: 'onpage:title-missing', reason: 'every page has a title (in positives)' },
        { ruleId: 'tech:noindex-conflict', reason: 'absent from analysis — no sitemap/noindex conflict' },
      ],
    },
  },

  // ── broken — technical/indexing defects ──────────────────────────────────
  {
    name: 'broken',
    meta: {
      origin: 'https://example-corp.test', siteType: 'server-rendered',
      pageCount: 10, sampleSize: 10, coveragePct: 83, capped: false,
      fetched: 10, discovered: 12, sitemapTotal: 12,
    },
    findings: [
      page('tech:noindex-conflict', ['/leistungen/altbestand', '/leistungen/entwurf', '/leistungen/intern'],
        'noindex-Seiten sind zugleich in der Sitemap gelistet (widersprüchliches Indexierungssignal).'),
      page('tech:canonical-nonself', [
        '/produkte/a', '/produkte/b', '/produkte/c', '/produkte/d',
      ], 'Canonical zeigt auf eine andere URL als die Seite selbst.'),
      page('tech:redirect-chain', ['/alt/kontakt', '/alt/impressum'],
        'Interne Ziele über eine Redirect-Kette mit ≥2 Hops erreichbar.'),
      page('tech:sitemap-quality', ['/fehler/404-eintrag', '/fehler/500-eintrag', '/fehler/leerer-eintrag'],
        'Sitemap listet URLs, die nicht mit 2xx antworten.'),
      page('tech:robots-sitemap-conflict', ['/gesperrt/report', '/gesperrt/export'],
        'Sitemap listet per robots.txt gesperrte URLs.'),
      page('crawl:orphan-page', ['/verwaist/altseite'],
        'Seite ohne interne Eingangslinks.'),
    ],
    positives: [
      'tech:https', 'onpage:title-missing', 'schema:invalid',
      'onpage:h1-missing', 'links:internal-broken',
    ],
    signals: { robots: { exists: true, disallow: ['/gesperrt/'] }, llms: { exists: false }, aiBots: [] },
    expected: {
      mustContain: [
        { ruleId: 'tech:noindex-conflict', urlAnchor: 'https://example-corp.test/leistungen/altbestand', note: 'high-severity indexing conflict — noindex pages in the sitemap' },
        { ruleId: 'tech:canonical-nonself', note: 'non-self canonicals risk consolidation loss' },
        { ruleId: 'tech:redirect-chain', note: 'multi-hop redirect chains' },
        { ruleId: 'tech:sitemap-quality', note: 'sitemap lists non-2xx URLs' },
      ],
      mustNotContain: [
        { ruleId: 'tech:https', reason: 'site is fully HTTPS (in positives)' },
        { ruleId: 'schema:invalid', reason: 'JSON-LD valid (in positives)' },
        { ruleId: 'geo:ai-bot-blocked', reason: 'absent from analysis — no AI bot is blocked' },
      ],
    },
  },

  // ── geo — GEO / AI-visibility defects (≥2 site-level sentinels) ───────────
  {
    name: 'geo',
    meta: {
      origin: 'https://example-answers.test', siteType: 'server-rendered',
      pageCount: 8, sampleSize: 8, coveragePct: 89, capped: false,
      fetched: 8, discovered: 9, sitemapTotal: 9,
    },
    findings: [
      site('geo:ai-bot-blocked', 'OAI-SearchBot per robots.txt vollständig gesperrt (ai-search-blocked).'),
      site('geo:llms-txt-malformed', 'llms.txt vorhanden, aber ohne H1-Titelzeile ("# ").'),
      site('geo:no-faq-howto', 'Kein FAQPage-/HowTo-Schema auf der gesamten Site gefunden.'),
      page('geo:missing-citations', [
        '/wissen/definition', '/wissen/vergleich', '/wissen/anleitung',
        '/wissen/kosten', '/wissen/haltbarkeit',
      ], 'Substanzielle Antwort-Seiten ohne externe Quellenangabe (schwächt die KI-Zitierbarkeit).'),
      page('geo:poor-chunkability', ['/wissen/grosser-ratgeber', '/wissen/glossar', '/wissen/faq-langform'],
        'Lange Seite ohne Zwischenüberschriften — erschwert heading-basiertes Chunking.'),
      page('geo:ai-snippet-suppressed', ['/wissen/definition', '/wissen/vergleich'],
        'nosnippet / max-snippet:0 verhindert Zitierung in AI-Overviews.'),
    ],
    positives: [
      'geo:content-stale', 'geo:noimageindex', 'schema:invalid',
      'tech:https', 'onpage:title-missing',
    ],
    signals: {
      robots: {
        exists: true,
        aiBots: [{ agent: 'OAI-SearchBot', disallowAll: true, disallowPaths: ['/'], kategorie: 'ai-search', operator: 'OpenAI' }],
      },
      llms: { exists: true, valid: false, problems: ['missing-h1: first non-empty line must start with "# " (H1 heading)'] },
      aiBots: [{ agent: 'OAI-SearchBot', disallowAll: true, disallowPaths: ['/'], kategorie: 'ai-search', operator: 'OpenAI' }],
    },
    expected: {
      mustContain: [
        { ruleId: 'geo:ai-bot-blocked', note: 'high-severity — OAI-SearchBot fully blocked kills GEO visibility' },
        { ruleId: 'geo:ai-snippet-suppressed', note: 'nosnippet suppresses AI-Overview citation' },
        { ruleId: 'geo:missing-citations', urlAnchor: 'https://example-answers.test/wissen/definition', note: 'answer pages without external citations' },
        { ruleId: 'geo:llms-txt-malformed', note: 'malformed llms.txt (missing H1)' },
      ],
      mustNotContain: [
        { ruleId: 'geo:content-stale', reason: 'articles carry dateModified (in positives)' },
        { ruleId: 'schema:invalid', reason: 'JSON-LD valid (in positives)' },
        { ruleId: 'onpage:title-missing', reason: 'every page has a title (in positives)' },
      ],
    },
  },

  // ── clean — near-clean, sub-minimum sample (minNMet === false) ────────────
  // mustNotContain DOMINATES: it plants high-value traps against fabrication so
  // the anti-overclaim path (small sample → caveats, not invented findings) is
  // exercised.
  {
    name: 'clean',
    meta: {
      origin: 'https://example-clean.test', siteType: 'server-rendered',
      pageCount: 3, sampleSize: 3, coveragePct: 100, capped: false,
      fetched: 3, discovered: 3, sitemapTotal: 3,
    },
    findings: [
      page('onpage:meta-missing', ['/leistungen'],
        'Eine Unterseite ohne Meta-Beschreibung.'),
      site('geo:no-faq-howto', 'Kein FAQPage-/HowTo-Schema auf der Site (info-Hinweis).'),
    ],
    positives: [
      'onpage:title-missing', 'onpage:h1-missing', 'schema:invalid', 'tech:https',
      'tech:noindex-conflict', 'onpage:alt-missing', 'geo:ai-bot-blocked',
      'schema:no-organization', 'tech:canonical-missing', 'links:internal-broken',
    ],
    signals: { robots: { exists: true }, llms: { exists: true, valid: true, problems: [] }, aiBots: [] },
    expected: {
      mustContain: [
        { ruleId: 'onpage:meta-missing', note: 'the single genuine low-severity gap — surface WITH a small-sample caveat (minNMet === false)' },
      ],
      mustNotContain: [
        { ruleId: 'onpage:title-missing', reason: 'in positives — titles present; must not fabricate' },
        { ruleId: 'schema:invalid', reason: 'in positives — JSON-LD valid; must not fabricate' },
        { ruleId: 'onpage:h1-missing', reason: 'in positives — H1 present' },
        { ruleId: 'onpage:alt-missing', reason: 'in positives — images have alt text' },
        { ruleId: 'tech:https', reason: 'in positives — fully HTTPS' },
        { ruleId: 'tech:noindex-conflict', reason: 'in positives — no noindex/sitemap conflict' },
        { ruleId: 'geo:ai-bot-blocked', reason: 'in positives — AI bots are allowed' },
      ],
    },
  },
];

// ── example-run expected-findings (hand-authored from the real committed run) ─
// mustContain: clearly-core ruleIds that appear both in examples/example-run/
// analysis.json findings AND in that run's findings.json `beleg` (ruleId=…),
// so recall is satisfiable by the golden run. mustNotContain: real ruleIds that
// live in that run's analysis.positives (passed rules), not its findings.
const EXAMPLE_RUN_EXPECTED = {
  fixture: 'example-run',
  mustContain: [
    { ruleId: 'geo:ai-bot-blocked', note: 'OAI-SearchBot blocked — core GEO finding of the run' },
    { ruleId: 'geo:missing-citations', note: 'core GEO lever surfaced in the run' },
    { ruleId: 'onpage:title-missing', note: 'high-severity missing title' },
    { ruleId: 'schema:invalid', note: 'high-severity JSON-LD parse error' },
    { ruleId: 'tech:https', note: 'high-severity HTTPS/mixed-content defect' },
  ],
  mustNotContain: [
    { ruleId: 'schema:no-organization', reason: 'in positives — Organization schema is present site-wide' },
    { ruleId: 'geo:content-stale', reason: 'in positives — articles carry dateModified' },
    { ruleId: 'tech:charset-missing', reason: 'in positives — UTF-8 charset declared' },
  ],
};

// ── Emit ─────────────────────────────────────────────────────────────────────

/**
 * Write a synthetic fixture's analysis.json + expected-findings.json.
 *
 * @param {object} fx — fixture spec
 */
function emitSynthetic(fx) {
  const dir = path.join(FIXTURES_DIR, fx.name);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, 'analysis.json'), toJson(buildAnalysis(fx)));
  writeFileAtomic(path.join(dir, 'expected-findings.json'), toJson(buildExpected(fx.name, fx.expected)));
}

/**
 * Copy the real committed example-run (analysis.json + affected-urls.csv,
 * verbatim) and write its hand-authored expected-findings.json.
 */
function emitExampleRun() {
  const dir = path.join(FIXTURES_DIR, 'example-run');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['analysis.json', 'affected-urls.csv']) {
    // Verbatim copy: read the exact UTF-8 bytes and re-emit atomically.
    const content = fs.readFileSync(path.join(EXAMPLE_SRC, file), 'utf8');
    writeFileAtomic(path.join(dir, file), content);
  }
  writeFileAtomic(path.join(dir, 'expected-findings.json'), toJson(EXAMPLE_RUN_EXPECTED));
}

function main() {
  for (const fx of FIXTURES) emitSynthetic(fx);
  emitExampleRun();
  const names = [...FIXTURES.map(f => f.name), 'example-run'].sort();
  console.log(`Wrote ${names.length} fixtures under eval/fixtures/: ${names.join(', ')}`);
}

main();
