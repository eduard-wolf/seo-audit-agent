/**
 * test/example-run.test.mjs — Unit H: the committed proof-of-generation run.
 *
 * Guards that examples/example-run/ stays a real, valid, self-consistent
 * artifact of the full pipeline, and that README.md keeps the load-bearing
 * credibility claims (prerequisites + differentiation) without leaking a real
 * client brand.
 *
 * Concerns:
 *   1. Chain artifacts exist (crawl.csv, analysis.json) and findings.json is
 *      schema-valid via validateFindings.
 *   2. index.html exists, carries the footer stamp + escaped content, and has no
 *      active <script>.
 *   3. README mentions Claude Code, both flavors of differentiation (Screaming
 *      Frog + claude-seo), carries NO confidential-client-audit origin framing,
 *      and never names the real client brand.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateFindings } from '../lib/findings-schema.mjs';
import { scanText } from '../scripts/leak-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

const RUN = 'examples/example-run';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Chain artifacts + schema-valid findings
// ─────────────────────────────────────────────────────────────────────────────
describe('example-run — chain artifacts', () => {
  it('the deterministic artifacts (crawl.csv, analysis.json) exist', () => {
    assert.ok(exists(`${RUN}/crawl.csv`), 'crawl.csv should exist');
    assert.ok(exists(`${RUN}/analysis.json`), 'analysis.json should exist');
  });

  it('findings.json exists and is schema-valid (validateFindings → valid:true)', () => {
    assert.ok(exists(`${RUN}/findings.json`), 'findings.json should exist');
    const findings = readJson(`${RUN}/findings.json`);
    const { valid, errors } = validateFindings(findings);
    assert.ok(valid, `findings.json must be schema-valid; errors:\n${errors.join('\n')}`);
  });

  it('analysis.json and findings.json describe the same crawled origin', () => {
    const analysis = readJson(`${RUN}/analysis.json`);
    const findings = readJson(`${RUN}/findings.json`);
    assert.equal(
      findings.meta.url,
      analysis.meta.origin,
      'findings.meta.url should equal analysis.meta.origin (proof the chain is one run)',
    );
  });

  it('findings.meta.crawledAt matches analysis.meta.crawledAt (no invented date)', () => {
    const analysis = readJson(`${RUN}/analysis.json`);
    const findings = readJson(`${RUN}/findings.json`);
    assert.equal(
      findings.meta.crawledAt,
      analysis.meta.crawledAt,
      'findings.meta.crawledAt must equal analysis.meta.crawledAt — never invent a crawl date (I12)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Rendered report: footer stamp, escaped content, no active <script>
// ─────────────────────────────────────────────────────────────────────────────
describe('example-run — rendered report', () => {
  it('index.html exists', () => {
    assert.ok(exists(`${RUN}/index.html`), 'index.html should exist');
  });

  it('carries the footer stamp (model · ruleset · crawl)', () => {
    const html = read(`${RUN}/index.html`);
    assert.ok(/class="stamp"/.test(html), 'should contain the footer stamp block');
    assert.ok(html.includes('Modell') && html.includes('Regelwerk') && html.includes('Crawl'),
      'footer stamp should name model, ruleset and crawl timestamp');
  });

  it('is CSP-pure: noindex, no active <script>, escaped content', () => {
    const html = read(`${RUN}/index.html`);
    assert.ok(!/<script[\s>]/i.test(html), 'must contain no active <script> tag');
    assert.ok(html.includes('content="noindex"'), 'should carry robots=noindex');
    // Escaping is in effect: HTML entities are present in the rendered document.
    assert.ok(/&amp;|&lt;|&gt;|&quot;|&#39;/.test(html), 'should contain HTML-escaped entities');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. README credibility claims (and brand cleanliness)
// ─────────────────────────────────────────────────────────────────────────────
describe('README — credibility claims', () => {
  const readme = read('README.md');

  it('states the Claude Code prerequisite', () => {
    assert.ok(/Claude[\s-]?Code/.test(readme), 'README should mention the Claude Code prerequisite');
  });

  it('draws both differentiation lines (Screaming Frog + claude-seo)', () => {
    assert.ok(readme.includes('Screaming Frog'), 'README should delimit vs. Screaming Frog');
    assert.ok(readme.includes('claude-seo'), 'README should delimit vs. claude-seo');
  });

  it('carries no confidential-client-audit origin framing', () => {
    assert.ok(!/Kunden-Audit/i.test(readme),
      'README must not frame the tool as coming from a confidential client audit');
  });

  it('never names the real client brand (via the leak-scan hashed mechanism, no plaintext)', () => {
    const brandHits = scanText('README.md', readme).filter(h => h.label === 'client-brand');
    assert.equal(brandHits.length, 0, 'README must not contain the confidential client brand');
  });
});
