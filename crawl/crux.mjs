/** crawl/crux.mjs — Google CrUX (Chrome UX Report) field-data client. Built-in fetch; key-gated. */
// CWV thresholds (web.dev/articles/vitals, 2026): good ≤ X, poor > Y. INP replaced FID (2024).
const CWV_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },   // ms
  inp: { good: 200,  poor: 500  },   // ms
  cls: { good: 0.10, poor: 0.25 },   // unitless
};

/** 'good' | 'needs-improvement' | 'poor' from a p75 value. */
export function categorizeCwv(metric, p75) {
  const t = CWV_THRESHOLDS[metric];
  if (!t || p75 == null || isNaN(p75)) return null;
  if (p75 <= t.good) return 'good';
  if (p75 <= t.poor) return 'needs-improvement';
  return 'poor';
}

/** Parse a CrUX queryRecord JSON into { lcp, inp, cls } each {p75, category}; null if no metrics. */
export function parseCruxRecord(json) {
  const m = json?.record?.metrics;
  if (!m) return null;
  const read = (key, metric) => {
    const p75raw = m[key]?.percentiles?.p75;
    if (p75raw == null) return null;
    const p75 = typeof p75raw === 'string' ? parseFloat(p75raw) : p75raw;
    return { p75, category: categorizeCwv(metric, p75) };
  };
  const out = {
    lcp: read('largest_contentful_paint', 'lcp'),
    inp: read('interaction_to_next_paint', 'inp'),
    cls: read('cumulative_layout_shift', 'cls'),
  };
  if (!out.lcp && !out.inp && !out.cls) return null;
  return out;
}

/**
 * Fetch CrUX origin-level field data. Returns:
 *   { ok:true, crux:{lcp,inp,cls,formFactor} } | { ok:true, noData:true } | { ok:false, reason }
 * @param {string} origin    e.g. 'https://example.com'
 * @param {string} apiKey
 * @param {(url,opts)=>Promise<{status:number, json:()=>Promise<any>}>} [fetchImpl=fetch]  injected for tests
 * @param {string} [formFactor='PHONE']
 */
export async function fetchCruxOrigin(origin, apiKey, fetchImpl = fetch, formFactor = 'PHONE', timeoutMs = 8000) {
  if (!apiKey) return { ok: false, reason: 'CRUX_API_KEY not set' };
  const url = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({ origin, formFactor,
    metrics: ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'] });
  let res;
  try { res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) {
    // The API key lives in the URL query string — redact it before persisting the
    // reason into runtime-signals.json, and normalise a timeout to a stable token.
    const msg  = e?.name === 'TimeoutError' ? 'timeout' : (e?.message ?? String(e));
    const safe = apiKey ? String(msg).split(apiKey).join('REDACTED') : String(msg);
    return { ok: false, reason: `fetch-error: ${safe}` };
  }
  if (res.status === 404) return { ok: true, noData: true };           // CrUX has no data for this origin → graceful skip
  if (res.status < 200 || res.status >= 300) return { ok: false, reason: `crux-status-${res.status}` };
  let json; try { json = await res.json(); } catch { return { ok: false, reason: 'crux-bad-json' }; }
  const crux = parseCruxRecord(json);
  if (!crux) return { ok: true, noData: true };
  return { ok: true, crux: { ...crux, formFactor } };
}
