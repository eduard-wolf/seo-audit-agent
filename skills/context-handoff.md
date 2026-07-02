# Skill: context-handoff — lossless context rotation from artifacts

Long audits exceed a single context window. Rather than "summarising from
memory" (which loses fidelity and invites hallucination), this tool rotates
context **deterministically from the artifact files on disk**. The artifacts —
not the conversation — are the source of truth. A fresh session can resume an
audit with no loss because everything load-bearing was already written to
`data/<host>/`.

> Use a capable, current model in **thinking mode**. Do not reconstruct facts
> from recollection; reconstruct them from the files.

---

## When to rotate (triggers — step/heuristic based, NOT "count tokens")

Rotate at natural artifact boundaries or on explicit request:

- **After the crawl/analyze bookend** — once `data/<host>/analysis.json` exists,
  the raw crawl context is no longer needed in-window.
- **Per-section while interpreting** — e.g. after every **N findings** (default
  N = 10) or at the end of each `sections[]` group.
- **Before strategy** — once `findings.json` is valid, hand off into a clean
  session for `skills/strategy.md`.
- **Human `/rotate`** — the operator can trigger a handoff at any time.

Do **not** gate on token estimates or "the context feels full". Tie rotation to
deterministic, observable progress so it is reproducible.

---

## How to rotate — regenerate the handoff from the files

The handoff prompt is **generated from the written artifacts**, never from chat
history. The deterministic generator is **`bin/handoff.mjs`** (0-dependency, pure
Node) — this skill is its spec. Run it and use its output as the resume prompt:

```bash
node bin/handoff.mjs data/<host>          # or: node bin/handoff.mjs data/<host>/findings.json
```

It reads `data/<host>/analysis.json` (plus `findings.json` if present), derives
the progress ledger purely from those files (see step 2), and prints the packet in
the template format. Same on-disk state ⇒ byte-identical packet (no clock, no
random, sorted id lists), so two rotations are reproducible. You may instead walk
the steps manually, but `bin/handoff.mjs` is the source of truth for the ledger
maths.

Steps (what the generator does — and what you verify):

1. **Flush state to disk.** Ensure every result so far is persisted:
   `data/<host>/crawl.csv`, `signals.json`, `analysis.json`, and any partial
   `findings.json`. Nothing important may live only in the conversation.
2. **Build the handoff packet** purely by reading those files:
   - `host`, `meta` (siteType, sampleSize, coveragePct, minNMet) from
     `analysis.json`.
   - Progress ledger: which sections/findings are already written in
     `findings.json`, and which `analysis.findings[]` rule hits are not yet
     interpreted. Derive ruleIds covered in `findings.json` by scanning each
     finding's `beleg` field for a parseable `ruleId=<id>` token (e.g.
     `analysis.json ruleId=meta:missing`); findings carry no standalone `ruleId`
     field. Diff those extracted ids against the `ruleId`s in
     `analysis.findings[]` — do not rely on memory of "what we did".
   - The exact next step (e.g. "interpret remaining ruleIds: …" or "run
     skills/strategy.md").
3. **Emit the resume prompt** (see template). It points the next session at the
   files and the remaining work — it does **not** restate findings prose.
4. **Start clean.** The next session opens the artifacts and continues. Because
   the packet is derived from files, two rotations from the same on-disk state
   produce the same packet (lossless / reproducible).

---

## Handoff prompt template (fill from files, not memory)

```
Resume SEO audit for host: <host>  (artifacts in data/<host>/)
Site profile: siteType=<…> sampleSize=<…> coveragePct=<…> minNMet=<…>
Artifacts present: crawl.csv ✓  signals.json ✓  analysis.json ✓  findings.json <none|partial|complete>

Done so far (from findings.json):
  - sections written: <ids/titles>
  - ruleIds interpreted: <list>

Remaining (from analysis.json minus findings.json):
  - ruleIds not yet interpreted: <list>
  - next step: <apply skills/interpret.md to remaining | run skills/strategy.md | validate>

Rules of engagement: read data/<host>/*.json as ground truth; do NOT invent
numbers; follow skills/interpret.md (ICE anchors, provenance, KB grounding via
kb/retrieve.mjs, validateFindings before done). Use a current model in thinking
mode; Anthropic docs are the source of truth for Claude specifics.
```

---

## Definition of done
- All state is on disk in `data/<host>/` before the window is dropped.
- The resume packet was regenerated from those files by `bin/handoff.mjs`
  (verifiable: re-running it on the same on-disk state yields a byte-identical
  packet) and names the exact remaining work.
- The new session can continue with zero reliance on the prior conversation.
