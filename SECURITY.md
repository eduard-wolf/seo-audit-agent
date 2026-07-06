# Security Policy

`seo-audit-agent` is a source-available, evaluation-only tool that makes **real
HTTP requests to the audited site** and can consume third-party API keys (CrUX,
Google Safe Browsing, GSC). Please handle it accordingly.

## Authorised use only

Audit **only your own sites or sites you are explicitly authorised to audit.**
See [`DISCLAIMER.md`](DISCLAIMER.md) for the legal framing (ToS, § 87 UrhG, § 7
UWG, DSGVO data minimisation). When in doubt about authorisation, stop.

## Data & secrets handling

- **`data/` is transient and git-ignored.** Crawl artifacts (`crawl.csv`,
  `signals.json`, `analysis.json`, `findings.json`) stay local. Do not commit them.
- **API keys come from the environment** (`CRUX_API_KEY`, `SAFEBROWSING_API_KEY`,
  GSC credentials) and are **never** written into artifacts. Enrichment error
  reasons redact the key value before persisting. Never commit keys.
- `scripts/leak-scan.mjs` (run in CI) gates against committed secrets/brands.

## SSRF / request-safety posture

- `crawl/ssrf-guard.mjs` blocks literal private/reserved IPs (RFC 1918/4193/6598,
  loopback, link-local incl. cloud metadata `169.254.169.254`) on **every** hop,
  including redirects, for IPv4 and IPv6 (incl. decimal/hex/octal/mapped forms).
- **Documented limitation:** no DNS resolution is performed, so a public hostname
  that *resolves* to a private address is not blocked by the guard alone. The
  authorisation scope (`allowedHost`) is the complementary control. Run only
  against hosts you control/authorise.
- The enrichment HTTP clients (CrUX, Safe Browsing) and the TLS probe carry
  request timeouts; robots.txt is honoured (RFC 9309, incl. this bot's own UA group).

## The rendered report

`report/build-report.mjs` HTML-escapes **every** crawled/foreign string and ships
a strict `Content-Security-Policy` (`default-src 'none'`) with `<meta robots=noindex>`.
The report is a static, self-contained document intended to be hosted behind a gate.

## Reporting a vulnerability

This is a personal, eval-only project without a formal disclosure program. If you
find a security issue, please open a minimal, non-exploit issue describing the
class of problem, or contact the author. Do not include working exploits or real
target data in public reports.

## Contributions

Not accepting external code contributions at this time (evaluation-only licence —
see [`LICENSE`](LICENSE)).
