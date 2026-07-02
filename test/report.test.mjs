/**
 * test/report.test.mjs — Unit G: HTML report renderer.
 *
 * Three concerns:
 *   1. Structure   — render(validExample) carries every contract section
 *                    (hero, exec-summary tiles, TOC, per-section findings with
 *                    severity/provenance/ICE/category badges, positives,
 *                    footer stamp, noindex, lang="de").
 *   2. Security    — untrusted crawled strings (title/befund/…) are HTML-escaped;
 *                    no executable <script> and no active onerror= attribute leak
 *                    into the output (XSS-Pflicht-Test).
 *   3. Robustness  — render() rejects schema-invalid input; the CLI writes
 *                    report/<host>/index.html for the example.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { render } from '../report/build-report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const example = readJson('examples/findings.example.json');
const xss = readJson('test/fixtures/findings-xss.json');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Structure
// ─────────────────────────────────────────────────────────────────────────────
describe('render(validExample) — structure', () => {
  const html = render(example);

  it('returns a self-contained HTML document', () => {
    assert.equal(typeof html, 'string');
    assert.ok(/^<!DOCTYPE html>/i.test(html.trimStart()), 'should start with a doctype');
    assert.ok(html.includes('lang="de"'), 'should declare lang="de"');
    assert.ok(html.includes('</html>'), 'should be a complete document');
  });

  it('is CSP-pure: noindex, inline <style>, no active <script>', () => {
    assert.ok(html.includes('name="robots"') && html.includes('content="noindex"'),
      'should carry a robots=noindex meta');
    assert.ok(html.includes('<style'), 'should inline its CSS');
    assert.ok(!/<script[\s>]/i.test(html), 'must contain no <script> tags');
    assert.ok(!/\son\w+=/i.test(html), 'must contain no inline event-handler attributes');
    // Self-contained: no external resources are loaded.
    assert.ok(!/<link\s+rel="stylesheet"/i.test(html), 'no external stylesheet link');
    assert.ok(!/\ssrc=/i.test(html), 'no src= resource references (no external img/script)');
    assert.ok(!/@import/i.test(html), 'no CSS @import of external resources');
  });

  it('renders semantic landmarks and a single <h1>', () => {
    assert.ok(html.includes('<main'), 'should have a <main> landmark');
    assert.ok(html.includes('<header'), 'should have a <header> landmark');
    assert.ok(html.includes('<footer'), 'should have a <footer> landmark');
    assert.ok(html.includes('<nav'), 'should have a <nav> landmark for the TOC');
    const h1Count = (html.match(/<h1[\s>]/g) || []).length;
    assert.equal(h1Count, 1, 'exactly one <h1>');
  });

  it('renders Executive-Summary metric tiles from execSummary.metrics', () => {
    for (const metric of example.execSummary.metrics) {
      assert.ok(html.includes(metric), `should render metric tile "${metric}"`);
    }
    for (const win of example.execSummary.quickWins) {
      assert.ok(html.includes(win), `should render quick-win "${win}"`);
    }
  });

  it('renders a table of contents listing every section', () => {
    assert.ok(/Inhalt/i.test(html), 'TOC should be labelled');
    for (const section of example.sections) {
      assert.ok(html.includes(section.title), `TOC/section should mention "${section.title}"`);
    }
  });

  it('renders one heading per section', () => {
    const h2Count = (html.match(/<h2[\s>]/g) || []).length;
    assert.ok(h2Count >= example.sections.length,
      `expected at least ${example.sections.length} <h2> headings, got ${h2Count}`);
  });

  it('renders severity, provenance, ICE and category badges with text labels', () => {
    assert.ok(/Schweregrad/i.test(html), 'severity badge should carry a text label');
    assert.ok(/Provenienz/i.test(html), 'provenance badge should carry a text label');
    assert.ok(/Kategorie/i.test(html), 'category badge should carry a text label');
    // ICE: the i×c×e=score arithmetic must be visible (e.g. "3 × 3 × 2 = 18").
    assert.ok(/ICE/.test(html), 'ICE badge should be labelled');
    assert.ok(/3\s*[×x]\s*3\s*[×x]\s*3\s*=\s*27/.test(html),
      'ICE badge should show the i×c×e=score arithmetic');
    // values present
    assert.ok(html.includes('gemessen'), 'provenance value rendered');
    assert.ok(html.includes('hoch') && html.includes('mittel'), 'severity values rendered');
  });

  it('renders Befund/Beleg/Auswirkung/Empfehlung and kbSources per finding', () => {
    const f = example.sections[0].findings[0];
    assert.ok(html.includes(f.befund), 'befund rendered');
    assert.ok(html.includes(f.auswirkung), 'auswirkung rendered');
    assert.ok(html.includes(f.empfehlung), 'empfehlung rendered');
    assert.ok(html.includes(f.kbSources[0].source), 'kbSource source rendered as citation');
    assert.ok(html.includes(f.kbSources[0].heading), 'kbSource heading rendered');
  });

  it('renders the positives ("Was bereits gut ist") section', () => {
    assert.ok(/gut ist/i.test(html), 'should label the positives section');
    for (const p of example.positives) {
      assert.ok(html.includes(p), `should render positive "${p}"`);
    }
  });

  it('renders the strategy levers/todos', () => {
    for (const todo of example.strategy.todos) {
      assert.ok(html.includes(todo), `should render strategy todo "${todo}"`);
    }
  });

  it('renders confidence caveats', () => {
    for (const caveat of example.confidence.caveats) {
      assert.ok(html.includes(caveat), `should render caveat "${caveat}"`);
    }
  });

  it('stamps the footer with modelId, rulesetVersion, crawledAt and a non-determinism note', () => {
    assert.ok(html.includes(example.meta.modelId), 'footer should carry modelId');
    assert.ok(html.includes(example.meta.rulesetVersion), 'footer should carry rulesetVersion');
    assert.ok(html.includes(example.meta.crawledAt), 'footer should carry crawledAt');
    assert.ok(/nicht-deterministisch|nicht deterministisch/i.test(html),
      'footer should note the LLM synthesis is non-deterministic');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. D15 meta-quality — the report's own output meets the a11y/quality bar
//     (CSP, banner/contentinfo landmarks, skip-link, ICE abbr+legend, TOC
//     completeness, escaping, @media print, deterministic severity SVG).
// ─────────────────────────────────────────────────────────────────────────────
describe('render — D15 meta-quality (a11y / CSP / print / SVG)', () => {
  const html = render(example);

  it('ships a strict Content-Security-Policy meta', () => {
    assert.ok(/<meta http-equiv="Content-Security-Policy"/i.test(html), 'CSP meta present');
    assert.ok(html.includes("default-src 'none'"), 'CSP locks default-src to none');
    assert.ok(html.includes("style-src 'unsafe-inline'"), 'CSP allows the single inline <style>');
  });

  it('places <header> and <footer> as siblings of <main> (banner/contentinfo)', () => {
    const mainOpen = html.indexOf('<main');
    const mainClose = html.indexOf('</main>');
    const headerIdx = html.indexOf('<header');
    const footerIdx = html.indexOf('<footer');
    assert.ok(headerIdx !== -1 && headerIdx < mainOpen, '<header> before <main>');
    assert.ok(footerIdx !== -1 && footerIdx > mainClose, '<footer> after </main>');
    const mainInner = html.slice(mainOpen, mainClose);
    assert.ok(!mainInner.includes('<header'), '<header> must not be nested in <main>');
    assert.ok(!mainInner.includes('<footer'), '<footer> must not be nested in <main>');
  });

  it('exposes a skip-to-content link as the first focusable child of <body>', () => {
    const afterBody = html.slice(html.indexOf('<body>'));
    assert.ok(/^<body>\s*<a class="skip-link" href="#h-exec">Zum Inhalt springen<\/a>/.test(afterBody),
      'skip-link is the first focusable element in <body>');
  });

  it('makes ICE a real <abbr> plus a visible legend (not title-only)', () => {
    assert.ok(html.includes('<abbr title="Impact × Confidence × Ease">ICE</abbr>'),
      'ICE wrapped in <abbr>');
    assert.ok(/class="[^"]*legend-ice[^"]*"/.test(html), 'a visible ICE legend element is present');
    const visible = html.replace(/title="[^"]*"/g, ''); // strip every title attribute
    assert.ok(visible.includes('Impact × Confidence × Ease'),
      'ICE expansion is visible text, not only a title attribute');
  });

  it('lists Zusammenfassung/Konfidenz/Positives/Strategie in the TOC', () => {
    assert.ok(/<a href="#h-exec">Zusammenfassung<\/a>/.test(html), 'TOC links exec summary');
    assert.ok(/<a href="#h-conf">Konfidenz<\/a>/.test(html), 'TOC links Konfidenz');
    assert.ok(/<a href="#h-pos">Positives<\/a>/.test(html), 'TOC links Positives');
    assert.ok(/<a href="#h-strat">Strategie<\/a>/.test(html), 'TOC links Strategie');
  });

  it('omits the Strategie TOC link when no strategy content is rendered', () => {
    const fixture = structuredClone(example);
    fixture.strategy = { levers: [], todos: [] };
    const noStrat = render(fixture);
    assert.ok(!/#h-strat/.test(noStrat), 'no #h-strat link when strategy is empty');
    assert.ok(/#h-exec/.test(noStrat), 'exec link still present');
  });

  it('includes an @media print stylesheet', () => {
    assert.ok(/@media print/.test(html), '@media print block present');
    assert.ok(/break-inside:\s*avoid/.test(html), 'print avoids breaking findings/tiles');
  });

  it('renders a deterministic, accessible inline SVG severity distribution', () => {
    assert.ok(/<svg[^>]*class="sev-chart"[^>]*role="img"/.test(html), 'SVG chart carries role=img');
    assert.ok(/aria-label="Schweregrad-Verteilung:/.test(html), 'SVG has an accessible name');
    assert.ok(/<title>Schweregrad-Verteilung:/.test(html), 'SVG has a <title>');
    // example fixture: hoch=2, mittel=1, niedrig=0 across 3 findings
    assert.ok(html.includes('2 hoch, 1 mittel, 0 niedrig (3 Befunde gesamt)'),
      'SVG describes the exact severity counts');
    assert.ok(!/<script[\s>]/i.test(html), 'SVG introduces no <script>');
  });

  it('escapes the hardcoded "Konfidenz & Einschränkungen" heading as &amp;', () => {
    assert.ok(html.includes('Konfidenz &amp; Einschränkungen'), 'heading uses &amp;');
    assert.ok(!html.includes('Konfidenz & Einschränkungen'), 'no raw & in the heading');
  });

  it('is byte-deterministic — render twice yields identical output', () => {
    assert.equal(render(example), render(example), 'same findings.json → identical HTML');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Security — XSS-Pflicht-Test
// ─────────────────────────────────────────────────────────────────────────────
describe('render — XSS escaping (untrusted crawled strings)', () => {
  const html = render(xss);

  it('escapes the raw <script> payload from title/evidence', () => {
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
      'the <script> payload must appear HTML-escaped');
    assert.ok(!html.includes('<script>alert'),
      'no executable <script>alert may appear in the output');
  });

  it('escapes the "><img onerror=…> payload from befund — no active attribute', () => {
    assert.ok(!/<img[^>]*onerror=/i.test(html),
      'no active <img ... onerror=…> element may appear');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'),
      'the img payload must appear HTML-escaped');
  });

  it('escapes payloads in patterns, todos and caveats too', () => {
    assert.ok(!/<script>alert\('(pattern|todo|caveat)'\)/.test(html),
      'no list-item payload may execute');
    assert.ok(html.includes("&lt;script&gt;alert(&#39;todo&#39;)&lt;/script&gt;"),
      'todo payload must be escaped including the single quotes');
  });

  it('contains no <script> tag at all (static report)', () => {
    assert.ok(!/<script[\s>]/i.test(html), 'rendered XSS fixture must contain no <script> tag');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Robustness — schema gate + CLI
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 2b. Null meta values — honest fallback rendering
// ─────────────────────────────────────────────────────────────────────────────
describe('render — null meta values render gracefully', () => {
  it('coveragePct=null renders "n. v." and never "null %"', () => {
    const fixture = structuredClone(example);
    fixture.meta.coveragePct = null;
    const html = render(fixture);
    assert.ok(html.includes('n. v.'), 'should render "n. v." when coveragePct is null');
    assert.ok(!html.includes('null %'), 'must not render literal "null %"');
  });

  it('crawledAt=null renders "unbekannt" in hero and footer, never "null"', () => {
    const fixture = structuredClone(example);
    fixture.meta.crawledAt = null;
    const html = render(fixture);
    const heroMatch = /Crawl-Zeitpunkt.*?unbekannt/s.test(html);
    assert.ok(heroMatch, 'hero should render "unbekannt" for null crawledAt');
    // Footer: Crawl <strong>unbekannt</strong>
    assert.ok(/Crawl\s*<strong>unbekannt<\/strong>/.test(html),
      'footer should render "unbekannt" for null crawledAt');
    assert.ok(!html.includes('>null<'), 'must not render literal ">null<" anywhere');
  });
});

describe('render — schema gate', () => {
  it('throws cleanly on schema-invalid input', () => {
    const bad = structuredClone(example);
    delete bad.meta;
    bad.sections[0].findings[0].severity = 'critical';
    assert.throws(() => render(bad), /invalid|schema|meta|severity/i,
      'render should reject schema-invalid findings');
  });

  it('throws on non-object input', () => {
    assert.throws(() => render(null));
    assert.throws(() => render('not findings'));
  });
});

describe('CLI — node report/build-report.mjs <findings.json>', () => {
  const outDir = path.join(ROOT, 'report', 'example.com');
  const outFile = path.join(outDir, 'index.html');

  after(() => {
    // report/<host>/ is gitignored output — clean up after the test.
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('writes report/<host>/index.html for the example', () => {
    fs.rmSync(outDir, { recursive: true, force: true });
    const stdout = execFileSync(
      'node',
      [path.join(ROOT, 'report', 'build-report.mjs'), path.join(ROOT, 'examples/findings.example.json')],
      { encoding: 'utf8' },
    );
    assert.ok(fs.existsSync(outFile), `should write ${outFile}`);
    assert.ok(stdout.includes(outFile), 'should print the written path on stdout');

    const written = fs.readFileSync(outFile, 'utf8');
    assert.ok(written.includes('<!DOCTYPE html>'), 'written file is an HTML document');
    assert.ok(written.includes('content="noindex"'), 'written file carries noindex');
  });

  it('exits non-zero on schema-invalid input', () => {
    const badPath = path.join(ROOT, 'test', 'fixtures', '_bad-findings.json');
    fs.writeFileSync(badPath, JSON.stringify({ not: 'findings' }), 'utf8');
    try {
      assert.throws(() => {
        execFileSync('node', [path.join(ROOT, 'report', 'build-report.mjs'), badPath], { encoding: 'utf8', stdio: 'pipe' });
      }, /Command failed/);
    } finally {
      fs.rmSync(badPath, { force: true });
    }
  });
});
