/**
 * test/crawl.test.mjs — Unit C1 TDD tests (red → green).
 *
 * All tests run against the in-process fixture server (no real network).
 * Use { rps: 50 } in crawl() calls to keep the suite fast.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './fixture-server.mjs';
import { politeFetch, USER_AGENT, parseRetryAfter } from '../crawl/fetch.mjs';
import { makeLimiter, effectiveIntervalMs } from '../crawl/throttle.mjs';
import { fetchSiteSignals, probeHttpScheme } from '../crawl/sitefetch.mjs';
import { crawl } from '../crawl/crawl.mjs';
import { isPathAllowed } from '../crawl/robots-match.mjs';
import { isPrivateAddress } from '../crawl/ssrf-guard.mjs';

// ── politeFetch ───────────────────────────────────────────────────────────────

describe('politeFetch', () => {
  let base;
  let closeServer;

  before(async () => {
    const srv = await startFixtureServer();
    base = srv.baseUrl;
    closeServer = srv.close;
  });

  after(() => closeServer());

  it('follows redirect chain: finalUrl ends with /redirect-final.html, redirectChain.length ≥ 2, status 200', async () => {
    const res = await politeFetch(base + '/redirect-1');
    assert.ok(
      res.finalUrl.endsWith('/redirect-final.html'),
      `finalUrl should end with /redirect-final.html, got: ${res.finalUrl}`,
    );
    assert.ok(
      res.redirectChain.length >= 2,
      `redirectChain.length should be ≥2, got: ${res.redirectChain.length}`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.redirected, true);
  });

  it('GET /gone-page.html → status 410, html null (error page)', async () => {
    const res = await politeFetch(base + '/gone-page.html');
    assert.equal(res.status, 410);
    assert.equal(res.html, null);
  });

  it('GET /notfound-xyz → status 404', async () => {
    const res = await politeFetch(base + '/notfound-xyz');
    assert.equal(res.status, 404);
  });

  it('GET /index.html → status 200 with html body', async () => {
    const res = await politeFetch(base + '/index.html');
    assert.equal(res.status, 200);
    assert.ok(res.html !== null, 'html should be populated for 200 HTML');
    assert.ok(res.html.includes('Demo'), 'html should contain page content');
  });

  it('httpsOk is false for http:// fixture server', async () => {
    const res = await politeFetch(base + '/index.html');
    assert.equal(res.httpsOk, false);
  });

  it('mixedContent is always null from C1', async () => {
    const res = await politeFetch(base + '/index.html');
    assert.equal(res.mixedContent, null);
  });

  it('returns url field equal to the requested URL', async () => {
    const url = base + '/index.html';
    const res = await politeFetch(url);
    assert.equal(res.url, url);
  });

  it('timeout → error is set, status is 0', async () => {
    // Port 1 is reserved and should refuse connections immediately,
    // giving a network error (or timeout if we set a very short timeoutMs).
    const res = await politeFetch('http://127.0.0.1:1', { timeoutMs: 200 });
    assert.equal(res.status, 0);
    assert.ok(res.error !== null, 'error should be set on network failure');
  });

  it('>5 redirects → error===\'too-many-redirects\', status is 3xx', async () => {
    // /redirect-deep-1 chains through 6 hops, exceeding MAX_REDIRECTS (5).
    const res = await politeFetch(base + '/redirect-deep-1');
    assert.equal(
      res.error,
      'too-many-redirects',
      `expected error='too-many-redirects', got: ${res.error}`,
    );
    assert.ok(
      res.status >= 300 && res.status < 400,
      `expected 3xx status, got: ${res.status}`,
    );
  });

  it('non-HTML content type (robots.txt text/plain): body populated, html null', async () => {
    const res = await politeFetch(base + '/robots.txt');
    assert.equal(res.status, 200);
    assert.equal(res.html, null, 'html must be null for text/plain (not text/html)');
    assert.ok(res.body !== null, 'body should be populated for text/plain 2xx');
    assert.ok(res.body.includes('Disallow'), 'robots.txt body should be readable via body field');
  });

  it('application/xml (sitemap.xml): body populated, html null', async () => {
    const res = await politeFetch(base + '/sitemap.xml');
    assert.equal(res.status, 200);
    assert.equal(res.html, null, 'html must be null for application/xml');
    assert.ok(res.body !== null, 'body should be populated for xml 2xx');
    assert.ok(res.body.includes('<urlset'), 'sitemap body should contain <urlset');
  });

  it('text/html (index.html): both html and body are populated', async () => {
    const res = await politeFetch(base + '/index.html');
    assert.equal(res.status, 200);
    assert.ok(res.html !== null, 'html must be populated for text/html');
    assert.ok(res.body !== null, 'body must also be populated for text/html');
    assert.equal(res.html, res.body, 'html and body should be the same string for text/html');
  });
});

// ── makeLimiter ───────────────────────────────────────────────────────────────

describe('makeLimiter', () => {
  it('executes the function and returns its result', async () => {
    const limit = makeLimiter({ rps: 100 });
    const result = await limit(() => 42);
    assert.equal(result, 42);
  });

  it('works with async functions', async () => {
    const limit = makeLimiter({ rps: 100 });
    const result = await limit(async () => 'hello');
    assert.equal(result, 'hello');
  });

  it('spreads calls over time at ~2 rps (≈1 s for 3 calls)', async () => {
    const limit = makeLimiter({ rps: 2 });
    const times = [];
    const start = Date.now();
    for (let i = 0; i < 3; i++) {
      await limit(() => times.push(Date.now() - start));
    }
    // Two 500 ms intervals → total ≈ 1000 ms; allow 10 % slack
    assert.ok(times[2] >= 900, `Expected ≥900 ms, got ${times[2]} ms`);
  });
});

// ── fetchSiteSignals ──────────────────────────────────────────────────────────

describe('fetchSiteSignals', () => {
  let base;
  let closeServer;

  before(async () => {
    const srv = await startFixtureServer();
    base = srv.baseUrl;
    closeServer = srv.close;
  });

  after(() => closeServer());

  it('robots.disallow contains /private/', async () => {
    const signals = await fetchSiteSignals(base);
    assert.ok(
      signals.robots.disallow.includes('/private/'),
      `disallow should contain /private/, got: ${JSON.stringify(signals.robots.disallow)}`,
    );
  });

  it('robots.exists is true and raw is non-empty', async () => {
    const signals = await fetchSiteSignals(base);
    assert.equal(signals.robots.exists, true);
    assert.ok(signals.robots.raw.length > 0);
  });

  it('aiBots contains OAI-SearchBot with kategorie ai-search and disallowAll:true', async () => {
    const signals = await fetchSiteSignals(base);
    const oai = signals.robots.aiBots.find(b => b.agent === 'OAI-SearchBot');
    assert.ok(oai, `OAI-SearchBot not found in aiBots: ${JSON.stringify(signals.robots.aiBots)}`);
    assert.equal(oai.kategorie, 'ai-search');
    assert.equal(oai.disallowAll, true);
  });

  it('llms.valid is false with non-empty problems array', async () => {
    const signals = await fetchSiteSignals(base);
    assert.equal(signals.llms.valid, false);
    assert.ok(
      signals.llms.problems.length > 0,
      'problems should be non-empty for malformed llms.txt',
    );
  });

  it('llms.exists is true', async () => {
    const signals = await fetchSiteSignals(base);
    assert.equal(signals.llms.exists, true);
  });

  it('sitemapUrls has entries (sitemap.xml is present)', async () => {
    const signals = await fetchSiteSignals(base);
    assert.ok(
      signals.sitemapUrls.length > 0,
      'sitemapUrls should be populated from sitemap.xml',
    );
  });
});

// ── fetchSiteSignals — sitemapindex expansion (U3.1) ─────────────────────────

describe('fetchSiteSignals — sitemapindex expansion (U3.1)', () => {
  it('expands sitemapindex: 4 content URLs across 2 child sitemaps, sitemapFiles with locCount per file', async () => {
    let srv;
    try {
      srv = await startFixtureServer({ sitemapMode: 'index' });
      const signals = await fetchSiteSignals(srv.baseUrl);
      assert.strictEqual(
        signals.sitemapUrls.length,
        4,
        `expected 4 sitemapUrls (2 from each child sitemap), got ${signals.sitemapUrls.length}: ${JSON.stringify(signals.sitemapUrls)}`,
      );
      assert.ok(
        signals.sitemapUrls.some(u => u.includes('a-')),
        'sitemapUrls should contain a-* URLs from sitemap-a.xml',
      );
      assert.ok(
        signals.sitemapUrls.some(u => u.includes('b-')),
        'sitemapUrls should contain b-* URLs from sitemap-b.xml',
      );
      assert.strictEqual(
        signals.sitemapFiles.length,
        2,
        `expected 2 sitemapFiles (one per child urlset), got ${signals.sitemapFiles?.length}`,
      );
      assert.ok(
        signals.sitemapFiles.every(f => f.locCount === 2),
        `each sitemapFile should have locCount 2, got: ${JSON.stringify(signals.sitemapFiles)}`,
      );
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── crawl ─────────────────────────────────────────────────────────────────────

describe('crawl', () => {
  let base;
  let closeServer;

  before(async () => {
    const srv = await startFixtureServer();
    base = srv.baseUrl;
    closeServer = srv.close;
  });

  after(() => closeServer());

  it('private/secret.html is NOT in pages (robots /private/ disallow respected)', async () => {
    const result = await crawl(base, { rps: 50 });
    const found = result.pages.find(p => p.url.includes('/private/'));
    assert.ok(
      !found,
      `private/secret.html must not be crawled, but found: ${found?.url}`,
    );
  });

  it('index.html, noindex.html, and orphan.html ARE in pages (sitemap mode)', async () => {
    const result = await crawl(base, { rps: 50 });
    const urls = result.pages.map(p => p.url);

    assert.ok(
      urls.some(u => u.endsWith('/index.html') || u.endsWith('/')),
      'index.html (or /) should be in pages',
    );
    assert.ok(
      urls.some(u => u.includes('noindex.html')),
      'noindex.html should be in pages',
    );
    assert.ok(
      urls.some(u => u.includes('orphan.html')),
      'orphan.html should be in pages (it is in sitemap)',
    );
  });

  it('gone-page.html is in pages with status 410', async () => {
    const result = await crawl(base, { rps: 50 });
    const gone = result.pages.find(p => p.url.includes('gone-page.html'));
    assert.ok(gone, 'gone-page.html should be in pages');
    assert.equal(gone.status, 410);
  });

  it('every 200-status page has a non-null html field', async () => {
    const result = await crawl(base, { rps: 50 });
    for (const page of result.pages) {
      if (page.status === 200) {
        assert.ok(
          page.html !== null,
          `${page.url} (status 200) should have html populated`,
        );
      }
    }
  });

  it('each page has the required C1 fields', async () => {
    const result = await crawl(base, { maxUrls: 3, rps: 50 });
    for (const page of result.pages) {
      assert.ok('url' in page, 'missing url');
      assert.ok('type' in page, 'missing type');
      assert.ok('status' in page, 'missing status');
      assert.ok('finalUrl' in page, 'missing finalUrl');
      assert.ok('redirected' in page, 'missing redirected');
      assert.ok('redirectChain' in page, 'missing redirectChain');
      assert.ok('httpsOk' in page, 'missing httpsOk');
      assert.ok('mixedContent' in page, 'missing mixedContent');
      assert.ok('error' in page, 'missing error');
      assert.ok('html' in page, 'missing html');
    }
  });

  it('BFS (useSitemap:false) finds index.html and internally linked pages', async () => {
    const result = await crawl(base, { useSitemap: false, rps: 50 });
    const urls = result.pages.map(p => p.url);

    assert.ok(
      urls.some(u => u.endsWith('/') || u.includes('index')),
      'root / should be in BFS pages',
    );
    assert.ok(
      urls.some(u => u.includes('perfect.html')),
      'perfect.html (linked from index) should be found via BFS',
    );
  });

  it('BFS (useSitemap:false) does NOT find orphan.html (not linked)', async () => {
    const result = await crawl(base, { useSitemap: false, rps: 50 });
    const urls = result.pages.map(p => p.url);
    assert.ok(
      !urls.some(u => u.includes('orphan.html')),
      'orphan.html must not be found in BFS (it is not internally linked)',
    );
  });

  it('maxUrls cap: pages.length ≤ 3 and stats.capped === true', async () => {
    const result = await crawl(base, { maxUrls: 3, rps: 50 });
    assert.ok(
      result.pages.length <= 3,
      `Expected ≤3 pages, got ${result.pages.length}`,
    );
    assert.equal(result.stats.capped, true);
  });

  it('stats.fetched equals pages.length', async () => {
    const result = await crawl(base, { maxUrls: 5, rps: 50 });
    assert.equal(result.stats.fetched, result.pages.length);
  });

  it('result includes signals from fetchSiteSignals', async () => {
    const result = await crawl(base, { maxUrls: 1, rps: 50 });
    assert.ok(result.signals, 'signals should be present');
    assert.ok(result.signals.robots, 'signals.robots should be present');
    assert.ok(result.signals.llms, 'signals.llms should be present');
  });

  it('result.origin is the normalised origin', async () => {
    const result = await crawl(base, { maxUrls: 1, rps: 50 });
    assert.equal(result.origin, new URL(base).origin);
  });
});

// ── isPathAllowed — pure RFC-9309 matcher (U3.2a) ─────────────────────────────

describe('isPathAllowed — RFC-9309 matcher (U3.2a)', () => {

  it('empty rules → allowed', () => {
    assert.equal(isPathAllowed('/any/path', {}), true);
  });

  it('Disallow:/products/ (no Allow): /products/x is disallowed', () => {
    const robots = { disallow: ['/products/'] };
    assert.equal(isPathAllowed('/products/x', robots), false);
  });

  it('Disallow:/products/ (no Allow): /about is allowed', () => {
    const robots = { disallow: ['/products/'] };
    assert.equal(isPathAllowed('/about', robots), true);
  });

  it('longest-match: Disallow:/products/ + Allow:/products/featured/ → /products/featured/x is allowed', () => {
    const robots = { disallow: ['/products/'], allow: ['/products/featured/'] };
    assert.equal(isPathAllowed('/products/featured/x', robots), true);
  });

  it('longest-match: Disallow:/products/ + Allow:/products/featured/ → /products/other is disallowed', () => {
    const robots = { disallow: ['/products/'], allow: ['/products/featured/'] };
    assert.equal(isPathAllowed('/products/other', robots), false);
  });

  it('$-end-anchor: Disallow:/*.pdf$ → /file.pdf is disallowed', () => {
    const robots = { disallow: ['/*.pdf$'] };
    assert.equal(isPathAllowed('/file.pdf', robots), false);
  });

  it('$-end-anchor: Disallow:/*.pdf$ → /file.pdfx is allowed (not end of path)', () => {
    const robots = { disallow: ['/*.pdf$'] };
    assert.equal(isPathAllowed('/file.pdfx', robots), true);
  });

  it('$-end-anchor: Disallow:/*.pdf$ → /a/b.pdf is disallowed', () => {
    const robots = { disallow: ['/*.pdf$'] };
    assert.equal(isPathAllowed('/a/b.pdf', robots), false);
  });

  it('query-wildcard: Disallow:/*? → /page?x=1 is disallowed', () => {
    const robots = { disallow: ['/*?'] };
    assert.equal(isPathAllowed('/page?x=1', robots), false);
  });

  it('query-wildcard: Disallow:/*? → /page (no query) is allowed', () => {
    const robots = { disallow: ['/*?'] };
    assert.equal(isPathAllowed('/page', robots), true);
  });

  it('tie→Allow: Disallow:/a + Allow:/a → /a is allowed', () => {
    const robots = { disallow: ['/a'], allow: ['/a'] };
    assert.equal(isPathAllowed('/a', robots), true);
  });

  it('missing allow field treated as [] → Disallow:/x blocks /x/y', () => {
    const robots = { disallow: ['/x'] };
    assert.equal(isPathAllowed('/x/y', robots), false);
  });
});

// ── parseRobots allow field via fetchSiteSignals (U3.2a) ─────────────────────

describe('fetchSiteSignals — robots.allow collected (U3.2a)', () => {
  it('robots.allow contains /foo when robotsBody has Allow:/foo', async () => {
    let srv;
    try {
      srv = await startFixtureServer({
        robotsBody: 'User-agent: *\nDisallow: /private/\nAllow: /foo\n',
      });
      const signals = await fetchSiteSignals(srv.baseUrl);
      assert.ok(
        Array.isArray(signals.robots.allow),
        `signals.robots.allow should be an array, got: ${typeof signals.robots.allow}`,
      );
      assert.ok(
        signals.robots.allow.includes('/foo'),
        `robots.allow should contain /foo, got: ${JSON.stringify(signals.robots.allow)}`,
      );
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── crawl E2E Allow-Override (U3.2a) ─────────────────────────────────────────

describe('crawl — E2E Allow-Override via robotsBody (U3.2a)', () => {
  it('/private/secret.html IS in pages when Allow:/private/secret.html overrides Disallow:/private/', async () => {
    let srv;
    try {
      srv = await startFixtureServer({
        robotsBody: 'User-agent: *\nDisallow: /private/\nAllow: /private/secret.html\n',
      });
      const result = await crawl(srv.baseUrl, { rps: 50 });
      const found = result.pages.find(p => p.url.includes('/private/secret.html'));
      assert.ok(
        found,
        `/private/secret.html should be crawled when Allow override is present, pages: ${result.pages.map(p => p.url).join(', ')}`,
      );
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── fetchSiteSignals — fail-closed on 5xx / network error (U3.3) ──────────────

describe('fetchSiteSignals — fail-closed on 5xx / network failure (U3.3)', () => {
  it('503 robots.txt ⇒ disallow deep-equals [\'/\'] (sitefetch level)', async () => {
    let srv;
    try {
      srv = await startFixtureServer({ robotsStatus: 503 });
      // backoffBaseMs:10 — behavior-under-test is 5xx status-handling, not backoff duration
      const signals = await fetchSiteSignals(srv.baseUrl, (u) => politeFetch(u, { backoffBaseMs: 10 }));
      assert.deepStrictEqual(
        signals.robots.disallow,
        ['/'],
        `RFC 9309 §2.3.1.4: 5xx robots should assume complete disallow, got: ${JSON.stringify(signals.robots.disallow)}`,
      );
    } finally {
      if (srv) await srv.close();
    }
  });

  it('4xx robots.txt ⇒ disallow deep-equals [] (allow-all, regression guard)', async () => {
    let srv;
    try {
      srv = await startFixtureServer({ robotsStatus: 404 });
      const signals = await fetchSiteSignals(srv.baseUrl);
      assert.deepStrictEqual(
        signals.robots.disallow,
        [],
        `RFC 9309 §2.3.1.3: 4xx robots should allow-all, got: ${JSON.stringify(signals.robots.disallow)}`,
      );
    } finally {
      if (srv) await srv.close();
    }
  });

  it('network error (status===0) ⇒ disallow deep-equals [\'/\'] (sitefetch level)', async () => {
    // Port 1 is reserved — connection refused fires immediately (no wait).
    const signals = await fetchSiteSignals('http://127.0.0.1:1');
    assert.deepStrictEqual(
      signals.robots.disallow,
      ['/'],
      `RFC 9309 §2.3.1.4: network failure (status 0) should assume complete disallow, got: ${JSON.stringify(signals.robots.disallow)}`,
    );
  });
});

// ── politeFetch — broken redirect Location (U3.4) ────────────────────────────

describe('politeFetch — broken redirect Location (U3.4)', () => {
  it('/redirect-broken → does NOT throw; error===\'invalid-redirect\', status 3xx, html null', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const res = await politeFetch(srv.baseUrl + '/redirect-broken');
      assert.equal(res.error, 'invalid-redirect',
        `expected error='invalid-redirect', got: ${res.error}`);
      assert.ok(res.status >= 300 && res.status < 400,
        `expected 3xx status, got: ${res.status}`);
      assert.equal(res.html, null, 'html must be null for broken redirect');
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── crawl — resilience on broken redirect in frontier (U3.4) ─────────────────

describe('crawl — resilience on broken redirect in frontier (U3.4)', () => {
  it('crawl resolves (not rejects); perfect.html survives; redirect-broken has error===\'invalid-redirect\'', async () => {
    let srv;
    try {
      srv = await startFixtureServer({ sitemapUrls: ['/redirect-broken', '/perfect.html'] });
      const result = await crawl(srv.baseUrl, { rps: 50 });

      const perfectPage = result.pages.find(p => p.url.includes('/perfect.html'));
      assert.ok(perfectPage, `perfect.html should be in pages, got: ${result.pages.map(p => p.url).join(', ')}`);
      assert.notEqual(perfectPage.html, null, 'perfect.html should have non-null html (good page survived)');

      const brokenPage = result.pages.find(p => p.url.includes('/redirect-broken'));
      assert.ok(brokenPage, '/redirect-broken should be in pages as a page-level error');
      assert.equal(brokenPage.error, 'invalid-redirect',
        `expected error='invalid-redirect' on broken page, got: ${brokenPage.error}`);
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── politeFetch — body-size cap + body-read under timeout (U3.5) ─────────────

describe('politeFetch — body-size cap (U3.5)', () => {
  it('maxBodyBytes:100 on /index.html (2106 B) → error=body-too-large, html/body null, status 200', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const res = await politeFetch(srv.baseUrl + '/index.html', { maxBodyBytes: 100 });
      assert.equal(res.status, 200, `expected status 200, got ${res.status}`);
      assert.equal(res.error, 'body-too-large',
        `expected error='body-too-large', got: ${res.error}`);
      assert.equal(res.html, null, 'html must be null when body capped');
      assert.equal(res.body, null, 'body must be null when body capped');
    } finally {
      if (srv) await srv.close();
    }
  });

  it('default cap: /index.html → status 200, html populated, html===body (stream-decode == old)', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const res = await politeFetch(srv.baseUrl + '/index.html');
      assert.equal(res.status, 200);
      assert.ok(res.html !== null, 'html should be populated');
      assert.ok(res.html.includes('Demo'), 'html should contain page content');
      assert.equal(res.html, res.body, 'html and body must be equal (stream decode == res.text())');
    } finally {
      if (srv) await srv.close();
    }
  });
});

describe('politeFetch — body-read under timeout (U3.5)', () => {
  it('/slow-body with timeoutMs:200 → error=timeout, html null', { timeout: 3000 }, async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const res = await politeFetch(srv.baseUrl + '/slow-body', { timeoutMs: 200 });
      assert.equal(res.error, 'timeout',
        `expected error='timeout', got: ${res.error}`);
      assert.equal(res.html, null, 'html must be null on timeout');
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── politeFetch — gzip sitemap decompression (U3.6) ──────────────────────────

describe('politeFetch — gzip sitemap decompression (U3.6)', () => {
  it('application/gzip sitemap.xml: body contains decompressed <urlset, html is null', async () => {
    let srv;
    try {
      srv = await startFixtureServer({ sitemapMode: 'gzip' });
      const res = await politeFetch(srv.baseUrl + '/sitemap.xml');
      assert.equal(res.status, 200, `expected status 200, got ${res.status}`);
      assert.equal(res.html, null, 'html must be null for application/gzip (not text/html)');
      assert.ok(res.body !== null, 'body must be populated for gzip sitemap (decompressed XML)');
      assert.ok(res.body.includes('<urlset'), `decompressed body should contain <urlset, got: ${res.body?.slice(0, 200)}`);
    } finally {
      if (srv) await srv.close();
    }
  });

  it('corrupt gzip: does NOT throw; error===\'gzip-error\', body===null', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const res = await politeFetch(srv.baseUrl + '/sitemap-corrupt.gz');
      assert.equal(res.error, 'gzip-error',
        `expected error='gzip-error', got: ${res.error}`);
      assert.equal(res.body, null, 'body must be null on gzip error');
      assert.equal(res.html, null, 'html must be null on gzip error');
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── politeFetch — gzip decompression output bound (U3.6 fix) ─────────────────

describe('politeFetch — gzip decompression output bound (U3.6 fix)', () => {
  it('gzip payload expanding beyond maxBodyBytes → error=body-too-large, body/html null', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      // /gzip-big decompresses to ~2048 B; cap at 100 B → gunzipSync must be bounded
      const res = await politeFetch(srv.baseUrl + '/gzip-big', { maxBodyBytes: 100 });
      assert.equal(res.status, 200, `expected status 200, got ${res.status}`);
      assert.equal(res.error, 'body-too-large',
        `expected error='body-too-large', got: ${res.error}`);
      assert.equal(res.body, null, 'body must be null when gzip output exceeds cap');
      assert.equal(res.html, null, 'html must be null when gzip output exceeds cap');
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── fetchSiteSignals — gzip sitemap end-to-end (U3.6) ────────────────────────

describe('fetchSiteSignals — gzip sitemap end-to-end (U3.6)', () => {
  it('gzip sitemap: sitemapUrls.length >= 2 and contains g-1 marker', async () => {
    let srv;
    try {
      srv = await startFixtureServer({ sitemapMode: 'gzip' });
      const signals = await fetchSiteSignals(srv.baseUrl);
      assert.ok(
        signals.sitemapUrls.length >= 2,
        `expected >= 2 sitemapUrls from gzip sitemap, got ${signals.sitemapUrls.length}: ${JSON.stringify(signals.sitemapUrls)}`,
      );
      assert.ok(
        signals.sitemapUrls.some(u => u.includes('g-1')),
        `sitemapUrls should contain g-1 marker, got: ${JSON.stringify(signals.sitemapUrls)}`,
      );
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── crawl — fail-closed E2E (U3.3) ───────────────────────────────────────────

describe('crawl — fail-closed E2E on 5xx robots (U3.3)', () => {
  it('503 robots.txt ⇒ crawl returns 0 pages (all sitemap URLs disallowed)', async () => {
    let srv;
    try {
      srv = await startFixtureServer({ robotsStatus: 503 });
      // backoffBaseMs:10 — behavior-under-test is 5xx status-handling, not backoff duration
      const result = await crawl(srv.baseUrl, { rps: 50, backoffBaseMs: 10 });
      assert.strictEqual(
        result.pages.length,
        0,
        `All pages should be blocked when robots returns 503, got ${result.pages.length} pages: ${result.pages.map(p => p.url).join(', ')}`,
      );
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── isPrivateAddress — pure-helper unit tests (U3.7) ─────────────────────────

describe('isPrivateAddress — pure RFC-1918 / link-local / loopback guard (U3.7)', () => {
  // Private / reserved → true
  it('127.0.0.1 → true (IPv4 loopback)', () => assert.equal(isPrivateAddress('127.0.0.1'), true));
  it('169.254.169.254 → true (link-local / cloud metadata)', () => assert.equal(isPrivateAddress('169.254.169.254'), true));
  it('10.0.0.1 → true (RFC 1918 10/8)', () => assert.equal(isPrivateAddress('10.0.0.1'), true));
  it('172.16.0.1 → true (RFC 1918 172.16/12)', () => assert.equal(isPrivateAddress('172.16.0.1'), true));
  it('172.31.255.255 → true (RFC 1918 172.16/12 upper bound)', () => assert.equal(isPrivateAddress('172.31.255.255'), true));
  it('192.168.1.1 → true (RFC 1918 192.168/16)', () => assert.equal(isPrivateAddress('192.168.1.1'), true));
  it('::1 → true (IPv6 loopback)', () => assert.equal(isPrivateAddress('::1'), true));
  it('fe80::1 → true (IPv6 link-local)', () => assert.equal(isPrivateAddress('fe80::1'), true));
  it('fc00::1 → true (IPv6 ULA fc00::/7)', () => assert.equal(isPrivateAddress('fc00::1'), true));
  it('localhost → true (keyword)', () => assert.equal(isPrivateAddress('localhost'), true));

  // Public / external → false
  it('8.8.8.8 → false (Google DNS, public)', () => assert.equal(isPrivateAddress('8.8.8.8'), false));
  it('172.32.0.1 → false (172.32 is outside 172.16/12)', () => assert.equal(isPrivateAddress('172.32.0.1'), false));
  it('93.184.216.34 → false (example.com IP, public)', () => assert.equal(isPrivateAddress('93.184.216.34'), false));
  it('2001:4860:4860::8888 → false (Google DNS IPv6, public)', () => assert.equal(isPrivateAddress('2001:4860:4860::8888'), false));
  it('example.com → false (hostname, no DNS lookup)', () => assert.equal(isPrivateAddress('example.com'), false));

  // IPv6 bypass cases (U3.7 fix) — RED before fix, GREEN after
  it('::ffff:0a00:0001 → true (hex IPv4-mapped 10.0.0.1, bypass fix)', () => assert.equal(isPrivateAddress('::ffff:0a00:0001'), true));
  it('::ffff:169.254.169.254 → true (dotted IPv4-mapped metadata, regression guard)', () => assert.equal(isPrivateAddress('::ffff:169.254.169.254'), true));
  it('0000:0000:0000:0000:0000:0000:0000:0001 → true (zero-padded loopback, bypass fix)', () => assert.equal(isPrivateAddress('0000:0000:0000:0000:0000:0000:0000:0001'), true));
  it('fd00::1 → true (ULA fd prefix, regression guard)', () => assert.equal(isPrivateAddress('fd00::1'), true));

  // Regression: public IPv6 must stay false after fix
  it('::ffff:8.8.8.8 → false (IPv4-mapped public, regression guard)', () => assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false));

  // Bracketed-IPv6 literals (new URL().hostname yields these) — bracket-strip fix
  it('[::1] → true (bracketed loopback, isIP-bypass fix)', () => assert.equal(isPrivateAddress('[::1]'), true));
  it('[fe80::1] → true (bracketed link-local)', () => assert.equal(isPrivateAddress('[fe80::1]'), true));
  it('[fd00:ec2::254] → true (bracketed ULA, IMDSv2-style)', () => assert.equal(isPrivateAddress('[fd00:ec2::254]'), true));
  it('[2606:4700::1] → false (bracketed public IPv6 stays allowed)', () => assert.equal(isPrivateAddress('[2606:4700::1]'), false));

  // RFC 6598 CGNAT + IPv6 unspecified — range-completeness fix
  it('100.64.0.1 → true (CGNAT 100.64.0.0/10, RFC 6598)', () => assert.equal(isPrivateAddress('100.64.0.1'), true));
  it('100.127.255.255 → true (CGNAT upper bound)', () => assert.equal(isPrivateAddress('100.127.255.255'), true));
  it('100.128.0.1 → false (just outside CGNAT 100.64.0.0/10)', () => assert.equal(isPrivateAddress('100.128.0.1'), false));
  it(':: → true (IPv6 unspecified, mirrors IPv4 0.0.0.0)', () => assert.equal(isPrivateAddress('::'), true));
});

// ── politeFetch — SSRF guard blocks redirect to private host (U3.7) ──────────

describe('politeFetch — SSRF guard blocks redirect into private address (U3.7)', () => {
  it('/redirect-ssrf → does NOT throw; error===\'blocked-private-host\', html===null', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const res = await politeFetch(srv.baseUrl + '/redirect-ssrf', { timeoutMs: 2000 });
      assert.equal(res.error, 'blocked-private-host',
        `expected error='blocked-private-host', got: ${res.error}`);
      assert.equal(res.html, null, 'html must be null when blocked');
      assert.equal(res.body, null, 'body must be null when blocked');
    } finally {
      if (srv) await srv.close();
    }
  });

  it('/redirect-rfc1918 → error===\'blocked-private-host\'', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const res = await politeFetch(srv.baseUrl + '/redirect-rfc1918', { timeoutMs: 2000 });
      assert.equal(res.error, 'blocked-private-host',
        `expected error='blocked-private-host', got: ${res.error}`);
    } finally {
      if (srv) await srv.close();
    }
  });

  it('/redirect-ipv6-loopback → error===\'blocked-private-host\' (bracketed-IPv6 bypass fix)', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      // Location: http://[::1]/ — new URL().hostname is "[::1]" (bracketed).
      // Before the bracket-strip fix this slipped through the guard and the hop
      // would be followed; now it must be blocked, not followed.
      const res = await politeFetch(srv.baseUrl + '/redirect-ipv6-loopback', { timeoutMs: 2000 });
      assert.equal(res.error, 'blocked-private-host',
        `expected error='blocked-private-host', got: ${res.error}`);
      assert.equal(res.html, null, 'html must be null when blocked');
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── politeFetch — 127.0.0.1 seed host stays allowed (U3.7 trap avoidance) ────

describe('politeFetch — 127.0.0.1 allowedHost is always reachable (U3.7 trap avoidance)', () => {
  it('redirect-1 chain (all hops on 127.0.0.1) still resolves to 200 after SSRF guard', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const res = await politeFetch(srv.baseUrl + '/redirect-1');
      assert.equal(res.status, 200,
        `expected status 200 on 127.0.0.1 redirect chain, got: ${res.status}`);
      assert.ok(res.finalUrl.endsWith('/redirect-final.html'),
        `finalUrl should end with /redirect-final.html, got: ${res.finalUrl}`);
      assert.equal(res.error, null, `error should be null, got: ${res.error}`);
    } finally {
      if (srv) await srv.close();
    }
  });

  it('crawl on 127.0.0.1 fixture still returns normal pages after SSRF guard', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const result = await crawl(srv.baseUrl, { rps: 50, maxUrls: 5 });
      const perfect = result.pages.find(p => p.url.includes('perfect.html'));
      assert.ok(perfect, `perfect.html should be in pages, got: ${result.pages.map(p => p.url).join(', ')}`);
      assert.ok(perfect.html !== null, 'perfect.html must have non-null html (fixture server still reachable)');
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── crawl — resilience with SSRF redirect in sitemap (U3.7) ──────────────────

describe('crawl — SSRF redirect in sitemap: good pages survive, ssrf URL blocked (U3.7)', () => {
  it('crawl resolves; perfect.html survives; redirect-ssrf has error===\'blocked-private-host\'', async () => {
    let srv;
    try {
      srv = await startFixtureServer({ sitemapUrls: ['/redirect-ssrf', '/perfect.html'] });
      const result = await crawl(srv.baseUrl, { rps: 50 });

      const perfectPage = result.pages.find(p => p.url.includes('/perfect.html'));
      assert.ok(perfectPage, `perfect.html should be in pages, got: ${result.pages.map(p => p.url).join(', ')}`);
      assert.ok(perfectPage.html !== null, 'perfect.html should have non-null html (good page survived)');

      const ssrfPage = result.pages.find(p => p.url.includes('/redirect-ssrf'));
      assert.ok(ssrfPage, '/redirect-ssrf should be in pages as a page-level error');
      assert.equal(ssrfPage.error, 'blocked-private-host',
        `expected error='blocked-private-host' on ssrf page, got: ${ssrfPage.error}`);
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── U3.8 Part 1: User-Agent contact URL (.example TLD) ───────────────────────

describe('politeFetch — User-Agent uses RFC-6761 .example TLD (U3.8-1)', () => {
  it('USER_AGENT contains seo-audit-agent.example (not example.com)', () => {
    assert.ok(
      USER_AGENT.includes('seo-audit-agent.example'),
      `USER_AGENT should use seo-audit-agent.example, got: ${USER_AGENT}`,
    );
    assert.ok(
      !USER_AGENT.includes('//example.com'),
      `USER_AGENT must not still reference //example.com, got: ${USER_AGENT}`,
    );
  });

  it('userAgent opt overrides the default', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      // Should not throw — custom userAgent is accepted
      const res = await politeFetch(srv.baseUrl + '/index.html', {
        userAgent: 'custom-bot/1.0 (+https://example.org/bot)',
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── U3.8 Part 2: Crawl-delay parsing ─────────────────────────────────────────

describe('fetchSiteSignals — Crawl-delay parsed from robots.txt (U3.8-2)', () => {
  it('Crawl-delay: 7 → signals.robots.crawlDelay === 7', async () => {
    let srv;
    try {
      srv = await startFixtureServer({
        robotsBody: 'User-agent: *\nDisallow: /private/\nCrawl-delay: 7\n',
      });
      const signals = await fetchSiteSignals(srv.baseUrl);
      assert.strictEqual(signals.robots.crawlDelay, 7,
        `crawlDelay should be 7, got: ${signals.robots.crawlDelay}`);
    } finally {
      if (srv) await srv.close();
    }
  });

  it('no Crawl-delay directive → crawlDelay is undefined or 0', async () => {
    let srv;
    try {
      srv = await startFixtureServer({
        robotsBody: 'User-agent: *\nDisallow: /private/\n',
      });
      const signals = await fetchSiteSignals(srv.baseUrl);
      assert.ok(
        signals.robots.crawlDelay == null || signals.robots.crawlDelay === 0,
        `crawlDelay should be absent/0 when not set, got: ${signals.robots.crawlDelay}`,
      );
    } finally {
      if (srv) await srv.close();
    }
  });
});

describe('effectiveIntervalMs — crawl-delay floor with clamp (U3.8-2)', () => {
  it('rps:50, crawlDelaySec:0 → 20 ms (1000/50, no floor)', () => {
    assert.strictEqual(effectiveIntervalMs(50, 0), 20);
  });

  it('rps:2, crawlDelaySec:7 → 7000 ms (crawl-delay 7 s > rps-interval 500 ms)', () => {
    assert.strictEqual(effectiveIntervalMs(2, 7), 7000);
  });

  it('rps:2, crawlDelaySec:1000 → 10000 ms (clamped to MAX_CRAWL_DELAY_SEC=10)', () => {
    assert.strictEqual(effectiveIntervalMs(2, 1000), 10000);
  });

  it('rps:2, crawlDelaySec:0.3 → 500 ms (rps-interval 500 ms > crawl-delay 300 ms)', () => {
    assert.strictEqual(effectiveIntervalMs(2, 0.3), 500);
  });
});

// ── U3.8 Part 3: parseRetryAfter pure function ────────────────────────────────

describe('parseRetryAfter — pure function (U3.8-3)', () => {
  it('"1" → 1000 ms', () => {
    assert.strictEqual(parseRetryAfter('1'), 1000);
  });

  it('"0" → 0 ms', () => {
    assert.strictEqual(parseRetryAfter('0'), 0);
  });

  it('"30" → 30000 ms', () => {
    assert.strictEqual(parseRetryAfter('30'), 30000);
  });

  it('HTTP-Date in the future → positive ms (deterministic via nowMs)', () => {
    const nowMs = 1_000_000_000_000; // 2001-09-09T01:46:40Z
    const futureDate = new Date(nowMs + 5000).toUTCString();
    const result = parseRetryAfter(futureDate, nowMs);
    assert.ok(
      result > 0 && result <= 5500,
      `expected ~5000 ms, got: ${result}`,
    );
  });

  it('HTTP-Date in the past → 0 ms (clamped to zero)', () => {
    const nowMs = Date.now();
    const pastDate = new Date(nowMs - 5000).toUTCString();
    const result = parseRetryAfter(pastDate, nowMs);
    assert.strictEqual(result, 0);
  });

  it('garbage string → null', () => {
    assert.strictEqual(parseRetryAfter('not-a-valid-retry-after'), null);
  });

  it('null → null', () => {
    assert.strictEqual(parseRetryAfter(null), null);
  });

  it('undefined → null', () => {
    assert.strictEqual(parseRetryAfter(undefined), null);
  });

  it('"-5" (negative numeric) → null (not clamped to 0)', () => {
    assert.strictEqual(parseRetryAfter('-5', Date.now()), null);
  });
});

// ── U3.8 Part 4: backoffBaseMs option ────────────────────────────────────────

describe('politeFetch — backoffBaseMs option accepted (U3.8-4)', () => {
  it('backoffBaseMs:10 option is accepted; 200 response succeeds', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const res = await politeFetch(srv.baseUrl + '/index.html', { backoffBaseMs: 10 });
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── U3.8 Part 5: makeLimiter.slowDown ────────────────────────────────────────

describe('makeLimiter — slowDown method (U3.8-5)', () => {
  it('limit has a slowDown method', () => {
    const limit = makeLimiter({ rps: 100 });
    assert.equal(typeof limit.slowDown, 'function', 'limit.slowDown must be a function');
  });

  it('slowDown(2) doubles the effective interval (via getIntervalMs)', () => {
    const limit = makeLimiter({ rps: 100 }); // 10 ms interval
    assert.strictEqual(limit.getIntervalMs(), 10,
      `initial interval should be 10 ms (1000/100), got: ${limit.getIntervalMs()}`);
    limit.slowDown(2);
    assert.strictEqual(limit.getIntervalMs(), 20,
      `after slowDown(2), interval should be 20 ms, got: ${limit.getIntervalMs()}`);
  });

  it('slowDown(3) triples the interval', () => {
    const limit = makeLimiter({ rps: 200 }); // 5 ms interval
    limit.slowDown(3);
    assert.strictEqual(limit.getIntervalMs(), 15);
  });

  it('limit function still works correctly after slowDown', async () => {
    const limit = makeLimiter({ rps: 10000 }); // 0.1 ms interval
    limit.slowDown(2);
    const result = await limit(() => 42);
    assert.strictEqual(result, 42);
  });
});

// ── U3.8 Part 5: 429 → rps reduction integration ─────────────────────────────

describe('crawl — ≥2 page 429 responses trigger slowDown (U3.8-5)', () => {
  it('stats.slowDownTriggered === true after 2+ 429 responses', async () => {
    let srv;
    try {
      srv = await startFixtureServer({
        sitemapUrls: ['/p429-1.html', '/p429-2.html', '/p429-3.html'],
        always429Paths: ['/p429-1.html', '/p429-2.html'],
      });
      // rps:500 → 2 ms intervals, backoffBaseMs:1 → near-instant retries
      const result = await crawl(srv.baseUrl, { rps: 500, backoffBaseMs: 1, maxUrls: 10 });
      assert.strictEqual(result.stats.slowDownTriggered, true,
        'slowDownTriggered should be true after 2+ 429 responses');
    } finally {
      if (srv) await srv.close();
    }
  });

  it('stats.slowDownTriggered === false with no 429 responses', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const result = await crawl(srv.baseUrl, { rps: 50, maxUrls: 3 });
      assert.strictEqual(result.stats.slowDownTriggered, false,
        'slowDownTriggered should be false with no 429 responses');
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── U3.9: site-signal and child-sitemap fetches throttled via rate limiter ────

describe('crawl — site-signal fetches throttled via signalLimit (U3.9)', () => {
  it('sitemapMode:index + rps:20 → elapsed ≥ 300 ms (5 signal fetches + 4 page fetches all throttled)', { timeout: 5000 }, async () => {
    // rps:20 → 50 ms interval per slot.
    // sitemapMode:'index' causes fetchSiteSignals to fetch:
    //   robots.txt, llms.txt, sitemap.xml (index), sitemap-a.xml, sitemap-b.xml = 5 signal slots
    // The 4 union page-locs (a-1, a-2, b-1, b-2) are fetched by the crawl loop = 4 page slots.
    // Without the fix: 5 signal fetches are unthrottled → only ~3 page intervals ≈ 150 ms → RED.
    // With the fix: all ~9 slots go through a limiter → ~8 × 50 ms ≈ 400 ms → GREEN (≥ 300 ms).
    let srv;
    try {
      srv = await startFixtureServer({ sitemapMode: 'index' });
      const t0 = Date.now();
      const result = await crawl(srv.baseUrl, { rps: 20 });
      const elapsed = Date.now() - t0;
      assert.ok(
        elapsed >= 300,
        `Expected elapsed ≥ 300 ms (site-signal fetches throttled), got ${elapsed} ms`,
      );
      // Sanity: content is unaffected — 4 page URLs discovered from the two child sitemaps
      assert.strictEqual(result.pages.length, 4,
        `Expected 4 pages from sitemapindex expansion, got ${result.pages.length}`);
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── U6.3: parseRobots path-level disallow + operator ────────────────────────

describe('fetchSiteSignals — parseRobots path-level disallow + operator (U6.3)', () => {
  it('Claude-User Disallow:/blog/ → disallowPaths:["/blog/"], disallowAll:false, kategorie:on-demand-fetcher, operator:Anthropic', async () => {
    let srv;
    try {
      srv = await startFixtureServer({
        robotsBody: 'User-agent: *\nDisallow: /private/\n\nUser-agent: Claude-User\nDisallow: /blog/\n',
      });
      const signals = await fetchSiteSignals(srv.baseUrl);
      const entry = signals.robots.aiBots.find(b => b.agent === 'Claude-User');
      assert.ok(entry, `Claude-User not found in aiBots: ${JSON.stringify(signals.robots.aiBots)}`);
      assert.deepStrictEqual(entry.disallowPaths, ['/blog/'],
        `disallowPaths should be ["/blog/"], got: ${JSON.stringify(entry.disallowPaths)}`);
      assert.strictEqual(entry.disallowAll, false,
        `disallowAll should be false for path-level disallow, got: ${entry.disallowAll}`);
      assert.strictEqual(entry.kategorie, 'on-demand-fetcher',
        `kategorie should be on-demand-fetcher, got: ${entry.kategorie}`);
      assert.strictEqual(entry.operator, 'Anthropic',
        `operator should be Anthropic, got: ${entry.operator}`);
    } finally {
      if (srv) await srv.close();
    }
  });

  it('Claude-User Disallow:/ → disallowAll:true, disallowPaths:["/"]', async () => {
    let srv;
    try {
      srv = await startFixtureServer({
        robotsBody: 'User-agent: *\nDisallow: /private/\n\nUser-agent: Claude-User\nDisallow: /\n',
      });
      const signals = await fetchSiteSignals(srv.baseUrl);
      const entry = signals.robots.aiBots.find(b => b.agent === 'Claude-User');
      assert.ok(entry, `Claude-User not found in aiBots: ${JSON.stringify(signals.robots.aiBots)}`);
      assert.strictEqual(entry.disallowAll, true,
        `disallowAll should be true for Disallow:/, got: ${entry.disallowAll}`);
      assert.deepStrictEqual(entry.disallowPaths, ['/'],
        `disallowPaths should be ["/"], got: ${JSON.stringify(entry.disallowPaths)}`);
    } finally {
      if (srv) await srv.close();
    }
  });

  it('existing OAI-SearchBot (training-era bot) gets operator:OpenAI in aiBots entry', async () => {
    let srv;
    try {
      srv = await startFixtureServer({
        robotsBody: 'User-agent: OAI-SearchBot\nDisallow: /\n',
      });
      const signals = await fetchSiteSignals(srv.baseUrl);
      const entry = signals.robots.aiBots.find(b => b.agent === 'OAI-SearchBot');
      assert.ok(entry, `OAI-SearchBot not found in aiBots: ${JSON.stringify(signals.robots.aiBots)}`);
      assert.strictEqual(entry.operator, 'OpenAI',
        `operator should be OpenAI, got: ${entry.operator}`);
      assert.ok(Array.isArray(entry.disallowPaths),
        `disallowPaths should be an array, got: ${typeof entry.disallowPaths}`);
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── U5.2: Streaming onPage callback ──────────────────────────────────────────

describe('crawl — streaming onPage callback (U5.2)', () => {
  let base;
  let closeServer;

  before(async () => {
    const srv = await startFixtureServer();
    base = srv.baseUrl;
    closeServer = srv.close;
  });

  after(() => closeServer());

  it('onPage called once per fetched page; pages array not accumulated in streaming mode', async () => {
    const seen = [];
    const r = await crawl(base, { rps: 50, onPage: (p) => seen.push(p.url) });
    assert.strictEqual(seen.length, r.stats.fetched,
      `onPage should be called stats.fetched times; seen=${seen.length}, stats.fetched=${r.stats.fetched}`);
    assert.strictEqual(r.pages.length, 0,
      `pages should be empty in streaming mode, got ${r.pages.length}`);
    assert.ok(
      seen.some(u => u.includes('perfect.html')),
      `seen should contain perfect.html, got: ${seen.join(', ')}`,
    );
  });

  it('backward compat: no onPage still buffers pages array', async () => {
    const r = await crawl(base, { rps: 50, maxUrls: 5 });
    assert.ok(r.pages.length > 0,
      `pages should be non-empty in buffered mode, got ${r.pages.length}`);
    assert.strictEqual(r.pages.length, r.stats.fetched,
      `pages.length should equal stats.fetched in buffered mode`);
  });
});

// ── U6.5: probeHttpScheme unit tests (mock fetchImpl) ─────────────────────────

describe('U6.5 — probeHttpScheme (unit, mock fetchImpl)', () => {
  it('http→https redirect: redirectsToHttps:true, reachable:true', async () => {
    const mockFetch = async (_url) => ({ status: 200, finalUrl: 'https://example.com/' });
    const result = await probeHttpScheme('https://example.com', mockFetch);
    assert.strictEqual(result.reachable, true,
      'should be reachable when status 200');
    assert.strictEqual(result.redirectsToHttps, true,
      'should detect https redirect when finalUrl starts with https://');
    assert.strictEqual(result.status, 200, 'status should be 200');
  });

  it('http serves content (no redirect): redirectsToHttps:false, reachable:true', async () => {
    const mockFetch = async (_url) => ({ status: 200, finalUrl: 'http://example.com/' });
    const result = await probeHttpScheme('http://example.com', mockFetch);
    assert.strictEqual(result.reachable, true,
      'should be reachable when status 200');
    assert.strictEqual(result.redirectsToHttps, false,
      'should NOT detect https redirect when finalUrl stays http://');
    assert.strictEqual(result.status, 200, 'status should be 200');
  });

  it('network error (fetchImpl throws): reachable:false, redirectsToHttps:false, status:0', async () => {
    const mockFetch = async (_url) => { throw new Error('connection refused'); };
    const result = await probeHttpScheme('http://example.com', mockFetch);
    assert.strictEqual(result.reachable, false,
      'should be unreachable on network error');
    assert.strictEqual(result.redirectsToHttps, false,
      'redirectsToHttps must be false on error');
    assert.strictEqual(result.status, 0, 'status should be 0 on error');
  });

  it('status 0 response (unreachable): reachable:false', async () => {
    const mockFetch = async (_url) => ({ status: 0, finalUrl: '' });
    const result = await probeHttpScheme('http://example.com', mockFetch);
    assert.strictEqual(result.reachable, false,
      'should be unreachable when status is 0');
    assert.strictEqual(result.redirectsToHttps, false);
  });

  it('invalid origin: reachable:false, status:0', async () => {
    const mockFetch = async (_url) => ({ status: 200, finalUrl: 'https://example.com/' });
    const result = await probeHttpScheme('not-a-url', mockFetch);
    assert.strictEqual(result.reachable, false,
      'invalid origin should return reachable:false');
    assert.strictEqual(result.status, 0, 'status should be 0 for invalid origin');
  });

  it('probe URL uses http:// scheme regardless of origin scheme', async () => {
    let probedUrl;
    const mockFetch = async (url) => { probedUrl = url; return { status: 200, finalUrl: 'https://example.com/' }; };
    await probeHttpScheme('https://example.com', mockFetch);
    assert.ok(probedUrl.startsWith('http://'),
      `probe URL should use http:// scheme, got: ${probedUrl}`);
  });
});
