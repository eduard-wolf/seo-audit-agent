# `eval/` — Evals für den LLM-Interpretationsschritt

Diese Harness **misst automatisiert die Qualität des einen nicht-deterministischen
Schritts** der Pipeline: den LLM-Interpretationsschritt (`skills/interpret.md`), der die
deterministische `analysis.json` in eine `findings.json` übersetzt. Der crawl→analyze-Kern
ist bereits unit-/golden-getestet; hier geht es um das, was Tests **nicht** können — die
Bewertung eines offenen, nicht-deterministischen Modell-Outputs.

> **Abgrenzung (ehrlich).** Unit-Tests prüfen deterministischen Code (gleicher Input → exakt
> erwarteter Output). **Evals** prüfen LLM-Output gegen **kuratierte Erwartungen + Grounding**
> — nicht gegen „die Wahrheit". Diese Harness misst, ob der Interpretationsschritt die
> deterministisch bekannten Kern-Findings **zuverlässig aufgreift**, sich **an die Analyse
> hält** (keine Erfindungen), **real zitiert** und **stabil** ist. Sie misst *nicht* absolute
> Korrektheit.

## So fährst du sie

```bash
npm run eval        # deterministisch, KEY-FREI: scored den committeten Snapshot + Gate
```

`npm run eval` ruft **kein Modell** auf und braucht **keinen API-Key**. Es führt nur die
deterministischen Scorer gegen den committeten Snapshot aus und liest die committeten
Judge-Verdikte. Läuft in CI im Node-Job mit.

## Wie es aufgebaut ist

```
eval/
  fixtures/<archetyp>/analysis.json          # 6 Golden-Inputs (5 synthetisch + example-run real)
                     /expected-findings.json  # must-contain ruleId-Anker + must-NOT-contain Fallen
  runs/<archetyp>/run-<k>/findings.json       # committete Modell-Outputs (der Baseline-Snapshot)
                 /run-<k>/judge.json           # committete Cross-Model-Faithfulness-Verdikte
  judge/PROMPT.md, RUBRIC.md                   # versionierter Judge-Skill (judge-v1)
  scorers/*                                    # deterministische Scorer (key-frei)
  run.mjs, baseline.json, gate.json            # Runner + No-Regression-Baseline + Floors
  report/latest.{json,md}                      # generierter Report (byte-deterministisch)
```

**Snapshot-Prinzip (der Grund für die Reproduzierbarkeit + Key-Freiheit):** Die
modell-berührenden Schritte — (a) das Erzeugen der `findings.json` (der interpret-Schritt) und
(b) der LLM-Judge — werden **einmal, manuell** über Claude-Code-Sessions erzeugt und als
**versionierter Snapshot committet**. Danach scored `npm run eval` nur noch diesen Snapshot,
deterministisch und key-frei. Neu gemessen wird bewusst **manuell**, wenn sich Prompt oder
Modell ändern (siehe „Baseline erneuern").

## Was gemessen wird

| Metrik | Was sie misst | Deterministisch? |
| --- | --- | --- |
| **Recall / Coverage** | Deckt der Output die erwarteten Kern-`ruleId`s? (Coverage-Matching, nicht Wortlaut) | ✅ |
| **Citation-Validität** | Löst jede `kbSources[].source` auf eine der 8 KB-Korpus-Dateien auf? | ✅ |
| **Schema** | `findings.json` schema-valide (`lib/findings-schema.mjs`) | ✅ |
| **Fabrications (strukturell)** | Referenziert ein Finding einen `ruleId`, der nicht in der Analyse steht / der bestanden hat? | ✅ |
| **Provenienz / Anti-Overclaim** | Enum-/ICE-Invarianten, `minNMet`-c≤1-Kappung u. a. | ✅ |
| **Stabilität (pass^k)** | Über k unabhängige Läufe: Anteil mit vollem Recall | ✅ (aus k committeten Läufen) |
| **Faithfulness** | Anteil der Findings mit Judge-Verdikt `pass` = **alle drei Achsen**: durch die Analyse gedeckt **und** Provenienz korrekt **und** keine erfundenen Zahlen (`warn`/`fail` zählen nicht). `supported`/Provenienz/erfundene-Zahlen bleiben als separate Diagnose-Kennzahlen. | LLM-as-Judge (committete Verdikte, deterministisch aggregiert) |

**Arbeitsteilung:** deterministisch = strukturell/Enum/Coverage/Citation-Existenz; **Judge** =
semantische Faithfulness (was ein struktureller Check nicht sehen kann).

**Aggregation (ehrlich benannt):** Recall und Stabilität werden **pro Fixture gemittelt, dann
über Fixtures gemittelt** (macro-average) — Stabilität dabei nur über Fixtures mit **≥2**
committeten Läufen (ein einzelner Lauf ergibt kein sinnvolles pass^k). Citation-Validität und
Faithfulness werden dagegen **über alle Verdikte bzw. alle Zitate hinweg gepoolt** (micro-average),
nicht pro Fixture gemittelt — Faithfulness als Anteil der `pass`-Verdikte über alle 103 Verdikte.

## Aktuelle Baseline (echt, reproduzierbar)

Gemessen an **6 Fixtures**, **k=3** unabhängigen interpret-Läufen je synthetischer Fixture
(example-run: 1 realer Lauf), **16 Läufe / 103 Judge-Verdikte** gesamt:

| Metrik | Baseline |
| --- | --- |
| Recall | 1.00 |
| Citation-Validität | 1.00 |
| Fabrications (strukturell) | 0 |
| Faithfulness (Judge, strikt) | **0.9223** |
| Stabilität pass^3 | 1.00 |
| Schema valide | ja |

Die Faithfulness ist die **strikte** Pass-Rate (Verdikt `pass` = alle drei Achsen) und liegt
**bewusst nicht bei 1.00**: über 103 Verdikte sind 95 `pass`, 6 `warn` (gedeckt, aber weiche
Provenienz-Ungenauigkeit) und 2 `fail`. Die 2 Fehler sind genuine Bugs, die der Cross-Model-Judge
im **realen, committeten `example-run`** fand (ein Verweis auf eine bestandene Regel; eine
erfundene Redirect-Hop-Angabe). Zum Vergleich: die reine `supported`-Rate (nur Achse 1) läge bei
0.9806 — die strengere, ehrlichere Zahl ist die hier gegatete. Genau dafür ist der Judge da.

**Modelle (aus offizieller Anthropic-Doku gepinnt):** interpret = `claude-opus-4-8`,
Judge = `claude-sonnet-5` (Cross-Model, reduziert Self-Preference-Bias). Beide über die
Claude-Code-Abo-Session erzeugt, **nicht** über einen programmatischen API-Key.

## Das CI-Gate

`npm run eval` endet mit Exit-Code und gated auf:

- **Harte Invarianten (immer absolut):** Schema valide, Fabrications = 0, Citation-Validität = 100 %.
- **Weiche Metriken (Recall, Faithfulness, pass^k):** (a) **No-Regression** gegen `baseline.json`
  **und** (b) ein **konservativer Floor** (`gate.json`, deutlich unter Baseline). Der Floor
  verhindert schleichende Baseline-Erosion („Boiling-Frog") und garantiert, dass ein grüner
  Build ein genanntes Minimum erfüllt. **Primär-Signal bleibt No-Regression.**

## Baseline erneuern (manueller Ritus)

Wenn sich `skills/interpret.md`, der Judge-Prompt oder das Modell ändert, wird **neu gemessen**:

1. Pro Fixture k **unabhängige** interpret-Läufe über frische Claude-Code-Sessions/Subagenten
   erzeugen (jeder sieht nur `analysis.json` + KB, **nie** `expected-findings.json`) →
   `eval/runs/<fixture>/run-<k>/findings.json`, jeweils gegen `validateFindings` grün.
2. Je Lauf ein Judge-Verdikt mit einem **anderen** Claude-Modell (`eval/judge/PROMPT.md`) →
   `run-<k>/judge.json`, gegen `validateVerdicts` grün.
3. `node eval/run.mjs` laufen lassen, `report/latest.json`s `aggregate` als neue
   `eval/baseline.json` (`aggregate` verbatim + `generatedWith`-Provenienz) übernehmen.
4. Snapshot + Baseline committen. Der Grund für den Refresh (Prompt-/Modell-Änderung) gehört in
   die Commit-Message.

## Ehrliche Grenzen

- Misst gegen **kuratierte Erwartungen + Grounding**, nicht gegen absolute Wahrheit.
- Golden-Set ist klein (6 Fixtures) — die Zahlen sind **Reliabilitäts-Indikatoren**, keine
  statistisch belastbaren Populationsschätzer. Deshalb: No-Regression als Primär-Signal, Floor
  bewusst konservativ.
- Cross-Model **innerhalb Claude** reduziert Self-Preference-Bias deutlich; ein voll
  unabhängiger Fremd-Anbieter würde ihn weiter senken, wird aber bewusst vermieden (kein
  zusätzlicher Key, keine Kosten).
- Der Snapshot ist eine **Momentaufnahme** eines konkreten Modell-/Prompt-Stands; die
  Aussagekraft gilt für diesen Stand, bis bewusst neu gemessen wird.

## Format-Entscheidung: `expected-findings.json` statt `.yaml`

Das Repo ist 0-Dependency und hat keinen YAML-Parser; die Erwartungen brauchen Nesting +
Listen. Ein handgerollter YAML-Subset-Parser wäre getestete Fehlerfläche, von der die
Scorer-Korrektheit abhinge. Das Repo spricht bereits überall JSON → **JSON**, idiomatisch,
null zusätzlicher Code. (Bewusste Abweichung vom ursprünglichen Brief, der `.yaml` nannte.)
