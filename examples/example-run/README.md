# Example Run — eingefrorener Beleg-Lauf (Proof of Generation)

Dieser Ordner ist **kein Mock**. Er enthält die echten Artefakte **eines einzigen
Durchlaufs** der vollständigen Pipeline gegen die synthetische Test-Site
(`examples/fixture-site/`, „Demo Kaffeerösterei"). Er belegt nachvollziehbar,
dass der Report aus dem Tool stammt — und nicht von Hand geschrieben wurde.

## Die Kette (jeder Schritt erzeugt die Eingabe des nächsten)

```
fixture-site/  ──(crawl)──►  crawl.csv      ┐
                             signals.json   ├─(analyze, Regeln)─►  analysis.json
                                            ┘
analysis.json  ──(interpret: 1 RAG-geerdeter LLM-Schritt)──►  findings.json
findings.json  ──(render, deterministisch)──────────────────►  index.html
```

| Datei | Schicht | Erzeugt durch |
|---|---|---|
| `crawl.csv` | 1 — Crawl | `bin/crawl-and-analyze.mjs` (→ `crawl/run.mjs`) |
| `signals.json` | 1 — Crawl | dito (robots/llms/aiBots + Link-Graph) |
| `analysis.json` | 2 — Regel-Analyse | dito (→ `analyze/analyze.mjs`, Regelwerk 1.7.0 — 96 Regeln) |
| `findings.json` | 3 — Interpretation | `skills/interpret.md`, **ein** RAG-geerdeter LLM-Schritt, validiert gegen `lib/findings-schema.mjs` |
| `index.html` | 5 — Render | `report/build-report.mjs` (deterministisch, CSP-rein, escaped) |

## So wurde dieser Lauf reproduziert

```bash
# 1. Fixture-Server starten (bindet einen ephemeren Port auf 127.0.0.1) und crawlen+analysieren.
#    Im Repo gefahren über test/fixture-server.mjs; daher der Origin http://127.0.0.1:<port>.
node bin/crawl-and-analyze.mjs http://127.0.0.1:<port>
#    → schreibt data/127.0.0.1/{crawl.csv,signals.json,analysis.json}

# 2. Interpretieren (skills/interpret.md, capable model im Thinking-Modus):
#    analysis.json lesen → kb/retrieve.mjs für Grounding → findings.json schreiben → validieren.

# 3. Rendern:
node report/build-report.mjs findings.json   # → index.html
#    (inzwischen erzeugt derselbe Befehl zusätzlich report.pdf via installiertem
#     Chrome headless; dieser historische Lauf wurde vor dem PDF-Schritt erzeugt)
```

`data/` ist git-ignored und transient; die drei deterministischen Artefakte sind
hier nach `examples/example-run/` kopiert, damit der Beleg im Repo liegt.

## Was dieser Lauf demonstriert

- **Echte Kette, kein Hand-Output.** `findings.json` ist gegen den Vertrag
  `validateFindings` schema-valide; `index.html` ist exakt das, was der Renderer
  daraus erzeugt (Footer-Stempel: Modell, Regelwerk, Crawl-Zeitpunkt).
- **Interpretation statt Daten-Dump.** Die 40 Roh-Regel-Treffer (Regelwerk 1.7.0)
  werden zu einem priorisierten Senior-Audit von 27 Befunden in 6 Abschnitten
  verdichtet: ICE-Scoring (`score = i×c×e`), Provenienz pro Befund,
  Evidence-before-Assertion, RAG-zitierte Empfehlungen.
- **Anti-Overclaim sichtbar gemacht.** Abschnitt 6 des Reports („Fehlalarme der
  Testumgebung") ordnet `tech:https` (100 %) und `tech:canonical-nonself`
  (85,7 %) ehrlich als Artefakte des localhost-HTTP-Laufs ein — gemessen
  korrekt, aber kein realer Site-Defekt — statt sie als kritische Funde
  aufzublasen.
- **Klartext für Nicht-Techniker.** Die Interpretation folgt der
  Verständlichkeits-Rubrik (`skills/interpret.md` §1b): jeder Befund trägt
  Problem in Alltagssprache, Business-Wirkung, konkrete Handlung + `wer`
  (Entwicklung/Redaktion/Agentur); Priorität und Aufwand leitet der Renderer
  deterministisch aus den ICE-Ankern ab.

## Eingefrorener Stand

Die LLM-Synthese (Schritt 3) ist **nicht-deterministisch**. Dieser Lauf ist eine
eingefrorene, repräsentative Momentaufnahme. Der Crawl-Zeitpunkt im Report ist
statisch gestempelt (`2026-06-29`, ISO), weil der Renderer bewusst ohne
Wall-Clock arbeitet (byte-identische Ausgabe je `findings.json`).

Die Interpretationsschicht (`findings.json` + `index.html`) wurde am 2026-07-23
unter der neuen Verständlichkeits-Rubrik **neu erzeugt** — über denselben,
unveränderten deterministischen Artefakten (`crawl.csv`, `signals.json`,
`analysis.json`); ein frischer Kontroll-Crawl der Fixture lieferte
messungs-identische 40 Regel-Treffer und identische Positives.

> Öffne `index.html` per `file://` im Browser. Screenshots (PNG) werden ergänzt —
> ihre Erzeugung ist ein manueller Schritt außerhalb der dependency-freien Kette.
