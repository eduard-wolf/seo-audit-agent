import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateFindings } from '../lib/findings-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('validateFindings', () => {
  it('accepts a valid minimal findings object', () => {
    const valid = buildValidFindings();
    const result = validateFindings(valid);
    assert.equal(result.valid, true, `Expected valid but got errors: ${result.errors.join('; ')}`);
    assert.deepEqual(result.errors, []);
  });

  it('rejects an object missing "meta" and with wrong severity', () => {
    const bad = buildValidFindings();
    delete bad.meta;
    bad.sections[0].findings[0].severity = 'critical'; // not in enum
    const result = validateFindings(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 2, `Expected >=2 errors, got ${result.errors.length}: ${result.errors.join('; ')}`);
    const combined = result.errors.join(' ');
    assert.ok(combined.includes('meta'), 'Should mention missing "meta"');
    assert.ok(combined.includes('severity'), 'Should mention invalid "severity"');
  });

  it('rejects missing execSummary', () => {
    const bad = buildValidFindings();
    delete bad.execSummary;
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('execSummary')));
  });

  it('rejects invalid prov value', () => {
    const bad = buildValidFindings();
    bad.sections[0].findings[0].prov = 'unknown';
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('prov')));
  });

  it('rejects non-numeric ice fields', () => {
    const bad = buildValidFindings();
    bad.sections[0].findings[0].ice.i = 'high';
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('ice')));
  });

  it('rejects sections not being an array', () => {
    const bad = buildValidFindings();
    bad.sections = 'not-an-array';
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('sections')));
  });

  it('accepts kbSources as array of objects with a "source" field', () => {
    const good = buildValidFindings();
    good.sections[0].findings[0].kbSources = [
      { source: '05-meta-tags.md', heading: 'Meta Description', date: '2024-09' },
    ];
    const { valid, errors } = validateFindings(good);
    assert.equal(valid, true, `Expected valid but got: ${errors.join('; ')}`);
  });

  it('rejects kbSources containing strings instead of objects', () => {
    const bad = buildValidFindings();
    bad.sections[0].findings[0].kbSources = ['kb/on-page-seo.md'];
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('kbSources')), `Expected kbSources error, got: ${errors.join('; ')}`);
  });

  it('rejects kbSources object missing the "source" field', () => {
    const bad = buildValidFindings();
    bad.sections[0].findings[0].kbSources = [{ heading: 'Meta Description', date: '2024-09' }];
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('kbSources')), `Expected kbSources error, got: ${errors.join('; ')}`);
  });

  it('accepts ice with valid 1–3 anchors and correct product score', () => {
    const good = buildValidFindings();
    good.sections[0].findings[0].ice = { i: 3, c: 2, e: 1, score: 6 };
    const { valid, errors } = validateFindings(good);
    assert.equal(valid, true, `Expected valid but got: ${errors.join('; ')}`);
  });

  it('rejects ice.score that does not equal i×c×e', () => {
    const bad = buildValidFindings();
    bad.sections[0].findings[0].ice = { i: 3, c: 3, e: 2, score: 10 }; // should be 18
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('ice.score')), `Expected ice.score error, got: ${errors.join('; ')}`);
  });

  it('rejects ice anchor out of {1,2,3} (e.g. i=7)', () => {
    const bad = buildValidFindings();
    bad.sections[0].findings[0].ice = { i: 7, c: 2, e: 2, score: 28 };
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('ice.i')), `Expected ice.i anchor error, got: ${errors.join('; ')}`);
  });

  it('validates the examples/findings.example.json file', () => {
    const raw = readFileSync(path.join(ROOT, 'examples/findings.example.json'), 'utf8');
    const example = JSON.parse(raw);
    const result = validateFindings(example);
    assert.equal(result.valid, true, `Example file invalid: ${result.errors.join('; ')}`);
  });

  // ── U0.3 Typ-Härtung: Negativ-Tests (RED → GREEN) ─────────────────────────

  it('rejects confidence.minNMet as string "false" (muss boolean sein)', () => {
    const bad = buildValidFindings();
    bad.confidence.minNMet = 'false';
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => e.includes('minNMet')),
      `Expected minNMet-Fehler, erhalten: ${errors.join('; ')}`,
    );
  });

  it('rejects object in positives[] (Elemente müssen Strings sein)', () => {
    const bad = buildValidFindings();
    bad.positives = [{ text: 'sollte ein String sein' }];
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => e.includes('positives')),
      `Expected positives-Fehler, erhalten: ${errors.join('; ')}`,
    );
  });

  it('rejects object as finding.befund (muss string sein)', () => {
    const bad = buildValidFindings();
    bad.sections[0].findings[0].befund = { text: 'sollte ein String sein' };
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => e.includes('befund')),
      `Expected befund-Fehler, erhalten: ${errors.join('; ')}`,
    );
  });

  it('rejects section.num as string "1" (muss number sein)', () => {
    const bad = buildValidFindings();
    bad.sections[0].num = '1';
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => e.includes('num')),
      `Expected num-Fehler, erhalten: ${errors.join('; ')}`,
    );
  });

  it('rejects kbSources[].source as number 123 (muss string sein)', () => {
    const bad = buildValidFindings();
    bad.sections[0].findings[0].kbSources = [{ source: 123 }];
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => e.includes('source')),
      `Expected source-Fehler, erhalten: ${errors.join('; ')}`,
    );
  });

  it('rejects object in strategy.levers[] (Elemente müssen Strings sein)', () => {
    const bad = buildValidFindings();
    bad.strategy.levers = [{ text: 'sollte ein String sein' }];
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => e.includes('levers')),
      `Expected levers-Fehler, erhalten: ${errors.join('; ')}`,
    );
  });

  // ── U0.3 Positiv-Tests: erlaubte null-Werte bleiben valide ────────────────

  it('akzeptiert meta.crawledAt als null (ehrlicher Null-Fallback)', () => {
    const good = buildValidFindings();
    good.meta.crawledAt = null;
    const { valid, errors } = validateFindings(good);
    assert.equal(valid, true, `Expected valid, erhalten: ${errors.join('; ')}`);
  });

  it('akzeptiert meta.coveragePct als null (ehrlicher Null-Fallback)', () => {
    const good = buildValidFindings();
    good.meta.coveragePct = null;
    const { valid, errors } = validateFindings(good);
    assert.equal(valid, true, `Expected valid, erhalten: ${errors.join('; ')}`);
  });

  // ── Batch D6/D11: beleg ruleId token (#9) + ICE minNMet cap (#10) ──────────

  it('accepts a beleg that references analysis and carries a ruleId= token (#9)', () => {
    const good = buildValidFindings();
    good.sections[0].findings[0].beleg = 'analysis.json affectedUrls; ruleId=meta:missing';
    const { valid, errors } = validateFindings(good);
    assert.equal(valid, true, `Expected valid, got: ${errors.join('; ')}`);
  });

  it('rejects a beleg that references analysis but lacks a ruleId= token (#9)', () => {
    const bad = buildValidFindings();
    bad.sections[0].findings[0].beleg = 'analysis.json affectedUrls';
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => /beleg/.test(e) && /ruleId/.test(e)),
      `Expected beleg ruleId error, got: ${errors.join('; ')}`,
    );
  });

  it('leaves crawl.csv/signals.json belegs (no "analysis") unaffected by the ruleId rule (#9)', () => {
    const good = buildValidFindings();
    good.sections[0].findings[0].beleg = 'crawl.csv rows 3-14 (metaMissing=true)';
    const { valid, errors } = validateFindings(good);
    assert.equal(valid, true, `Expected valid, got: ${errors.join('; ')}`);
  });

  it('rejects ice.c > 1 when confidence.minNMet === false (#10, anti-overclaim)', () => {
    const bad = buildValidFindings();
    bad.confidence.sampleSize = 3; // keep minNMet=false consistent with the deterministic gate
    bad.confidence.minNMet = false;
    bad.sections[0].findings[0].ice = { i: 3, c: 2, e: 2, score: 12 };
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => /ice\.c/.test(e) && /minNMet/.test(e)),
      `Expected ice.c minNMet cap error, got: ${errors.join('; ')}`,
    );
  });

  it('accepts ice.c = 1 when confidence.minNMet === false (#10, positive)', () => {
    const good = buildValidFindings();
    good.confidence.sampleSize = 3; // keep minNMet=false consistent with the deterministic gate
    good.meta.sampleSize = 3;       // meta + confidence describe the same crawl
    good.confidence.minNMet = false;
    good.sections[0].findings[0].ice = { i: 3, c: 1, e: 2, score: 6 };
    const { valid, errors } = validateFindings(good);
    assert.equal(valid, true, `Expected valid, got: ${errors.join('; ')}`);
  });

  it('does NOT cap ice.c when confidence.minNMet === true (#10)', () => {
    const good = buildValidFindings();
    good.confidence.minNMet = true;
    good.sections[0].findings[0].ice = { i: 3, c: 3, e: 3, score: 27 };
    const { valid, errors } = validateFindings(good);
    assert.equal(valid, true, `Expected valid, got: ${errors.join('; ')}`);
  });

  it('rejects minNMet=true when sampleSize < 5 (deterministic gate, not self-declared)', () => {
    // minNMet is deterministically (sampleSize >= 5) in the engine; a findings.json that
    // self-declares minNMet=true on a 3-page sample would silently disable the anti-overclaim
    // ICE cap. The validator must reject the inconsistency.
    const bad = buildValidFindings();
    bad.confidence.sampleSize = 3;
    bad.confidence.minNMet = true;
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => /minNMet/.test(e) && /sampleSize/.test(e)),
      `Expected minNMet/sampleSize consistency error, got: ${errors.join('; ')}`,
    );
  });

  it('rejects minNMet=false when sampleSize >= 5', () => {
    const bad = buildValidFindings();
    bad.confidence.sampleSize = 10;
    bad.confidence.minNMet = false;
    bad.sections[0].findings[0].ice = { i: 3, c: 1, e: 2, score: 6 }; // satisfy the c<=1 cap so only the consistency error surfaces
    const { valid, errors } = validateFindings(bad);
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => /minNMet/.test(e) && /sampleSize/.test(e)),
      `Expected minNMet/sampleSize consistency error, got: ${errors.join('; ')}`,
    );
  });

  it('accepts a consistent small sample (sampleSize < 5, minNMet=false, c<=1)', () => {
    const good = buildValidFindings();
    good.confidence.sampleSize = 3;
    good.meta.sampleSize = 3;       // meta + confidence describe the same crawl
    good.confidence.minNMet = false;
    good.sections[0].findings[0].ice = { i: 3, c: 1, e: 2, score: 6 };
    const { valid, errors } = validateFindings(good);
    assert.equal(valid, true, `Expected valid, got: ${errors.join('; ')}`);
  });

  it('keeps the committed example-run findings.json valid after #9/#10 (D6/D11)', () => {
    const raw = readFileSync(path.join(ROOT, 'examples/example-run/findings.json'), 'utf8');
    const example = JSON.parse(raw);
    const result = validateFindings(example);
    assert.equal(result.valid, true, `example-run findings.json invalid: ${result.errors.join('; ')}`);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function buildValidFindings() {
  return {
    meta: {
      url: 'https://example.com',
      crawledAt: '2026-06-27T10:00:00Z',
      modelId: 'claude-opus-4',
      rulesetVersion: '1.0.0',
      sampleSize: 50,
      coveragePct: 80,
      siteType: 'ecommerce',
    },
    execSummary: {
      metrics: ['50 pages crawled'],
      patterns: ['thin content on category pages'],
      quickWins: ['add meta descriptions to 12 pages'],
    },
    sections: [
      {
        id: 'sec-1',
        num: 1,
        title: 'Technical SEO',
        findings: [
          {
            id: 'f-1',
            title: 'Missing meta descriptions',
            category: 'on-page',
            severity: 'hoch',
            prov: 'gemessen',
            befund: '12 pages lack meta descriptions',
            beleg: 'crawl data',
            evidence: 'See crawl/output.csv rows 3-14',
            auswirkung: 'Lower CTR in SERPs',
            empfehlung: 'Add unique meta descriptions',
            ice: { i: 3, c: 3, e: 2, score: 18 },
            kbSources: [],
          },
        ],
      },
    ],
    positives: ['Fast page load times'],
    strategy: {
      levers: ['content', 'technical'],
      todos: ['Fix meta descriptions'],
    },
    confidence: {
      sampleSize: 50,
      minNMet: true,
      caveats: [],
    },
  };
}
