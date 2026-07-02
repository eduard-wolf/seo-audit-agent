/**
 * kb/retrieve.mjs — Semantic retrieval from the knowledge base.
 *
 * export async function retrieve(query, k=4, opts?) → [{text, source, heading, score, date}]
 *
 * opts:
 *   store   — pre-built store (createStore() + ingestDir). If omitted, the
 *             default sample corpus is loaded lazily on first call.
 *   embedFn — embedding function. Defaults to the local deterministic fallback.
 *
 * The default store is a singleton; subsequent calls reuse it without
 * re-reading the corpus.
 *
 * Runtime note: for production pass a pgvector store and a real embedFn.
 */

import { fileURLToPath } from 'node:url';
import { join, dirname }  from 'node:path';

const __dir     = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dir, 'corpus');

/** @type {object|null} Singleton default store */
let _defaultStore = null;
/** @type {Function|null} Singleton default embedFn */
let _defaultEmbed = null;

/**
 * Ensure the default in-memory store is initialised from the sample corpus.
 * Returns the store and embed function.
 */
async function getDefaultStore() {
  if (_defaultStore) return { store: _defaultStore, embedFn: _defaultEmbed };

  const { createStore } = await import('./store.mjs');
  const { embed }       = await import('./embed.mjs');
  const { ingestDir }   = await import('./ingest.mjs');

  const store = createStore();
  await ingestDir(CORPUS_DIR, store, embed);

  _defaultStore = store;
  _defaultEmbed = embed;
  return { store, embedFn: embed };
}

/**
 * Retrieve the k most relevant chunks for a natural-language query.
 *
 * @param {string} query
 * @param {number} [k=4]
 * @param {{ store?: object, embedFn?: Function }} [opts]
 * @returns {Promise<Array<{text: string, source: string, heading: string, score: number, date: string}>>}
 */
export async function retrieve(query, k = 4, opts = {}) {
  let { store, embedFn } = opts;

  if (!store || !embedFn) {
    const defaults = await getDefaultStore();
    store   = store   ?? defaults.store;
    embedFn = embedFn ?? defaults.embedFn;
  }

  const queryVector = await Promise.resolve(embedFn(query));
  const hits = store.search(queryVector, k);

  return hits.map(hit => ({
    text:    hit.meta.text    ?? '',
    source:  hit.meta.source  ?? '',
    heading: hit.meta.heading ?? '',
    score:   hit.score,
    date:    hit.meta.date    ?? '',
  }));
}
