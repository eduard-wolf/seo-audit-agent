/**
 * test/link-integrity.test.mjs — Batch 4d: link-graph TARGET integrity (synthetic ctx).
 *
 * Detector units for the four cross-reference rules added in Batch 4d. Each test
 * builds synthetic rows (and synthetic linkGraph.edges for the internal-link rules)
 * and asserts the detector fires / stays positive for the target's OWN crawled-row
 * state — keyed off redirected/redirectChain (NOT just final status), 4xx/5xx, and
 * (canonical only) noindex.
 *
 * Pure: no crawl, no network, no fixture files. Reuses runRules from the engine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runRules } from '../analyze/engine.mjs';

// Minimal rule descriptors (params unused by these detectors).
const canonicalRule = { id: 'tech:canonical-target-broken', kategorie: 'tech-index', scope: 'agnostic', severity: 'hoch',   title: 'Canonical → fehlerhaftes Ziel', params: {} };
const hreflangRule  = { id: 'i18n:hreflang-target-broken',   kategorie: 'i18n',       scope: 'agnostic', severity: 'mittel', title: 'hreflang → fehlerhaftes Ziel', params: {} };
const brokenRule    = { id: 'links:internal-broken',         kategorie: 'links',      scope: 'agnostic', severity: 'hoch',   title: 'Interner Link → 4xx/5xx',     params: {} };
const redirectRule  = { id: 'links:internal-redirect',       kategorie: 'links',      scope: 'agnostic', severity: 'mittel', title: 'Interner Link → Redirect',    params: {} };

// A clean content source row (passes contentRows()).
function src(extra) {
  return { url: 'http://example.com/source.html', status: '200', redirected: '0', redirectChain: '', wordCount: '500', error: '', canonical: '', hreflangLinks: '', ...extra };
}

// ── tech:canonical-target-broken ─────────────────────────────────────────────

describe('tech:canonical-target-broken — detector unit (synthetic ctx)', () => {
  it('fires when canonical → a 4xx/5xx target row', () => {
    const ctx = {
      rows: [
        src({ canonical: 'http://example.com/target.html' }),
        { url: 'http://example.com/target.html', status: '410', redirected: '0', redirectChain: '', wordCount: '', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [canonicalRule]);
    assert.strictEqual(findings.length, 1, 'should fire for canonical → 410 target');
    assert.ok(findings[0].affectedUrls.includes('http://example.com/source.html'), 'source page should be flagged');
  });

  it('fires when canonical → a redirect-SOURCE target (redirected=1, final status 200)', () => {
    // The crawler follows redirects, so a redirected target shows final 200 — keying off
    // status alone would MISS this; we key off the target row's redirected flag.
    const ctx = {
      rows: [
        src({ canonical: 'http://example.com/redir.html' }),
        { url: 'http://example.com/redir.html', status: '200', redirected: '1', redirectChain: 'http://example.com/redir.html|http://example.com/final.html', wordCount: '300', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [canonicalRule]);
    assert.strictEqual(findings.length, 1, 'should fire for canonical → redirect source (status 200)');
  });

  it('fires when canonical → a redirectChain-only target (redirected=0 but chain non-empty)', () => {
    const ctx = {
      rows: [
        src({ canonical: 'http://example.com/chain.html' }),
        { url: 'http://example.com/chain.html', status: '200', redirected: '0', redirectChain: 'http://example.com/chain.html|http://example.com/x.html', wordCount: '300', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [canonicalRule]);
    assert.strictEqual(findings.length, 1, 'should fire for canonical → redirectChain target');
  });

  it('fires when canonical → a noindex target', () => {
    const ctx = {
      rows: [
        src({ canonical: 'http://example.com/noindex-target.html' }),
        { url: 'http://example.com/noindex-target.html', status: '200', redirected: '0', redirectChain: '', robotsMeta: 'noindex', wordCount: '300', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [canonicalRule]);
    assert.strictEqual(findings.length, 1, 'should fire for canonical → noindex target');
  });

  it('does NOT fire for a SELF-referential canonical whose only defect is noindex (owned by noindex-canonical-conflict)', () => {
    // A noindex page that canonicalises to itself: reported by tech:noindex-canonical-conflict, not here.
    const ctx = {
      rows: [
        { url: 'http://example.com/self.html', status: '200', redirected: '0', redirectChain: '', robotsMeta: 'noindex', wordCount: '300', error: '', canonical: 'http://example.com/self.html', hreflangLinks: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [canonicalRule]);
    assert.strictEqual(findings.length, 0, 'self-referential noindex canonical must not double-fire here');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('STILL fires for a canonical → a DIFFERENT (cross-target) noindex page', () => {
    const ctx = {
      rows: [
        src({ url: 'http://example.com/a.html', canonical: 'http://example.com/other-noindex.html' }),
        { url: 'http://example.com/other-noindex.html', status: '200', redirected: '0', redirectChain: '', robotsMeta: 'noindex', wordCount: '300', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [canonicalRule]);
    assert.strictEqual(findings.length, 1, 'cross-target noindex canonical still fires');
  });

  it('does NOT fire when canonical → a healthy 2xx, non-redirect, indexable target', () => {
    const ctx = {
      rows: [
        src({ canonical: 'http://example.com/ok.html' }),
        { url: 'http://example.com/ok.html', status: '200', redirected: '0', redirectChain: '', robotsMeta: '', wordCount: '300', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [canonicalRule]);
    assert.strictEqual(findings.length, 0, 'must not fire for a healthy canonical target');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire (skips) when canonical → a cross-host / uncrawled target (path not in crawl set)', () => {
    const ctx = {
      rows: [ src({ canonical: 'http://other-host.example/external-only.html' }) ],
      signals: {}, linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [canonicalRule]);
    assert.strictEqual(findings.length, 0, 'must not fire when the canonical target was not crawled');
    assert.strictEqual(positives.length, 1, 'unverifiable cross-host target → positive (no overclaim)');
  });

  it('does NOT fire when canonical → a FOREIGN host whose path collides with a broken internal row', () => {
    // Cross-host false positive: a syndicated page canonicalises to an EXTERNAL publisher,
    // and an UNRELATED internal page happens to share the target pathname and be broken.
    // Host-ignored pathname matching would mis-resolve the foreign target to the internal row.
    const ctx = {
      rows: [
        src({ url: 'http://example.com/article.html', canonical: 'http://external-publisher.example/promo' }),
        { url: 'http://example.com/promo', status: '200', redirected: '0', redirectChain: '', robotsMeta: 'noindex', wordCount: '300', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [canonicalRule]);
    assert.strictEqual(findings.length, 0, 'foreign-host canonical must not resolve to a colliding internal path');
    assert.strictEqual(positives.length, 1, 'unverifiable cross-host target → positive (no overclaim)');
  });

  it('STILL fires when canonical → a different-host but SELF-referential production host (e.g. crawl 127.0.0.1, canonical demo.example)', () => {
    // The fixture crawls 127.0.0.1 but declares canonicals on demo.example; a self-canonical
    // (same pathname) marks demo.example as the site's own production host, so a canonical to a
    // broken same-host target must still be verifiable.
    const ctx = {
      rows: [
        // self-canonical establishes demo.example as a known site host
        { url: 'http://127.0.0.1:9/ok.html', status: '200', redirected: '0', redirectChain: '', wordCount: '300', error: '', canonical: 'http://demo.example/ok.html', hreflangLinks: '' },
        // this page canonicalises to a broken same-(production-)host target
        { url: 'http://127.0.0.1:9/dup.html', status: '200', redirected: '0', redirectChain: '', wordCount: '300', error: '', canonical: 'http://demo.example/gone.html', hreflangLinks: '' },
        { url: 'http://127.0.0.1:9/gone.html', status: '410', redirected: '0', redirectChain: '', wordCount: '', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [canonicalRule]);
    assert.strictEqual(findings.length, 1, 'canonical to a broken target on the declared production host must still fire');
    assert.ok(findings[0].affectedUrls.includes('http://127.0.0.1:9/dup.html'), 'the page with the broken canonical is flagged');
  });

  it('does NOT fire for a page without any canonical', () => {
    const ctx = { rows: [ src({ canonical: '' }) ], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [canonicalRule]);
    assert.strictEqual(findings.length, 0, 'no canonical → not applicable');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── i18n:hreflang-target-broken ──────────────────────────────────────────────

describe('i18n:hreflang-target-broken — detector unit (synthetic ctx)', () => {
  it('fires when an hreflang target → a 4xx/5xx row', () => {
    const ctx = {
      rows: [
        src({ hreflangLinks: 'de=http://example.com/de.html|en=http://example.com/en.html' }),
        { url: 'http://example.com/de.html', status: '404', redirected: '0', redirectChain: '', wordCount: '', error: '' },
        { url: 'http://example.com/en.html', status: '200', redirected: '0', redirectChain: '', wordCount: '300', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [hreflangRule]);
    assert.strictEqual(findings.length, 1, 'should fire when an hreflang target is 404');
    assert.ok(findings[0].affectedUrls.includes('http://example.com/source.html'), 'source page should be flagged');
  });

  it('fires when an hreflang target → a redirect SOURCE (redirected=1, final status 200)', () => {
    const ctx = {
      rows: [
        src({ hreflangLinks: 'de=http://example.com/de.html' }),
        { url: 'http://example.com/de.html', status: '200', redirected: '1', redirectChain: 'http://example.com/de.html|http://example.com/de-final.html', wordCount: '300', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [hreflangRule]);
    assert.strictEqual(findings.length, 1, 'should fire when an hreflang target is a redirect source');
  });

  it('does NOT fire when all hreflang targets are healthy 2xx, non-redirect rows', () => {
    const ctx = {
      rows: [
        src({ hreflangLinks: 'de=http://example.com/de.html|en=http://example.com/en.html' }),
        { url: 'http://example.com/de.html', status: '200', redirected: '0', redirectChain: '', wordCount: '300', error: '' },
        { url: 'http://example.com/en.html', status: '200', redirected: '0', redirectChain: '', wordCount: '300', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [hreflangRule]);
    assert.strictEqual(findings.length, 0, 'must not fire for healthy hreflang targets');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for a page without hreflang annotations', () => {
    const ctx = { rows: [ src({ hreflangLinks: '' }) ], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [hreflangRule]);
    assert.strictEqual(findings.length, 0, 'no hreflang → not applicable');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire (skips) for an uncrawled hreflang target', () => {
    const ctx = { rows: [ src({ hreflangLinks: 'fr=http://other-host.example/fr-only.html' }) ], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [hreflangRule]);
    assert.strictEqual(findings.length, 0, 'uncrawled hreflang target → skip (not flagged)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when an hreflang target → a FOREIGN host whose path collides with a broken internal row', () => {
    // Cross-host false positive: hreflang points to a genuinely different-site domain, and an
    // unrelated internal page shares the target pathname and is broken.
    const ctx = {
      rows: [
        src({ url: 'http://example.com/page.html', hreflangLinks: 'de=http://foreign-site.example/produkt' }),
        { url: 'http://example.com/produkt', status: '404', redirected: '0', redirectChain: '', wordCount: '', error: '' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [hreflangRule]);
    assert.strictEqual(findings.length, 0, 'foreign-host hreflang must not resolve to a colliding internal path');
    assert.strictEqual(positives.length, 1, 'unverifiable cross-host target → positive (no overclaim)');
  });
});

// ── links:internal-broken / links:internal-redirect (consume linkGraph.edges) ─

describe('links:internal-broken — detector unit (synthetic ctx + edges)', () => {
  it('fires when an internal <a> link → a 4xx/5xx target row', () => {
    const ctx = {
      rows: [
        src({ url: 'http://example.com/a.html' }),
        { url: 'http://example.com/dead.html', status: '500', redirected: '0', redirectChain: '', wordCount: '', error: '' },
      ],
      signals: {},
      linkgraph: { edges: [{ url: 'http://example.com/a.html', internalLinks: ['http://example.com/dead.html'] }] },
    };
    const { findings } = runRules(ctx, [brokenRule]);
    assert.strictEqual(findings.length, 1, 'should fire when an internal link points to a 5xx page');
    assert.ok(findings[0].affectedUrls.includes('http://example.com/a.html'), 'the SOURCE page should be flagged');
  });

  it('does NOT fire when all internal link targets are 2xx', () => {
    const ctx = {
      rows: [
        src({ url: 'http://example.com/a.html' }),
        { url: 'http://example.com/ok.html', status: '200', redirected: '0', redirectChain: '', wordCount: '300', error: '' },
      ],
      signals: {},
      linkgraph: { edges: [{ url: 'http://example.com/a.html', internalLinks: ['http://example.com/ok.html'] }] },
    };
    const { findings, positives } = runRules(ctx, [brokenRule]);
    assert.strictEqual(findings.length, 0, 'must not fire for a healthy internal link target');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when a redirect-target link is present but no 4xx/5xx (that is internal-redirect, not broken)', () => {
    const ctx = {
      rows: [
        src({ url: 'http://example.com/a.html' }),
        { url: 'http://example.com/r.html', status: '200', redirected: '1', redirectChain: 'http://example.com/r.html|http://example.com/f.html', wordCount: '300', error: '' },
      ],
      signals: {},
      linkgraph: { edges: [{ url: 'http://example.com/a.html', internalLinks: ['http://example.com/r.html'] }] },
    };
    const { findings, positives } = runRules(ctx, [brokenRule]);
    assert.strictEqual(findings.length, 0, 'a redirect target is NOT a 4xx/5xx broken link');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

describe('links:internal-redirect — detector unit (synthetic ctx + edges)', () => {
  it('fires when an internal <a> link → a redirect SOURCE (redirected=1, final status 200)', () => {
    const ctx = {
      rows: [
        src({ url: 'http://example.com/a.html' }),
        { url: 'http://example.com/r.html', status: '200', redirected: '1', redirectChain: 'http://example.com/r.html|http://example.com/f.html', wordCount: '300', error: '' },
      ],
      signals: {},
      linkgraph: { edges: [{ url: 'http://example.com/a.html', internalLinks: ['http://example.com/r.html'] }] },
    };
    const { findings } = runRules(ctx, [redirectRule]);
    assert.strictEqual(findings.length, 1, 'should fire when an internal link points to a redirect source');
    assert.ok(findings[0].affectedUrls.includes('http://example.com/a.html'), 'the SOURCE page should be flagged');
  });

  it('does NOT fire when the internal link target is a direct 2xx (no redirect)', () => {
    const ctx = {
      rows: [
        src({ url: 'http://example.com/a.html' }),
        { url: 'http://example.com/ok.html', status: '200', redirected: '0', redirectChain: '', wordCount: '300', error: '' },
      ],
      signals: {},
      linkgraph: { edges: [{ url: 'http://example.com/a.html', internalLinks: ['http://example.com/ok.html'] }] },
    };
    const { findings, positives } = runRules(ctx, [redirectRule]);
    assert.strictEqual(findings.length, 0, 'must not fire when the target is a direct 2xx');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when the source has no persisted edges', () => {
    const ctx = {
      rows: [ src({ url: 'http://example.com/a.html' }) ],
      signals: {},
      linkgraph: { edges: [] },
    };
    const { findings, positives } = runRules(ctx, [redirectRule]);
    assert.strictEqual(findings.length, 0, 'no edges → nothing to check');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});
