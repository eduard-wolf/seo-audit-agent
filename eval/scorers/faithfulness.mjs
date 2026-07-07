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
 * The headline `passRate` is the STRICT faithfulness rate: the fraction of
 * findings the judge scored `verdict === 'pass'`, i.e. all three axes satisfied
 * (supported AND provenanceCorrect AND no fabricatedNumbers — see
 * eval/judge/RUBRIC.md). `supported` / `provenanceIssues` / `fabricatedNumbers`
 * are retained as separate diagnostic counts; a `warn` (supported but
 * provenance-imprecise) or `fail` verdict does NOT count toward `passRate`.
 *
 * @param {{ verdicts: { supported: boolean, provenanceCorrect: boolean, fabricatedNumbers: boolean, verdict: string }[] }[]} runVerdicts
 *   — array of per-run verdict objects (each shaped like a parsed judge-verdict file)
 * @returns {{ total: number, passed: number, warned: number, failed: number, passRate: number|null, supported: number, unsupported: number, fabricatedNumbers: number, provenanceIssues: number }}
 */
export function scoreFaithfulness(runVerdicts) {
  const runs = Array.isArray(runVerdicts) ? runVerdicts : [];
  const verdicts = [];
  for (const run of runs) {
    if (run && Array.isArray(run.verdicts)) verdicts.push(...run.verdicts);
  }

  const total = verdicts.length;
  const passed = verdicts.filter(v => v && v.verdict === 'pass').length;
  const warned = verdicts.filter(v => v && v.verdict === 'warn').length;
  const failed = verdicts.filter(v => v && v.verdict === 'fail').length;
  const supported = verdicts.filter(v => v && v.supported === true).length;
  const unsupported = verdicts.filter(v => v && v.supported === false).length;
  const fabricatedNumbers = verdicts.filter(v => v && v.fabricatedNumbers === true).length;
  const provenanceIssues = verdicts.filter(v => v && v.provenanceCorrect === false).length;
  const passRate = total === 0 ? null : passed / total;

  return { total, passed, warned, failed, passRate, supported, unsupported, fabricatedNumbers, provenanceIssues };
}
