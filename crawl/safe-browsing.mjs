/** crawl/safe-browsing.mjs — Google Safe Browsing v4 Lookup (threatMatches:find), key-gated runtime. */
import { fetchWithTimeout } from './enrich-fetch.mjs';

/** Classify a Safe Browsing API response. PURE → unit-testable. Clean = {} (no matches). */
export function classifySafeBrowsingResponse(json) {
  const matches = json?.matches;
  if (!Array.isArray(matches) || matches.length === 0) return { flagged: false, threatTypes: [] };
  const threatTypes = [...new Set(matches.map(m => m?.threatType).filter(Boolean))];
  return { flagged: true, threatTypes };
}

/**
 * Look up a URL in Safe Browsing. Returns:
 *   { ok:true, flagged:boolean, threatTypes:string[] } | { ok:false, reason }
 * @param {string} targetUrl  @param {string} apiKey
 * @param {(url,opts)=>Promise<{status:number, json:()=>Promise<any>}>} [fetchImpl=fetch]  injected for tests
 */
export async function fetchSafeBrowsing(targetUrl, apiKey, fetchImpl = fetch, timeoutMs = 8000) {
  if (!apiKey) return { ok: false, reason: 'SAFEBROWSING_API_KEY not set' };
  if (!targetUrl) return { ok: false, reason: 'no target url' };
  const url = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    client: { clientId: 'seo-audit-agent', clientVersion: '1.0.0' },
    threatInfo: {
      threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
      platformTypes: ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries: [{ url: targetUrl }],
    },
  });
  const r0 = await fetchWithTimeout(fetchImpl, url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    { apiKey, timeoutMs });
  if (!r0.ok) return { ok: false, reason: r0.reason };
  const res = r0.res;
  if (res.status < 200 || res.status >= 300) return { ok: false, reason: `safebrowsing-status-${res.status}` };
  let json; try { json = await res.json(); } catch { return { ok: false, reason: 'safebrowsing-bad-json' }; }
  const c = classifySafeBrowsingResponse(json);
  return { ok: true, ...c };
}
