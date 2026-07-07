/**
 * eval/scorers/faithfulness.mjs — Judge-verdict reader: aggregates already-
 * committed LLM-judge verdict files (see eval/schema/verdict-schema.mjs) into
 * summary faithfulness statistics.
 *
 * This scorer reads only committed data — it never calls a model itself.
 *
 * No npm dependencies — pure Node.js.
 */

/**
 * Aggregate judge verdicts across one or more runs into summary statistics.
 *
 * @param {{ verdicts: { supported: boolean, provenanceCorrect: boolean, fabricatedNumbers: boolean }[] }[]} runVerdicts
 *   — array of per-run verdict objects (each shaped like a parsed judge-verdict file)
 * @returns {{ total: number, supported: number, passRate: number|null, unsupported: number, fabricatedNumbers: number, provenanceIssues: number }}
 */
export function scoreFaithfulness(runVerdicts) {
  const runs = Array.isArray(runVerdicts) ? runVerdicts : [];
  const verdicts = [];
  for (const run of runs) {
    if (run && Array.isArray(run.verdicts)) verdicts.push(...run.verdicts);
  }

  const total = verdicts.length;
  const supported = verdicts.filter(v => v && v.supported === true).length;
  const unsupported = verdicts.filter(v => v && v.supported === false).length;
  const fabricatedNumbers = verdicts.filter(v => v && v.fabricatedNumbers === true).length;
  const provenanceIssues = verdicts.filter(v => v && v.provenanceCorrect === false).length;
  const passRate = total === 0 ? null : supported / total;

  return { total, supported, passRate, unsupported, fabricatedNumbers, provenanceIssues };
}
