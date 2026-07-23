# Skill: strategy — from findings to a grounded, prioritised SEO/GEO strategy

Run this **after** `skills/interpret.md` has produced a valid
`data/<host>/findings.json`. Your job is to lift the individual findings into a
coherent strategy: what to do, in what order, and why — grounded in research and
the knowledge base, with the same provenance discipline as the audit.

Output:
- `data/<host>/strategy.md` — the human-readable strategy memo.
- The `strategy` field in `findings.json` (`{ levers[], todos[] }`) — updated to
  match the memo, then re-validated with `validateFindings`.

> Use a capable, current model in **thinking mode**. For any Claude/Anthropic
> specifics, use the official Anthropic docs as the source of truth — do not
> recall values from memory.

---

## 1. Meta-prompting — you design the research questions

We do **not** hand you a fixed question list. A senior strategist's value is
asking the *right* questions. So:

1. Read `data/<host>/findings.json` (and `analysis.json` for context). Identify
   the 3–6 themes that actually move the needle — driven by ICE scores,
   `severity`, and `pctOfPages`, not by what is easiest to write about.
2. For each theme, **draft your own** high-quality research questions. Good
   questions are specific, decision-oriented, and falsifiable, e.g.:
   - "For a `siteType = <…>` site, does consolidating near-duplicate category
     pages via canonical typically recover ranking signal, and what are the
     failure modes?"
   - "What is current best practice for `aggregateRating` eligibility, and which
     properties does the KB say are required vs. recommended?"
   - "For GEO: which on-page signals most influence whether AI answer engines
     cite a source, per the KB?"
3. Critique your own questions before researching: are they answerable with
   evidence? Do they avoid leading assumptions? Revise.

We supply only the **structure and the guardrails** below — not the answers.

---

## 2. Research, grounded — KB first, web second

For each question:

1. **Ground in the KB first.** Call `retrieve(query, k)` from `kb/retrieve.mjs`
   and read the chunks. The KB is the authoritative, dated corpus for this tool.
   Note: the default embedder (`kb/embed.mjs`) is a deterministic, fixture-grade
   **lexical** hash-trick fallback, not semantic — for a real run pass real
   embeddings (`opts.provider` to `embed`, or a real `embedFn` + pgvector `store`
   to `retrieve`) and treat a sub-threshold `score` as a no-hit.
2. If the KB is thin on a question and the site context genuinely needs current
   external facts, run **deep research** (web) — but treat external claims as
   `geschätzt`/`beobachtet` unless corroborated, and prefer primary/official
   sources. Never let web findings contradict the KB silently; if they diverge,
   say so and explain which you trust and why.
3. Record provenance for every strategic claim, same vocabulary as the audit:
   `gemessen` (from our artifacts) / `beobachtet` (read from sources) /
   `geschätzt` (inferred/projected). **No invented numbers, no hype, no promised
   metrics.** Effects are described as mechanisms with calibrated confidence.

---

## 3. Conditional company-context question (ask only when needed)

Some strategy is irresponsible without business context (e.g. prioritising
commercial vs. informational templates, or judging whether a content lever fits
the brand). **Only when a serious strategy cannot be written without it**, ask
the operator a tightly-scoped question, for example:

> "To prioritise correctly I need one piece of context: what is the primary
> business goal for this site (lead-gen / e-commerce revenue / brand /
> publisher reach), and is there a focus segment or geography?"

Rules for this question:
- Ask **at most one** compact question, and only if its absence would make the
  strategy guesswork. If the findings already determine the order, **do not ask**
  — proceed and note any assumptions explicitly in `strategy.md`.
- Never request private/sensitive data; you only need goal + segment.
- If unanswered, proceed with a clearly labelled assumption (`prov = geschätzt`).

---

## 4. Output structure

### `data/<host>/strategy.md`
A senior memo, roughly:
1. **Situation** — 3–5 sentences: site type, sample/coverage, the dominant
   patterns from `execSummary`. State confidence honestly (cite `minNMet`).
2. **Levers** — the 3–6 themes, each with: the lever, the evidence from the
   audit (cite finding `id`s), the KB grounding (cite `source`/`heading`), the
   expected mechanism of impact, and its provenance.
3. **Sequenced roadmap** — ordered by ICE: quick wins (high score, `e = 3`)
   first, then structural bets. For each todo: what, why, rough effort, and the
   findings it resolves.
4. **Risks & unknowns** — what would change the plan; what needs measurement or
   the company-context answer.
5. **GEO note** — if relevant, how the plan affects AI-answer citability.

### `findings.json.strategy`
- `levers[]` — the themes from §2 of the memo (short strings).
- `todos[]` — the sequenced roadmap items, ordered as in the memo (short strings).
Keep these consistent with the memo, then re-run `validateFindings` from
`lib/findings-schema.mjs` and fix any errors before finishing.

### Verständlichkeits-Rubrik für `levers`/`todos` (verbindlich — Kunden-Output)

`strategy.levers` und `strategy.todos` erscheinen wörtlich im Kunden-Report.
Es gelten dieselben Regeln wie in `skills/interpret.md` §1b — jedes To-do trägt
die **vier Ebenen** in einem reinen String (keine Objekte, das Schema erzwingt
Strings):

- **Muster:** `[Priorität hoch · Aufwand gering · Entwicklung] <konkrete
  Handlung in Alltagssprache> — <Geschäftsnutzen in einem Halbsatz>.`
  Beispiel: *„[Priorität hoch · Aufwand gering · Entwicklung] Die Sperre für
  ChatGPT-Suchcrawler aus der robots.txt entfernen — sonst kann ChatGPT Ihre
  Website nicht als Quelle nennen."*
- Priorität/Aufwand im Präfix müssen mit den ICE-Werten der zugehörigen Befunde
  **konsistent** sein (gleiche Buckets wie der Renderer: `e` 3/2/1 →
  gering/mittel/groß; `score` ≥ 18/≥ 8/sonst → hoch/mittel/niedrig) — keine
  freihändige Zweitbewertung.
- Zuständigkeit aus dem `wer`-Vokabular: `Entwicklung`, `Redaktion`, `Agentur`
  oder Kombination.
- Fachbegriffe vermeiden oder im Nebensatz erklären; Ton beratend, nie
  belehrend; keine versprochenen Kennzahlen (Anti-Overclaim gilt unverändert).
- `levers` — je Hebel ein jargonfreier Satz, benannt nach dem Geschäftsnutzen,
  nicht nach der Technik.

---

## Definition of done
- `data/<host>/strategy.md` written: questions you designed, KB-grounded answers,
  sequenced roadmap, explicit provenance and confidence.
- `findings.json.strategy.levers/todos` updated and `validateFindings` still
  returns `valid: true`.
- Company-context question asked **only** if genuinely required; otherwise
  assumptions are stated explicitly.
