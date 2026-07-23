/**
 * lib/findings-schema.mjs — Contract validator for findings.json (Layer 3 ↔ 5).
 *
 * No npm dependencies — pure Node.js.
 */

const SEVERITY_VALUES = new Set(['hoch', 'mittel', 'niedrig']);
const PROV_VALUES = new Set(['gemessen', 'beobachtet', 'geschätzt']);

/**
 * Validate a findings object against the required schema.
 * Collects ALL errors before returning.
 *
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateFindings(obj) {
  const errors = [];

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    errors.push('Root must be a non-null object');
    return { valid: false, errors };
  }

  // ── Top-level keys ────────────────────────────────────────────────────────
  const requiredTopKeys = ['meta', 'execSummary', 'sections', 'positives', 'strategy', 'confidence'];
  for (const key of requiredTopKeys) {
    if (!(key in obj)) {
      errors.push(`Missing required top-level key: "${key}"`);
    }
  }

  // ── meta ──────────────────────────────────────────────────────────────────
  if ('meta' in obj) {
    const meta = obj.meta;
    if (typeof meta !== 'object' || meta === null) {
      errors.push('"meta" must be an object');
    } else {
      for (const k of ['url', 'crawledAt', 'modelId', 'rulesetVersion', 'sampleSize', 'coveragePct', 'siteType']) {
        if (!(k in meta)) errors.push(`meta: missing required field "${k}"`);
      }
      // Typ-Checks: String-Felder
      for (const k of ['url', 'modelId', 'rulesetVersion', 'siteType']) {
        if (k in meta && typeof meta[k] !== 'string') {
          errors.push(`meta.${k} must be a string (got ${typeof meta[k]})`);
        }
      }
      // crawledAt: string oder null (ehrlicher Null-Fallback erlaubt)
      if ('crawledAt' in meta && meta.crawledAt !== null && typeof meta.crawledAt !== 'string') {
        errors.push(`meta.crawledAt must be a string or null (got ${typeof meta.crawledAt})`);
      }
      // coveragePct: number oder null (ehrlicher Null-Fallback erlaubt)
      if ('coveragePct' in meta && meta.coveragePct !== null && typeof meta.coveragePct !== 'number') {
        errors.push(`meta.coveragePct must be a number or null (got ${typeof meta.coveragePct})`);
      }
      // sampleSize: number
      if ('sampleSize' in meta && typeof meta.sampleSize !== 'number') {
        errors.push(`meta.sampleSize must be a number (got ${typeof meta.sampleSize})`);
      }
    }
  }

  // ── execSummary ───────────────────────────────────────────────────────────
  if ('execSummary' in obj) {
    const es = obj.execSummary;
    if (typeof es !== 'object' || es === null) {
      errors.push('"execSummary" must be an object');
    } else {
      for (const k of ['metrics', 'patterns', 'quickWins']) {
        if (!(k in es)) {
          errors.push(`execSummary: missing required field "${k}"`);
        } else if (!Array.isArray(es[k])) {
          errors.push(`execSummary.${k} must be an array`);
        } else {
          // Typ-Check: Arrayelemente müssen Strings sein
          es[k].forEach((el, ei) => {
            if (typeof el !== 'string') {
              errors.push(`execSummary.${k}[${ei}] must be a string (got ${typeof el})`);
            }
          });
        }
      }
    }
  }

  // Cross-object context for the anti-overclaim ICE cap (§3 of interpret.md):
  // a sub-minimum sample (confidence.minNMet === false) caps every finding's
  // Confidence anchor at c ≤ 1. Read it up-front so per-finding validation can
  // enforce it regardless of key order.
  const minNMetFalse =
    obj.confidence !== null && typeof obj.confidence === 'object' && !Array.isArray(obj.confidence) &&
    obj.confidence.minNMet === false;

  // ── sections ──────────────────────────────────────────────────────────────
  if ('sections' in obj) {
    if (!Array.isArray(obj.sections)) {
      errors.push('"sections" must be an array');
    } else {
      obj.sections.forEach((section, si) => {
        const sp = `sections[${si}]`;
        if (typeof section !== 'object' || section === null) {
          errors.push(`${sp} must be an object`);
          return;
        }
        for (const k of ['id', 'num', 'title', 'findings']) {
          if (!(k in section)) errors.push(`${sp}: missing required field "${k}"`);
        }
        // Typ-Checks: id und title = string, num = number
        for (const k of ['id', 'title']) {
          if (k in section && typeof section[k] !== 'string') {
            errors.push(`${sp}.${k} must be a string (got ${typeof section[k]})`);
          }
        }
        if ('num' in section && typeof section.num !== 'number') {
          errors.push(`${sp}.num must be a number (got ${typeof section.num})`);
        }
        if ('findings' in section) {
          if (!Array.isArray(section.findings)) {
            errors.push(`${sp}.findings must be an array`);
          } else {
            section.findings.forEach((finding, fi) => {
              validateFinding(finding, `${sp}.findings[${fi}]`, errors, { minNMetFalse });
            });
          }
        }
      });
    }
  }

  // ── positives ─────────────────────────────────────────────────────────────
  if ('positives' in obj) {
    if (!Array.isArray(obj.positives)) {
      errors.push('"positives" must be an array');
    } else {
      // Typ-Check: Arrayelemente müssen Strings sein
      obj.positives.forEach((el, ei) => {
        if (typeof el !== 'string') {
          errors.push(`positives[${ei}] must be a string (got ${typeof el})`);
        }
      });
    }
  }

  // ── strategy ──────────────────────────────────────────────────────────────
  if ('strategy' in obj) {
    const s = obj.strategy;
    if (typeof s !== 'object' || s === null) {
      errors.push('"strategy" must be an object');
    } else {
      for (const k of ['levers', 'todos']) {
        if (!(k in s)) {
          errors.push(`strategy: missing required field "${k}"`);
        } else if (!Array.isArray(s[k])) {
          errors.push(`strategy.${k} must be an array`);
        } else {
          // Typ-Check: Arrayelemente müssen Strings sein
          s[k].forEach((el, ei) => {
            if (typeof el !== 'string') {
              errors.push(`strategy.${k}[${ei}] must be a string (got ${typeof el})`);
            }
          });
        }
      }
    }
  }

  // ── confidence ────────────────────────────────────────────────────────────
  if ('confidence' in obj) {
    const c = obj.confidence;
    if (typeof c !== 'object' || c === null) {
      errors.push('"confidence" must be an object');
    } else {
      for (const k of ['sampleSize', 'minNMet', 'caveats']) {
        if (!(k in c)) errors.push(`confidence: missing required field "${k}"`);
      }
      // Typ-Checks
      if ('sampleSize' in c && typeof c.sampleSize !== 'number') {
        errors.push(`confidence.sampleSize must be a number (got ${typeof c.sampleSize})`);
      }
      if ('minNMet' in c && typeof c.minNMet !== 'boolean') {
        errors.push(`confidence.minNMet must be a boolean (got ${typeof c.minNMet})`);
      }
      // minNMet is deterministic — (sampleSize >= 5) in the engine (analyze.mjs / engine.mjs).
      // Reject a self-declared value that disagrees with sampleSize: otherwise a findings.json
      // could claim minNMet=true on a 3-page sample and silently disable the anti-overclaim
      // ICE c<=1 cap below.
      if ('sampleSize' in c && 'minNMet' in c &&
          typeof c.sampleSize === 'number' && typeof c.minNMet === 'boolean' &&
          c.minNMet !== (c.sampleSize >= 5)) {
        errors.push(`confidence.minNMet (${c.minNMet}) must equal (sampleSize >= 5) — the minimum-sample gate is deterministic and must not be self-declared (sampleSize=${c.sampleSize})`);
      }
      if ('caveats' in c && !Array.isArray(c.caveats)) {
        errors.push('confidence.caveats must be an array');
      } else if ('caveats' in c && Array.isArray(c.caveats)) {
        // Typ-Check: Arrayelemente müssen Strings sein
        c.caveats.forEach((el, ei) => {
          if (typeof el !== 'string') {
            errors.push(`confidence.caveats[${ei}] must be a string (got ${typeof el})`);
          }
        });
      }
    }
  }

  // Cross-object: meta.sampleSize and confidence.sampleSize describe the SAME
  // crawl and must agree. Otherwise a findings.json could declare a large
  // confidence.sampleSize (minNMet=true) over a tiny meta.sampleSize and bypass
  // the deterministic anti-overclaim ICE cap (c ≤ 1 on sub-minimum samples).
  if (obj.meta && typeof obj.meta === 'object' && !Array.isArray(obj.meta) &&
      obj.confidence && typeof obj.confidence === 'object' && !Array.isArray(obj.confidence) &&
      typeof obj.meta.sampleSize === 'number' && typeof obj.confidence.sampleSize === 'number' &&
      obj.meta.sampleSize !== obj.confidence.sampleSize) {
    errors.push(
      `meta.sampleSize (${obj.meta.sampleSize}) must equal confidence.sampleSize (${obj.confidence.sampleSize}) — ` +
      `they describe the same crawl; a mismatch would let the anti-overclaim minNMet gate be bypassed`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a single finding object, appending errors to the shared array.
 *
 * @param {unknown} f
 * @param {string} path
 * @param {string[]} errors
 * @param {{ minNMetFalse?: boolean }} [opts] — cross-object context (anti-overclaim cap)
 */
function validateFinding(f, path, errors, opts = {}) {
  if (typeof f !== 'object' || f === null) {
    errors.push(`${path} must be an object`);
    return;
  }

  const requiredFields = [
    'id', 'title', 'category', 'severity', 'prov',
    'befund', 'beleg', 'evidence', 'auswirkung', 'empfehlung', 'ice', 'kbSources',
  ];
  for (const k of requiredFields) {
    if (!(k in f)) errors.push(`${path}: missing required field "${k}"`);
  }

  // Typ-Checks: Freitext-Felder müssen Strings sein
  for (const k of ['id', 'title', 'category', 'befund', 'beleg', 'evidence', 'auswirkung', 'empfehlung']) {
    if (k in f && typeof f[k] !== 'string') {
      errors.push(`${path}.${k} must be a string (got ${typeof f[k]})`);
    }
  }

  if ('severity' in f && !SEVERITY_VALUES.has(f.severity)) {
    errors.push(`${path}.severity must be one of ${[...SEVERITY_VALUES].join('|')} (got "${f.severity}")`);
  }

  if ('prov' in f && !PROV_VALUES.has(f.prov)) {
    errors.push(`${path}.prov must be one of ${[...PROV_VALUES].join('|')} (got "${f.prov}")`);
  }

  // beleg → handoff ledger: a beleg that references the analysis MUST carry a
  // parseable "ruleId=<id>" token so bin/handoff.mjs can derive the progress
  // ledger from the file. Conditional: crawl.csv / signals.json belegs (which do
  // not mention "analysis") are deliberately unaffected.
  if ('beleg' in f && typeof f.beleg === 'string' &&
      /analysis/i.test(f.beleg) && !/ruleId=\S+/.test(f.beleg)) {
    errors.push(`${path}.beleg references the analysis but is missing a parseable "ruleId=<id>" token (required for the handoff ledger)`);
  }

  if ('ice' in f) {
    const ice = f.ice;
    if (typeof ice !== 'object' || ice === null) {
      errors.push(`${path}.ice must be an object`);
    } else {
      for (const k of ['i', 'c', 'e', 'score']) {
        if (!(k in ice)) {
          errors.push(`${path}.ice: missing required field "${k}"`);
        } else if (typeof ice[k] !== 'number') {
          errors.push(`${path}.ice.${k} must be a number (got ${typeof ice[k]})`);
        }
      }
      // Enforce 1–3 anchors for i/c/e
      const ICE_ANCHORS = new Set([1, 2, 3]);
      for (const k of ['i', 'c', 'e']) {
        if (k in ice && typeof ice[k] === 'number' && !ICE_ANCHORS.has(ice[k])) {
          errors.push(`${path}.ice.${k} must be one of 1|2|3 (got ${ice[k]})`);
        }
      }
      // Enforce score = i × c × e
      const allNumeric = ['i', 'c', 'e', 'score'].every(k => k in ice && typeof ice[k] === 'number');
      if (allNumeric) {
        const expected = ice.i * ice.c * ice.e;
        if (ice.score !== expected) {
          errors.push(`${path}.ice.score must equal i×c×e = ${expected} (got ${ice.score})`);
        }
      }
      // Anti-overclaim cap (interpret.md §3): a sub-minimum sample
      // (confidence.minNMet === false) caps every finding's Confidence anchor at
      // c ≤ 1 — a c > 1 on such a sample is an overclaim.
      if (opts.minNMetFalse && typeof ice.c === 'number' && ice.c > 1) {
        errors.push(`${path}.ice.c must be <= 1 when confidence.minNMet === false (sub-minimum sample — c>1 is an overclaim; got ${ice.c})`);
      }
    }
  }

  // Optionale Verantwortlichkeit (Verständlichkeits-Rubrik, skills/interpret.md §1b):
  // wer die Umsetzung übernimmt (z. B. "Entwicklung", "Redaktion", "Agentur",
  // "Entwicklung + Redaktion"). Schema-optional, damit ältere committete Läufe
  // (Eval-Runs) valide bleiben; wenn vorhanden, ein nicht-leerer String.
  if ('wer' in f) {
    if (typeof f.wer !== 'string') {
      errors.push(`${path}.wer must be a string (got ${typeof f.wer})`);
    } else if (f.wer.trim() === '') {
      errors.push(`${path}.wer must be a non-empty string when present`);
    }
  }

  // Optionaler No-Action-Marker (Verständlichkeits-Rubrik): true = der Befund
  // dient nur der Einordnung (z. B. Fehlalarm der Testumgebung) — der Renderer
  // ersetzt dann die Handlungs-Badges (Priorität/Aufwand/Wer), damit Badge und
  // Text («kein Handlungsbedarf») sich nicht widersprechen.
  if ('keinHandlungsbedarf' in f && typeof f.keinHandlungsbedarf !== 'boolean') {
    errors.push(`${path}.keinHandlungsbedarf must be a boolean (got ${typeof f.keinHandlungsbedarf})`);
  }

  // Optional first-class rule-id provenance. When present it is the authoritative
  // source for the handoff progress ledger (bin/handoff.mjs), replacing the older
  // convention of scraping `ruleId=` tokens out of free-text `beleg`.
  if ('ruleIds' in f) {
    if (!Array.isArray(f.ruleIds)) {
      errors.push(`${path}.ruleIds must be an array of strings (got ${typeof f.ruleIds})`);
    } else {
      f.ruleIds.forEach((r, ri) => {
        if (typeof r !== 'string') errors.push(`${path}.ruleIds[${ri}] must be a string (got ${typeof r})`);
      });
    }
  }

  if ('kbSources' in f) {
    if (!Array.isArray(f.kbSources)) {
      errors.push(`${path}.kbSources must be an array`);
    } else {
      f.kbSources.forEach((src, si) => {
        if (typeof src !== 'object' || src === null || Array.isArray(src)) {
          errors.push(`${path}.kbSources[${si}] must be an object with a "source" field (got ${typeof src})`);
        } else if (!('source' in src)) {
          errors.push(`${path}.kbSources[${si}] must have a "source" field`);
        } else if (typeof src.source !== 'string') {
          // Typ-Check: source muss ein String sein
          errors.push(`${path}.kbSources[${si}].source must be a string (got ${typeof src.source})`);
        }
      });
    }
  }
}
