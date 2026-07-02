/**
 * test/robots-substance.test.mjs — Batch 4a tests.
 *
 * Two new deterministic check families that REUSE already-collected signals
 * (no new crawl/extraction):
 *   • robots.txt SUBSTANCE — tech:robots-site-blocked / tech:robots-noindex-directive /
 *     tech:robots-no-sitemap (reuse signals.robots.{disallow,allow,raw,sitemapRefs}).
 *   • URL hygiene / host-canonicalization — hygiene:url-inconsistency (reuse crawl.csv
 *     url/finalUrl/status/redirected).
 *
 * Detectors are tested primarily via synthetic-ctx UNIT tests; the robots family is
 * additionally exercised end-to-end through the fixture-server robotsBody override
 * (real fetch + parseRobots → signals.robots → detector). Default-fixture bookend
 * positives are asserted so a future fixture change that trips a new rule is caught.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from './fixture-server.mjs';
import { runCrawl }           from '../crawl/run.mjs';
import { analyzeFromFiles }   from '../analyze/analyze.mjs';
import { runRules, loadRules } from '../analyze/engine.mjs';

const RULES = loadRules(new URL('../config/rules', import.meta.url).pathname);
const ruleFor = id => {
  const r = RULES.find(x => x.id === id);
  assert.ok(r, `config rule ${id} must exist`);
  return r;
};

// 5 filler 2xx rows → pageCount >= 5 → minNMet=true, so the engine preserves the
// detector's `detail` string (below 5 it is replaced with a small-sample notice).
// The site-level robots detectors ignore rows, so these never affect their results.
const FILLER = () => Array.from({ length: 5 }, (_, i) =>
  ({ url: `http://example.com/f${i}`, status: '200', redirected: '0' }));

// ── Test isolation (per analyze.test.mjs pattern) ────────────────────────────
const TMP_DATA_DIRS = [];
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
  TMP_DATA_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TMP_DATA_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

// ── tech:robots-site-blocked — detector unit (synthetic ctx) ─────────────────

describe('tech:robots-site-blocked — detector unit (synthetic signals.robots)', () => {
  const rule = ruleFor('tech:robots-site-blocked');

  it('fires when User-agent: * disallows the whole site (Disallow: /)', () => {
    const ctx = {
      rows: FILLER(),
      signals: { robots: { exists: true, disallow: ['/'], allow: [], raw: 'User-agent: *\nDisallow: /', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'site-blocked should fire for Disallow: /');
    assert.ok(findings[0].detail.includes('KEIN Ranking-Faktor'), 'detail carries eligibility-not-ranking framing');
    assert.ok(/crawl/i.test(findings[0].detail) && /URL-only/i.test(findings[0].detail),
      'detail states crawling impact + URL-only indexing possibility');
  });

  it('does NOT fire when an Allow: / re-permits the root (RFC-9309 Allow override)', () => {
    const ctx = {
      rows: [],
      signals: { robots: { exists: true, disallow: ['/'], allow: ['/'], raw: 'User-agent: *\nDisallow: /\nAllow: /', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'Allow: / ties Disallow: / → allowed → must NOT fire');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when only a sub-path is disallowed (Disallow: /private/)', () => {
    const ctx = {
      rows: [],
      signals: { robots: { exists: true, disallow: ['/private/'], allow: [], raw: 'User-agent: *\nDisallow: /private/', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'partial disallow must NOT block the whole site');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when signals.robots is absent (synthetic ctx without robots)', () => {
    const ctx = { rows: [], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'missing robots → graceful positive');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  // exists-gating: unreachable robots.txt fail-closes to {exists:false, disallow:['/']} — must NOT fire.
  it('does NOT fire for fail-closed unreachable robots.txt {exists:false, disallow:[\'/\']}', () => {
    const ctx = {
      rows: [],
      signals: { robots: { exists: false, disallow: ['/'], allow: [], raw: '', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'exists:false (fail-closed) must NOT fire site-blocked');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('DOES fire for a genuine block {exists:true, disallow:[\'/\']}', () => {
    const ctx = {
      rows: [],
      signals: { robots: { exists: true, disallow: ['/'], allow: [], raw: 'User-agent: *\nDisallow: /', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'exists:true + Disallow: / IS a deliberate block → fire');
  });
});

// ── tech:robots-noindex-directive — detector unit (synthetic ctx) ────────────

describe('tech:robots-noindex-directive — detector unit (synthetic signals.robots)', () => {
  const rule = ruleFor('tech:robots-noindex-directive');

  it('fires on a line-anchored noindex: directive (case-insensitive)', () => {
    const ctx = {
      rows: FILLER(),
      signals: { robots: { disallow: [], allow: [], raw: 'User-agent: *\nNoindex: /secret\n', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'noindex-directive should fire');
    assert.ok(findings[0].detail.includes('2019-09-01'), 'detail names the 2019-09-01 sunset');
    assert.ok(/WIRKUNGSLOS/i.test(findings[0].detail), 'detail flags the directive as ineffective');
  });

  it('does NOT fire when noindex appears only in a comment (# noindex: …)', () => {
    const ctx = {
      rows: [],
      signals: { robots: { disallow: [], allow: [], raw: 'User-agent: *\n# noindex: was here\nDisallow:\n', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'commented noindex must NOT fire');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when "noindex" only appears inside a Disallow path value', () => {
    const ctx = {
      rows: [],
      signals: { robots: { disallow: ['/noindex/'], allow: [], raw: 'User-agent: *\nDisallow: /noindex/\n', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'in-path noindex must NOT fire (not a directive line)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  // Verify the exists-gate is unnecessary here: a fail-closed robots.txt has raw='' so the
  // raw-keyed scan already yields a positive (no false claim of an ineffective directive).
  it('does NOT fire for fail-closed unreachable robots.txt (raw is empty)', () => {
    const ctx = {
      rows: [],
      signals: { robots: { exists: false, disallow: ['/'], allow: [], raw: '', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'empty raw (unreachable) must NOT fire noindex-directive');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── tech:robots-no-sitemap — detector unit (synthetic ctx) ───────────────────

describe('tech:robots-no-sitemap — detector unit (synthetic signals.robots)', () => {
  const rule = ruleFor('tech:robots-no-sitemap');

  it('fires when sitemapRefs is empty (no Sitemap: directive)', () => {
    const ctx = {
      rows: FILLER(),
      signals: { robots: { exists: true, disallow: ['/private/'], allow: [], raw: 'User-agent: *\nDisallow: /private/\n', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'no-sitemap should fire when sitemapRefs is empty');
    assert.ok(findings[0].detail.includes('KEIN Ranking-Faktor'), 'detail carries not-ranking framing');
  });

  it('does NOT fire when a Sitemap: directive is present', () => {
    const ctx = {
      rows: [],
      signals: { robots: { exists: true, disallow: [], allow: [], raw: 'Sitemap: http://x/sitemap.xml\n', sitemapRefs: ['http://x/sitemap.xml'] } },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'present Sitemap directive → must NOT fire');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when signals.robots is absent', () => {
    const ctx = { rows: [], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'missing robots → graceful positive');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  // exists-gating: don't claim "no Sitemap directive" when robots.txt was simply unreachable.
  it('does NOT fire for fail-closed unreachable robots.txt {exists:false, sitemapRefs:[]}', () => {
    const ctx = {
      rows: [],
      signals: { robots: { exists: false, disallow: ['/'], allow: [], raw: '', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'exists:false (fail-closed) must NOT fire no-sitemap');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('DOES fire for a reachable robots.txt with no Sitemap {exists:true, sitemapRefs:[]}', () => {
    const ctx = {
      rows: [],
      signals: { robots: { exists: true, disallow: [], allow: [], raw: 'User-agent: *\nDisallow:\n', sitemapRefs: [] } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'exists:true + no Sitemap directive → fire');
  });
});

// ── hygiene:url-inconsistency — detector unit (synthetic ctx) ────────────────
// ≥5 rows so minNMet=true and the dynamic detail string is preserved (and testable).

describe('hygiene:url-inconsistency — detector unit (synthetic ctx)', () => {
  const rule = ruleFor('hygiene:url-inconsistency');
  const liveRow = url => ({ url, status: '200', redirected: '0' });

  it('fires on www vs non-www host mix (both 2xx)', () => {
    const ctx = {
      rows: [
        liveRow('http://example.com/'),
        liveRow('http://example.com/a'),
        liveRow('http://www.example.com/b'),
        liveRow('http://example.com/c'),
        liveRow('http://example.com/d'),
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'host-mix should fire');
    assert.ok(/www-\/Non-www-Mix/.test(findings[0].detail), `detail should name the host mix: ${findings[0].detail}`);
    assert.ok(/HEURISTIK/.test(findings[0].detail) && /KEIN Ranking-Faktor/.test(findings[0].detail),
      'detail carries HEURISTIC + not-ranking framing');
  });

  it('fires on trailing-slash inconsistency (/foo and /foo/ both 2xx)', () => {
    const ctx = {
      rows: [
        liveRow('http://example.com/foo'),
        liveRow('http://example.com/foo/'),
        liveRow('http://example.com/bar'),
        liveRow('http://example.com/baz'),
        liveRow('http://example.com/qux'),
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'trailing-slash inconsistency should fire');
    assert.ok(/Trailing-Slash/.test(findings[0].detail), `detail should mention trailing slash: ${findings[0].detail}`);
    assert.ok(findings[0].affectedUrls.includes('http://example.com/foo') &&
              findings[0].affectedUrls.includes('http://example.com/foo/'),
      'both slash variants should be in affectedUrls');
  });

  it('fires on per-URL hygiene heuristics (uppercase / underscore / session-id / over-length)', () => {
    const longUrl = 'http://example.com/' + 'x'.repeat(130); // > 115 chars
    const ctx = {
      rows: [
        liveRow('http://example.com/Path-With-Caps'),
        liveRow('http://example.com/snake_case_path'),
        liveRow('http://example.com/page;jsessionid=ABC123'),
        liveRow('http://example.com/list?sid=42'),
        liveRow(longUrl),
        liveRow('http://example.com/clean'),
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'per-URL hygiene heuristics should fire');
    const a = findings[0].affectedUrls;
    assert.ok(a.some(u => u.includes('Path-With-Caps')), 'uppercase path flagged');
    assert.ok(a.some(u => u.includes('snake_case_path')), 'underscore path flagged');
    assert.ok(a.some(u => u.includes('jsessionid=')), 'jsessionid flagged');
    assert.ok(a.some(u => u.includes('sid=42')), 'sid= flagged');
    assert.ok(a.some(u => u === longUrl), 'over-length URL flagged');
    assert.ok(!a.some(u => u.endsWith('/clean')), 'clean URL must NOT be flagged');
  });

  it('does NOT fire on a clean, single-host, lowercase URL set (positive)', () => {
    const ctx = {
      rows: [
        liveRow('http://example.com/'),
        liveRow('http://example.com/about'),
        liveRow('http://example.com/produkte/kaffee'),
        liveRow('http://example.com/blog/post-eins'),
        liveRow('http://example.com/kontakt'),
      ],
      signals: {}, linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'clean URL set must NOT fire');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT flag percent-encoded umlaut paths as uppercase (e.g. /über)', () => {
    const ctx = {
      rows: [
        liveRow('http://example.com/%C3%BCber-uns'), // /über-uns — upper-hex %XX must be ignored
        liveRow('http://example.com/a'),
        liveRow('http://example.com/b'),
        liveRow('http://example.com/c'),
        liveRow('http://example.com/d'),
      ],
      signals: {}, linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'percent-encoded umlaut must NOT trip the uppercase heuristic');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT flag a redirect SOURCE (redirected=1) even with a dirty URL', () => {
    const ctx = {
      rows: [
        { url: 'http://example.com/OLD_Path', status: '301', redirected: '1' }, // consolidating redirect → fine
        liveRow('http://example.com/a'),
        liveRow('http://example.com/b'),
        liveRow('http://example.com/c'),
        liveRow('http://example.com/d'),
      ],
      signals: {}, linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'redirect source must NOT be evaluated for hygiene');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── Integration: robots family via fixture-server robotsBody override ────────
// Real fetch + parseRobots → persisted signals.robots → detector. We read the
// persisted signals.json (robust even when Disallow: / yields 0 crawled pages).

describe('robots substance — integration via fixture robotsBody override', () => {
  async function signalsFor(robotsBody) {
    const srv = await startFixtureServer({ robotsBody });
    try {
      const r = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
      return JSON.parse(fs.readFileSync(r.signalsPath, 'utf8'));
    } finally {
      await srv.close();
    }
  }

  it('inject Disallow: / → tech:robots-site-blocked fires on real signals.robots', async () => {
    const signals = await signalsFor('User-agent: *\nDisallow: /\n');
    const { findings } = runRules({ rows: [], signals, linkgraph: {} }, [ruleFor('tech:robots-site-blocked')]);
    assert.strictEqual(findings.length, 1, `site-blocked should fire (disallow=${JSON.stringify(signals.robots?.disallow)})`);
  });

  it('inject a Noindex: line → tech:robots-noindex-directive fires on real signals.robots', async () => {
    const signals = await signalsFor('User-agent: *\nDisallow: /private/\nNoindex: /secret\nSitemap: http://demo.example/sitemap.xml\n');
    const { findings } = runRules({ rows: [], signals, linkgraph: {} }, [ruleFor('tech:robots-noindex-directive')]);
    assert.strictEqual(findings.length, 1, 'noindex-directive should fire on the injected robots.txt');
  });

  it('omit Sitemap: → tech:robots-no-sitemap fires on real signals.robots', async () => {
    const signals = await signalsFor('User-agent: *\nDisallow: /private/\n');
    const { findings } = runRules({ rows: [], signals, linkgraph: {} }, [ruleFor('tech:robots-no-sitemap')]);
    assert.strictEqual(findings.length, 1, `no-sitemap should fire (sitemapRefs=${JSON.stringify(signals.robots?.sitemapRefs)})`);
  });
});

// ── Default-fixture bookend: which new rules fire? (golden guard) ─────────────
// The default fixture robots.txt disallows only /private/, carries a Sitemap, and has
// no noindex directive → all three robots rules must be POSITIVES. The clean localhost
// fixture URL set is single-host, lowercase, no slash-twins → url-inconsistency POSITIVE.

describe('Batch 4a — default fixture bookend (new rules are positives)', () => {
  let srv, analysis;
  before(async () => {
    srv = await startFixtureServer();
    const r = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(r.csvPath, r.signalsPath);
  });
  after(() => srv.close());

  const isPositive = id => analysis.positives.some(p => p.ruleId === id);
  const isFinding  = id => analysis.findings.some(f => f.ruleId === id);

  it('tech:robots-site-blocked is a positive (fixture disallows only /private/)', () => {
    assert.ok(!isFinding('tech:robots-site-blocked') && isPositive('tech:robots-site-blocked'),
      'site-blocked must be a positive on the default fixture');
  });
  it('tech:robots-noindex-directive is a positive (no noindex directive in fixture robots.txt)', () => {
    assert.ok(!isFinding('tech:robots-noindex-directive') && isPositive('tech:robots-noindex-directive'),
      'noindex-directive must be a positive on the default fixture');
  });
  it('tech:robots-no-sitemap is a positive (fixture robots.txt references a Sitemap)', () => {
    assert.ok(!isFinding('tech:robots-no-sitemap') && isPositive('tech:robots-no-sitemap'),
      'no-sitemap must be a positive on the default fixture');
  });
  it('hygiene:url-inconsistency is a positive (clean single-host localhost fixture)', () => {
    assert.ok(!isFinding('hygiene:url-inconsistency') && isPositive('hygiene:url-inconsistency'),
      'url-inconsistency must be a positive on the clean fixture');
  });
});

// ── exists-gating consistency: robots-sitemap-conflict + robots-blocked-resources ─
// Both gated only on disallow.length; an UNREACHABLE robots.txt fail-closes to
// {exists:false, disallow:['/']}, which would otherwise flag every sitemap URL / render
// resource as "blocked" off a synthetic directive. They must gate on exists===true like
// their robots-substance siblings.

describe('tech:robots-sitemap-conflict — exists-gating', () => {
  const rule = ruleFor('tech:robots-sitemap-conflict');

  it('does NOT fire for fail-closed unreachable robots.txt {exists:false, disallow:[\'/\']}', () => {
    const ctx = {
      rows: FILLER(),
      signals: { robots: { exists: false, disallow: ['/'], allow: [] }, sitemapUrls: ['http://example.com/a', 'http://example.com/b'] },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'fail-closed (exists:false) must not flag sitemap URLs as blocked');
  });

  it('DOES fire for a genuine block {exists:true, disallow:[\'/\']}', () => {
    const ctx = {
      rows: FILLER(),
      signals: { robots: { exists: true, disallow: ['/'], allow: [] }, sitemapUrls: ['http://example.com/a'] },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'a real robots.txt that disallows a listed sitemap URL still fires');
  });
});

describe('tech:robots-blocked-resources — exists-gating', () => {
  const rule = ruleFor('tech:robots-blocked-resources');

  it('does NOT fire for fail-closed unreachable robots.txt {exists:false, disallow:[\'/\']}', () => {
    const ctx = {
      rows: [{ url: 'http://example.com/p.html', status: '200', redirected: '0', wordCount: '300', error: '', resourcePaths: '/assets/app.js' }],
      signals: { robots: { exists: false, disallow: ['/'], allow: [] } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0, 'fail-closed (exists:false) must not flag render resources as blocked');
  });

  it('DOES fire for a genuine block {exists:true} of a render resource', () => {
    const ctx = {
      rows: [{ url: 'http://example.com/p.html', status: '200', redirected: '0', wordCount: '300', error: '', resourcePaths: '/assets/app.js' }],
      signals: { robots: { exists: true, disallow: ['/assets/'], allow: [] } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'a real robots.txt that blocks a referenced render resource still fires');
  });
});
