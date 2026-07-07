/**
 * eval/scorers/citation.mjs — Citation-validity scorer: are every finding's
 * `kbSources[]` real KB corpus references, or fabricated?
 *
 * No npm dependencies — pure Node.js.
 */

import { isValidCitation } from '../lib/kb-citations.mjs';

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

  const sections = (findings && Array.isArray(findings.sections)) ? findings.sections : [];
  for (const section of sections) {
    const sectionFindings = (section && Array.isArray(section.findings)) ? section.findings : [];
    for (const finding of sectionFindings) {
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
  }

  invalid.sort((a, b) => (a.findingId === b.findingId ? (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) : (a.findingId < b.findingId ? -1 : 1)));

  const validity = total === 0 ? 1 : valid / total;
  return { total, valid, validity, invalid };
}
