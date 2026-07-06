/**
 * test/parse-hardening.test.mjs — review-2026-07-06 parser robustness fixes.
 *
 * Regression guards for four parse.mjs defects surfaced in the deep review:
 *   1. malformed numeric HTML entity (> U+10FFFF) crashed the whole crawl
 *   2. unquoted HTML5 attributes were invisible (noindex false-negatives)
 *   3. a `>` inside a quoted attribute truncated the value (false "meta too short")
 *   4. whitespace-only word counting read CJK pages as empty (whole-page skip)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '../crawl/parse.mjs';

const URL = 'https://example.com/';
const doc = (head = '', body = '') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('parse hardening — malformed numeric entity must not crash', () => {
  it('an out-of-range numeric character reference does not throw', () => {
    assert.doesNotThrow(() => parsePage(doc('<title>&#x110000;</title>'), URL));
    assert.doesNotThrow(() => parsePage(doc('<title>&#99999999999;</title>'), URL));
  });

  it('an out-of-range reference becomes U+FFFD (replacement char), not a crash', () => {
    const r = parsePage(doc('<title>A&#x110000;B</title>'), URL);
    assert.equal(r.title, 'A�B');
  });

  it('a valid astral entity still decodes correctly (no over-eager guard)', () => {
    const r = parsePage(doc('<title>hi &#x1F600;</title>'), URL);
    assert.equal(r.title, 'hi \u{1F600}'); // 😀
  });
});

describe('parse hardening — unquoted HTML5 attributes', () => {
  it('unquoted robots meta is seen (noindex not silently missed)', () => {
    const r = parsePage(doc('<meta name=robots content=noindex>'), URL);
    assert.equal(r.robotsMeta, 'noindex');
  });

  it('unquoted meta description is captured', () => {
    const r = parsePage(doc('<meta name=description content=Hello>'), URL);
    assert.equal(r.metaDesc, 'Hello');
    assert.equal(r.metaMissing, 0);
  });

  it('unquoted <html lang> is captured', () => {
    const r = parsePage('<html lang=de><head></head><body>x</body></html>', URL);
    assert.equal(r.htmlLang, 'de');
  });
});

describe('parse hardening — `>` inside a quoted attribute value', () => {
  it('a `>` inside content= does not truncate the meta description', () => {
    const r = parsePage(doc('<meta name="description" content="Best a > b guide">'), URL);
    assert.equal(r.metaDesc, 'Best a > b guide');
    assert.equal(r.metaMissing, 0);
  });
});

describe('parse hardening — CJK word counting', () => {
  it('a CJK paragraph is not read as empty', () => {
    // 24 Han characters — a real, substantial paragraph.
    const cjk = '搜索引擎优化是提升网站在搜索结果中可见度的过程内容质量很重要';
    const r = parsePage(doc('', `<p>${cjk}</p>`), URL);
    assert.equal(r.isEmpty, false, 'CJK content must not classify the page as an empty JS-shell');
    assert.ok(r.wordCount >= 20, `expected many CJK word-tokens, got ${r.wordCount}`);
  });

  it('Latin word counting is unchanged (no regression)', () => {
    const r = parsePage(doc('', '<p>the quick brown fox jumps over</p>'), URL);
    assert.equal(r.wordCount, 6);
  });
});
