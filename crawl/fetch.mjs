/**
 * crawl/fetch.mjs — Robust, throttle-ready HTTP fetcher.
 *
 * politeFetch(url, opts) follows redirects manually, retries on 429/5xx
 * with exponential backoff (≥1 s default + jitter), honours Retry-After
 * headers, and aborts on configurable timeout.
 *
 * Return-value contract:
 *   `body`  — raw response text for any 2xx text/* or xml content-type
 *             (robots.txt, sitemap.xml, llms.txt, HTML pages …); or for
 *             application/gzip (or .gz path) the decompressed XML text;
 *             null otherwise.
 *   `html`  — populated ONLY for text/html 2xx responses (what C2 analyses);
 *             null for text/plain, application/xml, gzip, non-2xx, errors, etc.
 *   `mixedContent` — always null from C1; C2 fills it in.
 *   `xRobotsTag`     — X-Robots-Tag response header value ('' if absent).
 *   `hstsPresent`    — 1 if Strict-Transport-Security header is present, else 0.
 *   `frameProtection`— 1 if X-Frame-Options OR CSP frame-ancestors present, else 0.
 *   `contentEncoding`— Content-Encoding response header value ('' if absent).
 *   nosniffPresent / referrerPolicyPresent / permissionsPolicyPresent / cspPresent —
 *     1 if the respective X-Content-Type-Options: nosniff / Referrer-Policy /
 *     Permissions-Policy / Content-Security-Policy header is present, else 0.
 *   cookieInsecure — 1 if a served Set-Cookie misses Secure/HttpOnly/SameSite; 0 when
 *     secure OR when no Set-Cookie is served.
 *   versionDisclosure — 1 if Server (with version token) or X-Powered-By discloses
 *     server software/version, else 0.
 *   (The six above are TRUST/SECURITY signals — NOT ranking factors, NOT rich-result
 *    eligibility — pure functions of the response headers, no extra fetch.)
 *
 * Politeness (U3.8):
 *   USER_AGENT — exported constant using RFC-6761 .example TLD (no real brand/email).
 *   parseRetryAfter(headerVal, nowMs) — pure helper; exported for testing.
 *   backoffBaseMs opt — default 1000 ms (≥1 s politeness); inject small value in tests.
 *   maxBackoffMs opt  — default 30000 ms; caps the total wait per retry.
 *   userAgent opt     — defaults to USER_AGENT; deployers can set a real contact URL.
 */

import zlib from 'node:zlib';
import { isPrivateAddress } from './ssrf-guard.mjs';

export const USER_AGENT = 'seo-audit-agent/0.1 (+https://seo-audit-agent.example/bot)';
const MAX_REDIRECTS = 5;
const MAX_RETRIES = 2;
const JITTER_MS = 250; // uniform random jitter added on top of base backoff

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Parse a Retry-After header value to milliseconds.
 *
 * Accepts:
 *   - Numeric string (integer or float seconds, non-negative) → ms; negative/invalid → null.
 *   - HTTP-date string → ms until that date from nowMs; past dates → 0.
 *   - Anything else (including non-numeric, non-date strings) → null.
 *
 * @param {string|null|undefined} headerVal
 * @param {number} [nowMs=Date.now()]
 * @returns {number|null}
 */
export function parseRetryAfter(headerVal, nowMs = Date.now()) {
  if (headerVal == null) return null;
  const trimmed = String(headerVal).trim();
  if (!trimmed) return null;

  // Try numeric seconds first (covers integer and decimal values).
  // Negative finite numbers are explicitly null — they must not fall through to
  // the Date.parse branch (some engines parse '-5' as a valid date).
  const num = Number(trimmed);
  if (Number.isFinite(num)) return num >= 0 ? Math.round(num * 1000) : null;

  // Try HTTP-date (RFC 7231 / RFC 9110)
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) return Math.max(0, t - nowMs);

  return null;
}

/**
 * Determine whether any served Set-Cookie is "insecure" per the OWASP Secure
 * Headers Project: missing the Secure, HttpOnly, or SameSite attribute. Returns
 * false when NO Set-Cookie is served (the cookie rule must not fire without one).
 *
 * Uses undici's `headers.getSetCookie()` when available (present on Node v24) so
 * multiple Set-Cookie response headers are read individually; falls back to the
 * raw comma-joined `set-cookie` header on runtimes that lack it.
 *
 * @param {Headers} headers
 * @returns {boolean}
 */
export function computeCookieInsecure(headers) {
  const cookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  return cookies.some(cookie => {
    // Drop the name=value pair (attrs[0]); the rest are attributes.
    const attrs = cookie.split(';').slice(1).map(s => s.trim().toLowerCase());
    const hasSecure   = attrs.includes('secure');
    const hasHttpOnly = attrs.includes('httponly');
    const hasSameSite = attrs.some(a => a === 'samesite' || a.startsWith('samesite='));
    return !hasSecure || !hasHttpOnly || !hasSameSite;
  });
}

/**
 * Determine whether the response discloses server software/version via the
 * Server or X-Powered-By header (OWASP Secure Headers Project: avoid version
 * disclosure). X-Powered-By present at all is disclosure (it names the stack);
 * a Server header counts only when it carries a real version token after a slash —
 * digit(s).digit, e.g. "nginx/1.18.0" or "Microsoft-IIS/10.0" — so neither a bare
 * "Server: cloudflare" nor a non-version slash token like an edge id ("ECS (dcb/7F83)")
 * trips it.
 *
 * @param {Headers} headers
 * @returns {boolean}
 */
export function computeVersionDisclosure(headers) {
  const server    = headers.get('server') ?? '';
  const poweredBy = headers.get('x-powered-by') ?? '';
  return poweredBy.trim() !== '' || /\/\d+\.\d/.test(server);
}

/**
 * Whether the response sets X-Content-Type-Options: nosniff. The header value is
 * token-split: a duplicated/appended header reads back as "nosniff, nosniff" via
 * Headers.get(), and browsers honour any nosniff token — so an exact-string compare
 * would falsely report it absent. ANY nosniff token counts.
 *
 * @param {Headers} headers
 * @returns {boolean}
 */
export function computeNosniffPresent(headers) {
  const value = headers.get('x-content-type-options') ?? '';
  return value.split(',').some(token => token.trim().toLowerCase() === 'nosniff');
}

/**
 * Read a response body as raw bytes (Buffer), capped at maxBytes.
 * The AbortController signal stays armed so the reader.read() call will throw
 * an AbortError if the timeout fires during the body read.
 * Callers are responsible for decoding (e.g. buf.toString('utf8') or gunzipSync).
 *
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBodyCapped(res, maxBytes) {
  // Defensive fallback for non-streaming response bodies (e.g. environments where
  // res.body is absent). On Node ≥18 with undici this path is practically dead;
  // included for robustness against future runtimes or unusual fetch implementations.
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); // throws AbortError when timer fires
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {}); // fire-and-forget: stop the stream cleanly
      const e = new Error('body-too-large');
      e.tooLarge = true;
      throw e;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks); // Uint8Array chunks; Buffer is a built-in
}

/**
 * Fetch a URL with redirect following, retries, and timeout.
 *
 * @param {string} url
 * @param {{
 *   timeoutMs?:    number,
 *   maxBodyBytes?: number,
 *   allowedHost?:  string,
 *   backoffBaseMs?: number,
 *   maxBackoffMs?:  number,
 *   userAgent?:    string,
 * }} [opts]
 * @returns {Promise<{
 *   url: string, status: number, finalUrl: string,
 *   redirected: boolean, redirectChain: string[],
 *   contentType: string|null, httpsOk: boolean,
 *   mixedContent: null, error: string|null,
 *   body: string|null,
 *   html: string|null,
 *   xRobotsTag: string, hstsPresent: number,
 *   frameProtection: number, contentEncoding: string,
 *   nosniffPresent: number, referrerPolicyPresent: number,
 *   permissionsPolicyPresent: number, cspPresent: number,
 *   cookieInsecure: number, versionDisclosure: number
 * }>}
 */
/** @param {string} url @returns {string} */
function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export async function politeFetch(url, opts = {}) {
  const {
    timeoutMs    = 10000,
    maxBodyBytes = 8_000_000,
    allowedHost,
    backoffBaseMs = 1000,
    maxBackoffMs  = 30000,
    userAgent     = USER_AGENT,
  } = opts;

  // The seed host (authorized target). Hops to a DIFFERENT private host are blocked.
  // Default: the hostname of the initial URL — bare calls are always allowed for their
  // own host (covers the 127.0.0.1 fixture-server case and normal single-host crawls).
  const seedHost = allowedHost ?? safeHostname(url);

  let currentUrl = url;
  let redirected = false;
  const redirectChain = [];
  let status = 0;
  let contentType = null;
  let xRobotsTag = '';
  let hstsPresent = 0;
  let frameProtection = 0;
  let contentEncoding = '';
  let nosniffPresent = 0;
  let referrerPolicyPresent = 0;
  let permissionsPolicyPresent = 0;
  let cspPresent = 0;
  let cookieInsecure = 0;
  let versionDisclosure = 0;
  let body = null;
  let html = null;
  let error = null;

  mainLoop: for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // SSRF guard — checked at the top of every hop (covers hop 0 and all redirects).
    // Block any hop whose target host is a private/reserved address AND is not the
    // authorized seed host. This prevents open-redirect / misconfiguration attacks
    // that would redirect the crawler to cloud-metadata or RFC-1918 endpoints.
    // Note: hostname-only (non-literal-IP) targets pass through (no DNS resolution;
    // defense-in-depth; documented limitation — see crawl/ssrf-guard.mjs).
    const targetHost = safeHostname(currentUrl);
    if (targetHost !== seedHost && isPrivateAddress(targetHost)) {
      error = 'blocked-private-host';
      break mainLoop;
    }

    let res;

    // controller/tid are declared at the hop level so they stay alive
    // until AFTER the body read of the final response.
    let controller;
    let tid;

    // Inner retry loop for 429 / 5xx.
    // retryAfterMs is set when the server returns a Retry-After header; used for
    // the next attempt's wait, then reset to null.
    let retryAfterMs = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Use Retry-After if present, otherwise exponential backoff + jitter.
        // Both are clamped to maxBackoffMs.
        const backoff = backoffBaseMs * (2 ** (attempt - 1)) + Math.round(Math.random() * JITTER_MS);
        const waitMs  = Math.min(retryAfterMs ?? backoff, maxBackoffMs);
        retryAfterMs  = null; // reset — only used for the immediately next attempt
        await sleep(waitMs);
      }

      controller = new AbortController();
      tid = setTimeout(() => controller.abort(), timeoutMs);

      try {
        res = await fetch(currentUrl, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': userAgent, 'Accept-Encoding': 'gzip, deflate, br' },
        });

        // Retry on 429 or 5xx (except on last attempt)
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
          retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
          clearTimeout(tid); // disarm before sleeping for the next attempt
          continue;
        }
        break; // definitive response — do NOT clearTimeout yet
      } catch (e) {
        clearTimeout(tid);
        error = e.name === 'AbortError' ? 'timeout' : e.message;
        status = 0;
        break mainLoop;
      }
    }

    status = res.status;

    // Follow redirect — disarm current timer; next hop gets a fresh one
    if (status >= 300 && status < 400) {
      clearTimeout(tid);
      const loc = res.headers.get('location');
      if (!loc) break; // missing Location header — stop
      let nextUrl;
      try {
        nextUrl = new URL(loc, currentUrl).href;
      } catch {
        error = 'invalid-redirect'; // broken Location → page error, not crawl abort
        break mainLoop;
      }
      redirectChain.push(currentUrl);
      currentUrl = nextUrl;
      redirected = true;
      continue;
    }

    // Final response — timer stays armed over the body read
    contentType = res.headers.get('content-type') ?? null;
    xRobotsTag      = res.headers.get('x-robots-tag') ?? '';
    hstsPresent     = res.headers.get('strict-transport-security') ? 1 : 0;
    const xfo       = res.headers.get('x-frame-options');
    const csp       = res.headers.get('content-security-policy') ?? '';
    frameProtection = (xfo || /frame-ancestors/i.test(csp)) ? 1 : 0;
    contentEncoding = res.headers.get('content-encoding') ?? '';

    // ── Security/Trust response-header hardening (Batch 4b) ──────────────────
    // Pure functions of the final response headers — TRUST/SECURITY signals only,
    // NOT ranking factors and NOT rich-result eligibility. No extra fetch.
    nosniffPresent           = computeNosniffPresent(res.headers) ? 1 : 0;
    referrerPolicyPresent    = (res.headers.get('referrer-policy') ?? '') !== '' ? 1 : 0;
    permissionsPolicyPresent = (res.headers.get('permissions-policy') ?? '') !== '' ? 1 : 0;
    cspPresent               = csp !== '' ? 1 : 0; // overall CSP presence (distinct from frame-ancestors)
    cookieInsecure           = computeCookieInsecure(res.headers) ? 1 : 0;
    versionDisclosure        = computeVersionDisclosure(res.headers) ? 1 : 0;

    // gzip-file detection: Content-Type application/gzip (or x-gzip), or .gz path.
    // Note: Content-Encoding: gzip (transfer encoding) is auto-handled by undici/fetch;
    // this handles gzip FILES served as a binary response body that we must decompress.
    const path = (() => { try { return new URL(currentUrl).pathname; } catch { return ''; } })();
    const isGzip = /application\/(x-)?gzip/i.test(contentType ?? '') || /\.gz$/i.test(path);

    // Read body as text for 2xx responses with text/* or XML content types, or gzip files.
    // `body` receives decoded text for ALL such responses (robots, sitemap, llms, HTML, gz).
    // `html` is set ONLY for text/html — C2 expects null for everything else (incl. gzip).
    if (status >= 200 && status < 300 && (isGzip || /text\/|xml/.test(contentType ?? ''))) {
      try {
        const buf = await readBodyCapped(res, maxBodyBytes);   // raw Buffer
        // Bind decompressed output to the same cap so a gzip bomb cannot expand
        // the buffer far beyond maxBodyBytes. Node throws ERR_BUFFER_TOO_LARGE.
        body = isGzip ? zlib.gunzipSync(buf, { maxOutputLength: maxBodyBytes }).toString('utf8') : buf.toString('utf8');
        // html is set only for text/html content-type — gzip files are served as
        // application/gzip (not text/html), so html stays null for gzip responses.
        if (/text\/html/.test(contentType ?? '')) html = body;
      } catch (e) {
        body = null;
        html = null;
        error = e?.tooLarge || e?.code === 'ERR_BUFFER_TOO_LARGE' ? 'body-too-large'
          : (e?.name === 'AbortError' ? 'timeout'
          : (e?.code === 'Z_DATA_ERROR' || /incorrect header check|unexpected end/i.test(e?.message ?? '') ? 'gzip-error'
          : (e?.message || 'body-read-error')));
      }
    }

    clearTimeout(tid); // disarm after body read (or body skipped)
    break mainLoop;
  }

  // If the loop exhausted all redirect hops without reaching a final response,
  // flag the result so callers can distinguish "too many redirects" from a
  // legitimate 3xx (e.g. a server that never issues a final Location).
  if (status >= 300 && status < 400 && error === null) {
    error = 'too-many-redirects';
  }

  const finalUrl = currentUrl;

  return {
    url,
    status,
    finalUrl,
    redirected,
    redirectChain,
    contentType,
    httpsOk: finalUrl.startsWith('https://'),
    mixedContent: null,
    error,
    body,
    html,
    xRobotsTag,
    hstsPresent,
    frameProtection,
    contentEncoding,
    nosniffPresent,
    referrerPolicyPresent,
    permissionsPolicyPresent,
    cspPresent,
    cookieInsecure,
    versionDisclosure,
  };
}
