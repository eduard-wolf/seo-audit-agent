# CLAUDE.md — orchestration brain for the SEO/GEO audit agent

This repo is a **deterministic-bookend, single-interpretation** SEO/GEO audit
tool. The principle: **collect and check deterministically → interpret in ONE
LLM step (RAG-grounded) → render statically.** The crawler and rule engine
produce reproducible artifacts with zero model involvement; a single agentic
step turns those artifacts into a senior audit + strategy, grounded in the
knowledge base; a static renderer turns the result into a report. Keeping
interpretation to one well-bounded, grounded step is what makes the output
trustworthy and the model's role auditable.

---

## Model requirement

Use a **capable, current model in thinking mode** — reason before asserting, to
guard against hallucination. For anything Claude/Anthropic-specific (model ids,
limits, API parameters, pricing, caching), treat the **official Anthropic
documentation as the source of truth**. Do **not** recall such values from
memory; look them up.

---

## Legal / discretion

Audit **only your own sites or sites you are explicitly authorised to audit.**
The crawler hits real servers. Read and honour `DISCLAIMER.md` (authorised use,
DSGVO/GDPR data minimisation, `data/` is transient and git-ignored). When in
doubt about authorisation, stop and ask.

---

## Artifact-path convention (the pipeline on disk)

Every step reads the previous artifact and writes the next. All live under
`data/<host>/` (git-ignored, transient):

```
data/<host>/crawl.csv  →  signals.json  →  analysis.json  →  findings.json  →  strategy.md  →  report/<host>/index.html
        crawl (det.)        crawl (det.)     analyze (det.)    interpret (LLM)   strategy (LLM)     render (det.)
   └ affected-urls.csv (det. sidecar of analysis.json)   +   runtime-signals.json (optional, non-det. overlay via bin/enrich.mjs)
```

- `crawl.csv` + `signals.json` — written by `runCrawl(origin, opts)` in
  `crawl/run.mjs`.
- `analysis.json` + `affected-urls.csv` — `analyzeFromFiles(csvPath, signalsPath)`
  in `analyze/analyze.mjs`, persisted by `bin/crawl-and-analyze.mjs`. The
  `affected-urls.csv` sidecar (`ruleId,url`) holds the **complete** remediation
  list; `findings.json` keeps only a 10-URL sample per rule (bounded LLM input),
  so the sidecar is the human/report source for the full list.
- `runtime-signals.json` *(optional overlay)* — written by `bin/enrich.mjs
  data/<host>`: a **non-deterministic, key-gated** overlay (CrUX field data, TLS
  certificate, Google Safe-Browsing). It never mutates `crawl.csv`/`analysis.json`;
  without API keys it writes `{available:false}`. Runtime rules **skip** when it
  is absent rather than vacuously passing.
- `findings.json` — produced by the agent via `skills/interpret.md`; its shape is
  enforced by `validateFindings` in `lib/findings-schema.mjs`.
- `strategy.md` — produced by the agent via `skills/strategy.md`.
- `report/<host>/index.html` — rendered by `report/build-report.mjs`
  (the final pipeline step).

---

## Run: "Audit for `<URL>`"

1. **Deterministic bookend (no model):**
   ```bash
   node bin/crawl-and-analyze.mjs <url>
   ```
   Runs `runCrawl` → `analyzeFromFiles`, writes `data/<host>/analysis.json`, and
   prints its path. Optional flags: `--profile <quick-scan|standard|full-audit>`
   (default `standard`), `--max <n>` (page cap, overrides profile),
   `--rps <n>` (politeness throttle, overrides profile), `--resume` (continue an
   interrupted crawl from `crawl-state.json`). Optionally follow with
   `node bin/enrich.mjs data/<host>` for the runtime-signals overlay.

2. **Interpret (the ONE LLM step) — apply `skills/interpret.md`:**
   Read `data/<host>/analysis.json`; for each finding, retrieve grounding context
   via `kb/retrieve.mjs` (`retrieve(query, k)`) and **cite it in `kbSources`**;
   emit a schema-valid `data/<host>/findings.json` (ICE anchors, provenance,
   evidence-before-assertion). End by running `validateFindings` from
   `lib/findings-schema.mjs` and fixing any errors.

3. **Strategy (optional) — apply `skills/strategy.md`:**
   The agent designs its own research questions, grounds answers in the KB,
   asks the conditional company-context question only if genuinely required, and
   writes `data/<host>/strategy.md` + the `strategy` field of `findings.json`.

> **When to `/rotate`:** use the `/rotate` command (or call `skills/context-handoff.md`
> explicitly) after step 1 once `analysis.json` is written, after every ~10
> findings during step 2, or before starting step 3. The handoff packet is
> regenerated deterministically from the artifact files — see
> `skills/context-handoff.md` for the full rotation protocol.

4. **Render (no model):**
   ```bash
   node report/build-report.mjs data/<host>/findings.json
   ```
   Renders `findings.json` → `report/<host>/index.html`.

---

## Context rotation

Long audits exceed one context window. Rotate context **deterministically from
the written artifacts**, never from memory — see `skills/context-handoff.md`.
Triggers are step/heuristic based (after the crawl/analyze bookend, after every
N findings, before strategy) or the human `/rotate` command — **not** token
counting. Because the handoff packet is regenerated from `data/<host>/*.json`,
resuming in a fresh session is lossless.

---

## Skills index

- `skills/interpret.md` — the core step: `analysis.json` → schema-valid
  `findings.json`, KB-grounded, ICE-scored, provenance-tagged.
- `skills/strategy.md` — findings → grounded, sequenced strategy.
- `skills/context-handoff.md` — lossless context rotation from artifacts.

## Quality anchors (apply throughout)
- **Evidence before assertion** — never write a finding without a value/URL in
  the artifacts.
- **ICE with anchors** — score `i`/`c`/`e` ∈ {1,2,3} against the rubric;
  `score = i × c × e`. No invented numbers.
- **Provenance** — every claim is `gemessen` / `beobachtet` / `geschätzt`.
- **RAG grounding** — recommendations cite real `kbSources`; no fabricated cites.
- **Anti-overclaim** — small samples (`minNMet = false`) get caveats, not quotas;
  no promised metrics.
