/**
 * kb/chunk.mjs — Markdown chunker.
 *
 * chunkMarkdown(text, opts?) → [{text: string, heading: string}]
 *
 * Strategy:
 *  - Split the document at every ATX heading (# … through ###### …).
 *  - Each heading starts a new chunk; the text between this heading and the
 *    next becomes the chunk body.
 *  - YAML front-matter (--- … ---) is stripped before chunking.
 *  - opts.overlapChars (default 0): carry over the last N characters of the
 *    previous chunk's text into the start of the next chunk (improves
 *    retrieval continuity).
 *
 * Edge cases:
 *  - Text before the first heading becomes a chunk with heading ''.
 *  - Documents with no headings return a single chunk with heading ''.
 */

const FRONTMATTER_RE = /^---[\s\S]*?---\s*/;
const HEADING_RE     = /^(#{1,6})\s+(.+)$/m;

/**
 * @param {string} text
 * @param {{ overlapChars?: number }} [opts]
 * @returns {Array<{text: string, heading: string}>}
 */
export function chunkMarkdown(text, opts = {}) {
  const overlapChars = opts.overlapChars ?? 0;

  // Strip YAML front-matter
  const body = text.replace(FRONTMATTER_RE, '');

  // Split at ATX headings that are NOT inside a fenced code block, so a `# ` line
  // inside a ``` / ~~~ fence (e.g. a shell comment) does not shatter the block
  // into mis-headed chunks. (Fence-free documents split identically to before.)
  const parts = [];
  let cur = '';
  let inFence = false;
  let fenceChar = '';
  for (const line of body.split('\n')) {
    const fm = line.match(/^\s*(```+|~~~+)/);
    if (fm) {
      if (!inFence) { inFence = true; fenceChar = fm[1][0]; }
      else if (line.trimStart().startsWith(fenceChar)) { inFence = false; }
    }
    if (!inFence && /^#{1,6} /.test(line) && cur !== '') {
      parts.push(cur);
      cur = line + '\n';
    } else {
      cur += line + '\n';
    }
  }
  if (cur !== '') parts.push(cur);

  const raw = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const heading = match[2].trim();
      const content = trimmed.slice(match[0].length).trim();
      raw.push({ heading, text: content });
    } else {
      // Text before any heading
      raw.push({ heading: '', text: trimmed });
    }
  }

  // If nothing was produced, return the whole body as one chunk
  if (raw.length === 0) {
    return [{ heading: '', text: body.trim() }];
  }

  // Apply overlap: prepend tail of previous chunk to the current one
  if (overlapChars > 0) {
    for (let i = 1; i < raw.length; i++) {
      const prev = raw[i - 1].text;
      const tail = prev.slice(-overlapChars);
      if (tail) {
        raw[i] = { ...raw[i], text: tail + '\n' + raw[i].text };
      }
    }
  }

  return raw;
}
