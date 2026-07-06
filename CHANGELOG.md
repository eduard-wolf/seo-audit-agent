# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
this project uses static, manually-set dates (no wall-clock at build time).

> **Note on git history.** This public repository was published as a curated,
> squashed commit; the granular development history (conventional commits across
> several review rounds) was kept in private working branches. The ruleset
> progression below is the authoritative record of *what* changed and *when*.

## Ruleset progression (`config/rules-version.json`)

The rule catalogue is versioned independently of the package release. From the
initial catalogue that shipped inside the 0.1.0 release it has grown to the
current ruleset 1.7.0 (static, manually-set dates; newest first):

### Ruleset [1.7.0] — 2026-07 — review-2026-07 SEO-depth additions → **96 checks / 10 categories**

- **@context validation** — `schema:context-invalid` (parseable JSON-LD whose
  top-level object lacks a `schema.org` `@context` → silently rich-result-ineligible).
  Derived from a new parse-time `ldContextOk` signal.
- **html lang ↔ hreflang** — `i18n:html-lang-hreflang-mismatch` (the self-referential
  hreflang language disagrees with `<html lang>`; a localization/data-quality defect).
- **Image-index opt-out** — `geo:noimageindex` (robots-meta `noimageindex`, an image
  visibility opt-out). All three are eligibility/trust/data-quality signals, NOT ranking.
- **Detector refinements** — `tech:canonical-missing` now gates on indexable 2xx content
  (no false positive on 410 / js-guard pages); `tech:canonical-target-broken` no longer
  double-reports a self-referential noindex canonical (owned by `tech:noindex-canonical-conflict`).

### Ruleset [1.6.0] — 2026-06 — review-2026-06 hardening → **93 checks / 10 categories**

- **robots.txt substance** — `tech:robots-site-blocked`,
  `tech:robots-noindex-directive`, `tech:robots-no-sitemap`,
  `tech:robots-blocked-resources` (directive quality, not just presence).
- **URL hygiene** — `hygiene:url-inconsistency` (host/trailing-slash/case drift).
- **Security-header family** — `tech:hsts-missing`, `tech:frame-protection-missing`,
  `tech:nosniff-missing`, `tech:referrer-policy-missing`,
  `tech:permissions-policy-missing`, `tech:csp-missing`, `tech:cookie-insecure`,
  `tech:version-disclosure`.
- **Microdata / RDFa** — `schema:microdata-only` (structured data present only in
  legacy microdata, no JSON-LD).
- **Link-graph target integrity** — `tech:canonical-target-broken`,
  `i18n:hreflang-target-broken`, `links:internal-broken` (references that point
  at non-200 targets).

### Ruleset [1.5.0] — 2026-06 — Welle-6 runtime wave (77 rules)

- **Optional runtime enrichment** — `bin/enrich.mjs` → `runtime-signals.json`, a
  key-gated, non-deterministic overlay (CrUX field data, TLS-certificate probe,
  Google Safe-Browsing) that never touches `crawl.csv`/`analysis.json`.
- **Consuming rules** — `perf:cwv-field-fail`, `tech:tls-cert-expiring`,
  `tech:safe-browsing-flagged`, `tech:http-not-redirected`; these **skip**
  (rather than vacuously pass) when the run is un-enriched.
- **Further checks** — hreflang reciprocity (`i18n:hreflang-not-reciprocal`),
  `trust:contact-pages-missing`, 2026 AI-bot inventory / on-demand fetcher
  (`geo:ai-user-fetcher-blocked`), `geo:poor-chunkability`.

### Ruleset [1.4.0] — 2026-06 — Welle-5 full-audit architecture

- Named crawl profiles (`quick-scan` / `standard` / `full-audit`) + `--profile`,
  streaming crawl (bounded memory), checkpoint/resume (`--resume`, byte-identical)
  with a loud resume guard, the `affected-urls.csv` remediation sidecar, and
  deterministic bounded concurrency.

### Ruleset [1.3.0] — 2026-06 — Welle-4 coverage expansion

- Additional structured-data, GEO and on-page checks (U4.1–U4.7).

### Ruleset [1.2.0] — 2026-06 — Welle-2 on-page + i18n expansion

- On-page rules `onpage:html-lang-missing`, `onpage:meta-desc-length`,
  `onpage:title-short`, `links:dead-end`; hreflang script-subtag validation;
  offer/article detail-honesty fixes.

## [0.1.0] — 2026-06

First coherent end-to-end release: the full **deterministic-bookend,
single-interpretation** pipeline (crawl → analyze → interpret → render) plus a
committed proof-of-generation example run.

### Added

- **Crawler (Layer 1)** — dependency-free Node crawler (`crawl/`, `bin/crawl-and-analyze.mjs`):
  polite fetch with rate-limiting (`--rps`) and page cap (`--max`), `robots.txt`
  Disallow enforcement, redirect-chain handling, HTML parsing, link-graph
  (orphans + click-depth), and signal extraction (`robots`, `llms.txt`, AI-bot
  directives). Emits `crawl.csv` + `signals.json`.
- **Rule analyzer (Layer 2)** — `analyze/` + `config/rules/`: a deterministic
  rule engine spanning on-page, technical/index, structured-data, GEO,
  performance, internal-linking, a11y, i18n, trust and hygiene categories
  (**96 checks across 10 categories** as of ruleset 1.7.0 — see the ruleset
  progression below). Emits `analysis.json` (rule hits + positives + site meta).
- **Knowledge base / RAG (Layer 4)** — `kb/`: 8 curated corpus documents,
  chunking, embedding (local deterministic fallback; optional pgvector store and
  GSC enrichment via Python), and `retrieve(query, k)` semantic retrieval that
  grounds recommendations.
- **Skills (Layer 3)** — `skills/interpret.md` (analysis → schema-valid findings,
  ICE-scored, provenance-tagged, KB-cited), `skills/strategy.md` (findings →
  sequenced strategy), `skills/context-handoff.md` (lossless context rotation
  from artifacts).
- **Findings contract** — `lib/findings-schema.mjs#validateFindings`: the
  enforced schema between the LLM output and the renderer (severity/provenance
  vocab, ICE anchors `i|c|e ∈ {1,2,3}`, `score = i×c×e`, `kbSources` as objects).
- **HTML report renderer (Layer 5)** — `report/build-report.mjs`: deterministic,
  self-contained, CSP-pure output — inline CSS only, no scripts, every untrusted
  string HTML-escaped, `<meta robots=noindex>`, footer stamp (model, ruleset,
  crawl timestamp).
- **Example run** — `examples/example-run/`: a frozen, real chain on the synthetic
  fixture (crawl.csv → analysis.json → findings.json → index.html) as
  proof-of-generation.
- **Test suite** — `node --test` across crawl, parse, link-graph, analyzer, KB,
  schema, renderer, skills, leak-scan and the example run. No npm dependencies.
- **Docs & governance** — `README.md` (credibility surface), `CLAUDE.md`
  (orchestration runbook), `DISCLAIMER.md` (authorised use, DSGVO data
  minimisation), `LICENSE` (all rights reserved).

### Notes

- **No npm dependencies** in the Node pipeline; Python is optional (pgvector /
  GSC enrichment only).
- `data/` is **transient and git-ignored**; crawl output is never committed.
- Ruleset version is tracked separately in `config/rules-version.json`
  (currently `1.7.0`; the rule catalogue is versioned independently of the
  package release — see the ruleset progression below).
