/**
 * test/sitefetch.test.mjs — sitemap residency caps (D9).
 *
 * Proves the sitemaps.org per-file 50,000-loc limit (MAX_LOCS_PER_FILE) is
 * enforced in parseSitemap and that a total-ingestion residency cap
 * (MAX_TOTAL_LOCS) bounds the unioned <loc> set in expandSitemap. Both
 * truncate in deterministic document/index order. Under-cap inputs are
 * returned unchanged (behavior-preservation guard for normal-sized sitemaps).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSitemap,
  expandSitemap,
  MAX_LOCS_PER_FILE,
  MAX_TOTAL_LOCS,
} from '../crawl/sitefetch.mjs';

/** Build a <urlset> XML string with `count` <loc> entries: <origin>/<prefix>-<i>.html */
function makeUrlset(origin, count, prefix) {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (let i = 0; i < count; i++) {
    parts.push(`  <url><loc>${origin}/${prefix}-${i}.html</loc></url>`);
  }
  parts.push('</urlset>');
  return parts.join('\n');
}

describe('parseSitemap — per-file 50k loc cap (D9)', () => {
  it('truncates a single file at MAX_LOCS_PER_FILE in document order', () => {
    const origin = 'https://example.com';
    const xml = makeUrlset(origin, MAX_LOCS_PER_FILE + 5, 'p');
    const urls = parseSitemap(xml);

    assert.strictEqual(urls.length, MAX_LOCS_PER_FILE,
      `expected exactly ${MAX_LOCS_PER_FILE} locs, got ${urls.length}`);
    // Document order: the FIRST locs are kept, the overflow tail is dropped.
    assert.strictEqual(urls[0], `${origin}/p-0.html`);
    assert.strictEqual(urls[MAX_LOCS_PER_FILE - 1], `${origin}/p-${MAX_LOCS_PER_FILE - 1}.html`);
    assert.ok(!urls.includes(`${origin}/p-${MAX_LOCS_PER_FILE}.html`),
      'the first overflow loc must be truncated');
  });

  it('returns an under-cap file unchanged (behavior-preserving for normal sitemaps)', () => {
    const origin = 'https://example.com';
    const xml = makeUrlset(origin, 22, 'u');   // fixture-scale (~22 locs)
    const urls = parseSitemap(xml);
    assert.strictEqual(urls.length, 22);
    assert.strictEqual(urls[0], `${origin}/u-0.html`);
    assert.strictEqual(urls[21], `${origin}/u-21.html`);
  });
});

describe('expandSitemap — total-ingestion residency cap (D9)', () => {
  it('caps the unioned loc set at MAX_TOTAL_LOCS across a sitemapindex (index order)', async () => {
    const origin = 'https://example.com';
    const sitemapUrl = `${origin}/sitemap.xml`;
    const childA = `${origin}/sm-a.xml`;
    const childB = `${origin}/sm-b.xml`;

    // Each child holds well under the per-file cap, but together they exceed the
    // total cap (30k + 30k = 60k ⇒ truncated to MAX_TOTAL_LOCS=50k).
    const perChild = Math.floor(MAX_TOTAL_LOCS * 0.6);   // 30k
    const indexXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      `  <sitemap><loc>${childA}</loc></sitemap>`,
      `  <sitemap><loc>${childB}</loc></sitemap>`,
      '</sitemapindex>',
    ].join('\n');

    const bodies = {
      [childA]: makeUrlset(origin, perChild, 'a'),
      [childB]: makeUrlset(origin, perChild, 'b'),
    };
    const fetchImpl = async (url) =>
      bodies[url] != null ? { status: 200, body: bodies[url] } : { status: 404, body: null };

    const { urls, files } = await expandSitemap(indexXml, sitemapUrl, fetchImpl);

    assert.strictEqual(urls.length, MAX_TOTAL_LOCS,
      `expected union truncated to ${MAX_TOTAL_LOCS}, got ${urls.length}`);
    // Index order: all of child A, then child B up to the cap.
    assert.strictEqual(urls[0], `${origin}/a-0.html`);
    assert.ok(urls.includes(`${origin}/a-${perChild - 1}.html`), 'all of child A is kept');
    assert.ok(urls.includes(`${origin}/b-0.html`), 'child B begins contributing');
    const keptFromB = MAX_TOTAL_LOCS - perChild;   // 20k
    assert.ok(!urls.includes(`${origin}/b-${keptFromB}.html`),
      'child B is truncated at the total cap (document order)');
    assert.strictEqual(files.length, 2, 'both child files are accounted for');
  });
});
