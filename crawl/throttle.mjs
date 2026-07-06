/**
 * crawl/throttle.mjs — Global throughput limiter (~N req/s).
 *
 * makeLimiter({ rps, crawlDelaySec }) returns an async limit(fn) function.
 * Concurrent callers each reserve a time slot atomically (single-threaded JS),
 * so the aggregate call rate never exceeds rps (or the crawl-delay floor if larger).
 *
 * Politeness (U3.8):
 *   crawlDelaySec — honours robots.txt Crawl-delay as a floor on the interval,
 *                   clamped to MAX_CRAWL_DELAY_SEC (10 s) to avoid absurd values.
 *   limit.slowDown(factor) — multiplies the running interval by factor (e.g. 2
 *                   to halve effective rps); used when repeated 429s are observed.
 *   limit.getIntervalMs() — returns the current interval (testing seam only).
 */

const MAX_CRAWL_DELAY_SEC = 10;

/**
 * Compute effective interval in milliseconds honoring the Crawl-delay floor.
 *
 * Effective interval = max(1000/rps, min(crawlDelaySec, MAX_CRAWL_DELAY_SEC) * 1000)
 * This means the crawl-delay acts as a minimum pause between requests, but is
 * capped at MAX_CRAWL_DELAY_SEC seconds to guard against robots files that
 * specify absurdly large delays.
 *
 * @param {number} rps
 * @param {number} [crawlDelaySec=0]
 * @returns {number} effective interval in milliseconds
 */
export function effectiveIntervalMs(rps, crawlDelaySec = 0) {
  // rps <= 0 means "unbounded" (0 ms between requests) — never 1000/0 = Infinity,
  // which would hang the limiter. The CLI already rejects non-positive rps; this
  // guards the library entry point.
  const rpsInterval = rps > 0 ? 1000 / rps : 0;
  if (!crawlDelaySec) return rpsInterval;
  return Math.max(rpsInterval, Math.min(crawlDelaySec, MAX_CRAWL_DELAY_SEC) * 1000);
}

/**
 * @param {{ rps?: number, crawlDelaySec?: number }} [opts]
 * @returns {(fn: () => unknown) => Promise<unknown>}
 */
export function makeLimiter({ rps = 2, crawlDelaySec = 0 } = {}) {
  let intervalMs = effectiveIntervalMs(rps, crawlDelaySec);
  let nextAllowed = 0; // absolute timestamp when the next call may start

  /**
   * Run fn() after honouring the rate limit.
   *
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function limit(fn) {
    const now = Date.now();
    const delay = Math.max(0, nextAllowed - now);
    // Reserve the slot *before* awaiting so concurrent callers see the updated value
    nextAllowed = Math.max(now, nextAllowed) + intervalMs;
    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }
    return fn();
  }

  /**
   * Multiply the running interval by factor for the rest of the crawl.
   * Halves effective rps when factor=2 (called on repeated 429 responses).
   *
   * @param {number} factor
   */
  limit.slowDown = function slowDown(factor) {
    intervalMs *= factor;
  };

  /**
   * Return current interval in ms. Testing seam — not for production use.
   * @returns {number}
   */
  limit.getIntervalMs = function getIntervalMs() {
    return intervalMs;
  };

  return limit;
}
