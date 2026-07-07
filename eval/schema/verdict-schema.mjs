/**
 * eval/schema/verdict-schema.mjs — Contract validator for judge-verdict files
 * (the eval-harness LLM-judge output: per-finding pass/fail/warn verdicts with
 * rationale). Mirrors the collect-all-errors style of lib/findings-schema.mjs.
 *
 * No npm dependencies — pure Node.js.
 */

const VERDICT_VALUES = new Set(['pass', 'fail', 'warn']);

/**
 * Validate a judge-verdict object against the required schema.
 * Collects ALL errors before returning.
 *
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateVerdicts(obj) {
  const errors = [];

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    errors.push('Root must be a non-null, non-array object');
    return { valid: false, errors };
  }

  // ── top-level scalar fields ──────────────────────────────────────────────
  const requiredStringFields = ['fixture', 'judgeModel', 'promptVersion'];
  for (const k of requiredStringFields) {
    if (!(k in obj)) {
      errors.push(`Missing required field "${k}"`);
    } else if (typeof obj[k] !== 'string') {
      errors.push(`"${k}" must be a string (got ${typeof obj[k]})`);
    }
  }

  if (!('run' in obj)) {
    errors.push('Missing required field "run"');
  } else if (typeof obj.run !== 'number') {
    errors.push(`"run" must be a number (got ${typeof obj.run})`);
  }

  // ── verdicts ──────────────────────────────────────────────────────────────
  if (!('verdicts' in obj)) {
    errors.push('Missing required field "verdicts"');
  } else if (!Array.isArray(obj.verdicts)) {
    errors.push(`"verdicts" must be an array (got ${typeof obj.verdicts})`);
  } else {
    obj.verdicts.forEach((entry, i) => {
      const path = `verdicts[${i}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`${path} must be an object`);
        return;
      }

      for (const k of ['findingId', 'rationale']) {
        if (!(k in entry)) {
          errors.push(`${path}: missing required field "${k}"`);
        } else if (typeof entry[k] !== 'string') {
          errors.push(`${path}.${k} must be a string (got ${typeof entry[k]})`);
        }
      }

      for (const k of ['supported', 'provenanceCorrect', 'fabricatedNumbers']) {
        if (!(k in entry)) {
          errors.push(`${path}: missing required field "${k}"`);
        } else if (typeof entry[k] !== 'boolean') {
          errors.push(`${path}.${k} must be a boolean (got ${typeof entry[k]})`);
        }
      }

      if (!('verdict' in entry)) {
        errors.push(`${path}: missing required field "verdict"`);
      } else if (!VERDICT_VALUES.has(entry.verdict)) {
        errors.push(`${path}.verdict must be one of ${[...VERDICT_VALUES].join('|')} (got "${entry.verdict}")`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}
