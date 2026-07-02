/**
 * test/bin-crawl-and-analyze.test.mjs — TDD for parseArgs export (Welle 5 U5.1, RED first).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixtureServer } from './fixture-server.mjs';
import { parseArgs, crawlAndAnalyze } from '../bin/crawl-and-analyze.mjs';

const CLI_PATH = fileURLToPath(new URL('../bin/crawl-and-analyze.mjs', import.meta.url));

describe('parseArgs (bin/crawl-and-analyze.mjs)', () => {
  it('defaults to standard profile when no --profile flag given', () => {
    const { url, opts, profile } = parseArgs(['http://x']);
    assert.strictEqual(url, 'http://x');
    assert.strictEqual(profile, 'standard');
    assert.strictEqual(opts.maxUrls, 300);
    assert.strictEqual(opts.rps, 2);
  });

  it('--profile quick-scan resolves to correct opts', () => {
    const { opts, profile } = parseArgs(['http://x', '--profile', 'quick-scan']);
    assert.strictEqual(profile, 'quick-scan');
    assert.strictEqual(opts.maxUrls, 50);
    assert.strictEqual(opts.maxDepth, 2);
  });

  it('explicit --max overrides the profile maxUrls', () => {
    const { opts, profile } = parseArgs(['http://x', '--profile', 'full-audit', '--max', '100']);
    assert.strictEqual(profile, 'full-audit');
    assert.strictEqual(opts.maxUrls, 100);
    assert.strictEqual(opts.concurrency, 4);
  });

  it('explicit --rps overrides the default standard profile rps', () => {
    const { opts } = parseArgs(['http://x', '--rps', '5']);
    assert.strictEqual(opts.rps, 5);
  });

  it('throws on unknown --profile value', () => {
    assert.throws(() => parseArgs(['http://x', '--profile', 'bogus']));
  });

  // ── --max / --rps validation (review fix: bare Number() silently disabled cap/throttle) ──

  it('throws on --max abc (non-numeric)', () => {
    assert.throws(() => parseArgs(['http://x', '--max', 'abc']), /--max must be a positive integer/);
  });

  it('throws on --max 0 (must be positive)', () => {
    assert.throws(() => parseArgs(['http://x', '--max', '0']), /--max must be a positive integer/);
  });

  it('throws on --max -1 (negative)', () => {
    assert.throws(() => parseArgs(['http://x', '--max', '-1']), /--max must be a positive integer/);
  });

  it('throws on --max 1.5 (non-integer)', () => {
    assert.throws(() => parseArgs(['http://x', '--max', '1.5']), /--max must be a positive integer/);
  });

  it('throws on --rps foo (non-numeric)', () => {
    assert.throws(() => parseArgs(['http://x', '--rps', 'foo']), /--rps must be a positive number/);
  });

  it('throws on --rps -5 (negative)', () => {
    assert.throws(() => parseArgs(['http://x', '--rps', '-5']), /--rps must be a positive number/);
  });

  it('accepts fractional --rps 0.5 (valid positive number)', () => {
    const { opts } = parseArgs(['http://x', '--rps', '0.5']);
    assert.strictEqual(opts.rps, 0.5);
  });
});

// ── CLI --help / -h (review fix: previously exited 1) ────────────────────────

describe('CLI --help / -h (bin/crawl-and-analyze.mjs)', () => {
  it('--help prints usage to STDOUT and exits 0', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, '--help'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status} (stderr: ${r.stderr})`);
    assert.match(r.stdout, /Usage: node bin\/crawl-and-analyze\.mjs <url>/);
  });

  it('-h prints usage to STDOUT and exits 0', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, '-h'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status} (stderr: ${r.stderr})`);
    assert.match(r.stdout, /Usage: node bin\/crawl-and-analyze\.mjs <url>/);
  });
});

// ── End-to-end bookend smoke test (crawl → analyze → persist) ────────────────
// Exercises the deterministic bookend CLAUDE.md documents against the in-process
// fixture server. Isolated via a per-suite mkdtemp dataDir; crawledAt is injected
// so no wall-clock is read (determinism guard).

describe('crawlAndAnalyze end-to-end (bin/crawl-and-analyze.mjs)', () => {
  let srv, dataDir;

  before(async () => {
    srv = await startFixtureServer();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
  });

  after(async () => {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('drives crawl→analyze→persist and writes a schema-valid analysis.json', async () => {
    const { analysisPath, analysis } = await crawlAndAnalyze(srv.baseUrl, {
      dataDir,
      rps: 50,
      maxUrls: 30,
      crawledAt: '2026-01-01T00:00:00.000Z',
    });

    // Returned path points at a real file that round-trips to the returned object.
    assert.ok(analysisPath.endsWith('analysis.json'), `path should end with analysis.json, got ${analysisPath}`);
    assert.ok(fs.existsSync(analysisPath), `analysis.json should exist at ${analysisPath}`);
    const onDisk = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
    assert.deepEqual(onDisk, analysis, 'persisted file must equal the returned analysis');

    // Schema-valid shape (analysis.json contract — see analyze/analyze.mjs).
    assert.strictEqual(typeof analysis.meta, 'object');
    assert.ok(analysis.meta.host, 'meta.host should be set');
    assert.ok(analysis.meta.pageCount > 0, `meta.pageCount should be > 0, got ${analysis.meta.pageCount}`);
    assert.strictEqual(analysis.meta.crawledAt, '2026-01-01T00:00:00.000Z', 'injected crawledAt should flow through to meta');
    assert.strictEqual(typeof analysis.rulesetVersion, 'string');
    assert.ok(analysis.rulesetVersion.length > 0, 'rulesetVersion should be non-empty');
    assert.ok(Array.isArray(analysis.findings) && analysis.findings.length > 0, 'findings should be a non-empty array');
    assert.ok(Array.isArray(analysis.positives), 'positives should be an array');
    assert.strictEqual(typeof analysis.signals, 'object');
  });
});
