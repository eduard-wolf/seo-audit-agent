/**
 * eval/schema/expected-schema.mjs — Contract validator for expected-findings.json
 * (the eval-harness fixture-expectation file: which ruleIds a fixture must / must
 * not surface). Mirrors the collect-all-errors style of lib/findings-schema.mjs.
 *
 * No npm dependencies — pure Node.js.
 */

/**
 * Validate an expected-findings object against the required schema.
 * Collects ALL errors before returning.
 *
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateExpected(obj) {
  const errors = [];

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    errors.push('Root must be a non-null, non-array object');
    return { valid: false, errors };
  }

  // ── fixture ───────────────────────────────────────────────────────────────
  if (!('fixture' in obj)) {
    errors.push('Missing required field "fixture"');
  } else if (typeof obj.fixture !== 'string') {
    errors.push(`"fixture" must be a string (got ${typeof obj.fixture})`);
  }

  // ── mustContain ───────────────────────────────────────────────────────────
  if (!('mustContain' in obj)) {
    errors.push('Missing required field "mustContain"');
  } else if (!Array.isArray(obj.mustContain)) {
    errors.push(`"mustContain" must be an array (got ${typeof obj.mustContain})`);
  } else {
    obj.mustContain.forEach((entry, i) => {
      const path = `mustContain[${i}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (!('ruleId' in entry)) {
        errors.push(`${path}: missing required field "ruleId"`);
      } else if (typeof entry.ruleId !== 'string') {
        errors.push(`${path}.ruleId must be a string (got ${typeof entry.ruleId})`);
      }
      if ('urlAnchor' in entry && typeof entry.urlAnchor !== 'string') {
        errors.push(`${path}.urlAnchor must be a string (got ${typeof entry.urlAnchor})`);
      }
      if ('note' in entry && typeof entry.note !== 'string') {
        errors.push(`${path}.note must be a string (got ${typeof entry.note})`);
      }
    });
  }

  // ── mustNotContain ────────────────────────────────────────────────────────
  if (!('mustNotContain' in obj)) {
    errors.push('Missing required field "mustNotContain"');
  } else if (!Array.isArray(obj.mustNotContain)) {
    errors.push(`"mustNotContain" must be an array (got ${typeof obj.mustNotContain})`);
  } else {
    obj.mustNotContain.forEach((entry, i) => {
      const path = `mustNotContain[${i}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (!('ruleId' in entry)) {
        errors.push(`${path}: missing required field "ruleId"`);
      } else if (typeof entry.ruleId !== 'string') {
        errors.push(`${path}.ruleId must be a string (got ${typeof entry.ruleId})`);
      }
      if ('reason' in entry && typeof entry.reason !== 'string') {
        errors.push(`${path}.reason must be a string (got ${typeof entry.reason})`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}
