# seo-audit-agent

[![CI](https://github.com/eduard-wolf/seo-audit-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/eduard-wolf/seo-audit-agent/actions/workflows/ci.yml)

**Agentischer SEO/GEO-Audit-Workspace** — deterministisch sammeln & prüfen,
in **einem** RAG-geerdeten LLM-Schritt interpretieren, statisch rendern.

> Source-available, **all rights reserved** (siehe [`LICENSE`](LICENSE)). Nur
> eigene/autorisierte Sites auditieren — siehe [`DISCLAIMER.md`](DISCLAIMER.md).

> **English (TL;DR).** An agentic SEO/GEO audit workspace: collect & check
> **deterministically**, interpret in **one** RAG-grounded LLM step, render a
> self-contained HTML report **statically** — plus a client-ready `report.pdf`
> printed by installed headless Chrome (no npm package). Runs inside a coding
> agent (Claude Code); the Node core (crawler, rule engine, renderer) is
> dependency-free.
> The detailed docs below are in German. Security policy: [`SECURITY.md`](SECURITY.md).

---

## In 30 Sekunden — Was, Warum, Wirkung

**Was.** Ein Skill-Workspace, der eine Website crawlt, gegen **96 Checks über
10 Kategorien** (technisches SEO und **GEO** — Generative Engine Optimization,
Sichtbarkeit in KI-Antworten) prüft und daraus einen **interpretierten
Senior-Audit** plus
priorisierten Action-Plan und Strategie erzeugt. Gefahren wird er **im
Coding-Agent** (Claude Code), nicht als gehosteter SaaS.

**Warum das schwer ist.** Die Rohdaten sind das einfache Teil. Schwer ist das
*Urteil*: Welcher der 40 Roh-Regel-Treffer ist wirklich kritisch, welcher
nur Rauschen? Was ist ein echter Defekt — und was ein Artefakt der
Crawl-Umgebung? Generische LLM-Audits halluzinieren hier gern Zahlen und
Maßnahmen. Dieses Tool zwingt das Modell in **eine** eng begrenzte, geerdete
Interpretationsstufe mit Provenienz-Pflicht und zitiertem Wissen.

**Wirkung.** Statt eines Daten-Dumps liefert es das, was ein Senior-Auditor
abgeben würde: nach **ICE** (`score = i×c×e`) priorisierte Befunde mit Beleg,
Evidenz, Auswirkung und einer **wissensbasiert begründeten** Empfehlung — plus
einen sequenzierten Maßnahmen- und Strategieplan. Ergebnis ist ein
self-contained HTML-Dokument, das gegatet ausgeliefert werden kann — plus ein
kundenfertiges `report.pdf`, das der Build automatisch über installiertes
Chrome headless mitdruckt (ohne Chrome: HTML wie gehabt, Warnung statt Abbruch).

---

## Für die Rolle — Kompetenz → Evidenz

Dieses Repo ist ein **polyglottes** Portfolio-Artefakt: ein bewusst
**dependency-freier Node-Kern** (Crawler, Regel-Engine, Renderer) plus
**produktionsreife Python-Adapter** für Datenanbindung und RAG-Store.

| Kompetenz | Konkrete Evidenz |
|---|---|
| **Technical SEO / GEO** | 96 Checks über 10 Kategorien (`config/rules/*.json`); Link-Graph mit Orphans/Click-Depth/Ziel-Integrität (`crawl/`, `analyze/detectors/`); AI-Bot-Direktiven + Zitier-/Entity-Signale (`config/rules/geo.json`) |
| **Automatisierung** | Deterministischer CLI-Bookend (`bin/`), Crawl-Profile/`--resume`, Secret-Gate (`scripts/leak-scan.mjs`), CI mit Node-Matrix 20/22/24 + Python-Job |
| **Python** | GSC-Enrichment (`crawl/gsc.py`) + pgvector-RAG-Store (`kb/pgvector_store.py`) — **typisiert (mypy), gelintet (ruff), 22 pytest, eigener CI-Job** |
| **LLM / RAG / Agent-Design** | Der eine LLM-Schritt als Prompt-Spec (`skills/interpret.md`), RAG mit Fallback-Embedder (`kb/`), schema-erzwungener LLM↔Renderer-Vertrag (`lib/findings-schema.mjs`) |

Ausführliche Fassung: [`docs/DESIGN.md`](docs/DESIGN.md).

---

## Wie es funktioniert — „Fan-out, then aggregate"

Das Leitprinzip: **deterministisch sammeln & prüfen → in EINEM LLM-Schritt
interpretieren → statisch rendern.** Crawler und Regel-Engine erzeugen
reproduzierbare Artefakte ganz ohne Modell. Genau **ein** agentischer Schritt
verdichtet sie zum Audit — geerdet in einer Wissensbasis. Ein statischer Renderer
macht daraus den Bericht. Die Beschränkung der Interpretation auf einen einzigen,
gut umrissenen, geerdeten Schritt ist das, was die Ausgabe vertrauenswürdig und
die Rolle des Modells **auditierbar** macht.

```
  Schicht 1            Schicht 2           Schicht 3              Schicht 5
  CRAWL (det.)         ANALYZE (det.)      INTERPRET (1× LLM)     RENDER (det.)
  ────────────         ──────────────      ──────────────────     ─────────────
  fetch + parse   ─►   96 Checks      ─►   senior judgment   ─►   self-contained
  robots/llms/         + Link-Graph        + RAG-Grounding         HTML-Report
  Link-Graph                               + ICE + Provenienz      (CSP-rein,
       │                    │              + Anti-Overclaim         escaped,
       ▼                    ▼                   │  ▲                 noindex)
  crawl.csv           analysis.json        findings.json ──────►   index.html
  signals.json                             (schema-validiert)
                                                ▲
                          Schicht 4: kb/ (RAG)  │  retrieve(query,k) → zitierte
                          8 kuratierte Korpus-Dokumente, gechunkt + embedded
```

> **Optionales Runtime-Overlay (nicht-deterministisch, key-gated).** Zwischen
> Schicht 1–2 und der Interpretation kann `node bin/enrich.mjs data/<host>` ein
> `runtime-signals.json` schreiben (CrUX-Felddaten, Google Safe-Browsing,
> TLS-Zertifikat). Es rührt `crawl.csv`/`analysis.json` **nie** an; ohne API-Keys
> schreibt es `{available:false}`. Deshalb liegt es bewusst *außerhalb* des
> deterministischen Rands.

**Warum das gegen Halluzination wirkt:**

- **Evidence before assertion.** Kein Befund ohne einen konkreten Wert/eine URL
  aus den Artefakten. Zahlen werden zitiert, nicht erfunden.
- **Provenienz pro Befund** — `gemessen` / `beobachtet` / `geschätzt`. Eine
  Schätzung wird nie als Messung verkleidet.
- **RAG-Grounding.** Jede Empfehlung wird gegen eine kuratierte Wissensbasis
  geprüft und zitiert (`kbSources`); fehlt die Deckung, sinkt die Konfidenz
  ehrlich, statt eine Quelle zu fingieren.
- **ICE mit Ankern.** `i`/`c`/`e` ∈ {1,2,3} gegen eine feste Rubrik;
  `score = i×c×e` ist eine deterministische Funktion, keine frei gegriffene Zahl.
- **Deterministischer Rand.** Crawl, Regeln und Render sind reproduzierbar; nur
  die mittlere Stufe ist ein Modell — und die ist begrenzt und nachprüfbar.

---

## Beispiel-Report (Proof of Generation)

➡️ **[`examples/example-run/index.html`](examples/example-run/index.html)** — per
`file://` im Browser öffnen.

Kein Mock: die echten Artefakte **eines** Durchlaufs der vollständigen Pipeline
gegen die synthetische Test-Site (`examples/fixture-site/`, „Demo
Kaffeerösterei"). Die Kette liegt nachvollziehbar im Ordner:

```
crawl.csv + signals.json + analysis.json  →  findings.json  →  index.html
   (Schicht 1–2, deterministisch)            (1× LLM, valide)   (Schicht 5)
```

Der Report verdichtet 40 Roh-Regel-Treffer zu 27 priorisierten Befunden — und
zeigt die Anti-Overclaim-Disziplin live: Abschnitt 6 ordnet `tech:https` (100 %)
und `tech:canonical-nonself` (85,7 %) ehrlich als **Crawl-Umgebungs-Artefakte**
des localhost-HTTP-Laufs ein, statt sie als kritische Funde aufzublasen. Details:
[`examples/example-run/README.md`](examples/example-run/README.md).

> **Keine PNG-Screenshots eingecheckt — bewusst.** Die 0-Dependency-Kette
> *bündelt* keinen Headless-Browser (der PDF-Schritt nutzt ein bereits
> installiertes Chrome und degradiert ohne es sauber); Screenshot-Bilder bleiben
> ein *bewusst manueller* Schritt außerhalb der reproduzierbaren Kette.
> Maßgeblicher, versionierter Beleg ist die oben verlinkte `index.html` selbst.

---

## Abgrenzung

### vs. klassische Crawler (Screaming Frog, Sitebulb, Ahrefs Site Audit)

Diese Werkzeuge sind exzellent darin, **Daten zu sammeln** und in Tabellen/Filter
zu kippen. Sie liefern einen Daten-Dump, den ein Mensch dann interpretieren muss.
`seo-audit-agent` setzt **eine Ebene darüber** an:

- **GEO-first.** Erstklassige Checks für KI-Sichtbarkeit (AI-Bot-Direktiven,
  `llms.txt`, Quellenangaben, Entity-/`sameAs`-Signale), nicht nur klassisches SEO.
- **Interpretierter Action-Plan statt Daten-Dump.** Roh-Treffer werden zu
  priorisierten, begründeten Empfehlungen verdichtet (ICE, Provenienz, Beleg).
- **Agentisch & CLI-nativ.** Läuft im Coding-Agent, dependency-frei (Node),
  Artefakte als Dateien auf der Platte — komponierbar, scriptbar, versionierbar.

Es **ersetzt** einen dedizierten Enterprise-Crawler für Tausende URLs nicht; es
liefert das *Urteil* obendrauf.

> **GEO-Aktualität (Stand 2026-06):** Die GEO-Checks zielen auf **nicht-Google
> KI-Oberflächen** (Perplexity, ChatGPT, Claude), die Antworten aus gecrawlten/
> zitierten Quellen bauen — Google Search selbst *nutzt `llms.txt` nicht* und
> behandelt die Grundlagen als klassisches SEO ([Google, AI-Optimization-Guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide),
> zuletzt aktualisiert ~2026-06); die Regeln bleiben also gültig, ihre Wirkung
> ist aber nach Zieloberfläche zu lesen.

### vs. `claude-seo`, `Agentic-SEO-Skill` & verwandte LLM-SEO-Skills

Es gibt eine wachsende Landschaft an SEO-Skills für Coding-Agents (in der
Tradition von **`claude-seo`** und ähnlichen agentischen SEO-Skills). Warum
existiert dieses Tool *daneben*, ehrlich gesagt?

- **Aus der Praxis gedacht, nicht aus einer Feature-Liste** — jeder Check bildet
  ab, was ein realer End-to-End-Audit tatsächlich braucht.
- **RAG-geerdet.** Empfehlungen sind gegen eine kuratierte Wissensbasis geprüft
  und zitiert — nicht aus dem Modell-Gedächtnis frei generiert.
- **Provenienz- & Anti-Overclaim-Disziplin.** Jeder Befund deklariert, wie er
  belegt ist; kleine Stichproben bekommen Caveats statt erfundener Prozentquoten;
  Umgebungs-Artefakte werden als solche markiert.
- **Single-Context-Betrieb ohne API-Kosten.** Die ganze Kette läuft in **einem**
  Coding-Agent-Kontext (deterministische Ränder + ein LLM-Schritt), ohne separate
  API-Schlüssel oder Pro-Token-Abrechnung gegen ein externes SEO-Backend.

---

## Voraussetzungen (ehrlich)

- **Claude-Code-Abo.** Das Tool wird **im Coding-Agent** gefahren, nicht als
  eigenständiger Dienst — die Interpretationsstufe ist der Agent selbst.
- **Ein fähiges, aktuelles Modell im Thinking-Modus.** Die Interpretation lebt
  von „erst denken, dann behaupten". Für Claude/Anthropic-Spezifika (Modell-IDs,
  Limits, Preise) gilt die **offizielle Anthropic-Doku** als Quelle — nie aus dem
  Gedächtnis zitieren.
- **Node ≥ 20.** Crawler, Regel-Engine und Renderer sind **dependency-frei**
  (reines Node, keine npm-Abhängigkeiten).
- **Optional: installiertes Chrome/Chromium** — nur für das automatische
  `report.pdf` am Ende des Renderns (headless `--print-to-pdf`, kein npm-Paket).
  Fehlt es, liefert der Build das HTML unverändert und überspringt das PDF mit
  klarer Warnung.
- **Python-Produktions-Adapter.** Der deterministische Kern ist bewusst
  dependency-freies Node; die Python-Seite liefert die Produktions-Adapter —
  GSC-Enrichment (`crawl/gsc.py`) und einen pgvector-RAG-Store
  (`kb/pgvector_store.py`), **typisiert (mypy), gelintet (ruff), mit 22 pytest
  und eigenem CI-Job**. Zur Laufzeit optional: der Standard-RAG läuft auch ohne
  sie mit einem lokalen Fallback-Embedder.

**Was die Maschine verlässt** (Transparenz): Der Crawler sendet **echte
HTTP-Requests an die Ziel-Site**. In der optionalen Strategie-Phase können
**Web-Suchen** ausgelöst werden. Andernfalls bleibt alles lokal; `data/` ist
transient und git-ignored (DSGVO-Datenminimierung, siehe `DISCLAIMER.md`).

---

## Schnellstart

```bash
# 1. Deterministischer Rand (kein Modell): crawlen + analysieren
node bin/crawl-and-analyze.mjs https://deine-eigene-site.example
#    → data/<host>/analysis.json (+ crawl.csv, signals.json, affected-urls.csv)

# 1b. (optional) Runtime-Enrichment (kein Modell, key-gated, nicht-deterministisch):
node bin/enrich.mjs data/<host>
#    → data/<host>/runtime-signals.json (CrUX / Safe-Browsing / TLS-Overlay;
#      ohne API-Keys: {available:false}; rührt crawl.csv/analysis.json nie an)

# 2. Interpretieren — skills/interpret.md im Agent anwenden:
#    analysis.json lesen → kb/retrieve.mjs fürs Grounding → findings.json
#    schreiben → mit validateFindings (lib/findings-schema.mjs) validieren.

# 3. (optional) Strategie — skills/strategy.md anwenden.

# 4. Rendern (kein Modell): HTML + PDF in einem Schritt
node report/build-report.mjs data/<host>/findings.json
#    → report/<host>/index.html + report/<host>/report.pdf
#      (PDF via installiertem Chrome/Chromium headless — kein npm-Paket;
#       Pfad auto-detektiert, überschreibbar per --chrome/$CHROME_PATH.
#       Ohne Chrome: HTML wie gehabt, PDF wird mit Warnung übersprungen;
#       --no-pdf schaltet bewusst ab.)
```

**Flags für Schritt 1** (`bin/crawl-and-analyze.mjs`):

| Flag | Wirkung |
|---|---|
| `--profile quick-scan` | Schnell-Triage / sehr kleine Site: ≤ 50 URLs, Tiefe 2, ~25 s — klärt `minNMet` (≥ 5). |
| `--profile standard` | **Default.** ≤ 300 URLs, Tiefe 4, ~2,5 min — die meisten Marketing-/KMU-Sites. |
| `--profile full-audit` | Große Sites, Near-Complete-Coverage: ≤ 25 000 URLs, Tiefe 8; Off-Peak. Verwirft HTML pro Seite (speicherschonend, kein DOM-Retain); Resume ab **sauberem Stopp**. |
| `--max <n>` | Harte Seitenobergrenze; überschreibt das Profil. |
| `--rps <n>` | Requests/Sekunde (Politeness-Drossel); überschreibt das Profil. |
| `--resume` | Setzt einen an einem **sauberen Stopp** (Cap/Drain) unterbrochenen Crawl aus `crawl-state.json` fort (byte-identisch). Ein Hard-Crash *mitten* im Crawl ist bewusst nicht resumebar — die Zwischenzeilen sind noch nicht persistiert; der Resume-Guard bricht dann **laut** ab statt still korrumpierte Daten zu liefern. |

Vollständiges Runbook: [`CLAUDE.md`](CLAUDE.md). Tests: `npm test`
(`node --test`, dependency-frei).

---

## Evals — der LLM-Schritt wird gemessen, nicht nur getestet

Der crawl→analyze-Kern ist deterministisch und golden-getestet. Der **eine
nicht-deterministische Schritt** — der LLM-Interpretationsschritt (`skills/interpret.md`:
`analysis.json` → `findings.json`) — ist zusätzlich **automatisiert evaluiert**. Unit-Tests
prüfen exakten Output; **Evals** prüfen offenen Modell-Output gegen kuratierte Erwartungen +
Grounding.

```bash
npm run eval    # deterministisch, KEY-FREI: scored den committeten Golden-Snapshot + Gate
```

Gemessen über **6 Fixtures** (5 synthetische Archetypen + der reale `example-run`), **k=3**
unabhängige Läufe je synthetischer Fixture (`example-run`: 1 realer Lauf), **16 Läufe /
103 LLM-as-Judge-Verdikte**:

| Recall | Citation-Validität | Fabrications | Faithfulness (Judge) | Stabilität pass³ |
|---|---|---|---|---|
| 1.00 | 1.00 | 0 | **0.9223** | 1.00 |

- **Deterministische Scorer** (key-frei): Recall/Coverage (ruleId-Matching), Citation-Existenz
  gegen die KB, Schema, strukturelle No-Fabrication, Provenienz/Anti-Overclaim, `pass^k`.
- **LLM-as-Judge** (Cross-Model, `claude-sonnet-5` bewertet `claude-opus-4-8`-Output): semantische
  Faithfulness je Finding gegen `analysis.json`. Die Zahl ist die **strikte** Pass-Rate (Judge-
  Verdikt `pass` = alle drei Achsen: gedeckt **und** Provenienz korrekt **und** keine erfundenen
  Zahlen). Die 92,23 % sind **echt, nicht 100 %** — über 103 Verdikte: 2 echte Fehler (u. a. zwei
  genuine Bugs im realen `example-run`) + 6 weiche Provenienz-Ungenauigkeiten (`warn`). Genau
  dafür ist der Judge da.
- **CI-gegated:** harte Invarianten (Schema, Fabrications = 0, Citations = 100 %) + No-Regression
  gegen committete Baseline + konservativer Floor. **Kein API-Key, keine Modell-Calls in CI** —
  die modell-berührenden Schritte werden manuell erzeugt und als versionierter Snapshot committet.

Methodik, Grenzen und der Refresh-Ritus: [`eval/README.md`](eval/README.md). **Ehrlich:** misst
gegen kuratierte Erwartungen + Grounding auf einem kleinen Golden-Set — nicht gegen absolute
Wahrheit, kein „misst Korrektheit absolut".

---

## Repo-Karte

| Pfad | Schicht | Inhalt |
|---|---|---|
| `crawl/`, `bin/` | 1 | Crawler + deterministischer Bookend-CLI |
| `analyze/`, `config/rules/` | 2 | Regel-Engine + 96 Checks über 10 Kategorien |
| `kb/`, `kb/corpus/` | 4 (RAG) | Wissensbasis: Chunking, Embedding, Retrieval, Korpus |
| `skills/` | 3 | `interpret.md`, `strategy.md`, `context-handoff.md` |
| `lib/findings-schema.mjs` | 3↔5 | Vertrag zwischen LLM-Ausgabe und Renderer |
| `report/` | 5 | Deterministischer, CSP-reiner HTML-Renderer |
| `examples/example-run/` | — | Eingefrorener Beleg-Lauf (Proof of Generation) |
| `eval/` | — | Evals des LLM-Schritts: Golden-Set, deterministische Scorer, Cross-Model-Judge, `npm run eval` |
| `test/` | — | `node --test`-Suite + synthetische Fixture |

---

## Lizenz & Recht

- **Lizenz:** Copyright (c) 2026 Eduard Wolf. **All rights reserved** —
  source-available, nicht Open Source. Klonen/Ausführen zur **persönlichen,
  nicht-kommerziellen Evaluierung** ist erlaubt; Weiterverbreitung, Modifikation
  und kommerzielle Nutzung bleiben vorbehalten und bedürfen schriftlicher
  Erlaubnis — siehe [`LICENSE`](LICENSE). Externe Code-Beiträge werden derzeit
  **nicht** angenommen (Eval-only-Lizenz) — siehe [`SECURITY.md`](SECURITY.md).
- **Recht:** Nur **eigene oder ausdrücklich autorisierte** Sites auditieren. Der
  Crawler trifft echte Server. ToS, § 87 UrhG (Datenbankrecht), § 7 UWG und
  DSGVO-Datenminimierung beachten — siehe [`DISCLAIMER.md`](DISCLAIMER.md).
