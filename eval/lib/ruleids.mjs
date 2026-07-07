/**
 * eval/lib/ruleids.mjs — ruleId extraction helpers shared by eval scorers.
 *
 * No npm dependencies — pure Node.js.
 */

// Mirrors the convention in bin/handoff.mjs::extractInterpretedRuleIds exactly,
// so producedRuleIds() is a drop-in parity check against the canonical extractor.
const CLAUSE_RE = /ruleId=([^;]*)/g;          // clause body up to next ';' or end
const ID_RE = /[a-z][a-z0-9]*:[a-z0-9:_-]+/g; // namespace:id shaped token

/**
 * Extract the rule ids a single finding covers.
 *
 * First-class `finding.ruleIds` (array) is authoritative when present. Otherwise,
 * scrape `ruleId=` clauses out of `finding.beleg` free text, collecting every
 * `namespace:id`-shaped token inside each clause (folded lists like
 * `ruleId=a:1 + a:2` yield both ids).
 *
 * @param {object} finding
 * @returns {string[]} sorted, de-duplicated rule ids
 */
export function findingRuleIds(finding) {
  const ids = new Set();
  if (finding && Array.isArray(finding.ruleIds)) {
    for (const r of finding.ruleIds) if (typeof r === 'string' && r) ids.add(r);
    return [...ids].sort();
  }
  const beleg = finding && typeof finding.beleg === 'string' ? finding.beleg : '';
  let clause;
  CLAUSE_RE.lastIndex = 0;
  while ((clause = CLAUSE_RE.exec(beleg)) !== null) {
    const body = clause[1];
    let m;
    ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(body)) !== null) ids.add(m[0]);
  }
  return [...ids].sort();
}

/**
 * Union of findingRuleIds() over every finding in every section of a
 * findings.json object. Returns [] if the shape is invalid.
 *
 * @param {object} findings — parsed findings.json
 * @returns {string[]} sorted, de-duplicated rule ids
 */
export function producedRuleIds(findings) {
  const ids = new Set();
  if (!findings || !Array.isArray(findings.sections)) return [];
  for (const section of findings.sections) {
    if (!section || !Array.isArray(section.findings)) continue;
    for (const f of section.findings) {
      for (const id of findingRuleIds(f)) ids.add(id);
    }
  }
  return [...ids].sort();
}

/**
 * Sorted, de-duplicated rule ids referenced by analysis.findings[].
 *
 * @param {object} analysis — parsed analysis.json
 * @returns {string[]}
 */
export function analysisRuleIds(analysis) {
  const ids = Array.isArray(analysis && analysis.findings)
    ? analysis.findings.map(f => f && f.ruleId).filter(Boolean)
    : [];
  return [...new Set(ids)].sort();
}

/**
 * Sorted, de-duplicated rule ids referenced by analysis.positives[].
 *
 * @param {object} analysis — parsed analysis.json
 * @returns {string[]}
 */
export function positiveRuleIds(analysis) {
  const ids = Array.isArray(analysis && analysis.positives)
    ? analysis.positives.map(f => f && f.ruleId).filter(Boolean)
    : [];
  return [...new Set(ids)].sort();
}
