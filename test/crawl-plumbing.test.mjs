/**
 * test/crawl-plumbing.test.mjs — review-2026-07-06 crawl-plumbing fixes.
 *
 *   1. buildRow dropped `ldContextOk` → schema:context-invalid could never fire.
 *   2. parseCsv split on newlines before quote-awareness → resume dedup corruption
 *      on titles containing an embedded newline (its own writer emits them).
 *   3. a throwing parsePage aborted the whole crawl → one bad page must not kill it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRow, safeParse, writeFileAtomic } from '../crawl/run.mjs';
import { COLS, toCsvRow, parseCsv } from '../crawl/schema.mjs';
import { parsePage } from '../crawl/parse.mjs';

const PAGE = {
  url: 'http://x/', type: 'html', status: 200, finalUrl: 'http://x/',
  redirected: false, redirectChain: [], httpsOk: true, error: null,
  xRobotsTag: '', hstsPresent: 0, frameProtection: 0, contentEncoding: '',
  nosniffPresent: 0, referrerPolicyPresent: 0, permissionsPolicyPresent: 0,
  cspPresent: 0, cookieInsecure: 0, versionDisclosure: 0,
};

describe('buildRow — COLS completeness', () => {
  it('assigns EVERY COLS column (no silently dropped signal)', () => {
    const parsed = parsePage(
      '<html><head><title>t</title></head><body>hello world here</body></html>',
      'http://x/',
    );
    const row = buildRow(PAGE, parsed);
    const missing = COLS.filter((c) => !(c in row));
    assert.deepEqual(missing, [], `buildRow must assign every COLS key; missing: ${missing}`);
  });

  it('carries the parsed ldContextOk value through to the row', () => {
    // A JSON-LD block whose @context is not schema.org → ldContextOk === 0.
    const html = '<html><head><title>t</title>' +
      '<script type="application/ld+json">{"@context":"https://example.com","@type":"Thing"}</script>' +
      '</head><body>hello world here today</body></html>';
    const row = buildRow(PAGE, parsePage(html, 'http://x/'));
    assert.equal(row.ldContextOk, 0, 'ldContextOk=0 must reach the CSV row (drives schema:context-invalid)');
  });
});

describe('parseCsv — RFC 4180 embedded newlines', () => {
  it('round-trips a field containing an embedded newline', () => {
    const row = {};
    for (const c of COLS) row[c] = '';
    row.url = 'http://x/page';
    row.title = 'Line one\nLine two'; // e.g. a Yoast title with a &#10; char-ref
    const csv = [COLS.join(','), toCsvRow(row)].join('\n');

    const parsed = parseCsv(csv);
    assert.equal(parsed.length, 1, 'one written row must parse back as exactly one row');
    assert.equal(parsed[0].url, 'http://x/page');
    assert.equal(parsed[0].title, 'Line one\nLine two');
  });

  it('round-trips a field with an embedded CRLF and a comma', () => {
    const row = {};
    for (const c of COLS) row[c] = '';
    row.url = 'http://x/2';
    row.title = 'a,\r\nb';
    const csv = [COLS.join(','), toCsvRow(row)].join('\n');
    const parsed = parseCsv(csv);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].title, 'a,\r\nb');
  });
});

describe('writeFileAtomic — no torn artifacts', () => {
  it('writes the content and leaves no .tmp sibling behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
    try {
      const f = path.join(dir, 'crawl.csv');
      writeFileAtomic(f, 'header\nrow1');
      assert.equal(fs.readFileSync(f, 'utf8'), 'header\nrow1');
      assert.ok(!fs.existsSync(`${f}.tmp`), 'the temp file must be renamed away, not left behind');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('safeParse — one bad page must not kill the crawl', () => {
  it('returns {} (not a throw) when the parser throws', () => {
    let out;
    assert.doesNotThrow(() => {
      out = safeParse('<html>…</html>', 'http://x/', () => { throw new Error('boom'); });
    });
    assert.deepEqual(out, {});
  });

  it('delegates to parsePage on the happy path', () => {
    const out = safeParse('<html><head><title>ok</title></head><body>hi there</body></html>', 'http://x/');
    assert.equal(out.title, 'ok');
  });
});
