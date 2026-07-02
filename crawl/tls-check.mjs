/** crawl/tls-check.mjs — TLS leaf-certificate inspection via node:tls (keyless, runtime). */
import tls from 'node:tls';

/** Parse `subjectaltname` ("DNS:a.com, DNS:*.b.com") → ['a.com','*.b.com']. */
export function parseSans(subjectaltname) {
  if (!subjectaltname) return [];
  return subjectaltname.split(',').map(s => s.trim().replace(/^DNS:/i, '')).filter(Boolean);
}

/** Does host match a SAN (exact or single-level wildcard *.example.com)? */
export function hostMatchesSans(host, sans) {
  const h = (host || '').toLowerCase();
  return sans.some(san => {
    const s = san.toLowerCase();
    if (s === h) return true;
    if (s.startsWith('*.')) {
      const suffix = s.slice(1);            // ".example.com"
      const idx = h.indexOf('.');
      return idx > 0 && h.slice(idx) === suffix;   // exactly one extra label
    }
    return false;
  });
}

/**
 * Classify a peer certificate. PURE (injected now) → fully unit-testable.
 * @param {{valid_to?:string, subject?:{CN?:string}, subjectaltname?:string}} cert
 * @param {string} host
 * @param {string|null} authorizationError  e.g. 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT'
 * @param {number} nowMs
 * @param {number} [warnDays=14]
 * @returns {{issues:string[], daysLeft:number|null, validTo:string|null}}
 */
export function classifyCert(cert, host, authorizationError, nowMs, warnDays = 14) {
  const issues = [];
  let daysLeft = null;
  const validTo = cert?.valid_to ?? null;
  const exp = validTo ? Date.parse(validTo) : NaN;
  if (!isNaN(exp)) {
    daysLeft = Math.floor((exp - nowMs) / 86400000);
    if (exp <= nowMs) issues.push('expired');
    else if (daysLeft <= warnDays) issues.push('expiring');
  }
  const sans = parseSans(cert?.subjectaltname);
  if (sans.length > 0 && host && !hostMatchesSans(host, sans)) issues.push('mismatch');
  // Untrusted chain — only add if not already captured as expired (CERT_HAS_EXPIRED ⇒ expired above).
  if (authorizationError && !issues.includes('expired') && authorizationError !== 'CERT_HAS_EXPIRED') {
    issues.push('untrusted');
  }
  return { issues, daysLeft, validTo };
}

/**
 * Open a read-only TLS handshake and return the peer cert for AUDITING.
 * SECURITY NOTE: `rejectUnauthorized: false` is INTENTIONAL and REQUIRED here, and is NOT a MITM risk:
 *   - This is a passive cert-AUDIT probe whose entire purpose is to READ certs that may be expired,
 *     self-signed, or hostname-mismatched. With verification ON, the handshake aborts BEFORE the cert
 *     can be inspected, so the broken cases this check exists to detect would be invisible.
 *   - NO request is sent and NO data is transmitted over the connection — we read the cert and destroy
 *     the socket. Trust failures are NOT silently accepted: `authorizationError` is captured and
 *     surfaced as an 'untrusted' finding (see classifyCert). This is the standard cert-monitor pattern.
 * Add a top-of-file `eslint-disable` only if the repo lints this rule; otherwise a clear comment suffices.
 * @param {string} host  @param {number} [port=443]
 * @param {(opts:object, cb:Function)=>any} [connectImpl=tls.connect]  injected for tests
 * @returns {Promise<{cert:object, authorizationError:string|null}|{error:string}>}
 */
export function probeTlsCert(host, port = 443, connectImpl = tls.connect, timeoutMs = 8000) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let socket;
    try {
      socket = connectImpl({ host, port, servername: host, rejectUnauthorized: false }, () => {
        const cert = socket.getPeerCertificate(true);
        const authorizationError = socket.authorizationError ? String(socket.authorizationError) : null;
        try { socket.destroy(); } catch { /* ignore */ }
        finish({ cert, authorizationError });
      });
    } catch (e) { return finish({ error: `tls-connect: ${e?.message ?? e}` }); }
    socket.setTimeout?.(timeoutMs, () => { try { socket.destroy(); } catch {} finish({ error: 'tls-timeout' }); });
    socket.on?.('error', e => finish({ error: `tls-error: ${e?.message ?? e}` }));
  });
}
