/**
 * eval/lib/kb-citations.mjs — Citation allowlist built from kb/corpus/ front-matter.
 *
 * No npm dependencies — pure Node.js.
 */

import fs from 'node:fs';

const DEFAULT_CORPUS_DIR = new URL('../../kb/corpus/', import.meta.url);
const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---/;
const SOURCE_LINE_RE = /^source:\s*(.+)$/m;

/**
 * Build the set of valid citation targets from the KB corpus front-matter.
 * Each `*.md` file's `source:` line (inside the leading `---`…`---` block)
 * contributes its trimmed value to `urls`; the file's own basename is added
 * to `basenames` so citing the corpus file directly is also valid.
 *
 * @param {string|URL} [corpusDir] — defaults to kb/corpus/ relative to this module
 * @returns {{ urls: Set<string>, basenames: Set<string> }}
 */
export function buildCitationAllowlist(corpusDir = DEFAULT_CORPUS_DIR) {
  const urls = new Set();
  const basenames = new Set();
  const dir = corpusDir instanceof URL ? corpusDir : new URL(corpusDir);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const text = fs.readFileSync(new URL(file, dir), 'utf8');
    const fmMatch = FRONT_MATTER_RE.exec(text);
    if (!fmMatch) continue;
    const srcMatch = SOURCE_LINE_RE.exec(fmMatch[1]);
    if (!srcMatch) continue;
    urls.add(srcMatch[1].trim());
    basenames.add(file);
  }
  return { urls, basenames };
}

/**
 * Normalize a citation value for comparison against the allowlist.
 *
 * @param {unknown} source
 * @returns {string}
 */
export function normalizeCitation(source) {
  return String(source).trim();
}

/**
 * Check whether a citation is a real KB corpus reference (URL or basename).
 *
 * @param {unknown} source
 * @param {{ urls: Set<string>, basenames: Set<string> }} allowlist
 * @returns {boolean}
 */
export function isValidCitation(source, allowlist) {
  const norm = normalizeCitation(source);
  return allowlist.urls.has(norm) || allowlist.basenames.has(norm);
}
