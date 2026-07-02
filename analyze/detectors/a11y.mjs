/**
 * analyze/detectors/a11y.mjs — detectors for config/rules/a11y.json.
 *
 * Split out of analyze/engine.mjs verbatim (behaviour-neutral). Each entry is
 * [id, detector]; engine.mjs imports `detectors` and registers them into the registry.
 */

import { contentRows } from './_shared.mjs';

export const detectors = [

// a11y:control-no-name — interactive controls without an accessible name: <iframe> without title
// (WCAG H64) or <button> with no text and no aria-label/aria-labelledby/title (icon button, F68).
// WCAG 2.2 SC 4.1.2 "Name, Role, Value" (Level A). NOT a Google ranking signal. Generic form-field
// label association is intentionally NOT checked (statically too false-positive-prone).
['a11y:control-no-name', (ctx, params) => {
  const minCount = params?.minCount ?? 1;
  const affected = contentRows(ctx.rows).filter(r => Number(r.unlabeledControlCount ?? 0) >= minCount);
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Interaktive Steuerelemente ohne zugänglichen Namen: <iframe> ohne title-Attribut (WCAG-Technik H64) bzw. <button> ohne Textinhalt und ohne aria-label/aria-labelledby/title (z. B. Icon-Buttons). Verstoß gegen WCAG 2.2 SC 4.1.2 „Name, Role, Value" (Level A) — Screenreader können das Element nicht benennen. KEIN Google-Ranking-Signal. Hinweis: die generische Formularfeld-Label-Zuordnung (label[for]/umschließendes label) wird bewusst NICHT geprüft (statisch zu fehleranfällig).',
  };
}],

];
