/**
 * test/run.test.mjs — Unit C2 TDD tests for runCrawl (red → green).
 *
 * Tests run against the in-process fixture server. runCrawl orchestrates
 * the full pipeline and writes crawl.csv + signals.json to data/<host>/.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from './fixture-server.mjs';
import { runCrawl } from '../crawl/run.mjs';
import { COLS, parseCsv } from '../crawl/schema.mjs';

describe('runCrawl', () => {
  let base, close, dataDir;

  before(async () => {
    const srv = await startFixtureServer();
    base = srv.baseUrl;
    close = srv.close;
    // Unique output dir per suite — fixture binds 127.0.0.1, so the hostname-derived
    // default (data/127.0.0.1/) would collide with other parallel test files.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
  });

  after(() => {
    close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes crawl.csv with exact COLS header and valid parseable rows', async () => {
    const result = await runCrawl(base, { rps: 50, maxUrls: 30, dataDir });

    assert.ok(result.csvPath, 'csvPath should be set');
    assert.ok(result.signalsPath, 'signalsPath should be set');
    assert.ok(typeof result.siteType === 'string', 'siteType should be a string');

    assert.ok(fs.existsSync(result.csvPath), `crawl.csv should exist at ${result.csvPath}`);
    assert.ok(fs.existsSync(result.signalsPath), `signals.json should exist at ${result.signalsPath}`);

    const csv = fs.readFileSync(result.csvPath, 'utf8');
    const lines = csv.split('\n').filter(l => l.trim() !== '');
    assert.ok(lines.length >= 2, 'CSV should have header + at least one data row');

    // Header must match COLS exactly
    assert.strictEqual(
      lines[0],
      COLS.join(','),
      `CSV header should be COLS.join(',').\nExpected: ${COLS.join(',')}\nGot:      ${lines[0]}`,
    );

    // parseCsv round-trip
    const rows = parseCsv(csv);
    assert.ok(rows.length > 0, 'parseCsv should return at least one row');

    for (const row of rows) {
      assert.ok(row.url, `each row should have a non-empty url, got: ${JSON.stringify(row)}`);
    }
  });

  it('siteType is "server-rendered" for the fixture site (only one JS-shell page)', async () => {
    const result = await runCrawl(base, { rps: 50, maxUrls: 30, dataDir });
    assert.ok(
      ['server-rendered', 'client-rendered'].includes(result.siteType),
      `siteType should be server-rendered or client-rendered, got: ${result.siteType}`,
    );
    // The fixture site has only 1 JS-shell page (client-rendered.html) out of ~20 pages
    assert.strictEqual(result.siteType, 'server-rendered');
  });

  it('signals.json is valid JSON containing linkGraph summary', async () => {
    const result = await runCrawl(base, { rps: 50, maxUrls: 30, dataDir });
    const raw = fs.readFileSync(result.signalsPath, 'utf8');
    let signals;
    assert.doesNotThrow(() => { signals = JSON.parse(raw); }, 'signals.json should be valid JSON');
    assert.ok(signals.linkGraph, 'signals.json should have a linkGraph property');
    assert.ok(typeof signals.linkGraph.orphanCount === 'number', 'linkGraph.orphanCount should be a number');
  });

  // ── Important-2: depthByUrl must be persisted in signals.json ────────────────
  it('signals.json linkGraph includes depthByUrl (required for links:deep detector)', async () => {
    const result = await runCrawl(base, { rps: 50, maxUrls: 30, dataDir });
    const raw    = fs.readFileSync(result.signalsPath, 'utf8');
    const signals = JSON.parse(raw);
    assert.ok(
      signals.linkGraph,
      'signals.json should have a linkGraph property',
    );
    assert.ok(
      typeof signals.linkGraph.depthByUrl === 'object' && signals.linkGraph.depthByUrl !== null,
      `signals.json linkGraph.depthByUrl should be an object (was: ${typeof signals.linkGraph.depthByUrl})`,
    );
    // Root page should be at depth 0
    const entries = Object.entries(signals.linkGraph.depthByUrl);
    assert.ok(entries.length > 0, 'depthByUrl should have at least one entry');
    const rootEntry = entries.find(([, d]) => d === 0);
    assert.ok(rootEntry, 'depthByUrl should include the root URL at depth 0');
  });

  // ── Batch 4d: per-page internal-link adjacency persisted in signals.json ─────
  it('signals.json linkGraph.edges is a stable [{url, internalLinks[]}] array (link-integrity rules)', async () => {
    const result  = await runCrawl(base, { rps: 50, maxUrls: 30, dataDir });
    const signals = JSON.parse(fs.readFileSync(result.signalsPath, 'utf8'));
    assert.ok(Array.isArray(signals.linkGraph.edges), 'linkGraph.edges should be an array');
    assert.ok(signals.linkGraph.edges.length > 0, 'edges should have at least one entry');
    for (const e of signals.linkGraph.edges) {
      assert.ok(typeof e.url === 'string' && e.url.length > 0, `edge.url should be a non-empty string: ${JSON.stringify(e)}`);
      assert.ok(Array.isArray(e.internalLinks), `edge.internalLinks should be an array: ${JSON.stringify(e)}`);
    }
    // index.html links to several internal pages → its edge must carry internalLinks.
    const idxEdge = signals.linkGraph.edges.find(e => e.url.endsWith('/index.html'));
    assert.ok(idxEdge && idxEdge.internalLinks.length > 0, 'index.html edge should list internal links');
    // edges order tracks the (deterministic) crawl/CSV row order → stable across runs.
    const result2  = await runCrawl(base, { rps: 50, maxUrls: 30, dataDir });
    const signals2 = JSON.parse(fs.readFileSync(result2.signalsPath, 'utf8'));
    assert.deepStrictEqual(signals.linkGraph.edges, signals2.linkGraph.edges,
      'linkGraph.edges must be byte-stable (identical order + content) across two runs');
  });

  it('stats returned and has fetched count', async () => {
    const result = await runCrawl(base, { rps: 50, maxUrls: 10, dataDir });
    assert.ok(result.stats, 'stats should be returned');
    assert.ok(typeof result.stats.fetched === 'number', 'stats.fetched should be a number');
    assert.ok(result.stats.fetched > 0, 'should have fetched at least one page');
  });

  it('crawl.csv rows include C2 fields (title present for HTML pages)', async () => {
    const result = await runCrawl(base, { rps: 50, maxUrls: 30, dataDir });
    const csv = fs.readFileSync(result.csvPath, 'utf8');
    const rows = parseCsv(csv);

    // Find the index.html row
    const indexRow = rows.find(r => r.url.endsWith('/') || r.url.endsWith('/index.html'));
    assert.ok(indexRow, 'should have a row for the root/index page');
    assert.ok(indexRow.title, `index page should have a title, got: ${indexRow.title}`);
    assert.ok(indexRow.h1Count, `index page should have h1Count, got: ${indexRow.h1Count}`);
  });

  // Critical fix: js_guard signal must appear in CSV error column
  it('client-rendered.html row has error="js-guard:empty-body" in CSV', async () => {
    const result = await runCrawl(base, { rps: 50, maxUrls: 30, dataDir });
    const csv = fs.readFileSync(result.csvPath, 'utf8');
    const rows = parseCsv(csv);

    const crRow = rows.find(r => r.url.includes('client-rendered.html'));
    assert.ok(crRow, 'should have a row for client-rendered.html');
    assert.strictEqual(
      crRow.error,
      'js-guard:empty-body',
      `client-rendered.html row must have error=js-guard:empty-body, got: ${crRow.error}`,
    );
  });

  // U0.1: signals.json soll crawlMeta mit ISO-crawledAt enthalten
  it('U0.1: signals.json enthält crawlMeta mit ISO-crawledAt, fetched und capped', async () => {
    const result = await runCrawl(base, { rps: 50, maxUrls: 30, dataDir });
    const raw     = fs.readFileSync(result.signalsPath, 'utf8');
    const signals = JSON.parse(raw);

    assert.ok(signals.crawlMeta, 'signals.json soll crawlMeta enthalten');
    assert.ok(
      typeof signals.crawlMeta.crawledAt === 'string',
      `crawlMeta.crawledAt soll ein String sein, bekam: ${typeof signals.crawlMeta.crawledAt}`,
    );
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(signals.crawlMeta.crawledAt),
      `crawlMeta.crawledAt soll ein ISO-8601-String sein, bekam: ${signals.crawlMeta.crawledAt}`,
    );
    assert.ok(
      typeof signals.crawlMeta.fetched === 'number' && signals.crawlMeta.fetched > 0,
      `crawlMeta.fetched soll eine positive Zahl sein, bekam: ${signals.crawlMeta.fetched}`,
    );
    assert.ok(
      typeof signals.crawlMeta.capped === 'boolean',
      `crawlMeta.capped soll ein Boolean sein, bekam: ${typeof signals.crawlMeta.capped}`,
    );
  });
});

// ── U5.2: Determinism golden — two runs produce byte-identical crawl.csv ──────

describe('runCrawl — determinism: two sequential runs produce byte-identical crawl.csv (U5.2)', () => {
  it('crawl.csv is byte-identical across two consecutive runs', async () => {
    let srv, dataDir;
    try {
      srv = await startFixtureServer();
      // Both runs deliberately share one dataDir — that is the property under test
      // (a second run overwrites the first with byte-identical content).
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
      const result1 = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir });
      const csv1 = fs.readFileSync(result1.csvPath, 'utf8');

      const result2 = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir });
      const csv2 = fs.readFileSync(result2.csvPath, 'utf8');

      assert.strictEqual(csv1, csv2,
        'crawl.csv must be byte-identical across two consecutive runs (no timestamp in CSV)');
    } finally {
      if (srv) await srv.close();
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
