/**
 * analyze/detectors/trust.mjs — detectors for config/rules/trust.json.
 *
 * Split out of analyze/engine.mjs verbatim (behaviour-neutral). Each entry is
 * [id, detector]; engine.mjs imports `detectors` and registers them into the registry.
 */

// trust:contact-pages-missing — site-level: no recognizable contact/about/imprint/privacy page among
// crawled + discovered URLs. Trust signal per Google QRG (NOT a ranking factor); for commercial DE sites
// Impressum (DDG §5) + Datenschutz (DSGVO Art. 13) are a LEGAL obligation. Heuristic (pages may live at
// non-standard URLs or be uncrawled) → caveated. Loose path matching is deliberate (anti-overclaim).
const TRUST_PAGE_PATTERNS = [
  /\/(kontakt|contact|reach-us|get-in-touch|hilfe)/i,                         // contact
  /\/(ueber-uns|ueber|uber-uns|uber|about|wer-wir-sind|unternehmen|firma)/i,  // about
  /\/(impressum|imprint|legal-notice|legal|anbieterkennzeichnung)/i,          // imprint
  /\/(datenschutz|privacy|data-protection|dsgvo)/i,                            // privacy
];
function normTrustPath(u) {
  try {
    let p = new URL(u).pathname;
    try { p = decodeURIComponent(p); } catch { /* keep percent-encoded form */ }
    return p.toLowerCase().replace(/ü/g, 'ue').replace(/ä/g, 'ae').replace(/ö/g, 'oe');
  }
  catch { return String(u).toLowerCase(); }
}

export const detectors = [

['trust:contact-pages-missing', (ctx, params) => {
  const urls = new Set((ctx.rows ?? []).map(r => r.url));
  for (const u of Object.keys(ctx.signals?.linkGraph?.depthByUrl ?? ctx.linkgraph?.depthByUrl ?? {})) urls.add(u);
  const paths = [...urls].map(normTrustPath);
  const found = TRUST_PAGE_PATTERNS.some(re => paths.some(p => re.test(p)));
  if (found) return { count: 0, affectedUrls: [], detail: '' };
  return {
    count: 1,
    affectedUrls: [],
    detail: 'Kein erkennbarer Kontakt-, Über-uns-, Impressums- oder Datenschutz-Bereich unter den gecrawlten/entdeckten URLs gefunden. Vertrauenssignal gemäß Google Quality Rater Guidelines (Sept. 2025: „Trust is the most important member of the E-E-A-T family"; transaktionale Seiten verlangen „satisfying customer service information") — KEIN direkter Ranking-Faktor. Für gewerbliche deutsche Websites zudem RECHTSPFLICHT: Impressum (DDG §5, seit Mai 2024) + Datenschutzerklärung (DSGVO Art. 13). Heuristik (Seiten können unter untypischen URLs liegen oder ungecrawlt sein) — bitte manuell verifizieren.',
  };
}],

];
