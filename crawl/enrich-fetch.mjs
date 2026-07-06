/**
 * crawl/enrich-fetch.mjs — timeout-armed, key-redacting fetch for the enrich clients.
 *
 * Shared by crawl/crux.mjs and crawl/safe-browsing.mjs so the security-sensitive
 * timeout + API-key-redaction logic lives in ONE place (the API key rides in the
 * URL query string, and error reasons are persisted to runtime-signals.json).
 */

/**
 * Fetch with an AbortSignal timeout, returning a discriminated result instead of
 * throwing. On failure the reason is sanitised: a TimeoutError normalises to the
 * stable token `timeout`, and any occurrence of `apiKey` is redacted.
 *
 * @param {(url:string, init:object)=>Promise<any>} fetchImpl
 * @param {string} url
 * @param {object} init  — fetch init (method/headers/body); a `signal` is injected
 * @param {{ apiKey?: string, timeoutMs: number }} opts
 * @returns {Promise<{ok:true, res:any} | {ok:false, reason:string}>}
 */
export async function fetchWithTimeout(fetchImpl, url, init, { apiKey, timeoutMs }) {
  try {
    return { ok: true, res: await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }) };
  } catch (e) {
    const msg  = e?.name === 'TimeoutError' ? 'timeout' : (e?.message ?? String(e));
    const safe = apiKey ? String(msg).split(apiKey).join('REDACTED') : String(msg);
    return { ok: false, reason: `fetch-error: ${safe}` };
  }
}
