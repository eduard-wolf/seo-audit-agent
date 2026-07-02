/**
 * test/seo-depth-1_7.test.mjs — ruleset 1.7.0 additive SEO-depth detectors.
 *
 * Detector units (synthetic ctx) for the three rules added in 1.7.0, plus a parsePage
 * unit for the new ldContextOk signal:
 *   • geo:noimageindex                  (robotsMeta column, zero new extraction)
 *   • i18n:html-lang-hreflang-mismatch  (htmlLang + hreflangLinks columns)
 *   • schema:context-invalid            (parse-time ldContextOk column)
 *
 * Pure: no crawl, no network. Reuses runRules + loadRules.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runRules, loadRules } from '../analyze/engine.mjs';
import { parsePage } from '../crawl/parse.mjs';

const RULES = loadRules(new URL('../config/rules', import.meta.url).pathname);
const ruleFor = id => {
  const r = RULES.find(x => x.id === id);
  assert.ok(r, `config rule ${id} must exist`);
  return r;
};

// A clean content row (passes contentRows()); override fields per test.
const row = (extra) => ({ url: 'http://example.com/p.html', status: '200', redirected: '0', redirectChain: '', wordCount: '400', error: '', ...extra });

// ── geo:noimageindex ─────────────────────────────────────────────────────────
describe('geo:noimageindex — detector unit', () => {
  const rule = ruleFor('geo:noimageindex');

  it('fires when robotsMeta contains noimageindex', () => {
    const ctx = { rows: [row({ robotsMeta: 'noindex, noimageindex' })], signals: {}, linkgraph: {} };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'noimageindex present → fire');
    assert.ok(findings[0].affectedUrls.includes('http://example.com/p.html'));
  });

  it('does NOT fire without noimageindex (e.g. plain noindex)', () => {
    const ctx = { rows: [row({ robotsMeta: 'noindex' })], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'no noimageindex → no fire');
    assert.strictEqual(positives.length, 1, 'clean page → positive');
  });
});

// ── i18n:html-lang-hreflang-mismatch ─────────────────────────────────────────
describe('i18n:html-lang-hreflang-mismatch — detector unit', () => {
  const rule = ruleFor('i18n:html-lang-hreflang-mismatch');

  it('fires when the self-referential hreflang language disagrees with html lang', () => {
    // page is served at /p.html, declares html lang=de, but its SELF hreflang says en
    const ctx = { rows: [row({ htmlLang: 'de', hreflangLinks: 'en=http://example.com/p.html|de=http://example.de/p.html' })], signals: {}, linkgraph: {} };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'self hreflang en vs html lang de → mismatch');
  });

  it('does NOT fire when the self-referential hreflang matches html lang', () => {
    const ctx = { rows: [row({ htmlLang: 'de-DE', hreflangLinks: 'de=http://example.com/p.html|en=http://example.com/en/p.html' })], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'de self hreflang matches de-DE html lang → no fire');
    assert.strictEqual(positives.length, 1);
  });

  it('does NOT fire when there is no hreflang at all', () => {
    const ctx = { rows: [row({ htmlLang: 'de', hreflangLinks: '' })], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'no hreflang → not applicable');
    assert.strictEqual(positives.length, 1);
  });
});

// ── schema:context-invalid ───────────────────────────────────────────────────
describe('schema:context-invalid — detector unit', () => {
  const rule = ruleFor('schema:context-invalid');

  it('fires when a parseable JSON-LD block lacks a schema.org @context (ldContextOk=0)', () => {
    const ctx = { rows: [row({ ldContextOk: '0' })], signals: {}, linkgraph: {} };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'ldContextOk=0 → fire');
  });

  it('does NOT fire when @context is valid (ldContextOk=1)', () => {
    const ctx = { rows: [row({ ldContextOk: '1' })], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'ldContextOk=1 → no fire');
    assert.strictEqual(positives.length, 1);
  });

  it('does NOT fire when there is no JSON-LD (ldContextOk empty)', () => {
    const ctx = { rows: [row({ ldContextOk: '' })], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'no JSON-LD → not applicable');
    assert.strictEqual(positives.length, 1);
  });
});

// ── parsePage: ldContextOk signal ────────────────────────────────────────────
describe('parsePage — ldContextOk @context signal', () => {
  const wrap = (ld) => `<html><head><script type="application/ld+json">${ld}</script></head>` +
    `<body>words words words words words words words words words words words</body></html>`;

  it('ldContextOk=1 for a schema.org @context', () => {
    const r = parsePage(wrap('{"@context":"https://schema.org","@type":"Organization","name":"X"}'), 'http://example.com/');
    assert.strictEqual(r.ldContextOk, 1);
  });

  it('ldContextOk=0 for parseable JSON-LD missing @context', () => {
    const r = parsePage(wrap('{"@type":"Organization","name":"X"}'), 'http://example.com/');
    assert.strictEqual(r.ldContextOk, 0);
  });

  it('ldContextOk=0 for a non-schema.org @context', () => {
    const r = parsePage(wrap('{"@context":"https://example.com/ns","@type":"Thing"}'), 'http://example.com/');
    assert.strictEqual(r.ldContextOk, 0);
  });

  it("ldContextOk='' when there is no JSON-LD block", () => {
    const r = parsePage('<html><head><title>t</title></head><body>words words words words words words words words words words</body></html>', 'http://example.com/');
    assert.strictEqual(r.ldContextOk, '');
  });
});
