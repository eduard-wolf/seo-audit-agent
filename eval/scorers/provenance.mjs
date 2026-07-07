/**
 * eval/scorers/provenance.mjs — Provenance / anti-overclaim invariant scorer:
 * checks a findings.json object for internally-consistent `prov`/`severity`
 * enums, exact ICE score arithmetic, and the sub-minimum-sample confidence
 * cap (skills/interpret.md §"Anti-overclaim") that limits every finding's
 * Confidence anchor to `c <= 1` whenever `confidence.minNMet === false`.
 *
 * No npm dependencies — pure Node.js.
 */

const PROV_VALUES = new Set(['gemessen', 'beobachtet', 'geschätzt']);
const SEVERITY_VALUES = new Set(['hoch', 'mittel', 'niedrig']);

/**
 * Flatten every `sections[].findings[]` entry into a single list.
 *
 * @param {object} findings — parsed findings.json
 * @returns {object[]}
 */
function allFindings(findings) {
  const sections = (findings && Array.isArray(findings.sections)) ? findings.sections : [];
  const out = [];
  for (const section of sections) {
    const sectionFindings = (section && Array.isArray(section.findings)) ? section.findings : [];
    for (const finding of sectionFindings) out.push(finding);
  }
  return out;
}

/**
 * Score a findings.json object against the provenance / anti-overclaim
 * invariants.
 *
 * @param {object} findings — parsed findings.json
 * @returns {{ checks: { provEnumOk: boolean, severityEnumOk: boolean, iceScoreConsistent: boolean, minNMetConsistent: boolean, sampleSizeMatch: boolean, cCapOk: boolean }, issues: string[] }}
 */
export function scoreProvenance(findings) {
  const items = allFindings(findings);
  const meta = (findings && findings.meta) || {};
  const confidence = (findings && findings.confidence) || {};

  const provEnumOk = items.every(f => PROV_VALUES.has(f && f.prov));
  const severityEnumOk = items.every(f => SEVERITY_VALUES.has(f && f.severity));
  const iceScoreConsistent = items.every(f => {
    const ice = f && f.ice;
    return !!ice && ice.score === ice.i * ice.c * ice.e;
  });
  const minNMetConsistent = confidence.minNMet === (confidence.sampleSize >= 5);
  const sampleSizeMatch = meta.sampleSize === confidence.sampleSize;
  const cCapOk = confidence.minNMet === false
    ? items.every(f => f && f.ice && f.ice.c <= 1)
    : true;

  const checks = { provEnumOk, severityEnumOk, iceScoreConsistent, minNMetConsistent, sampleSizeMatch, cCapOk };

  const issues = [];
  if (!provEnumOk) issues.push('one or more findings have a "prov" value outside {gemessen, beobachtet, geschätzt}');
  if (!severityEnumOk) issues.push('one or more findings have a "severity" value outside {hoch, mittel, niedrig}');
  if (!iceScoreConsistent) issues.push('one or more findings have ice.score !== ice.i * ice.c * ice.e');
  if (!minNMetConsistent) issues.push('confidence.minNMet does not equal (confidence.sampleSize >= 5)');
  if (!sampleSizeMatch) issues.push('meta.sampleSize does not equal confidence.sampleSize');
  if (!cCapOk) issues.push('confidence.minNMet is false but one or more findings have ice.c > 1 (anti-overclaim cap violated)');

  return { checks, issues };
}
