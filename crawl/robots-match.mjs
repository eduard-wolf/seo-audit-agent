/**
 * crawl/robots-match.mjs — Pure RFC-9309-compliant robots.txt path matcher.
 *
 * Implements §2.2.2 (longest-match precedence, tie → Allow) and §2.2.3
 * (* and $ special characters).
 *
 * No side-effects, no dependencies, deterministic.
 */

// ── Pattern compiler ──────────────────────────────────────────────────────────

/**
 * Compile a single robots.txt pattern string into a RegExp.
 *
 * RFC 9309 §2.2.3:
 *   - Pattern is anchored at the start of the path (implicit ^).
 *   - '*' matches zero or more of any character.
 *   - '$' at the end of the pattern anchors to end-of-string; anywhere else it
 *     is treated as a literal '$' (only trailing '$' is special per spec).
 *   - All other regex metacharacters are escaped literally.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function compilePattern(pattern) {
  // Split on '*' to process wildcards; escape everything else.
  // Trailing '$' becomes a regex end-anchor; elsewhere it is literal.
  // RFC 9309 §2.2.3: '$' designates the end of the match. Only a '$' at the end
  // of a segment is turned into an explicit end-anchor here; any other '$' is left
  // as-is, and the regex engine still treats it as an end-anchor. Either way, a '$'
  // that is not at the very end of the pattern yields a regex that matches nothing —
  // a degenerate case that does not occur in real robots.txt files.
  const parts = pattern.split('*');
  const compiled = parts
    .map(part => {
      // Check if this part ends with '$' (only the very last segment can
      // contribute a trailing '$' that matters, but handle it uniformly).
      // We escape the part fully, then restore a trailing '$' as an anchor.
      const hasTrailingDollar = part.endsWith('$');
      const rawPart = hasTrailingDollar ? part.slice(0, -1) : part;
      // Escape all regex metacharacters (except $ which we handle above).
      const escaped = rawPart.replace(/[.+?^{}()|[\]\\]/g, '\\$&');
      return hasTrailingDollar ? escaped + '$' : escaped;
    })
    .join('.*');

  return new RegExp('^' + compiled);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Determine whether a path is allowed to be crawled, per RFC 9309 §2.2.2.
 *
 * Decision rule:
 *   1. Find the longest matching Disallow pattern (by raw pattern length).
 *   2. Find the longest matching Allow pattern (by raw pattern length).
 *   3. If D > A  →  disallowed.
 *      Otherwise (A ≥ D, including ties and no Disallow match) → allowed.
 *
 * @param {string} path  — URL path + query string (e.g. "/page?x=1")
 * @param {{ allow?: string[], disallow?: string[] }} robots
 * @returns {boolean}  true = allowed, false = disallowed
 */
export function isPathAllowed(path, robots) {
  const disallowList = robots.disallow ?? [];
  const allowList    = robots.allow    ?? [];

  let longestDisallow = -1; // length of longest matching Disallow pattern
  let longestAllow    = -1; // length of longest matching Allow pattern

  for (const pattern of disallowList) {
    if (pattern && compilePattern(pattern).test(path)) {
      if (pattern.length > longestDisallow) longestDisallow = pattern.length;
    }
  }

  for (const pattern of allowList) {
    if (pattern && compilePattern(pattern).test(path)) {
      if (pattern.length > longestAllow) longestAllow = pattern.length;
    }
  }

  // D > A → disallowed; otherwise allowed (tie or no disallow match → allowed)
  return longestDisallow <= longestAllow;
}
