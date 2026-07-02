/**
 * test/parse.test.mjs — Unit C2 TDD tests for parsePage (red → green).
 *
 * Tests run against the in-process fixture server. parsePage receives raw HTML
 * and the final URL, returning extracted signal fields.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFixtureServer } from './fixture-server.mjs';
import { parsePage } from '../crawl/parse.mjs';

/** Fetch HTML body from a URL using the bare Node http module. */
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

describe('parsePage — fixture-server', () => {
  let base, close;

  before(async () => {
    const srv = await startFixtureServer();
    base = srv.baseUrl;
    close = srv.close;
  });

  after(() => close());

  // ── Title ──────────────────────────────────────────────────────────────────

  it('missing-title.html → title empty, titleLen 0, metaMissing 0 (has description)', async () => {
    const url = `${base}/missing-title.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(r.title, '', 'title should be empty');
    assert.strictEqual(r.titleLen, 0, 'titleLen should be 0');
    assert.strictEqual(r.metaMissing, 0, 'metaMissing should be 0 (page has a description meta)');
  });

  it('long-title.html → titleLen > 60', async () => {
    const url = `${base}/long-title.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.ok(r.titleLen > 60, `titleLen should be >60, got ${r.titleLen}`);
  });

  // ── Headings ───────────────────────────────────────────────────────────────

  it('multi-h1.html → h1Count === 2, headingOutline includes h1 and h3, no h2', async () => {
    const url = `${base}/multi-h1.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(r.h1Count, 2, `h1Count should be 2, got ${r.h1Count}`);
    assert.ok(r.headingOutline.includes('h1'), `headingOutline should include h1: ${r.headingOutline}`);
    assert.ok(r.headingOutline.includes('h3'), `headingOutline should include h3: ${r.headingOutline}`);
    assert.ok(!r.headingOutline.includes('h2'), `headingOutline should not include h2: ${r.headingOutline}`);
  });

  // ── JSON-LD ────────────────────────────────────────────────────────────────

  it('invalid-schema.html → ldValid === 0, hasProduct === 1', async () => {
    const url = `${base}/invalid-schema.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(r.ldValid, 0, 'ldValid should be 0 (one block has syntax error)');
    assert.strictEqual(r.hasProduct, 1, 'hasProduct should be 1 (Product in second block)');
  });

  it('perfect.html → ldValid === 1, hasAuthor === 1, hasOrg === 1', async () => {
    const url = `${base}/perfect.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(r.ldValid, 1, 'ldValid should be 1 (valid JSON-LD)');
    assert.strictEqual(r.hasAuthor, 1, 'hasAuthor should be 1 (author is a Person)');
    assert.strictEqual(r.hasOrg, 1, 'hasOrg should be 1 (publisher is Organization)');
  });

  // ── Images ────────────────────────────────────────────────────────────────

  it('no-alt.html → imgNoAlt === 4, imgJpg === 4', async () => {
    const url = `${base}/no-alt.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(r.imgNoAlt, 4, `imgNoAlt should be 4, got ${r.imgNoAlt}`);
    assert.strictEqual(r.imgJpg, 4, `imgJpg should be 4, got ${r.imgJpg}`);
  });

  it('perfect.html → imgNoAlt === 0, imgWebp === 2', async () => {
    const url = `${base}/perfect.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(r.imgNoAlt, 0, 'imgNoAlt should be 0 (all images have alt)');
    assert.strictEqual(r.imgWebp, 2, `imgWebp should be 2, got ${r.imgWebp}`);
  });

  // ── Outlinks ──────────────────────────────────────────────────────────────

  it('no-citations.html → outlinksAuthoritative === 0', async () => {
    const url = `${base}/no-citations.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(r.outlinksAuthoritative, 0, `outlinksAuthoritative should be 0, got ${r.outlinksAuthoritative}`);
  });

  it('perfect.html → outlinksAuthoritative >= 1', async () => {
    const url = `${base}/perfect.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.ok(r.outlinksAuthoritative >= 1, `outlinksAuthoritative should be >=1, got ${r.outlinksAuthoritative}`);
  });

  // ── XSS decoding ─────────────────────────────────────────────────────────

  it('xss.html → title decodes to raw <script>alert(1)</script>', async () => {
    const url = `${base}/xss.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(
      r.title,
      '<script>alert(1)</script>',
      `title should be decoded XSS string, got: ${r.title}`,
    );
  });

  it('xss.html → h1 also decodes to raw <script>alert(1)</script>', async () => {
    const url = `${base}/xss.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(
      r.h1,
      '<script>alert(1)</script>',
      `h1 should be decoded XSS string, got: ${r.h1}`,
    );
  });

  // ── Empty / JS-guard (boundary) ───────────────────────────────────────────

  it('thin.html → isEmpty === false (~12 raw words > threshold 10)', async () => {
    const url = `${base}/thin.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(
      r.isEmpty,
      false,
      `thin.html should have isEmpty=false (rawWordCount=${r.rawWordCount} > 10)`,
    );
  });

  it('xss.html → metaDesc decodes to "><img src=x onerror=alert(1)>', async () => {
    const url = `${base}/xss.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(
      r.metaDesc,
      '"><img src=x onerror=alert(1)>',
      `metaDesc should be decoded XSS string, got: ${r.metaDesc}`,
    );
  });

  // ── Empty / JS-guard ──────────────────────────────────────────────────────

  it('client-rendered.html → isEmpty === true', async () => {
    const url = `${base}/client-rendered.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(r.isEmpty, true, 'isEmpty should be true for JS-rendered shell');
  });

  it('perfect.html → isEmpty === false (has real content)', async () => {
    const url = `${base}/perfect.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(r.isEmpty, false, 'isEmpty should be false for content-rich page');
  });

  // ── robotsMeta ────────────────────────────────────────────────────────────

  it('noindex.html → robotsMeta includes "noindex"', async () => {
    const url = `${base}/noindex.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.ok(
      r.robotsMeta.includes('noindex'),
      `robotsMeta should include noindex, got: ${r.robotsMeta}`,
    );
  });

  // ── htmlLang ─────────────────────────────────────────────────────────────

  it('index.html → htmlLang === "de"', async () => {
    const url = `${base}/`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(r.htmlLang, 'de', `htmlLang should be "de", got ${r.htmlLang}`);
  });

  // ── internalLinks ─────────────────────────────────────────────────────────

  it('index.html → internalLinks is array with same-origin URLs', async () => {
    const url = `${base}/`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.ok(Array.isArray(r.internalLinks), 'internalLinks should be an array');
    assert.ok(r.internalLinks.length > 0, 'index.html should have internal links');
    for (const link of r.internalLinks) {
      assert.ok(link.startsWith(base), `link ${link} should start with ${base}`);
    }
  });

  // ── Minor 1: orgHasSameAs ─────────────────────────────────────────────────

  it('index.html → hasOrgSameAs === 0 (Organization lacks sameAs)', async () => {
    const url = `${base}/`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(
      r.hasOrgSameAs,
      0,
      `hasOrgSameAs should be 0 for index.html (Org LD has no sameAs), got ${r.hasOrgSameAs}`,
    );
  });

  it('perfect.html → hasOrgSameAs === 1 (publisher Organization has sameAs)', async () => {
    const url = `${base}/perfect.html`;
    const html = await fetchHtml(url);
    const r = parsePage(html, url);
    assert.strictEqual(
      r.hasOrgSameAs,
      1,
      `hasOrgSameAs should be 1 for perfect.html (publisher Org has sameAs), got ${r.hasOrgSameAs}`,
    );
  });
});

// ── Inline tests (no server needed) ─────────────────────────────────────────

describe('parsePage — inline HTML', () => {

  it('canonSelf === 1 when canonical href matches page URL', () => {
    const url = 'http://example.com/page.html';
    const html = [
      '<html lang="en"><head>',
      `<link rel="canonical" href="${url}">`,
      '</head><body>',
      'Words words words words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.strictEqual(r.canonSelf, 1, 'canonSelf should be 1 when canonical matches url');
  });

  it('canonSelf === 0 when canonical href differs from page URL', () => {
    const url = 'http://example.com/page.html';
    const html = [
      '<html><head>',
      '<link rel="canonical" href="http://other.com/page.html">',
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.strictEqual(r.canonSelf, 0, 'canonSelf should be 0 when canonical differs');
  });

  it('mixedContent === 1 when https page embeds http resource', () => {
    const url = 'https://example.com/page.html';
    const html = [
      '<html><head></head><body>',
      '<img src="http://cdn.example.com/img.jpg" alt="test">',
      'words words words words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.strictEqual(r.mixedContent, 1, 'mixedContent should be 1 for https page with http resource');
  });

  it('mixedContent === 0 for http page even with http resource', () => {
    const url = 'http://example.com/page.html';
    const html = [
      '<html><head></head><body>',
      '<img src="http://cdn.example.com/img.jpg" alt="test">',
      'words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.strictEqual(r.mixedContent, 0, 'mixedContent should be 0 for non-https page');
  });

  it('metaMissing === 1 when no <meta name="description"> present', () => {
    const html = '<html><head><title>Test</title></head><body>some words here and there and more</body></html>';
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.metaMissing, 1, 'metaMissing should be 1 when no description meta');
  });

  it('JSON-LD datePublished and offerPrice extracted correctly', () => {
    const html = [
      '<html><head>',
      '<script type="application/ld+json">',
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Product',
        'name': 'Test Product',
        'offers': { '@type': 'Offer', 'price': '29.99', 'availability': 'https://schema.org/InStock' },
      }),
      '</script>',
      '</head><body>Test product page with content words here and there</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/product');
    assert.strictEqual(r.hasProduct, 1, 'hasProduct should be 1');
    assert.strictEqual(r.offerPrice, '29.99', `offerPrice should be 29.99, got ${r.offerPrice}`);
    assert.strictEqual(r.availability, 'https://schema.org/InStock', `availability should match`);
    assert.strictEqual(r.ldValid, 1, 'ldValid should be 1');
  });

  // ── Important 1: Array-root JSON-LD ─────────────────────────────────────

  it('Array-root JSON-LD → hasProduct === 1', () => {
    const html = [
      '<html><head>',
      '<script type="application/ld+json">',
      JSON.stringify([{ '@context': 'https://schema.org', '@type': 'Product', 'name': 'Test' }]),
      '</script>',
      '</head><body>Test product array ld+json page content words here now</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/product');
    assert.strictEqual(r.hasProduct, 1, `hasProduct should be 1 for array-root JSON-LD, got ${r.hasProduct}`);
  });

  // ── Important 2: Config-domain suffix-match ──────────────────────────────

  it('link to www.bbc.com → outlinksAuthoritative >= 1 (subdomain of config domain)', () => {
    const url = 'http://example.com/page.html';
    const html = [
      '<html><head></head><body>',
      '<a href="https://www.bbc.com/news/article">BBC article</a>',
      'words words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.ok(
      r.outlinksAuthoritative >= 1,
      `www.bbc.com should be authoritative (subdomain of bbc.com), got ${r.outlinksAuthoritative}`,
    );
  });

  it('link to notbbc.com → outlinksAuthoritative === 0 (not a suffix match)', () => {
    const url = 'http://example.com/page.html';
    const html = [
      '<html><head></head><body>',
      '<a href="https://notbbc.com/news/article">Not BBC article</a>',
      'words words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.strictEqual(
      r.outlinksAuthoritative,
      0,
      `notbbc.com must NOT be authoritative, got ${r.outlinksAuthoritative}`,
    );
  });

  // ── Important-3: @graph date and Offer extraction (Yoast/WordPress pattern) ──

  it('@graph JSON-LD → datePublished and dateModified extracted from @graph node', () => {
    const html = [
      '<html><head>',
      '<script type="application/ld+json">',
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'Article', 'datePublished': '2026-01-01', 'dateModified': '2026-02-01' },
        ],
      }),
      '</script>',
      '</head><body>Article content words here for testing purposes now</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/article');
    assert.strictEqual(r.datePublished, '2026-01-01',
      `datePublished should be extracted from @graph node, got "${r.datePublished}"`);
    assert.strictEqual(r.dateModified, '2026-02-01',
      `dateModified should be extracted from @graph node, got "${r.dateModified}"`);
  });

  it('@graph JSON-LD → Offer price and availability extracted from @graph Product node', () => {
    const html = [
      '<html><head>',
      '<script type="application/ld+json">',
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Product',
            'name': 'Widget',
            'offers': { '@type': 'Offer', 'price': '49.99', 'availability': 'https://schema.org/InStock' },
          },
        ],
      }),
      '</script>',
      '</head><body>Product content words here for testing purposes now</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/product');
    assert.strictEqual(r.offerPrice, '49.99',
      `offerPrice should be extracted from @graph Product node, got "${r.offerPrice}"`);
    assert.ok(r.availability.includes('InStock'),
      `availability should be extracted from @graph Product node, got "${r.availability}"`);
  });

  it('hreflangCount reflects number of alternate hreflang links', () => {
    const html = [
      '<html><head>',
      '<link rel="alternate" hreflang="de" href="http://example.com/de/">',
      '<link rel="alternate" hreflang="en" href="http://example.com/en/">',
      '</head><body>content words here and there for testing purposes now</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hreflangCount, 2, `hreflangCount should be 2, got ${r.hreflangCount}`);
    assert.ok(r.hreflang.includes('de'), 'hreflang should include de');
    assert.ok(r.hreflang.includes('en'), 'hreflang should include en');
  });
});

// ── U1-A Fix-1: property= Meta-Tags (OG / article:*) ────────────────────────

describe('parsePage — Fix 1: property= meta tag support', () => {
  it('article:published_time via property= → datePublished gesetzt (kein JSON-LD)', () => {
    // RED: getMetaContent matcht nur name=, nicht property= → datePublished bleibt leer
    const html = [
      '<html><head>',
      '<meta property="article:published_time" content="2026-01-01">',
      '<meta property="article:modified_time"  content="2026-03-15">',
      '</head><body>',
      'Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/post');
    assert.strictEqual(r.datePublished, '2026-01-01',
      `datePublished sollte aus property="article:published_time" gelesen werden, got "${r.datePublished}"`);
    assert.strictEqual(r.dateModified, '2026-03-15',
      `dateModified sollte aus property="article:modified_time" gelesen werden, got "${r.dateModified}"`);
  });

  it('OG-property= meta tag wird gelesen (og:description existiert als property)', () => {
    // Stellt sicher, dass property= generell erkannt wird (kein Seiteneffekt auf name=)
    const html = [
      '<html><head>',
      '<meta property="og:title" content="OG Titel">',
      '<meta name="description" content="Normale Beschreibung">',
      '</head><body>',
      'Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter',
      '</body></html>',
    ].join('');
    // property="article:published_time" fehlt → datePublished leer, aber property= selbst ist
    // jetzt grundsätzlich erkennbar — indirekter Nachweis via datePublished-Test genügt
    const r2Html = [
      '<html><head>',
      '<meta property="article:published_time" content="2025-05-01">',
      '</head><body>',
      'Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter',
      '</body></html>',
    ].join('');
    const r2 = parsePage(r2Html, 'http://example.com/');
    assert.strictEqual(r2.datePublished, '2025-05-01',
      `datePublished sollte via property= gesetzt sein, got "${r2.datePublished}"`);
    // name= bleibt unverändert: meta name="description" weiterhin erkannt
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.metaDesc, 'Normale Beschreibung',
      `meta name="description" muss weiterhin erkannt werden, got "${r.metaDesc}"`);
  });
});

// ── U1-A Fix-2: Relatives rel=canonical ──────────────────────────────────────

describe('parsePage — Fix 2: relative canonical href', () => {
  it('relatives canonical href="/p" → canonSelf === 1 für url https://x.de/p', () => {
    // RED: new URL("/p") wirft ohne Base → catch → canonSelf=0 → Fehlalarm
    const url = 'https://x.de/p';
    const html = [
      '<html><head>',
      '<link rel="canonical" href="/p">',
      '</head><body>',
      'Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.strictEqual(r.canonSelf, 1,
      `canonSelf muss 1 sein für relatives canonical "/p" und url "${url}", got ${r.canonSelf}`);
  });

  it('relatives canonical href="/andere" → canonSelf === 0 (zeigt auf andere Seite)', () => {
    const url = 'https://x.de/p';
    const html = [
      '<html><head>',
      '<link rel="canonical" href="/andere">',
      '</head><body>',
      'Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.strictEqual(r.canonSelf, 0,
      `canonSelf muss 0 sein für relatives canonical "/andere" ≠ url "${url}", got ${r.canonSelf}`);
  });
});

// ── canonSelf ignores the query string (tracking-param URLs) ──────────────────
// A page reached with tracking params (utm/gclid/fbclid …) whose rel=canonical
// points at the param-free path IS self-canonical and must NOT be flagged by
// tech:canonical-nonself. The comparison drops the query (after the trailing-slash
// strip); cross-host / different-path canonicals stay non-self.

describe('parsePage — canonSelf ignores query string (tracking params)', () => {
  it('url "/p?utm=x" with canonical "/p" → canonSelf === 1 (not flagged)', () => {
    const url = 'https://x.de/p?utm=x';
    const html = [
      '<html><head>',
      '<link rel="canonical" href="/p">',
      '</head><body>',
      'Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.strictEqual(r.canonSelf, 1,
      `canonSelf muss 1 sein für url "${url}" mit canonical "/p" (Query ignorieren), got ${r.canonSelf}`);
  });

  it('url "/p?utm=x" with absolute self canonical "https://x.de/p" → canonSelf === 1', () => {
    const url = 'https://x.de/p?utm=x&gclid=123';
    const html = [
      '<html><head>',
      '<link rel="canonical" href="https://x.de/p">',
      '</head><body>',
      'Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.strictEqual(r.canonSelf, 1,
      `canonSelf muss 1 sein; Tracking-Param darf canonSelf nicht auf 0 setzen, got ${r.canonSelf}`);
  });

  it('url "/p?utm=x" with canonical to DIFFERENT path "/q" → canonSelf === 0 (still flagged)', () => {
    const url = 'https://x.de/p?utm=x';
    const html = [
      '<html><head>',
      '<link rel="canonical" href="/q">',
      '</head><body>',
      'Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.strictEqual(r.canonSelf, 0,
      `canonSelf muss 0 sein für anderen Pfad "/q" ≠ "/p", got ${r.canonSelf}`);
  });

  it('cross-host canonical "https://other.de/p" → canonSelf === 0 (still flagged)', () => {
    const url = 'https://x.de/p?utm=x';
    const html = [
      '<html><head>',
      '<link rel="canonical" href="https://other.de/p">',
      '</head><body>',
      'Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    assert.strictEqual(r.canonSelf, 0,
      `canonSelf muss 0 sein für fremden Host "other.de" ≠ "x.de", got ${r.canonSelf}`);
  });
});

// ── U1-A Fix-3: HTML-Kommentare strippen ─────────────────────────────────────

describe('parsePage — Fix 3: HTML-Kommentare werden vor Head-Scans entfernt', () => {
  it('auskommentiertes <link rel=canonical> wird NICHT als Canonical erkannt', () => {
    // RED: auskommentierter Canonical-Tag wird fälschlicherweise geparst → Fehlalarm
    const url = 'https://example.com/page';
    const html = [
      '<html><head>',
      '<!-- <link rel="canonical" href="/stale"> -->',
      '<link rel="canonical" href="https://example.com/page">',
      '</head><body>',
      'Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt',
      '</body></html>',
    ].join('');
    const r = parsePage(html, url);
    // Das echte Canonical stimmt mit der URL überein → canonSelf muss 1 sein
    // (würde 0 sein, wenn der auskommentierte "/stale"-Tag zuerst erkannt würde)
    assert.strictEqual(r.canonSelf, 1,
      `canonSelf muss 1 sein; auskommentierter Canonical "/stale" darf nicht erkannt werden, got ${r.canonSelf}`);
    assert.strictEqual(r.canonical, 'https://example.com/page',
      `canonical muss das echte Tag zeigen, got "${r.canonical}"`);
  });

  it('auskommentierter kaputter JSON-LD-Block → ldValid bleibt 1', () => {
    // RED: auskommentierter unparsbarer JSON-LD-Block → JSON.parse wirft → ldValid=0 Fehlalarm
    const html = [
      '<html><head>',
      '<!-- <script type="application/ld+json">{ KAPUTT }</script> -->',
      '<script type="application/ld+json">',
      JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage' }),
      '</script>',
      '</head><body>',
      'Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.ldValid, 1,
      `ldValid muss 1 bleiben; auskommentierter kaputt JSON-LD darf ldValid nicht auf 0 setzen, got ${r.ldValid}`);
  });
});

// ── U1-B Fix 1: Entity-Decode + normalizeUrl in internalLinks ────────────────

describe('parsePage — U1-B Fix 1: &amp;-Entity-Decode in internalLinks', () => {
  it('href mit &amp; → internalLink enthält kein "amp;" (entity-decoded)', () => {
    // RED: href wird NICHT dekodiert → resolved.search enthält "amp;" → Link matcht nie die saubere URL
    const html = [
      '<html><head></head><body>',
      '<a href="/s?q=a&amp;p=2">Suche</a>',
      'Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.ok(
      r.internalLinks.includes('http://example.com/s?q=a&p=2'),
      `internalLinks sollte 'http://example.com/s?q=a&p=2' enthalten, got ${JSON.stringify(r.internalLinks)}`,
    );
    assert.ok(
      !r.internalLinks.some(u => u.includes('amp;')),
      `kein Link sollte literal "amp;" enthalten, got ${JSON.stringify(r.internalLinks)}`,
    );
  });

  it('Link auf /dir/index.html → normalizeUrl → /dir in internalLinks', () => {
    // RED: kein normalizeUrl → internalLinks enthält '/dir/index.html' statt '/dir'
    const html = [
      '<html><head></head><body>',
      '<a href="/dir/index.html">Verzeichnis</a>',
      'Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/page');
    assert.ok(
      r.internalLinks.includes('http://example.com/dir'),
      `internalLinks sollte 'http://example.com/dir' enthalten (normalisiert aus /dir/index.html), got ${JSON.stringify(r.internalLinks)}`,
    );
  });
});

// ── U1-B Fix 2: <picture>/<source>/srcset moderne Bilder ─────────────────────

describe('parsePage — U1-B Fix 2: picture/source/srcset moderne Bildformate', () => {
  it('<picture><source type="image/webp"> → imgWebp >= 1', () => {
    // RED: <source> wird nicht gescannt → imgWebp=0, imgJpg=1 → onpage:non-modern-image-format Fehlalarm
    const html = [
      '<html><head></head><body>',
      '<picture>',
      '  <source type="image/webp" srcset="x.webp">',
      '  <img src="x.jpg" alt="test">',
      '</picture>',
      'Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/page');
    assert.ok(r.imgWebp >= 1,
      `imgWebp sollte >= 1 sein für <source type=image/webp>, got ${r.imgWebp}`);
    assert.strictEqual(r.imgJpg, 1,
      `imgJpg sollte 1 sein für <img src=x.jpg>, got ${r.imgJpg}`);
  });

  it('<source type="image/avif"> → imgAvif >= 1', () => {
    const html = [
      '<html><head></head><body>',
      '<picture>',
      '  <source type="image/avif" srcset="x.avif">',
      '  <img src="x.jpg" alt="test">',
      '</picture>',
      'Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/page');
    assert.ok(r.imgAvif >= 1,
      `imgAvif sollte >= 1 sein für <source type=image/avif>, got ${r.imgAvif}`);
  });

  it('<img srcset="x.webp 800w"> → imgWebp >= 1', () => {
    const html = [
      '<html><head></head><body>',
      '<img src="x.jpg" srcset="x.webp 800w" alt="test">',
      'Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/page');
    assert.ok(r.imgWebp >= 1,
      `imgWebp sollte >= 1 sein für <img srcset=x.webp>, got ${r.imgWebp}`);
  });

  it('<picture>/<source> WebP: onpage:non-modern-image-format-Bedingung false → kein Fehlalarm', () => {
    // End-to-End: Engine-Bedingung (imgJpg>0 && imgWebp===0 && imgAvif===0) darf NICHT wahr sein
    const html = [
      '<html><head></head><body>',
      '<picture>',
      '  <source type="image/webp" srcset="x.webp">',
      '  <img src="x.jpg" alt="test">',
      '</picture>',
      'Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'https://example.com/page');
    const jpg  = parseInt(r.imgJpg,  10);
    const webp = parseInt(r.imgWebp, 10);
    const avif = parseInt(r.imgAvif, 10);
    const wouldFire = jpg > 0 && (isNaN(webp) || webp === 0) && (isNaN(avif) || avif === 0);
    assert.ok(!wouldFire,
      `onpage:non-modern-image-format sollte NICHT feuern für Best-Practice-Seite; got imgJpg=${jpg} imgWebp=${webp} imgAvif=${avif}`);
  });
});

// ── U1-B Fix 3: mixedContent-Regex erweitern + Attribut-Grenze ───────────────

describe('parsePage — U1-B Fix 3: mixedContent iframe + Attribut-Grenze', () => {
  it('<iframe src="http://..."> auf https-Seite → mixedContent === 1', () => {
    // RED: <iframe> fehlt in der Tag-Alternation → wird nicht erkannt → mixedContent=0 Fehlnegativ
    const html = [
      '<html><head></head><body>',
      '<iframe src="http://evil.com/tracker"></iframe>',
      'Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'https://example.com/page');
    assert.strictEqual(r.mixedContent, 1,
      `mixedContent muss 1 sein für <iframe src=http://> auf https-Seite, got ${r.mixedContent}`);
  });

  it('einziges http:// steht in <img data-src="http://..."> → mixedContent === 0', () => {
    // RED: keine Attribut-Grenze → data-src matcht fälschlich → mixedContent=1 Fehlalarm
    const html = [
      '<html><head></head><body>',
      '<img data-src="http://lazy.example.com/img.jpg" alt="lazy">',
      'Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'https://example.com/page');
    assert.strictEqual(r.mixedContent, 0,
      `mixedContent muss 0 sein wenn http:// nur in data-src steht, got ${r.mixedContent}`);
  });

  it('<video src="http://..."> auf https-Seite → mixedContent === 1', () => {
    const html = [
      '<html><head></head><body>',
      '<video src="http://cdn.example.com/video.mp4"></video>',
      'Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter Wörter',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'https://example.com/page');
    assert.strictEqual(r.mixedContent, 1,
      `mixedContent muss 1 sein für <video src=http://> auf https-Seite, got ${r.mixedContent}`);
  });
});

// ── U1-A Fix-4: CDATA-umhülltes JSON-LD ─────────────────────────────────────

describe('parsePage — Fix 4: CDATA-umhülltes JSON-LD wird korrekt geparst', () => {
  it('valides JSON-LD in //<![CDATA[ … //]]> → ldValid===1, @type erkannt', () => {
    // RED: CDATA-Hülle macht JSON.parse kaputt → ldValid=0 Fehlalarm
    const html = [
      '<html><head>',
      '<script type="application/ld+json">',
      '//<![CDATA[',
      JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', 'headline': 'Test' }),
      '//]]>',
      '</script>',
      '</head><body>',
      'Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt',
      '</body></html>',
    ].join('\n');
    const r = parsePage(html, 'http://example.com/article');
    assert.strictEqual(r.ldValid, 1,
      `ldValid muss 1 sein für CDATA-umhülltes valides JSON-LD, got ${r.ldValid}`);
    assert.ok(r.ldTypes.includes('Article'),
      `@type Article muss erkannt sein, got ldTypes="${r.ldTypes}"`);
  });

  it('CDATA mit /* */ Kommentar-Variante → ldValid===1', () => {
    const html = [
      '<html><head>',
      '<script type="application/ld+json">',
      '/*<![CDATA[*/',
      JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', 'name': 'Test' }),
      '/*]]>*/',
      '</script>',
      '</head><body>',
      'Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt Inhalt',
      '</body></html>',
    ].join('\n');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.ldValid, 1,
      `ldValid muss 1 sein für /*<![CDATA[*/…/*]]>*/-Variante, got ${r.ldValid}`);
    assert.ok(r.ldTypes.includes('WebSite'),
      `@type WebSite muss erkannt sein, got ldTypes="${r.ldTypes}"`);
  });
});

// ── U4.1: viewportContent + charsetOk extraction ─────────────────────────────

describe('parsePage — U4.1: viewportContent extraction', () => {

  it('viewportContent extracted from <meta name="viewport">', () => {
    const html = [
      '<html lang="de"><head>',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>Test</title>',
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.viewportContent, 'width=device-width, initial-scale=1',
      `viewportContent should be extracted, got: "${r.viewportContent}"`);
  });

  it('viewportContent is empty string when no viewport meta present', () => {
    const html = [
      '<html><head>',
      '<title>No Viewport</title>',
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.viewportContent, '',
      `viewportContent should be empty string when missing, got: "${r.viewportContent}"`);
  });

  it('viewportContent in emptyResult() is empty string (null html)', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.viewportContent, '',
      `emptyResult viewportContent should be "", got: "${r.viewportContent}"`);
  });
});

describe('parsePage — U4.1: charsetOk extraction', () => {

  it('charsetOk is "1" when <meta charset="utf-8"> present in first 1024 bytes', () => {
    const html = [
      '<html><head>',
      '<meta charset="utf-8">',
      '<title>Test</title>',
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.charsetOk, '1',
      `charsetOk should be "1" when charset meta present, got: "${r.charsetOk}"`);
  });

  it('charsetOk is "1" for http-equiv Content-Type charset=utf-8 variant', () => {
    const html = [
      '<html><head>',
      '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
      '<title>Test</title>',
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.charsetOk, '1',
      `charsetOk should be "1" for http-equiv Content-Type charset, got: "${r.charsetOk}"`);
  });

  it('charsetOk is "1" for charset=utf8 (no dash variant)', () => {
    const html = '<html><head><meta charset="utf8"><title>T</title></head><body>' +
      'words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.charsetOk, '1',
      `charsetOk should be "1" for charset=utf8, got: "${r.charsetOk}"`);
  });

  it('charsetOk is "0" when no charset meta is present', () => {
    const html = [
      '<html><head>',
      '<title>No Charset</title>',
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.charsetOk, '0',
      `charsetOk should be "0" when no charset meta present, got: "${r.charsetOk}"`);
  });

  it('charsetOk is "0" when charset declaration only appears after 1024 bytes', () => {
    // Build HTML where charset is pushed beyond the 1024-byte boundary
    const padding = ' '.repeat(1050);
    const html = '<html><head><title>Delayed</title>' + padding + '</head>' +
      '<body>words words words words words words words words words words</body></html>' +
      '<meta charset="utf-8">';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.charsetOk, '0',
      `charsetOk should be "0" when charset only appears after first 1024 bytes`);
  });

  it('charsetOk in emptyResult() is "0" (null html)', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.charsetOk, '0',
      `emptyResult charsetOk should be "0", got: "${r.charsetOk}"`);
  });
});

// ── U4.2: ogTitle / ogImage / ogUrl / hasFavicon / canonicalCount ─────────────

describe('parsePage — U4.2: ogTitle / ogImage / ogUrl extraction', () => {

  it('ogTitle extracted from <meta property="og:title">', () => {
    const html = '<html><head><meta charset="utf-8">' +
      '<meta property="og:title" content="My Page Title">' +
      '<title>T</title></head><body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.ogTitle, 'My Page Title',
      `ogTitle should be "My Page Title", got: "${r.ogTitle}"`);
  });

  it('ogImage extracted from <meta property="og:image">', () => {
    const html = '<html><head><meta charset="utf-8">' +
      '<meta property="og:image" content="https://example.com/img.jpg">' +
      '<title>T</title></head><body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.ogImage, 'https://example.com/img.jpg',
      `ogImage should be extracted, got: "${r.ogImage}"`);
  });

  it('ogUrl extracted from <meta property="og:url">', () => {
    const html = '<html><head><meta charset="utf-8">' +
      '<meta property="og:url" content="https://example.com/page">' +
      '<title>T</title></head><body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.ogUrl, 'https://example.com/page',
      `ogUrl should be extracted, got: "${r.ogUrl}"`);
  });

  it('ogTitle is "" when og:title absent', () => {
    const html = '<html><head><meta charset="utf-8"><title>T</title></head>' +
      '<body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.ogTitle, '',
      `ogTitle should be "" when absent, got: "${r.ogTitle}"`);
  });

  it('ogImage is "" when og:image absent', () => {
    const html = '<html><head><meta charset="utf-8"><title>T</title></head>' +
      '<body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.ogImage, '',
      `ogImage should be "" when absent, got: "${r.ogImage}"`);
  });

  it('ogUrl is "" when og:url absent', () => {
    const html = '<html><head><meta charset="utf-8"><title>T</title></head>' +
      '<body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.ogUrl, '',
      `ogUrl should be "" when absent, got: "${r.ogUrl}"`);
  });

  it('ogTitle / ogImage / ogUrl are "" in emptyResult() (null html)', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.ogTitle, '', `emptyResult ogTitle should be "", got: "${r.ogTitle}"`);
    assert.strictEqual(r.ogImage, '', `emptyResult ogImage should be "", got: "${r.ogImage}"`);
    assert.strictEqual(r.ogUrl,   '', `emptyResult ogUrl should be "", got: "${r.ogUrl}"`);
  });
});

describe('parsePage — U4.2: hasFavicon extraction', () => {

  it('hasFavicon === 1 for <link rel="icon">', () => {
    const html = '<html><head><meta charset="utf-8">' +
      '<link rel="icon" href="/favicon.ico">' +
      '<title>T</title></head><body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasFavicon, 1,
      `hasFavicon should be 1 for rel="icon", got: ${r.hasFavicon}`);
  });

  it('hasFavicon === 1 for <link rel="shortcut icon">', () => {
    const html = '<html><head><meta charset="utf-8">' +
      '<link rel="shortcut icon" href="/favicon.ico">' +
      '<title>T</title></head><body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasFavicon, 1,
      `hasFavicon should be 1 for rel="shortcut icon", got: ${r.hasFavicon}`);
  });

  it('hasFavicon === 1 for <link rel="apple-touch-icon">', () => {
    const html = '<html><head><meta charset="utf-8">' +
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">' +
      '<title>T</title></head><body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasFavicon, 1,
      `hasFavicon should be 1 for rel="apple-touch-icon", got: ${r.hasFavicon}`);
  });

  it('hasFavicon === 0 when no icon link present', () => {
    const html = '<html><head><meta charset="utf-8">' +
      '<link rel="canonical" href="http://example.com/">' +
      '<title>T</title></head><body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasFavicon, 0,
      `hasFavicon should be 0 when no icon link, got: ${r.hasFavicon}`);
  });

  it('hasFavicon === 0 in emptyResult() (null html)', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.hasFavicon, 0,
      `emptyResult hasFavicon should be 0, got: ${r.hasFavicon}`);
  });
});

describe('parsePage — U4.2: canonicalCount extraction', () => {

  it('canonicalCount === 1 for a single canonical', () => {
    const html = '<html><head><meta charset="utf-8">' +
      '<link rel="canonical" href="https://example.com/page">' +
      '<title>T</title></head><body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.canonicalCount, 1,
      `canonicalCount should be 1 for single canonical, got: ${r.canonicalCount}`);
  });

  it('canonicalCount === 2 for two canonicals with DIFFERENT hrefs', () => {
    const html = '<html><head><meta charset="utf-8">' +
      '<link rel="canonical" href="https://example.com/page">' +
      '<link rel="canonical" href="https://example.com/other">' +
      '<title>T</title></head><body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.canonicalCount, 2,
      `canonicalCount should be 2 for two distinct canonical hrefs, got: ${r.canonicalCount}`);
  });

  it('canonicalCount === 1 for two canonicals with the SAME href (distinct dedupe)', () => {
    const html = '<html><head><meta charset="utf-8">' +
      '<link rel="canonical" href="https://example.com/page">' +
      '<link rel="canonical" href="https://example.com/page">' +
      '<title>T</title></head><body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.canonicalCount, 1,
      `canonicalCount should be 1 when two canonicals share the same href, got: ${r.canonicalCount}`);
  });

  it('canonicalCount === 0 when no canonical is present', () => {
    const html = '<html><head><meta charset="utf-8">' +
      '<title>T</title></head><body>words words words words words words words words words words</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.canonicalCount, 0,
      `canonicalCount should be 0 when no canonical, got: ${r.canonicalCount}`);
  });

  it('canonicalCount === 0 in emptyResult() (null html)', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.canonicalCount, 0,
      `emptyResult canonicalCount should be 0, got: ${r.canonicalCount}`);
  });
});

// ── U4.3: imgNoDimensions + firstImgLazy extraction ──────────────────────────

describe('parsePage — U4.3: imgNoDimensions extraction', () => {

  it('imgNoDimensions === 0 for img with both width and height', () => {
    const html = '<html><head></head><body>' +
      '<img src="a.jpg" alt="a" width="800" height="600">' +
      'words words words words words words words words words words' +
      '</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.imgNoDimensions, 0,
      `imgNoDimensions should be 0 for img with width+height, got: ${r.imgNoDimensions}`);
  });

  it('imgNoDimensions === 1 for img with width only (no height)', () => {
    const html = '<html><head></head><body>' +
      '<img src="a.jpg" alt="a" width="800">' +
      'words words words words words words words words words words' +
      '</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.imgNoDimensions, 1,
      `imgNoDimensions should be 1 for img with width only, got: ${r.imgNoDimensions}`);
  });

  it('imgNoDimensions === 1 for img with height only (no width)', () => {
    const html = '<html><head></head><body>' +
      '<img src="a.jpg" alt="a" height="600">' +
      'words words words words words words words words words words' +
      '</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.imgNoDimensions, 1,
      `imgNoDimensions should be 1 for img with height only, got: ${r.imgNoDimensions}`);
  });

  it('imgNoDimensions === 1 for img with neither width nor height', () => {
    const html = '<html><head></head><body>' +
      '<img src="a.jpg" alt="a">' +
      'words words words words words words words words words words' +
      '</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.imgNoDimensions, 1,
      `imgNoDimensions should be 1 for img with no dimensions, got: ${r.imgNoDimensions}`);
  });

  it('imgNoDimensions === 1 when one img has both and another lacks height', () => {
    const html = '<html><head></head><body>' +
      '<img src="a.jpg" alt="a" width="800" height="600">' +
      '<img src="b.jpg" alt="b" width="400">' +
      'words words words words words words words words words words' +
      '</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.imgNoDimensions, 1,
      `imgNoDimensions should be 1 (second img missing height), got: ${r.imgNoDimensions}`);
  });

  it('data-width and data-height do NOT count as real dimensions (img with only data-width → counted missing)', () => {
    const html = '<html><head></head><body>' +
      '<img src="a.jpg" alt="a" data-width="800" data-height="600">' +
      'words words words words words words words words words words' +
      '</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.imgNoDimensions, 1,
      `imgNoDimensions should be 1 for img with only data-width/data-height (not real attrs), got: ${r.imgNoDimensions}`);
  });

  it('imgNoDimensions === 0 in emptyResult() (null html)', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.imgNoDimensions, 0,
      `emptyResult imgNoDimensions should be 0, got: ${r.imgNoDimensions}`);
  });
});

describe('parsePage — U4.3: firstImgLazy extraction', () => {

  it('firstImgLazy === 1 when first img has loading="lazy"', () => {
    const html = '<html><head></head><body>' +
      '<img src="hero.jpg" alt="hero" width="1200" height="600" loading="lazy">' +
      'words words words words words words words words words words' +
      '</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.firstImgLazy, 1,
      `firstImgLazy should be 1 when first img has loading="lazy", got: ${r.firstImgLazy}`);
  });

  it('firstImgLazy === 0 when first img is eager even if a later img is lazy', () => {
    const html = '<html><head></head><body>' +
      '<img src="hero.jpg" alt="hero" width="1200" height="600">' +
      '<img src="below.jpg" alt="below" loading="lazy">' +
      'words words words words words words words words words words' +
      '</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.firstImgLazy, 0,
      `firstImgLazy should be 0 when first img is eager, got: ${r.firstImgLazy}`);
  });

  it('firstImgLazy === 0 when there are no img elements', () => {
    const html = '<html><head></head><body>' +
      'words words words words words words words words words words' +
      '</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.firstImgLazy, 0,
      `firstImgLazy should be 0 when no img present, got: ${r.firstImgLazy}`);
  });

  it('firstImgLazy === 1 case-insensitive: LOADING="LAZY"', () => {
    const html = '<html><head></head><body>' +
      '<img src="hero.jpg" alt="hero" LOADING="LAZY">' +
      'words words words words words words words words words words' +
      '</body></html>';
    const r = parsePage(html, 'http://example.com/page.html');
    assert.strictEqual(r.firstImgLazy, 1,
      `firstImgLazy should be 1 for LOADING="LAZY" (case-insensitive), got: ${r.firstImgLazy}`);
  });

  it('firstImgLazy === 0 in emptyResult() (null html)', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.firstImgLazy, 0,
      `emptyResult firstImgLazy should be 0, got: ${r.firstImgLazy}`);
  });
});

// ── U4.4: domNodeCount extraction ─────────────────────────────────────────────

describe('parsePage — U4.4: domNodeCount extraction', () => {
  it('counts opening element tags in the body', () => {
    const html = `<html><body><div><p>Text</p><span>more</span></div></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    // body contains: div, p, span = 3 opening tags
    assert.strictEqual(r.domNodeCount, 3,
      `domNodeCount should be 3 (div+p+span), got: ${r.domNodeCount}`);
  });

  it('does NOT count tags inside <script> blocks', () => {
    const html = `<html><body><div></div><script>var s="<div><span>"</script></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    // only the real <div> counts; the ones in the script string do not
    assert.strictEqual(r.domNodeCount, 1,
      `domNodeCount should be 1 (script content must not count), got: ${r.domNodeCount}`);
  });

  it('does NOT count tags inside <style> blocks', () => {
    const html = `<html><body><p>text</p><style>.a > .b { color:red; }</style></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    // only the real <p> counts
    assert.strictEqual(r.domNodeCount, 1,
      `domNodeCount should be 1 (style content must not count), got: ${r.domNodeCount}`);
  });

  it('does NOT count tags inside HTML comments', () => {
    const html = `<html><body><p>real</p><!-- <div><span> --></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    // only the real <p> counts
    assert.strictEqual(r.domNodeCount, 1,
      `domNodeCount should be 1 (comment content must not count), got: ${r.domNodeCount}`);
  });

  it('domNodeCount === 0 in emptyResult() (null html)', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.domNodeCount, 0,
      `emptyResult domNodeCount should be 0, got: ${r.domNodeCount}`);
  });
});

// ── U4.4: headBlockingScripts extraction ──────────────────────────────────────

describe('parsePage — U4.4: headBlockingScripts extraction', () => {
  it('counts 1 for a blocking <script src> in head (no async/defer)', () => {
    const html = `<html><head><script src="a.js"></script></head><body></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingScripts, 1,
      `headBlockingScripts should be 1 for plain <script src>, got: ${r.headBlockingScripts}`);
  });

  it('does NOT count a <script src async> as blocking', () => {
    const html = `<html><head><script src="a.js" async></script></head><body></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingScripts, 0,
      `headBlockingScripts should be 0 for async script, got: ${r.headBlockingScripts}`);
  });

  it('does NOT count a <script src defer> as blocking', () => {
    const html = `<html><head><script src="a.js" defer></script></head><body></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingScripts, 0,
      `headBlockingScripts should be 0 for defer script, got: ${r.headBlockingScripts}`);
  });

  it('does NOT count a <script type="module" src> as blocking', () => {
    const html = `<html><head><script type="module" src="a.mjs"></script></head><body></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingScripts, 0,
      `headBlockingScripts should be 0 for type=module script, got: ${r.headBlockingScripts}`);
  });

  it('does NOT count an inline <script> (no src) as blocking', () => {
    const html = `<html><head><script>console.log("hi")</script></head><body></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingScripts, 0,
      `headBlockingScripts should be 0 for inline script (no src), got: ${r.headBlockingScripts}`);
  });

  it('does NOT count <script type="application/ld+json"> as blocking', () => {
    const html = `<html><head><script type="application/ld+json">{"@context":"https://schema.org"}</script></head><body></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingScripts, 0,
      `headBlockingScripts should be 0 for ld+json script, got: ${r.headBlockingScripts}`);
  });

  it('does NOT count a <script src> in the body (not head)', () => {
    const html = `<html><head></head><body><script src="a.js"></script></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingScripts, 0,
      `headBlockingScripts should be 0 for body script, got: ${r.headBlockingScripts}`);
  });

  it('headBlockingScripts === 0 in emptyResult() (null html)', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.headBlockingScripts, 0,
      `emptyResult headBlockingScripts should be 0, got: ${r.headBlockingScripts}`);
  });
});

// ── U4.4: headBlockingStyles extraction ───────────────────────────────────────

describe('parsePage — U4.4: headBlockingStyles extraction', () => {
  it('counts 1 for a single render-blocking stylesheet in head', () => {
    const html = `<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingStyles, 1,
      `headBlockingStyles should be 1 for one stylesheet, got: ${r.headBlockingStyles}`);
  });

  it('does NOT count a print stylesheet as blocking', () => {
    const html = `<html><head><link rel="stylesheet" href="print.css" media="print"></head><body></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingStyles, 0,
      `headBlockingStyles should be 0 for media=print, got: ${r.headBlockingStyles}`);
  });

  it('counts 4 for four stylesheets', () => {
    const html = `<html><head>
      <link rel="stylesheet" href="a.css">
      <link rel="stylesheet" href="b.css">
      <link rel="stylesheet" href="c.css">
      <link rel="stylesheet" href="d.css">
    </head><body></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingStyles, 4,
      `headBlockingStyles should be 4 for four stylesheets, got: ${r.headBlockingStyles}`);
  });

  it('does NOT count <link rel="icon"> as a blocking stylesheet', () => {
    const html = `<html><head><link rel="icon" href="/favicon.ico"></head><body></body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingStyles, 0,
      `headBlockingStyles should be 0 for link rel=icon, got: ${r.headBlockingStyles}`);
  });

  it('headBlockingStyles === 0 in emptyResult() (null html)', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.headBlockingStyles, 0,
      `emptyResult headBlockingStyles should be 0, got: ${r.headBlockingStyles}`);
  });
});

// ── U4.5: genericAnchorCount + emptyLinkCount extraction ─────────────────────

describe('parsePage — U4.5: genericAnchorCount + emptyLinkCount extraction', () => {

  it('counts 1 for a generic anchor text "hier"', () => {
    const html = `<html><head></head><body><a href="/x">hier</a> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.genericAnchorCount, 1,
      `genericAnchorCount should be 1 for "hier", got: ${r.genericAnchorCount}`);
    assert.strictEqual(r.emptyLinkCount, 0,
      `emptyLinkCount should be 0, got: ${r.emptyLinkCount}`);
  });

  it('counts 1 for "Mehr" (case-insensitive match)', () => {
    const html = `<html><head></head><body><a href="/y">Mehr</a> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.genericAnchorCount, 1,
      `genericAnchorCount should be 1 for "Mehr" (case-insensitive), got: ${r.genericAnchorCount}`);
  });

  it('counts 1 for "click here" (EN generic)', () => {
    const html = `<html><head></head><body><a href="/z">click here</a> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.genericAnchorCount, 1,
      `genericAnchorCount should be 1 for "click here", got: ${r.genericAnchorCount}`);
  });

  it('counts 0 for a descriptive anchor text "Vollständigen Leitfaden lesen"', () => {
    const html = `<html><head></head><body><a href="/guide">Vollständigen Leitfaden lesen</a> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.genericAnchorCount, 0,
      `genericAnchorCount should be 0 for descriptive text, got: ${r.genericAnchorCount}`);
  });

  it('counts 1 for an empty link <a href></a>', () => {
    const html = `<html><head></head><body><a href=""></a> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.emptyLinkCount, 1,
      `emptyLinkCount should be 1 for empty link, got: ${r.emptyLinkCount}`);
    assert.strictEqual(r.genericAnchorCount, 0,
      `genericAnchorCount should be 0 for empty link, got: ${r.genericAnchorCount}`);
  });

  it('counts 0 for <a href><img src="i.png" alt="Start"></a> — img alt names it', () => {
    const html = `<html><head></head><body><a href=""><img src="i.png" alt="Start"></a> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.emptyLinkCount, 0,
      `emptyLinkCount should be 0 when inner img has alt, got: ${r.emptyLinkCount}`);
    assert.strictEqual(r.genericAnchorCount, 0,
      `genericAnchorCount should be 0 when inner img has alt, got: ${r.genericAnchorCount}`);
  });

  it('counts 0 for <a href aria-label="Read full article">more</a> — descriptive aria-label', () => {
    const html = `<html><head></head><body><a href="/art" aria-label="Read full article">more</a> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.genericAnchorCount, 0,
      `genericAnchorCount should be 0 when aria-label overrides, got: ${r.genericAnchorCount}`);
    assert.strictEqual(r.emptyLinkCount, 0,
      `emptyLinkCount should be 0 when aria-label present, got: ${r.emptyLinkCount}`);
  });

  it('counts 0 for <a name="x">no href</a> — not a link (no href)', () => {
    const html = `<html><head></head><body><a name="x">no href</a> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.genericAnchorCount, 0,
      `genericAnchorCount should be 0 for anchor without href, got: ${r.genericAnchorCount}`);
    assert.strictEqual(r.emptyLinkCount, 0,
      `emptyLinkCount should be 0 for anchor without href, got: ${r.emptyLinkCount}`);
  });

  it('emptyResult → both 0', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.genericAnchorCount, 0,
      `emptyResult genericAnchorCount should be 0, got: ${r.genericAnchorCount}`);
    assert.strictEqual(r.emptyLinkCount, 0,
      `emptyResult emptyLinkCount should be 0, got: ${r.emptyLinkCount}`);
  });
});

// ── U4.5: unlabeledControlCount extraction ───────────────────────────────────

describe('parsePage — U4.5: unlabeledControlCount extraction', () => {

  it('counts 1 for <iframe src="x.html"></iframe> (no title)', () => {
    const html = `<html><head></head><body><iframe src="x.html"></iframe> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.unlabeledControlCount, 1,
      `unlabeledControlCount should be 1 for iframe without title, got: ${r.unlabeledControlCount}`);
  });

  it('counts 0 for <iframe src="x.html" title="Karte"></iframe>', () => {
    const html = `<html><head></head><body><iframe src="x.html" title="Karte"></iframe> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.unlabeledControlCount, 0,
      `unlabeledControlCount should be 0 when iframe has title, got: ${r.unlabeledControlCount}`);
  });

  it('counts 1 for <button></button> (empty, no aria-label)', () => {
    const html = `<html><head></head><body><button></button> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.unlabeledControlCount, 1,
      `unlabeledControlCount should be 1 for empty button, got: ${r.unlabeledControlCount}`);
  });

  it('counts 0 for <button>Speichern</button>', () => {
    const html = `<html><head></head><body><button>Speichern</button> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.unlabeledControlCount, 0,
      `unlabeledControlCount should be 0 for button with text, got: ${r.unlabeledControlCount}`);
  });

  it('counts 0 for <button aria-label="Schließen"></button>', () => {
    const html = `<html><head></head><body><button aria-label="Schließen"></button> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.unlabeledControlCount, 0,
      `unlabeledControlCount should be 0 when button has aria-label, got: ${r.unlabeledControlCount}`);
  });

  it('counts 0 for <button><img src="i.png" alt="Schließen"></button>', () => {
    const html = `<html><head></head><body><button><img src="i.png" alt="Schließen"></button> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.unlabeledControlCount, 0,
      `unlabeledControlCount should be 0 when button contains img with alt, got: ${r.unlabeledControlCount}`);
  });

  it('counts 2 for iframe-no-title + empty button together', () => {
    const html = `<html><head></head><body><iframe src="x.html"></iframe><button></button> words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.unlabeledControlCount, 2,
      `unlabeledControlCount should be 2 for iframe-no-title + empty button, got: ${r.unlabeledControlCount}`);
  });

  it('emptyResult → 0', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.unlabeledControlCount, 0,
      `emptyResult unlabeledControlCount should be 0, got: ${r.unlabeledControlCount}`);
  });
});

// ── U4.5: mixed-content regex extension (form + track) ───────────────────────

describe('parsePage — U4.5: mixed-content regex extension (form + track)', () => {

  it('<form action="http://x.com/s"> on https page → mixedContent === 1', () => {
    const html = `<html><head></head><body><form action="http://x.com/s"><button>Go</button></form> words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'https://example.com/');
    assert.strictEqual(r.mixedContent, 1,
      `mixedContent should be 1 for <form action=http://> on https page, got: ${r.mixedContent}`);
  });

  it('<track src="http://x/s.vtt"> on https page → mixedContent === 1', () => {
    const html = `<html><head></head><body><video><track src="http://x/s.vtt"></video> words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'https://example.com/');
    assert.strictEqual(r.mixedContent, 1,
      `mixedContent should be 1 for <track src=http://> on https page, got: ${r.mixedContent}`);
  });

  it('<form action="/s"> (relative) on https page → mixedContent === 0', () => {
    const html = `<html><head></head><body><form action="/s"><button>Go</button></form> words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'https://example.com/');
    assert.strictEqual(r.mixedContent, 0,
      `mixedContent should be 0 for relative form action, got: ${r.mixedContent}`);
  });

  it('<form action="https://x/s"> on https page → mixedContent === 0', () => {
    const html = `<html><head></head><body><form action="https://x/s"><button>Go</button></form> words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'https://example.com/');
    assert.strictEqual(r.mixedContent, 0,
      `mixedContent should be 0 for https form action, got: ${r.mixedContent}`);
  });
});

// ── U4.6: aggRatingValue / aggRatingCount extraction ─────────────────────────

describe('parsePage — U4.6: aggRatingValue / aggRatingCount extraction', () => {

  it('Product with aggregateRating {ratingValue:4.5, reviewCount:100} → "4.5"/"100"', () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "Test Product",
      "aggregateRating": { "@type": "AggregateRating", "ratingValue": 4.5, "reviewCount": 100 }
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.aggRatingValue, '4.5', `aggRatingValue should be '4.5', got: ${r.aggRatingValue}`);
    assert.strictEqual(r.aggRatingCount, '100', `aggRatingCount should be '100', got: ${r.aggRatingCount}`);
  });

  it('standalone AggregateRating with ratingValue but no count → value set, count ""', () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "AggregateRating",
      "ratingValue": 3.8
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.aggRatingValue, '3.8', `aggRatingValue should be '3.8', got: ${r.aggRatingValue}`);
    assert.strictEqual(r.aggRatingCount, '', `aggRatingCount should be '' when no count, got: ${r.aggRatingCount}`);
  });

  it('AggregateRating with ratingCount (not reviewCount) → count set', () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "AggregateRating",
      "ratingValue": 4.0,
      "ratingCount": 55
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.aggRatingCount, '55', `aggRatingCount should be '55' via ratingCount, got: ${r.aggRatingCount}`);
  });

  it('no AggregateRating → both ""', () => {
    const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "Article", "headline": "Test" });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.aggRatingValue, '', `aggRatingValue should be '' when absent, got: ${r.aggRatingValue}`);
    assert.strictEqual(r.aggRatingCount, '', `aggRatingCount should be '' when absent, got: ${r.aggRatingCount}`);
  });

  it('emptyResult → aggRatingValue:"", aggRatingCount:""', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.aggRatingValue, '', `emptyResult aggRatingValue should be '', got: ${r.aggRatingValue}`);
    assert.strictEqual(r.aggRatingCount, '', `emptyResult aggRatingCount should be '', got: ${r.aggRatingCount}`);
  });
});

// ── U4.6: hasShippingDetails / hasReturnPolicy extraction ────────────────────

describe('parsePage — U4.6: hasShippingDetails / hasReturnPolicy extraction', () => {

  it('Offer with shippingDetails + hasMerchantReturnPolicy → 1/1', () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "Test",
      "offers": {
        "@type": "Offer",
        "price": "9.99",
        "shippingDetails": { "@type": "OfferShippingDetails" },
        "hasMerchantReturnPolicy": { "@type": "MerchantReturnPolicy" }
      }
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasShippingDetails, 1, `hasShippingDetails should be 1, got: ${r.hasShippingDetails}`);
    assert.strictEqual(r.hasReturnPolicy, 1, `hasReturnPolicy should be 1, got: ${r.hasReturnPolicy}`);
  });

  it('Offer with neither → 0/0', () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "Test",
      "offers": { "@type": "Offer", "price": "9.99" }
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasShippingDetails, 0, `hasShippingDetails should be 0, got: ${r.hasShippingDetails}`);
    assert.strictEqual(r.hasReturnPolicy, 0, `hasReturnPolicy should be 0, got: ${r.hasReturnPolicy}`);
  });

  it('Offer with only shippingDetails → 1/0', () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "Test",
      "offers": {
        "@type": "Offer",
        "price": "9.99",
        "shippingDetails": { "@type": "OfferShippingDetails" }
      }
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasShippingDetails, 1, `hasShippingDetails should be 1, got: ${r.hasShippingDetails}`);
    assert.strictEqual(r.hasReturnPolicy, 0, `hasReturnPolicy should be 0, got: ${r.hasReturnPolicy}`);
  });

  it('emptyResult → hasShippingDetails:0, hasReturnPolicy:0', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.hasShippingDetails, 0, `emptyResult hasShippingDetails should be 0, got: ${r.hasShippingDetails}`);
    assert.strictEqual(r.hasReturnPolicy, 0, `emptyResult hasReturnPolicy should be 0, got: ${r.hasReturnPolicy}`);
  });
});

// ── U4.6: hasOrgLogo / hasOrgContactPoint extraction ─────────────────────────

describe('parsePage — U4.6: hasOrgLogo / hasOrgContactPoint extraction', () => {

  it('Organization with logo + contactPoint → 1/1', () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": "Test Org",
      "logo": { "@type": "ImageObject", "url": "http://example.com/logo.png" },
      "contactPoint": { "@type": "ContactPoint", "telephone": "+1-800-000-0000" }
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasOrgLogo, 1, `hasOrgLogo should be 1, got: ${r.hasOrgLogo}`);
    assert.strictEqual(r.hasOrgContactPoint, 1, `hasOrgContactPoint should be 1, got: ${r.hasOrgContactPoint}`);
  });

  it('Organization with neither logo nor contactPoint → 0/0', () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": "Test Org"
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasOrgLogo, 0, `hasOrgLogo should be 0, got: ${r.hasOrgLogo}`);
    assert.strictEqual(r.hasOrgContactPoint, 0, `hasOrgContactPoint should be 0, got: ${r.hasOrgContactPoint}`);
  });

  it('Organization with only logo → 1/0', () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": "Test Org",
      "logo": { "@type": "ImageObject", "url": "http://example.com/logo.png" }
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasOrgLogo, 1, `hasOrgLogo should be 1, got: ${r.hasOrgLogo}`);
    assert.strictEqual(r.hasOrgContactPoint, 0, `hasOrgContactPoint should be 0, got: ${r.hasOrgContactPoint}`);
  });

  it('Organization nested in @graph with logo → hasOrgLogo 1 (traversal)', () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", "name": "Test Org", "logo": { "@type": "ImageObject", "url": "http://example.com/logo.png" } }
      ]
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body>words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasOrgLogo, 1, `hasOrgLogo should be 1 for org in @graph, got: ${r.hasOrgLogo}`);
  });

  it('emptyResult → hasOrgLogo:0, hasOrgContactPoint:0', () => {
    const r = parsePage(null, 'http://example.com/');
    assert.strictEqual(r.hasOrgLogo, 0, `emptyResult hasOrgLogo should be 0, got: ${r.hasOrgLogo}`);
    assert.strictEqual(r.hasOrgContactPoint, 0, `emptyResult hasOrgContactPoint should be 0, got: ${r.hasOrgContactPoint}`);
  });
});

// ── U4.4-M1: head script/style body literals must NOT be counted ──────────────
// RED tests: inline script/style body containing tag-like literals must not
// inflate headBlockingScripts / headBlockingStyles.

describe('parsePage — U4.4-M1: head script/style body tag-literals do not inflate counts', () => {

  it('RED (U4.4-M1-a): inline head <script> with literal src tag → headBlockingScripts === 0', () => {
    // The ONLY script in <head> is an inline script whose body contains a
    // tag-literal string — there is no real external script.
    const html = [
      '<html><head>',
      `<script>var x = '<script src="evil.js"><\\/script>'</script>`,
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingScripts, 0,
      `headBlockingScripts must be 0 — inline script body with literal tag should not be counted, got: ${r.headBlockingScripts}`);
  });

  it('RED (U4.4-M1-b): inline head <script> with literal <link rel=stylesheet> → headBlockingStyles === 0', () => {
    // The ONLY script in <head> is an inline script whose body contains a
    // stylesheet link-literal string — there is no real stylesheet.
    const html = [
      '<html><head>',
      `<script>var s = '<link rel="stylesheet" href="x.css">'</script>`,
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingStyles, 0,
      `headBlockingStyles must be 0 — inline script body with literal link tag should not be counted, got: ${r.headBlockingStyles}`);
  });

  it('REGRESSION (U4.4-M1-c): real blocking <script src> in head still counted as 1', () => {
    const html = [
      '<html><head>',
      '<script src="a.js"></script>',
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingScripts, 1,
      `headBlockingScripts must be 1 for real blocking script src, got: ${r.headBlockingScripts}`);
  });

  it('REGRESSION (U4.4-M1-d): real blocking <link rel=stylesheet> in head still counted as 1', () => {
    const html = [
      '<html><head>',
      '<link rel="stylesheet" href="a.css">',
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.headBlockingStyles, 1,
      `headBlockingStyles must be 1 for real blocking stylesheet, got: ${r.headBlockingStyles}`);
  });
});

// ── U4.6-M1: standalone AggregateRating with array @type ─────────────────────
// RED test: a top-level AggregateRating with "@type":["AggregateRating"] sets
// hasAgg=1 (via extractLdTypes) but the old standalone branch used strict
// string equality → findAggregateRating returned null → false positive.

describe('parsePage — U4.6-M1: standalone AggregateRating with array @type is extracted', () => {

  it('RED (U4.6-M1): standalone {"@type":["AggregateRating"],...} → aggRatingValue "4.5", aggRatingCount "10"', () => {
    const ld = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': ['AggregateRating'],
      'ratingValue': 4.5,
      'ratingCount': 10,
    });
    const html = [
      '<html><head>',
      `<script type="application/ld+json">${ld}</script>`,
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.aggRatingValue, '4.5',
      `aggRatingValue must be "4.5" for standalone array-@type AggregateRating, got: "${r.aggRatingValue}"`);
    assert.strictEqual(r.aggRatingCount, '10',
      `aggRatingCount must be "10" for standalone array-@type AggregateRating, got: "${r.aggRatingCount}"`);
  });
});

// ── U4.5-M2: button with &nbsp; inner text counts as unlabeled ────────────────

describe('parsePage — U4.5-M2: button &nbsp; inner text counts as unlabeled after decodeEntities', () => {

  it('RED (U4.5-M2): <button>&nbsp;</button> → unlabeledControlCount === 1', () => {
    // &nbsp; is normalised to U+0020 (regular space) by decodeEntities; after trim()
    // it becomes empty-equivalent → the button has no accessible name.
    const html = [
      '<html><head></head><body>',
      '<button>&nbsp;</button>',
      'words words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.unlabeledControlCount, 1,
      `unlabeledControlCount must be 1 for <button>&nbsp;</button>, got: ${r.unlabeledControlCount}`);
  });
});

// ── U6.1: parsePage — hreflangLinks extraction ────────────────────────────────

describe('parsePage — U6.1: hreflangLinks extraction (lang=href pairs)', () => {

  it('extracts hreflangLinks as pipe-joined lang=href pairs from two alternate links', () => {
    const html = [
      '<html><head>',
      '<link rel="alternate" hreflang="de" href="https://ex.com/de">',
      '<link rel="alternate" hreflang="en" href="https://ex.com/en">',
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'https://ex.com/de');
    assert.strictEqual(r.hreflangLinks, 'de=https://ex.com/de|en=https://ex.com/en',
      `hreflangLinks should be 'de=https://ex.com/de|en=https://ex.com/en', got: "${r.hreflangLinks}"`);
  });

  it('returns empty string for hreflangLinks when no alternate links present', () => {
    const html = [
      '<html><head>',
      '<link rel="stylesheet" href="style.css">',
      '</head><body>words words words words words words words words words words</body></html>',
    ].join('');
    const r = parsePage(html, 'https://ex.com/');
    assert.strictEqual(r.hreflangLinks, '',
      `hreflangLinks should be '' when no hreflang links, got: "${r.hreflangLinks}"`);
  });

  it('emptyResult returns hreflangLinks: empty string', () => {
    // parsePage returns emptyResult when html is absent/empty — verify hreflangLinks is ''
    const r = parsePage('', 'https://ex.com/');
    assert.strictEqual(r.hreflangLinks, '',
      `hreflangLinks in emptyResult should be '', got: "${r.hreflangLinks}"`);
  });
});

// ── Batch 4c: Microdata / RDFa detection + same-origin resource paths ────────────

describe('parsePage — Microdata / RDFa structured-data detection', () => {
  it('hasMicrodata === 1 when itemscope + schema.org itemtype present (no JSON-LD)', () => {
    const html = [
      '<html><head><title>Org</title></head><body>',
      '<div itemscope itemtype="https://schema.org/Organization">',
      '<span itemprop="name">Demo GmbH</span></div>',
      'words words words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasMicrodata, 1, 'hasMicrodata should be 1');
    assert.strictEqual(r.hasRdfa, 0, 'hasRdfa should be 0');
    assert.strictEqual(r.ldTypes, '', 'ldTypes should be empty (Microdata only)');
  });

  it('hasMicrodata === 0 when itemscope present but itemtype is non-schema.org', () => {
    const html = [
      '<html><head></head><body>',
      '<div itemscope itemtype="https://data-vocabulary.org/Breadcrumb">x</div>',
      'words words words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasMicrodata, 0, 'non-schema.org itemtype must not set hasMicrodata');
  });

  it('hasRdfa === 1 when typeof= attribute present', () => {
    const html = [
      '<html><head></head><body>',
      '<div vocab="https://schema.org/" typeof="Organization"><span property="name">X</span></div>',
      'words words words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasRdfa, 1, 'hasRdfa should be 1 when typeof/vocab present');
  });

  it('hasMicrodata === 0 and hasRdfa === 0 for a JSON-LD-only page', () => {
    const html = [
      '<html><head>',
      '<script type="application/ld+json">',
      JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'X' }),
      '</script></head><body>',
      'words words words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.hasMicrodata, 0, 'JSON-LD-only page must not set hasMicrodata');
    assert.strictEqual(r.hasRdfa, 0, 'JSON-LD-only page must not set hasRdfa');
    assert.strictEqual(r.hasOrg, 1, 'JSON-LD Organization still detected via hasOrg');
  });

  it('emptyResult returns hasMicrodata 0, hasRdfa 0, resourcePaths ""', () => {
    const r = parsePage('', 'http://example.com/');
    assert.strictEqual(r.hasMicrodata, 0);
    assert.strictEqual(r.hasRdfa, 0);
    assert.strictEqual(r.resourcePaths, '');
  });
});

describe('parsePage — same-origin render resource paths', () => {
  it('collects same-origin <script src> and stylesheet href paths in document order', () => {
    const html = [
      '<html><head>',
      '<link rel="stylesheet" href="/assets/app.css">',
      '<script src="/assets/app.js"></script>',
      '<link rel="stylesheet" href="https://cdn.other.com/ext.css">', // cross-origin → excluded
      '<script src="https://cdn.other.com/ext.js"></script>',          // cross-origin → excluded
      '</head><body>',
      'words words words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/page');
    assert.strictEqual(r.resourcePaths, '/assets/app.css|/assets/app.js',
      `resourcePaths should be same-origin css then js in document order, got: "${r.resourcePaths}"`);
  });

  it('ignores non-stylesheet <link> and inline scripts; dedups repeated paths', () => {
    const html = [
      '<html><head>',
      '<link rel="preload" href="/assets/font.woff2">',  // not stylesheet → excluded
      '<script>console.log("inline")</script>',          // inline (no src) → excluded
      '<script src="/assets/app.js"></script>',
      '<script src="/assets/app.js"></script>',           // duplicate → deduped
      '</head><body>',
      'words words words words words words words words words words words',
      '</body></html>',
    ].join('');
    const r = parsePage(html, 'http://example.com/page');
    assert.strictEqual(r.resourcePaths, '/assets/app.js',
      `resourcePaths should dedup and exclude non-stylesheet/inline, got: "${r.resourcePaths}"`);
  });

  it('caps the collected list at 20 same-origin resources', () => {
    const links = Array.from({ length: 30 }, (_, i) => `<script src="/s${i}.js"></script>`).join('');
    const html  = `<html><head>${links}</head><body>words words words words words words words words words words words</body></html>`;
    const r = parsePage(html, 'http://example.com/');
    assert.strictEqual(r.resourcePaths.split('|').length, 20, 'resource list must be capped at 20');
    assert.strictEqual(r.resourcePaths.split('|')[0], '/s0.js', 'document order preserved (first kept)');
  });
});

// ── Round-2 D9: JSON-LD CDATA-strip must stay linear (ReDoS guard) ────────────

describe('parsePage — JSON-LD CDATA strip is not O(n²) on padded blocks', () => {
  it('does not stall on a large whitespace-padded ld+json block', () => {
    // A ld+json block that is mostly whitespace with no CDATA markers exercised the
    // catastrophic-backtracking path in the two CDATA-strip regexes (leading unanchored
    // \s* + a double-\s* around the optional comment). O(n²) → seconds on ~60k chars.
    const padding = ' '.repeat(60_000);
    const html = `<html><head><script type="application/ld+json">${padding}</script>` +
                 `</head><body>words words words words words words words words words words</body></html>`;
    const start = process.hrtime.bigint();
    const r = parsePage(html, 'http://example.com/');
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 2000, `parsePage must stay linear on padded JSON-LD (took ${ms.toFixed(0)}ms — O(n²) regression)`);
    assert.strictEqual(r.ldValid, 0, 'a whitespace-only ld+json block is not valid JSON → ldValid 0');
  });

  it('does not stall when the block ends with a real //]]> after heavy whitespace padding', () => {
    const padding = ' '.repeat(60_000);
    const html = `<html><head><script type="application/ld+json">//<![CDATA[${padding}{"@type":"Thing"}${padding}//]]></script>` +
                 `</head><body>words words words words words words words words words words</body></html>`;
    const start = process.hrtime.bigint();
    const r = parsePage(html, 'http://example.com/');
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 2000, `parsePage must stay linear on padded CDATA-wrapped JSON-LD (took ${ms.toFixed(0)}ms)`);
    assert.strictEqual(r.ldValid, 1, 'the padded-but-valid CDATA-wrapped block must still parse');
    assert.ok(r.ldTypes.includes('Thing'), `@type Thing must be detected, got "${r.ldTypes}"`);
  });
});
