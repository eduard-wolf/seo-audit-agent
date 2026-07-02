---
source: https://developers.google.com/search/docs/crawling-indexing/robots/intro
datum: 2025-12-10
---

# Crawlability, robots.txt, and XML Sitemaps

## robots.txt

`robots.txt` lives at the root of a domain (`https://example.com/robots.txt`) and instructs crawlers which paths they may or may not fetch.

### Syntax

```
User-agent: Googlebot
Disallow: /private/
Allow: /private/public-exception/

User-agent: *
Disallow: /admin/
```

### Common mistakes

- Accidentally blocking CSS or JS files that are needed to render pages.
- Using `Disallow: /` during a site migration and forgetting to revert it.
- Expecting `robots.txt` to keep pages out of the index — it only prevents *crawling*, not *indexing* from links.
- Using wildcards in ways not supported by all crawlers.

## XML Sitemaps

Sitemaps list the URLs you want crawlers to know about. They accelerate discovery but do not guarantee indexing.

### sitemap.xml essentials

- Every URL in the sitemap must be canonical and return HTTP 200.
- Set `<lastmod>` only if you track actual modification dates; fake lastmod degrades trust.
- Keep individual sitemap files under 50 MB and 50,000 URLs; use a sitemap index for larger sites.
- Submit the sitemap in Google Search Console (and Bing Webmaster Tools).

## noindex vs. Disallow

| Need | Use |
|------|-----|
| Prevent crawl | `Disallow` in robots.txt |
| Prevent indexing | `<meta name="robots" content="noindex">` or `X-Robots-Tag: noindex` |
| Both | Use both — robots.txt alone won't remove an already-indexed page |

## Crawl Budget

Large sites with millions of pages should optimise crawl budget by removing low-value URLs (paginated archives, filtered URLs, internal search results) from crawlable paths.
