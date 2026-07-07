/**
 * eval/scorers/fabrication.mjs — Structural no-fabrication / precision scorer:
 * flags, per finding and per cited rule id, whether that rule id is a pure
 * invention (absent from analysis.json entirely), an overclaim (the rule
 * actually passed — it lives in analysis.positives, not analysis.findings),
 * or an explicit must-not-contain trap the fixture author planted.
 *
 * `must-not-contain` and `on-positive` are independent, additive signals — a
 * ruleId can trip both at once (one item per tripped kind). `not-in-analysis`
 * is the residual fallback: it only fires when neither of the more specific
 * signals already explains the ruleId's absence from analysis.findings.
 *
 * No npm dependencies — pure Node.js.
 */

import { findingRuleIds, analysisRuleIds, positiveRuleIds, allFindings } from '../lib/ruleids.mjs';

/**
 * Score structural fabrication/precision violations across every finding's
 * cited rule ids.
 *
 * @param {object} findings — parsed findings.json
 * @param {{ mustNotContain?: { ruleId: string }[] }} expected — parsed expected fixture
 * @param {object} analysis — parsed analysis.json
 * @returns {{ fabrications: number, items: { findingId: string, ruleId: string, kind: string }[] }}
 */
export function scoreFabrication(findings, expected, analysis) {
  const analysisIds = new Set(analysisRuleIds(analysis));
  const positiveIds = new Set(positiveRuleIds(analysis));
  const trapIds = new Set(
    (expected && Array.isArray(expected.mustNotContain) ? expected.mustNotContain : [])
      .map(entry => entry && entry.ruleId)
      .filter(Boolean)
  );

  const items = [];
  for (const finding of allFindings(findings)) {
    const findingId = finding && finding.id;
    for (const ruleId of findingRuleIds(finding)) {
      let explained = false;
      if (trapIds.has(ruleId)) {
        items.push({ findingId, ruleId, kind: 'must-not-contain' });
        explained = true;
      }
      if (positiveIds.has(ruleId)) {
        items.push({ findingId, ruleId, kind: 'on-positive' });
        explained = true;
      }
      if (!explained && !analysisIds.has(ruleId)) {
        items.push({ findingId, ruleId, kind: 'not-in-analysis' });
      }
    }
  }

  items.sort((a, b) => {
    if (a.findingId !== b.findingId) return a.findingId < b.findingId ? -1 : 1;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return 0;
  });

  return { fabrications: items.length, items };
}
