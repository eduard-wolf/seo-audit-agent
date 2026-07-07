# Faithfulness Judge — rubric (companion to `PROMPT.md`, `judge-v1`)

A compact decision table for the four per-finding fields. Judge strictly against
`analysis.json`; never against `expected-findings.json` (which the judge must not read).

## `supported`

| Situation | `supported` |
| --- | --- |
| Finding describes a rule hit present in `analysis.findings[]` | `true` |
| Every number/URL in the finding traces to the analysis (`count`, `pctOfPages`, `affectedUrls`, `meta`, `signals`) | `true` |
| Finding is about an issue absent from `analysis.findings[]` | `false` |
| Finding claims a problem for a rule listed in `analysis.positives[]` (it PASSED) | `false` |

## `provenanceCorrect`

| `prov` tag | Correct when… |
| --- | --- |
| `gemessen` | the finding's core value is a measured quantity in the analysis (count / pct / presence flag) |
| `beobachtet` | qualitative observation directly read off the data (no measured metric claimed as fact) |
| `geschätzt` | the finding's headline is the model's own inference/estimate |
| any | **incorrect** if the tag over-claims certainty (e.g. `gemessen` on an estimate) |

## `fabricatedNumbers`

`true` if the finding states any numeric value not present in / derivable from `analysis.json`:
- invented counts, percentages, prices, ratios, "N of M pages", CTR/traffic promises;
- for `confidence.minNMet === false` (sub-minimum sample): any promised quota or confident
  metric is fabrication (the analysis cannot support it).

Otherwise `false`. A finding with **no** numbers has `fabricatedNumbers: false`.

## `verdict`

- `pass` — `supported && provenanceCorrect && !fabricatedNumbers`.
- `warn` — `supported && !fabricatedNumbers`, but a minor provenance imprecision or soft
  over-statement.
- `fail` — `!supported`, OR `fabricatedNumbers`, OR a problem claimed for a passing rule.

## Honesty note (for the eval README)

This judge measures **faithfulness to the deterministic analysis** — is each finding
grounded, correctly attributed, and free of invented numbers. It does **not** measure whether
the finding is the "right" priority (that is recall, scored deterministically) nor absolute
truth about the site. Cross-model (a different Claude model than the one that produced the
findings) reduces self-preference bias; it does not eliminate it — a fully independent
third-party judge would reduce it further but is deliberately avoided (no extra key/cost).
