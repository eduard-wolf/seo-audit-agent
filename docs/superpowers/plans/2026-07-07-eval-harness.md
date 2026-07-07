# Eval-Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible, key-free eval harness that measures the quality of the LLM interpretation step (`skills/interpret.md` → `findings.json`) against a committed golden snapshot — Recall/Coverage, Citation-validity, Schema, No-Fabrication, Provenance, Stability (pass^k), and Faithfulness (via committed LLM-judge verdicts).

**Architecture:** Deterministic, zero-dependency Node scorers run over a **committed snapshot** (synthetic `analysis.json` fixtures + expected-findings + model-produced `findings.json` runs + judge verdicts). Model-touching steps (producing runs + judge verdicts) happen once, via Claude-Code subagents (no API key), and are committed. `npm run eval` and CI only ever run the deterministic scorers + read committed verdicts, then apply a gate (hard invariants + no-regression vs baseline + conservative floor).

**Tech Stack:** Node ≥20 ESM (`.mjs`), built-in `node:test` + `node:assert/strict`, zero npm dependencies. Reuses `lib/findings-schema.mjs` (`validateFindings`), `bin/handoff.mjs` (`extractInterpretedRuleIds`), `crawl/run.mjs` (`writeFileAtomic`), `kb/corpus/*.md` (citation allowlist).

## Global Constraints

- **Zero npm dependencies.** Pure `node:*` built-ins only. No YAML parser exists → golden expectations are **JSON** (`expected-findings.json`), not YAML.
- **No `ANTHROPIC_API_KEY`, no programmatic model calls anywhere.** `npm run eval` and CI never call a model. If any task appears to require a programmatic model call → STOP and ask before adding any key dependency.
- **ESM only:** every file `.mjs`, imports use the `node:` prefix, module opens with a `/** … */` block-comment header (filename — one-line purpose), JSDoc on every exported function.
- **Test style:** `describe()`/`it()` from `node:test`; `import assert from 'node:assert/strict'`; **every assertion carries a descriptive message string** as its last argument. Temp dirs via `fs.mkdtempSync(path.join(os.tmpdir(), 'seo-eval-'))`, cleaned in a top-level `after()`.
- **Determinism:** no `Date.now()`, no `Math.random()` in any scorer/runner/report path. All emitted lists sorted; report JSON has sorted keys. Same committed inputs → byte-identical report.
- **Reuse, don't reimplement:** `validateFindings` (`lib/findings-schema.mjs`), `extractInterpretedRuleIds` (`bin/handoff.mjs` — its CLI is import-guarded, safe to import), `writeFileAtomic` (`crawl/run.mjs`).
- **Node test runner is serial** (`node --test --test-concurrency=1`); new files under `test/eval-*.test.mjs` are auto-picked and auto-linted.
- Real anchors (verified): `examples/example-run/findings.json` = 6 sections, 27 findings, schema-valid, `minNMet=true`, `sampleSize=21`, all findings anchor rule ids via `ruleId=` in `beleg` (0 use `ruleIds[]`). The 8 KB corpus source URLs are the citation allowlist (see Task 2).

---

## File Structure

```
eval/
  lib/ruleids.mjs         # findingRuleIds, producedRuleIds, analysisRuleIds, positiveRuleIds
  lib/kb-citations.mjs    # buildCitationAllowlist, normalizeCitation, isValidCitation
  lib/fixtures.mjs        # listFixtures, loadFixture, loadRuns, loadVerdicts, parseAffectedUrls
  schema/expected-schema.mjs  # validateExpected
  schema/verdict-schema.mjs   # validateVerdicts
  scorers/recall.mjs      # scoreRecall
  scorers/citation.mjs    # scoreCitations
  scorers/schema.mjs      # scoreSchema
  scorers/fabrication.mjs # scoreFabrication
  scorers/provenance.mjs  # scoreProvenance
  scorers/stability.mjs   # scoreStability, anchorStability
  scorers/faithfulness.mjs# scoreFaithfulness
  run.mjs                 # runEval + CLI (load → score → report → gate → exit code)
  gate.json               # conservative absolute floors (committed)
  baseline.json           # committed baseline scores (Phase B)
  fixtures/<name>/analysis.json, expected-findings.json, affected-urls.csv
  runs/<name>/run-<k>/findings.json, judge.json   # committed snapshot (Phase B)
  judge/PROMPT.md, RUBRIC.md                       # versioned judge skill (Phase B)
  report/latest.json, latest.md                    # generated (committed snapshot)
  README.md                                        # methodology + how-to-run + refresh ritual
test/eval-lib.test.mjs, eval-schema.test.mjs, eval-scorers.test.mjs,
test/eval-run.test.mjs, eval-review.test.mjs
```

---

## Phase A — Deterministic scorers (key-free, TDD). Tasks 1–13.

### Task 1: `eval/lib/ruleids.mjs` — ruleId extraction

**Files:**
- Create: `eval/lib/ruleids.mjs`
- Test: `test/eval-lib.test.mjs` (create; ruleids block)

**Interfaces:**
- Consumes: `extractInterpretedRuleIds` from `../../bin/handoff.mjs`.
- Produces:
  - `findingRuleIds(finding): string[]` — one finding → sorted, deduped rule ids. If `Array.isArray(finding.ruleIds)` use those; else scrape `ruleId=` clauses from `finding.beleg` (clause body up to next `;`), collecting `namespace:id`-shaped tokens (`/[a-z][a-z0-9]*:[a-z0-9:_-]+/g`). Mirrors the handoff convention for a single finding.
  - `producedRuleIds(findings): string[]` — union of `findingRuleIds` over all `findings.sections[].findings[]`, sorted+deduped. Returns `[]` if shape invalid.
  - `analysisRuleIds(analysis): string[]` — sorted unique `analysis.findings[].ruleId`.
  - `positiveRuleIds(analysis): string[]` — sorted unique `analysis.positives[].ruleId`.

- [ ] **Step 1: Write the failing test** in `test/eval-lib.test.mjs`:

```js
/**
 * test/eval-lib.test.mjs — Unit tests for eval/lib helpers (ruleids, kb-citations, fixtures).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findingRuleIds, producedRuleIds, analysisRuleIds, positiveRuleIds } from '../eval/lib/ruleids.mjs';
import { extractInterpretedRuleIds } from '../bin/handoff.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails** — `node --test test/eval-lib.test.mjs` → FAIL (module not found / export missing).
- [ ] **Step 3: Implement** `eval/lib/ruleids.mjs` per the Interfaces block. Reuse the same clause/id regexes as `bin/handoff.mjs` (`/ruleId=([^;]*)/g`, `/[a-z][a-z0-9]*:[a-z0-9:_-]+/g`). `producedRuleIds` should produce identical output to `extractInterpretedRuleIds` for whole-findings objects (the parity test guards this).
- [ ] **Step 4: Run test to verify it passes** — `node --test test/eval-lib.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add eval/lib/ruleids.mjs test/eval-lib.test.mjs && git commit -m "feat(eval): ruleId extraction helpers with handoff parity"`

---

### Task 2: `eval/lib/kb-citations.mjs` — citation allowlist

**Files:**
- Create: `eval/lib/kb-citations.mjs`
- Test: `test/eval-lib.test.mjs` (kb-citations block)

**Interfaces:**
- Produces:
  - `buildCitationAllowlist(corpusDir?): { urls: Set<string>, basenames: Set<string> }` — default corpusDir = `new URL('../../kb/corpus/', import.meta.url)`. For each `*.md`, parse front-matter `source:` line (regex `/^source:\s*(.+)$/m` inside the leading `---`…`---` block); add its trimmed value to `urls`, add the file basename (e.g. `05-meta-tags.md`) to `basenames`.
  - `normalizeCitation(source): string` — `String(source).trim()`.
  - `isValidCitation(source, allowlist): boolean` — `true` iff normalized source is in `allowlist.urls` OR in `allowlist.basenames`.

- [ ] **Step 1: Write the failing test** (append to `test/eval-lib.test.mjs`):

```js
import { buildCitationAllowlist, isValidCitation } from '../eval/lib/kb-citations.mjs';

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
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per Interfaces (read dir with `fs.readdirSync`, filter `.md`, parse front-matter). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(eval): KB citation allowlist from corpus front-matter"`

---

### Task 3: `eval/schema/expected-schema.mjs` — validate expected-findings.json

**Files:**
- Create: `eval/schema/expected-schema.mjs`
- Test: `test/eval-schema.test.mjs` (create)

**Interfaces:**
- Produces: `validateExpected(obj): { valid: boolean, errors: string[] }` — collect-all-errors style (mirror `validateFindings`). Schema:
  - `fixture`: required string.
  - `mustContain`: required array; each item `{ ruleId: string (required), urlAnchor?: string, note?: string }`.
  - `mustNotContain`: required array; each item `{ ruleId: string (required), reason?: string }`.
  - Root must be a non-null non-array object. Unknown extra keys are ignored (forward-compatible).

- [ ] **Step 1: Write the failing test** in `test/eval-schema.test.mjs`:

```js
/**
 * test/eval-schema.test.mjs — Unit tests for eval expected-findings + judge-verdict validators.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateExpected } from '../eval/schema/expected-schema.mjs';

describe('eval/schema/expected-schema', () => {
  it('accepts a minimal valid expected-findings object', () => {
    const r = validateExpected({ fixture: 'ecommerce',
      mustContain: [{ ruleId: 'schema:product-no-aggregate', urlAnchor: '/product/' }],
      mustNotContain: [{ ruleId: 'onpage:title-missing', reason: 'all titles present' }] });
    assert.equal(r.valid, true, `expected valid, got errors: ${r.errors.join('; ')}`);
  });
  it('collects errors for missing fixture and malformed mustContain', () => {
    const r = validateExpected({ mustContain: [{ note: 'no ruleId' }], mustNotContain: [] });
    assert.equal(r.valid, false, 'missing fixture + ruleId-less entry must be invalid');
    assert.ok(r.errors.some(e => /fixture/.test(e)), 'reports missing fixture');
    assert.ok(r.errors.some(e => /ruleId/.test(e)), 'reports mustContain entry missing ruleId');
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(eval): expected-findings schema validator"`

---

### Task 4: `eval/schema/verdict-schema.mjs` — validate judge verdicts

**Files:**
- Create: `eval/schema/verdict-schema.mjs`
- Test: `test/eval-schema.test.mjs` (verdict block)

**Interfaces:**
- Produces: `validateVerdicts(obj): { valid, errors }`. Schema:
  - `fixture`: string; `run`: number; `judgeModel`: string; `promptVersion`: string.
  - `verdicts`: array; each `{ findingId: string, supported: boolean, provenanceCorrect: boolean, fabricatedNumbers: boolean, verdict: 'pass'|'fail'|'warn', rationale: string }`. All fields required; `verdict` must be one of the enum.

- [ ] **Step 1: Write the failing test** (append):

```js
import { validateVerdicts } from '../eval/schema/verdict-schema.mjs';

describe('eval/schema/verdict-schema', () => {
  const ok = { fixture: 'geo', run: 1, judgeModel: 'claude-x', promptVersion: 'judge-v1',
    verdicts: [{ findingId: 'f-1', supported: true, provenanceCorrect: true, fabricatedNumbers: false, verdict: 'pass', rationale: 'ok' }] };
  it('accepts a well-formed verdict file', () => {
    const r = validateVerdicts(ok);
    assert.equal(r.valid, true, `expected valid, got: ${r.errors.join('; ')}`);
  });
  it('rejects a bad verdict enum and non-boolean supported', () => {
    const bad = structuredClone(ok);
    bad.verdicts[0].verdict = 'maybe'; bad.verdicts[0].supported = 'yes';
    const r = validateVerdicts(bad);
    assert.equal(r.valid, false, 'bad enum + non-boolean must fail');
    assert.ok(r.errors.some(e => /verdict/.test(e)), 'reports bad verdict enum');
  });
});
```

- [ ] **Step 2–4:** Run→FAIL, implement, Run→PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(eval): judge-verdict schema validator"`

---

### Task 5: `eval/lib/fixtures.mjs` — fixture/run/verdict loaders

**Files:**
- Create: `eval/lib/fixtures.mjs`
- Test: `test/eval-lib.test.mjs` (fixtures block; uses a `mkdtempSync` scratch tree)

**Interfaces:**
- Produces:
  - `listFixtures(fixturesDir): string[]` — sorted subdirectory names.
  - `loadFixture(fixturesDir, name): { name, analysis, expected, affectedUrls }` — read `analysis.json`, `expected-findings.json`; `affected-urls.csv` optional → `affectedUrls: [{ ruleId, url }]` via `parseAffectedUrls`.
  - `parseAffectedUrls(csvText): [{ ruleId, url }]` — split lines, drop header `ruleId,url`, split each on first comma. Ignore blank lines.
  - `loadRuns(runsDir, name): [{ run: number, findings: object }]` — read `runsDir/name/run-*/findings.json`, sorted by run number.
  - `loadVerdicts(runsDir, name): [{ run: number, verdicts: object }]` — read `run-*/judge.json` where present, sorted.

- [ ] **Step 1: Write the failing test** (append; build a tiny tree in a temp dir):

```js
import path from 'node:path';
import os from 'node:os';
import { listFixtures, loadFixture, loadRuns, parseAffectedUrls } from '../eval/lib/fixtures.mjs';

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
```

- [ ] **Step 2–4:** Run→FAIL, implement, Run→PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(eval): fixture/run/verdict loaders"`

---

### Task 6: `eval/scorers/recall.mjs` — coverage recall

**Files:** Create `eval/scorers/recall.mjs`; Test `test/eval-scorers.test.mjs` (create).

**Interfaces:**
- Consumes: `producedRuleIds` (Task 1).
- Produces: `scoreRecall(findings, expected): { recall: number, total: number, covered: string[], missed: string[] }`.
  - `produced = new Set(producedRuleIds(findings))`. For each `e` in `expected.mustContain`: covered if `produced.has(e.ruleId)`. `total = mustContain.length`; `recall = total === 0 ? 1 : covered.length / total`. `covered`/`missed` = sorted rule-id lists.

- [ ] **Step 1: Write the failing test** in `test/eval-scorers.test.mjs`:

```js
/**
 * test/eval-scorers.test.mjs — Unit tests for the deterministic eval scorers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scoreRecall } from '../eval/scorers/recall.mjs';

const golden = JSON.parse(fs.readFileSync(new URL('../examples/example-run/findings.json', import.meta.url), 'utf8'));

describe('eval/scorers/recall', () => {
  it('full recall when every must-contain ruleId is covered by the golden findings', () => {
    // pick two rule ids that the golden run demonstrably covers via beleg
    const expected = { fixture: 'x', mustContain: [
      { ruleId: 'geo:missing-citations' }, { ruleId: 'crawl:orphan-page' }], mustNotContain: [] };
    const r = scoreRecall(golden, expected);
    assert.equal(r.recall, 1, `expected recall 1, missed: ${r.missed.join(',')}`);
  });
  it('partial recall reports the missed anchor', () => {
    const expected = { fixture: 'x', mustContain: [
      { ruleId: 'geo:missing-citations' }, { ruleId: 'zzz:does-not-exist' }], mustNotContain: [] };
    const r = scoreRecall(golden, expected);
    assert.equal(r.total, 2, 'two anchors expected');
    assert.equal(r.recall, 0.5, 'one of two covered');
    assert.deepEqual(r.missed, ['zzz:does-not-exist'], 'reports the uncovered anchor');
  });
});
```

> NOTE for implementer: before finalizing, confirm the two golden anchors above are actually present with `node -e "import('./eval/scorers/recall.mjs')..."` or by grepping `examples/example-run/findings.json` for `ruleId=geo:missing-citations` and `ruleId=crawl:orphan-page`. If a chosen anchor is absent, pick another rule id that the golden run covers and update the test — anchors MUST be real.

- [ ] **Step 2–4:** Run→FAIL, implement, Run→PASS. **Step 5: Commit** — `git commit -am "feat(eval): recall/coverage scorer"`

---

### Task 7: `eval/scorers/citation.mjs` — citation validity

**Files:** Create `eval/scorers/citation.mjs`; Test append to `test/eval-scorers.test.mjs`.

**Interfaces:**
- Consumes: `buildCitationAllowlist`, `isValidCitation` (Task 2).
- Produces: `scoreCitations(findings, allowlist): { total: number, valid: number, validity: number, invalid: [{ findingId, source }] }`.
  - Iterate every `sections[].findings[].kbSources[]`. `total` = count of all kbSources entries. `valid` = those passing `isValidCitation`. `validity = total === 0 ? 1 : valid / total`. `invalid` sorted by `findingId,source`.

- [ ] **Step 1: Write the failing test** (append):

```js
import { scoreCitations } from '../eval/scorers/citation.mjs';
import { buildCitationAllowlist } from '../eval/lib/kb-citations.mjs';

describe('eval/scorers/citation', () => {
  const allow = buildCitationAllowlist();
  it('golden findings cite only real corpus URLs → 100% validity', () => {
    const r = scoreCitations(golden, allow);
    assert.ok(r.total > 0, 'golden has citations');
    assert.equal(r.validity, 1, `all golden citations must be valid; invalid: ${JSON.stringify(r.invalid)}`);
  });
  it('flags a fabricated citation', () => {
    const bad = { sections: [{ findings: [{ id: 'f-x', kbSources: [{ source: 'https://example.com/nope' }] }] }] };
    const r = scoreCitations(bad, allow);
    assert.equal(r.validity, 0, 'fabricated citation is invalid');
    assert.deepEqual(r.invalid, [{ findingId: 'f-x', source: 'https://example.com/nope' }], 'reports offender');
  });
});
```

- [ ] **Step 2–4:** Run→FAIL, implement, Run→PASS. **Step 5: Commit** — `git commit -am "feat(eval): citation-validity scorer"`

---

### Task 8: `eval/scorers/schema.mjs` — schema wrapper

**Files:** Create `eval/scorers/schema.mjs`; Test append.

**Interfaces:**
- Consumes: `validateFindings` from `../../lib/findings-schema.mjs`.
- Produces: `scoreSchema(findings): { valid, errors }` — thin pass-through of `validateFindings`.

- [ ] **Step 1: Write the failing test** (append):

```js
import { scoreSchema } from '../eval/scorers/schema.mjs';
describe('eval/scorers/schema', () => {
  it('golden findings are schema-valid', () => {
    assert.equal(scoreSchema(golden).valid, true, 'golden must validate');
  });
  it('an empty object is schema-invalid with errors', () => {
    const r = scoreSchema({});
    assert.equal(r.valid, false, 'empty object invalid'); assert.ok(r.errors.length > 0, 'has errors');
  });
});
```

- [ ] **Step 2–4:** Run→FAIL, implement, Run→PASS. **Step 5: Commit** — `git commit -am "feat(eval): schema scorer (validateFindings wrapper)"`

---

### Task 9: `eval/scorers/fabrication.mjs` — structural no-fabrication / precision

**Files:** Create `eval/scorers/fabrication.mjs`; Test append.

**Interfaces:**
- Consumes: `findingRuleIds`, `analysisRuleIds`, `positiveRuleIds` (Task 1).
- Produces: `scoreFabrication(findings, expected, analysis): { fabrications: number, items: [{ findingId, ruleId, kind }] }`.
  - For each finding, for each of its `findingRuleIds`:
    - `kind='not-in-analysis'` if ruleId ∉ `analysisRuleIds(analysis)`.
    - `kind='on-positive'` if ruleId ∈ `positiveRuleIds(analysis)`.
    - `kind='must-not-contain'` if ruleId ∈ the set of `expected.mustNotContain[].ruleId`.
  - `fabrications = items.length`. `items` sorted by `findingId,ruleId,kind`. A ruleId can trip multiple kinds → one item per (finding, ruleId, kind).

- [ ] **Step 1: Write the failing test** (append):

```js
import { scoreFabrication } from '../eval/scorers/fabrication.mjs';
describe('eval/scorers/fabrication', () => {
  const analysis = { findings: [{ ruleId: 'a:real' }], positives: [{ ruleId: 'p:passed' }] };
  const expected = { fixture: 'x', mustContain: [], mustNotContain: [{ ruleId: 'trap:x' }] };
  it('zero fabrications when findings reference only real analysis rule ids', () => {
    const f = { sections: [{ findings: [{ id: 'f1', beleg: 'analysis.json ruleId=a:real' }] }] };
    assert.equal(scoreFabrication(f, expected, analysis).fabrications, 0, 'a:real is in analysis');
  });
  it('flags invented ruleId, positive-claim, and must-not-contain trap', () => {
    const f = { sections: [{ findings: [
      { id: 'f2', beleg: 'x ruleId=ghost:invented' },
      { id: 'f3', beleg: 'x ruleId=p:passed' },
      { id: 'f4', beleg: 'x ruleId=trap:x' }] }] };
    const r = scoreFabrication(f, expected, analysis);
    assert.equal(r.fabrications, 3, 'three distinct fabrication/precision violations');
    assert.ok(r.items.some(i => i.kind === 'not-in-analysis' && i.ruleId === 'ghost:invented'), 'invented flagged');
    assert.ok(r.items.some(i => i.kind === 'on-positive' && i.ruleId === 'p:passed'), 'positive-claim flagged');
    assert.ok(r.items.some(i => i.kind === 'must-not-contain' && i.ruleId === 'trap:x'), 'trap flagged');
  });
});
```

- [ ] **Step 2–4:** Run→FAIL, implement, Run→PASS. **Step 5: Commit** — `git commit -am "feat(eval): structural no-fabrication/precision scorer"`

---

### Task 10: `eval/scorers/provenance.mjs` — provenance/anti-overclaim invariants

**Files:** Create `eval/scorers/provenance.mjs`; Test append.

**Interfaces:**
- Produces: `scoreProvenance(findings): { checks: object, issues: string[] }` with boolean checks:
  - `provEnumOk` — every finding `prov` ∈ {gemessen, beobachtet, geschätzt}.
  - `severityEnumOk` — every finding `severity` ∈ {hoch, mittel, niedrig}.
  - `iceScoreConsistent` — every finding `ice.score === ice.i*ice.c*ice.e`.
  - `minNMetConsistent` — `confidence.minNMet === (confidence.sampleSize >= 5)`.
  - `sampleSizeMatch` — `meta.sampleSize === confidence.sampleSize`.
  - `cCapOk` — if `confidence.minNMet === false`, every finding `ice.c <= 1`; else true.
  - `issues` — human-readable messages for any false check. All checks true ⇒ `issues: []`.

- [ ] **Step 1: Write the failing test** (append):

```js
import { scoreProvenance } from '../eval/scorers/provenance.mjs';
describe('eval/scorers/provenance', () => {
  it('golden findings satisfy all provenance/anti-overclaim invariants', () => {
    const r = scoreProvenance(golden);
    assert.deepEqual(r.issues, [], `golden must be clean; issues: ${r.issues.join('; ')}`);
  });
  it('detects a c-cap violation under a sub-minimum sample', () => {
    const bad = { meta: { sampleSize: 3 }, confidence: { sampleSize: 3, minNMet: false },
      sections: [{ findings: [{ prov: 'gemessen', severity: 'hoch', ice: { i: 3, c: 2, e: 1, score: 6 } }] }] };
    const r = scoreProvenance(bad);
    assert.equal(r.checks.cCapOk, false, 'c=2 with minNMet=false violates the cap');
  });
});
```

- [ ] **Step 2–4:** Run→FAIL, implement, Run→PASS. **Step 5: Commit** — `git commit -am "feat(eval): provenance/anti-overclaim invariant scorer"`

---

### Task 11: `eval/scorers/stability.mjs` — pass^k stability

**Files:** Create `eval/scorers/stability.mjs`; Test append.

**Interfaces:**
- Produces:
  - `scoreStability(perRunRecall: number[]): { k: number, passK: number|null, recallMin: number|null, recallMean: number|null, recallMax: number|null }` — `passK` = fraction of runs with `recall === 1`; means computed exactly; `k===0` → all null.
  - `anchorStability(runsCovered: string[][], mustContainIds: string[]): [{ ruleId, coveredFraction }]` — for each anchor, fraction of runs whose covered-list includes it; sorted by ruleId.

- [ ] **Step 1: Write the failing test** (append):

```js
import { scoreStability, anchorStability } from '../eval/scorers/stability.mjs';
describe('eval/scorers/stability', () => {
  it('pass^k = fraction of runs with recall 1', () => {
    const r = scoreStability([1, 1, 0.5, 1]);
    assert.equal(r.k, 4, 'k = number of runs');
    assert.equal(r.passK, 0.75, 'three of four runs fully recalled');
    assert.equal(r.recallMin, 0.5, 'min recall');
  });
  it('anchorStability reports per-anchor coverage fraction', () => {
    const r = anchorStability([['a:1', 'b:2'], ['a:1']], ['a:1', 'b:2']);
    assert.deepEqual(r, [{ ruleId: 'a:1', coveredFraction: 1 }, { ruleId: 'b:2', coveredFraction: 0.5 }],
      'a:1 in both runs, b:2 in one');
  });
});
```

- [ ] **Step 2–4:** Run→FAIL, implement, Run→PASS. **Step 5: Commit** — `git commit -am "feat(eval): pass^k stability scorer"`

---

### Task 12: `eval/scorers/faithfulness.mjs` — judge-verdict reader

**Files:** Create `eval/scorers/faithfulness.mjs`; Test append.

**Interfaces:**
- Produces: `scoreFaithfulness(runVerdicts: object[]): { total, supported, passRate, unsupported, fabricatedNumbers, provenanceIssues }`.
  - `runVerdicts` = array of verdict objects (each `{ verdicts: [...] }`). Flatten all `verdicts[]`. `total` = count; `supported` = count with `supported===true`; `passRate = total===0 ? null : supported/total`; `unsupported` = count `supported===false`; `fabricatedNumbers` = count `fabricatedNumbers===true`; `provenanceIssues` = count `provenanceCorrect===false`.
  - Reads only committed data; **no model call**.

- [ ] **Step 1: Write the failing test** (append):

```js
import { scoreFaithfulness } from '../eval/scorers/faithfulness.mjs';
describe('eval/scorers/faithfulness', () => {
  it('aggregates committed judge verdicts across runs', () => {
    const runs = [
      { verdicts: [{ findingId: 'a', supported: true, provenanceCorrect: true, fabricatedNumbers: false, verdict: 'pass', rationale: '' },
                   { findingId: 'b', supported: false, provenanceCorrect: true, fabricatedNumbers: true, verdict: 'fail', rationale: '' }] },
      { verdicts: [{ findingId: 'a', supported: true, provenanceCorrect: false, fabricatedNumbers: false, verdict: 'warn', rationale: '' }] },
    ];
    const r = scoreFaithfulness(runs);
    assert.equal(r.total, 3, 'three verdicts total');
    assert.equal(r.supported, 2, 'two supported');
    assert.equal(r.fabricatedNumbers, 1, 'one invented-number');
    assert.equal(r.provenanceIssues, 1, 'one provenance issue');
  });
});
```

- [ ] **Step 2–4:** Run→FAIL, implement, Run→PASS. **Step 5: Commit** — `git commit -am "feat(eval): faithfulness scorer (judge-verdict reader)"`

---

### Task 13: `eval/run.mjs` + `eval/gate.json` + `npm run eval` — orchestrator, report, gate

**Files:**
- Create: `eval/run.mjs`, `eval/gate.json`
- Modify: `package.json` (add `"eval": "node eval/run.mjs"` to scripts)
- Test: `test/eval-run.test.mjs` (create)

**Interfaces:**
- Consumes: all scorers + loaders above; `writeFileAtomic` from `../crawl/run.mjs`.
- Produces:
  - `runEval({ fixturesDir, runsDir, gate, baseline }): { report, gateResult }` — pure function (no fs writes, no exit). `gate`/`baseline` are already-parsed objects (caller reads files). For each fixture: load fixture + runs + verdicts; per run compute schema/recall/citation/fabrication/provenance; compute stability across runs; faithfulness across verdicts. Build a deterministic `report` object (sorted fixture order, sorted keys). Compute `gateResult`:
    - **Hard invariants** (must all hold): every run schema-valid; total fabrications across all fixtures/runs === 0; overall citation validity === 1.
    - **Soft, per aggregate metric** (`recall` = mean of per-fixture mean recall; `faithfulness` = overall passRate; `stability` = mean per-fixture passK): fail if `current < floor` (from `gate` floors) OR `current < baselineValue` (no-regression, tolerance 1e-9).
    - `gateResult = { passed: boolean, hardFailures: string[], softFailures: string[] }`.
  - `buildReportMarkdown(report, gateResult): string` — deterministic human-readable report.
  - CLI (guarded `if (import.meta.url === 'file://'+process.argv[1])`): resolve default dirs (`eval/fixtures`, `eval/runs`), read `eval/gate.json` + `eval/baseline.json` (baseline optional → no-regression skipped if absent), call `runEval`, write `eval/report/latest.json` (via `writeFileAtomic`, `JSON.stringify(report, null, 2)` with a stable key order) + `eval/report/latest.md`, print a summary, `process.exit(gateResult.passed ? 0 : 1)`.
- `eval/gate.json` initial conservative floors: `{ "floors": { "recall": 0.5, "faithfulness": 0.6, "stability": 0.4 }, "note": "Conservative absolute safety-net floors, deliberately well below baseline; primary signal is no-regression vs baseline.json." }`

- [ ] **Step 1: Write the failing test** in `test/eval-run.test.mjs` — build a 2-fixture scratch tree (one clean, one with an injected fabrication), assert gate behavior + report determinism:

```js
/**
 * test/eval-run.test.mjs — Integration test for the eval runner + gate + report determinism.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runEval, buildReportMarkdown } from '../eval/run.mjs';

const tmps = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-eval-')); tmps.push(d); return d; }
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

// Minimal schema-valid findings factory (fill required fields) — implementer completes to satisfy validateFindings.
function validFindings(ruleId) { /* returns a schema-valid findings.json object whose single finding's beleg = `analysis.json ruleId=${ruleId}` */ }

describe('eval/run', () => {
  it('passes the gate on a clean committed snapshot and fails when a fabrication is injected', () => {
    // Implementer: write fixtures/runs into a scratch tree, call runEval twice (clean vs fabricated run),
    // assert gateResult.passed === true for clean and false (hardFailures mentions fabrication) for fabricated.
  });
  it('produces a byte-identical report on repeated runs (determinism)', () => {
    // call runEval twice on the same tree; JSON.stringify(reportA) === JSON.stringify(reportB)
  });
});
```

> Implementer note: complete `validFindings` to emit a full schema-valid object (meta/execSummary/sections/positives/strategy/confidence per `lib/findings-schema.mjs`) so `scoreSchema` passes for the clean case; use `examples/example-run/findings.json` as the field template. Keep the fabricated case's finding referencing a ruleId absent from that fixture's analysis. Assertions MUST carry messages.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `eval/run.mjs` + `eval/gate.json` + package.json script. **Step 4: Run** `node --test test/eval-run.test.mjs` → PASS. Also run `node eval/run.mjs` against an empty `eval/fixtures` and confirm it exits cleanly (no fixtures → empty report, gate passes vacuously) — document that Phase B fills it.
- [ ] **Step 5: Commit** — `git add eval/run.mjs eval/gate.json package.json test/eval-run.test.mjs && git commit -m "feat(eval): runner, deterministic report, and gate (hard invariants + no-regression + floor)"`

---

## Phase B — Golden dataset (model-touching, via Claude-Code subagents; committed snapshot). Tasks 14–17.

> These tasks are orchestrated by the top-level Claude-Code session (this session), NOT by ordinary code subagents doing TDD. They produce committed data. **No API key.** Model-touching work runs as isolated Claude-Code subagents. The generated `findings.json`/`judge.json` are committed as the reproducible snapshot.

### Task 14: Author the 5 synthetic fixtures + wire example-run as the 6th

**Files:** Create `eval/fixtures/{ecommerce,editorial,broken,geo,clean}/analysis.json` + `expected-findings.json`; create `eval/fixtures/example-run/` referencing the real committed `examples/example-run/analysis.json` (copy the file in; add an authored `expected-findings.json` from `examples/fixture-site/EXPECTED.md`).

- [ ] Author each `analysis.json` **deterministically** (no model), in the documented shape (top-level `meta, rulesetVersion, findings, positives, signals`). Constraints per fixture: valid `ruleId`s drawn from `config/rules/*.json`; `meta.minNMet === (sampleSize >= 5)`; site-level sentinels `count===1 && affectedUrls===[]`; the `clean` fixture uses `sampleSize < 5` to exercise the `minNMet=false` / c≤1 path.
- [ ] Author each `expected-findings.json`: `mustContain` = the core rule ids the interpret step should cover (anchored to that fixture's `analysis.findings[].ruleId`); `mustNotContain` = traps (rule ids in `positives`, or plausible-but-absent issues). Validate every file: `node -e "import('./eval/schema/expected-schema.mjs').then(m=>{const fs=require('node:fs');/* validateExpected each */})"` — all valid.
- [ ] Sanity-check each authored `analysis.json` is internally consistent (a tiny checker script or manual `node` one-liner asserting `minNMet === sampleSize>=5` and all ruleIds exist in `config/rules`). Commit — `git commit -m "test(eval): synthetic golden fixtures (6 archetypes) + expected-findings"`.

### Task 15: Generate k=5 interpret runs per fixture (isolated subagents)

- [ ] For each fixture, dispatch **5 independent** Claude-Code subagents (fresh context each). Each subagent is given ONLY `skills/interpret.md` + that fixture's `analysis.json` (and the repo's `kb/retrieve.mjs` for grounding) and told to produce a schema-valid `findings.json` exactly as in production — **it must NOT see `expected-findings.json` or any other run.** Record the actual model id used into each `findings.meta.modelId` (look up exact id from Anthropic docs via the `claude-api` skill; do not recall from memory).
- [ ] Write each result to `eval/runs/<fixture>/run-<k>/findings.json`; validate each with `validateFindings` before committing. Any invalid run is regenerated, not hand-patched.
- [ ] Commit — `git commit -m "test(eval): committed interpret-step baseline runs (k=5 per fixture)"`.

### Task 16: Author judge skill + generate cross-model judge verdicts

**Files:** Create `eval/judge/PROMPT.md` (versioned, `promptVersion: judge-v1`), `eval/judge/RUBRIC.md`.

- [ ] Write the versioned judge prompt + rubric: input = a fixture's `analysis.json` + one run's `findings.json` (NOT expected-findings); output = the verdict schema from Task 4 (`{ findingId, supported, provenanceCorrect, fabricatedNumbers, verdict, rationale }`). The rubric defines "supported" = every claim/number traces to `analysis.json`; "provenanceCorrect" = `prov` tag matches the evidence basis; "fabricatedNumbers" = any metric not present in `analysis.json`.
- [ ] For each committed run, dispatch a Claude-Code subagent running a **different** Claude model than the interpret runs (cross-model, key-free) applying `eval/judge/PROMPT.md`. Write `eval/runs/<fixture>/run-<k>/judge.json`; validate each with `validateVerdicts` before committing.
- [ ] Commit — `git commit -m "test(eval): versioned judge prompt + committed cross-model faithfulness verdicts"`.

### Task 17: Compute + commit baseline, run the harness green

- [ ] Run `node eval/run.mjs` (no baseline yet → no-regression skipped, floors apply). Confirm it produces `eval/report/latest.{json,md}` with real numbers and passes the hard invariants + floors.
- [ ] Snapshot the aggregate + per-fixture scores into `eval/baseline.json` (add `generatedWith: { interpretModel, judgeModel, promptVersion, k }`). Re-run `node eval/run.mjs` → now also enforces no-regression → still green.
- [ ] Commit — `git add eval/baseline.json eval/report && git commit -m "test(eval): commit baseline scores + report snapshot"`.

---

## Phase C — CI, docs, meta-test. Tasks 18–20.

### Task 18: Wire the eval gate into CI

**Files:** Modify `.github/workflows/ci.yml`.

- [ ] Add, in the existing `test-and-scan` job after the `Run tests` step (no secret, no key):
```yaml
      - name: Evals (deterministic, key-free)
        run: npm run eval
```
- [ ] Verify locally `npm run eval` exits 0 on the committed snapshot. Commit — `git commit -am "ci(eval): gate on deterministic evals over committed snapshot"`.

### Task 19: Docs — `eval/README.md` + README "Evals" section

**Files:** Create `eval/README.md`; Modify `README.md`.

- [ ] `eval/README.md`: methodology (what each metric means + its **limits** — "measures against curated expectations + grounding, not 'the truth'"); the JSON-not-YAML rationale; the cross-model-within-Claude honesty note; the **manual refresh ritual** (regenerate runs+verdicts via Claude-Code subagents when prompt/model changes, then recompute baseline).
- [ ] `README.md`: add a German **"Evals"** section (honesty-forward, methodology + "so fährst du sie: `npm run eval`"), placed after `## Voraussetzungen (ehrlich)` / `## Schnellstart`. Do NOT remove existing enforced tokens ("Claude Code", "Screaming Frog", "claude-seo") that `test/example-run.test.mjs` checks.
- [ ] Commit — `git commit -am "docs(eval): eval methodology README + honest Evals section"`.

### Task 20: Meta-test guarding the eval docs/claims

**Files:** Create `test/eval-review.test.mjs`.

- [ ] Mirror the repo's `*-review.test.mjs` pattern: assert `eval/README.md` documents the key honesty caveats (contains "kuratierte Erwartungen"/"nicht 'die Wahrheit'", the no-API-key statement, the refresh ritual); assert `README.md` has an "Evals" section; assert `eval/baseline.json` records `generatedWith` provenance; assert `eval/gate.json` floors are below the committed baseline aggregates (floor really is a safety net, not the real bar).
- [ ] Run `node --test test/eval-review.test.mjs` → PASS. Commit — `git commit -am "test(eval): meta-review guarding eval docs + gate honesty"`.

---

## Final verification (run after all tasks)

1. `npm test` → all existing (1096) + new `eval-*` tests green (serial).
2. `npm run lint` → `node --check` clean on new `eval/*.mjs`.
3. `npm run eval` → exit 0, produces `eval/report/latest.{json,md}` with real numbers.
4. Regression proof: temporarily corrupt one committed run (inject a `ruleId` absent from that fixture's analysis) → `npm run eval` exits non-zero, `hardFailures` names the fabrication; `git checkout` to restore.
5. Determinism: `npm run eval` twice → `eval/report/latest.json` byte-identical.
6. `npm run leak-scan` → clean (no keys anywhere).

## Self-review notes (author)

- Spec coverage: Recall (T6), Grounding/Faithfulness (T12 reads judge; T16 generates), Precision/No-Fabrication (T9), Citation validity (T7), ICE/Provenance plausibility (T10), Stability pass^k (T11); golden set (T14), runner+report+`npm run eval` (T13), baseline+CI gate (T17/T18), README Evals (T19), honesty guardrails (T19/T20). All brief §2/§3/§6 items mapped.
- No placeholders in Phase A code steps except the two clearly-marked implementer completions in T13's integration test (a schema-valid findings factory + the scratch-tree wiring) — these are integration harness scaffolding, not product logic, and are fully specified in prose + the field template pointer.
- Type consistency: scorer signatures referenced in T13 match their defining tasks (`scoreRecall(findings, expected)`, `scoreCitations(findings, allowlist)`, `scoreFabrication(findings, expected, analysis)`, `scoreStability(perRunRecall[])`, `scoreFaithfulness(runVerdicts[])`).
