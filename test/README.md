# Tests

Dependency-free `node --test` suite.

```bash
npm test          # runs: node --test --test-concurrency=1
```

## Why `--test-concurrency=1`

A subset of tests exercise the full crawl→analyze bookend, and some derive the
output directory from the loopback host (`data/127.0.0.1/`). The most at-risk
suites isolate themselves with a unique `fs.mkdtempSync` data dir, but to keep
the signal clean and byte-deterministic regardless, the suite is **serialised**
(`--test-concurrency=1`) — this is pinned in the `test` script and in CI, so a
shared-state race can never turn the build intermittently red.

## Regenerating the frozen example-run goldens

`examples/example-run/{crawl.csv,signals.json,analysis.json,affected-urls.csv}`
are deterministic goldens regression-tested by `test/determinism.test.mjs`
(`FROZEN_CRAWLED_AT`, `rps:50, maxUrls:40`). An intentional detector/format change
turns that test red on purpose — regenerate the goldens with a bookend run at the
frozen params and rewrite the ephemeral port to the committed origin's port. The
LLM artifacts (`findings.json`, `index.html`) are a manually-maintained snapshot.
