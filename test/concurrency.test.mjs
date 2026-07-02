/**
 * test/concurrency.test.mjs — U5.5 TDD tests for bounded fetch concurrency (RED first).
 *
 * Core invariant: crawl.csv and the link-graph produced by concurrency:4 must
 * be BYTE-IDENTICAL to the same crawl with concurrency:1 (queue-order processing
 * of batch results guarantees determinism).
 *
 * All tests run against the in-process fixture server (no real network).
 * { rps:50 } keeps the suite fast.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from './fixture-server.mjs';
import { crawl } from '../crawl/crawl.mjs';
import { runCrawl } from '../crawl/run.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Normalise 127.0.0.1:<port> → HOST for deterministic comparison across runs. */
function normalize(s) {
  return s.replace(/127\.0\.0\.1:\d+/g, 'HOST');
}

// ── U5.5: bounded concurrency ─────────────────────────────────────────────────

describe('bounded concurrency (U5.5)', () => {
  let srv, base, dataDir;

  before(async () => {
    srv  = await startFixtureServer();
    base = srv.baseUrl;
    // Unique output dir per suite — avoids the data/127.0.0.1/ collision across
    // parallel test files. The byte-identity assertions still compare two runs
    // that share this one dir (run B overwrites run A).
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
  });

  after(async () => {
    if (srv) await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ── U5.5-1: byte-identical crawl.csv ─────────────────────────────────────

  it('U5.5-1: crawl.csv is byte-identical between concurrency:1 and concurrency:4 (sitemap mode)', async () => {
    // Run A: concurrency:1 — sequential baseline
    const rA = await runCrawl(base, { rps: 50, maxUrls: 40, concurrency: 1, dataDir });
    const csvA = fs.readFileSync(rA.csvPath, 'utf8');

    // Run B: concurrency:4 — batch path (overwrites same data dir)
    const rB = await runCrawl(base, { rps: 50, maxUrls: 40, concurrency: 4, dataDir });
    const csvB = fs.readFileSync(rB.csvPath, 'utf8');

    assert.strictEqual(
      csvA,
      csvB,
      `crawl.csv must be byte-identical between concurrency:1 and concurrency:4.\nFirst diff at:\n${findFirstDiff(csvA, csvB)}`,
    );
  });

  // ── U5.5-2: link-graph identical ─────────────────────────────────────────

  it('U5.5-2: link-graph (orphans + depthByUrl) identical between concurrency:1 and concurrency:4', async () => {
    const rA = await runCrawl(base, { rps: 50, maxUrls: 40, concurrency: 1, dataDir });
    const sigA = JSON.parse(fs.readFileSync(rA.signalsPath, 'utf8'));

    const rB = await runCrawl(base, { rps: 50, maxUrls: 40, concurrency: 4, dataDir });
    const sigB = JSON.parse(fs.readFileSync(rB.signalsPath, 'utf8'));

    assert.deepStrictEqual(
      [...sigA.linkGraph.orphans].sort(),
      [...sigB.linkGraph.orphans].sort(),
      'linkGraph.orphans must be identical between concurrency:1 and concurrency:4',
    );
    assert.deepStrictEqual(
      sigA.linkGraph.depthByUrl,
      sigB.linkGraph.depthByUrl,
      'linkGraph.depthByUrl must be identical between concurrency:1 and concurrency:4',
    );
  });

  // ── U5.5-3: URL sequence identical (crawl() level) ───────────────────────

  it('U5.5-3: URL sequence is identical between concurrency:1 and concurrency:4 at crawl() level', async () => {
    const r1 = await crawl(base, { rps: 50, maxUrls: 40, concurrency: 1 });
    const r4 = await crawl(base, { rps: 50, maxUrls: 40, concurrency: 4 });

    const urls1 = r1.pages.map(p => normalize(p.url));
    const urls4 = r4.pages.map(p => normalize(p.url));

    assert.deepStrictEqual(
      urls1,
      urls4,
      `URL sequence must be identical (queue order preserved).\nconcurrency:1: ${urls1.join(', ')}\nconcurrency:4: ${urls4.join(', ')}`,
    );
  });

  // ── U5.5-4: page count parity under maxUrls cap ──────────────────────────

  it('U5.5-4: page count (stats.fetched) is identical between concurrency:1 and concurrency:4', async () => {
    const r1 = await crawl(base, { rps: 50, maxUrls: 20, concurrency: 1 });
    const r4 = await crawl(base, { rps: 50, maxUrls: 20, concurrency: 4 });

    assert.strictEqual(
      r1.stats.fetched,
      r4.stats.fetched,
      `stats.fetched must match: concurrency:1=${r1.stats.fetched}, concurrency:4=${r4.stats.fetched}`,
    );
  });

  // ── U5.5-5: BFS mode — byte-identical ────────────────────────────────────

  it('U5.5-5: BFS mode crawl.csv is byte-identical between concurrency:1 and concurrency:4', async () => {
    const rA = await runCrawl(base, { rps: 50, maxUrls: 40, concurrency: 1, useSitemap: false, dataDir });
    const csvA = fs.readFileSync(rA.csvPath, 'utf8');

    const rB = await runCrawl(base, { rps: 50, maxUrls: 40, concurrency: 4, useSitemap: false, dataDir });
    const csvB = fs.readFileSync(rB.csvPath, 'utf8');

    assert.strictEqual(
      csvA,
      csvB,
      `crawl.csv (BFS mode) must be byte-identical between concurrency:1 and concurrency:4.\nFirst diff at:\n${findFirstDiff(csvA, csvB)}`,
    );
  });

  // ── U5.5-6: concurrency:4 run completes and returns valid stats ───────────

  it('U5.5-6: concurrency:4 run completes successfully and returns valid stats', async () => {
    const r = await crawl(base, { rps: 50, maxUrls: 20, concurrency: 4 });

    assert.ok(r.stats.fetched > 0,
      `concurrency:4 should fetch pages, got stats.fetched=${r.stats.fetched}`);
    assert.ok(Array.isArray(r.pages),
      'pages should be an array in buffered mode');
    assert.ok(r.pages.length > 0,
      'pages should be non-empty in buffered mode');
    assert.strictEqual(r.stats.fetched, r.pages.length,
      'stats.fetched must equal pages.length in buffered mode');
  });

  // ── U5.5-7: concurrency:4 respects robots disallow ────────────────────────

  it('U5.5-7: concurrency:4 respects robots Disallow — /private/ not in pages', async () => {
    const r = await crawl(base, { rps: 50, maxUrls: 40, concurrency: 4 });
    const privatePages = r.pages.filter(p => p.url.includes('/private/'));
    assert.strictEqual(
      privatePages.length,
      0,
      `concurrency:4 must respect robots Disallow, but found: ${privatePages.map(p => p.url).join(', ')}`,
    );
  });
});

// ── U5.5: BFS concurrency with separate fixture server ───────────────────────

describe('bounded concurrency BFS — distinct fixture server (U5.5)', () => {
  it('U5.5-8: BFS URL sequence identical between concurrency:1 and concurrency:4 (crawl() level)', async () => {
    let srv;
    try {
      srv = await startFixtureServer();
      const r1 = await crawl(srv.baseUrl, { rps: 50, maxUrls: 30, concurrency: 1, useSitemap: false });
      const r4 = await crawl(srv.baseUrl, { rps: 50, maxUrls: 30, concurrency: 4, useSitemap: false });

      const urls1 = r1.pages.map(p => normalize(p.url));
      const urls4 = r4.pages.map(p => normalize(p.url));

      assert.deepStrictEqual(urls1, urls4,
        `BFS URL sequence must be identical (queue-order processing).\nconcurrency:1: ${urls1.join(', ')}\nconcurrency:4: ${urls4.join(', ')}`);
    } finally {
      if (srv) await srv.close();
    }
  });
});

// ── utility ───────────────────────────────────────────────────────────────────

/**
 * Return a short string highlighting the first difference between two strings.
 * Used in assertion messages.
 */
function findFirstDiff(a, b) {
  const linesA = a.split('\n');
  const linesB = b.split('\n');
  const maxLines = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < maxLines; i++) {
    if (linesA[i] !== linesB[i]) {
      return `line ${i + 1}:\n  A: ${linesA[i] ?? '(missing)'}\n  B: ${linesB[i] ?? '(missing)'}`;
    }
  }
  return '(no line-level diff found)';
}
