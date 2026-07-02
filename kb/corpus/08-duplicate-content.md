---
source: https://developers.google.com/search/docs/crawling-indexing/canonicalization
datum: 2025-12-10
---

# Duplicate Content and Canonical Tags

## What Duplicate Content Means

Duplicate content occurs when the same or substantially similar content appears at more than one URL. Google does not apply a "duplicate content penalty" per se, but it must choose one URL to rank — meaning the others receive diluted signals and may rank poorly or not at all.

## Common Causes

- HTTP vs. HTTPS variations (`http://example.com` vs. `https://example.com`)
- Trailing-slash vs. no-trailing-slash (`/page` vs. `/page/`)
- www vs. non-www
- URL parameters for tracking or filtering (`?ref=newsletter`, `?sort=price`)
- Printer-friendly page versions
- Syndicated content republished on multiple domains

## The Canonical Tag

```html
<link rel="canonical" href="https://example.com/preferred-url/" />
```

The canonical hint tells Google which URL is the "master" version. It is a hint, not a directive — Google may override it if contradictory signals exist.

### Best practices

- Self-referencing canonicals are always safe and recommended.
- Cross-domain canonicals require careful implementation: the source and target must agree.
- If you use pagination, do not canonicalise paginated pages to page 1 unless they truly duplicate it.

## 301 Redirects vs. Canonical

For truly duplicate pages you control (e.g. after a URL restructure), a 301 redirect is stronger than a canonical because it consolidates equity and resolves the URL definitively. Use canonical for situations where you need both URLs to remain accessible (e.g. syndicated content).

## Hreflang and Duplication

Translated pages are not "duplicate content" under Google's guidelines, but they must use `hreflang` tags to signal language/region targeting and avoid confusion.
