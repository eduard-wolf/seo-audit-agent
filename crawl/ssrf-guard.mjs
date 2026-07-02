/**
 * crawl/ssrf-guard.mjs — Pure SSRF guard: private-address detector.
 *
 * isPrivateAddress(hostname) returns true when `hostname` is a literal IP
 * in a private/reserved range, or the keyword "localhost". No DNS resolution
 * is performed — non-literal-IP hostnames always return false. This is an
 * intentional, documented limitation: defense-in-depth; authorization scope
 * (the allowedHost mechanism in fetch.mjs) provides the complementary layer.
 *
 * Covered ranges (literal IPs only):
 *
 *   IPv4:
 *     127.0.0.0/8   — Loopback (RFC 5735 / RFC 1122)
 *     10.0.0.0/8    — RFC 1918 private
 *     172.16.0.0/12 — RFC 1918 private (172.16–172.31)
 *     192.168.0.0/16— RFC 1918 private
 *     169.254.0.0/16— Link-local / cloud metadata (incl. 169.254.169.254)
 *     100.64.0.0/10 — CGNAT shared address space (RFC 6598)
 *     0.0.0.0/8     — "This" network (RFC 1122)
 *
 *   IPv6 (expansion-based; covers all notation variants):
 *     ::                  — Unspecified (RFC 4291 §2.5.2; mirrors IPv4 0.0.0.0)
 *     ::1 and equivalents — Loopback (any notation, incl. zero-padded)
 *     fe80::/10           — Link-local (fe80–febf hex range)
 *     fc00::/7            — ULA (fc00–fdff hex range; RFC 4193)
 *     ::ffff:a.b.c.d      — IPv4-mapped dotted notation; embedded IPv4 checked
 *     ::ffff:hhhh:hhhh    — IPv4-mapped hex notation (e.g. ::ffff:0a00:0001);
 *                           embedded IPv4 extracted and checked
 *     ::a.b.c.d           — IPv4-compatible; embedded IPv4 checked
 *
 *   Note: no DNS resolution is performed. This is the documented limitation.
 *
 * Sources: RFC 1918, RFC 1122, RFC 5735, RFC 4193 (fc00::/7), RFC 4291
 * (link-local fe80::/10, IPv4-mapped/compatible), IANA Special-Purpose
 * Address Registries.
 */

import { isIP } from 'node:net';

/**
 * Expand an IPv6 address string to an array of 8 numeric hextets (0–0xffff).
 * Handles :: shorthand and trailing embedded IPv4 dotted-quad.
 * Returns null if the input is not a valid IPv6 address.
 *
 * @param {string} host — lowercase IPv6 string (no brackets)
 * @returns {number[]|null}
 */
function expandIPv6(host) {
  let s = host;

  // Trailing embedded IPv4 dotted-quad → two hextets (e.g. ::ffff:1.2.3.4)
  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const o = v4[1].split('.').map(n => parseInt(n, 10));
    if (o.some(n => Number.isNaN(n) || n > 255)) return null;
    s = s.slice(0, v4.index) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];

  let groups;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }

  if (groups.length !== 8) return null;

  const nums = groups.map(g => parseInt(g || '0', 16));
  if (nums.some(n => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;

  return nums;
}

/**
 * @param {string} host — lowercase IPv6 string
 * @returns {boolean}
 */
function isPrivateIPv6(host) {
  const h = expandIPv6(host);
  if (!h) return false;

  // Unspecified :: — all-zero address (RFC 4291 §2.5.2). Mirrors IPv4 0.0.0.0/8,
  // which is already treated as private below; without this, `::` slipped through.
  if (h.every(x => x === 0)) return true;

  // Loopback ::1 (any notation incl. zero-padded, fully-expanded, etc.)
  if (h.slice(0, 7).every(x => x === 0) && h[7] === 1) return true;

  // IPv4-mapped ::ffff:a.b.c.d  (h[0..4] = h[0],h[1],h[2],h[3],h[4] all 0; h[5]===0xffff)
  // IPv4-compatible ::a.b.c.d   (h[0..5] = h[0]–h[5] all 0; non-zero host part in h[6]/h[7])
  const mappedV4 =
    (h.slice(0, 5).every(x => x === 0) && h[5] === 0xffff) ||
    (h.slice(0, 6).every(x => x === 0) && (h[6] !== 0 || h[7] !== 0));
  if (mappedV4) {
    const a = h[6] >> 8, b = h[6] & 0xff, c = h[7] >> 8, d = h[7] & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  // fe80::/10 — Link-local: 0xfe80–0xfebf
  if (h[0] >= 0xfe80 && h[0] <= 0xfebf) return true;
  // fc00::/7  — ULA: 0xfc00–0xfdff (RFC 4193)
  if (h[0] >= 0xfc00 && h[0] <= 0xfdff) return true;

  return false;
}

/**
 * @param {string} host — IPv4 dotted-decimal string
 * @returns {boolean}
 */
function isPrivateIPv4(host) {
  const parts = host.split('.').map(Number);
  const [a, b] = parts;
  if (a === 127) return true;                              // 127.0.0.0/8  — Loopback
  if (a === 10)  return true;                              // 10.0.0.0/8   — RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12 — RFC 1918
  if (a === 192 && b === 168) return true;                 // 192.168.0.0/16 — RFC 1918
  if (a === 169 && b === 254) return true;                 // 169.254.0.0/16 — Link-local
  if (a === 100 && b >= 64 && b <= 127) return true;       // 100.64.0.0/10 — CGNAT (RFC 6598)
  if (a === 0)   return true;                              // 0.0.0.0/8 — "This" network
  return false;
}

/**
 * @param {string} hostname  — e.g. "10.0.0.1", "::1", "example.com"
 * @returns {boolean}
 */
export function isPrivateAddress(hostname) {
  if (!hostname) return false;
  // Strip a surrounding [...] from bracketed IPv6 literals (e.g. "[::1]" → "::1")
  // BEFORE the isIP() classification: isIP() returns 0 for bracketed input, which
  // would otherwise route every bracketed-IPv6 literal through the non-IP (public)
  // branch — a bypass, since `new URL(url).hostname` yields bracketed IPv6 hosts.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Keyword check: "localhost" is always private
  if (host === 'localhost') return true;

  const ipVersion = isIP(host);

  // Non-literal hostname (e.g. "example.com") → no DNS lookup; not blocked.
  // Callers must not rely on this for hostname-spoofing defence — use separate
  // DNS-rebinding mitigations at the network layer.
  if (ipVersion === 0) return false;

  if (ipVersion === 4) return isPrivateIPv4(host);

  if (ipVersion === 6) return isPrivateIPv6(host);

  return false;
}
