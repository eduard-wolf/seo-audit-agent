# DESIGN — Warum der Determinismus-Bookend

Dieses Dokument begründet die Architektur in einer Seite: **deterministisch
sammeln & prüfen → in EINEM RAG-geerdeten LLM-Schritt interpretieren → statisch
rendern.** Die Kernfrage ist nicht „kann ein LLM einen SEO-Audit schreiben"
(kann es), sondern „**wie macht man seine Ausgabe vertrauenswürdig und
nachprüfbar**". Die Antwort ist, die Modellrolle radikal zu begrenzen.

## Warum genau EIN LLM-Schritt

Jeder Modellaufruf ist eine potenzielle Halluzinationsquelle. Rohdaten sammeln
(Crawl), Regeln auswerten (Analyze) und HTML erzeugen (Render) sind
**geschlossene, verifizierbare Probleme** — sie brauchen kein Urteil, nur
korrekten Code. Nur die Verdichtung von 42 Roh-Regel-Treffern zu 29
priorisierten Befunden ist echtes *Senior-Urteil*. Genau diese eine Stelle ist
das Modell. Alles andere deterministisch zu halten macht die Frage „hat das
Modell hier fantasiert?" auf **einen einzigen, eng umrissenen Schritt**
beschränkbar und damit auditierbar.

## Warum ein 0-Dependency-Kern (reines Node)

Crawler, Regel-Engine und Renderer haben **null npm-Abhängigkeiten**. Das ist
kein Purismus, sondern Reproduzierbarkeit und Auditierbarkeit: keine transitive
Supply-Chain, kein Versions-Drift, byte-identische Artefakte über
Node-Versionen 20/22/24 hinweg (CI-Matrix). Der deterministische Rand ist genau
so vertrauenswürdig, wie er einfach überprüfbar ist.

## Warum ein schema-erzwungener Vertrag

Zwischen LLM-Ausgabe und Renderer sitzt `lib/findings-schema.mjs#validateFindings`:
Severity-/Provenienz-Vokabular, ICE-Anker `i|c|e ∈ {1,2,3}`, `score = i×c×e`,
`kbSources` als Objekte. Das Modell kann nicht „irgendein JSON" abliefern — ein
strukturell unsauberer Befund wird **abgelehnt, nicht gerendert**. Der Vertrag
ist die Naht, an der ein statistischer Prozess (LLM) auf einen deterministischen
(Render) trifft; er hält die Naht ehrlich.

## Warum statisches Rendering

`report/build-report.mjs` erzeugt CSP-reines, self-contained HTML: nur Inline-CSS,
keine Skripte, jeder untrusted String HTML-escaped, `<meta robots=noindex>`.
Kein Client-JS heißt keine Runtime-Überraschungen und eine gegatet
auslieferbare Datei — der Report ist ein Artefakt, kein Programm.

## Anti-Overclaim- & Provenienz-Disziplin

- **Evidence before assertion** — kein Befund ohne konkreten Wert/URL aus den
  Artefakten; Zahlen werden zitiert, nicht erfunden.
- **Provenienz pro Befund** — `gemessen` / `beobachtet` / `geschätzt`; eine
  Schätzung wird nie als Messung verkleidet.
- **RAG-Grounding** — jede Empfehlung zitiert reale `kbSources`; fehlt Deckung,
  sinkt die Konfidenz ehrlich, statt eine Quelle zu fingieren.
- **Kleine Stichproben** — `minNMet = false` erzeugt Caveats statt erfundener
  Prozentquoten; Crawl-Umgebungs-Artefakte werden als solche markiert.

## Stellen-Kompetenz → Repo-Evidenz

| Kompetenz | Konkrete Evidenz im Repo |
|---|---|
| **Technical SEO / GEO** | `config/rules/*.json` (96 Checks über 10 Kategorien: on-page, tech-index, structured-data, GEO, performance, links, a11y, i18n, trust, hygiene); `analyze/engine.mjs` + `analyze/analyze.mjs` (Detektoren, ICE, affected-urls); `crawl/parse.mjs` + `crawl/run.mjs` (Robots-Enforcement, Redirect-Ketten, Link-Graph/Orphans/Click-Depth); `config/rules/geo.json` (AI-Bot-Direktiven, `llms.txt`, Zitier-/Entity-Signale) |
| **Automatisierung** | `bin/crawl-and-analyze.mjs` (deterministischer CLI-Bookend); `crawl/profiles.mjs` + `config/crawl-profiles.json` (`--profile`); `crawl/run.mjs` (Streaming, Checkpoint/`--resume`, Bounded Concurrency); `scripts/leak-scan.mjs` (Secret-Gate); `.github/workflows/ci.yml` (Node-Matrix 20/22/24 + Python-Job); `npm run clean` |
| **Python** | `crawl/gsc.py` (Search-Console-Enrichment, gemockt/skip-fähig); `kb/pgvector_store.py` (pgvector-Store für Produktion); `tests/python/*` (pytest); `pyproject.toml` + `requirements-dev.txt` (Ruff + Mypy im CI) |
| **LLM / RAG / Agent-Design** | `skills/interpret.md` (der eine LLM-Schritt), `skills/strategy.md`, `skills/context-handoff.md` (verlustfreie Kontext-Rotation aus Artefakten); `kb/retrieve.mjs` + `kb/chunk.mjs` + `kb/embed.mjs` + `kb/corpus/` (RAG mit lokalem Fallback-Embedder); `lib/findings-schema.mjs` (erzwungener LLM↔Renderer-Vertrag); `report/build-report.mjs` (statischer, CSP-reiner Renderer) |

---

*Kurz: Der Wert liegt nicht im LLM-Aufruf, sondern in den deterministischen
Rändern, die ihn einklammern — und in der Disziplin, mit der die eine
Interpretationsstufe geerdet, belegt und schema-geprüft bleibt.*
