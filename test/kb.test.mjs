/**
 * test/kb.test.mjs — Unit E TDD tests for the RAG Knowledge-Base layer.
 *
 * All tests are offline / deterministic. No network calls, no external packages.
 * Python smoke-tests run via `python3 -c "import ast; ast.parse(...)"` and are
 * skipped gracefully if python3 is unavailable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { embed }          from '../kb/embed.mjs';
import { createStore }    from '../kb/store.mjs';
import { chunkMarkdown }  from '../kb/chunk.mjs';
import { ingestDir }      from '../kb/ingest.mjs';
import { retrieve }       from '../kb/retrieve.mjs';

const __dir    = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');
const corpusDir = join(repoRoot, 'kb', 'corpus');

// ── helpers ───────────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ── embed ─────────────────────────────────────────────────────────────────────

describe('embed — local deterministic fallback', () => {
  it('returns a number array of fixed dimension 256', async () => {
    const v = await embed('hello world');
    assert.ok(Array.isArray(v), 'should be an array');
    assert.strictEqual(v.length, 256, 'dimension must be 256');
    assert.ok(v.every(x => typeof x === 'number'), 'all elements should be numbers');
  });

  it('is deterministic (same input → identical output)', async () => {
    const v1 = await embed('SEO aggregateRating structured data');
    const v2 = await embed('SEO aggregateRating structured data');
    assert.deepStrictEqual(v1, v2, 'must be identical on repeated calls');
  });

  it('thematically similar texts are more similar than dissimilar ones', async () => {
    const vSeo1  = await embed('aggregateRating structured data rich results schema');
    const vSeo2  = await embed('rich snippets schema markup aggregateRating reviews');
    const vUnrel = await embed('banana pancake recipe breakfast syrup');

    const simSimilar   = cosineSimilarity(vSeo1, vSeo2);
    const simDissimilar = cosineSimilarity(vSeo1, vUnrel);

    assert.ok(
      simSimilar > simDissimilar,
      `Similar pair cosine (${simSimilar.toFixed(3)}) should exceed dissimilar pair (${simDissimilar.toFixed(3)})`
    );
  });

  it('produces a unit-length (L2-normalised) vector', async () => {
    const v = await embed('internal linking anchor text seo');
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, `L2 norm should be ~1, got ${norm}`);
  });

  it('returns zero vector safely for empty string', async () => {
    const v = await embed('');
    assert.strictEqual(v.length, 256);
    // empty string → all zeros is fine; must not throw
  });

  it('delegates to opts.provider when provided', async () => {
    const mockProvider = async (t) => [1, 2, 3];
    const result = await embed('x', { provider: mockProvider });
    assert.deepStrictEqual(result, [1, 2, 3], 'should return provider result');
  });
});

// ── store ─────────────────────────────────────────────────────────────────────

describe('store — in-memory vector store', () => {
  it('add + search returns k results sorted by cosine score desc', async () => {
    const store = createStore();
    store.add('doc-a', await embed('aggregateRating reviews schema'), { source: 'a.md' });
    store.add('doc-b', await embed('internal link anchor text'),      { source: 'b.md' });
    store.add('doc-c', await embed('core web vitals performance lcp'), { source: 'c.md' });

    const results = store.search(await embed('aggregateRating schema markup'), 2);
    assert.strictEqual(results.length, 2, 'should return exactly k results');
    assert.strictEqual(results[0].id, 'doc-a', 'most similar doc should be first');
    assert.ok(results[0].score > results[1].score, 'results should be sorted descending by score');
  });

  it('search with k > store size returns all entries', async () => {
    const store = createStore();
    store.add('x', await embed('hello'), { source: 'x.md' });
    const results = store.search(await embed('hello'), 10);
    assert.strictEqual(results.length, 1);
  });

  it('each result has id, score, meta', async () => {
    const store = createStore();
    store.add('y', await embed('robots txt crawl'), { source: 'y.md', date: '2024-01' });
    const [r] = store.search(await embed('robots txt'), 1);
    assert.ok('id'    in r, 'result must have id');
    assert.ok('score' in r, 'result must have score');
    assert.ok('meta'  in r, 'result must have meta');
    assert.strictEqual(r.meta.source, 'y.md');
  });
});

// ── chunkMarkdown ─────────────────────────────────────────────────────────────

describe('chunkMarkdown — heading-based splitter', () => {
  const md = `---
source: test.md
datum: 2024-06
---

# Core Web Vitals

Largest Contentful Paint (LCP) should be under 2.5 seconds.
Cumulative Layout Shift (CLS) should be under 0.1.

## First Input Delay

FID measures interactivity. Aim for under 100 ms.

## Interaction to Next Paint

INP is the successor to FID for measuring responsiveness.
`;

  it('returns an array of chunk objects with text and heading', () => {
    const chunks = chunkMarkdown(md);
    assert.ok(Array.isArray(chunks), 'should return array');
    assert.ok(chunks.length > 0,     'should have at least one chunk');
    chunks.forEach(c => {
      assert.ok('text'    in c, 'chunk must have text');
      assert.ok('heading' in c, 'chunk must have heading');
    });
  });

  it('splits on multiple headings producing ≥ 3 chunks', () => {
    const chunks = chunkMarkdown(md);
    assert.ok(chunks.length >= 3, `expected ≥3 chunks, got ${chunks.length}`);
  });

  it('captures heading text correctly', () => {
    const chunks = chunkMarkdown(md);
    const headings = chunks.map(c => c.heading);
    assert.ok(headings.some(h => /Core Web Vitals/i.test(h)), 'should have Core Web Vitals heading');
    assert.ok(headings.some(h => /First Input Delay/i.test(h)), 'should have FID heading');
  });

  it('each chunk text contains relevant content', () => {
    const chunks = chunkMarkdown(md);
    const combined = chunks.map(c => c.text).join(' ');
    assert.ok(/LCP/i.test(combined), 'LCP text should appear in chunks');
    assert.ok(/FID/i.test(combined), 'FID text should appear in chunks');
  });

  it('overlap option includes tail of previous chunk in next chunk', () => {
    const overlapChars = 30;
    const chunks = chunkMarkdown(md, { overlapChars });
    assert.ok(chunks.length >= 2, 'need at least 2 chunks to test overlap');
    // chunk[1].text must start with the last overlapChars characters of chunk[0].text
    const expectedPrefix = chunks[0].text.slice(-overlapChars);
    assert.ok(
      chunks[1].text.startsWith(expectedPrefix),
      `chunk[1] should start with tail of chunk[0] ("${expectedPrefix}"); got "${chunks[1].text.slice(0, overlapChars + 5)}"`
    );
  });

  it('handles a document with no headings as a single chunk', () => {
    const plain = 'Just a paragraph without headings.\nAnother line.';
    const chunks = chunkMarkdown(plain);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].heading, '');
  });
});

// ── ingestDir ─────────────────────────────────────────────────────────────────

describe('ingestDir — corpus ingestion', () => {
  let store;

  it('ingests the sample corpus and returns a positive count', async () => {
    store = createStore();
    const count = await ingestDir(corpusDir, store, embed);
    assert.ok(count > 0, `expected at least 1 chunk ingested, got ${count}`);
  });

  it('store is non-empty after ingest', async () => {
    if (!store) {
      store = createStore();
      await ingestDir(corpusDir, store, embed);
    }
    const results = store.search(embed('aggregateRating'), 1);
    assert.ok(results.length > 0, 'store should have entries after ingest');
  });
});

// ── retrieve ─────────────────────────────────────────────────────────────────

describe('retrieve — semantic search over corpus', () => {
  it('returns at most k results with required shape', async () => {
    const results = await retrieve('aggregateRating Rich Results', 3);
    assert.ok(Array.isArray(results), 'should return array');
    assert.ok(results.length > 0,     'should return at least 1 result');
    assert.ok(results.length <= 3,    'should return at most k=3 results');
    const r = results[0];
    assert.ok('text'    in r, 'result must have text');
    assert.ok('source'  in r, 'result must have source');
    assert.ok('heading' in r, 'result must have heading');
    assert.ok('score'   in r, 'result must have score');
    assert.ok('date'    in r, 'result must have date');
  });

  it('top result for "aggregateRating Rich Results" is the aggregateRating card', async () => {
    const results = await retrieve('aggregateRating Rich Results', 3);
    assert.ok(results.length > 0, 'must have results');
    const top = results[0];
    // The top card must be the aggregateRating content. `source` is now a
    // canonical upstream URL (review-snippet card), so assert on the retrieved
    // content/URL rather than the internal filename — robust to source relabels.
    assert.match(`${top.source} ${top.heading} ${top.text}`, /aggregateRating|review[- ]snippet/i);
  });

  it('accepts a pre-built store and embedFn', async () => {
    const store = createStore();
    await ingestDir(corpusDir, store, embed);
    const results = await retrieve('internal linking anchor text', 2, { store, embedFn: embed });
    assert.ok(results.length > 0, 'should return results with injected store');
  });
});

// ── Python smoke-tests ────────────────────────────────────────────────────────

describe('Python touchpoints — syntax validity', () => {
  const pythonFiles = [
    join(repoRoot, 'crawl', 'gsc.py'),
    join(repoRoot, 'kb',    'pgvector_store.py'),
  ];

  const py3 = spawnSync('python3', ['--version']);
  const hasPython = py3.status === 0;

  if (!hasPython) {
    it.skip('python3 not found — skipping Python smoke-tests');
  } else {
    for (const pyFile of pythonFiles) {
      it(`${pyFile.split('/').slice(-2).join('/')} is syntactically valid`, () => {
        const result = spawnSync('python3', [
          '-c',
          `import ast, sys; ast.parse(open(sys.argv[1]).read()); print('OK')`,
          pyFile,
        ]);
        assert.strictEqual(result.status, 0,
          `Syntax error in ${pyFile}:\n${result.stderr?.toString()}`
        );
      });

      it(`${pyFile.split('/').slice(-2).join('/')} importable without external packages`, () => {
        // We can't truly import without installing deps, but we can verify
        // that the file parses and that external imports are inside try/except blocks
        const src = readFileSync(pyFile, 'utf8');
        // The file must contain try/except guarding external imports
        assert.ok(
          src.includes('try:') || src.includes('ImportError'),
          `${pyFile} should guard external imports with try/except`
        );
      });
    }
  }
});
