/**
 * eval/scorers/stability.mjs — pass^k stability scorer: how consistently does
 * the interpret step reach full recall (and per-anchor coverage) across
 * repeated runs of the same fixture?
 *
 * No npm dependencies — pure Node.js.
 */

/**
 * Score pass^k stability across repeated-run recall values.
 *
 * @param {number[]} perRunRecall — recall score (0..1) for each repeated run
 * @returns {{ k: number, passK: number|null, recallMin: number|null, recallMean: number|null, recallMax: number|null }}
 */
export function scoreStability(perRunRecall) {
  const runs = Array.isArray(perRunRecall) ? perRunRecall : [];
  const k = runs.length;
  if (k === 0) {
    return { k: 0, passK: null, recallMin: null, recallMean: null, recallMax: null };
  }

  const fullPasses = runs.filter(r => r === 1).length;
  const passK = fullPasses / k;
  const recallMin = Math.min(...runs);
  const recallMax = Math.max(...runs);
  const recallMean = runs.reduce((sum, r) => sum + r, 0) / k;

  return { k, passK, recallMin, recallMean, recallMax };
}

/**
 * Score per-anchor coverage fraction across repeated runs: for each
 * must-contain rule id, what fraction of the runs' covered-rule-id lists
 * include it?
 *
 * @param {string[][]} runsCovered — per-run list of covered rule ids
 * @param {string[]} mustContainIds — the anchor rule ids to score
 * @returns {{ ruleId: string, coveredFraction: number }[]} sorted by ruleId
 */
export function anchorStability(runsCovered, mustContainIds) {
  const runs = Array.isArray(runsCovered) ? runsCovered : [];
  const anchors = Array.isArray(mustContainIds) ? mustContainIds : [];
  const totalRuns = runs.length;

  const result = anchors.map(ruleId => {
    const coveredCount = runs.filter(covered => Array.isArray(covered) && covered.includes(ruleId)).length;
    const coveredFraction = totalRuns === 0 ? 0 : coveredCount / totalRuns;
    return { ruleId, coveredFraction };
  });

  result.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  return result;
}
