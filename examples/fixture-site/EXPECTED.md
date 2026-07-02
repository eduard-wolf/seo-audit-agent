# EXPECTED.md — Golden Reference for Unit D Analyzer Tests

**Site:** Demo Kaffeerösterei (synthetic fixture, `http://demo.example/`)
**Purpose:** Deterministic ground-truth for Unit D (Analyzer) assertions.
Each row maps a fixture file to its intentional defect and the expected
rule category / finding identifier that the analyzer must emit.

Rule IDs match the implementations in `config/rules/*.json` exactly.
Rules marked **(D2+)** are not implemented in Unit D1.

---

## Per-Page Expected Findings

| File | Intentional Defect | Expected Rule / Finding |
|---|---|---|
| `index.html` | Organization JSON-LD present but **missing `sameAs` property** | **(D2+)** `schema:org-missing-same-as` |
| `perfect.html` | *Best-practice content-reference page (75 words). Structurally clean for all content/SEO rules, but genuinely thin (75 < 100 words) and inherits crawl-environment artifacts of the localhost-HTTP run* | `onpage:thin` (genuine, 75 words); crawl-environment artifacts `tech:https`, `tech:canonical-nonself`, `tech:frame-protection-missing`, `perf:text-compression-missing`, and the Batch 4b security-header rules `tech:nosniff-missing`, `tech:referrer-policy-missing`, `tech:permissions-policy-missing`, `tech:csp-missing` — see the "`perfect.html`" section below |
| `missing-title.html` | No `<title>` element | `onpage:title-missing` |
| `long-title.html` | `<title>` is 94 characters (>60) | `onpage:title-long` |
| `dup-title-a.html` | Same `<title>` as `dup-title-b.html` | `onpage:title-dup` (pair: a↔b) |
| `dup-title-b.html` | Same `<title>` as `dup-title-a.html` | `onpage:title-dup` (pair: a↔b) |
| `missing-meta.html` | No `<meta name="description">` | `onpage:meta-missing` |
| `dup-meta-a.html` | Same `meta description` as `dup-meta-b.html` | `onpage:meta-dup` (pair: a↔b) |
| `dup-meta-b.html` | Same `meta description` as `dup-meta-a.html` | `onpage:meta-dup` (pair: a↔b) |
| `multi-h1.html` | Two `<h1>` elements + heading jump H1→H3 (no H2) | `onpage:h1-multi`, `onpage:heading-skip` |
| `noindex.html` | `<meta name="robots" content="noindex">` while listed in `sitemap.xml`; its self-`rel=canonical` therefore points to a **noindex** target | `tech:noindex-conflict`; **(Batch 4d)** `tech:canonical-target-broken` (canonical → noindex target) |
| `thin.html` | Body word count <100 words | `onpage:thin` |
| `no-alt.html` | 4× `<img>` without `alt` attribute; all `.jpg` (no webp/avif) | `onpage:alt-missing` (count=4), **(D2+)** `onpage:non-modern-image-format` |
| `invalid-schema.html` | Block 1: JSON-LD with syntax error (unclosed `}`). Block 2: `Product` JSON-LD without `aggregateRating` | `schema:invalid`, `schema:product-no-aggregate` |
| `no-citations.html` | Statistical claims, zero outgoing authoritative links | **(D2+)** `geo:missing-citations` |
| `orphan.html` | In `sitemap.xml` but not linked by any other page | **(D2+)** `crawl:orphan-page` (count=1 — the **only** orphan; the 410 page and the redirect source are also unlinked but are excluded because only live 2xx, non-redirected pages can be genuine orphans) |
| `xss.html` | Title, meta description, and H1 contain XSS payloads (`<script>alert(1)</script>`, `"><img src=x onerror=alert(1)>`) | *(no SEO finding)* — payload propagates as extracted string to verify **Unit G renderer escaping** |
| `client-rendered.html` | Near-empty body (`<div id="app"></div>` + `<script src="/app.bundle.js">`) | `crawl:client-rendered` (JS-guard flag, content rules suppressed) |

### Redirect chain (served by fixture-server, not a static file)

| Path | Behaviour | Expected Finding |
|---|---|---|
| `/redirect-1` | 301 → `/redirect-2` → 301 → `/redirect-final.html` | `tech:redirect-chain` (hop-count=2); also flagged by `tech:sitemap-quality` (redirected sitemap entry) |
| `/gone-page.html` | Listed in `sitemap.xml`; server returns **410** | `tech:sitemap-quality` (status=410), `tech:non-2xx` |

### Site-level files

| File | Intentional Defect | Expected Rule / Finding |
|---|---|---|
| `robots.txt` | `User-agent: OAI-SearchBot` + `Disallow: /` blocks ChatGPT-Search citations | **(D2+)** `geo:ai-bot-blocked` (bot=OAI-SearchBot) |
| `sitemap.xml` | Contains `/gone-page.html` (410) and `/noindex.html` (noindex conflict) and `/redirect-1` (redirect) | `tech:sitemap-quality` flags all three; `tech:noindex-conflict` additionally for `/noindex.html` |
| `llms.txt` | Missing mandatory H1 title line (`# …`) and blockquote summary (`> …`) | **(D2+)** `geo:llms-txt-malformed` |
| `private/secret.html` | Disallowed by `robots.txt`; must **not** appear in crawl output | *(assertion: URL absent from crawl CSV)* |

---

## `perfect.html` — best-practice content reference (NOT zero findings)

`perfect.html` is the **best-practice content-reference page**: it is structurally
clean for every content/markup/SEO best-practice rule. It is **not** a literal
zero-findings page, however. Against the live localhost-HTTP bookend it fires
exactly the following, and nothing else:

**Genuine fire (a real, page-level issue):**

- `onpage:thin` — the body is **75 words** (`wordCount=75`), below the 100-word
  heuristic threshold. This is a true thin-content fire, not an artifact: the page
  is deliberately concise. (`onpage:thin` is severity `niedrig` and Google uses no
  word-count threshold — caveated in the finding detail.)

**Crawl-environment artifacts (properties of the localhost-HTTP test harness, NOT
page defects):**

- `tech:https` — the fixture server speaks plain HTTP, so `httpsOk=0` for every
  page including `perfect.html`. In production over HTTPS this does not fire.
- `tech:canonical-nonself` — `perfect.html` declares a self-referential canonical
  to its own production URL `http://demo.example/perfect.html`. Because the crawl
  host is `127.0.0.1`, the canonical host differs → `canonSelf=0` → the rule fires.
  In production (crawl host == canonical host) this is a true self-canonical and
  does not fire.
- `tech:frame-protection-missing` — the default fixture server sends no
  `X-Frame-Options` / CSP `frame-ancestors` header (`frameProtection=0`). The U4.7
  integration assertions use `startFixtureServer({ responseHeaders:{'X-Frame-Options':'SAMEORIGIN'} })`
  to suppress it; the default bookend run does not.
- `perf:text-compression-missing` — the default fixture server does not compress
  (`contentEncoding=''`). The U4.7 integration assertions use `compress:true` to
  suppress it; the default bookend run does not.
- `tech:nosniff-missing`, `tech:referrer-policy-missing`,
  `tech:permissions-policy-missing`, `tech:csp-missing` (Batch 4b) — the default
  fixture server sends none of `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, or `Content-Security-Policy`, so all four fire for every
  content page including `perfect.html`. Inject the headers via
  `startFixtureServer({ responseHeaders:{…} })` to suppress them; the default
  bookend run does not. These are Trust/Security-hardening signals — NOT ranking
  factors and NOT rich-result eligibility. `tech:cookie-insecure` and
  `tech:version-disclosure` do NOT fire (no Set-Cookie / no Server/X-Powered-By).

Positive signals (rules `perfect.html` correctly does NOT trip):

- Title present and ≤60 characters; `meta description` present; exactly one `<h1>`
- Canonical is *self-referential in format* (only flagged here as a host artifact)
- Valid `Article` JSON-LD with `datePublished`, `dateModified`, and `author`
- Publisher `Organization` includes `sameAs`, `logo`, and `contactPoint`
- All images have `alt` text, explicit `width`/`height`, and use `.webp` format
- Has a viewport meta + UTF-8 charset; one canonical; not a js-guard page
- At least one outgoing link to an authoritative domain (`de.wikipedia.org`)

---

## Welle 4 (U4.1) — Viewport + Charset Rules

Three new rules added in U4.1 (`tech:viewport-missing`, `onpage:viewport-zoom-disabled`,
`tech:charset-missing`). Fire-case coverage uses **synthetic ctx unit tests** in
`analyze.test.mjs` (low fixture-churn approach per brief). `perfect.html` has been
updated with `<meta name="viewport" content="width=device-width, initial-scale=1">` and
already carried `<meta charset="utf-8">` — it stays clean against all three rules.

Most other fixture pages lack a viewport meta tag and will be flagged by
`tech:viewport-missing` in integration runs; this is expected behaviour and not
per-page enumerated here (the fixture pages serve other defect scenarios).

---

## Coverage Note — `client-rendered.html`

The crawler (Unit C) will extract near-zero text from this page because
the body contains only `<div id="app"></div>`. The Empty-/JS-Guard must:

1. Set `error=js-guard:empty-body` in the crawl CSV row.
2. **Not** emit content-quality findings (thin-content, missing-h1, etc.)
   that would be false positives for a valid SPA with SSR disabled.
3. The analyzer (Unit D) suppresses all content rules for pages where
   `error=js-guard:empty-body` via `contentRows()`, and emits
   `crawl:client-rendered` as the sole finding for such pages.

---

## Welle 4 (U4.2) — Open Graph + Favicon + Canonical-Multiple Rules

Three new rules added in U4.2 (`onpage:og-missing`, `onpage:favicon-missing`,
`tech:canonical-multiple`). Fire-case coverage uses **synthetic ctx unit tests** in
`analyze.test.mjs` (low fixture-churn approach per brief).

`index.html` now declares `<link rel="icon" href="/favicon.ico">` so the homepage stays
clean against `onpage:favicon-missing`. No fixture page uses Open Graph markup, so
`onpage:og-missing` does not fire in integration runs. Every fixture page declares exactly
one canonical (or none), so `tech:canonical-multiple` does not fire in integration runs.
`perfect.html` has no OG (og-missing won't fire), one canonical (canonical-multiple won't
fire), and is not the homepage (favicon-missing N/A) — it stays clean against all three rules.

---

## Coverage Note — redirected rows

The crawler records the original URL (e.g. `/redirect-1`) as `url` in the CSV,
with `redirected=1` and parsed content from the redirect destination.
The analyzer's `contentRows()` helper excludes `redirected=1` rows to prevent
false positives in content rules (`onpage:title-dup`, `onpage:thin`, etc.).
`tech:canonical-nonself` likewise excludes redirect rows.
`tech:sitemap-quality` actively **flags** redirect rows as bad sitemap entries.

---

## Welle 4 (U4.3) — Image Dimensions + LCP-Lazy Rules

Two new rules added in U4.3 (`onpage:img-missing-dimensions`, `onpage:lcp-image-lazy`).
Fire-case coverage uses **synthetic ctx unit tests** in `analyze.test.mjs` (low fixture-churn
approach per brief). No fixture HTML change was needed.

`perfect.html`'s two images already carry `width="800" height="600"` and are not lazy →
`imgNoDimensions=0`, `firstImgLazy=0` → both rules stay clean for `perfect.html`.
No fixture page has dimensionless images or a lazy first image, so neither rule fires in
integration runs (both appear in `positives`). The new COLS (`imgNoDimensions`, `firstImgLazy`)
are appended at the end of COLS after `canonicalCount`.

---

## Welle 4 (U4.4) — DOM Size + Render-Blocking Head Rules

Two new rules added in U4.4 (`onpage:excessive-dom`, `onpage:render-blocking-head`).
Three new COLS appended at the end of COLS after `firstImgLazy`:
`domNodeCount`, `headBlockingScripts`, `headBlockingStyles`.
Fire-case coverage uses **synthetic ctx unit tests** in `analyze.test.mjs` (low fixture-churn
approach per brief). No fixture HTML change was needed.

`perfect.html` has a small DOM (well under 1400 nodes) and no render-blocking head scripts or
≥4 stylesheets → `domNodeCount` is tiny, `headBlockingScripts=0`, `headBlockingStyles=0` →
both rules stay clean for `perfect.html`.

The only fixture external script (`client-rendered.html`, `<script src="/app.bundle.js">`) is a
js-guard page excluded by `contentRows()`, so `onpage:render-blocking-head` never fires in
integration runs for that page. No fixture page has a >1400-node DOM, so `onpage:excessive-dom`
does not fire in integration runs either. Both rules appear in `positives` for the integration run.

---

## Welle 4 (U4.5) — Links/a11y + mixed-content extension

Two new rules added in U4.5 (`links:generic-anchor`, `a11y:control-no-name`) plus an extension
of the mixed-content regex (adding `form`/`track` tags and `action` attribute, surfaced via the
existing `tech:https` rule — NO new rule id).

Three new COLS appended at the end of COLS after `headBlockingStyles`:
`genericAnchorCount`, `emptyLinkCount`, `unlabeledControlCount`.

`links:generic-anchor` fires on contentRows where `genericAnchorCount + emptyLinkCount >= 1`.
`a11y:control-no-name` fires on contentRows where `unlabeledControlCount >= 1` (iframe-without-title
or button-without-name only; generic form-field label association is intentionally deferred).

Fire-case coverage uses **synthetic ctx unit tests** in `analyze.test.mjs` and **inline HTML**
in `parse.test.mjs` (low fixture-churn approach per brief). No fixture HTML change was needed.

`perfect.html`'s anchors are descriptive ("← Startseite", "Wikipedia-Artikel über Kaffee"),
it has no iframe or button, and no http:// form/track resources → all three new signals are 0 →
both new rules stay clean for `perfect.html`. The fixture has no iframes or buttons so neither
rule fires in integration runs. Mixed-content never fires on the fixture (served over http → the
`url.startsWith('https://')` guard is false). Both new rules appear in `positives` for the
integration run.

---

## Welle 4 (U4.6) — Structured-Data JSON-LD checks

Four new structured-data rules added in U4.6, all appended to `config/rules/structured-data.json`
(kategorie "structured-data"):

- `schema:aggregaterating-incomplete` — fires on contentRows where `hasAgg === '1'` AND
  (`aggRatingValue === ''` OR `aggRatingCount === ''`). Disjoint from `schema:product-no-aggregate`
  (which fires when `hasAgg === '0'`). Rich-Result-Eligibility, NOT a ranking signal.
- `schema:merchant-shipping-returns` — fires on contentRows where `hasProduct === '1'` AND
  (`hasShippingDetails !== '1'` OR `hasReturnPolicy !== '1'`). RECOMMENDED properties only;
  can be supplied via Google Merchant Center instead of markup. NOT a ranking signal.
- `schema:organization-logo` — fires on contentRows where `hasOrg === '1'` AND `hasOrgLogo !== '1'`.
  logo is RECOMMENDED for Google's Knowledge Panel / logo in search. NOT a ranking signal.
- `schema:organization-contact` — fires on contentRows where `hasOrg === '1'` AND
  `hasOrgContactPoint !== '1'`. contactPoint is RECOMMENDED for entity/Knowledge Panel enrichment.
  NOT a ranking signal.

Six new COLS appended at the end of COLS after `unlabeledControlCount`:
`aggRatingValue`, `aggRatingCount`, `hasShippingDetails`, `hasReturnPolicy`, `hasOrgLogo`, `hasOrgContactPoint`.

Two new traversal helpers added to `crawl/parse.mjs`: `findAggregateRating` and `orgHasProperty`.
The existing `orgHasSameAs` / `hasOrgSameAs` are left untouched.

Fire-case coverage uses **synthetic ctx unit tests** in `analyze.test.mjs` and **inline HTML**
in `parse.test.mjs`. No new fixture HTML file was needed.

**Fixture edit (REQUIRED):** `perfect.html`'s Article `publisher` Organization now declares `logo`
and `contactPoint` (in addition to the existing `sameAs`) so it stays clean for all four new rules.
`perfect.html` has no Product and no AggregateRating, so `schema:aggregaterating-incomplete` and
`schema:merchant-shipping-returns` never fire on it.

`invalid-schema.html` (Product, no AggregateRating) and `index.html` (Organization without logo/
contactPoint) will fire some of these rules in integration runs — this is expected and intentional,
not enumerated per-page here.

---

## Welle 4 (U4.7) — Response-Header Checks

Four new response-header rules added in U4.7. HTTP response headers are captured in
`crawl/fetch.mjs` (request sends `Accept-Encoding: gzip, deflate, br`) and threaded
through `crawl/crawl.mjs` → `crawl/run.mjs` as C1 fields. Four new COLS appended
at the end of COLS after `hasOrgContactPoint`:
`xRobotsTag`, `hstsPresent`, `frameProtection`, `contentEncoding`.

- `tech:x-robots-noindex` — fires on contentRows where `isNoindex(r.xRobotsTag)`. The
  X-Robots-Tag header is invisible in View Source and often an unintentional CDN/staging
  guard. Finding carries "verify intentional". KEIN Ranking-Signal.
- `tech:hsts-missing` — fires on contentRows where `httpsOk='1'` AND `hstsPresent!='1'`.
  Gated on HTTPS pages only (HTTP pages must not send HSTS). KEIN Ranking-Signal.
- `tech:frame-protection-missing` — fires on contentRows where `frameProtection!='1'`
  (neither X-Frame-Options nor CSP frame-ancestors present). KEIN Ranking-Signal.
- `perf:text-compression-missing` — fires on contentRows where `contentEncoding` does not
  match `gzip|br|deflate|zstd`. Added to `config/rules/performance.json`. KEIN Ranking-Signal.

Fire-case coverage uses **synthetic ctx unit tests** in `analyze.test.mjs` and a
`startFixtureServer({ responseHeaders:{...}, compress:true })` integration clean assert.
Header capture verified in `test/fetch.test.mjs` against a well-configured fixture server.

`perfect.html` stays clean for all four rules on the integration server
`startFixtureServer({ responseHeaders:{'X-Frame-Options':'SAMEORIGIN'}, compress:true })`:
  - `xRobotsTag=''` → x-robots-noindex does not fire
  - `httpsOk=0` (http fixture) → hsts-missing gated out
  - `frameProtection=1` (X-Frame-Options injected) → frame-protection-missing does not fire
  - `contentEncoding='gzip'` (compress:true) → text-compression-missing does not fire

**`tech:http-not-redirected` is DEFERRED** — needs a cross-scheme site-level http:// origin
probe that the http-only in-process fixture cannot represent; also overlaps `tech:https`.
Better as a focused follow-up unit.

---

## Welle 6 (U6.2) — trust:contact-pages-missing + Ruleset 1.5.0

One new site-level rule added in U6.2 in the new `trust` category
(`config/rules/trust.json`, auto-discovered by `loadRules`):

- `trust:contact-pages-missing` — fires once (`count=1`, `affectedUrls=[]`) when none of the
  crawled or discovered (via `signals.linkGraph.depthByUrl`) URLs matches a recognizable
  contact/about/imprint/privacy path pattern (case-insensitive, umlaut-normalized). It is a
  **site-level** finding with empty `affectedUrls` (not a per-page flag). Trust signal per
  Google QRG (NOT a ranking factor); for DE commercial sites Impressum + Datenschutz are a
  LEGAL obligation. Heuristic — manual verification recommended.

**The fixture demo site exposes no contact/about/legal pages** → `trust:contact-pages-missing`
DOES fire on the fixture (count=1, affectedUrls=[]). This is correct and expected behavior —
it is a site-level finding, not a per-page defect, and `perfect.html` is not affected.

Ruleset bumped to **1.5.0**.

---

## Welle 6 (U6.4) — geo:poor-chunkability

New GEO heuristic added in U6.4 (`config/rules/geo.json`, kategorie geo, severity niedrig):

- `geo:poor-chunkability` — fires on contentRows where `wordCount > 900` AND
  `headingOutline.split(',').filter(Boolean).length <= 1`. A long page with at most
  one heading (i.e. only an H1 or zero headings) is a "wall of text" that AI/RAG
  retrievers cannot chunk well. STRUCTURE heuristic for KI-Extrahierbarkeit only —
  KEIN Google-Ranking-Signal, KEIN Wortzahl-Qualitätshinweis (Google: word count is NOT
  a quality or ranking signal). Framed as manual-review hint. Practitioner evidence
  (no Google primary source).

No fixture page exceeds 900 words, so `geo:poor-chunkability` does **not** fire in
integration runs (it appears in `positives`). Fire-case coverage is via **synthetic ctx
unit tests** in `analyze.test.mjs`.

`perfect.html` is short (75 words) with one H1 → wordCount ≤ 900 → rule never fires →
`perfect.html` remains clean against `geo:poor-chunkability` (it does fire `onpage:thin`
at the 100-word threshold — see the "`perfect.html`" section).

---

## Batch 4a — robots.txt SUBSTANCE + URL hygiene (Ruleset 1.6.0)

Four new deterministic rules that **reuse already-collected signals** (no new crawl /
extraction). Eligibility-not-ranking framing throughout.

robots.txt substance (`config/rules/tech-index.json`, reuse `signals.robots`):

- `tech:robots-site-blocked` (severity **hoch**) — fires when the `User-agent: *` group
  disallows the whole site, via the RFC-9309 matcher `isPathAllowed('/', signals.robots) === false`
  (an overriding `Allow: /` is honored, so a bare `Disallow: /` + `Allow: /` is NOT a full block).
- `tech:robots-noindex-directive` (severity **mittel**) — fires on a line-anchored, case-insensitive
  `noindex:` directive in `signals.robots.raw`; flagged INEFFECTIVE (Google dropped robots.txt
  `noindex` support effective 2019-09-01). Commented (`# noindex:`) and in-path (`Disallow: /noindex/`)
  occurrences do not match.
- `tech:robots-no-sitemap` (severity **niedrig**) — fires when `signals.robots.sitemapRefs` is empty
  (no `Sitemap:` directive). Recommended, not an error.

URL hygiene (`config/rules/hygiene.json`, reuse crawl.csv `url`/`finalUrl`/`status`/`redirected`):

- `hygiene:url-inconsistency` (severity **niedrig**) — site-level. Over the live-2xx, non-redirect
  URL set it flags (1) a www vs non-www host mix both serving 2xx, (2) trailing-slash inconsistency
  (same host+path served with AND without a trailing slash), and (3) per-URL hygiene heuristics
  (uppercase path letters — `%XX` percent-octets stripped first to avoid umlaut false positives —,
  underscores, session-id-like params `;jsessionid=`/`sid=`/`phpsessid=`/`sessionid=`, or length
  `> maxUrlLength` (115)). Explicitly a HEURISTIC and NOT a ranking factor.

**Default fixture behavior — all four are POSITIVES, no per-page table changes:**

- `tech:robots-site-blocked` — fixture `robots.txt` disallows only `/private/` (not `/`) → positive.
- `tech:robots-noindex-directive` — fixture `robots.txt` has no `noindex:` line → positive.
- `tech:robots-no-sitemap` — fixture `robots.txt` declares `Sitemap: http://demo.example/sitemap.xml`
  → positive.
- `hygiene:url-inconsistency` — the localhost fixture is single-host, lowercase, with no trailing-slash
  twins and no dirty URLs → positive.

Fire-case coverage is via **synthetic-ctx unit tests** plus a **fixture-server `robotsBody` override**
integration path (real fetch + parseRobots → `signals.robots` → detector) in
`test/robots-substance.test.mjs`; the default-fixture positives are asserted there too. No new files
were added under `examples/fixture-site/` (crawl surface unchanged).

Ruleset bumped to **1.6.0** (77 → 81 rules).

---

## Batch 4b — Response/Security-header completeness (Ruleset 1.6.0, NO bump)

Six new **Trust/Security-hardening** rules extend the existing header family
(HSTS + frame protection). They are framed EXPLICITLY as security hardening —
**NOT ranking factors and NOT rich-result eligibility** (every detail string
carries "KEIN Ranking-Signal — Trust/Security-Härtung"), mirroring the existing
`tech:hsts-missing` / `tech:frame-protection-missing` wording and their
site-level (not per-page-explosion) aggregation over `contentRows`.

New rules in `config/rules/tech-index.json` (kategorie `tech-index`):

- `tech:nosniff-missing` (severity **mittel**) — fires when `nosniffPresent != '1'`
  (no `X-Content-Type-Options: nosniff`). Quelle: OWASP Secure Headers Project + MDN.
- `tech:referrer-policy-missing` (severity **niedrig**) — fires when
  `referrerPolicyPresent != '1'` (no `Referrer-Policy`).
- `tech:permissions-policy-missing` (severity **niedrig**) — fires when
  `permissionsPolicyPresent != '1'` (no `Permissions-Policy`).
- `tech:csp-missing` (severity **mittel**) — fires when `cspPresent != '1'` (no
  `Content-Security-Policy` overall; distinct from the frame-ancestors check of
  `tech:frame-protection-missing`).
- `tech:cookie-insecure` (severity **mittel**) — fires when `cookieInsecure == '1'`,
  i.e. a served `Set-Cookie` misses Secure / HttpOnly / SameSite. Gated in
  `crawl/fetch.mjs`: without any Set-Cookie the flag is `'0'`, so the rule does NOT
  fire. (`res.headers.getSetCookie()` is available on the installed Node v24 and is
  used to read multiple Set-Cookie headers individually; a raw-header fallback exists.)
- `tech:version-disclosure` (severity **niedrig**) — fires when
  `versionDisclosure == '1'`, i.e. `X-Powered-By` is present OR `Server` carries a
  version token (e.g. `nginx/1.18.0`). A bare `Server: cloudflare` does NOT trip it.

Six new COLS appended at the end of COLS after `hreflangLinks`:
`nosniffPresent`, `referrerPolicyPresent`, `permissionsPolicyPresent`,
`cspPresent`, `cookieInsecure`, `versionDisclosure`. They are pure functions of
the response headers (captured in `crawl/fetch.mjs`, no extra fetch) and threaded
through `crawl/crawl.mjs` → `crawl/run.mjs` exactly like the U4.7 header fields.

**Default fixture behavior — exactly four FIRE, two are POSITIVES:**

- `tech:nosniff-missing`, `tech:referrer-policy-missing`,
  `tech:permissions-policy-missing`, `tech:csp-missing` — **FIRE** (the fixture
  server serves none of these headers) for every content page (incl. `perfect.html`).
- `tech:cookie-insecure` — **POSITIVE** (no Set-Cookie served).
- `tech:version-disclosure` — **POSITIVE** (Node's http server sends no `Server`
  banner and no `X-Powered-By`).

Fire/no-fire coverage: **synthetic-ctx detector units** in `analyze.test.mjs`,
**pure-helper units** (`computeCookieInsecure` / `computeVersionDisclosure`) plus
**full-pipeline integration** (default / hardened / insecure-cookie+banner servers
via `startFixtureServer({ responseHeaders })`) in `security-headers.test.mjs`, and
**header-capture units** in `fetch.test.mjs`. No new `examples/fixture-site/` files.

Ruleset stays **1.6.0** (NOT re-bumped): **81 → 87 rules**.

---

## Batch 4c — Microdata/RDFa detection + robots-blocked render resources (Ruleset 1.6.0, NO bump)

Two parse-time structured-data/resource checks. Three new COLS appended at the end
of COLS after `versionDisclosure` (parse-derived C2 fields, threaded through
`crawl/parse.mjs` → `crawl/run.mjs` `buildRow` — NOT through `crawl/crawl.mjs`, which
only assembles fetch-layer C1 fields):
`hasMicrodata`, `hasRdfa`, `resourcePaths`.

- `hasMicrodata` (1/0) — as-served HTML contains an `itemscope` AND an `itemtype`
  whose value contains `schema.org`. `hasRdfa` (1/0) — a `typeof=` or `vocab=`
  attribute. Both are regex over the comment-stripped HTML (deterministic).
- `resourcePaths` — pipe-joined, deduplicated, document-order list (capped at 20) of
  SAME-ORIGIN `<script src>` and `<link rel=stylesheet href>` reference paths
  (pathname+search).

**Check 1 — Microdata/RDFa gate (false-positive guard).** `hasOrg`/`hasBreadcrumb`
are JSON-LD-only signals. A site marked up entirely in Microdata or RDFa would make
the ABSENCE detectors misfire. Two detectors now suppress on `hasMicrodata==='1' ||
hasRdfa==='1'`: `schema:no-organization` (site-level) and `schema:breadcrumb-missing`
(per-row). The presence-gated rules (e.g. `schema:article-no-author`) already
early-return on empty `ldTypes` and are unchanged. Google supports JSON-LD, Microdata
AND RDFa (Search Central — Structured data intro, 2026-06).

New informational rule `schema:microdata-only` (kategorie `structured-data`, severity
**niedrig**) — fires on contentRows where (`hasMicrodata==='1'` OR `hasRdfa==='1'`) AND
`ldTypes` is empty. Explicitly framed as NOT a defect (detail carries "KEIN Defekt");
JSON-LD is Google's recommended format.

**Check 2 — robots-blocked render resources.** New rule
`tech:robots-blocked-resources` (kategorie `tech-index`, severity **mittel**) — fires
on contentRows where any `resourcePaths` entry tests `!isPathAllowed(path,
signals.robots)` (RFC-9309 matcher, reused from `crawl/robots-match.mjs`). Mirrors
`tech:robots-sitemap-conflict` (build `{disallow, allow}`, early-return on empty
disallow). As-served caveat in the detail: flags the FACT of a blocked resource, not
its render-criticality → Eignungs-/Rendering-Risiko, KEIN Ranking-Faktor.

**Default fixture behavior — BOTH new rules are POSITIVES; gating is a no-op; no
per-page table change:**

- Every fixture page is JSON-LD (no `itemscope`/`typeof`/`vocab`) → `hasMicrodata=0`
  and `hasRdfa=0` on all rows → the two gated detectors behave exactly as before
  (`schema:no-organization` already a positive because `index.html`/`perfect.html`
  carry Organization JSON-LD; `schema:breadcrumb-missing` unaffected) and
  `schema:microdata-only` is a **POSITIVE**.
- Only `client-rendered.html` references a same-origin resource
  (`resourcePaths=/app.bundle.js`); robots.txt disallows only `/private/`, so the
  path is allowed, and that page is a js-guard row excluded by `contentRows()` anyway
  → `tech:robots-blocked-resources` is a **POSITIVE**.

Fire-case coverage: **inline-HTML units** in `parse.test.mjs` (hasMicrodata/hasRdfa/
resourcePaths extraction + 20-cap + dedup + cross-origin exclusion) and **synthetic-ctx
detector units** in `analyze.test.mjs` (both gates, `schema:microdata-only` fire/no-fire,
`tech:robots-blocked-resources` blocked/allowed/no-disallow). No new
`examples/fixture-site/` files (crawl surface unchanged).

Ruleset stays **1.6.0** (NOT re-bumped): **87 → 89 rules**.

---

## Batch 4d — Link-graph TARGET integrity (Ruleset 1.6.0, NO bump)

Four new deterministic rules cross-reference a page's canonical / hreflang / internal
`<a href>` **TARGET** against that target's OWN crawled row. They **reuse already-collected
data** (existing crawl.csv columns + a new persisted `signals.json.linkGraph.edges` adjacency
— no new fetch). Eligibility/crawl-quality framing throughout; **explicitly NOT direct
ranking factors**. CRITICAL design point: the "broken" predicates key off the target row's
`redirected`/`redirectChain` fields, NOT just its final status — the crawler FOLLOWS redirects,
so a redirected target's row typically shows the final 2xx.

**signals.json shape change:** `linkGraph` gains an `edges` key — `[{ url, internalLinks[] }]`,
one entry per crawled page, emitted in stable crawl/CSV-row order (so two runs produce
byte-identical `signals.json` except `crawlMeta.crawledAt`). `internalLinks` are the
deduplicated, normalized same-origin targets already produced by `parsePage`.

New rules:

- `tech:canonical-target-broken` (severity **hoch**, `config/rules/tech-index.json`) — a
  content page's `rel=canonical` points to an INTERNAL URL (matched by pathname, host-ignored,
  like `tech:sitemap-quality`) whose crawled row is HTTP ≥ 400, a redirect SOURCE, **or**
  `noindex`. Cross-host/uncrawled targets are not found → skipped (not flagged).
- `i18n:hreflang-target-broken` (severity **mittel**, `config/rules/i18n.json`) — same idea for
  hreflang targets pointing to HTTP ≥ 400 or redirect-SOURCE internal URLs (noindex is NOT
  checked here; the source-noindex case is owned by `i18n:hreflang-on-noindex`).
- `links:internal-broken` (severity **hoch**, `config/rules/links.json`) — a content page whose
  persisted `edges` adjacency contains an `<a href>` target whose crawled row is 4xx/5xx.
- `links:internal-redirect` (severity **mittel**, `config/rules/links.json`) — a content page that
  links to a target which is itself a redirect SOURCE (link the FINAL URL instead).

For the canonical/hreflang/internal rules, `affectedUrls` lists the **SOURCE** pages (where the
offending canonical/hreflang/href lives — the fix site). Sources are restricted to `contentRows()`
so a redirect-source row (whose parsed canonical/hreflang/adjacency came from the redirect
DESTINATION) is never mis-attributed.

**Default fixture behavior — exactly ONE fires, the other three are POSITIVES (no new
fixture files; per-page table updated only for `noindex.html`):**

- `tech:canonical-target-broken` — **FIRES** on `noindex.html` (count=1). Its self-`rel=canonical`
  (`http://demo.example/noindex.html`) resolves by pathname to its own crawled row, which carries
  `robots=noindex` → the canonical target is non-indexable. (This is the same noindex defect the
  repo already surfaces under `tech:noindex-conflict` + `tech:noindex-canonical-conflict` — an
  accepted multi-rule overlap, here framed as "the declared canonical target is non-indexable".)
  All other fixture canonicals self-reference live 2xx pages; `index.html`'s canonical (`/`) has no
  exact-pathname row (the home page was crawled as `/index.html`) → skipped, no false positive.
- `i18n:hreflang-target-broken` — **POSITIVE** (the fixture has no `hreflang` annotations).
- `links:internal-broken` — **POSITIVE** (the 410 `/gone-page.html` is only in `sitemap.xml`, never
  linked via `<a href>`; every internal link targets a live 2xx page).
- `links:internal-redirect` — **POSITIVE** (`index.html` links the FINAL `/redirect-final.html`,
  never the redirect source `/redirect-1`).

Fire-case coverage: **synthetic-ctx detector units** in `test/link-integrity.test.mjs`
(canonical → 4xx / redirect-source / redirectChain-only / noindex / healthy / cross-host-skip /
no-canonical; hreflang → 4xx / redirect-source / healthy / no-hreflang / uncrawled-skip;
internal-link → 4xx and redirect, plus negatives and no-edges) + **integration positives/fire**
assertions in `analyze.test.mjs` + an `edges`-shape + determinism assertion in `run.test.mjs`.

Ruleset stays **1.6.0** (NOT re-bumped): **89 → 93 rules**.

---

## Ruleset 1.7.0 — review-2026-07 SEO-depth additions (positive-only on this fixture)

Three additive rules; all three are **positive-only** on this fixture (nothing new fires),
so the fixture's raw findings count stays **42** and only the positives count rises (48 → 51):

- `schema:context-invalid` — a parseable JSON-LD block whose top-level object lacks a
  `schema.org` `@context`. The fixture's JSON-LD all uses `@context: https://schema.org`, so
  this is a **positive** here. Backed by a new parse-time `ldContextOk` column.
- `i18n:html-lang-hreflang-mismatch` — the self-referential hreflang disagrees with
  `<html lang>`. The fixture declares no hreflang, so this is **not applicable → positive**.
- `geo:noimageindex` — robots-meta `noimageindex`. No fixture page sets it → **positive**.

Ruleset bumped to **1.7.0**: **93 → 96 rules**. Detector units live in
`test/seo-depth-1_7.test.mjs`; the fixture output is pinned by the example-run regression
golden in `test/determinism.test.mjs`.

### Detector refinements (same ruleset 1.7.0, no bump)

Two false-positive/redundancy fixes turned two former fixture findings into positives, so the
raw findings count drops **42 → 40** and positives rise **51 → 53**:

- `tech:canonical-missing` now gates on `contentRows` (indexable 2xx). It no longer fires on
  `client-rendered.html` (js-guard, empty as-served body) or `gone-page.html` (410) — a
  missing canonical on a non-content page was a false positive.
- `tech:canonical-target-broken` no longer double-reports a **self-referential** canonical whose
  only defect is noindex (that exact case is owned by `tech:noindex-canonical-conflict`). On the
  fixture `noindex.html` was the only fire, so the rule is now a positive; cross-**target** noindex
  canonicals still fire.
