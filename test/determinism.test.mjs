/**
 * test/determinism.test.mjs — whole-artifact determinism golden (D1/D7).
 *
 * Pins the FULL deterministic bookend, not just crawl.csv (run.test.mjs U5.2) plus
 * a couple of linkGraph subkeys. After many new columns/signals were added (security
 * headers, microdata/RDFa, resourcePaths, linkGraph.edges), this runs the bookend
 * (crawlAndAnalyze) TWICE against examples/fixture-site/ via two independent ephemeral
 * fixture servers (different ports), with crawledAt pinned identical on BOTH so the one
 * intentional wall-clock field is fixed — then asserts:
 *
 *   • signals.json A === signals.json B   (full deep equality)
 *   • analysis.json A === analysis.json B  (full deep equality)
 *   • crawl.csv     A === crawl.csv     B  (byte-identical regression guard)
 *
 * Because crawledAt is pinned, NO field needs deleting before comparison; full equality
 * pins per-finding counts/severities, float formatting, finding-array order, signal
 * ordering, linkGraph.edges order, and the new header/microdata/resource columns. The
 * two servers bind 127.0.0.1 on OS-assigned ports, so host:port is normalised on both
 * sides first (mirrors test/resume.test.mjs / test/run.test.mjs).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from './fixture-server.mjs';
import { crawlAndAnalyze } from '../bin/crawl-and-analyze.mjs';

/** Single pinned wall-clock value for both runs → crawledAt drops out of the diff. */
const PINNED_CRAWLED_AT = '2026-01-01T00:00:00.000Z';

/** Normalise 127.0.0.1:<port> → HOST so two ephemeral server starts (different ports) compare equal. */
function normalize(s) {
  return s.replace(/127\.0\.0\.1:\d+/g, 'HOST');
}

/** Read a JSON artifact, normalise host:port in the raw text, then parse (numbers stay numbers). */
function readNormalizedJson(p) {
  return JSON.parse(normalize(fs.readFileSync(p, 'utf8')));
}

describe('whole-artifact determinism golden (D1/D7)', () => {
  it('two pinned-crawledAt runs → deep-equal signals.json + analysis.json and byte-identical crawl.csv', async () => {
    const baseOpts = { rps: 50, maxUrls: 40, crawledAt: PINNED_CRAWLED_AT };
    const temps = [];
    let srvA, srvB;
    try {
      // ── Run A (own ephemeral server + own data dir) ──
      srvA = await startFixtureServer();
      const dataDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-detA-'));
      temps.push(dataDirA);
      const a = await crawlAndAnalyze(srvA.baseUrl, { ...baseOpts, dataDir: dataDirA });

      // ── Run B (independent ephemeral server → different port + own data dir) ──
      srvB = await startFixtureServer();
      const dataDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-detB-'));
      temps.push(dataDirB);
      const b = await crawlAndAnalyze(srvB.baseUrl, { ...baseOpts, dataDir: dataDirB });

      // ── crawl.csv: byte-identical after host:port normalisation (CSV regression guard) ──
      const csvA = normalize(fs.readFileSync(a.csvPath, 'utf8'));
      const csvB = normalize(fs.readFileSync(b.csvPath, 'utf8'));
      assert.strictEqual(csvA, csvB,
        'crawl.csv must be byte-identical across two pinned-crawledAt runs (host:port-normalised)');

      // ── signals.json: FULL deep equality (crawledAt pinned → nothing deleted) ──
      const sigA = readNormalizedJson(a.signalsPath);
      const sigB = readNormalizedJson(b.signalsPath);
      assert.strictEqual(sigA.crawlMeta.crawledAt, PINNED_CRAWLED_AT,
        'sanity: pinned crawledAt must reach signals.crawlMeta.crawledAt');
      assert.deepStrictEqual(sigA, sigB,
        'signals.json must be fully deep-equal across two pinned-crawledAt runs ' +
        '(header/microdata/resource columns, linkGraph.edges order, every signal field)');

      // ── analysis.json: FULL deep equality ──
      const anA = readNormalizedJson(a.analysisPath);
      const anB = readNormalizedJson(b.analysisPath);
      assert.strictEqual(anA.meta.crawledAt, PINNED_CRAWLED_AT,
        'sanity: pinned crawledAt must reach analysis.meta.crawledAt');
      assert.deepStrictEqual(anA, anB,
        'analysis.json must be fully deep-equal across two pinned-crawledAt runs ' +
        '(per-finding counts/severities, float formatting, finding-array order)');
    } finally {
      if (srvA) await srvA.close();
      if (srvB) await srvB.close();
      for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('default path (no opts.crawledAt) still produces a real ISO-8601 timestamp', async () => {
    let srv, dataDir;
    try {
      srv = await startFixtureServer();
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-detDefault-'));
      const { signalsPath } = await crawlAndAnalyze(srv.baseUrl, { rps: 50, maxUrls: 10, dataDir });
      const sig = JSON.parse(fs.readFileSync(signalsPath, 'utf8'));
      assert.match(
        sig.crawlMeta.crawledAt,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        `default crawledAt must be a real ISO-8601 timestamp, got: ${sig.crawlMeta.crawledAt}`,
      );
    } finally {
      if (srv) await srv.close();
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/** The committed example-run's pinned crawledAt — a fresh bookend at this value reproduces it. */
const FROZEN_CRAWLED_AT = '2026-06-29T00:00:00.000Z';
const EXAMPLE_RUN = new URL('../examples/example-run/', import.meta.url);

describe('example-run regression golden — deterministic drift + concurrency stability (D1/D7/D12)', () => {
  // Unlike the whole-artifact A-vs-B test above (same code both runs → catches only
  // NON-determinism), this pins the ACTUAL committed output values: any deliberate detector or
  // format change turns the test red and forces a conscious regeneration of examples/example-run/
  // (catches deterministic DRIFT — the gap flagged in the round-2 review). It also exercises the
  // CLI default (concurrency=2) and full-audit (4) over the WHOLE artifact; the prior concurrency
  // test only deep-checked crawl.csv + a couple of linkGraph keys (and sorted orphans, masking order).
  const goldenAnalysis = readNormalizedJson(new URL('analysis.json', EXAMPLE_RUN).pathname);
  const goldenSignals  = readNormalizedJson(new URL('signals.json', EXAMPLE_RUN).pathname);

  for (const concurrency of [1, 2, 4]) {
    it(`bookend at concurrency=${concurrency} reproduces the committed example-run signals + analysis`, async () => {
      let srv, dataDir;
      try {
        srv = await startFixtureServer();
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `seo-golden-c${concurrency}-`));
        const r = await crawlAndAnalyze(srv.baseUrl, { rps: 50, maxUrls: 40, crawledAt: FROZEN_CRAWLED_AT, concurrency, dataDir });
        assert.deepStrictEqual(readNormalizedJson(r.signalsPath), goldenSignals,
          `signals.json must match committed examples/example-run at concurrency=${concurrency} — regenerate the example-run on an intentional change`);
        assert.deepStrictEqual(readNormalizedJson(r.analysisPath), goldenAnalysis,
          `analysis.json must match committed examples/example-run at concurrency=${concurrency}`);
      } finally {
        if (srv) await srv.close();
        if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
  }
});
