/**
 * eval/scorers/recall.mjs — Coverage-recall scorer: did the produced findings
 * cover every rule id an eval fixture's `expected.mustContain` anchors demand?
 *
 * No npm dependencies — pure Node.js.
 */

import { producedRuleIds } from '../lib/ruleids.mjs';

/**
 * Score how many of `expected.mustContain[].ruleId` anchors are covered by
 * the rule ids actually produced in `findings`.
 *
 * @param {object} findings — parsed findings.json
 * @param {{ mustContain: { ruleId: string }[] }} expected — parsed expected fixture
 * @returns {{ recall: number, total: number, covered: string[], missed: string[] }}
 */
export function scoreRecall(findings, expected) {
  const produced = new Set(producedRuleIds(findings));
  const anchors = (expected && Array.isArray(expected.mustContain)) ? expected.mustContain : [];
  const total = anchors.length;

  const covered = [];
  const missed = [];
  for (const { ruleId } of anchors) {
    if (produced.has(ruleId)) covered.push(ruleId);
    else missed.push(ruleId);
  }
  covered.sort();
  missed.sort();

  const recall = total === 0 ? 1 : covered.length / total;
  return { recall, total, covered, missed };
}
