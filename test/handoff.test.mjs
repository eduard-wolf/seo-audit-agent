/**
 * test/handoff.test.mjs — the deterministic context-rotation generator.
 *
 * bin/handoff.mjs is the executable spec of skills/context-handoff.md: it
 * regenerates the resume packet purely from the on-disk artifacts. These tests
 * pin (1) correctness of the progress ledger against the committed
 * examples/example-run/ artifacts, and (2) determinism — same on-disk state ⇒
 * byte-identical packet, whether called in-process or as a child process.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  renderPacket,
  computeLedger,
  extractInterpretedRuleIds,
  resolveDir,
} from '../bin/handoff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXAMPLE_DIR = path.join(ROOT, 'examples', 'example-run');
const HANDOFF_BIN = path.join(ROOT, 'bin', 'handoff.mjs');

const analysis = JSON.parse(readFileSync(path.join(EXAMPLE_DIR, 'analysis.json'), 'utf8'));
const findings = JSON.parse(readFileSync(path.join(EXAMPLE_DIR, 'findings.json'), 'utf8'));

describe('bin/handoff.mjs ledger', () => {
  it('interprets every analysis ruleId from the committed example (0 remaining)', () => {
    const led = computeLedger(analysis, findings);
    // The example-run is a complete, frozen showcase: every rule hit is interpreted
    // (folded ruleId= clauses included), nothing remains. Assert the invariant against the
    // actual count rather than a brittle magic number.
    assert.ok(led.allRuleIds.length > 0, 'analysis.json should carry rule hits');
    assert.equal(led.interpreted.length, led.allRuleIds.length, 'every analysis ruleId should be interpreted');
    assert.deepEqual(led.remaining, [], 'no ruleIds should remain');
    assert.equal(led.host, '127.0.0.1');
    assert.equal(led.profile.siteType, 'server-rendered');
    assert.equal(led.profile.minNMet, true);
    assert.equal(led.sections.length, 6, 'six sections written');
  });

  it('extracts folded "+"-joined ruleIds from a single beleg clause', () => {
    const ids = extractInterpretedRuleIds({
      sections: [{
        findings: [{
          beleg: 'ruleId=tech:sitemap-quality (count=3) + tech:noindex-conflict + tech:non-2xx; analysis.json affectedUrls',
        }],
      }],
    });
    assert.deepEqual(ids, ['tech:noindex-conflict', 'tech:non-2xx', 'tech:sitemap-quality']);
  });

  it('ignores text after the clause terminator (";") and non-ruleId tokens', () => {
    const ids = extractInterpretedRuleIds({
      sections: [{ findings: [{ beleg: 'ruleId=tech:https (count=21, pctOfPages=100); Crawl-Origin http://127.0.0.1:51427' }] }],
    });
    assert.deepEqual(ids, ['tech:https']);
  });

  it('treats a missing findings.json as "nothing interpreted yet"', () => {
    const led = computeLedger(analysis, null);
    assert.equal(led.findingsPresent, false);
    assert.equal(led.interpreted.length, 0);
    assert.equal(led.remaining.length, led.allRuleIds.length);
  });

  it('resolveDir accepts a dir or a path to an artifact json', () => {
    assert.equal(resolveDir(EXAMPLE_DIR), EXAMPLE_DIR);
    assert.equal(resolveDir(path.join(EXAMPLE_DIR, 'findings.json')), EXAMPLE_DIR);
    assert.equal(resolveDir(path.join(EXAMPLE_DIR, 'analysis.json')), EXAMPLE_DIR);
  });
});

describe('bin/handoff.mjs packet', () => {
  it('renders a sensible, complete-audit packet for the example', () => {
    const packet = renderPacket(EXAMPLE_DIR);
    assert.match(packet, /Resume SEO audit for host: 127\.0\.0\.1/);
    assert.match(packet, /siteType=server-rendered sampleSize=21 coveragePct=95 minNMet=true/);
    assert.match(packet, /findings\.json complete/);
    assert.match(packet, /ruleIds interpreted \(\d+\):/);
    assert.match(packet, /ruleIds not yet interpreted \(0\): none — all analysis ruleIds interpreted/);
    assert.match(packet, /next step: all ruleIds interpreted and strategy present/);
    // Names the artifacts and the engagement rules.
    assert.match(packet, /kb\/retrieve\.mjs/);
    assert.match(packet, /thinking mode/);
  });

  it('is deterministic in-process (two renders byte-identical)', () => {
    assert.equal(renderPacket(EXAMPLE_DIR), renderPacket(EXAMPLE_DIR));
  });

  it('is deterministic across child processes', () => {
    const a = execFileSync('node', [HANDOFF_BIN, EXAMPLE_DIR], { encoding: 'utf8' });
    const b = execFileSync('node', [HANDOFF_BIN, EXAMPLE_DIR], { encoding: 'utf8' });
    assert.equal(a, b, 'two CLI runs should produce identical stdout');
    assert.match(a, /Resume SEO audit for host: 127\.0\.0\.1/);
  });

  it('the dir arg and the findings.json arg resolve to the same packet', () => {
    const viaDir = execFileSync('node', [HANDOFF_BIN, EXAMPLE_DIR], { encoding: 'utf8' });
    const viaFile = execFileSync('node', [HANDOFF_BIN, path.join(EXAMPLE_DIR, 'findings.json')], { encoding: 'utf8' });
    assert.equal(viaDir, viaFile);
  });
});
