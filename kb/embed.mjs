/**
 * kb/embed.mjs — Text → embedding vector.
 *
 * Default (offline): deterministic token-frequency hash-trick vector (256 dims).
 * Runtime: pass opts.provider to route to a real embedding API.
 *
 * The local fallback:
 *  1. Tokenise text (lowercase alphanum).
 *  2. For each token compute a djb2 hash.
 *  3. Scatter token weight into two buckets of a 256-dim float array.
 *  4. L2-normalise the result.
 *
 * This means: texts that share tokens share bucket contributions, so cosine
 * similarity is meaningfully correlated with lexical overlap — good enough to
 * ground the RAG retrieval for testing without any API call.
 *
 * Runtime provider contract (not tested in this offline build):
 *   opts.provider = async (text) => number[]   // must return length-256+ vector
 */

const DIM = 256;

/**
 * djb2 hash — returns a 32-bit unsigned integer.
 * @param {string} str
 * @returns {number}
 */
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h, 33) ^ str.charCodeAt(i);
  }
  return h >>> 0; // unsigned 32-bit
}

/**
 * Deterministic local embedding: token-frequency hash-trick.
 * @param {string} text
 * @returns {number[]}  Always length DIM, L2-normalised.
 */
function localEmbed(text) {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const vec = new Float64Array(DIM);

  for (const token of tokens) {
    const h = djb2(token);
    // Primary bucket: full hash mod DIM
    const i1 = h % DIM;
    // Secondary bucket: upper 8 bits — adds sub-token discrimination
    const i2 = ((h >>> 8) & 0xff) % DIM;
    vec[i1] += 1.0;
    vec[i2] += 0.5;
  }

  // L2 normalise
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return Array.from(vec); // all-zero for empty input

  return Array.from(vec, v => v / norm);
}

/**
 * embed(text, opts?) → Promise<number[]>
 *
 * @param {string}  text
 * @param {{provider?: (text: string) => Promise<number[]>}} [opts]
 * @returns {Promise<number[]>}
 */
export async function embed(text, opts = {}) {
  if (opts.provider) {
    return opts.provider(text);
  }
  return localEmbed(text);
}
