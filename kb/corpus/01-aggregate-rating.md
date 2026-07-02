---
source: https://developers.google.com/search/docs/appearance/structured-data/review-snippet
datum: 2025-12-10
---

# aggregateRating Rich Results and Structured Data

## What aggregateRating Does

`aggregateRating` is a Schema.org property used inside `Product`, `Recipe`, `LocalBusiness`, and other types to expose review summaries to search engines. When implemented correctly, Google may display star ratings directly in search result snippets — these are called **Rich Results**.

## Required Properties

To qualify for the `aggregateRating` rich result, you must provide:
- `ratingValue` — the numeric average rating (e.g. `4.7`)
- `reviewCount` or `ratingCount` — how many reviews the average is based on
- `bestRating` and `worstRating` (recommended) — the scale endpoints

Example JSON-LD:

```json
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Example Widget",
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "4.7",
    "reviewCount": "312",
    "bestRating": "5",
    "worstRating": "1"
  }
}
```

## Common Mistakes

- Displaying ratings for a page that isn't about a rateable entity (Google's guidelines forbid this).
- Using a `ratingValue` outside the `worstRating`–`bestRating` range.
- Placing the markup in a `<template>` tag that is not rendered in the DOM.
- Not including enough real reviews to meet Google's quality threshold.

## Testing

Use the Google Rich Results Test (search.google.com/test/rich-results) or the Schema Markup Validator to confirm the markup is read correctly before expecting SERP enhancement.
