/**
 * test/analyze.test.mjs — Unit D1 + D2 TDD tests for the Analyzer Engine + Rules.
 *
 * Tests run against the in-process fixture server.
 * runCrawl → analyzeFromFiles → assert findings against EXPECTED.md golden reference.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startFixtureServer } from './fixture-server.mjs';
import { runCrawl }           from '../crawl/run.mjs';
import { analyze, analyzeFromFiles } from '../analyze/analyze.mjs';
import { runRules, loadRules } from '../analyze/engine.mjs';

// ── Test isolation ─────────────────────────────────────────────────────────────
// The fixture server binds 127.0.0.1, so runCrawl's hostname-derived default dir
// (data/127.0.0.1/) is shared by every parallel test file and clobbers across them.
// Each integration suite gets its own unique dataDir via freshDataDir(); a single
// top-level after() hook removes them all once the file's tests complete.
const TMP_DATA_DIRS = [];
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
  TMP_DATA_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TMP_DATA_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

describe('analyzeFromFiles — engine + rules I', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  // ── schema-plausibility ────────────────────────────────────────────────────

  it('analysis has required top-level keys', () => {
    assert.ok(analysis.meta,                     'meta should exist');
    assert.ok(Array.isArray(analysis.findings),  'findings should be an array');
    assert.ok(Array.isArray(analysis.positives), 'positives should be an array');
    assert.ok(analysis.signals,                  'signals should exist');
    assert.ok(typeof analysis.rulesetVersion === 'string', 'rulesetVersion should be a string');
    assert.ok(analysis.rulesetVersion.length > 0,          'rulesetVersion should be non-empty');
  });

  it('meta has required fields with correct types', () => {
    const { meta } = analysis;
    assert.ok(typeof meta.pageCount === 'number', `meta.pageCount should be number, got ${typeof meta.pageCount}`);
    assert.ok(meta.pageCount > 0,                 'meta.pageCount should be > 0');
    assert.ok(typeof meta.minNMet === 'boolean',  'meta.minNMet should be boolean');
    assert.ok(meta.minNMet === true,              'meta.minNMet should be true for fixture (>=5 pages)');
    assert.ok(typeof meta.origin === 'string',    'meta.origin should be string');
    assert.ok(typeof meta.host === 'string',      'meta.host should be string');
  });

  it('findings each have required shape', () => {
    for (const f of analysis.findings) {
      assert.ok(typeof f.ruleId === 'string',        `finding.ruleId should be string: ${JSON.stringify(f)}`);
      assert.ok(typeof f.severity === 'string',      `finding.severity should be string: ${f.ruleId}`);
      assert.ok(typeof f.count === 'number',         `finding.count should be number: ${f.ruleId}`);
      assert.ok(f.count > 0,                         `finding.count should be > 0: ${f.ruleId}`);
      assert.ok(Array.isArray(f.affectedUrls),       `finding.affectedUrls should be array: ${f.ruleId}`);
      assert.ok(f.affectedUrls.length <= 10,         `finding.affectedUrls should be ≤10: ${f.ruleId}`);
    }
  });

  it('positives each have ruleId and title', () => {
    assert.ok(analysis.positives.length > 0, 'should have at least some positives');
    for (const p of analysis.positives) {
      assert.ok(typeof p.ruleId === 'string', `positive.ruleId should be string: ${JSON.stringify(p)}`);
      assert.ok(typeof p.title === 'string',  `positive.title should be string: ${JSON.stringify(p)}`);
    }
  });

  // ── Helper ─────────────────────────────────────────────────────────────────

  function findFinding(id) {
    return analysis.findings.find(f => f.ruleId === id);
  }

  // ── on-page rules ─────────────────────────────────────────────────────────

  it('onpage:title-missing hits missing-title.html', () => {
    const f = findFinding('onpage:title-missing');
    assert.ok(f, 'onpage:title-missing finding should exist');
    assert.ok(f.count >= 1, `count should be >= 1, got ${f.count}`);
    assert.ok(
      f.affectedUrls.some(u => u.includes('missing-title.html')),
      `missing-title.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  it('onpage:title-long hits long-title.html (>60 chars)', () => {
    const f = findFinding('onpage:title-long');
    assert.ok(f, 'onpage:title-long finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('long-title.html')),
      `long-title.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  it('onpage:title-dup hits both dup-title-a and dup-title-b (count ≥ 2)', () => {
    const f = findFinding('onpage:title-dup');
    assert.ok(f, 'onpage:title-dup finding should exist');
    assert.ok(f.count >= 2, `dup count should be >= 2, got ${f.count}`);
    assert.ok(
      f.affectedUrls.some(u => u.includes('dup-title-a.html')),
      `dup-title-a.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
    assert.ok(
      f.affectedUrls.some(u => u.includes('dup-title-b.html')),
      `dup-title-b.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  it('onpage:meta-dup hits both dup-meta-a and dup-meta-b', () => {
    const f = findFinding('onpage:meta-dup');
    assert.ok(f, 'onpage:meta-dup finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('dup-meta-a.html')),
      `dup-meta-a.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
    assert.ok(
      f.affectedUrls.some(u => u.includes('dup-meta-b.html')),
      `dup-meta-b.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  it('onpage:h1-multi hits multi-h1.html', () => {
    const f = findFinding('onpage:h1-multi');
    assert.ok(f, 'onpage:h1-multi finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('multi-h1.html')),
      `multi-h1.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  it('onpage:heading-skip hits multi-h1.html', () => {
    const f = findFinding('onpage:heading-skip');
    assert.ok(f, 'onpage:heading-skip finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('multi-h1.html')),
      `multi-h1.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  it('onpage:alt-missing hits no-alt.html', () => {
    const f = findFinding('onpage:alt-missing');
    assert.ok(f, 'onpage:alt-missing finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('no-alt.html')),
      `no-alt.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  it('onpage:thin hits thin.html but NOT client-rendered.html (js-guard suppressed)', () => {
    const f = findFinding('onpage:thin');
    assert.ok(f, 'onpage:thin finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('thin.html')),
      `thin.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
    assert.ok(
      !f.affectedUrls.some(u => u.includes('client-rendered.html')),
      `client-rendered.html must NOT be in thin affectedUrls (js-guard): ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  // U0.4a: pin updated framing strings (wording-only reframe, no logic change)
  it('onpage:thin — title und detail reflect 2026-06 reframe (keine Wortzahl-Schwelle)', () => {
    const f = findFinding('onpage:thin');
    assert.ok(f, 'onpage:thin finding should exist');
    assert.ok(
      f.title.includes('manueller Review-Hinweis'),
      `onpage:thin title should mention manueller Review-Hinweis, got: "${f.title}"`,
    );
    assert.ok(
      f.detail.includes('Wortzahl-Schwelle'),
      `onpage:thin detail should mention Wortzahl-Schwelle, got: "${f.detail}"`,
    );
  });

  // ── js-guard ───────────────────────────────────────────────────────────────

  it('crawl:client-rendered finding exists and contains client-rendered.html', () => {
    const f = findFinding('crawl:client-rendered');
    assert.ok(f, 'crawl:client-rendered finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('client-rendered.html')),
      `client-rendered.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  // ── schema rules ───────────────────────────────────────────────────────────

  it('schema:invalid hits invalid-schema.html', () => {
    const f = findFinding('schema:invalid');
    assert.ok(f, 'schema:invalid finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('invalid-schema.html')),
      `invalid-schema.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  it('schema:product-no-aggregate hits invalid-schema.html', () => {
    const f = findFinding('schema:product-no-aggregate');
    assert.ok(f, 'schema:product-no-aggregate finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('invalid-schema.html')),
      `invalid-schema.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  // ── tech rules ─────────────────────────────────────────────────────────────

  it('tech:noindex-conflict hits noindex.html', () => {
    const f = findFinding('tech:noindex-conflict');
    assert.ok(f, 'tech:noindex-conflict finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('noindex.html')),
      `noindex.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  it('tech:redirect-chain has count >= 1 and redirect-1 in affectedUrls', () => {
    const f = findFinding('tech:redirect-chain');
    assert.ok(f, 'tech:redirect-chain finding should exist');
    assert.ok(f.count >= 1, `tech:redirect-chain count should be >= 1, got ${f?.count ?? 'undefined'}`);
    assert.ok(
      f.affectedUrls.some(u => u.includes('redirect-1') && !u.includes('redirect-final')),
      `redirect-1 should be in tech:redirect-chain affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  // ── positives ─────────────────────────────────────────────────────────────

  it('positives contains rules with count=0 (e.g. schema:no-organization)', () => {
    // schema:no-organization fires only when NO page has hasOrg=1.
    // index.html has Organization LD → so this should be a positive.
    const pos = analysis.positives.find(p => p.ruleId === 'schema:no-organization');
    assert.ok(pos, 'schema:no-organization should appear in positives (fixture has org LD)');
  });

  // ── Important-3: tech:sitemap-quality flags redirected sitemap URLs ────────

  it('important-3: tech:sitemap-quality flags gone-page.html (410), noindex.html (noindex), and redirect-1 (redirected)', () => {
    const f = findFinding('tech:sitemap-quality');
    assert.ok(f, 'tech:sitemap-quality finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('gone-page.html')),
      `gone-page.html (410) should be in tech:sitemap-quality affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
    assert.ok(
      f.affectedUrls.some(u => u.includes('noindex.html')),
      `noindex.html (noindex) should be in tech:sitemap-quality affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
    assert.ok(
      f.affectedUrls.some(u => /\/redirect-1$/.test(u)),
      `redirect-1 (redirected) should be in tech:sitemap-quality affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  // ── Critical-1: redirected rows excluded from contentRows ─────────────────

  it('critical-1: redirect-1 must NOT appear in onpage:title-dup (redirected row excluded from contentRows)', () => {
    const f = findFinding('onpage:title-dup');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('redirect-1') && !u.includes('redirect-final')),
        `redirect-1 must NOT be in onpage:title-dup affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('critical-1: redirect-1 must NOT appear in tech:canonical-nonself (redirected row excluded)', () => {
    const f = findFinding('tech:canonical-nonself');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => /\/redirect-1$/.test(u)),
        `redirect-1 must NOT be in tech:canonical-nonself affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('critical-1: redirect-1 must NOT appear in onpage:thin (redirected row excluded from contentRows)', () => {
    const f = findFinding('onpage:thin');
    assert.ok(f, 'onpage:thin finding should exist');
    assert.ok(
      !f.affectedUrls.some(u => /\/redirect-1$/.test(u)),
      `redirect-1 must NOT be in onpage:thin affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });
});

// ── Unit D2 tests ─────────────────────────────────────────────────────────────

describe('analyzeFromFiles — engine + rules II (D2)', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  function findFinding(id) {
    return analysis.findings.find(f => f.ruleId === id);
  }

  // ── rulesetVersion updated ─────────────────────────────────────────────────

  it('rulesetVersion is bumped to 1.7.x (Batch 4a robots-substance + url-hygiene rules)', () => {
    assert.ok(
      analysis.rulesetVersion.startsWith('1.7.'),
      `rulesetVersion should start with 1.7., got ${analysis.rulesetVersion}`,
    );
  });

  // ── findings contain both D1 and D2 rule IDs ──────────────────────────────

  it('findings include at least one D1 rule ID (onpage:title-missing)', () => {
    const f = findFinding('onpage:title-missing');
    assert.ok(f, 'D1 rule onpage:title-missing should still be present');
  });

  it('findings include at least one D2 rule ID (geo:ai-bot-blocked)', () => {
    const f = findFinding('geo:ai-bot-blocked');
    assert.ok(f, 'D2 rule geo:ai-bot-blocked should be present');
  });

  // ── GEO rules ─────────────────────────────────────────────────────────────

  it('geo:ai-bot-blocked fires (OAI-SearchBot disallows /) and detail mentions ai-search', () => {
    const f = findFinding('geo:ai-bot-blocked');
    assert.ok(f, 'geo:ai-bot-blocked finding should exist');
    assert.ok(f.count >= 1, `count should be >= 1, got ${f.count}`);
    assert.ok(
      f.detail.includes('ai-search'),
      `detail should mention ai-search, got: ${f.detail}`,
    );
  });

  it('geo:llms-txt-malformed fires (fixture llms.txt is structurally invalid)', () => {
    const f = findFinding('geo:llms-txt-malformed');
    assert.ok(f, 'geo:llms-txt-malformed finding should exist');
    assert.ok(f.count >= 1, `count should be >= 1, got ${f.count}`);
  });

  it('geo:missing-citations fires on no-citations.html but NOT on thin.html or perfect.html (minCitationWords filter)', () => {
    const f = findFinding('geo:missing-citations');
    assert.ok(f, 'geo:missing-citations finding should exist');
    assert.ok(f.count > 0, `count should be > 0, got ${f.count}`);
    // perfect.html: outlinksAuthoritative >= 1 → must be excluded regardless of wordCount
    assert.ok(
      !f.affectedUrls.some(u => u.includes('perfect.html')),
      `perfect.html must NOT be in geo:missing-citations affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
    // no-citations.html: ~104 words (above minCitationWords), 0 authoritative outlinks → must be caught
    assert.ok(
      f.affectedUrls.some(u => u.includes('no-citations.html')),
      `no-citations.html must be in geo:missing-citations affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
    // thin.html: ~12 words (below minCitationWords) → must NOT be flagged despite having 0 outlinks
    assert.ok(
      !f.affectedUrls.some(u => u.includes('thin.html')),
      `thin.html must NOT be in geo:missing-citations affectedUrls (below minCitationWords): ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  // U0.4a: pin updated framing strings (wording-only reframe, no logic change)
  it('geo:missing-citations — title und detail reflect the outlinksExternal reframe (any external citation counts)', () => {
    const f = findFinding('geo:missing-citations');
    assert.ok(f, 'geo:missing-citations finding should exist');
    assert.ok(
      f.title.includes('externen Quellenangaben'),
      `geo:missing-citations title should mention externen Quellenangaben, got: "${f.title}"`,
    );
    assert.ok(
      f.detail.includes('externe Quellenangabe'),
      `geo:missing-citations detail should describe the missing external citation, got: "${f.detail}"`,
    );
  });

  // ── Schema rules (D2) ──────────────────────────────────────────────────────

  it('schema:org-missing-same-as fires on index.html (Org without sameAs)', () => {
    const f = findFinding('schema:org-missing-same-as');
    assert.ok(f, 'schema:org-missing-same-as finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.endsWith('/') || u.includes('index.html')),
      `index.html (or root) should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  it('schema:org-missing-same-as does NOT fire on perfect.html (Org has sameAs)', () => {
    const f = findFinding('schema:org-missing-same-as');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in schema:org-missing-same-as affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  // ── Crawl / link rules ────────────────────────────────────────────────────

  it('crawl:orphan-page fires for orphan.html ONLY (410 + redirect-source rows excluded)', () => {
    const f = findFinding('crawl:orphan-page');
    assert.ok(f, 'crawl:orphan-page finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('orphan.html')),
      `orphan.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
    // Only live (2xx), non-redirected pages can be genuine orphans. The 410 page
    // (/gone-page.html) and the redirect source (/redirect-1) are listed in
    // sitemap.xml but have no internal-link-equity defect to fix → must NOT appear.
    assert.ok(
      !f.affectedUrls.some(u => u.includes('gone-page.html')),
      `410 page must NOT be an orphan: ${JSON.stringify(f.affectedUrls)}`,
    );
    assert.ok(
      !f.affectedUrls.some(u => u.includes('redirect-1')),
      `redirect source must NOT be an orphan: ${JSON.stringify(f.affectedUrls)}`,
    );
    assert.strictEqual(f.count, 1,
      `only orphan.html should be flagged after the live/non-redirect filter, got ${f.count}: ${JSON.stringify(f.affectedUrls)}`);
  });

  it('links:deep is a positive for the fixture site (all pages at depth ≤ 1; depthByUrl is now populated)', () => {
    // After fix: depthByUrl IS persisted in signals.json. All fixture pages are reachable
    // from root in 0–1 click-steps (well within maxDepth=4). So count=0 → positive.
    // This assertion is now HONEST: it passes because the pages are shallow, not because
    // depthByUrl was always empty (dead code).
    const f = findFinding('links:deep');
    assert.ok(!f, `links:deep should be a positive (no finding), but got: ${JSON.stringify(f)}`);
    const pos = analysis.positives.find(p => p.ruleId === 'links:deep');
    assert.ok(pos, 'links:deep should appear in positives');
  });

  // ── Batch 4d: link-graph TARGET integrity (canonical/hreflang/internal-link) ──

  it('tech:canonical-target-broken is a positive on the fixture (self-canonical noindex owned by noindex-canonical-conflict)', () => {
    // The fixture's only candidate was noindex.html's SELF-referential canonical to its own noindex
    // row. That exact case is reported by tech:noindex-canonical-conflict, so canonical-target-broken
    // deliberately does not double-fire it; all other fixture canonicals resolve to live 2xx rows.
    const f = findFinding('tech:canonical-target-broken');
    assert.ok(!f, `tech:canonical-target-broken should be a positive (self-noindex de-duped), got: ${JSON.stringify(f)}`);
    const pos = analysis.positives.find(p => p.ruleId === 'tech:canonical-target-broken');
    assert.ok(pos, 'tech:canonical-target-broken should appear in positives');
  });

  it('i18n:hreflang-target-broken is a positive (fixture has no hreflang annotations)', () => {
    const f = findFinding('i18n:hreflang-target-broken');
    assert.ok(!f, `i18n:hreflang-target-broken should be a positive, but got: ${JSON.stringify(f)}`);
    const pos = analysis.positives.find(p => p.ruleId === 'i18n:hreflang-target-broken');
    assert.ok(pos, 'i18n:hreflang-target-broken should appear in positives');
  });

  it('links:internal-broken is a positive (no internal <a> links to a 4xx/5xx page in the fixture)', () => {
    // The 410 /gone-page.html is only in sitemap.xml, never linked via <a href> → no broken link.
    const f = findFinding('links:internal-broken');
    assert.ok(!f, `links:internal-broken should be a positive, but got: ${JSON.stringify(f)}`);
    const pos = analysis.positives.find(p => p.ruleId === 'links:internal-broken');
    assert.ok(pos, 'links:internal-broken should appear in positives');
  });

  it('links:internal-redirect is a positive (index.html links the FINAL /redirect-final.html, not /redirect-1)', () => {
    const f = findFinding('links:internal-redirect');
    assert.ok(!f, `links:internal-redirect should be a positive, but got: ${JSON.stringify(f)}`);
    const pos = analysis.positives.find(p => p.ruleId === 'links:internal-redirect');
    assert.ok(pos, 'links:internal-redirect should appear in positives');
  });

  // ── Performance rules ─────────────────────────────────────────────────────

  it('onpage:non-modern-image-format hits no-alt.html (4× JPG, no webp/avif)', () => {
    const f = findFinding('onpage:non-modern-image-format');
    assert.ok(f, 'onpage:non-modern-image-format finding should exist');
    assert.ok(
      f.affectedUrls.some(u => u.includes('no-alt.html')),
      `no-alt.html should be in affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
    );
  });

  it('onpage:non-modern-image-format does NOT hit perfect.html (uses webp)', () => {
    const f = findFinding('onpage:non-modern-image-format');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in onpage:non-modern-image-format affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  // ── Hygiene rules — positive (no fixture triggers) ─────────────────────────

  it('hygiene:oos-noindexed produces a positive (no OOS+noindex products in fixture)', () => {
    const f = findFinding('hygiene:oos-noindexed');
    assert.ok(!f, `hygiene:oos-noindexed should be a positive, but got: ${JSON.stringify(f)}`);
    const pos = analysis.positives.find(p => p.ruleId === 'hygiene:oos-noindexed');
    assert.ok(pos, 'hygiene:oos-noindexed should appear in positives');
  });

  it('hygiene:duplicate-content produces a positive (no full title+meta combos duplicated)', () => {
    const f = findFinding('hygiene:duplicate-content');
    assert.ok(!f, `hygiene:duplicate-content should be a positive (no same title+meta combo), got: ${JSON.stringify(f)}`);
    const pos = analysis.positives.find(p => p.ruleId === 'hygiene:duplicate-content');
    assert.ok(pos, 'hygiene:duplicate-content should appear in positives');
  });

  // ── tech:robots-sitemap-conflict integration test (U2-e) ──────────────────

  it('tech:robots-sitemap-conflict fires and affectedUrls contains private/secret.html (real fixture)', () => {
    const f = findFinding('tech:robots-sitemap-conflict');
    assert.ok(f, 'tech:robots-sitemap-conflict finding should exist (sitemap lists /private/secret.html which robots.txt disallows via Disallow: /private/)');
    assert.ok(
      f.affectedUrls.some(u => u.includes('private/secret.html')),
      `affectedUrls should contain a URL with private/secret.html: ${JSON.stringify(f.affectedUrls)}`,
    );
  });
});

// ── hygiene:oos-noindexed — detector unit tests ──────────────────────────────
// Inverted detector: flag OOS products that ARE noindexed (Google-contrary).
// OOS products WITHOUT noindex (correct per Google Mueller) must NOT be flagged.
// Tests use synthetic ctx rows — no fixture page needed, no EXPECTED.md churn.

describe('hygiene:oos-noindexed — detector unit (synthetic ctx)', () => {

  const oosNoindexedRule = {
    id:        'hygiene:oos-noindexed',
    kategorie: 'hygiene',
    scope:     'ecommerce',
    severity:  'mittel',
    title:     'Temporär ausverkaufte Produkte fälschlich deindexiert (noindex → Ranking-/Backlink-Verlust)',
    params:    {},
  };

  it('fires when OutOfStock product has noindex (fälschlich deindexiert)', () => {
    const url = 'http://example.com/produkt-oos-noindex.html';
    const ctx = {
      rows:    [{ url, availability: 'OutOfStock', robotsMeta: 'noindex' }],
      signals: {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [oosNoindexedRule]);
    assert.strictEqual(findings.length, 1, 'hygiene:oos-noindexed should fire for OutOfStock+noindex');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `OutOfStock+noindex URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('fires when SoldOut product has noindex (SoldOut-Variante)', () => {
    const url = 'http://example.com/produkt-soldout-noindex.html';
    const ctx = {
      rows:    [{ url, availability: 'SoldOut', robotsMeta: 'noindex, follow' }],
      signals: {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [oosNoindexedRule]);
    assert.strictEqual(findings.length, 1, 'hygiene:oos-noindexed should fire for SoldOut+noindex');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `SoldOut+noindex URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire when OOS product has no noindex (korrekt indexiert — Google-konform)', () => {
    const url = 'http://example.com/produkt-oos-korrekt.html';
    const ctx = {
      rows:    [{ url, availability: 'OutOfStock', robotsMeta: '' }],
      signals: {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [oosNoindexedRule]);
    assert.strictEqual(findings.length, 0, 'hygiene:oos-noindexed must NOT fire for OOS without noindex');
    assert.strictEqual(positives.length, 1, 'should yield a positive (OOS without noindex is correct)');
  });

  it('does NOT fire for non-OOS product with noindex', () => {
    const url = 'http://example.com/produkt-instock-noindex.html';
    const ctx = {
      rows:    [{ url, availability: 'InStock', robotsMeta: 'noindex' }],
      signals: {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [oosNoindexedRule]);
    assert.strictEqual(findings.length, 0, 'hygiene:oos-noindexed must NOT fire for non-OOS product');
  });
});

// ── Important-2: links:deep detector unit tests ───────────────────────────────
// These test the detector logic directly with synthetic ctx (no crawl, no file I/O).
// The integration path (runCrawl → analyzeFromFiles) is separately covered above;
// these unit tests verify the detector CAN fire when given real depth data.

describe('links:deep — detector unit (synthetic ctx)', () => {

  // Minimal rule descriptor matching config/rules/links.json
  const linksDeepRule = {
    id:        'links:deep',
    kategorie: 'links',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Seiten zu tief im Klick-Pfad',
    params:    { maxDepth: 4 },
  };

  it('fires when a URL has depth 5 > maxDepth 4', () => {
    const url = 'http://example.com/deep-page.html';
    const ctx = {
      rows:      [{ url, error: '', redirected: '0', wordCount: '500', status: '200' }],
      signals:   {},
      linkgraph: { depthByUrl: { [url]: 5 } },
    };
    const { findings, positives } = runRules(ctx, [linksDeepRule]);
    assert.strictEqual(findings.length, 1, 'links:deep should fire for depth 5 > maxDepth 4');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `deep URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
    assert.strictEqual(positives.length, 0, 'no positives when finding exists');
  });

  it('does NOT fire when depth exactly equals maxDepth 4 (boundary)', () => {
    const url = 'http://example.com/boundary.html';
    const ctx = {
      rows:      [{ url, error: '', redirected: '0', wordCount: '500', status: '200' }],
      signals:   {},
      linkgraph: { depthByUrl: { [url]: 4 } },
    };
    const { findings, positives } = runRules(ctx, [linksDeepRule]);
    assert.strictEqual(findings.length, 0, 'links:deep must NOT fire at exact boundary depth 4');
    assert.strictEqual(positives.length, 1, 'should yield a positive at boundary');
  });

  it('does NOT fire when depthByUrl is missing (no data → graceful fallback)', () => {
    const url = 'http://example.com/no-depth.html';
    const ctx = {
      rows:      [{ url, error: '', redirected: '0', wordCount: '200', status: '200' }],
      signals:   {},
      linkgraph: {},    // no depthByUrl key at all
    };
    const { findings, positives } = runRules(ctx, [linksDeepRule]);
    assert.strictEqual(findings.length, 0, 'links:deep should not fire when no depthByUrl available');
    assert.strictEqual(positives.length, 1, 'should yield a positive (graceful no-data)');
  });
});

// ── Important-3: @graph dates → schema:missing-dates false-positive fix ────────
// Tests the detector directly: an Article row whose datePublished comes from a
// Yoast/WordPress @graph payload must NOT be flagged as missing dates.

describe('schema:missing-dates — @graph Article is NOT flagged (Important-3)', () => {

  const missingDatesRule = {
    id:        'schema:missing-dates',
    kategorie: 'schema',
    scope:     'per-page',
    severity:  'mittel',
    title:     'Article ohne Publikationsdaten',
  };

  it('does NOT fire for an Article row with datePublished set (e.g. from @graph)', () => {
    // Simulates the CSV row parsePage produces from a Yoast/WordPress @graph payload
    // after the @graph date-traversal fix: ldTypes includes 'Article', datePublished set.
    const row = {
      url:           'http://example.com/article',
      ldTypes:       'WebSite,Article',
      datePublished: '2026-01-01',
      dateModified:  '2026-02-01',
    };
    const ctx = {
      rows:      [row],
      signals:   { robots: null, llms: null, aiBots: [] },
      linkgraph: { orphans: [], depthByUrl: {} },
    };
    const { findings, positives } = runRules(ctx, [missingDatesRule]);
    assert.strictEqual(
      findings.length, 0,
      `schema:missing-dates must NOT fire when Article has datePublished; got: ${JSON.stringify(findings)}`,
    );
    const pos = positives.find(p => p.ruleId === 'schema:missing-dates');
    assert.ok(pos, 'schema:missing-dates should appear in positives when Article has datePublished');
  });

  it('DOES fire for an Article row with no datePublished', () => {
    const row = {
      url:           'http://example.com/undated-article',
      ldTypes:       'Article',
      datePublished: '',
      dateModified:  '',
    };
    const ctx = {
      rows:      [row],
      signals:   { robots: null, llms: null, aiBots: [] },
      linkgraph: { orphans: [], depthByUrl: {} },
    };
    const { findings } = runRules(ctx, [missingDatesRule]);
    assert.strictEqual(
      findings.length, 1,
      `schema:missing-dates should fire for an Article with no datePublished; got: ${JSON.stringify(findings)}`,
    );
    assert.ok(
      findings[0].affectedUrls.includes(row.url),
      `undated article URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });
});

// ── U0.1: Coverage-Ehrlichkeit — synthetische analyze()-Tests ──────────────────
// Prüft, dass analyze() meta.coveragePct, meta.capped und meta.crawledAt aus
// signals.crawlMeta ableitet statt hartcodierter Werte (coveragePct:100, crawledAt:null).

describe('analyze() — Coverage-Ehrlichkeit (U0.1)', () => {
  const EMPTY_RULES = [];
  const BASE_LINKGRAPH = { orphans: [], depthByUrl: {} };

  function makeRows(n, urlBase = 'http://example.com/p') {
    return Array.from({ length: n }, (_, i) => ({
      url:        `${urlBase}${i}.html`,
      error:      '',
      redirected: '0',
      wordCount:  '500',
      status:     '200',
      title:      `Seite ${i}`,
    }));
  }

  it('sitemap-getrieben, gecappt: coveragePct=40, capped=true, crawledAt aus crawlMeta', () => {
    const rows = makeRows(4);
    const signals = {
      sitemapUrls: Array.from({ length: 10 }, (_, i) => `http://example.com/p${i}.html`),
      crawlMeta: { crawledAt: '2026-06-28T00:00:00.000Z', fetched: 4, discovered: 4, capped: true },
    };
    const result = analyze(rows, signals, BASE_LINKGRAPH, EMPTY_RULES);
    assert.strictEqual(result.meta.coveragePct, 40,
      `coveragePct soll 40 sein (4/10*100), bekam: ${result.meta.coveragePct}`);
    assert.strictEqual(result.meta.capped, true,
      'capped soll true sein');
    assert.strictEqual(result.meta.crawledAt, '2026-06-28T00:00:00.000Z',
      `crawledAt soll aus crawlMeta kommen, bekam: ${result.meta.crawledAt}`);
  });

  it('sitemap-getrieben, voll abgedeckt: coveragePct=100, capped=false', () => {
    const rows = makeRows(5);
    const signals = {
      sitemapUrls: Array.from({ length: 5 }, (_, i) => `http://example.com/p${i}.html`),
      crawlMeta: { crawledAt: '2026-06-28T12:00:00.000Z', fetched: 5, discovered: 5, capped: false },
    };
    const result = analyze(rows, signals, BASE_LINKGRAPH, EMPTY_RULES);
    assert.strictEqual(result.meta.coveragePct, 100,
      `coveragePct soll 100 sein (5/5*100), bekam: ${result.meta.coveragePct}`);
    assert.strictEqual(result.meta.capped, false,
      'capped soll false sein');
  });

  it('BFS-Modus (keine Sitemap): coveragePct=50 als Obergrenze (fetched=4, discovered=8)', () => {
    const rows = makeRows(4);
    const signals = {
      // sitemapUrls fehlt — BFS-Modus; discovered ist Obergrenze
      crawlMeta: { crawledAt: '2026-06-28T06:00:00.000Z', fetched: 4, discovered: 8, capped: true },
    };
    const result = analyze(rows, signals, BASE_LINKGRAPH, EMPTY_RULES);
    assert.strictEqual(result.meta.coveragePct, 50,
      `coveragePct soll 50 sein (4/8*100 Obergrenze), bekam: ${result.meta.coveragePct}`);
  });

  it('Fallback null wenn weder Sitemap noch discovered verfügbar', () => {
    const rows = makeRows(3);
    const signals = {};  // weder sitemapUrls noch crawlMeta
    const result = analyze(rows, signals, BASE_LINKGRAPH, EMPTY_RULES);
    assert.strictEqual(result.meta.coveragePct, null,
      `coveragePct soll null sein (konservativer Fallback), bekam: ${result.meta.coveragePct}`);
  });

  it('Determinismus: zwei identische Aufrufe liefern identisches meta', () => {
    const rows = makeRows(4);
    const signals = {
      sitemapUrls: Array.from({ length: 10 }, (_, i) => `http://example.com/p${i}.html`),
      crawlMeta: { crawledAt: '2026-06-28T00:00:00.000Z', fetched: 4, discovered: 4, capped: true },
    };
    const r1 = analyze(rows, signals, BASE_LINKGRAPH, EMPTY_RULES);
    const r2 = analyze(rows, signals, BASE_LINKGRAPH, EMPTY_RULES);
    assert.deepStrictEqual(r1.meta, r2.meta,
      'Zwei identische Aufrufe sollen identisches meta liefern');
  });
});

// ── U1-C Fix 1 — Redirect-Row-Guard in vier Detektoren ───────────────────────
// Jeder Detektor darf für eine redirected='1'-Row NICHT feuern (Fehl-Attribution verhindern).
// Gegenprobe: dieselbe Row ohne redirected feuert weiterhin (Logik unverändert).

describe('U1-C Fix 1 — schema:product-no-aggregate: redirected row excluded', () => {
  const rule = {
    id: 'schema:product-no-aggregate', kategorie: 'schema', scope: 'per-page',
    severity: 'mittel', title: 'Produkt ohne AggregateRating', params: {},
  };

  it('feuert NICHT für redirected=1 row (hasProduct=1, hasAgg=0)', () => {
    const url = 'http://example.com/redirect-src.html';
    const ctx = {
      rows:      [{ url, hasProduct: '1', hasAgg: '0', redirected: '1', wordCount: '500', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'schema:product-no-aggregate darf für redirected=1 nicht feuern');
    assert.strictEqual(positives.length, 1, 'soll als Positiv erscheinen');
  });

  it('feuert weiterhin ohne redirected (Gegenprobe)', () => {
    const url = 'http://example.com/product-no-agg.html';
    const ctx = {
      rows:      [{ url, hasProduct: '1', hasAgg: '0', wordCount: '500', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'schema:product-no-aggregate soll ohne redirected weiterhin feuern');
    assert.ok(findings[0].affectedUrls.includes(url), 'URL soll in affectedUrls sein');
  });
});

describe('U1-C Fix 1 — schema:missing-dates: redirected row excluded', () => {
  const rule = {
    id: 'schema:missing-dates', kategorie: 'schema', scope: 'per-page',
    severity: 'mittel', title: 'Article ohne Publikationsdaten', params: {},
  };

  it('feuert NICHT für redirected=1 row (Article ohne datePublished)', () => {
    const url = 'http://example.com/redirect-article.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'Article', datePublished: '', redirected: '1', wordCount: '500', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'schema:missing-dates darf für redirected=1 nicht feuern');
    assert.strictEqual(positives.length, 1, 'soll als Positiv erscheinen');
  });

  it('feuert weiterhin ohne redirected (Gegenprobe)', () => {
    const url = 'http://example.com/undated-article.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'Article', datePublished: '', wordCount: '500', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'schema:missing-dates soll ohne redirected weiterhin feuern');
    assert.ok(findings[0].affectedUrls.includes(url), 'URL soll in affectedUrls sein');
  });
});

describe('U1-C Fix 1 — schema:org-missing-same-as: redirected row excluded', () => {
  const rule = {
    id: 'schema:org-missing-same-as', kategorie: 'schema', scope: 'per-page',
    severity: 'mittel', title: 'Organization ohne sameAs', params: {},
  };

  it('feuert NICHT für redirected=1 row (hasOrg=1, hasOrgSameAs!=1)', () => {
    const url = 'http://example.com/redirect-org.html';
    const ctx = {
      rows:      [{ url, hasOrg: '1', hasOrgSameAs: '0', redirected: '1', wordCount: '500', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'schema:org-missing-same-as darf für redirected=1 nicht feuern');
    assert.strictEqual(positives.length, 1, 'soll als Positiv erscheinen');
  });

  it('feuert weiterhin ohne redirected (Gegenprobe)', () => {
    const url = 'http://example.com/org-no-sameas.html';
    const ctx = {
      rows:      [{ url, hasOrg: '1', hasOrgSameAs: '0', wordCount: '500', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'schema:org-missing-same-as soll ohne redirected weiterhin feuern');
    assert.ok(findings[0].affectedUrls.includes(url), 'URL soll in affectedUrls sein');
  });
});

describe('U1-C Fix 1 — hygiene:oos-noindexed: redirected row excluded', () => {
  const rule = {
    id: 'hygiene:oos-noindexed', kategorie: 'hygiene', scope: 'ecommerce',
    severity: 'mittel', title: 'OOS-Produkt fälschlich deindexiert', params: {},
  };

  it('feuert NICHT für redirected=1 row (OutOfStock + noindex)', () => {
    const url = 'http://example.com/redirect-oos.html';
    const ctx = {
      rows:      [{ url, availability: 'OutOfStock', robotsMeta: 'noindex', redirected: '1', wordCount: '500', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'hygiene:oos-noindexed darf für redirected=1 nicht feuern');
    assert.strictEqual(positives.length, 1, 'soll als Positiv erscheinen');
  });

  it('feuert weiterhin ohne redirected (Gegenprobe)', () => {
    const url = 'http://example.com/oos-noindex.html';
    const ctx = {
      rows:      [{ url, availability: 'OutOfStock', robotsMeta: 'noindex', wordCount: '500', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'hygiene:oos-noindexed soll ohne redirected weiterhin feuern');
    assert.ok(findings[0].affectedUrls.includes(url), 'URL soll in affectedUrls sein');
  });
});

// ── U1-C Fix 2 — Leere H1 zählt als fehlend (onpage:h1-missing) ──────────────
// Ein <h1></h1> liefert h1Count=1, r.h1='' → muss jetzt feuern.
// Eine echte H1 mit Text darf nicht feuern (Gegenprobe).

describe('U1-C Fix 2 — onpage:h1-missing: leere H1 zählt als fehlend', () => {
  const rule = {
    id: 'onpage:h1-missing', kategorie: 'on-page', scope: 'agnostic',
    severity: 'hoch', title: 'Fehlende oder leere H1-Überschrift', params: {},
  };

  it('feuert bei h1Count=1 und leerem h1-Text (leere H1)', () => {
    const url = 'http://example.com/empty-h1.html';
    const ctx = {
      rows:      [{ url, h1Count: '1', h1: '', wordCount: '300', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'onpage:h1-missing soll bei h1Count=1 und h1="" feuern (leere H1 ist fehlende H1)');
    assert.ok(findings[0].affectedUrls.includes(url), 'URL soll in affectedUrls sein');
  });

  it('feuert bei h1Count=1 und h1 nur Whitespace', () => {
    const url = 'http://example.com/whitespace-h1.html';
    const ctx = {
      rows:      [{ url, h1Count: '1', h1: '   ', wordCount: '300', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'onpage:h1-missing soll bei h1Count=1 und h1="   " feuern');
  });

  it('feuert NICHT bei h1Count=1 mit echtem H1-Text (Gegenprobe)', () => {
    const url = 'http://example.com/real-h1.html';
    const ctx = {
      rows:      [{ url, h1Count: '1', h1: 'Echte Überschrift', wordCount: '300', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'onpage:h1-missing darf bei echtem H1-Text nicht feuern');
    assert.strictEqual(positives.length, 1, 'soll als Positiv erscheinen');
  });

  it('feuert weiterhin bei h1Count=0 (keine H1 vorhanden)', () => {
    const url = 'http://example.com/no-h1.html';
    const ctx = {
      rows:      [{ url, h1Count: '0', h1: '', wordCount: '300', error: '' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'onpage:h1-missing soll bei h1Count=0 weiterhin feuern');
  });

  it('Regel-Titel in on-page.json lautet "Fehlende oder leere H1-Überschrift"', async () => {
    const { loadRules } = await import('../analyze/engine.mjs');
    const rules = loadRules(new URL('../config/rules', import.meta.url).pathname);
    const h1Rule = rules.find(r => r.id === 'onpage:h1-missing');
    assert.ok(h1Rule, 'onpage:h1-missing soll in den geladenen Regeln vorhanden sein');
    assert.strictEqual(h1Rule.title, 'Fehlende oder leere H1-Überschrift',
      `Regel-Titel soll aktualisiert sein, bekam: "${h1Rule.title}"`);
    assert.strictEqual(h1Rule.lastReviewed, '2026-06',
      `lastReviewed soll "2026-06" sein, bekam: "${h1Rule.lastReviewed}"`);
  });
});

// ── U1-B Critical Fix — normalizeUrl boundary gap in engine lookups ────────────
// crawl:orphan-page and links:deep use normalized key-space in their linkgraph
// structures (orphans[], depthByUrl{}), but the engine historically looked up
// those keys with the RAW r.url — causing silent mismatches on trailing-slash /
// index.html URL shapes (the common WordPress shape).
//
// Regression tests use synthetic ctx:
//   • orphan row crawled as "/about/"  → linkgraph.orphans has normalized "/about"
//   • deep row crawled as "/deep/"     → linkgraph.depthByUrl has normalized "/deep"
// Both must be detected by the engine after the fix.

describe('U1-B Critical — crawl:orphan-page: trailing-slash URL matched via normalizeUrl', () => {
  const orphanRule = {
    id:        'crawl:orphan-page',
    kategorie: 'links',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Seite ohne interne Eingangslinks',
    params:    {},
  };

  it('fires when orphan URL is stored normalized ("/about") but row.url is raw ("/about/")', () => {
    // Simulates the real pipeline: buildLinkGraph normalizes /about/ → /about in orphans[],
    // but the CSV row still carries the raw crawled URL /about/.
    const rawUrl  = 'http://example.com/about/';
    const normUrl = 'http://example.com/about';  // what buildLinkGraph stores in orphans
    const ctx = {
      rows:      [{ url: rawUrl, error: '', redirected: '0', wordCount: '300', status: '200' }],
      signals:   {},
      linkgraph: { orphans: [normUrl], depthByUrl: {} },
    };
    const { findings } = runRules(ctx, [orphanRule]);
    assert.strictEqual(
      findings.length, 1,
      `crawl:orphan-page must fire when orphan key is normalized "/about" and row.url is raw "/about/" — got: ${JSON.stringify(findings)}`,
    );
    // affectedUrls must use the DISPLAY (raw) URL, not the normalized key
    assert.ok(
      findings[0].affectedUrls.includes(rawUrl),
      `affectedUrls must contain the raw display URL "${rawUrl}": ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire when the same page has an inlink (not an orphan)', () => {
    const rawUrl = 'http://example.com/linked/';
    const ctx = {
      rows:      [{ url: rawUrl, error: '', redirected: '0', wordCount: '300', status: '200' }],
      signals:   {},
      // orphans list is empty — linked page has inlinks
      linkgraph: { orphans: [], depthByUrl: {} },
    };
    const { findings, positives } = runRules(ctx, [orphanRule]);
    assert.strictEqual(findings.length, 0, 'must not fire when orphans list is empty');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

describe('U1-B Critical — links:deep: trailing-slash URL matched via normalizeUrl', () => {
  const linksDeepRule = {
    id:        'links:deep',
    kategorie: 'links',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Seiten zu tief im Klick-Pfad',
    params:    { maxDepth: 4 },
  };

  it('fires when depthByUrl key is normalized ("/deep") but row.url is raw ("/deep/")', () => {
    // Simulates the real pipeline: buildLinkGraph stores normalized key /deep (no trailing slash),
    // but the CSV row carries the raw crawled URL /deep/.
    const rawUrl  = 'http://example.com/deep/';
    const normUrl = 'http://example.com/deep';   // what buildLinkGraph stores in depthByUrl
    const ctx = {
      rows:      [{ url: rawUrl, error: '', redirected: '0', wordCount: '200', status: '200' }],
      signals:   {},
      linkgraph: { orphans: [], depthByUrl: { [normUrl]: 5 } },
    };
    const { findings } = runRules(ctx, [linksDeepRule]);
    assert.strictEqual(
      findings.length, 1,
      `links:deep must fire when depthByUrl key is normalized "/deep" and row.url is raw "/deep/" (depth 5 > maxDepth 4) — got: ${JSON.stringify(findings)}`,
    );
    // affectedUrls must use the DISPLAY (raw) URL
    assert.ok(
      findings[0].affectedUrls.includes(rawUrl),
      `affectedUrls must contain the raw display URL "${rawUrl}": ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire when normalized depth is within limit', () => {
    const rawUrl  = 'http://example.com/shallow/';
    const normUrl = 'http://example.com/shallow';
    const ctx = {
      rows:      [{ url: rawUrl, error: '', redirected: '0', wordCount: '200', status: '200' }],
      signals:   {},
      linkgraph: { orphans: [], depthByUrl: { [normUrl]: 2 } },
    };
    const { findings, positives } = runRules(ctx, [linksDeepRule]);
    assert.strictEqual(findings.length, 0, 'must not fire when depth 2 <= maxDepth 4');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-a: onpage:html-lang-missing — detector unit (synthetic ctx) ────────────

describe('onpage:html-lang-missing — detector unit (synthetic ctx)', () => {

  const htmlLangRule = {
    id:        'onpage:html-lang-missing',
    kategorie: 'on-page',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Fehlendes lang-Attribut am <html>-Element (Barrierefreiheit & Sprach-Erkennung)',
    params:    {},
  };

  it('fires when htmlLang is empty string', () => {
    const url = 'http://example.com/no-lang.html';
    const ctx = {
      rows:      [{ url, htmlLang: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [htmlLangRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:html-lang-missing should fire when htmlLang is empty');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire when htmlLang is set (e.g. "de") — positive', () => {
    const url = 'http://example.com/with-lang.html';
    const ctx = {
      rows:      [{ url, htmlLang: 'de', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [htmlLangRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:html-lang-missing must NOT fire when htmlLang is "de"');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-a: onpage:meta-desc-length — detector unit (synthetic ctx) ─────────────

describe('onpage:meta-desc-length — detector unit (synthetic ctx)', () => {

  const metaDescLengthRule = {
    id:        'onpage:meta-desc-length',
    kategorie: 'on-page',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Meta-Beschreibung zu kurz oder zu lang (Snippet-Heuristik)',
    params:    { min: 70, max: 160 },
  };

  it('fires for metaDescLen:200 (too long, metaMissing:0)', () => {
    const url = 'http://example.com/long-meta.html';
    const ctx = {
      rows:      [{ url, metaDescLen: '200', metaMissing: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [metaDescLengthRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:meta-desc-length should fire for metaDescLen=200 (too long)');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('fires for metaDescLen:40 (too short, metaMissing:0)', () => {
    const url = 'http://example.com/short-meta.html';
    const ctx = {
      rows:      [{ url, metaDescLen: '40', metaMissing: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [metaDescLengthRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:meta-desc-length should fire for metaDescLen=40 (too short)');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire for metaDescLen:120 (within range) — positive', () => {
    const url = 'http://example.com/ok-meta.html';
    const ctx = {
      rows:      [{ url, metaDescLen: '120', metaMissing: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [metaDescLengthRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:meta-desc-length must NOT fire for metaDescLen=120 (within 70–160)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when metaMissing:1 (anti-overlap with onpage:meta-missing)', () => {
    const url = 'http://example.com/missing-meta.html';
    const ctx = {
      rows:      [{ url, metaDescLen: '0', metaMissing: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [metaDescLengthRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:meta-desc-length must NOT fire when metaMissing=1 (handled by onpage:meta-missing)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-a: onpage:title-short — detector unit (synthetic ctx) ─────────────────

describe('onpage:title-short — detector unit (synthetic ctx)', () => {

  const titleShortRule = {
    id:        'onpage:title-short',
    kategorie: 'on-page',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Seitentitel sehr kurz (Heuristik — kein Google-Mindestwert)',
    params:    { minTitle: 30 },
  };

  it('fires for titleLen:10 (shorter than minTitle 30)', () => {
    const url = 'http://example.com/short-title.html';
    const ctx = {
      rows:      [{ url, titleLen: '10', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [titleShortRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:title-short should fire for titleLen=10 (< minTitle 30)');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire for titleLen:0 — anti-overlap with onpage:title-missing', () => {
    const url = 'http://example.com/no-title.html';
    const ctx = {
      rows:      [{ url, titleLen: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [titleShortRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:title-short must NOT fire for titleLen=0 (missing title handled by onpage:title-missing)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for titleLen:45 (within acceptable range) — positive', () => {
    const url = 'http://example.com/ok-title.html';
    const ctx = {
      rows:      [{ url, titleLen: '45', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [titleShortRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:title-short must NOT fire for titleLen=45 (>= minTitle 30)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-a: links:dead-end — detector unit (synthetic ctx) ─────────────────────

describe('links:dead-end — detector unit (synthetic ctx)', () => {

  const deadEndRule = {
    id:        'links:dead-end',
    kategorie: 'links',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Sackgassen-Seite (keine ausgehenden internen Links — Link-Equity-Heuristik)',
    params:    {},
  };

  it('fires for outlinksInternal:0 (dead-end page)', () => {
    const url = 'http://example.com/dead-end.html';
    const ctx = {
      rows:      [{ url, outlinksInternal: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [deadEndRule]);
    assert.strictEqual(findings.length, 1,
      'links:dead-end should fire for outlinksInternal=0');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire for outlinksInternal:3 — positive', () => {
    const url = 'http://example.com/linked-page.html';
    const ctx = {
      rows:      [{ url, outlinksInternal: '3', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [deadEndRule]);
    assert.strictEqual(findings.length, 0,
      'links:dead-end must NOT fire when outlinksInternal=3');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-b: schema:missing-dates broadened to Article subtypes ─────────────────
// The existing detector matched only exact 'Article'. Broadened to ARTICLE_TYPES
// = {Article, NewsArticle, BlogPosting} per Google's Article structured-data doc.

describe('schema:missing-dates — broadened to Article subtypes (U2-b)', () => {

  const missingDatesRule = {
    id:        'schema:missing-dates',
    kategorie: 'structured-data',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Article-/News-/Blog-Schema ohne datePublished',
    params:    {},
  };

  it('fires for ldTypes:NewsArticle without datePublished', () => {
    const url = 'http://example.com/news-no-date.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'NewsArticle', datePublished: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [missingDatesRule]);
    assert.strictEqual(findings.length, 1,
      'schema:missing-dates should fire for NewsArticle without datePublished');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `NewsArticle URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('fires for ldTypes:BlogPosting without datePublished', () => {
    const url = 'http://example.com/blog-no-date.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'BlogPosting', datePublished: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [missingDatesRule]);
    assert.strictEqual(findings.length, 1,
      'schema:missing-dates should fire for BlogPosting without datePublished');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `BlogPosting URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('still fires for ldTypes:Article without datePublished (backward compat)', () => {
    const url = 'http://example.com/article-no-date.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'Article', datePublished: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [missingDatesRule]);
    assert.strictEqual(findings.length, 1,
      'schema:missing-dates should still fire for Article without datePublished');
  });

  it('does NOT fire for ldTypes:Article with datePublished set', () => {
    const url = 'http://example.com/article-with-date.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'Article', datePublished: '2024-01-01', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [missingDatesRule]);
    assert.strictEqual(findings.length, 0,
      'schema:missing-dates must NOT fire when Article has datePublished');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-b: schema:breadcrumb-missing — detector unit ──────────────────────────

describe('schema:breadcrumb-missing — detector unit (U2-b)', () => {

  const breadcrumbRule = {
    id:        'schema:breadcrumb-missing',
    kategorie: 'structured-data',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Tiefe Seite ohne BreadcrumbList-Schema (Breadcrumb-Rich-Result)',
    params:    { minDepth: 2 },
  };

  it('fires when page has depth>=2 and hasBreadcrumb:0', () => {
    // Use a URL that normalizes to itself (no trailing slash) to avoid needing normalizeUrl
    const url = 'http://example.com/a/b';
    const ctx = {
      rows:      [{ url, hasBreadcrumb: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: { depthByUrl: { [url]: 2 } },
    };
    const { findings } = runRules(ctx, [breadcrumbRule]);
    assert.strictEqual(findings.length, 1,
      'schema:breadcrumb-missing should fire for depth>=2 page without breadcrumb');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire for hasBreadcrumb:1 at depth 2', () => {
    const url = 'http://example.com/a/b';
    const ctx = {
      rows:      [{ url, hasBreadcrumb: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: { depthByUrl: { [url]: 2 } },
    };
    const { findings, positives } = runRules(ctx, [breadcrumbRule]);
    assert.strictEqual(findings.length, 0,
      'schema:breadcrumb-missing must NOT fire when breadcrumb is present');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire at depth 1 (shallow page below minDepth)', () => {
    const url = 'http://example.com/a/b';
    const ctx = {
      rows:      [{ url, hasBreadcrumb: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: { depthByUrl: { [url]: 1 } },
    };
    const { findings, positives } = runRules(ctx, [breadcrumbRule]);
    assert.strictEqual(findings.length, 0,
      'schema:breadcrumb-missing must NOT fire at depth 1 (below minDepth 2)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when depthByUrl has no entry for the url (graceful no-fire)', () => {
    const url = 'http://example.com/a/b';
    const ctx = {
      rows:      [{ url, hasBreadcrumb: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: { depthByUrl: {} },
    };
    const { findings, positives } = runRules(ctx, [breadcrumbRule]);
    assert.strictEqual(findings.length, 0,
      'schema:breadcrumb-missing must NOT fire when no depth data available (graceful)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-b: schema:article-no-author — detector unit ───────────────────────────

describe('schema:article-no-author — detector unit (U2-b)', () => {

  const articleNoAuthorRule = {
    id:        'schema:article-no-author',
    kategorie: 'structured-data',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Artikel-Schema ohne author (E-E-A-T-Signal — empfohlen)',
    params:    {},
  };

  it('fires for ldTypes:NewsArticle with hasAuthor:0', () => {
    const url = 'http://example.com/news-no-author.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'NewsArticle', hasAuthor: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [articleNoAuthorRule]);
    assert.strictEqual(findings.length, 1,
      'schema:article-no-author should fire for NewsArticle with no author');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire for ldTypes:Article with hasAuthor:1', () => {
    const url = 'http://example.com/article-with-author.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'Article', hasAuthor: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [articleNoAuthorRule]);
    assert.strictEqual(findings.length, 0,
      'schema:article-no-author must NOT fire when author is present');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for ldTypes:WebPage with hasAuthor:0 (non-article)', () => {
    const url = 'http://example.com/webpage-no-author.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'WebPage', hasAuthor: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [articleNoAuthorRule]);
    assert.strictEqual(findings.length, 0,
      'schema:article-no-author must NOT fire for non-article types (WebPage)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-b: schema:offer-no-price — detector unit ──────────────────────────────

describe('schema:offer-no-price — detector unit (U2-b)', () => {

  const offerNoPriceRule = {
    id:        'schema:offer-no-price',
    kategorie: 'structured-data',
    scope:     'ecommerce',
    severity:  'mittel',
    title:     'Produkt ohne Preis im Offer (price ist für Rich-Results erforderlich)',
    params:    {},
  };

  it('fires for hasProduct:1 with empty offerPrice', () => {
    const url = 'http://example.com/product-no-price.html';
    const ctx = {
      rows:      [{ url, hasProduct: '1', offerPrice: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [offerNoPriceRule]);
    assert.strictEqual(findings.length, 1,
      'schema:offer-no-price should fire for product with empty offerPrice');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire for hasProduct:1 with offerPrice:14.90', () => {
    const url = 'http://example.com/product-with-price.html';
    const ctx = {
      rows:      [{ url, hasProduct: '1', offerPrice: '14.90', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [offerNoPriceRule]);
    assert.strictEqual(findings.length, 0,
      'schema:offer-no-price must NOT fire when price is set');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for hasProduct:0 with empty offerPrice (not a product)', () => {
    const url = 'http://example.com/no-product-no-price.html';
    const ctx = {
      rows:      [{ url, hasProduct: '0', offerPrice: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [offerNoPriceRule]);
    assert.strictEqual(findings.length, 0,
      'schema:offer-no-price must NOT fire when hasProduct=0');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-b: schema:date-inconsistent — detector unit ───────────────────────────

describe('schema:date-inconsistent — detector unit (U2-b)', () => {

  const dateInconsistentRule = {
    id:        'schema:date-inconsistent',
    kategorie: 'structured-data',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Widersprüchliche Datumsangaben (dateModified vor datePublished)',
    params:    {},
  };

  it('fires when dateModified is before datePublished (logically impossible)', () => {
    const url = 'http://example.com/bad-dates.html';
    const ctx = {
      rows:      [{ url, datePublished: '2024-06-01', dateModified: '2024-01-15', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [dateInconsistentRule]);
    assert.strictEqual(findings.length, 1,
      'schema:date-inconsistent should fire when dateModified < datePublished');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire for normal dates (datePublished before dateModified)', () => {
    const url = 'http://example.com/good-dates.html';
    const ctx = {
      rows:      [{ url, datePublished: '2024-01-15', dateModified: '2024-06-01', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [dateInconsistentRule]);
    assert.strictEqual(findings.length, 0,
      'schema:date-inconsistent must NOT fire for normal date order');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when only datePublished is present (dateModified missing)', () => {
    const url = 'http://example.com/only-published.html';
    const ctx = {
      rows:      [{ url, datePublished: '2024-06-01', dateModified: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [dateInconsistentRule]);
    assert.strictEqual(findings.length, 0,
      'schema:date-inconsistent must NOT fire when only one date is present');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for equal datePublished and dateModified', () => {
    const url = 'http://example.com/equal-dates.html';
    const ctx = {
      rows:      [{ url, datePublished: '2024-06-01', dateModified: '2024-06-01', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [dateInconsistentRule]);
    assert.strictEqual(findings.length, 0,
      'schema:date-inconsistent must NOT fire for equal dates');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for unparseable date strings', () => {
    const url = 'http://example.com/bad-format.html';
    const ctx = {
      rows:      [{ url, datePublished: 'not-a-date', dateModified: 'also-not-a-date', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [dateInconsistentRule]);
    assert.strictEqual(findings.length, 0,
      'schema:date-inconsistent must NOT fire for unparseable dates');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-c: geo:ai-snippet-suppressed — detector unit (synthetic ctx) ───────────

describe('geo:ai-snippet-suppressed — detector unit (U2-c)', () => {

  const aiSnippetRule = {
    id:        'geo:ai-snippet-suppressed',
    kategorie: 'geo',
    scope:     'agnostic',
    severity:  'hoch',
    title:     'AI-Snippet unterdrückt (nosnippet / max-snippet:0 — keine AI-Overview-/AI-Mode-Zitierung)',
    params:    {},
  };

  it('fires for robotsMeta:nosnippet', () => {
    const url = 'http://example.com/nosnippet.html';
    const ctx = {
      rows:      [{ url, robotsMeta: 'nosnippet', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [aiSnippetRule]);
    assert.strictEqual(findings.length, 1,
      'geo:ai-snippet-suppressed should fire for robotsMeta=nosnippet');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('fires for robotsMeta:max-snippet:0', () => {
    const url = 'http://example.com/max-snippet-0.html';
    const ctx = {
      rows:      [{ url, robotsMeta: 'max-snippet:0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [aiSnippetRule]);
    assert.strictEqual(findings.length, 1,
      'geo:ai-snippet-suppressed should fire for robotsMeta=max-snippet:0');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('fires for robotsMeta:noindex, nosnippet (combined directive)', () => {
    const url = 'http://example.com/noindex-nosnippet.html';
    const ctx = {
      rows:      [{ url, robotsMeta: 'noindex, nosnippet', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [aiSnippetRule]);
    assert.strictEqual(findings.length, 1,
      'geo:ai-snippet-suppressed should fire for combined noindex, nosnippet');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire for robotsMeta:max-snippet:50 (snippet allowed)', () => {
    const url = 'http://example.com/max-snippet-50.html';
    const ctx = {
      rows:      [{ url, robotsMeta: 'max-snippet:50', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [aiSnippetRule]);
    assert.strictEqual(findings.length, 0,
      'geo:ai-snippet-suppressed must NOT fire for max-snippet:50');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for robotsMeta:max-image-preview:none (excluded by design — image-preview only)', () => {
    const url = 'http://example.com/max-image-preview.html';
    const ctx = {
      rows:      [{ url, robotsMeta: 'max-image-preview:none', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [aiSnippetRule]);
    assert.strictEqual(findings.length, 0,
      'geo:ai-snippet-suppressed must NOT fire for max-image-preview:none (image-preview only, no AI-text impact)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for empty robotsMeta', () => {
    const url = 'http://example.com/no-robots-meta.html';
    const ctx = {
      rows:      [{ url, robotsMeta: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [aiSnippetRule]);
    assert.strictEqual(findings.length, 0,
      'geo:ai-snippet-suppressed must NOT fire for empty robotsMeta');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-c: geo:content-stale — detector unit (synthetic ctx) ──────────────────

describe('geo:content-stale — detector unit (U2-c)', () => {

  const contentStaleRule = {
    id:        'geo:content-stale',
    kategorie: 'geo',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Artikel ohne dateModified (Recency-Signal fehlt)',
    params:    {},
  };

  it('fires for ldTypes:BlogPosting without dateModified', () => {
    const url = 'http://example.com/blog-no-datemodified.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'BlogPosting', dateModified: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [contentStaleRule]);
    assert.strictEqual(findings.length, 1,
      'geo:content-stale should fire for BlogPosting without dateModified');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire for ldTypes:Article with dateModified set', () => {
    const url = 'http://example.com/article-with-datemodified.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'Article', dateModified: '2024-06-01', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [contentStaleRule]);
    assert.strictEqual(findings.length, 0,
      'geo:content-stale must NOT fire when Article has dateModified');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for ldTypes:WebPage without dateModified (non-article type)', () => {
    const url = 'http://example.com/webpage-no-datemodified.html';
    const ctx = {
      rows:      [{ url, ldTypes: 'WebPage', dateModified: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [contentStaleRule]);
    assert.strictEqual(findings.length, 0,
      'geo:content-stale must NOT fire for non-article types (WebPage)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-d: Test 0 — ISO asset integrity (config/iso-codes.json) ───────────────

describe('U2-d: Test 0 — ISO asset integrity (config/iso-codes.json)', () => {
  let isoCodes;

  before(() => {
    isoCodes = JSON.parse(
      fs.readFileSync(new URL('../config/iso-codes.json', import.meta.url), 'utf8'),
    );
  });

  it('languages.length >= 180', () => {
    assert.ok(isoCodes.languages.length >= 180,
      `Expected >= 180 languages, got ${isoCodes.languages.length}`);
  });

  it('regions.length >= 245', () => {
    assert.ok(isoCodes.regions.length >= 245,
      `Expected >= 245 regions, got ${isoCodes.regions.length}`);
  });

  it('regions includes GB', () => {
    assert.ok(isoCodes.regions.includes('GB'), 'regions should include GB');
  });

  it('regions excludes UK, EU, UN', () => {
    assert.ok(!isoCodes.regions.includes('UK'), 'regions should NOT include UK');
    assert.ok(!isoCodes.regions.includes('EU'), 'regions should NOT include EU');
    assert.ok(!isoCodes.regions.includes('UN'), 'regions should NOT include UN');
  });

  it('languages includes a diverse sample', () => {
    const sample = [
      'de','en','fr','es','it','pt','nl','zh','ja','ko','ar','ru','pl','sv','cs',
      'el','tr','he','th','vi','id','uk','ro','hu','ga','cy','eu','gl','is','mt',
    ];
    for (const lang of sample) {
      assert.ok(isoCodes.languages.includes(lang),
        `languages should include '${lang}'`);
    }
  });
});

// ── U2-d: Test 1 — i18n:hreflang-invalid-code (synthetic ctx) ────────────────

describe('U2-d: Test 1 — i18n:hreflang-invalid-code (synthetic ctx)', () => {

  const rule = {
    id:        'i18n:hreflang-invalid-code',
    kategorie: 'i18n',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Ungültige hreflang-Codes',
    params:    {},
  };

  // Each invalid value must cause the detector to fire
  // Note: zh-Hant is VALID (ISO-15924 script subtag) — see validValues below.
  const invalidValues = ['en_US', 'en-UK', 'en-EU', 'es-419', 'US', 'zz', 'de-DEU'];
  for (const val of invalidValues) {
    it(`fires for invalid hreflang value: ${val}`, () => {
      const url = `http://example.com/invalid-${val.replace(/[^a-z0-9]/gi, '-')}.html`;
      const ctx = {
        rows:      [{ url, hreflang: val, wordCount: '300', error: '', redirected: '0' }],
        signals:   {},
        linkgraph: {},
      };
      const { findings } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 1,
        `i18n:hreflang-invalid-code should fire for invalid value '${val}'`);
      assert.ok(findings[0].affectedUrls.includes(url),
        `URL should be in affectedUrls for '${val}': ${JSON.stringify(findings[0].affectedUrls)}`);
    });
  }

  // Each valid value must NOT cause the detector to fire.
  // zh-Hant, zh-Hans, sr-Latn: valid ISO-15924 script subtags (lang-Script).
  // zh-Hant-HK: valid lang-Script-Region triple.
  const validValues = [
    'de', 'en-US', 'en-GB', 'de-AT', 'fr-CA', 'pt-BR', 'zh-CN', 'x-default',
    'zh-Hant', 'zh-Hans', 'sr-Latn', 'zh-Hant-HK',
  ];
  for (const val of validValues) {
    it(`does NOT fire for valid hreflang value: ${val}`, () => {
      const url = `http://example.com/valid-${val.replace(/[^a-z0-9]/gi, '-')}.html`;
      const ctx = {
        rows:      [{ url, hreflang: val, wordCount: '300', error: '', redirected: '0' }],
        signals:   {},
        linkgraph: {},
      };
      const { findings, positives } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 0,
        `i18n:hreflang-invalid-code must NOT fire for valid value '${val}'`);
      assert.strictEqual(positives.length, 1, `should yield a positive for '${val}'`);
    });
  }

  it('does NOT fire for multi-value row: de,en-US,x-default (all valid)', () => {
    const url = 'http://example.com/multi-valid.html';
    const ctx = {
      rows:      [{ url, hreflang: 'de,en-US,x-default', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'i18n:hreflang-invalid-code must NOT fire when all values are valid');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-d: Test 2 — i18n:hreflang-no-x-default (synthetic ctx) ───────────────

describe('U2-d: Test 2 — i18n:hreflang-no-x-default (synthetic ctx)', () => {

  const rule = {
    id:        'i18n:hreflang-no-x-default',
    kategorie: 'i18n',
    scope:     'agnostic',
    severity:  'info',
    title:     'hreflang-Cluster ohne x-default (empfohlen)',
    params:    {},
  };

  it('fires for hreflang:de,en-US (no x-default)', () => {
    const url = 'http://example.com/no-xdefault.html';
    const ctx = {
      rows:      [{ url, hreflang: 'de,en-US', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'i18n:hreflang-no-x-default should fire when no x-default present');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire for hreflang:de,en-US,x-default', () => {
    const url = 'http://example.com/with-xdefault.html';
    const ctx = {
      rows:      [{ url, hreflang: 'de,en-US,x-default', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'i18n:hreflang-no-x-default must NOT fire when x-default is present');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for a row with empty hreflang', () => {
    const url = 'http://example.com/no-hreflang.html';
    const ctx = {
      rows:      [{ url, hreflang: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'i18n:hreflang-no-x-default must NOT fire when hreflang is empty');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  // M-c: prove case-insensitive X-DEFAULT handling
  it('does NOT fire for hreflang:de,en-US,X-DEFAULT (uppercase — case-insensitive)', () => {
    const url = 'http://example.com/xdefault-upper.html';
    const ctx = {
      rows:      [{ url, hreflang: 'de,en-US,X-DEFAULT', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'i18n:hreflang-no-x-default must NOT fire for uppercase X-DEFAULT (case-insensitive)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-d: Test 3 — i18n:hreflang-on-noindex (synthetic ctx) ─────────────────

describe('U2-d: Test 3 — i18n:hreflang-on-noindex (synthetic ctx)', () => {

  const rule = {
    id:        'i18n:hreflang-on-noindex',
    kategorie: 'i18n',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'hreflang auf noindex-Seite',
    params:    {},
  };

  it('fires for hreflangCount:2, robotsMeta:noindex', () => {
    const url = 'http://example.com/hreflang-noindex.html';
    const ctx = {
      rows:      [{ url, hreflangCount: '2', robotsMeta: 'noindex', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'i18n:hreflang-on-noindex should fire for hreflangCount>0 + noindex');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire for hreflangCount:2, robotsMeta:""', () => {
    const url = 'http://example.com/hreflang-nonoindex.html';
    const ctx = {
      rows:      [{ url, hreflangCount: '2', robotsMeta: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'i18n:hreflang-on-noindex must NOT fire when no noindex');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for hreflangCount:0, robotsMeta:noindex', () => {
    const url = 'http://example.com/nohreflang-noindex.html';
    const ctx = {
      rows:      [{ url, hreflangCount: '0', robotsMeta: 'noindex', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'i18n:hreflang-on-noindex must NOT fire when hreflangCount=0');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-d: Test 4 — i18n:hreflang-canonical-conflict (synthetic ctx) ──────────

describe('U2-d: Test 4 — i18n:hreflang-canonical-conflict (synthetic ctx)', () => {

  const rule = {
    id:        'i18n:hreflang-canonical-conflict',
    kategorie: 'i18n',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'hreflang mit fremdem Canonical (Konflikt)',
    params:    {},
  };

  it('fires for hreflangCount:2, canonical:other, canonSelf:0', () => {
    const url = 'http://example.com/hreflang-conflict.html';
    const ctx = {
      rows:      [{
        url, hreflangCount: '2', canonical: 'http://example.com/other',
        canonSelf: '0', wordCount: '300', error: '', redirected: '0',
      }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'i18n:hreflang-canonical-conflict should fire for hreflang + non-self canonical');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire for hreflangCount:2, canonical:self, canonSelf:1', () => {
    const url = 'http://example.com/hreflang-selfcanon.html';
    const ctx = {
      rows:      [{
        url, hreflangCount: '2', canonical: 'http://example.com/self',
        canonSelf: '1', wordCount: '300', error: '', redirected: '0',
      }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'i18n:hreflang-canonical-conflict must NOT fire when canonSelf=1');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for hreflangCount:2, canonical:"", canonSelf:0 (no canonical set)', () => {
    const url = 'http://example.com/hreflang-nocanon.html';
    const ctx = {
      rows:      [{
        url, hreflangCount: '2', canonical: '',
        canonSelf: '0', wordCount: '300', error: '', redirected: '0',
      }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'i18n:hreflang-canonical-conflict must NOT fire when canonical is empty');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for hreflangCount:0, canonical:other, canonSelf:0 (no hreflang)', () => {
    const url = 'http://example.com/nohreflang-conflict.html';
    const ctx = {
      rows:      [{
        url, hreflangCount: '0', canonical: 'http://example.com/other',
        canonSelf: '0', wordCount: '300', error: '', redirected: '0',
      }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'i18n:hreflang-canonical-conflict must NOT fire when hreflangCount=0');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-e: tech:noindex-canonical-conflict — detector unit (synthetic ctx) ──────

describe('tech:noindex-canonical-conflict — detector unit (U2-e)', () => {

  const rule = {
    id:        'tech:noindex-canonical-conflict',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'noindex und canonical gleichzeitig (widersprüchliche Signale)',
    params:    {},
  };

  it('fires when page has noindex AND a non-empty canonical', () => {
    const url = 'http://example.com/noindex-canon.html';
    const ctx = {
      rows:      [{ url, robotsMeta: 'noindex', canonical: 'http://example.com/p', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'tech:noindex-canonical-conflict should fire for noindex + non-empty canonical');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire when page has noindex but canonical is empty (no conflict)', () => {
    const url = 'http://example.com/noindex-nocanon.html';
    const ctx = {
      rows:      [{ url, robotsMeta: 'noindex', canonical: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'tech:noindex-canonical-conflict must NOT fire when canonical is empty');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when page has canonical but no noindex (indexable + canonical = normal)', () => {
    const url = 'http://example.com/indexable-canon.html';
    const ctx = {
      rows:      [{ url, robotsMeta: '', canonical: 'http://example.com/p', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'tech:noindex-canonical-conflict must NOT fire when page is indexable (no noindex)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U2-e: tech:robots-sitemap-conflict — detector unit (synthetic ctx) ──────────

describe('tech:robots-sitemap-conflict — detector unit (U2-e)', () => {

  const rule = {
    id:        'tech:robots-sitemap-conflict',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Sitemap listet per robots.txt gesperrte URL',
    params:    {},
  };

  it('fires and includes /private/ URL but not /ok.html (prefix match)', () => {
    const privateUrl = 'http://x/private/secret.html';
    const okUrl      = 'http://x/ok.html';
    const ctx = {
      rows:      [],
      signals:   { sitemapUrls: [privateUrl, okUrl], robots: { exists: true, disallow: ['/private/'] } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'tech:robots-sitemap-conflict should fire when a sitemap URL is disallowed');
    assert.ok(
      findings[0].affectedUrls.includes(privateUrl),
      `private URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
    assert.ok(
      !findings[0].affectedUrls.includes(okUrl),
      `/ok.html must NOT be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire when robots.disallow is empty', () => {
    const ctx = {
      rows:      [],
      signals:   { sitemapUrls: ['http://x/private/secret.html'], robots: { exists: true, disallow: [] } },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'tech:robots-sitemap-conflict must NOT fire when disallow is empty');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when no sitemap URL matches any disallow prefix', () => {
    const ctx = {
      rows:      [],
      signals:   {
        sitemapUrls: ['http://x/public/page.html', 'http://x/about.html'],
        robots:      { exists: true, disallow: ['/private/'] },
      },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'tech:robots-sitemap-conflict must NOT fire when no sitemap URL is blocked');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U3.2a: tech:robots-sitemap-conflict — RFC-9309 upgrade (synthetic ctx) ───

describe('tech:robots-sitemap-conflict — RFC-9309 matcher upgrade (U3.2a)', () => {

  const rule = {
    id:        'tech:robots-sitemap-conflict',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Sitemap listet per robots.txt gesperrte URL',
    params:    {},
  };

  it('Allow-Override: /private/secret.html NOT flagged, /private/other.html IS flagged', () => {
    const secretUrl = 'http://x/private/secret.html';
    const otherUrl  = 'http://x/private/other.html';
    const ctx = {
      rows:      [],
      signals:   {
        sitemapUrls: [secretUrl, otherUrl],
        robots:      { exists: true, disallow: ['/private/'], allow: ['/private/secret.html'] },
      },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, 'should fire once (only other.html is blocked)');
    assert.ok(
      findings[0].affectedUrls.includes(otherUrl),
      `/private/other.html should be flagged: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
    assert.ok(
      !findings[0].affectedUrls.includes(secretUrl),
      `/private/secret.html must NOT be flagged (Allow overrides): ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('wildcard /*.pdf$ flags http://x/a.pdf (old prefix-match would miss this)', () => {
    const pdfUrl = 'http://x/a.pdf';
    const ctx = {
      rows:      [],
      signals:   {
        sitemapUrls: [pdfUrl],
        robots:      { exists: true, disallow: ['/*.pdf$'] },
      },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1, '/*.pdf$ should flag http://x/a.pdf');
    assert.ok(
      findings[0].affectedUrls.includes(pdfUrl),
      `pdfUrl should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });
});

// ── U2-e: tech:sitemap-scale-limit — detector unit (synthetic ctx) ──────────────

describe('tech:sitemap-scale-limit — detector unit (U2-e)', () => {

  // Use params:{maxLoc:2} override so we never build a 50001-element array.
  const rule = {
    id:        'tech:sitemap-scale-limit',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Sitemap überschreitet das 50.000-URL-Limit',
    params:    { maxLoc: 2 },
  };

  // 5 rows so minNMet=true and we get the real detail string (not kleine-Stichprobe)
  function makeRows(n) {
    return Array.from({ length: n }, (_, i) => ({
      url:        `http://example.com/p${i}.html`,
      error:      '',
      redirected: '0',
      wordCount:  '300',
      status:     '200',
    }));
  }

  it('fires when sitemapUrls.length > maxLoc (3 > 2)', () => {
    const ctx = {
      rows:      makeRows(5),
      signals:   { sitemapUrls: ['http://x/a', 'http://x/b', 'http://x/c'] },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'tech:sitemap-scale-limit should fire for 3 sitemapUrls when maxLoc=2');
    assert.strictEqual(findings[0].ruleId, 'tech:sitemap-scale-limit',
      'ruleId should be tech:sitemap-scale-limit');
    // M-b: site-level finding — affectedUrls must always be empty (no per-URL data)
    assert.deepStrictEqual(findings[0].affectedUrls, [],
      'tech:sitemap-scale-limit affectedUrls must be [] (site-level finding, no per-URL data)');
  });

  it('does NOT fire when sitemapUrls.length === maxLoc (2 = 2, boundary)', () => {
    const ctx = {
      rows:      makeRows(5),
      signals:   { sitemapUrls: ['http://x/a', 'http://x/b'] },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'tech:sitemap-scale-limit must NOT fire when count equals maxLoc (boundary)');
    assert.strictEqual(positives.length, 1, 'should yield a positive at boundary');
  });

  it('does NOT fire for empty/absent sitemapUrls', () => {
    const ctx = {
      rows:      makeRows(5),
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'tech:sitemap-scale-limit must NOT fire when sitemapUrls is absent');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U3.1: tech:sitemap-scale-limit — per-file-count path ─────────────────────

describe('tech:sitemap-scale-limit — per-file-count (U3.1)', () => {

  // maxLoc:5 so we never need large arrays
  const rule = {
    id:        'tech:sitemap-scale-limit',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Sitemap überschreitet das 50.000-URL-Limit',
    params:    { maxLoc: 5 },
  };

  function makeRows(n) {
    return Array.from({ length: n }, (_, i) => ({
      url:        `http://example.com/p${i}.html`,
      error:      '',
      redirected: '0',
      wordCount:  '300',
      status:     '200',
    }));
  }

  it('does NOT fire when no single file exceeds maxLoc even if union does (3+3=6 > 5)', () => {
    const ctx = {
      rows:      makeRows(5),
      signals:   {
        sitemapUrls:  Array.from({ length: 6 }, (_, i) => `http://x/p${i}`),
        sitemapFiles: [
          { url: 'http://x/a.xml', locCount: 3 },
          { url: 'http://x/b.xml', locCount: 3 },
        ],
      },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'should NOT fire: no single file > maxLoc=5, union of 6 must not trigger false positive');
  });

  it('fires when a single file has locCount > maxLoc (10 > 5)', () => {
    const ctx = {
      rows:      makeRows(5),
      signals:   {
        sitemapUrls:  Array.from({ length: 12 }, (_, i) => `http://x/p${i}`),
        sitemapFiles: [
          { url: 'http://x/big.xml',   locCount: 10 },
          { url: 'http://x/small.xml', locCount: 2  },
        ],
      },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'should fire: big.xml has 10 > maxLoc=5');
    assert.strictEqual(findings[0].ruleId, 'tech:sitemap-scale-limit');
    assert.deepStrictEqual(findings[0].affectedUrls, [], 'site-level finding — affectedUrls must be []');
  });
});

// ── U3.2b: isNoindex helper — content="none" coverage ────────────────────────
// Google robots-meta: `none` ≡ `noindex, nofollow`.
// All five detectors that check for noindex must also trigger on `none`.
// Tested via tech:noindex-canonical-conflict as the representative detector.

describe('U3.2b — isNoindex: content="none" fires tech:noindex-canonical-conflict (RED→GREEN)', () => {

  const rule = {
    id:        'tech:noindex-canonical-conflict',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'noindex und canonical gleichzeitig (widersprüchliche Signale)',
    params:    {},
  };

  // RED test (behavior change): `robotsMeta: 'none'` must fire (was NOT detected before helper)
  it('fires when robotsMeta is "none" AND canonical is set (content="none" ≡ noindex,nofollow)', () => {
    const url = 'http://example.com/none-canon.html';
    const ctx = {
      rows:      [{ url, robotsMeta: 'none', canonical: 'http://example.com/p', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'tech:noindex-canonical-conflict should fire for robotsMeta="none" + canonical (none ≡ noindex,nofollow)');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  // Regression guard: existing `noindex, nofollow` must still fire
  it('still fires for robotsMeta "noindex, nofollow" (regression guard)', () => {
    const url = 'http://example.com/noindex-nofollow-canon.html';
    const ctx = {
      rows:      [{ url, robotsMeta: 'noindex, nofollow', canonical: 'http://example.com/p', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'tech:noindex-canonical-conflict must still fire for noindex, nofollow (regression)');
  });

  // Over-match guard: `index, follow` must NOT fire
  it('does NOT fire for robotsMeta "index, follow" (over-match guard)', () => {
    const url = 'http://example.com/index-follow-canon.html';
    const ctx = {
      rows:      [{ url, robotsMeta: 'index, follow', canonical: 'http://example.com/p', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'tech:noindex-canonical-conflict must NOT fire for robotsMeta="index, follow"');
    assert.strictEqual(positives.length, 1, 'should yield a positive (indexable page)');
  });
});

// ── U4.1: tech:viewport-missing — detector unit (synthetic ctx) ───────────────

describe('U4.1 — tech:viewport-missing — detector unit (synthetic ctx)', () => {

  const viewportMissingRule = {
    id:        'tech:viewport-missing',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Fehlendes Viewport-Meta-Tag (Mobile Usability)',
    params:    {},
  };

  it('fires when viewportContent is empty string', () => {
    const url = 'http://example.com/no-viewport.html';
    const ctx = {
      rows:      [{ url, viewportContent: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [viewportMissingRule]);
    assert.strictEqual(findings.length, 1,
      'tech:viewport-missing should fire when viewportContent is empty');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire when viewportContent is set to a standard value', () => {
    const url = 'http://example.com/with-viewport.html';
    const ctx = {
      rows:      [{ url, viewportContent: 'width=device-width, initial-scale=1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [viewportMissingRule]);
    assert.strictEqual(findings.length, 0,
      'tech:viewport-missing must NOT fire when viewportContent is set');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U4.1: onpage:viewport-zoom-disabled — detector unit (synthetic ctx) ────────

describe('U4.1 — onpage:viewport-zoom-disabled — detector unit (synthetic ctx)', () => {

  const zoomDisabledRule = {
    id:        'onpage:viewport-zoom-disabled',
    kategorie: 'on-page',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Zoom/Skalierung im Viewport unterdrückt (Barrierefreiheit WCAG 2.2 SC 1.4.4)',
    params:    {},
  };

  it('fires when user-scalable=no is set', () => {
    const url = 'http://example.com/zoom-no.html';
    const ctx = {
      rows:      [{ url, viewportContent: 'width=device-width, user-scalable=no', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [zoomDisabledRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:viewport-zoom-disabled should fire for user-scalable=no');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('fires when maximum-scale=1 (clearly below 5)', () => {
    const url = 'http://example.com/scale-1.html';
    const ctx = {
      rows:      [{ url, viewportContent: 'width=device-width, initial-scale=1, maximum-scale=1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [zoomDisabledRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:viewport-zoom-disabled should fire for maximum-scale=1');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire when maximum-scale=2 (WCAG 200% boundary — scale 2 is WCAG-compliant, anti-overclaim)', () => {
    // RED against old <5 code: 2 < 5 = true → would fire (false-positive).
    // GREEN after fix:         2 < 2 = false → must NOT fire.
    const url = 'http://example.com/scale-2.html';
    const ctx = {
      rows:      [{ url, viewportContent: 'width=device-width, initial-scale=1, maximum-scale=2', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [zoomDisabledRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:viewport-zoom-disabled must NOT fire for maximum-scale=2 (WCAG SC 1.4.4 requires ≥200%=scale 2; scale=2 is compliant)');
    assert.strictEqual(positives.length, 1, 'should yield a positive at WCAG boundary');
  });

  it('does NOT fire when maximum-scale=3 (above WCAG boundary — no false-positive)', () => {
    // RED against old <5 code: 3 < 5 = true → would fire (false-positive).
    // GREEN after fix:         3 < 2 = false → must NOT fire.
    const url = 'http://example.com/scale-3.html';
    const ctx = {
      rows:      [{ url, viewportContent: 'width=device-width, initial-scale=1, maximum-scale=3', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [zoomDisabledRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:viewport-zoom-disabled must NOT fire for maximum-scale=3 (above WCAG 200% — no false-positive)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when maximum-scale=5 (well above WCAG boundary)', () => {
    const url = 'http://example.com/scale-5.html';
    const ctx = {
      rows:      [{ url, viewportContent: 'width=device-width, initial-scale=1, maximum-scale=5', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [zoomDisabledRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:viewport-zoom-disabled must NOT fire for maximum-scale=5');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for a normal responsive viewport without zoom restrictions', () => {
    const url = 'http://example.com/normal-viewport.html';
    const ctx = {
      rows:      [{ url, viewportContent: 'width=device-width, initial-scale=1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [zoomDisabledRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:viewport-zoom-disabled must NOT fire for normal viewport');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when viewportContent is empty (no viewport — different rule)', () => {
    const url = 'http://example.com/no-viewport.html';
    const ctx = {
      rows:      [{ url, viewportContent: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [zoomDisabledRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:viewport-zoom-disabled must NOT fire when viewport is absent (different rule handles that)');
  });
});

// ── U4.1: tech:charset-missing — detector unit (synthetic ctx) ────────────────

describe('U4.1 — tech:charset-missing — detector unit (synthetic ctx)', () => {

  const charsetMissingRule = {
    id:        'tech:charset-missing',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Fehlende UTF-8-Charset-Deklaration',
    params:    {},
  };

  it('fires when charsetOk is "0"', () => {
    const url = 'http://example.com/no-charset.html';
    const ctx = {
      rows:      [{ url, charsetOk: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [charsetMissingRule]);
    assert.strictEqual(findings.length, 1,
      'tech:charset-missing should fire when charsetOk is "0"');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire when charsetOk is "1"', () => {
    const url = 'http://example.com/has-charset.html';
    const ctx = {
      rows:      [{ url, charsetOk: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [charsetMissingRule]);
    assert.strictEqual(findings.length, 0,
      'tech:charset-missing must NOT fire when charsetOk is "1"');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U4.1: perfect.html clean assert — none of the 3 new rules fires ───────────

describe('U4.1 — perfect.html: none of the 3 new rules fires (integration clean assert)', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  function findFinding(id) {
    return analysis.findings.find(f => f.ruleId === id);
  }

  it('tech:viewport-missing does NOT fire on perfect.html', () => {
    const f = findFinding('tech:viewport-missing');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in tech:viewport-missing affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
    // If no finding at all, the rule is a positive — acceptable
  });

  it('onpage:viewport-zoom-disabled does NOT fire on perfect.html', () => {
    const f = findFinding('onpage:viewport-zoom-disabled');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in onpage:viewport-zoom-disabled affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('tech:charset-missing does NOT fire on perfect.html', () => {
    const f = findFinding('tech:charset-missing');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in tech:charset-missing affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });
});

// ── U4.2: onpage:og-missing — detector unit (synthetic ctx) ──────────────────

describe('U4.2 — onpage:og-missing — detector unit (synthetic ctx)', () => {

  const ogMissingRule = {
    id:        'onpage:og-missing',
    kategorie: 'on-page',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Unvollständiges Open-Graph-Markup (Social-/Link-Preview)',
    params:    {},
  };

  it('fires for partial OG (ogTitle present, ogImage and ogUrl absent)', () => {
    const url = 'http://example.com/partial-og.html';
    const ctx = {
      rows:      [{ url, ogTitle: 'My Title', ogImage: '', ogUrl: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [ogMissingRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:og-missing should fire when OG is partial');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire for complete OG (all three properties present)', () => {
    const url = 'http://example.com/complete-og.html';
    const ctx = {
      rows:      [{ url, ogTitle: 'My Title', ogImage: 'https://example.com/img.jpg', ogUrl: 'https://example.com/page', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [ogMissingRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:og-missing must NOT fire for complete OG');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for zero OG (none of the three properties present)', () => {
    const url = 'http://example.com/no-og.html';
    const ctx = {
      rows:      [{ url, ogTitle: '', ogImage: '', ogUrl: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [ogMissingRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:og-missing must NOT fire when zero OG properties are present');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U4.2: onpage:favicon-missing — detector unit (synthetic ctx) ─────────────

describe('U4.2 — onpage:favicon-missing — detector unit (synthetic ctx)', () => {

  const faviconMissingRule = {
    id:        'onpage:favicon-missing',
    kategorie: 'on-page',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Startseite ohne deklariertes Favicon (SERP-Darstellung)',
    params:    {},
  };

  it('fires for homepage row with hasFavicon "0"', () => {
    const url = 'http://example.com/';
    const ctx = {
      rows:      [{ url, hasFavicon: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [faviconMissingRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:favicon-missing should fire for homepage with hasFavicon="0"');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire for non-homepage with hasFavicon "0"', () => {
    const url = 'http://example.com/page.html';
    const ctx = {
      rows:      [{ url, hasFavicon: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [faviconMissingRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:favicon-missing must NOT fire for non-homepage');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for homepage with hasFavicon "1"', () => {
    const url = 'http://example.com/';
    const ctx = {
      rows:      [{ url, hasFavicon: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [faviconMissingRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:favicon-missing must NOT fire for homepage with hasFavicon="1"');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U4.2: tech:canonical-multiple — detector unit (synthetic ctx) ────────────

describe('U4.2 — tech:canonical-multiple — detector unit (synthetic ctx)', () => {

  const canonMultipleRule = {
    id:        'tech:canonical-multiple',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Mehrere widersprüchliche Canonical-Tags',
    params:    {},
  };

  it('fires when canonicalCount is "2"', () => {
    const url = 'http://example.com/multi-canon.html';
    const ctx = {
      rows:      [{ url, canonicalCount: '2', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [canonMultipleRule]);
    assert.strictEqual(findings.length, 1,
      'tech:canonical-multiple should fire when canonicalCount="2"');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire when canonicalCount is "1"', () => {
    const url = 'http://example.com/one-canon.html';
    const ctx = {
      rows:      [{ url, canonicalCount: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [canonMultipleRule]);
    assert.strictEqual(findings.length, 0,
      'tech:canonical-multiple must NOT fire when canonicalCount="1"');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U4.2: integration clean assert — perfect.html + homepage favicon ─────────

describe('U4.2 — integration clean assert: new rules do not fire on perfect.html / index.html', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  function findFinding(id) {
    return analysis.findings.find(f => f.ruleId === id);
  }

  it('onpage:og-missing does NOT fire on perfect.html', () => {
    const f = findFinding('onpage:og-missing');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in onpage:og-missing affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('onpage:favicon-missing does NOT fire on the homepage (index.html declares a favicon)', () => {
    const f = findFinding('onpage:favicon-missing');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => {
          try { return new URL(u).pathname === '/'; } catch { return false; }
        }),
        `homepage must NOT be in onpage:favicon-missing affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('onpage:favicon-missing does NOT fire on perfect.html', () => {
    const f = findFinding('onpage:favicon-missing');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in onpage:favicon-missing affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('tech:canonical-multiple does NOT fire on perfect.html', () => {
    const f = findFinding('tech:canonical-multiple');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in tech:canonical-multiple affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });
});

// ── U4.3: onpage:img-missing-dimensions — detector unit (synthetic ctx) ──────

describe('U4.3 — onpage:img-missing-dimensions — detector unit (synthetic ctx)', () => {

  const imgDimsRule = {
    id:        'onpage:img-missing-dimensions',
    kategorie: 'on-page',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Bilder ohne width/height (Layout-Shift / CLS)',
    params:    { minCount: 1 },
  };

  it('fires when imgNoDimensions is "2"', () => {
    const url = 'http://example.com/dims.html';
    const ctx = {
      rows:      [{ url, imgNoDimensions: '2', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [imgDimsRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:img-missing-dimensions should fire for imgNoDimensions="2"');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('fires when imgNoDimensions is "1"', () => {
    const url = 'http://example.com/one-missing.html';
    const ctx = {
      rows:      [{ url, imgNoDimensions: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [imgDimsRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:img-missing-dimensions should fire for imgNoDimensions="1"');
  });

  it('does NOT fire when imgNoDimensions is "0" (positive)', () => {
    const url = 'http://example.com/good-dims.html';
    const ctx = {
      rows:      [{ url, imgNoDimensions: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [imgDimsRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:img-missing-dimensions must NOT fire for imgNoDimensions="0"');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U4.3: onpage:lcp-image-lazy — detector unit (synthetic ctx) ──────────────

describe('U4.3 — onpage:lcp-image-lazy — detector unit (synthetic ctx)', () => {

  const lcpLazyRule = {
    id:        'onpage:lcp-image-lazy',
    kategorie: 'on-page',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Erstes Content-Bild lazy-geladen (LCP-Risiko)',
    params:    {},
  };

  it('fires when firstImgLazy is "1"', () => {
    const url = 'http://example.com/lazy-hero.html';
    const ctx = {
      rows:      [{ url, firstImgLazy: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [lcpLazyRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:lcp-image-lazy should fire for firstImgLazy="1"');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire when firstImgLazy is "0" (positive)', () => {
    const url = 'http://example.com/eager-hero.html';
    const ctx = {
      rows:      [{ url, firstImgLazy: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [lcpLazyRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:lcp-image-lazy must NOT fire for firstImgLazy="0"');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U4.3: integration clean assert — new rules do not fire on perfect.html ────

describe('U4.3 — integration clean assert: img-missing-dimensions + lcp-image-lazy do not fire on perfect.html', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  function findFinding(id) {
    return analysis.findings.find(f => f.ruleId === id);
  }

  it('onpage:img-missing-dimensions does NOT fire on perfect.html', () => {
    const f = findFinding('onpage:img-missing-dimensions');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in onpage:img-missing-dimensions affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('onpage:lcp-image-lazy does NOT fire on perfect.html', () => {
    const f = findFinding('onpage:lcp-image-lazy');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in onpage:lcp-image-lazy affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });
});

// ── U4.4: onpage:excessive-dom — detector unit (synthetic ctx) ────────────────

describe('U4.4 — onpage:excessive-dom — detector unit (synthetic ctx)', () => {
  const excessiveDomRule = {
    id:        'onpage:excessive-dom',
    kategorie: 'on-page',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Übermäßige DOM-Größe (Performance-Heuristik)',
    quelle:    'Lighthouse',
    datum:     '2024-06',
    params:    { maxNodes: 1400 },
  };

  it('fires when domNodeCount is 1500 (> 1400)', () => {
    const url = 'http://example.com/big-dom.html';
    const ctx = {
      rows:      [{ url, domNodeCount: '1500', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [excessiveDomRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:excessive-dom should fire when domNodeCount=1500');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('does NOT fire when domNodeCount is 500 (below threshold)', () => {
    const url = 'http://example.com/small-dom.html';
    const ctx = {
      rows:      [{ url, domNodeCount: '500', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [excessiveDomRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:excessive-dom must NOT fire when domNodeCount=500');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire at the boundary domNodeCount=1400 (must be strictly >)', () => {
    const url = 'http://example.com/boundary-dom.html';
    const ctx = {
      rows:      [{ url, domNodeCount: '1400', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [excessiveDomRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:excessive-dom must NOT fire at exactly domNodeCount=1400 (strictly >)');
  });
});

// ── U4.4: onpage:render-blocking-head — detector unit (synthetic ctx) ─────────

describe('U4.4 — onpage:render-blocking-head — detector unit (synthetic ctx)', () => {
  const renderBlockingRule = {
    id:        'onpage:render-blocking-head',
    kategorie: 'on-page',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Render-blockierende Ressourcen im <head>',
    quelle:    'MDN + web.dev',
    datum:     '2026-05',
    params:    { maxStyles: 4 },
  };

  it('fires when headBlockingScripts is 1 (blocking script present)', () => {
    const url = 'http://example.com/blocking-script.html';
    const ctx = {
      rows:      [{ url, headBlockingScripts: '1', headBlockingStyles: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [renderBlockingRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:render-blocking-head should fire when headBlockingScripts=1');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('fires when headBlockingStyles is 4 (>= maxStyles)', () => {
    const url = 'http://example.com/many-styles.html';
    const ctx = {
      rows:      [{ url, headBlockingScripts: '0', headBlockingStyles: '4', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [renderBlockingRule]);
    assert.strictEqual(findings.length, 1,
      'onpage:render-blocking-head should fire when headBlockingStyles=4 (>= maxStyles=4)');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('does NOT fire when headBlockingScripts=0, headBlockingStyles=1 (single stylesheet is normal)', () => {
    const url = 'http://example.com/one-style.html';
    const ctx = {
      rows:      [{ url, headBlockingScripts: '0', headBlockingStyles: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [renderBlockingRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:render-blocking-head must NOT fire for a single stylesheet');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire when headBlockingScripts=0, headBlockingStyles=3 (below maxStyles=4)', () => {
    const url = 'http://example.com/three-styles.html';
    const ctx = {
      rows:      [{ url, headBlockingScripts: '0', headBlockingStyles: '3', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [renderBlockingRule]);
    assert.strictEqual(findings.length, 0,
      'onpage:render-blocking-head must NOT fire for headBlockingStyles=3 (below maxStyles=4)');
    assert.strictEqual(positives.length, 1, 'should yield a positive (3 styles is below threshold)');
  });
});

// ── U4.4: integration clean assert — new rules do not fire on perfect.html ────

describe('U4.4 — integration clean assert: excessive-dom + render-blocking-head do not fire on perfect.html', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  function findFinding(id) {
    return analysis.findings.find(f => f.ruleId === id);
  }

  it('onpage:excessive-dom does NOT fire on perfect.html', () => {
    const f = findFinding('onpage:excessive-dom');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in onpage:excessive-dom affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('onpage:render-blocking-head does NOT fire on perfect.html', () => {
    const f = findFinding('onpage:render-blocking-head');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in onpage:render-blocking-head affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });
});

// ── U4.5: links:generic-anchor — detector unit (synthetic ctx) ────────────────

describe('U4.5 — links:generic-anchor — detector unit (synthetic ctx)', () => {

  const genericAnchorRule = {
    id:        'links:generic-anchor',
    kategorie: 'links',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Generischer oder leerer Linktext (Barrierefreiheit/Usability)',
    params:    { minCount: 1 },
  };

  it('fires when genericAnchorCount is 2 (> minCount=1)', () => {
    const url = 'http://example.com/generic-links.html';
    const ctx = {
      rows:      [{ url, genericAnchorCount: '2', emptyLinkCount: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [genericAnchorRule]);
    assert.strictEqual(findings.length, 1,
      'links:generic-anchor should fire when genericAnchorCount=2');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('fires when emptyLinkCount is 1 (>= minCount=1)', () => {
    const url = 'http://example.com/empty-links.html';
    const ctx = {
      rows:      [{ url, genericAnchorCount: '0', emptyLinkCount: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [genericAnchorRule]);
    assert.strictEqual(findings.length, 1,
      'links:generic-anchor should fire when emptyLinkCount=1');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire when both genericAnchorCount and emptyLinkCount are 0 (positive)', () => {
    const url = 'http://example.com/good-links.html';
    const ctx = {
      rows:      [{ url, genericAnchorCount: '0', emptyLinkCount: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [genericAnchorRule]);
    assert.strictEqual(findings.length, 0,
      'links:generic-anchor must NOT fire when both counts are 0');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U4.5: a11y:control-no-name — detector unit (synthetic ctx) ────────────────

describe('U4.5 — a11y:control-no-name — detector unit (synthetic ctx)', () => {

  const controlNoNameRule = {
    id:        'a11y:control-no-name',
    kategorie: 'a11y',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Interaktives Element ohne zugänglichen Namen (WCAG 4.1.2)',
    params:    { minCount: 1 },
  };

  it('fires when unlabeledControlCount is 1 (>= minCount=1)', () => {
    const url = 'http://example.com/no-name-control.html';
    const ctx = {
      rows:      [{ url, unlabeledControlCount: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [controlNoNameRule]);
    assert.strictEqual(findings.length, 1,
      'a11y:control-no-name should fire when unlabeledControlCount=1');
    assert.ok(findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('does NOT fire when unlabeledControlCount is 0 (positive)', () => {
    const url = 'http://example.com/named-controls.html';
    const ctx = {
      rows:      [{ url, unlabeledControlCount: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [controlNoNameRule]);
    assert.strictEqual(findings.length, 0,
      'a11y:control-no-name must NOT fire when unlabeledControlCount=0');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U4.5: integration clean assert — new rules do not fire on perfect.html ────

describe('U4.5 — integration clean assert: generic-anchor + control-no-name do not fire on perfect.html', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  function findFinding(id) {
    return analysis.findings.find(f => f.ruleId === id);
  }

  it('links:generic-anchor does NOT fire on perfect.html', () => {
    const f = findFinding('links:generic-anchor');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in links:generic-anchor affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('a11y:control-no-name does NOT fire on perfect.html', () => {
    const f = findFinding('a11y:control-no-name');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in a11y:control-no-name affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });
});

// ── U4.6: schema:aggregaterating-incomplete — detector unit (synthetic ctx) ──

describe('U4.6 — schema:aggregaterating-incomplete — detector unit (synthetic ctx)', () => {

  const aggRatingRule = {
    id:        'schema:aggregaterating-incomplete',
    kategorie: 'structured-data',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'AggregateRating unvollständig (ratingValue/-Count fehlt)',
    params:    {},
  };

  it('FIRE when hasAgg=1 and aggRatingValue is empty (count present)', () => {
    const url = 'http://example.com/p1.html';
    const ctx = {
      rows:      [{ url, hasAgg: '1', aggRatingValue: '', aggRatingCount: '50', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [aggRatingRule]);
    assert.strictEqual(findings.length, 1, 'should fire when aggRatingValue is empty');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('FIRE when hasAgg=1 and aggRatingCount is empty (value present)', () => {
    const url = 'http://example.com/p2.html';
    const ctx = {
      rows:      [{ url, hasAgg: '1', aggRatingValue: '4.5', aggRatingCount: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [aggRatingRule]);
    assert.strictEqual(findings.length, 1, 'should fire when aggRatingCount is empty');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('NO-FIRE (positive) when hasAgg=1 and both value + count present', () => {
    const url = 'http://example.com/p3.html';
    const ctx = {
      rows:      [{ url, hasAgg: '1', aggRatingValue: '4.5', aggRatingCount: '50', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [aggRatingRule]);
    assert.strictEqual(findings.length, 0, 'must NOT fire when both value and count are present');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('NO-FIRE when hasAgg=0 (disjoint from schema:product-no-aggregate)', () => {
    const url = 'http://example.com/p4.html';
    const ctx = {
      rows:      [{ url, hasAgg: '0', aggRatingValue: '', aggRatingCount: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [aggRatingRule]);
    assert.strictEqual(findings.length, 0, 'must NOT fire when hasAgg=0');
  });
});

// ── U4.6: schema:merchant-shipping-returns — detector unit (synthetic ctx) ───

describe('U4.6 — schema:merchant-shipping-returns — detector unit (synthetic ctx)', () => {

  const merchantRule = {
    id:        'schema:merchant-shipping-returns',
    kategorie: 'structured-data',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Product/Offer ohne shippingDetails/Rückgabepolicy (empfohlen)',
    params:    {},
  };

  it('FIRE when hasProduct=1 and hasShippingDetails=0 (hasReturnPolicy=1)', () => {
    const url = 'http://example.com/shop1.html';
    const ctx = {
      rows:      [{ url, hasProduct: '1', hasShippingDetails: '0', hasReturnPolicy: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [merchantRule]);
    assert.strictEqual(findings.length, 1, 'should fire when shippingDetails missing');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('FIRE when hasProduct=1 and hasReturnPolicy=0 (hasShippingDetails=1)', () => {
    const url = 'http://example.com/shop2.html';
    const ctx = {
      rows:      [{ url, hasProduct: '1', hasShippingDetails: '1', hasReturnPolicy: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [merchantRule]);
    assert.strictEqual(findings.length, 1, 'should fire when returnPolicy missing');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('NO-FIRE (positive) when hasProduct=1 and both shippingDetails=1 + returnPolicy=1', () => {
    const url = 'http://example.com/shop3.html';
    const ctx = {
      rows:      [{ url, hasProduct: '1', hasShippingDetails: '1', hasReturnPolicy: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [merchantRule]);
    assert.strictEqual(findings.length, 0, 'must NOT fire when both present');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('NO-FIRE when hasProduct=0', () => {
    const url = 'http://example.com/shop4.html';
    const ctx = {
      rows:      [{ url, hasProduct: '0', hasShippingDetails: '0', hasReturnPolicy: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [merchantRule]);
    assert.strictEqual(findings.length, 0, 'must NOT fire when hasProduct=0');
  });
});

// ── U4.6: schema:organization-logo — detector unit (synthetic ctx) ────────────

describe('U4.6 — schema:organization-logo — detector unit (synthetic ctx)', () => {

  const orgLogoRule = {
    id:        'schema:organization-logo',
    kategorie: 'structured-data',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Organization ohne logo',
    params:    {},
  };

  it('FIRE when hasOrg=1 and hasOrgLogo=0', () => {
    const url = 'http://example.com/org1.html';
    const ctx = {
      rows:      [{ url, hasOrg: '1', hasOrgLogo: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [orgLogoRule]);
    assert.strictEqual(findings.length, 1, 'should fire when hasOrg=1 and hasOrgLogo=0');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('NO-FIRE (positive) when hasOrg=1 and hasOrgLogo=1', () => {
    const url = 'http://example.com/org2.html';
    const ctx = {
      rows:      [{ url, hasOrg: '1', hasOrgLogo: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [orgLogoRule]);
    assert.strictEqual(findings.length, 0, 'must NOT fire when hasOrgLogo=1');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('NO-FIRE when hasOrg=0', () => {
    const url = 'http://example.com/org3.html';
    const ctx = {
      rows:      [{ url, hasOrg: '0', hasOrgLogo: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [orgLogoRule]);
    assert.strictEqual(findings.length, 0, 'must NOT fire when hasOrg=0');
  });
});

// ── U4.6: schema:organization-contact — detector unit (synthetic ctx) ─────────

describe('U4.6 — schema:organization-contact — detector unit (synthetic ctx)', () => {

  const orgContactRule = {
    id:        'schema:organization-contact',
    kategorie: 'structured-data',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Organization ohne contactPoint',
    params:    {},
  };

  it('FIRE when hasOrg=1 and hasOrgContactPoint=0', () => {
    const url = 'http://example.com/org4.html';
    const ctx = {
      rows:      [{ url, hasOrg: '1', hasOrgContactPoint: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [orgContactRule]);
    assert.strictEqual(findings.length, 1, 'should fire when hasOrg=1 and hasOrgContactPoint=0');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('NO-FIRE (positive) when hasOrg=1 and hasOrgContactPoint=1', () => {
    const url = 'http://example.com/org5.html';
    const ctx = {
      rows:      [{ url, hasOrg: '1', hasOrgContactPoint: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [orgContactRule]);
    assert.strictEqual(findings.length, 0, 'must NOT fire when hasOrgContactPoint=1');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('NO-FIRE when hasOrg=0', () => {
    const url = 'http://example.com/org6.html';
    const ctx = {
      rows:      [{ url, hasOrg: '0', hasOrgContactPoint: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [orgContactRule]);
    assert.strictEqual(findings.length, 0, 'must NOT fire when hasOrg=0');
  });
});

// ── U4.6: integration clean assert — new rules do not fire on perfect.html ────

describe('U4.6 — integration clean assert: 4 new structured-data rules do not fire on perfect.html', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  function findFinding(id) {
    return analysis.findings.find(f => f.ruleId === id);
  }

  it('schema:aggregaterating-incomplete does NOT fire on perfect.html', () => {
    const f = findFinding('schema:aggregaterating-incomplete');
    // `if (f)` guard is intentional: no fixture page has hasAgg=1, so the finding
    // may legitimately be absent — that is an acceptable clean state, not a gap.
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in schema:aggregaterating-incomplete affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('schema:merchant-shipping-returns does NOT fire on perfect.html', () => {
    const f = findFinding('schema:merchant-shipping-returns');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in schema:merchant-shipping-returns affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('schema:organization-logo does NOT fire on perfect.html', () => {
    const f = findFinding('schema:organization-logo');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in schema:organization-logo affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('schema:organization-contact does NOT fire on perfect.html', () => {
    const f = findFinding('schema:organization-contact');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in schema:organization-contact affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });
});

// ── U4.7: tech:x-robots-noindex — detector unit (synthetic ctx) ───────────────

describe('tech:x-robots-noindex — detector unit (synthetic ctx)', () => {
  const xRobotsRule = {
    id:        'tech:x-robots-noindex',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'X-Robots-Tag: noindex im HTTP-Header (oft unsichtbar)',
    params:    {},
  };

  it('FIRE when xRobotsTag:"noindex"', () => {
    const url = 'http://example.com/noindex-header.html';
    const ctx = {
      rows:      [{ url, xRobotsTag: 'noindex', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [xRobotsRule]);
    assert.strictEqual(findings.length, 1,
      'tech:x-robots-noindex should fire when xRobotsTag="noindex"');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('FIRE when xRobotsTag:"none" (none ≡ noindex,nofollow)', () => {
    const url = 'http://example.com/none-header.html';
    const ctx = {
      rows:      [{ url, xRobotsTag: 'none', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [xRobotsRule]);
    assert.strictEqual(findings.length, 1,
      'tech:x-robots-noindex should fire when xRobotsTag="none"');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('NO-FIRE + positive when xRobotsTag:""', () => {
    const url = 'http://example.com/no-header.html';
    const ctx = {
      rows:      [{ url, xRobotsTag: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [xRobotsRule]);
    assert.strictEqual(findings.length, 0,
      'tech:x-robots-noindex must NOT fire when xRobotsTag is empty');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('NO-FIRE when xRobotsTag:"index, follow"', () => {
    const url = 'http://example.com/index-follow.html';
    const ctx = {
      rows:      [{ url, xRobotsTag: 'index, follow', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [xRobotsRule]);
    assert.strictEqual(findings.length, 0,
      'tech:x-robots-noindex must NOT fire when xRobotsTag="index, follow"');
  });
});

// ── U4.7: tech:hsts-missing — detector unit (synthetic ctx) ──────────────────

describe('tech:hsts-missing — detector unit (synthetic ctx)', () => {
  const hstsRule = {
    id:        'tech:hsts-missing',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'HTTPS-Seite ohne HSTS-Header (Security-Härtung)',
    params:    {},
  };

  it('FIRE when httpsOk:"1" and hstsPresent:"0"', () => {
    const url = 'https://example.com/https-no-hsts.html';
    const ctx = {
      rows:      [{ url, httpsOk: '1', hstsPresent: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [hstsRule]);
    assert.strictEqual(findings.length, 1,
      'tech:hsts-missing should fire when httpsOk=1 and hstsPresent=0');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('NO-FIRE + positive when httpsOk:"1" and hstsPresent:"1"', () => {
    const url = 'http://example.com/https-with-hsts.html';
    const ctx = {
      rows:      [{ url, httpsOk: '1', hstsPresent: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [hstsRule]);
    assert.strictEqual(findings.length, 0,
      'tech:hsts-missing must NOT fire when hstsPresent=1');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('NO-FIRE when httpsOk:"0" and hstsPresent:"0" — http page gated out', () => {
    const url = 'http://example.com/http-page.html';
    const ctx = {
      rows:      [{ url, httpsOk: '0', hstsPresent: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [hstsRule]);
    assert.strictEqual(findings.length, 0,
      'tech:hsts-missing must NOT fire on http pages (httpsOk=0)');
  });
});

// ── U4.7: tech:frame-protection-missing — detector unit (synthetic ctx) ───────

describe('tech:frame-protection-missing — detector unit (synthetic ctx)', () => {
  const frameRule = {
    id:        'tech:frame-protection-missing',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Kein Clickjacking-Schutz (X-Frame-Options / CSP frame-ancestors)',
    params:    {},
  };

  it('FIRE when frameProtection:"0"', () => {
    const url = 'http://example.com/no-frame-guard.html';
    const ctx = {
      rows:      [{ url, frameProtection: '0', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [frameRule]);
    assert.strictEqual(findings.length, 1,
      'tech:frame-protection-missing should fire when frameProtection=0');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('NO-FIRE + positive when frameProtection:"1"', () => {
    const url = 'http://example.com/frame-guarded.html';
    const ctx = {
      rows:      [{ url, frameProtection: '1', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [frameRule]);
    assert.strictEqual(findings.length, 0,
      'tech:frame-protection-missing must NOT fire when frameProtection=1');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U4.7: perf:text-compression-missing — detector unit (synthetic ctx) ───────

describe('perf:text-compression-missing — detector unit (synthetic ctx)', () => {
  const compressionRule = {
    id:        'perf:text-compression-missing',
    kategorie: 'performance',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'HTML ohne Text-Kompression (gzip/Brotli)',
    params:    {},
  };

  it('FIRE when contentEncoding:""', () => {
    const url = 'http://example.com/no-encoding.html';
    const ctx = {
      rows:      [{ url, contentEncoding: '', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [compressionRule]);
    assert.strictEqual(findings.length, 1,
      'perf:text-compression-missing should fire when contentEncoding is empty');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('NO-FIRE + positive when contentEncoding:"gzip"', () => {
    const url = 'http://example.com/gzip-encoded.html';
    const ctx = {
      rows:      [{ url, contentEncoding: 'gzip', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [compressionRule]);
    assert.strictEqual(findings.length, 0,
      'perf:text-compression-missing must NOT fire when contentEncoding=gzip');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('NO-FIRE when contentEncoding:"br"', () => {
    const url = 'http://example.com/brotli-encoded.html';
    const ctx = {
      rows:      [{ url, contentEncoding: 'br', wordCount: '300', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [compressionRule]);
    assert.strictEqual(findings.length, 0,
      'perf:text-compression-missing must NOT fire when contentEncoding=br');
  });
});

// ── U4.7: integration clean assert — new rules do not fire on perfect.html ────

describe('U4.7 — integration clean assert: 4 new header rules do not fire on perfect.html', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    // Well-configured server: inject X-Frame-Options + gzip compression.
    // perfect.html will have: frameProtection=1, contentEncoding='gzip',
    // httpsOk=0 (http fixture → hsts-missing gated out), xRobotsTag='' → all four clean.
    srv = await startFixtureServer({
      responseHeaders: { 'X-Frame-Options': 'SAMEORIGIN' },
      compress: true,
    });
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  function findFinding(id) {
    return analysis.findings.find(f => f.ruleId === id);
  }

  it('tech:x-robots-noindex does NOT fire on perfect.html', () => {
    const f = findFinding('tech:x-robots-noindex');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in tech:x-robots-noindex affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('tech:hsts-missing does NOT fire on perfect.html', () => {
    const f = findFinding('tech:hsts-missing');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in tech:hsts-missing affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('tech:frame-protection-missing does NOT fire on perfect.html', () => {
    const f = findFinding('tech:frame-protection-missing');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in tech:frame-protection-missing affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });

  it('perf:text-compression-missing does NOT fire on perfect.html', () => {
    const f = findFinding('perf:text-compression-missing');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in perf:text-compression-missing affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
  });
});

// ── Batch 4b: security/trust response-header detectors — synthetic ctx units ──
// Each mirrors the hsts/frame unit tests: site-level aggregation over contentRows,
// one finding per rule. The presence-rules fire on '!= "1"', the cookie/version
// rules fire on '=== "1"' (gated in fetch.mjs so they only fire when applicable).

describe('Batch 4b — security/trust header detectors (synthetic ctx)', () => {
  const mkRule = (id, severity) => ({ id, kategorie: 'tech-index', scope: 'agnostic', severity, title: id, params: {} });

  // ── presence rules: FIRE when col != "1", NO-FIRE (+positive) when col === "1" ──
  const presenceCases = [
    { id: 'tech:nosniff-missing',             col: 'nosniffPresent',           severity: 'mittel'  },
    { id: 'tech:referrer-policy-missing',     col: 'referrerPolicyPresent',    severity: 'niedrig' },
    { id: 'tech:permissions-policy-missing',  col: 'permissionsPolicyPresent', severity: 'niedrig' },
    { id: 'tech:csp-missing',                 col: 'cspPresent',               severity: 'mittel'  },
  ];

  for (const { id, col, severity } of presenceCases) {
    it(`${id} FIRES when ${col}="0"`, () => {
      const url = `http://example.com/${col}-missing.html`;
      const ctx = { rows: [{ url, [col]: '0', wordCount: '300', error: '', redirected: '0' }], signals: {}, linkgraph: {} };
      const { findings } = runRules(ctx, [mkRule(id, severity)]);
      assert.strictEqual(findings.length, 1, `${id} should fire when ${col}=0`);
      assert.ok(findings[0].affectedUrls.includes(url));
    });

    it(`${id} does NOT fire (positive) when ${col}="1"`, () => {
      const url = `http://example.com/${col}-present.html`;
      const ctx = { rows: [{ url, [col]: '1', wordCount: '300', error: '', redirected: '0' }], signals: {}, linkgraph: {} };
      const { findings, positives } = runRules(ctx, [mkRule(id, severity)]);
      assert.strictEqual(findings.length, 0, `${id} must NOT fire when ${col}=1`);
      assert.strictEqual(positives.length, 1, `${id} should yield a positive`);
    });
  }

  // ── tech:cookie-insecure: FIRES only when cookieInsecure="1" ──────────────────
  it('tech:cookie-insecure FIRES when cookieInsecure="1"', () => {
    const url = 'http://example.com/insecure-cookie.html';
    const ctx = { rows: [{ url, cookieInsecure: '1', wordCount: '300', error: '', redirected: '0' }], signals: {}, linkgraph: {} };
    const { findings } = runRules(ctx, [mkRule('tech:cookie-insecure', 'mittel')]);
    assert.strictEqual(findings.length, 1, 'tech:cookie-insecure should fire when cookieInsecure=1');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('tech:cookie-insecure does NOT fire when cookieInsecure="0" (secure OR no Set-Cookie)', () => {
    const url = 'http://example.com/secure-or-no-cookie.html';
    const ctx = { rows: [{ url, cookieInsecure: '0', wordCount: '300', error: '', redirected: '0' }], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [mkRule('tech:cookie-insecure', 'mittel')]);
    assert.strictEqual(findings.length, 0, 'tech:cookie-insecure must NOT fire when cookieInsecure=0');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  // ── tech:version-disclosure: FIRES only when versionDisclosure="1" ────────────
  it('tech:version-disclosure FIRES when versionDisclosure="1"', () => {
    const url = 'http://example.com/banner.html';
    const ctx = { rows: [{ url, versionDisclosure: '1', wordCount: '300', error: '', redirected: '0' }], signals: {}, linkgraph: {} };
    const { findings } = runRules(ctx, [mkRule('tech:version-disclosure', 'niedrig')]);
    assert.strictEqual(findings.length, 1, 'tech:version-disclosure should fire when versionDisclosure=1');
    assert.ok(findings[0].affectedUrls.includes(url));
  });

  it('tech:version-disclosure does NOT fire when versionDisclosure="0"', () => {
    const url = 'http://example.com/no-banner.html';
    const ctx = { rows: [{ url, versionDisclosure: '0', wordCount: '300', error: '', redirected: '0' }], signals: {}, linkgraph: {} };
    const { findings, positives } = runRules(ctx, [mkRule('tech:version-disclosure', 'niedrig')]);
    assert.strictEqual(findings.length, 0, 'tech:version-disclosure must NOT fire when versionDisclosure=0');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  // ── contentRows gating: redirect / js-guard / non-HTML rows are excluded ──────
  it('presence rules ignore redirect / js-guard / non-HTML rows (contentRows gating)', () => {
    const ctx = {
      rows: [
        { url: 'http://example.com/redir.html',   nosniffPresent: '0', wordCount: '300', error: '',                    redirected: '1' },
        { url: 'http://example.com/jsguard.html',  nosniffPresent: '0', wordCount: '300', error: 'js-guard:empty-body', redirected: '0' },
        { url: 'http://example.com/nonhtml',       nosniffPresent: '0', wordCount: '',    error: '',                    redirected: '0' },
      ],
      signals: {}, linkgraph: {},
    };
    const { findings } = runRules(ctx, [mkRule('tech:nosniff-missing', 'mittel')]);
    assert.strictEqual(findings.length, 0, 'tech:nosniff-missing must ignore redirect/js-guard/non-HTML rows');
  });

  // ── framing: every new detail carries "KEIN Ranking-Signal — Trust/Security-Härtung" ──
  // Uses 5 rows so minNMet=true and runRules preserves the detector's raw detail
  // (at N<5 it is replaced by the small-sample caveat).
  it('all six detail strings carry the Trust/Security framing (NOT a ranking factor)', () => {
    const trigger = {
      'tech:nosniff-missing':            { nosniffPresent: '0' },
      'tech:referrer-policy-missing':    { referrerPolicyPresent: '0' },
      'tech:permissions-policy-missing': { permissionsPolicyPresent: '0' },
      'tech:csp-missing':                { cspPresent: '0' },
      'tech:cookie-insecure':            { cookieInsecure: '1' },
      'tech:version-disclosure':         { versionDisclosure: '1' },
    };
    for (const [id, cols] of Object.entries(trigger)) {
      const rows = Array.from({ length: 5 }, (_, i) =>
        ({ url: `http://example.com/p${i}.html`, wordCount: '300', error: '', redirected: '0', ...cols }));
      const { findings } = runRules({ rows, signals: {}, linkgraph: {} }, [mkRule(id, 'mittel')]);
      assert.strictEqual(findings.length, 1, `${id} should fire (N=5)`);
      assert.match(findings[0].detail, /KEIN Ranking-Signal — Trust\/Security-Härtung/,
        `${id} detail must carry "KEIN Ranking-Signal — Trust/Security-Härtung"`);
      assert.match(findings[0].detail, /keine Rich-Result-Eignung/,
        `${id} detail must state it is NOT rich-result eligibility`);
    }
  });
});

// ── U5.4: pathCluster + stratifiedSample + sidecar + version 1.4 ──────────────

// Minimal rule descriptor for onpage:title-missing (detector already registered).
const TITLE_MISSING_RULE = {
  id: 'onpage:title-missing', kategorie: 'onpage', scope: 'page',
  severity: 'hoch', title: 'Seitentitel fehlt', quelle: 'test', datum: '2025-01',
};

// Helper: build a synthetic content row (triggers onpage:title-missing).
function makeContentRow(url) {
  return { url, title: '', wordCount: '100', error: '', redirected: '0' };
}

describe('U5.4 — pathCluster correctness + determinism (via runRules)', () => {
  // 4 URLs with 2 blog, 1 shop, 1 root — exercises cluster grouping + sorting
  const clusterUrls = [
    'http://x.com/blog/a',
    'http://x.com/blog/b',
    'http://x.com/shop/c',
    'http://x.com/',
  ];
  const ctx = {
    rows:      clusterUrls.map(makeContentRow),
    signals:   {},
    linkgraph: {},
  };

  it('clusters include /blog/* count:2, /shop/* count:1, / count:1', () => {
    const { findings } = runRules(ctx, [TITLE_MISSING_RULE]);
    assert.strictEqual(findings.length, 1, 'should have one finding');
    const { clusters } = findings[0];
    assert.ok(Array.isArray(clusters), 'clusters should be an array');
    const blogCluster  = clusters.find(c => c.pattern === '/blog/*');
    const shopCluster  = clusters.find(c => c.pattern === '/shop/*');
    const rootCluster  = clusters.find(c => c.pattern === '/');
    assert.ok(blogCluster,  'should have /blog/* cluster');
    assert.ok(shopCluster,  'should have /shop/* cluster');
    assert.ok(rootCluster,  'should have / cluster');
    assert.strictEqual(blogCluster.count,  2, '/blog/* count should be 2');
    assert.strictEqual(shopCluster.count,  1, '/shop/* count should be 1');
    assert.strictEqual(rootCluster.count,  1, '/ count should be 1');
    // sorted by count desc then pattern asc: /blog/* > / > /shop/*
    assert.strictEqual(clusters[0].pattern, '/blog/*', 'first cluster should be /blog/* (highest count)');
    assert.strictEqual(clusters[1].pattern, '/',       'second cluster should be / (count 1, "/" < "/shop/*")');
    assert.strictEqual(clusters[2].pattern, '/shop/*', 'third cluster should be /shop/*');
  });

  it('two runRules calls produce identical clusters (determinism)', () => {
    const { findings: f1 } = runRules(ctx, [TITLE_MISSING_RULE]);
    const { findings: f2 } = runRules(ctx, [TITLE_MISSING_RULE]);
    assert.deepStrictEqual(f1[0].clusters, f2[0].clusters, 'clusters must be deterministic across two calls');
  });
});

describe('U5.4 — stratifiedSample: 25 URLs → 10 evenly spaced, 6 URLs → all 6 (via runRules)', () => {
  it('25 URLs → exactly 10, first and last included, deterministic', () => {
    const urls25 = Array.from({ length: 25 }, (_, i) =>
      `http://x.com/page-${String(i).padStart(2, '0')}.html`);
    const ctx25 = { rows: urls25.map(makeContentRow), signals: {}, linkgraph: {} };

    const { findings: f1 } = runRules(ctx25, [TITLE_MISSING_RULE]);
    const { findings: f2 } = runRules(ctx25, [TITLE_MISSING_RULE]);
    assert.strictEqual(f1.length, 1, 'should have one finding');
    assert.strictEqual(f1[0].affectedUrls.length, 10, '25 URLs → stratified sample of 10');
    // first and last of the full list must be included
    assert.ok(f1[0].affectedUrls.includes(urls25[0]),  'first URL must be included');
    assert.ok(f1[0].affectedUrls.includes(urls25[24]), 'last URL must be included');
    // deterministic across two calls
    assert.deepStrictEqual(f1[0].affectedUrls, f2[0].affectedUrls, 'sample must be deterministic');
  });

  it('6 URLs → all 6 returned (== old slice behavior for ≤10 inputs)', () => {
    const urls6 = Array.from({ length: 6 }, (_, i) =>
      `http://x.com/short-${i}.html`);
    const ctx6 = { rows: urls6.map(makeContentRow), signals: {}, linkgraph: {} };
    const { findings } = runRules(ctx6, [TITLE_MISSING_RULE]);
    assert.strictEqual(findings.length, 1, 'should have one finding');
    assert.deepStrictEqual(
      findings[0].affectedUrls,
      urls6,
      '6 URLs → all returned, same as old slice(0,10)',
    );
  });
});

describe('U5.4 — sidecar written, analysis.json lean, clusters in every finding', () => {
  let srv, crawlResult, analysis, sidecarPath;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
    sidecarPath = path.join(path.dirname(crawlResult.csvPath), 'affected-urls.csv');
  });

  after(() => srv.close());

  it('affected-urls.csv exists in the crawl output directory', () => {
    assert.ok(fs.existsSync(sidecarPath), `affected-urls.csv should exist at ${sidecarPath}`);
  });

  it('affected-urls.csv starts with header ruleId,url and has ≥1 data row', () => {
    const content = fs.readFileSync(sidecarPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim() !== '');
    assert.strictEqual(lines[0], 'ruleId,url', 'first line should be header "ruleId,url"');
    assert.ok(lines.length >= 2, `sidecar should have ≥1 data row, got ${lines.length - 1}`);
  });

  it('returned analysis has NO affectedUrlsByRule key (lean — full lists in sidecar only)', () => {
    assert.ok(
      !('affectedUrlsByRule' in analysis),
      'analysis returned by analyzeFromFiles must NOT contain affectedUrlsByRule',
    );
  });

  it('every finding has a clusters array', () => {
    for (const f of analysis.findings) {
      assert.ok(
        Array.isArray(f.clusters),
        `finding ${f.ruleId} should have a clusters array, got ${JSON.stringify(f.clusters)}`,
      );
    }
  });
});

describe('U5.4 — rulesetVersion is 1.7.x', () => {
  // No fixture server needed — read the version directly from the config file
  // (the same source that analyze.mjs uses) to avoid a redundant crawl+analyze.
  it('rulesetVersion starts with 1.7.', () => {
    const ver = JSON.parse(fs.readFileSync(
      new URL('../config/rules-version.json', import.meta.url),
      'utf8',
    ));
    assert.ok(
      ver.version.startsWith('1.7.'),
      `rulesetVersion should start with 1.7., got ${ver.version}`,
    );
  });
});

describe('affected-urls.csv determinism', () => {
  let srv, crawlResult;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
  });

  after(() => srv.close());

  it('two analyzeFromFiles calls produce byte-identical affected-urls.csv (host-normalised)', async () => {
    const sidecarPath = path.join(path.dirname(crawlResult.csvPath), 'affected-urls.csv');
    const normalizeHost = s => s.replace(/127\.0\.0\.1:\d+/g, 'HOST');

    // First call
    await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
    const content1 = fs.readFileSync(sidecarPath, 'utf8');

    // Second call (overwrites the sidecar in place)
    await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
    const content2 = fs.readFileSync(sidecarPath, 'utf8');

    assert.strictEqual(
      normalizeHost(content1),
      normalizeHost(content2),
      'affected-urls.csv must be byte-identical across two analyzeFromFiles calls on the same input',
    );
  });
});

// ── U6.1: i18n:hreflang-not-reciprocal (synthetic ctx) ───────────────────────

describe('U6.1 — i18n:hreflang-not-reciprocal (synthetic ctx)', () => {

  const rule = {
    id:        'i18n:hreflang-not-reciprocal',
    kategorie: 'i18n',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'hreflang nicht reziprok / ohne Self-Referenz / relativ (Targeting-Defekt)',
    params:    {},
  };

  it('Reciprocal cluster clean: two pages that both declare each other + self → neither fires', () => {
    const urlA = 'http://x/de';
    const urlB = 'http://x/en';
    const ctx = {
      rows: [
        { url: urlA, hreflangLinks: 'de=http://x/de|en=http://x/en', wordCount: '300', error: '', redirected: '0' },
        { url: urlB, hreflangLinks: 'de=http://x/de|en=http://x/en', wordCount: '300', error: '', redirected: '0' },
      ],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      `i18n:hreflang-not-reciprocal must NOT fire for a fully-reciprocal cluster, findings: ${JSON.stringify(findings)}`);
    assert.ok(positives.some(p => p.ruleId === rule.id),
      `i18n:hreflang-not-reciprocal should appear as a positive for a clean cluster`);
  });

  it('Non-reciprocal: A declares B but B (crawled) does NOT declare A → A is in affectedUrls', () => {
    const urlA = 'http://x/de';
    const urlB = 'http://x/en';
    const ctx = {
      rows: [
        { url: urlA, hreflangLinks: 'de=http://x/de|en=http://x/en', wordCount: '300', error: '', redirected: '0' },
        // B only declares itself, does not declare A → non-reciprocal
        { url: urlB, hreflangLinks: 'en=http://x/en', wordCount: '300', error: '', redirected: '0' },
      ],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      `i18n:hreflang-not-reciprocal should fire for non-reciprocal cluster`);
    assert.ok(findings[0].affectedUrls.includes(urlA),
      `urlA (${urlA}) must be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('Relative target: a row with relative hrefs fires', () => {
    const url = 'http://x/de';
    const ctx = {
      rows: [
        { url, hreflangLinks: 'de=/de|en=/en', wordCount: '300', error: '', redirected: '0' },
      ],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      `i18n:hreflang-not-reciprocal should fire for relative hreflang targets`);
    assert.ok(findings[0].affectedUrls.includes(url),
      `url must be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('Missing self-ref: a row whose hreflangLinks omit its own URL → fires', () => {
    const urlA = 'http://x/de';
    const urlB = 'http://x/en';
    const ctx = {
      rows: [
        // A omits itself from its hreflang set → missing self-ref
        { url: urlA, hreflangLinks: 'en=http://x/en', wordCount: '300', error: '', redirected: '0' },
        { url: urlB, hreflangLinks: 'de=http://x/de|en=http://x/en', wordCount: '300', error: '', redirected: '0' },
      ],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      `i18n:hreflang-not-reciprocal should fire when self-ref is missing`);
    assert.ok(findings[0].affectedUrls.includes(urlA),
      `urlA must be in affectedUrls for missing self-ref: ${JSON.stringify(findings[0].affectedUrls)}`);
  });

  it('Uncrawled target (anti-overclaim): only uncrawled target declared, otherwise clean → does NOT fire', () => {
    const urlA = 'http://x/de';
    // fr target is not a crawled row
    const ctx = {
      rows: [
        { url: urlA, hreflangLinks: 'de=http://x/de|fr=http://x/fr', wordCount: '300', error: '', redirected: '0' },
      ],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      `i18n:hreflang-not-reciprocal must NOT fire for uncrawled target (anti-overclaim), findings: ${JSON.stringify(findings)}`);
  });

  it('No hreflang: a row with empty hreflangLinks does not fire', () => {
    const url = 'http://x/page';
    const ctx = {
      rows: [
        { url, hreflangLinks: '', wordCount: '300', error: '', redirected: '0' },
      ],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      `i18n:hreflang-not-reciprocal must NOT fire for a page with no hreflang`);
  });
});

// ── U6.1: perfect.html clean assert (integration) ────────────────────────────

describe('U6.1 — perfect.html: i18n:hreflang-not-reciprocal does NOT fire (integration clean assert)', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  it('i18n:hreflang-not-reciprocal does NOT fire on perfect.html', () => {
    const f = analysis.findings.find(f => f.ruleId === 'i18n:hreflang-not-reciprocal');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in i18n:hreflang-not-reciprocal affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
    // If no finding at all, perfect — the rule is a positive
  });
});

// ── U6.2: trust:contact-pages-missing (synthetic ctx, site-level) ────────────

describe('U6.2 — trust:contact-pages-missing (synthetic ctx, site-level)', () => {

  const rule = {
    id:        'trust:contact-pages-missing',
    kategorie: 'trust',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'Keine erkennbare Kontakt-/Über-uns-/Impressums-/Datenschutz-Seite (Trust)',
    params:    {},
  };

  it('No-fire: /kontakt present as a row → does NOT fire', () => {
    const ctx = {
      rows:      [{ url: 'http://x/' }, { url: 'http://x/kontakt' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      `trust:contact-pages-missing must NOT fire when /kontakt is a crawled row, findings: ${JSON.stringify(findings)}`);
  });

  it('No-fire: /kontakt in signals.linkGraph.depthByUrl (discovered, not a row) → does NOT fire', () => {
    const ctx = {
      rows:      [{ url: 'http://x/' }],
      signals:   { linkGraph: { depthByUrl: { 'http://x/kontakt': 1 } } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      `trust:contact-pages-missing must NOT fire when /kontakt is in signals.linkGraph.depthByUrl, findings: ${JSON.stringify(findings)}`);
  });

  it('No-fire: /impressum present → does NOT fire (imprint pattern)', () => {
    const ctx = {
      rows:      [{ url: 'http://x/' }, { url: 'http://x/impressum' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      `trust:contact-pages-missing must NOT fire when /impressum is present`);
  });

  it('No-fire: /datenschutz present → does NOT fire (privacy pattern)', () => {
    const ctx = {
      rows:      [{ url: 'http://x/' }, { url: 'http://x/datenschutz' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      `trust:contact-pages-missing must NOT fire when /datenschutz is present`);
  });

  it('No-fire: /ueber-uns present → does NOT fire (about pattern)', () => {
    const ctx = {
      rows:      [{ url: 'http://x/' }, { url: 'http://x/ueber-uns' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      `trust:contact-pages-missing must NOT fire when /ueber-uns is present`);
  });

  it('No-fire: /privacy present → does NOT fire (privacy/EN pattern)', () => {
    const ctx = {
      rows:      [{ url: 'http://x/' }, { url: 'http://x/privacy' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      `trust:contact-pages-missing must NOT fire when /privacy is present`);
  });

  it('Umlaut: /über-uns (raw umlaut) normalizes to ueber → does NOT fire', () => {
    const ctx = {
      rows:      [{ url: 'http://x/' }, { url: 'http://x/über-uns' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      `trust:contact-pages-missing must NOT fire when /über-uns is present (umlaut normalization)`);
  });

  it('FIRE: only non-trust URLs (/, /produkt.html, /blog/x), empty linkgraph → fires once', () => {
    const ctx = {
      rows: [
        { url: 'http://x/' },
        { url: 'http://x/produkt.html' },
        { url: 'http://x/blog/x' },
      ],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      `trust:contact-pages-missing must fire when no trust page URL is present`);
    assert.strictEqual(findings[0].count, 1,
      `trust:contact-pages-missing count must be 1, got ${findings[0].count}`);
    assert.deepStrictEqual(findings[0].affectedUrls, [],
      `trust:contact-pages-missing affectedUrls must be empty (site-level)`);
  });

});

describe('U6.2 — rulesetVersion is 1.7.x', () => {
  it('rulesetVersion starts with 1.7.', () => {
    const ver = JSON.parse(fs.readFileSync(
      new URL('../config/rules-version.json', import.meta.url),
      'utf8',
    ));
    assert.ok(
      ver.version.startsWith('1.7.'),
      `rulesetVersion should start with 1.7., got ${ver.version}`,
    );
  });
});

// ── U6.3: geo:ai-user-fetcher-blocked — synthetic ctx unit tests ──────────────

describe('U6.3 — geo:ai-user-fetcher-blocked — detector unit (synthetic ctx)', () => {
  const rules = loadRules(new URL('../config/rules', import.meta.url).pathname);
  const rule = rules.find(r => r.id === 'geo:ai-user-fetcher-blocked');

  function mkCtx(aiBots) {
    return {
      rows:      [],
      signals:   { robots: { aiBots }, llms: null },
      linkgraph: {},
    };
  }

  it('rule descriptor exists in config/rules/geo.json', () => {
    assert.ok(rule, 'geo:ai-user-fetcher-blocked rule must exist in geo.json');
    assert.strictEqual(rule.kategorie, 'geo', `kategorie must be geo, got: ${rule.kategorie}`);
    assert.strictEqual(rule.severity, 'mittel', `severity must be mittel, got: ${rule.severity}`);
  });

  it('FIRE: Claude-User disallowAll:true → fires (count 1)', () => {
    const ctx = mkCtx([
      { agent: 'Claude-User', operator: 'Anthropic', kategorie: 'on-demand-fetcher', disallowAll: true, disallowPaths: ['/'] },
    ]);
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'geo:ai-user-fetcher-blocked must fire when Claude-User disallowAll:true');
    assert.strictEqual(findings[0].count, 1, `count must be 1, got: ${findings[0].count}`);
  });

  it('FIRE: Perplexity-User path-level disallow → fires', () => {
    const ctx = mkCtx([
      { agent: 'Perplexity-User', operator: 'Perplexity', kategorie: 'on-demand-fetcher', disallowAll: false, disallowPaths: ['/news/'] },
    ]);
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 1,
      'geo:ai-user-fetcher-blocked must fire for path-level disallow (Perplexity-User /news/)');
  });

  it('NO-FIRE: only a training bot (GPTBot, disallowAll:true) → does NOT fire', () => {
    const ctx = mkCtx([
      { agent: 'GPTBot', operator: 'OpenAI', kategorie: 'training', disallowAll: true, disallowPaths: ['/'] },
    ]);
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'geo:ai-user-fetcher-blocked must NOT fire for training bot only');
  });

  it('NO-FIRE: on-demand bot with no disallow → does not fire', () => {
    const ctx = mkCtx([
      { agent: 'ChatGPT-User', operator: 'OpenAI', kategorie: 'on-demand-fetcher', disallowAll: false, disallowPaths: [] },
    ]);
    const { findings } = runRules(ctx, [rule]);
    assert.strictEqual(findings.length, 0,
      'geo:ai-user-fetcher-blocked must NOT fire when on-demand bot has no disallow');
  });
});

// ── U6.3: geo:ai-bot-blocked no-double-report (on-demand bots excluded) ───────

describe('U6.3 — geo:ai-bot-blocked excludes on-demand-fetcher bots (U6.3)', () => {
  const rules = loadRules(new URL('../config/rules', import.meta.url).pathname);
  const blockedRule   = rules.find(r => r.id === 'geo:ai-bot-blocked');
  const fetcherRule   = rules.find(r => r.id === 'geo:ai-user-fetcher-blocked');

  it('on-demand bot (disallowAll:true) is excluded from geo:ai-bot-blocked, included in geo:ai-user-fetcher-blocked', () => {
    const ctx = {
      rows:      [],
      signals:   {
        robots: {
          aiBots: [
            { agent: 'Claude-User', operator: 'Anthropic', kategorie: 'on-demand-fetcher', disallowAll: true, disallowPaths: ['/'] },
          ],
        },
        llms: null,
      },
      linkgraph: {},
    };
    const { findings: blocked }  = runRules(ctx, [blockedRule]);
    const { findings: fetcher }  = runRules(ctx, [fetcherRule]);

    assert.strictEqual(blocked.length, 0,
      'geo:ai-bot-blocked must NOT fire for on-demand-fetcher bot (excluded by kategorie)');
    assert.strictEqual(fetcher.length, 1,
      'geo:ai-user-fetcher-blocked must fire for on-demand-fetcher bot');
  });

  it('training bot (disallowAll:true) is included in geo:ai-bot-blocked, excluded from geo:ai-user-fetcher-blocked', () => {
    const ctx = {
      rows:      [],
      signals:   {
        robots: {
          aiBots: [
            { agent: 'GPTBot', operator: 'OpenAI', kategorie: 'training', disallowAll: true, disallowPaths: ['/'] },
          ],
        },
        llms: null,
      },
      linkgraph: {},
    };
    const { findings: blocked }  = runRules(ctx, [blockedRule]);
    const { findings: fetcher }  = runRules(ctx, [fetcherRule]);

    assert.strictEqual(blocked.length, 1,
      'geo:ai-bot-blocked must still fire for training bot');
    assert.strictEqual(fetcher.length, 0,
      'geo:ai-user-fetcher-blocked must NOT fire for training bot');
  });
});

// ── U6.3: config/ai-bots.json inventory check ────────────────────────────────

describe('U6.3 — config/ai-bots.json inventory (2026)', () => {
  const aiBots = JSON.parse(
    fs.readFileSync(new URL('../config/ai-bots.json', import.meta.url), 'utf8'),
  );

  it('contains Claude-User with kategorie on-demand-fetcher and operator Anthropic', () => {
    const b = aiBots.find(b => b.agent === 'Claude-User');
    assert.ok(b, 'Claude-User must be in ai-bots.json');
    assert.strictEqual(b.kategorie, 'on-demand-fetcher', `kategorie must be on-demand-fetcher, got: ${b.kategorie}`);
    assert.strictEqual(b.operator, 'Anthropic', `operator must be Anthropic, got: ${b.operator}`);
  });

  it('contains ChatGPT-User with kategorie on-demand-fetcher and operator OpenAI', () => {
    const b = aiBots.find(b => b.agent === 'ChatGPT-User');
    assert.ok(b, 'ChatGPT-User must be in ai-bots.json');
    assert.strictEqual(b.kategorie, 'on-demand-fetcher', `kategorie must be on-demand-fetcher, got: ${b.kategorie}`);
    assert.strictEqual(b.operator, 'OpenAI', `operator must be OpenAI, got: ${b.operator}`);
  });

  it('contains Perplexity-User with kategorie on-demand-fetcher', () => {
    const b = aiBots.find(b => b.agent === 'Perplexity-User');
    assert.ok(b, 'Perplexity-User must be in ai-bots.json');
    assert.strictEqual(b.kategorie, 'on-demand-fetcher', `kategorie must be on-demand-fetcher, got: ${b.kategorie}`);
  });

  it('contains meta-externalfetcher with kategorie on-demand-fetcher', () => {
    const b = aiBots.find(b => b.agent === 'meta-externalfetcher');
    assert.ok(b, 'meta-externalfetcher must be in ai-bots.json');
    assert.strictEqual(b.kategorie, 'on-demand-fetcher', `kategorie must be on-demand-fetcher, got: ${b.kategorie}`);
  });

  it('all entries have an operator field', () => {
    const missing = aiBots.filter(b => !b.operator);
    assert.strictEqual(missing.length, 0,
      `All bots must have operator field. Missing: ${missing.map(b => b.agent).join(', ')}`);
  });

  it('contains new training bots (Applebot-Extended, Meta-ExternalAgent, Amazonbot, Bytespider)', () => {
    const expected = ['Applebot-Extended', 'Meta-ExternalAgent', 'Amazonbot', 'Bytespider'];
    for (const agent of expected) {
      const b = aiBots.find(b => b.agent === agent);
      assert.ok(b, `${agent} must be in ai-bots.json`);
      assert.strictEqual(b.kategorie, 'training', `${agent} must have kategorie training, got: ${b.kategorie}`);
    }
  });
});

describe('U6.2 — trust:contact-pages-missing integration (fixture fires)', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  it('trust:contact-pages-missing fires on the fixture (no contact/about/legal pages)', () => {
    const f = analysis.findings.find(f => f.ruleId === 'trust:contact-pages-missing');
    assert.ok(f, 'trust:contact-pages-missing must be present in findings (fixture has no trust pages)');
    assert.strictEqual(f.count, 1, `count must be 1, got ${f.count}`);
    assert.deepStrictEqual(f.affectedUrls, [], 'affectedUrls must be empty (site-level)');
  });
});

// ── U6.4: geo:poor-chunkability — detector unit (synthetic ctx) ──────────────

describe('U6.4 — geo:poor-chunkability — detector unit (synthetic ctx)', () => {

  const poorChunkabilityRule = {
    id:        'geo:poor-chunkability',
    kategorie: 'geo',
    scope:     'agnostic',
    severity:  'niedrig',
    title:     'Lange Seite ohne Zwischenüberschriften (KI-Chunkability — struktureller Hinweis)',
    params:    { minWords: 900, maxHeadings: 1 },
  };

  it('fires for wordCount:1000 + headingOutline:h1 (long, only H1)', () => {
    const url = 'http://example.com/long-no-subheadings.html';
    const ctx = {
      rows:      [{ url, wordCount: '1000', headingOutline: 'h1', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [poorChunkabilityRule]);
    assert.strictEqual(findings.length, 1,
      'geo:poor-chunkability should fire for long page with only H1');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('fires for wordCount:1500 + headingOutline:"" (long, zero headings)', () => {
    const url = 'http://example.com/long-no-headings.html';
    const ctx = {
      rows:      [{ url, wordCount: '1500', headingOutline: '', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [poorChunkabilityRule]);
    assert.strictEqual(findings.length, 1,
      'geo:poor-chunkability should fire for long page with zero headings');
    assert.ok(
      findings[0].affectedUrls.includes(url),
      `URL should be in affectedUrls: ${JSON.stringify(findings[0].affectedUrls)}`,
    );
  });

  it('does NOT fire for wordCount:1000 + headingOutline:h1,h2,h3 (has sub-structure)', () => {
    const url = 'http://example.com/long-with-subheadings.html';
    const ctx = {
      rows:      [{ url, wordCount: '1000', headingOutline: 'h1,h2,h3', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [poorChunkabilityRule]);
    assert.strictEqual(findings.length, 0,
      'geo:poor-chunkability must NOT fire when page has sub-structure (h1,h2,h3)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for wordCount:500 + headingOutline:h1 (too short)', () => {
    const url = 'http://example.com/short-no-subheadings.html';
    const ctx = {
      rows:      [{ url, wordCount: '500', headingOutline: 'h1', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [poorChunkabilityRule]);
    assert.strictEqual(findings.length, 0,
      'geo:poor-chunkability must NOT fire for short page (wordCount=500)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });

  it('does NOT fire for wordCount:900 + headingOutline:h1 (boundary: not strictly > 900)', () => {
    const url = 'http://example.com/boundary-900.html';
    const ctx = {
      rows:      [{ url, wordCount: '900', headingOutline: 'h1', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [poorChunkabilityRule]);
    assert.strictEqual(findings.length, 0,
      'geo:poor-chunkability must NOT fire for wordCount=900 (boundary: not strictly > 900)');
    assert.strictEqual(positives.length, 1, 'should yield a positive');
  });
});

// ── U6.4: integration clean assert — perfect.html not flagged ────────────────

describe('U6.4 — perfect.html: geo:poor-chunkability does not fire (integration clean assert)', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  it('geo:poor-chunkability does NOT fire on perfect.html (short page, wordCount <= 900)', () => {
    const f = analysis.findings.find(f => f.ruleId === 'geo:poor-chunkability');
    if (f) {
      assert.ok(
        !f.affectedUrls.some(u => u.includes('perfect.html')),
        `perfect.html must NOT be in geo:poor-chunkability affectedUrls: ${JSON.stringify(f.affectedUrls)}`,
      );
    }
    // If no finding at all, the rule is a positive — acceptable (no fixture page exceeds 900 words)
  });
});

// ── U6.5: tech:http-not-redirected — detector unit (synthetic ctx) ────────────

describe('U6.5 — tech:http-not-redirected — detector unit (synthetic ctx)', () => {
  const httpNotRedirectedRule = {
    id:        'tech:http-not-redirected',
    kategorie: 'tech-index',
    scope:     'agnostic',
    severity:  'mittel',
    title:     'HTTP leitet nicht auf HTTPS um (Kanonisierung/Sicherheit)',
    params:    {},
  };

  it('FIRE: reachable + no redirect + https row exists → count 1', () => {
    const ctx = {
      rows:      [{ url: 'https://example.com/', httpsOk: '1', wordCount: '100', error: '', redirected: '0' }],
      signals:   { httpProbe: { reachable: true, redirectsToHttps: false, status: 200 } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [httpNotRedirectedRule]);
    assert.strictEqual(findings.length, 1,
      'tech:http-not-redirected should fire when probe reachable, no redirect, https row exists');
    assert.strictEqual(findings[0].count, 1, `count should be 1, got ${findings[0].count}`);
    assert.deepStrictEqual(findings[0].affectedUrls, [],
      'affectedUrls should be empty (site-level finding)');
  });

  it('NO-FIRE: probe redirectsToHttps:true → does not fire', () => {
    const ctx = {
      rows:      [{ url: 'https://example.com/', httpsOk: '1', wordCount: '100', error: '', redirected: '0' }],
      signals:   { httpProbe: { reachable: true, redirectsToHttps: true, status: 200 } },
      linkgraph: {},
    };
    const { findings, positives } = runRules(ctx, [httpNotRedirectedRule]);
    assert.strictEqual(findings.length, 0,
      'tech:http-not-redirected must NOT fire when probe redirectsToHttps:true');
    assert.strictEqual(positives.length, 1, 'should yield a positive when redirect is in place');
  });

  it('NO-FIRE: no httpsOk="1" row (http-only site, gated) → does not fire', () => {
    const ctx = {
      rows:      [{ url: 'http://example.com/', httpsOk: '0', wordCount: '100', error: '', redirected: '0' }],
      signals:   { httpProbe: { reachable: true, redirectsToHttps: false, status: 200 } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [httpNotRedirectedRule]);
    assert.strictEqual(findings.length, 0,
      'tech:http-not-redirected must NOT fire when no httpsOk="1" row exists (http-only site)');
  });

  it('NO-FIRE: no httpProbe in signals → does not fire', () => {
    const ctx = {
      rows:      [{ url: 'https://example.com/', httpsOk: '1', wordCount: '100', error: '', redirected: '0' }],
      signals:   {},
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [httpNotRedirectedRule]);
    assert.strictEqual(findings.length, 0,
      'tech:http-not-redirected must NOT fire when signals.httpProbe is absent');
  });

  it('NO-FIRE: probe not reachable (reachable:false) → does not fire', () => {
    const ctx = {
      rows:      [{ url: 'https://example.com/', httpsOk: '1', wordCount: '100', error: '', redirected: '0' }],
      signals:   { httpProbe: { reachable: false, redirectsToHttps: false, status: 0 } },
      linkgraph: {},
    };
    const { findings } = runRules(ctx, [httpNotRedirectedRule]);
    assert.strictEqual(findings.length, 0,
      'tech:http-not-redirected must NOT fire when probe is unreachable');
  });
});

// ── U6.5: tech:http-not-redirected integration (fixture crawl) ────────────────

describe('U6.5 — tech:http-not-redirected integration (fixture crawl)', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  it('signals.json has httpProbe with reachable:true (probe ran against fixture http server)', () => {
    const signals = JSON.parse(fs.readFileSync(crawlResult.signalsPath, 'utf8'));
    assert.ok(signals.httpProbe, 'signals.json must have httpProbe field');
    assert.strictEqual(signals.httpProbe.reachable, true,
      `httpProbe.reachable should be true (fixture is an http server), got: ${JSON.stringify(signals.httpProbe)}`);
    assert.strictEqual(typeof signals.httpProbe.redirectsToHttps, 'boolean',
      'httpProbe.redirectsToHttps must be a boolean');
    assert.strictEqual(typeof signals.httpProbe.status, 'number',
      'httpProbe.status must be a number');
  });

  it('tech:http-not-redirected does NOT fire on fixture (gated: no httpsOk="1" rows)', () => {
    const f = analysis.findings.find(f => f.ruleId === 'tech:http-not-redirected');
    assert.ok(!f,
      `tech:http-not-redirected must NOT fire on http-only fixture (no httpsOk='1' rows), but got: ${JSON.stringify(f)}`);
  });

  it('probe did not add extra rows to crawl.csv (stats.fetched unchanged)', () => {
    // The probe is a SITE-signal fetch, not a page fetch — it must NOT bump fetchedCount.
    // Verify by checking that crawl.csv has exactly stats.fetched rows.
    const csvRaw = fs.readFileSync(crawlResult.csvPath, 'utf8');
    const csvRows = csvRaw.trim().split('\n').filter(Boolean);
    // csvRows includes the header line, so data rows = csvRows.length - 1
    const dataRows = csvRows.length - 1;
    assert.strictEqual(dataRows, crawlResult.stats.fetched,
      `crawl.csv data rows (${dataRows}) must equal stats.fetched (${crawlResult.stats.fetched}) — probe must not add a page row`);
  });
});

// ── U6.6: perf:cwv-field-fail synthetic detector tests ───────────────────────

describe('U6.6 — perf:cwv-field-fail detector (synthetic ctx)', () => {
  const cwvRule = {
    id: 'perf:cwv-field-fail',
    kategorie: 'performance',
    scope: 'agnostic',
    severity: 'hoch',
    title: 'Core Web Vitals (Felddaten/CrUX) nicht im »good«-Bereich',
    quelle: 'CrUX',
    datum: '2026-06',
    params: {},
  };

  const baseRows = [
    { url: 'https://example.com/', wordCount: '200', error: '', redirected: '0', title: 'Home', canonical: 'https://example.com/', canonSelf: '1' },
    { url: 'https://example.com/a', wordCount: '200', error: '', redirected: '0', title: 'A', canonical: 'https://example.com/a', canonSelf: '1' },
    { url: 'https://example.com/b', wordCount: '200', error: '', redirected: '0', title: 'B', canonical: 'https://example.com/b', canonSelf: '1' },
    { url: 'https://example.com/c', wordCount: '200', error: '', redirected: '0', title: 'C', canonical: 'https://example.com/c', canonSelf: '1' },
    { url: 'https://example.com/d', wordCount: '200', error: '', redirected: '0', title: 'D', canonical: 'https://example.com/d', canonSelf: '1' },
  ];

  it('FIRE: poor LCP runtimeSignals → finding count 1', () => {
    const runtimeSignals = {
      available: true,
      crux: {
        lcp: { p75: 4500, category: 'poor' },
        inp: { p75: 150, category: 'good' },
        cls: { p75: 0.05, category: 'good' },
        formFactor: 'PHONE',
      },
      generatedAt: '2026-06-29T00:00:00Z',
      source: 'CrUX',
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [cwvRule]);
    assert.strictEqual(findings.length, 1, 'should emit 1 finding for poor LCP');
    assert.strictEqual(findings[0].ruleId, 'perf:cwv-field-fail');
    assert.strictEqual(findings[0].count, 1);
    assert.ok(findings[0].detail.includes('LCP'), `detail should mention LCP: ${findings[0].detail}`);
    assert.ok(findings[0].detail.includes('poor'), `detail should mention poor: ${findings[0].detail}`);
  });

  it('FIRE: needs-improvement INP + poor CLS → finding count 1, detail mentions both', () => {
    const runtimeSignals = {
      available: true,
      crux: {
        lcp: { p75: 2000, category: 'good' },
        inp: { p75: 350, category: 'needs-improvement' },
        cls: { p75: 0.30, category: 'poor' },
        formFactor: 'PHONE',
      },
      generatedAt: '2026-06-29T00:00:00Z',
      source: 'CrUX',
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [cwvRule]);
    assert.strictEqual(findings.length, 1);
    assert.ok(findings[0].detail.includes('INP'), `detail should mention INP: ${findings[0].detail}`);
    assert.ok(findings[0].detail.includes('CLS'), `detail should mention CLS: ${findings[0].detail}`);
  });

  it('NO-FIRE: all CWV good → no finding', () => {
    const runtimeSignals = {
      available: true,
      crux: {
        lcp: { p75: 1800, category: 'good' },
        inp: { p75: 150, category: 'good' },
        cls: { p75: 0.05, category: 'good' },
        formFactor: 'PHONE',
      },
      generatedAt: '2026-06-29T00:00:00Z',
      source: 'CrUX',
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [cwvRule]);
    assert.strictEqual(findings.length, 0, 'no finding when all CWV are good');
  });

  it('NO-FIRE: available:false → no finding', () => {
    const runtimeSignals = { available: false, reason: 'CRUX_API_KEY not set', generatedAt: '2026-06-29T00:00:00Z' };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [cwvRule]);
    assert.strictEqual(findings.length, 0, 'no finding when available:false');
  });

  it('NO-FIRE: {available:true, crux:{noData:true}} → no finding', () => {
    const runtimeSignals = { available: true, crux: { noData: true }, generatedAt: '2026-06-29T00:00:00Z', source: 'CrUX' };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [cwvRule]);
    assert.strictEqual(findings.length, 0, 'no finding when crux.noData:true');
  });

  it('NO-FIRE: null runtimeSignals → no finding', () => {
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals: null };
    const { findings } = runRules(ctx, [cwvRule]);
    assert.strictEqual(findings.length, 0, 'no finding when runtimeSignals is null');
  });

  it('NO-FIRE: missing runtimeSignals (no key in ctx) → no finding', () => {
    const ctx = { rows: baseRows, signals: {}, linkgraph: {} };
    const { findings } = runRules(ctx, [cwvRule]);
    assert.strictEqual(findings.length, 0, 'no finding when runtimeSignals absent from ctx');
  });

  it('MEASURED-CLEAN: available:true + all CWV good → IS in positives (measured pass, not skipped)', () => {
    const runtimeSignals = {
      available: true,
      crux: {
        lcp: { p75: 1800, category: 'good' },
        inp: { p75: 150, category: 'good' },
        cls: { p75: 0.05, category: 'good' },
        formFactor: 'PHONE',
      },
      generatedAt: '2026-06-29T00:00:00Z',
      source: 'CrUX',
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings, positives } = runRules(ctx, [cwvRule]);
    assert.strictEqual(findings.length, 0, 'no finding when all CWV are good');
    assert.strictEqual(positives.length, 1, 'perf:cwv-field-fail must be a positive when CrUX present and clean');
    assert.strictEqual(positives[0].ruleId, 'perf:cwv-field-fail');
  });
});

// ── U6.6: offline purity (analyzeFromFiles without runtime-signals.json) ─────

describe('U6.6 — offline purity (no runtime-signals.json → no perf:cwv-field-fail)', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    // Ensure no runtime-signals.json exists in the data dir
    const rsPath = path.join(path.dirname(crawlResult.csvPath), 'runtime-signals.json');
    if (fs.existsSync(rsPath)) fs.unlinkSync(rsPath);
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  it('perf:cwv-field-fail does NOT appear in findings (no runtime-signals.json)', () => {
    const f = analysis.findings.find(f => f.ruleId === 'perf:cwv-field-fail');
    assert.ok(!f,
      `perf:cwv-field-fail must NOT fire when no runtime-signals.json exists, but got: ${JSON.stringify(f)}`);
  });

  it('analysis still has all core required top-level keys', () => {
    assert.ok(analysis.meta, 'meta should exist');
    assert.ok(Array.isArray(analysis.findings), 'findings should be an array');
    assert.ok(Array.isArray(analysis.positives), 'positives should be an array');
  });

  it('perf:cwv-field-fail appears in NEITHER findings NOR positives when offline (skipped)', () => {
    const f = analysis.findings.find(f => f.ruleId === 'perf:cwv-field-fail');
    const p = analysis.positives.find(p => p.ruleId === 'perf:cwv-field-fail');
    assert.ok(!f, 'perf:cwv-field-fail must NOT appear in findings when no runtime data');
    assert.ok(!p, 'perf:cwv-field-fail must NOT appear in positives when no runtime data (skipped)');
  });
});

// ── U6.7: tech:tls-cert-expiring synthetic detector tests ─────────────────────

describe('U6.7 — tech:tls-cert-expiring detector (synthetic ctx)', () => {
  const tlsRule = {
    id: 'tech:tls-cert-expiring',
    kategorie: 'tech-index',
    scope: 'agnostic',
    severity: 'hoch',
    title: 'TLS-Zertifikat abgelaufen/bald ablaufend/Hostname-Mismatch (Sicherheit)',
    quelle: 'node:tls',
    datum: '2026-06',
    params: {},
  };

  const baseRows = [
    { url: 'https://example.com/', wordCount: '200', error: '', redirected: '0', title: 'Home', canonical: 'https://example.com/', canonSelf: '1' },
    { url: 'https://example.com/a', wordCount: '200', error: '', redirected: '0', title: 'A', canonical: 'https://example.com/a', canonSelf: '1' },
    { url: 'https://example.com/b', wordCount: '200', error: '', redirected: '0', title: 'B', canonical: 'https://example.com/b', canonSelf: '1' },
    { url: 'https://example.com/c', wordCount: '200', error: '', redirected: '0', title: 'C', canonical: 'https://example.com/c', canonSelf: '1' },
    { url: 'https://example.com/d', wordCount: '200', error: '', redirected: '0', title: 'D', canonical: 'https://example.com/d', canonSelf: '1' },
  ];

  it('FIRE: issues:[expired] → finding count 1', () => {
    const runtimeSignals = {
      tls: {
        available: true,
        data: { issues: ['expired'], daysLeft: -1, validTo: 'Jun 28 00:00:00 2026 GMT', host: 'example.com' },
      },
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [tlsRule]);
    assert.strictEqual(findings.length, 1, 'should emit 1 finding for expired cert');
    assert.strictEqual(findings[0].ruleId, 'tech:tls-cert-expiring');
    assert.strictEqual(findings[0].count, 1);
    assert.ok(findings[0].detail.includes('abgelaufen'), `detail should mention abgelaufen: ${findings[0].detail}`);
    assert.ok(findings[0].detail.includes('example.com'), `detail should mention host: ${findings[0].detail}`);
  });

  it('FIRE: issues:[expiring] → finding count 1, detail mentions daysLeft', () => {
    const runtimeSignals = {
      tls: {
        available: true,
        data: { issues: ['expiring'], daysLeft: 5, validTo: 'Jul 04 00:00:00 2026 GMT', host: 'example.com' },
      },
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [tlsRule]);
    assert.strictEqual(findings.length, 1);
    assert.ok(findings[0].detail.includes('5'), `detail should mention daysLeft=5: ${findings[0].detail}`);
  });

  it('FIRE: issues:[mismatch] → finding count 1', () => {
    const runtimeSignals = {
      tls: {
        available: true,
        data: { issues: ['mismatch'], daysLeft: 90, validTo: 'Sep 27 00:00:00 2026 GMT', host: 'example.com' },
      },
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [tlsRule]);
    assert.strictEqual(findings.length, 1);
    assert.ok(findings[0].detail.includes('Hostname-Mismatch'), `detail should mention Hostname-Mismatch: ${findings[0].detail}`);
  });

  it('FIRE: issues:[untrusted] → finding count 1', () => {
    const runtimeSignals = {
      tls: {
        available: true,
        data: { issues: ['untrusted'], daysLeft: 90, validTo: 'Sep 27 00:00:00 2026 GMT', host: 'example.com' },
      },
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [tlsRule]);
    assert.strictEqual(findings.length, 1);
    assert.ok(findings[0].detail.includes('Vertrauenskette'), `detail should mention Vertrauenskette: ${findings[0].detail}`);
  });

  it('NO-FIRE: issues:[] → no finding', () => {
    const runtimeSignals = {
      tls: {
        available: true,
        data: { issues: [], daysLeft: 90, validTo: 'Sep 27 00:00:00 2026 GMT', host: 'example.com' },
      },
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [tlsRule]);
    assert.strictEqual(findings.length, 0, 'no finding when issues is empty');
  });

  it('NO-FIRE: tls.available:false → no finding', () => {
    const runtimeSignals = {
      tls: { available: false, reason: 'origin not https' },
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [tlsRule]);
    assert.strictEqual(findings.length, 0, 'no finding when tls.available:false');
  });

  it('NO-FIRE: no runtimeSignals → no finding', () => {
    const ctx = { rows: baseRows, signals: {}, linkgraph: {} };
    const { findings } = runRules(ctx, [tlsRule]);
    assert.strictEqual(findings.length, 0, 'no finding when runtimeSignals absent');
  });

  it('NO-FIRE: null runtimeSignals → no finding', () => {
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals: null };
    const { findings } = runRules(ctx, [tlsRule]);
    assert.strictEqual(findings.length, 0, 'no finding when runtimeSignals is null');
  });

  it('NO-FIRE: runtimeSignals without tls field → no finding', () => {
    const runtimeSignals = { available: true, crux: { lcp: { p75: 1800, category: 'good' } }, generatedAt: '2026-06-29T00:00:00Z' };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [tlsRule]);
    assert.strictEqual(findings.length, 0, 'no finding when runtimeSignals has no tls field');
  });

  it('MEASURED-CLEAN: available:true + issues:[] → IS in positives (measured pass, not skipped)', () => {
    const runtimeSignals = {
      tls: {
        available: true,
        data: { issues: [], daysLeft: 90, validTo: 'Sep 27 00:00:00 2026 GMT', host: 'example.com' },
      },
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings, positives } = runRules(ctx, [tlsRule]);
    assert.strictEqual(findings.length, 0, 'no finding when issues is empty');
    assert.strictEqual(positives.length, 1, 'tech:tls-cert-expiring must be a positive when TLS present and clean');
    assert.strictEqual(positives[0].ruleId, 'tech:tls-cert-expiring');
  });
});

// ── U6.7: offline purity (analyzeFromFiles without runtime-signals.json) ──────

describe('U6.7 — offline purity (no runtime-signals.json → no tech:tls-cert-expiring)', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    // Ensure no runtime-signals.json exists in the data dir
    const rsPath = path.join(path.dirname(crawlResult.csvPath), 'runtime-signals.json');
    if (fs.existsSync(rsPath)) fs.unlinkSync(rsPath);
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  it('tech:tls-cert-expiring does NOT appear in findings (no runtime-signals.json)', () => {
    const f = analysis.findings.find(f => f.ruleId === 'tech:tls-cert-expiring');
    assert.ok(!f,
      `tech:tls-cert-expiring must NOT fire when no runtime-signals.json exists, but got: ${JSON.stringify(f)}`);
  });

  it('tech:tls-cert-expiring appears in NEITHER findings NOR positives when offline (skipped)', () => {
    const f = analysis.findings.find(f => f.ruleId === 'tech:tls-cert-expiring');
    const p = analysis.positives.find(p => p.ruleId === 'tech:tls-cert-expiring');
    assert.ok(!f, 'tech:tls-cert-expiring must NOT appear in findings when no runtime data');
    assert.ok(!p, 'tech:tls-cert-expiring must NOT appear in positives when no runtime data (skipped)');
  });
});

// ── U6.8: tech:safe-browsing-flagged synthetic detector tests ──────────────────

describe('U6.8 — tech:safe-browsing-flagged detector (synthetic ctx)', () => {
  const sbRule = {
    id: 'tech:safe-browsing-flagged',
    kategorie: 'tech-index',
    scope: 'agnostic',
    severity: 'hoch',
    title: 'Von Google Safe Browsing als Bedrohung markiert (Sicherheit/Trust)',
    quelle: 'Google Safe Browsing Lookup API v4',
    datum: '2026-06',
    params: {},
  };

  const baseRows = [
    { url: 'https://example.com/', wordCount: '200', error: '', redirected: '0', title: 'Home', canonical: 'https://example.com/', canonSelf: '1' },
    { url: 'https://example.com/a', wordCount: '200', error: '', redirected: '0', title: 'A', canonical: 'https://example.com/a', canonSelf: '1' },
    { url: 'https://example.com/b', wordCount: '200', error: '', redirected: '0', title: 'B', canonical: 'https://example.com/b', canonSelf: '1' },
    { url: 'https://example.com/c', wordCount: '200', error: '', redirected: '0', title: 'C', canonical: 'https://example.com/c', canonSelf: '1' },
    { url: 'https://example.com/d', wordCount: '200', error: '', redirected: '0', title: 'D', canonical: 'https://example.com/d', canonSelf: '1' },
  ];

  it('FIRE: safeBrowsing.available:true, data.flagged:true → count 1', () => {
    const runtimeSignals = {
      safeBrowsing: {
        available: true,
        data: { flagged: true, threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING'], target: 'https://example.com' },
      },
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [sbRule]);
    assert.strictEqual(findings.length, 1, 'should emit 1 finding when flagged');
    assert.strictEqual(findings[0].ruleId, 'tech:safe-browsing-flagged');
    assert.strictEqual(findings[0].count, 1);
    assert.ok(findings[0].detail.includes('MALWARE'), `detail should mention MALWARE: ${findings[0].detail}`);
    assert.ok(findings[0].detail.includes('https://example.com'), `detail should mention target: ${findings[0].detail}`);
  });

  it('NO-FIRE: safeBrowsing.data.flagged:false → no finding', () => {
    const runtimeSignals = {
      safeBrowsing: {
        available: true,
        data: { flagged: false, threatTypes: [], target: 'https://example.com' },
      },
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [sbRule]);
    assert.strictEqual(findings.length, 0, 'no finding when flagged is false');
  });

  it('NO-FIRE: safeBrowsing.available:false → no finding', () => {
    const runtimeSignals = {
      safeBrowsing: {
        available: false,
        reason: 'SAFEBROWSING_API_KEY not set',
      },
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [sbRule]);
    assert.strictEqual(findings.length, 0, 'no finding when available:false');
  });

  it('NO-FIRE: no runtimeSignals → no finding', () => {
    const ctx = { rows: baseRows, signals: {}, linkgraph: {} };
    const { findings } = runRules(ctx, [sbRule]);
    assert.strictEqual(findings.length, 0, 'no finding when runtimeSignals absent');
  });

  it('NO-FIRE: null runtimeSignals → no finding', () => {
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals: null };
    const { findings } = runRules(ctx, [sbRule]);
    assert.strictEqual(findings.length, 0, 'no finding when runtimeSignals is null');
  });

  it('NO-FIRE: runtimeSignals without safeBrowsing field → no finding', () => {
    const runtimeSignals = { available: true, crux: { lcp: { p75: 1800, category: 'good' } }, generatedAt: '2026-06-29T00:00:00Z' };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings } = runRules(ctx, [sbRule]);
    assert.strictEqual(findings.length, 0, 'no finding when runtimeSignals has no safeBrowsing field');
  });

  it('MEASURED-CLEAN: available:true + flagged:false → IS in positives (measured pass, not skipped)', () => {
    const runtimeSignals = {
      safeBrowsing: {
        available: true,
        data: { flagged: false, threatTypes: [], target: 'https://example.com' },
      },
    };
    const ctx = { rows: baseRows, signals: {}, linkgraph: {}, runtimeSignals };
    const { findings, positives } = runRules(ctx, [sbRule]);
    assert.strictEqual(findings.length, 0, 'no finding when flagged is false');
    assert.strictEqual(positives.length, 1, 'tech:safe-browsing-flagged must be a positive when SB present and clean');
    assert.strictEqual(positives[0].ruleId, 'tech:safe-browsing-flagged');
  });
});

// ── U6.8: offline purity (analyzeFromFiles without runtime-signals.json) ───────

describe('U6.8 — offline purity (no runtime-signals.json → no tech:safe-browsing-flagged)', () => {
  let srv, crawlResult, analysis;

  before(async () => {
    srv = await startFixtureServer();
    crawlResult = await runCrawl(srv.baseUrl, { rps: 50, maxUrls: 40, dataDir: freshDataDir() });
    // Ensure no runtime-signals.json exists in the data dir
    const rsPath = path.join(path.dirname(crawlResult.csvPath), 'runtime-signals.json');
    if (fs.existsSync(rsPath)) fs.unlinkSync(rsPath);
    analysis = await analyzeFromFiles(crawlResult.csvPath, crawlResult.signalsPath);
  });

  after(() => srv.close());

  it('tech:safe-browsing-flagged does NOT appear in findings (no runtime-signals.json)', () => {
    const f = analysis.findings.find(f => f.ruleId === 'tech:safe-browsing-flagged');
    assert.ok(!f,
      `tech:safe-browsing-flagged must NOT fire when no runtime-signals.json exists, but got: ${JSON.stringify(f)}`);
  });

  it('tech:safe-browsing-flagged appears in NEITHER findings NOR positives when offline (skipped)', () => {
    const f = analysis.findings.find(f => f.ruleId === 'tech:safe-browsing-flagged');
    const p = analysis.positives.find(p => p.ruleId === 'tech:safe-browsing-flagged');
    assert.ok(!f, 'tech:safe-browsing-flagged must NOT appear in findings when no runtime data');
    assert.ok(!p, 'tech:safe-browsing-flagged must NOT appear in positives when no runtime data (skipped)');
  });
});

// ── Batch 4c: Microdata/RDFa gating + render-resource robots-block (synthetic ctx) ──

describe('Batch 4c — Microdata/RDFa structured-data gating + render-resource block', () => {
  const ALL_RULES = loadRules(new URL('../config/rules', import.meta.url).pathname);
  const ruleFor = (id) => {
    const r = ALL_RULES.find(x => x.id === id);
    assert.ok(r, `config rule ${id} must exist`);
    return r;
  };
  // 5 filler rows → pageCount>=5 → minNMet=true so detail strings survive.
  const FILLER = () => Array.from({ length: 5 }, (_, i) =>
    ({ url: `http://example.com/f${i}`, status: '200', redirected: '0', wordCount: '300',
       hasOrg: '0', hasMicrodata: '0', hasRdfa: '0', ldTypes: '', resourcePaths: '' }));

  // ── schema:no-organization GATE ─────────────────────────────────────────────
  describe('schema:no-organization — Microdata/RDFa gate', () => {
    const rule = ruleFor('schema:no-organization');

    it('fires when no page has Organization in ANY structured-data format', () => {
      const ctx = { rows: FILLER(), signals: {}, linkgraph: {} };
      const { findings } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 1, 'should fire when truly no Organization markup');
    });

    it('does NOT fire when a page carries Microdata (hasMicrodata=1) — JSON-LD-only hasOrg would misfire', () => {
      const rows = FILLER();
      rows[0].hasMicrodata = '1';
      const ctx = { rows, signals: {}, linkgraph: {} };
      const { findings, positives } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 0, 'Microdata present → must NOT claim missing Organization');
      assert.ok(positives.find(p => p.ruleId === rule.id), 'should be a positive');
    });

    it('does NOT fire when a page carries RDFa (hasRdfa=1)', () => {
      const rows = FILLER();
      rows[2].hasRdfa = '1';
      const ctx = { rows, signals: {}, linkgraph: {} };
      const { findings } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 0, 'RDFa present → must NOT claim missing Organization');
    });
  });

  // ── schema:breadcrumb-missing GATE ──────────────────────────────────────────
  describe('schema:breadcrumb-missing — Microdata/RDFa gate', () => {
    const rule = ruleFor('schema:breadcrumb-missing');
    const deepRow = (extra) => ({ url: 'http://example.com/a/b/c', status: '200', redirected: '0',
      wordCount: '300', hasBreadcrumb: '0', hasMicrodata: '0', hasRdfa: '0', ldTypes: '', ...extra });

    it('fires for a deep JSON-LD page with no BreadcrumbList', () => {
      const rows = [...FILLER(), deepRow({})];
      const ctx = { rows, signals: {}, linkgraph: { depthByUrl: { 'http://example.com/a/b/c': 2 } } };
      const { findings } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 1, 'deep page without breadcrumb → fires');
      assert.ok(findings[0].affectedUrls.includes('http://example.com/a/b/c'));
    });

    it('does NOT fire for the same deep page when it uses Microdata (hasMicrodata=1)', () => {
      const rows = [...FILLER(), deepRow({ hasMicrodata: '1' })];
      const ctx = { rows, signals: {}, linkgraph: { depthByUrl: { 'http://example.com/a/b/c': 2 } } };
      const { findings } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 0, 'Microdata breadcrumb → must NOT flag missing');
    });
  });

  // ── schema:microdata-only (informational) ───────────────────────────────────
  describe('schema:microdata-only — informational nudge', () => {
    const rule = ruleFor('schema:microdata-only');

    it('fires for a Microdata-only page (hasMicrodata=1, ldTypes empty)', () => {
      const rows = [...FILLER(), { url: 'http://example.com/md', status: '200', redirected: '0',
        wordCount: '300', hasMicrodata: '1', hasRdfa: '0', ldTypes: '' }];
      const ctx = { rows, signals: {}, linkgraph: {} };
      const { findings } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 1, 'Microdata-only page → informational fire');
      assert.ok(/KEIN Defekt/i.test(findings[0].detail), 'detail frames it as not-a-defect');
    });

    it('does NOT fire when the page ALSO has JSON-LD (ldTypes non-empty)', () => {
      const rows = [...FILLER(), { url: 'http://example.com/both', status: '200', redirected: '0',
        wordCount: '300', hasMicrodata: '1', hasRdfa: '0', ldTypes: 'Organization' }];
      const ctx = { rows, signals: {}, linkgraph: {} };
      const { findings, positives } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 0, 'JSON-LD already present → no nudge');
      assert.ok(positives.find(p => p.ruleId === rule.id), 'should be a positive');
    });
  });

  // ── tech:robots-blocked-resources ───────────────────────────────────────────
  describe('tech:robots-blocked-resources — render-resource robots block', () => {
    const rule = ruleFor('tech:robots-blocked-resources');
    const robots = { exists: true, disallow: ['/assets/'], allow: [] };

    it('fires for a page whose same-origin resource path is robots-disallowed', () => {
      const rows = [...FILLER(), { url: 'http://example.com/p', status: '200', redirected: '0',
        wordCount: '300', resourcePaths: '/assets/app.css|/js/ok.js' }];
      const ctx = { rows, signals: { robots }, linkgraph: {} };
      const { findings } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 1, 'blocked /assets/ resource → fires');
      assert.ok(findings[0].affectedUrls.includes('http://example.com/p'));
      assert.ok(/KEIN Ranking-Faktor/i.test(findings[0].detail), 'detail carries eligibility-not-ranking framing');
    });

    it('does NOT fire when all referenced resources are robots-allowed', () => {
      const rows = [...FILLER(), { url: 'http://example.com/p', status: '200', redirected: '0',
        wordCount: '300', resourcePaths: '/css/ok.css|/js/ok.js' }];
      const ctx = { rows, signals: { robots }, linkgraph: {} };
      const { findings, positives } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 0, 'all resources allowed → no fire');
      assert.ok(positives.find(p => p.ruleId === rule.id), 'should be a positive');
    });

    it('does NOT fire when robots.txt has no Disallow rules (early positive)', () => {
      const rows = [...FILLER(), { url: 'http://example.com/p', status: '200', redirected: '0',
        wordCount: '300', resourcePaths: '/assets/app.css' }];
      const ctx = { rows, signals: { robots: { exists: true, disallow: [], allow: [] } }, linkgraph: {} };
      const { findings } = runRules(ctx, [rule]);
      assert.strictEqual(findings.length, 0, 'no disallow rules → nothing blocked');
    });
  });
});

// ── Round-2 D9: coveragePct must not overstate coverage on a capped sitemap ───
import { MAX_TOTAL_LOCS } from '../crawl/sitefetch.mjs';

describe('analyze — coveragePct vs. capped sitemap (D9 anti-overclaim)', () => {
  it('reports null coverage when the sitemap URL set hit the MAX_TOTAL_LOCS cap', () => {
    // At the cap the real sitemap may be larger than the truncated set, so fetched/cappedTotal
    // would OVERSTATE coverage (e.g. 25k/50k = 50% while true coverage is 12.5%).
    const signals = { sitemapUrls: new Array(MAX_TOTAL_LOCS).fill('http://x/a'), crawlMeta: { fetched: 25000 } };
    const { meta } = analyze([], signals, {}, []);
    assert.strictEqual(meta.coveragePct, null,
      'coveragePct must be null when the sitemap set is capped (no overclaim)');
  });

  it('still computes coverage for an uncapped sitemap', () => {
    const signals = { sitemapUrls: new Array(100).fill('http://x/a'), crawlMeta: { fetched: 80 } };
    const { meta } = analyze([], signals, {}, []);
    assert.strictEqual(meta.coveragePct, 80, 'normal coverage unchanged below the cap');
  });
});
