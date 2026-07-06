/**
 * test/kb-review.test.mjs — review-2026-07-06 KB/RAG hardening.
 *
 *   1. cosine() had no length guard → NaN / false-1.0 on dimension mismatch.
 *   2. retrieve() always returned k → add an opt-in similarity floor.
 *   3. chunk splitter was not code-fence-aware → a `# ` line inside ``` split.
 *   4. ingest dropped empty-body headings, and chunk ids collided on shared source.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../kb/store.mjs';
import { retrieve } from '../kb/retrieve.mjs';
import { chunkMarkdown } from '../kb/chunk.mjs';
import { ingestDir } from '../kb/ingest.mjs';

describe('store cosine — dimension-mismatch guard', () => {
  it('returns score 0 (not a false 1.0) when the query is shorter than stored', () => {
    const s = createStore();
    s.add('a', [1, 0, 0, 0], {});
    assert.equal(s.search([1, 0], 1)[0].score, 0);
  });

  it('returns a finite score 0 (not NaN) when the query is longer than stored', () => {
    const s = createStore();
    s.add('b', [1, 0], {});
    const hit = s.search([1, 0, 0, 0, 0, 0], 1)[0];
    assert.ok(Number.isFinite(hit.score));
    assert.equal(hit.score, 0);
  });
});

describe('retrieve — opt-in similarity floor', () => {
  it('an impossible floor (minScore > 1) drops every hit', async () => {
    const floored = await retrieve('canonical duplicate content', 5, { minScore: 1.1 });
    assert.equal(floored.length, 0);
  });

  it('the default (no minScore) still returns hits', async () => {
    const r = await retrieve('meta description length', 3);
    assert.ok(r.length >= 1);
  });
});

describe('chunkMarkdown — fenced code blocks', () => {
  it('does not split on a `# ` line inside a code fence', () => {
    const md = '# Real Heading\n\ntext line\n\n```\n# not a heading\nmore\n```\n\n## Second\n\nbody';
    const chunks = chunkMarkdown(md);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].heading, 'Real Heading');
    assert.ok(chunks[0].text.includes('# not a heading'), 'the fenced # line stays inside the first chunk');
    assert.equal(chunks[1].heading, 'Second');
  });
});

describe('ingestDir — empty-body headings + unique ids', () => {
  it('embeds an empty-body H1 instead of dropping it, and ids are unique for a shared source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.md'), '---\nsource: https://x/\n---\n# Topical Title\n\n## Sub\n\nbody a');
      fs.writeFileSync(path.join(dir, 'b.md'), '---\nsource: https://x/\n---\n# Other\n\nbody b');
      const added = [];
      const store = { add: (id, _vec, meta) => added.push({ id, meta }), search() {}, size() { return added.length; } };
      const embedFn = (t) => [t.length, 1, 0];

      await ingestDir(dir, store, embedFn);

      assert.ok(added.some(a => a.meta.heading === 'Topical Title'), 'empty-body H1 must not be dropped');
      const ids = added.map(a => a.id);
      assert.equal(new Set(ids).size, ids.length, 'chunk ids must be unique across files sharing a source');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
