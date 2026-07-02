/**
 * test/linkgraph.test.mjs — Unit C2 TDD tests for buildLinkGraph (red → green).
 *
 * Tests run against the in-process fixture server. The link graph is built
 * from parsed page data to detect orphans, click-depth, and inlink counts.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFixtureServer } from './fixture-server.mjs';
import { parsePage } from '../crawl/parse.mjs';
import { buildLinkGraph } from '../crawl/linkgraph.mjs';

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

describe('buildLinkGraph', () => {
  let base, close;

  before(async () => {
    const srv = await startFixtureServer();
    base = srv.baseUrl;
    close = srv.close;
  });

  after(() => close());

  it('orphan.html appears in orphans (not linked from index, despite nav link to /)', async () => {
    const origin = base;
    const indexUrl = `${base}/`;
    const orphanUrl = `${base}/orphan.html`;

    const [indexHtml, orphanHtml] = await Promise.all([
      fetchHtml(indexUrl),
      fetchHtml(orphanUrl),
    ]);

    const pages = [{ url: indexUrl }, { url: orphanUrl }];
    const parsedByUrl = {
      [indexUrl]: parsePage(indexHtml, indexUrl),
      [orphanUrl]: parsePage(orphanHtml, orphanUrl),
    };

    const graph = buildLinkGraph(origin, pages, parsedByUrl);

    assert.ok(
      graph.orphans.includes(orphanUrl),
      `orphan.html should be in orphans. Got: ${JSON.stringify(graph.orphans)}`,
    );
  });

  it('index.html (origin root) is NOT in orphans', async () => {
    const origin = base;
    const indexUrl = `${base}/`;
    const orphanUrl = `${base}/orphan.html`;

    const [indexHtml, orphanHtml] = await Promise.all([
      fetchHtml(indexUrl),
      fetchHtml(orphanUrl),
    ]);

    const pages = [{ url: indexUrl }, { url: orphanUrl }];
    const parsedByUrl = {
      [indexUrl]: parsePage(indexHtml, indexUrl),
      [orphanUrl]: parsePage(orphanHtml, orphanUrl),
    };

    const graph = buildLinkGraph(origin, pages, parsedByUrl);

    assert.ok(
      !graph.orphans.includes(indexUrl),
      'index.html (origin root) should not be in orphans',
    );
  });

  it('depthByUrl[origin/] === 0 (root has depth 0)', async () => {
    const origin = base;
    const indexUrl = `${base}/`;
    const indexHtml = await fetchHtml(indexUrl);

    const pages = [{ url: indexUrl }];
    const parsedByUrl = { [indexUrl]: parsePage(indexHtml, indexUrl) };

    const graph = buildLinkGraph(origin, pages, parsedByUrl);

    assert.strictEqual(graph.depthByUrl[indexUrl], 0, 'origin root should have depth 0');
  });

  it('pages linked from index get depth 1; orphan has no depth (unreachable)', async () => {
    const origin = base;
    const indexUrl = `${base}/`;
    const perfectUrl = `${base}/perfect.html`;
    const orphanUrl = `${base}/orphan.html`;

    const [indexHtml, perfectHtml, orphanHtml] = await Promise.all([
      fetchHtml(indexUrl),
      fetchHtml(perfectUrl),
      fetchHtml(orphanUrl),
    ]);

    const pages = [
      { url: indexUrl },
      { url: perfectUrl },
      { url: orphanUrl },
    ];
    const parsedByUrl = {
      [indexUrl]: parsePage(indexHtml, indexUrl),
      [perfectUrl]: parsePage(perfectHtml, perfectUrl),
      [orphanUrl]: parsePage(orphanHtml, orphanUrl),
    };

    const graph = buildLinkGraph(origin, pages, parsedByUrl);

    // perfect.html is in index.html's nav list
    assert.ok(
      parsedByUrl[indexUrl].internalLinks.includes(perfectUrl),
      'index.html should have perfect.html in its internalLinks',
    );
    assert.strictEqual(
      graph.depthByUrl[perfectUrl],
      1,
      `perfect.html should have depth 1, got ${graph.depthByUrl[perfectUrl]}`,
    );

    // orphan.html is not reachable from root via internal links
    assert.ok(
      graph.depthByUrl[orphanUrl] === undefined,
      `orphan.html depth should be undefined (unreachable), got ${graph.depthByUrl[orphanUrl]}`,
    );
  });

  it('inlinkCounts: pages linked from index.html get inlinkCount >= 1', async () => {
    const origin = base;
    const indexUrl = `${base}/`;
    const perfectUrl = `${base}/perfect.html`;

    const [indexHtml, perfectHtml] = await Promise.all([
      fetchHtml(indexUrl),
      fetchHtml(perfectUrl),
    ]);

    const pages = [{ url: indexUrl }, { url: perfectUrl }];
    const parsedByUrl = {
      [indexUrl]: parsePage(indexHtml, indexUrl),
      [perfectUrl]: parsePage(perfectHtml, perfectUrl),
    };

    const graph = buildLinkGraph(origin, pages, parsedByUrl);

    // perfect.html is linked from index.html
    assert.ok(
      (graph.inlinkCounts[perfectUrl] ?? 0) >= 1,
      `perfect.html should have inlinkCounts >= 1, got ${graph.inlinkCounts[perfectUrl]}`,
    );
  });

  it('inlinkCounts for orphan.html === 0 (or absent)', async () => {
    const origin = base;
    const indexUrl = `${base}/`;
    const orphanUrl = `${base}/orphan.html`;

    const [indexHtml, orphanHtml] = await Promise.all([
      fetchHtml(indexUrl),
      fetchHtml(orphanUrl),
    ]);

    const pages = [{ url: indexUrl }, { url: orphanUrl }];
    const parsedByUrl = {
      [indexUrl]: parsePage(indexHtml, indexUrl),
      [orphanUrl]: parsePage(orphanHtml, orphanUrl),
    };

    const graph = buildLinkGraph(origin, pages, parsedByUrl);

    assert.ok(
      !graph.inlinkCounts[orphanUrl],
      `orphan.html inlinkCounts should be 0 or absent, got ${graph.inlinkCounts[orphanUrl]}`,
    );
  });
});

// ── U1-B Fix 1: normalizeUrl-Mismatch (Orphan/Depth) ─────────────────────────

describe('buildLinkGraph — U1-B Fix 1: normalizeUrl-Mismatch', () => {
  it('Seite mit trailing-slash wird NICHT als Orphan gezählt wenn ohne Slash verlinkt', () => {
    // RED: page.url '/about/' wird nicht normalisiert → inlinkCounts['/about'] matcht nicht → Fehlorphan
    const origin = 'http://example.com';
    const pages = [
      { url: 'http://example.com/' },
      { url: 'http://example.com/about/' }, // gecrawlte URL hat Trailing-Slash
    ];
    const parsedByUrl = {
      'http://example.com/': {
        // parse.mjs normalisiert: href="/about" → 'http://example.com/about' (kein Trailing-Slash)
        internalLinks: ['http://example.com/about'],
      },
      'http://example.com/about/': { internalLinks: [] },
    };
    const graph = buildLinkGraph(origin, pages, parsedByUrl);
    assert.ok(
      !graph.orphans.some(u => u.includes('about')),
      `about/ soll kein Orphan sein (verlinkt als /about), got orphans=${JSON.stringify(graph.orphans)}`,
    );
  });

  it('Seite mit trailing-slash bekommt korrekte Tiefe (depth=1) wenn ohne Slash verlinkt', () => {
    const origin = 'http://example.com';
    const pages = [
      { url: 'http://example.com/' },
      { url: 'http://example.com/about/' },
    ];
    const parsedByUrl = {
      'http://example.com/': { internalLinks: ['http://example.com/about'] },
      'http://example.com/about/': { internalLinks: [] },
    };
    const graph = buildLinkGraph(origin, pages, parsedByUrl);
    // Die normalisierte Form 'http://example.com/about' soll depth=1 haben
    const depth = graph.depthByUrl['http://example.com/about']
               ?? graph.depthByUrl['http://example.com/about/'];
    assert.strictEqual(depth, 1,
      `about-Seite soll depth=1 haben, got depthByUrl=${JSON.stringify(graph.depthByUrl)}`);
  });
});

// ── Inline / unit tests ────────────────────────────────────────────────────────

describe('buildLinkGraph — inline', () => {
  it('single page with no links: that page is its own orphan if not origin', () => {
    const origin = 'http://example.com';
    const pages = [
      { url: 'http://example.com/' },
      { url: 'http://example.com/lonely.html' },
    ];
    const parsedByUrl = {
      'http://example.com/': { internalLinks: [] },
      'http://example.com/lonely.html': { internalLinks: [] },
    };
    const graph = buildLinkGraph(origin, pages, parsedByUrl);
    assert.ok(
      graph.orphans.includes('http://example.com/lonely.html'),
      'lonely.html should be an orphan',
    );
    assert.ok(
      !graph.orphans.includes('http://example.com/'),
      'root should not be an orphan',
    );
  });

  it('linked pages have correct depths', () => {
    const origin = 'http://example.com';
    const pages = [
      { url: 'http://example.com/' },
      { url: 'http://example.com/a.html' },
      { url: 'http://example.com/b.html' },
    ];
    const parsedByUrl = {
      'http://example.com/': {
        internalLinks: ['http://example.com/a.html'],
      },
      'http://example.com/a.html': {
        internalLinks: ['http://example.com/b.html'],
      },
      'http://example.com/b.html': { internalLinks: [] },
    };
    const graph = buildLinkGraph(origin, pages, parsedByUrl);
    assert.strictEqual(graph.depthByUrl['http://example.com/'], 0);
    assert.strictEqual(graph.depthByUrl['http://example.com/a.html'], 1);
    assert.strictEqual(graph.depthByUrl['http://example.com/b.html'], 2);
  });
});
