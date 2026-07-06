import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COLS, toCsvRow, parseCsv } from '../crawl/schema.mjs';

describe('COLS', () => {
  it('has no duplicate column names', () => {
    const seen = new Set();
    for (const col of COLS) {
      assert.ok(!seen.has(col), `Duplicate column: ${col}`);
      seen.add(col);
    }
  });

  it('contains exactly the specified columns in order', () => {
    const expected = [
      'url', 'type', 'status', 'finalUrl', 'redirected', 'redirectChain',
      'title', 'titleLen', 'metaDesc', 'metaDescLen', 'metaMissing', 'canonical',
      'canonSelf', 'robotsMeta', 'htmlLang', 'hreflangCount', 'hreflang',
      'h1', 'h1Count', 'headingOutline', 'ldTypes', 'ldValid', 'ldContextOk', 'hasProduct',
      'hasAgg', 'hasBreadcrumb', 'hasOrg', 'hasOrgSameAs', 'hasFAQ', 'hasAuthor',
      'datePublished', 'dateModified', 'offerPrice', 'availability', 'imgTotal',
      'imgNoAlt', 'imgJpg', 'imgWebp', 'imgAvif', 'outlinksInternal',
      'outlinksAuthoritative', 'wordCount', 'rawWordCount', 'httpsOk', 'mixedContent',
      'error', 'viewportContent', 'charsetOk',
      'ogTitle', 'ogImage', 'ogUrl', 'hasFavicon', 'canonicalCount',
      'imgNoDimensions', 'firstImgLazy',
      'domNodeCount', 'headBlockingScripts', 'headBlockingStyles',
      'genericAnchorCount', 'emptyLinkCount', 'unlabeledControlCount',
      'aggRatingValue', 'aggRatingCount', 'hasShippingDetails', 'hasReturnPolicy', 'hasOrgLogo', 'hasOrgContactPoint',
      'xRobotsTag', 'hstsPresent', 'frameProtection', 'contentEncoding',
      'hreflangLinks',
      'nosniffPresent', 'referrerPolicyPresent', 'permissionsPolicyPresent',
      'cspPresent', 'cookieInsecure', 'versionDisclosure',
      'hasMicrodata', 'hasRdfa', 'resourcePaths',
      'outlinksExternal',
    ];
    assert.deepEqual(COLS, expected);
  });
});

describe('toCsvRow / parseCsv round-trip', () => {
  it('round-trips a simple object', () => {
    const obj = {};
    for (const col of COLS) obj[col] = '';
    obj.url = 'https://example.com/page';
    obj.title = 'Hello World';
    obj.status = '200';

    const headerLine = COLS.join(',');
    const dataLine = toCsvRow(obj);
    const rows = parseCsv(headerLine + '\n' + dataLine);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, obj.url);
    assert.equal(rows[0].title, obj.title);
    assert.equal(rows[0].status, obj.status);
  });

  it('round-trips a value containing a comma', () => {
    const obj = {};
    for (const col of COLS) obj[col] = '';
    obj.title = 'Shoes, Bags & More';

    const headerLine = COLS.join(',');
    const rows = parseCsv(headerLine + '\n' + toCsvRow(obj));
    assert.equal(rows[0].title, 'Shoes, Bags & More');
  });

  it('round-trips a value containing a double-quote', () => {
    const obj = {};
    for (const col of COLS) obj[col] = '';
    obj.metaDesc = 'He said "hello" to her';

    const headerLine = COLS.join(',');
    const rows = parseCsv(headerLine + '\n' + toCsvRow(obj));
    assert.equal(rows[0].metaDesc, 'He said "hello" to her');
  });

  it('round-trips a value containing both comma and quote', () => {
    const obj = {};
    for (const col of COLS) obj[col] = '';
    obj.headingOutline = 'H1: "Products, Services"';

    const headerLine = COLS.join(',');
    const rows = parseCsv(headerLine + '\n' + toCsvRow(obj));
    assert.equal(rows[0].headingOutline, 'H1: "Products, Services"');
  });
});
