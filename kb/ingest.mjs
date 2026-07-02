/**
 * kb/ingest.mjs — Ingest a directory of Markdown files into a vector store.
 *
 * export async function ingestDir(dir, store, embedFn) → number
 *
 * Steps:
 *  1. Read every .md / .mdx file in `dir` (non-recursive by default).
 *  2. Extract `source` and `datum` from YAML front-matter if present.
 *  3. Chunk the document via chunkMarkdown().
 *  4. Embed each chunk with embedFn (sync or async).
 *  5. store.add(id, vector, meta) for each chunk.
 *  6. Return total chunk count.
 *
 * CLI: node kb/ingest.mjs <dir>
 *   Prints ingestion summary; uses the local embed fallback and default store.
 *
 * Runtime note: to use a real embedding API, pass embedFn = async (text) => number[]
 * from your provider (e.g. OpenAI text-embedding-3-small).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { chunkMarkdown } from './chunk.mjs';

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Parse a minimal subset of YAML front-matter (key: value lines only).
 * Returns {} if no front-matter found.
 * @param {string} text
 * @returns {{ source?: string, datum?: string, [key: string]: string }}
 */
function parseFrontMatter(text) {
  const match = text.match(FRONT_MATTER_RE);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([^:]+):\s*(.+)$/);
    if (kv) result[kv[1].trim()] = kv[2].trim();
  }
  return result;
}

/**
 * Ingest all .md and .mdx files from `dir` into `store`.
 *
 * @param {string}   dir      Directory path to scan
 * @param {object}   store    Instance from createStore()
 * @param {Function} embedFn  sync or async: (text: string) => number[]
 * @returns {Promise<number>} Total number of chunks ingested
 */
export async function ingestDir(dir, store, embedFn) {
  const files = (await readdir(dir))
    .filter(f => ['.md', '.mdx'].includes(extname(f)))
    .sort();

  let total = 0;

  for (const file of files) {
    const filePath = join(dir, file);
    const text     = await readFile(filePath, 'utf8');
    const fm       = parseFrontMatter(text);
    const source   = fm.source ?? basename(file);
    const date     = fm.datum  ?? '';

    const chunks = chunkMarkdown(text);

    for (let i = 0; i < chunks.length; i++) {
      const { text: chunkText, heading } = chunks[i];
      if (!chunkText.trim()) continue;

      const id     = `${source}#${i}`;
      const vector = await Promise.resolve(embedFn(chunkText));

      store.add(id, vector, { source, heading, date, text: chunkText });
      total++;
    }
  }

  return total;
}

// ── CLI entry-point ───────────────────────────────────────────────────────────

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node kb/ingest.mjs <directory>');
    process.exit(1);
  }

  const { createStore } = await import('./store.mjs');
  const { embed }       = await import('./embed.mjs');

  const store = createStore();
  const count = await ingestDir(dir, store, embed);

  console.log(`Ingested ${count} chunks from "${dir}".`);
  console.log('(Store is in-memory only — pass a pgvector store for persistence.)');
}
