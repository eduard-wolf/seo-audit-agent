/**
 * eval/scorers/citation.mjs — Citation-validity scorer: are every finding's
 * `kbSources[]` real KB corpus references, or fabricated?
 *
 * No npm dependencies — pure Node.js.
 */

import { isValidCitation } from '../lib/kb-citations.mjs';
import { allFindings } from '../lib/ruleids.mjs';

/**
 * Score citation validity across every `sections[].findings[].kbSources[]`
 * entry in `findings` against the given allowlist.
 *
 * @param {object} findings — parsed findings.json
 * @param {{ urls: Set<string>, basenames: Set<string> }} allowlist — from buildCitationAllowlist()
 * @returns {{ total: number, valid: number, validity: number, invalid: { findingId: string, source: string }[] }}
 */
export function scoreCitations(findings, allowlist) {
  let total = 0;
  let valid = 0;
  const invalid = [];

  for (const finding of allFindings(findings)) {
    const kbSources = (finding && Array.isArray(finding.kbSources)) ? finding.kbSources : [];
    for (const kbSource of kbSources) {
      total++;
      const source = kbSource && kbSource.source;
      if (isValidCitation(source, allowlist)) {
        valid++;
      } else {
        invalid.push({ findingId: finding.id, source });
      }
    }
  }

  // Sort by findingId, then source (same explicit two-step form as fabrication.mjs).
  invalid.sort((a, b) => {
    if (a.findingId !== b.findingId) return a.findingId < b.findingId ? -1 : 1;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return 0;
  });

  const validity = total === 0 ? 1 : valid / total;
  return { total, valid, validity, invalid };
}
