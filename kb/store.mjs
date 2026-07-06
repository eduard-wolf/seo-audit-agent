/**
 * kb/store.mjs — In-memory cosine-similarity vector store.
 *
 * Interface (mirrors pgvector_store.py at the logical level):
 *   const store = createStore()
 *   store.add(id, vector, meta)
 *   store.search(vector, k) → [{id, score, meta}]
 *
 * All operations are synchronous and O(n) — suitable for the small offline
 * corpus (< 200 chunks). For production scale use kb/pgvector_store.py.
 */

/**
 * Cosine similarity between two equal-length numeric arrays.
 * Returns 0 if either vector is the zero vector.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosine(a, b) {
  // Dimension mismatch is not comparable — return 0 rather than silently reading
  // past the shorter vector (→ NaN) or comparing a prefix (→ false 1.0). This is
  // the failure mode when swapping embedders without re-embedding the corpus.
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Creates a new in-memory vector store.
 * @returns {{ add: Function, search: Function, size: Function }}
 */
export function createStore() {
  /** @type {Array<{id: string, vector: number[], meta: object}>} */
  const entries = [];

  return {
    /**
     * Add a document chunk to the store.
     * @param {string}   id      Unique identifier (e.g. "file.md#0")
     * @param {number[]} vector  Embedding vector
     * @param {object}   meta    Arbitrary metadata (source, heading, date, …)
     */
    add(id, vector, meta = {}) {
      entries.push({ id, vector, meta });
    },

    /**
     * Find the k nearest entries by cosine similarity.
     * @param {number[]} vector  Query embedding
     * @param {number}   k       Max results to return
     * @returns {Array<{id: string, score: number, meta: object}>}
     */
    search(vector, k = 4) {
      return entries
        .map(e => ({ id: e.id, score: cosine(vector, e.vector), meta: e.meta }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },

    /** Number of stored entries. */
    size() {
      return entries.length;
    },
  };
}
