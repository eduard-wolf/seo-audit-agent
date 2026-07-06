#!/usr/bin/env node
// bin/enrich.mjs — OPTIONAL runtime enrichment. Writes data/<host>/runtime-signals.json. Key-gated +
// graceful: with no CRUX_API_KEY it writes {available:false}. NEVER touches crawl.csv/analysis.json.
import fs from 'node:fs'; import path from 'node:path';
import { fetchCruxOrigin } from '../crawl/crux.mjs';
import { probeTlsCert, classifyCert } from '../crawl/tls-check.mjs';
import { fetchSafeBrowsing } from '../crawl/safe-browsing.mjs';

/**
 * @param {string} dataDir  e.g. data/<host> (must contain signals.json)
 * @param {{apiKey?:string, fetchImpl?:Function, nowIso?:string, formFactor?:string, connectImpl?:Function, probeImpl?:Function, nowMs?:number, warnDays?:number, sbApiKey?:string, sbFetchImpl?:Function}} [opts]
 * @returns {Promise<object>} the runtime-signals object that was written
 */
export async function enrich(dataDir, opts = {}) {
  const { apiKey = process.env.CRUX_API_KEY, fetchImpl, nowIso, formFactor } = opts;
  // origin from signals.json (crawlMeta) or analysis.json meta; fall back to host
  let origin = '';
  try { const sig = JSON.parse(fs.readFileSync(path.join(dataDir, 'signals.json'), 'utf8'));
        origin = sig.origin || sig.meta?.origin || ''; } catch { /* ignore */ }
  if (!origin) { try { const a = JSON.parse(fs.readFileSync(path.join(dataDir, 'analysis.json'),'utf8'));
        origin = a.meta?.origin || ''; } catch { /* ignore */ } }
  const generatedAt = nowIso ?? new Date().toISOString();
  let out;
  if (!apiKey) {
    out = { available: false, reason: 'CRUX_API_KEY not set', generatedAt };
  } else {
    const r = await fetchCruxOrigin(origin, apiKey, fetchImpl ?? fetch, formFactor);
    if (!r.ok)        out = { available: false, reason: r.reason, generatedAt, source: 'CrUX' };
    else if (r.noData) out = { available: true, crux: { noData: true }, origin, generatedAt, source: 'CrUX' };
    else               out = { available: true, crux: r.crux, origin, generatedAt, source: 'CrUX' };
  }

  // ── TLS probe (keyless — runs for https origins regardless of CrUX key) ──
  let tlsPart;
  let tlsHost = '';
  try { const u = new URL(origin); if (u.protocol === 'https:') tlsHost = u.hostname; } catch { /* ignore */ }
  if (!tlsHost) {
    tlsPart = { available: false, reason: 'origin not https' };
  } else {
    const probed = await (opts.probeImpl ?? probeTlsCert)(tlsHost, 443, opts.connectImpl);
    if (probed.error) tlsPart = { available: false, reason: probed.error };
    else {
      const c = classifyCert(probed.cert, tlsHost, probed.authorizationError, opts.nowMs ?? Date.parse(generatedAt), opts.warnDays);
      tlsPart = { available: true, data: { ...c, host: tlsHost } };
    }
  }
  out.tls = tlsPart;   // attach to the existing `out` object (CrUX fields preserved), before writeFileSync

  // ── Safe Browsing probe (key-gated — runs only when SAFEBROWSING_API_KEY / opts.sbApiKey set) ──
  // `!== undefined` (not `??`): an explicit `sbApiKey: null` is a "no key" sentinel that must NOT fall
  // through to process.env (tests pass null to stay offline even if SAFEBROWSING_API_KEY is set in CI).
  const sbKey = opts.sbApiKey !== undefined ? opts.sbApiKey : process.env.SAFEBROWSING_API_KEY;
  let sbPart;
  if (!sbKey)        sbPart = { available: false, reason: 'SAFEBROWSING_API_KEY not set' };
  else if (!origin)  sbPart = { available: false, reason: 'no origin' };
  else {
    const r = await fetchSafeBrowsing(origin, sbKey, opts.sbFetchImpl ?? fetch);
    if (!r.ok) sbPart = { available: false, reason: r.reason };
    else       sbPart = { available: true, data: { flagged: r.flagged, threatTypes: r.threatTypes, target: origin } };
  }
  out.safeBrowsing = sbPart;   // attach before fs.writeFileSync (alongside out.tls and the CrUX fields)

  fs.writeFileSync(path.join(dataDir, 'runtime-signals.json'), JSON.stringify(out, null, 2), 'utf8');
  return out;
}

// CLI: node bin/enrich.mjs <dataDir>   (resolve relative to cwd)
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error('Usage: node bin/enrich.mjs <data/host-dir>'); process.exit(1); }
  // Validate up front: a missing dir / signals.json otherwise surfaces as a late
  // writeFileSync ENOENT stack trace deep inside enrich(). Fail early and clearly.
  if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, 'signals.json'))) {
    console.error(`enrich: ${dir} not found or has no signals.json — run bin/crawl-and-analyze.mjs first`);
    process.exit(1);
  }
  // `o.available` is the CrUX-scoped flag (the documented {available:false} no-key
  // contract). Report all three vehicles so a keyless run does not read as "nothing
  // happened" when the keyless TLS probe actually ran.
  enrich(dir).then(o => {
    const st = (p) => (p && p.available ? 'yes' : `no${p && p.reason ? ' (' + p.reason + ')' : ''}`);
    console.error(`enrich: crux=${st(o)} tls=${st(o.tls)} safeBrowsing=${st(o.safeBrowsing)}`);
    console.log(path.resolve(dir, 'runtime-signals.json'));
  }).catch(e => { console.error(`enrich failed: ${e?.message ?? e}`); process.exit(1); });
}
