/**
 * test/eval-lib.test.mjs — Unit tests for eval/lib helpers (ruleids, kb-citations, fixtures).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findingRuleIds, producedRuleIds, analysisRuleIds, positiveRuleIds } from '../eval/lib/ruleids.mjs';
import { extractInterpretedRuleIds } from '../bin/handoff.mjs';
import { buildCitationAllowlist, isValidCitation } from '../eval/lib/kb-citations.mjs';
import path from 'node:path';
import os from 'node:os';
import { listFixtures, loadFixture, loadRuns, parseAffectedUrls } from '../eval/lib/fixtures.mjs';

describe('eval/lib/ruleids', () => {
  it('findingRuleIds prefers first-class ruleIds[]', () => {
    assert.deepEqual(findingRuleIds({ ruleIds: ['b:y', 'a:x'] }), ['a:x', 'b:y'],
      'ruleIds[] should be used verbatim, sorted+deduped');
  });
  it('findingRuleIds scrapes ruleId= clauses from beleg (folded ids captured)', () => {
    const f = { beleg: 'analysis.json ruleId=tech:sitemap-quality + tech:noindex-conflict; more text' };
    assert.deepEqual(findingRuleIds(f), ['tech:noindex-conflict', 'tech:sitemap-quality'],
      'both folded rule ids inside the ruleId= clause must be captured');
  });
  it('producedRuleIds matches the canonical handoff extractor on the real golden findings', () => {
    const g = JSON.parse(fs.readFileSync(new URL('../examples/example-run/findings.json', import.meta.url), 'utf8'));
    assert.deepEqual(producedRuleIds(g), extractInterpretedRuleIds(g),
      'eval producedRuleIds must agree with bin/handoff.mjs extractInterpretedRuleIds (parity)');
    assert.ok(producedRuleIds(g).length > 0, 'golden findings must yield rule ids');
  });
  it('analysisRuleIds / positiveRuleIds read the deterministic analysis shape', () => {
    const a = { findings: [{ ruleId: 'a:1' }, { ruleId: 'a:1' }, { ruleId: 'b:2' }], positives: [{ ruleId: 'c:3' }] };
    assert.deepEqual(analysisRuleIds(a), ['a:1', 'b:2'], 'analysis rule ids sorted+deduped');
    assert.deepEqual(positiveRuleIds(a), ['c:3'], 'positive rule ids sorted+deduped');
  });
});

describe('eval/lib/kb-citations', () => {
  const allow = buildCitationAllowlist();
  it('collects all 8 corpus source URLs', () => {
    assert.equal(allow.urls.size, 8, 'exactly 8 KB corpus files → 8 source URLs');
    assert.ok(allow.urls.has('https://arxiv.org/abs/2311.09735'), 'geo cite-sources URL present');
  });
  it('accepts a real corpus URL and the filename form, rejects a fabricated one', () => {
    assert.equal(isValidCitation('https://web.dev/articles/vitals', allow), true, 'real URL is valid');
    assert.equal(isValidCitation('05-meta-tags.md', allow), true, 'basename form is valid');
    assert.equal(isValidCitation('https://example.com/made-up', allow), false, 'fabricated URL is invalid');
  });
});

describe('eval/lib/fixtures', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-eval-'));
  const fixDir = path.join(tmp, 'fixtures');
  const runDir = path.join(tmp, 'runs');
  fs.mkdirSync(path.join(fixDir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(fixDir, 'demo', 'analysis.json'), JSON.stringify({ meta: {}, findings: [], positives: [] }));
  fs.writeFileSync(path.join(fixDir, 'demo', 'expected-findings.json'), JSON.stringify({ fixture: 'demo', mustContain: [], mustNotContain: [] }));
  fs.writeFileSync(path.join(fixDir, 'demo', 'affected-urls.csv'), 'ruleId,url\na:1,http://h/x\n');
  fs.mkdirSync(path.join(runDir, 'demo', 'run-1'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'demo', 'run-1', 'findings.json'), JSON.stringify({ sections: [] }));
  it('lists fixtures and loads one with parsed affected-urls', () => {
    assert.deepEqual(listFixtures(fixDir), ['demo'], 'lists the demo fixture');
    const fx = loadFixture(fixDir, 'demo');
    assert.equal(fx.expected.fixture, 'demo', 'loads expected-findings');
    assert.deepEqual(fx.affectedUrls, [{ ruleId: 'a:1', url: 'http://h/x' }], 'parses affected-urls.csv');
  });
  it('loads runs sorted by run number', () => {
    const runs = loadRuns(runDir, 'demo');
    assert.equal(runs.length, 1, 'one run present'); assert.equal(runs[0].run, 1, 'run number parsed');
  });
  it('parseAffectedUrls drops header and blanks', () => {
    assert.deepEqual(parseAffectedUrls('ruleId,url\n\nb:2,http://h/y\n'), [{ ruleId: 'b:2', url: 'http://h/y' }], 'header+blank dropped');
  });
});
