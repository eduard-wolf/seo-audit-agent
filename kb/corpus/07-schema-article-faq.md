---
source: https://developers.google.com/search/docs/appearance/structured-data/article
datum: 2025-12-10
---

# Schema Markup: Article, FAQPage, and HowTo

## Article Schema

Use `Article`, `NewsArticle`, or `BlogPosting` to help Google understand editorial content.

```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "How to Improve Core Web Vitals",
  "author": { "@type": "Person", "name": "Jane Doe" },
  "datePublished": "2024-05-01",
  "dateModified": "2024-09-15",
  "image": "https://example.com/images/cwv-guide.jpg"
}
```

`datePublished` and `dateModified` in ISO 8601 format help Google display freshness dates in search snippets.

## FAQPage Schema

`FAQPage` no longer produces Google rich results (discontinued May 2026; previously restricted to government/health sites since August 2023). Its value today is **GEO / AI-answer surfaces**: structured question–answer pairs help AI answer engines (ChatGPT Search, Perplexity, AI Overviews) extract and surface your content accurately. Each question/answer pair is a `Question` entity with an `acceptedAnswer`.

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is LCP?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Largest Contentful Paint measures when the largest element in the viewport is rendered."
      }
    }
  ]
}
```

**Note (2026-06):** Google progressively restricted and then fully removed FAQPage rich results: limited to authoritative government/health sites in August 2023, discontinued for all sites as of May 2026. FAQPage markup no longer produces Google rich results. Its value today is **GEO / AI-answer surfaces**: structured question–answer pairs help AI answer engines (ChatGPT Search, Perplexity, AI Overviews) extract and surface your content accurately.

## HowTo Schema

`HowTo` markup no longer produces Google rich results (feature removed: mobile August 2023, desktop September 2023). Its value today is **GEO / AI-answer surfaces**: explicit step-by-step structure helps AI answer engines extract how-to procedures reliably. Each step uses `HowToStep` with `name` and `text`. Include `totalTime` (ISO 8601 duration, e.g. `PT30M`) and `estimatedCost` where relevant.

## Nesting and Multiple Types

You can combine types: a `Product` page can contain an `aggregateRating` and also reference `Review` entities. Avoid declaring a page as two top-level types simultaneously — use the most specific applicable type.
