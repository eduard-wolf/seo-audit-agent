/**
 * test/resume.test.mjs — U5.3 TDD tests for checkpoint + resume (RED first).
 *
 * Property under test: a capped-then-resumed crawl yields byte-identical
 * crawl.csv AND identical link-graph (orphans/depthByUrl) vs an uninterrupted
 * crawl with the higher cap.
 *
 * U5.3-5 (Welle 5): loud resume guard — THROWS "Resume aborted" when
 * checkpoint fetchedCount > crawl.csv rows (hard-crash signature).
 * U5.3-6 (Welle 5): resume × concurrency:4 byte-identity — regression guard
 * for the production path (both shipped profiles use concurrency > 1).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from './fixture-server.mjs';
import { runCrawl } from '../crawl/run.mjs';
import { parseCsv } from '../crawl/schema.mjs';

/** Path to crawl-state.json inside a given data dir (the dataDir override). */
function statePath(dir) {
  return path.join(dir, 'crawl-state.json');
}

/** Normalise 127.0.0.1:<port> → HOST for deterministic comparison across runs. */
function normalize(s) {
  return s.replace(/127\.0\.0\.1:\d+/g, 'HOST');
}

describe('crawl checkpoint + resume (U5.3)', () => {
  let srv, base, dataDir;

  before(async () => {
    srv  = await startFixtureServer();
    base = srv.baseUrl;
    // Unique output dir per suite — resume reads crawl-state.json from this same
    // dir; the hostname-derived default (data/127.0.0.1/) would collide with
    // other parallel test files.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
  });

  after(async () => {
    if (srv) await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ── U5.3-1: byte-identical crawl.csv ─────────────────────────────────────
  it('U5.3-1: resumed crawl.csv is byte-identical (host:port-normalised) to a fresh full run', async () => {
    // Step A: cap at 5 → crawl-state.json has done:false
    await runCrawl(base, { rps: 50, maxUrls: 5, dataDir });

    // Step B: resume, extend cap to 40
    const resumeResult = await runCrawl(base, { rps: 50, maxUrls: 40, resume: true, dataDir });
    const resumedCsv   = fs.readFileSync(resumeResult.csvPath, 'utf8');

    // Sanity: resumed CSV must have MORE than 5 data rows
    const resumedRows = parseCsv(resumedCsv);
    assert.ok(
      resumedRows.length > 5,
      `Resumed CSV should have more than 5 rows, got ${resumedRows.length}`,
    );

    // Step C: fresh uninterrupted run (overwrites data dir)
    const freshResult = await runCrawl(base, { rps: 50, maxUrls: 40, dataDir });
    const freshCsv    = fs.readFileSync(freshResult.csvPath, 'utf8');

    assert.strictEqual(
      normalize(resumedCsv),
      normalize(freshCsv),
      'Resumed crawl.csv must be byte-identical to a fresh full run (after host:port normalisation)',
    );
  });

  // ── U5.3-2: identical link-graph ──────────────────────────────────────────
  it('U5.3-2: resumed link-graph (orphans + depthByUrl) matches a fresh full run', async () => {
    // Step A: cap at 5
    await runCrawl(base, { rps: 50, maxUrls: 5, dataDir });

    // Step B: resume
    const resumeResult  = await runCrawl(base, { rps: 50, maxUrls: 40, resume: true, dataDir });
    const resumedSig    = JSON.parse(fs.readFileSync(resumeResult.signalsPath, 'utf8'));

    // Step C: fresh run
    const freshResult   = await runCrawl(base, { rps: 50, maxUrls: 40, dataDir });
    const freshSig      = JSON.parse(fs.readFileSync(freshResult.signalsPath, 'utf8'));

    /** Normalise host:port in all keys of a depthByUrl object. */
    const normalizeDepth = obj =>
      Object.fromEntries(Object.entries(obj).map(([k, v]) => [normalize(k), v]));

    assert.deepStrictEqual(
      [...resumedSig.linkGraph.orphans].map(normalize).sort(),
      [...freshSig.linkGraph.orphans].map(normalize).sort(),
      'Resumed linkGraph.orphans must match a fresh run',
    );

    assert.deepStrictEqual(
      normalizeDepth(resumedSig.linkGraph.depthByUrl),
      normalizeDepth(freshSig.linkGraph.depthByUrl),
      'Resumed linkGraph.depthByUrl must match a fresh run',
    );
  });

  // ── U5.3-3: done flag ─────────────────────────────────────────────────────
  it('U5.3-3: done=true after queue fully drains; done=false after a maxUrls cap', async () => {
    // Full drain (default maxUrls=200, fixture site has ~21 reachable URLs)
    await runCrawl(base, { rps: 50, dataDir });
    const stateAfterDrain = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'));
    assert.strictEqual(stateAfterDrain.done, true, 'done should be true after queue fully drains');

    // Capped run
    await runCrawl(base, { rps: 50, maxUrls: 5, dataDir });
    const stateAfterCap = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'));
    assert.strictEqual(stateAfterCap.done, false, 'done should be false after a maxUrls cap');
  });

  // ── U5.3-4: no duplicate rows on resume ───────────────────────────────────
  it('U5.3-4: resumed crawl.csv contains no duplicate url values', async () => {
    // Step A: cap at 5
    await runCrawl(base, { rps: 50, maxUrls: 5, dataDir });

    // Step B: resume
    const resumeResult = await runCrawl(base, { rps: 50, maxUrls: 40, resume: true, dataDir });
    const resumedCsv   = fs.readFileSync(resumeResult.csvPath, 'utf8');
    const rows         = parseCsv(resumedCsv);

    const urls       = rows.map(r => r.url);
    const uniqueUrls = new Set(urls);
    const dupes      = urls.filter((u, i) => urls.indexOf(u) !== i);
    assert.strictEqual(
      urls.length,
      uniqueUrls.size,
      `Resumed crawl.csv has duplicate URL(s): ${dupes.join(', ')}`,
    );
  });

  // ── U5.3-5: hard-crash guard (RED first → implements loud resume abort) ───
  it('U5.3-5: resume throws "Resume aborted" when checkpoint fetchedCount exceeds crawl.csv rows (hard-crash signature)', async () => {
    // Step A: capped crawl — writes crawl.csv (5 rows) + crawl-state.json
    await runCrawl(base, { rps: 50, maxUrls: 5, dataDir });

    // Simulate a hard crash: artificially bump fetchedCount in the checkpoint to
    // exceed the actual row count in crawl.csv — this is the kill -9 mid-run
    // signature (checkpoint written after pages but before the atomic CSV write).
    const sPath = statePath(dataDir);
    const state = JSON.parse(fs.readFileSync(sPath, 'utf8'));
    state.fetchedCount = (state.fetchedCount ?? 0) + 10; // clearly > rows in csv
    state.done = false; // ensure done=false so resume block is entered
    fs.writeFileSync(sPath, JSON.stringify(state), 'utf8');

    // Resume MUST throw with "Resume aborted" instead of silently producing a
    // corrupt crawl.csv that is missing the first run's rows.
    await assert.rejects(
      () => runCrawl(base, { rps: 50, maxUrls: 40, resume: true, dataDir }),
      (err) => {
        assert.ok(
          err.message.includes('Resume aborted'),
          `Expected "Resume aborted" in error message, got: ${err.message}`,
        );
        return true;
      },
      'runCrawl should throw when checkpoint records more fetched pages than crawl.csv has rows',
    );
  });

  // ── U5.3-6: resume × concurrency:4 byte-identity (regression guard) ──────
  it('U5.3-6: resumed crawl.csv is byte-identical with concurrency:4 (regression guard for full-audit profile)', async () => {
    // Both shipped profiles use concurrency > 1 (standard=2, full-audit=4) so
    // resume × concurrency is the production path. This is a REGRESSION GUARD —
    // the assertion should already pass; we verify it is meaningful (> 5 rows).

    // Step A: cap at 5 with concurrency:4
    await runCrawl(base, { rps: 50, maxUrls: 5, concurrency: 4, dataDir });

    // Step B: resume to 40 pages with concurrency:4
    const resumeResult = await runCrawl(base, { rps: 50, maxUrls: 40, concurrency: 4, resume: true, dataDir });
    const resumedCsv   = fs.readFileSync(resumeResult.csvPath, 'utf8');
    const resumedSig   = JSON.parse(fs.readFileSync(resumeResult.signalsPath, 'utf8'));

    // Assertion is meaningful only if the resumed run actually fetched more than
    // the initial 5 pages; guard against a vacuous equality.
    const resumedRows = parseCsv(resumedCsv);
    assert.ok(
      resumedRows.length > 5,
      `Resumed CSV should have more than 5 rows (vacuous assertion otherwise), got ${resumedRows.length}`,
    );

    // Step C: fresh full run on a second fixture server (same content, different
    // port — host-normalised comparison removes the port difference).
    const srv2 = await startFixtureServer();
    const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
    try {
      const freshResult = await runCrawl(srv2.baseUrl, { rps: 50, maxUrls: 40, concurrency: 4, dataDir: dataDir2 });
      const freshCsv    = fs.readFileSync(freshResult.csvPath, 'utf8');
      const freshSig    = JSON.parse(fs.readFileSync(freshResult.signalsPath, 'utf8'));

      /** Normalise host:port in all keys of a depthByUrl object. */
      const normalizeDepth = obj =>
        Object.fromEntries(Object.entries(obj).map(([k, v]) => [normalize(k), v]));

      // Byte-identity (host-normalised)
      assert.strictEqual(
        normalize(resumedCsv),
        normalize(freshCsv),
        'Resumed crawl.csv must be byte-identical to a fresh full run with concurrency:4 (host:port-normalised)',
      );

      // Link-graph identity
      assert.deepStrictEqual(
        [...resumedSig.linkGraph.orphans].map(normalize).sort(),
        [...freshSig.linkGraph.orphans].map(normalize).sort(),
        'Resumed linkGraph.orphans must match a fresh run (concurrency:4)',
      );
      assert.deepStrictEqual(
        normalizeDepth(resumedSig.linkGraph.depthByUrl),
        normalizeDepth(freshSig.linkGraph.depthByUrl),
        'Resumed linkGraph.depthByUrl must match a fresh run (concurrency:4)',
      );
    } finally {
      await srv2.close();
      fs.rmSync(dataDir2, { recursive: true, force: true });
    }
  });
});
