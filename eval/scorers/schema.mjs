/**
 * eval/scorers/schema.mjs — Schema-validity scorer: thin pass-through wrapper
 * around the canonical findings.json contract validator.
 *
 * No npm dependencies — pure Node.js.
 */

import { validateFindings } from '../../lib/findings-schema.mjs';

/**
 * Score whether `findings` conforms to the findings.json schema.
 *
 * @param {unknown} findings — parsed findings.json (or candidate object)
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function scoreSchema(findings) {
  return validateFindings(findings);
}
