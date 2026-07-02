/**
 * test/skills.test.mjs — Unit F consistency + bookend tests.
 *
 * Two concerns:
 *   1. Behaviour — bin/crawl-and-analyze.mjs really runs the deterministic
 *      bookend (runCrawl → analyzeFromFiles) against the fixture server and
 *      writes a schema-plausible analysis.json. (This is the only real code in
 *      Unit F; the skills themselves are Markdown.)
 *   2. Consistency — CLAUDE.md and the skills only point at paths/commands that
 *      actually exist, and the core skill names the binding findings.json
 *      contract. This keeps the "agentic brain" from referencing fiction.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { startFixtureServer } from './fixture-server.mjs';
import { crawlAndAnalyze } from '../bin/crawl-and-analyze.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ─────────────────────────────────────────────────────────────────────────────
// 1. Behaviour: the deterministic bookend produces analysis.json
// ─────────────────────────────────────────────────────────────────────────────
describe('bin/crawl-and-analyze.mjs', () => {
  let base, close, dataDir;

  before(async () => {
    const srv = await startFixtureServer();
    base = srv.baseUrl;
    close = srv.close;
    // Unique output dir per suite — avoids the data/127.0.0.1/ collision across
    // parallel test files (crawlAndAnalyze forwards dataDir to runCrawl, and the
    // analysis.json path is derived from path.dirname(csvPath)).
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
  });

  after(() => {
    close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('exposes a crawlAndAnalyze() function', () => {
    assert.equal(typeof crawlAndAnalyze, 'function');
  });

  it('writes a schema-plausible analysis.json against the fixture server', async () => {
    const { analysisPath, analysis } = await crawlAndAnalyze(base, { rps: 50, maxUrls: 30, dataDir });

    assert.ok(analysisPath, 'should return the analysisPath');
    assert.ok(fs.existsSync(analysisPath), `analysis.json should exist at ${analysisPath}`);
    assert.ok(analysisPath.endsWith('analysis.json'), 'path should end with analysis.json');

    // Returned object and on-disk file must agree.
    const onDisk = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
    assert.deepEqual(onDisk, analysis, 'returned analysis should equal the persisted file');

    // analysisObj shape contract (see analyze/analyze.mjs).
    assert.equal(typeof analysis.meta, 'object');
    assert.ok(analysis.meta && analysis.meta.host, 'meta.host should be set');
    assert.equal(typeof analysis.rulesetVersion, 'string');
    assert.ok(Array.isArray(analysis.findings), 'findings must be an array');
    assert.ok(Array.isArray(analysis.positives), 'positives must be an array');
    assert.equal(typeof analysis.signals, 'object');
    assert.ok('minNMet' in analysis.meta, 'meta.minNMet must be present');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Consistency: CLAUDE.md references only real artifacts
// ─────────────────────────────────────────────────────────────────────────────
describe('CLAUDE.md consistency', () => {
  it('CLAUDE.md exists', () => {
    assert.ok(exists('CLAUDE.md'), 'CLAUDE.md should exist at repo root');
  });

  // Skill/bin/legal artifacts that MUST exist *now* and be referenced.
  const mustExistAndBeReferenced = [
    'bin/crawl-and-analyze.mjs',
    'skills/interpret.md',
    'skills/strategy.md',
    'skills/context-handoff.md',
    'DISCLAIMER.md',
  ];

  for (const rel of mustExistAndBeReferenced) {
    it(`references ${rel} and the file exists`, () => {
      assert.ok(exists(rel), `${rel} should exist on disk`);
      assert.ok(read('CLAUDE.md').includes(rel), `CLAUDE.md should reference ${rel}`);
    });
  }

  it('references report/build-report.mjs as the live final render step, and the file exists on disk', () => {
    const md = read('CLAUDE.md');
    assert.ok(md.includes('report/build-report.mjs'), 'CLAUDE.md should reference the report renderer');
    assert.ok(exists('report/build-report.mjs'), 'report/build-report.mjs should exist on disk (renderer is live)');
  });

  it('documents the artifact-path convention chain', () => {
    const md = read('CLAUDE.md');
    for (const artifact of ['crawl.csv', 'signals.json', 'analysis.json', 'findings.json', 'strategy.md']) {
      assert.ok(md.includes(artifact), `CLAUDE.md should mention the artifact "${artifact}"`);
    }
  });

  it('requires a capable, current model in thinking mode and Anthropic docs as source of truth', () => {
    const md = read('CLAUDE.md');
    assert.ok(/thinking/i.test(md), 'CLAUDE.md should require thinking mode');
    assert.ok(/anthropic/i.test(md), 'CLAUDE.md should name the official Anthropic docs as source of truth');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Consistency: the core skill names the binding findings.json contract
// ─────────────────────────────────────────────────────────────────────────────
describe('skills/interpret.md contract', () => {
  it('exists', () => {
    assert.ok(exists('skills/interpret.md'));
  });

  it('names every required findings.json top-level key', () => {
    const md = read('skills/interpret.md');
    for (const key of ['meta', 'execSummary', 'sections', 'positives', 'strategy', 'confidence']) {
      assert.ok(md.includes(key), `interpret.md should name the top-level key "${key}"`);
    }
  });

  it('mandates running validateFindings (from lib/findings-schema.mjs)', () => {
    const md = read('skills/interpret.md');
    assert.ok(md.includes('validateFindings'), 'interpret.md should require validateFindings');
    assert.ok(md.includes('lib/findings-schema.mjs'), 'interpret.md should cite the schema module');
  });

  it('grounds recommendations via kb/retrieve.mjs and cites kbSources', () => {
    const md = read('skills/interpret.md');
    assert.ok(md.includes('kb/retrieve.mjs'), 'interpret.md should reference the retriever');
    assert.ok(md.includes('kbSources'), 'interpret.md should require kbSources citations');
  });

  it('defines the ICE anchor rubric and provenance discipline', () => {
    const md = read('skills/interpret.md');
    assert.ok(/ICE/i.test(md), 'interpret.md should define an ICE rubric');
    for (const prov of ['gemessen', 'beobachtet', 'geschätzt']) {
      assert.ok(md.includes(prov), `interpret.md should enumerate provenance value "${prov}"`);
    }
  });

  // ── U0.2 assertions ──────────────────────────────────────────────────────────

  it('reads rulesetVersion from top-level analysis.rulesetVersion, not analysis.meta', () => {
    const md = read('skills/interpret.md');
    assert.ok(
      md.includes('analysis.rulesetVersion'),
      'interpret.md should reference top-level analysis.rulesetVersion'
    );
    assert.ok(
      !md.includes('analysis.meta.rulesetVersion'),
      'interpret.md must NOT reference analysis.meta.rulesetVersion (rulesetVersion is top-level)'
    );
  });

  it('instructs copying crawledAt from analysis.meta.crawledAt (never invented)', () => {
    const md = read('skills/interpret.md');
    // The copy instruction near "do not recompute" must explicitly list crawledAt.
    // We extract the sentence/paragraph that mentions the copy of meta fields and check
    // that crawledAt appears there (not just in the §0 shape description).
    const copyIdx = md.indexOf('do not recompute');
    assert.ok(copyIdx !== -1, 'interpret.md should contain a "do not recompute" copy instruction');
    const copyContext = md.slice(Math.max(0, copyIdx - 300), copyIdx + 100);
    assert.ok(
      copyContext.includes('crawledAt'),
      'interpret.md copy instruction (near "do not recompute") must explicitly list crawledAt'
    );
  });

  it('contains a caveat rule triggered by capped or coveragePct < 100', () => {
    const md = read('skills/interpret.md');
    // Find a window of ≤1000 chars where meta.capped and caveats co-occur
    // (i.e. the new anti-overclaim rule names both in the same paragraph)
    const metaCappedIdx = md.indexOf('meta.capped');
    assert.ok(metaCappedIdx !== -1, 'interpret.md should mention meta.capped in the anti-overclaim section');
    // Within ±1000 chars of meta.capped there must be a confidence.caveats reference
    const window = md.slice(Math.max(0, metaCappedIdx - 200), metaCappedIdx + 1000);
    assert.ok(
      window.includes('caveats'),
      'interpret.md should mention caveats within the same anti-overclaim rule as meta.capped'
    );
  });

  it('restricts positives list items to pure strings (no object items)', () => {
    const md = read('skills/interpret.md');
    assert.ok(
      !md.includes('or `{ title'),
      'interpret.md must not allow { title, … } objects in the positives list'
    );
    // "or objects" variant also must be absent from the positives context
    const posIdx = md.indexOf('### `positives`');
    const posSection = posIdx !== -1 ? md.slice(posIdx, posIdx + 600) : '';
    assert.ok(
      !posSection.includes('or objects'),
      'interpret.md positives section must not say "or objects"'
    );
  });

  it('mandates a parseable ruleId= token in the beleg field', () => {
    const md = read('skills/interpret.md');
    assert.ok(
      md.includes('ruleId='),
      'interpret.md should mandate a ruleId=<id> token in the beleg field for the rotation ledger'
    );
    // The mandate must be near the beleg definition (not just a passing example)
    const belegIdx = md.indexOf('`beleg`');
    const ruleIdIdx = md.indexOf('ruleId=');
    assert.ok(
      belegIdx !== -1 && ruleIdIdx !== -1 && Math.abs(belegIdx - ruleIdIdx) < 1500,
      'interpret.md should describe the ruleId= token requirement near the beleg definition'
    );
  });

  // ── D6/D11 assertions ─────────────────────────────────────────────────────

  it('encodes the eligibility ≠ ranking-factor rule (states "KEIN Ranking-Signal")', () => {
    const md = read('skills/interpret.md');
    assert.ok(/eligibilit/i.test(md), 'interpret.md should classify rich-result/indexing eligibility');
    assert.ok(
      md.includes('KEIN Ranking-Signal'),
      'interpret.md should require stating "KEIN Ranking-Signal" for eligibility/security/usability findings'
    );
    assert.ok(
      md.includes('Propagate the rule\'s `quelle` framing') || /propagate.*quelle/i.test(md),
      'interpret.md should instruct propagating the rule quelle framing into auswirkung'
    );
  });

  it('documents the incoming severity:"info" → niedrig down-map', () => {
    const md = read('skills/interpret.md');
    assert.ok(
      md.includes('info → niedrig'),
      'interpret.md should map the incoming info severity to niedrig'
    );
  });

  it('relabels site-level pctOfPages rather than quoting the 1/pageCount fraction', () => {
    const md = read('skills/interpret.md');
    assert.ok(/site-weit/.test(md), 'interpret.md should relabel site-level pctOfPages as "site-weit"');
    assert.ok(/1\/pageCount/.test(md), 'interpret.md should name the misleading 1/pageCount fraction');
  });

  it('discloses the fixture-grade lexical embedder fallback (RAG honesty)', () => {
    const md = read('skills/interpret.md');
    assert.ok(/lexical/i.test(md), 'interpret.md should disclose the lexical hash-trick embedder fallback');
    assert.ok(md.includes('kb/embed.mjs'), 'interpret.md should name kb/embed.mjs as the default embedder');
    assert.ok(/no-hit/i.test(md), 'interpret.md should treat a sub-threshold score as a no-hit');
    // The honest-empty-kbSources rule must remain intact.
    assert.ok(/empty `kbSources` is CORRECT/i.test(md) || /keep `kbSources` honest \(empty\)/.test(md),
      'interpret.md should keep the honest-empty kbSources rule');
  });

  it('requires meta.modelId from harness/runtime or Anthropic docs, never memory', () => {
    const md = read('skills/interpret.md');
    const hIdx = md.indexOf('harness/runtime');
    assert.ok(hIdx !== -1, 'interpret.md should source modelId from the harness/runtime');
    assert.ok(
      /memory/i.test(md.slice(hIdx, hIdx + 220)),
      'interpret.md should forbid self-recalling modelId from memory near the harness/runtime instruction'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Content: skills/strategy.md covers the key behavioural commitments
// ─────────────────────────────────────────────────────────────────────────────
describe('skills/strategy.md content', () => {
  it('exists', () => {
    assert.ok(exists('skills/strategy.md'));
  });

  it('describes a meta-prompting step (agent designs its own research questions)', () => {
    const md = read('skills/strategy.md');
    assert.ok(/meta-prompt/i.test(md), 'strategy.md should describe a meta-prompting step');
  });

  it('includes a conditional company-context question (ask only when needed)', () => {
    const md = read('skills/strategy.md');
    assert.ok(/conditional/i.test(md) || /only.*needed/i.test(md) || /only if/i.test(md),
      'strategy.md should gate the context question (ask only when needed)');
  });

  it('requires provenance vocabulary on strategic claims', () => {
    const md = read('skills/strategy.md');
    for (const prov of ['gemessen', 'beobachtet', 'geschätzt']) {
      assert.ok(md.includes(prov), `strategy.md should enumerate provenance value "${prov}"`);
    }
  });

  // ── U0.2 assertions ──────────────────────────────────────────────────────────

  it('defines levers and todos as pure strings, not objects', () => {
    const md = read('skills/strategy.md');
    assert.ok(
      !md.includes('or objects'),
      'strategy.md must not allow "or objects" for levers/todos — they must be pure strings'
    );
    assert.ok(
      !md.includes('short strings or'),
      'strategy.md must not say "short strings or objects" — levers/todos must be pure strings'
    );
  });

  // ── D11 assertion ─────────────────────────────────────────────────────────

  it('discloses the fixture-grade lexical embedder fallback in the research step', () => {
    const md = read('skills/strategy.md');
    assert.ok(/lexical/i.test(md), 'strategy.md should disclose the lexical embedder fallback');
    assert.ok(md.includes('kb/embed.mjs'), 'strategy.md should name kb/embed.mjs as the default embedder');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Content: skills/context-handoff.md covers the key rotation commitments
// ─────────────────────────────────────────────────────────────────────────────
describe('skills/context-handoff.md content', () => {
  it('exists', () => {
    assert.ok(exists('skills/context-handoff.md'));
  });

  it('references the data/<host> artifact path', () => {
    const md = read('skills/context-handoff.md');
    assert.ok(md.includes('data/<host>'), 'context-handoff.md should reference data/<host>');
  });

  it('documents the /rotate command trigger', () => {
    const md = read('skills/context-handoff.md');
    assert.ok(md.includes('/rotate'), 'context-handoff.md should document the /rotate command');
  });

  it('prohibits token-counting as a rotation trigger', () => {
    const md = read('skills/context-handoff.md');
    assert.ok(/token/i.test(md), 'context-handoff.md should address token-counting (and reject it as a trigger)');
  });

  it('regenerates the handoff packet from artifact files, not from memory', () => {
    const md = read('skills/context-handoff.md');
    assert.ok(/artifact/i.test(md), 'context-handoff.md should require regeneration from artifact files');
    assert.ok(/not.*memory|never.*memory|do not.*recollect/i.test(md),
      'context-handoff.md should explicitly forbid reconstructing from memory');
  });

  // ── U0.2 assertions ──────────────────────────────────────────────────────────

  it('derives the rotation ledger from the ruleId= token in the beleg field', () => {
    const md = read('skills/context-handoff.md');
    assert.ok(
      md.includes('ruleId='),
      'context-handoff.md should reference the ruleId= token (from beleg) for the progress ledger diff'
    );
  });

  // ── D11 assertion ─────────────────────────────────────────────────────────

  it('references bin/handoff.mjs as the deterministic generator (and it exists)', () => {
    const md = read('skills/context-handoff.md');
    assert.ok(
      md.includes('bin/handoff.mjs'),
      'context-handoff.md should reference bin/handoff.mjs as the deterministic generator'
    );
    assert.ok(exists('bin/handoff.mjs'), 'bin/handoff.mjs should exist on disk (the skill is its spec)');
  });
});
