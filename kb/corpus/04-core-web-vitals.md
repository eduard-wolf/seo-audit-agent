---
source: https://web.dev/articles/vitals
datum: 2024-10-31
---

# Core Web Vitals and Page Performance

## The Three Core Web Vitals

Google uses three metrics as ranking signals under the "Page Experience" update:

| Metric | Full Name | Good Threshold |
|--------|-----------|----------------|
| LCP | Largest Contentful Paint | ≤ 2.5 s |
| INP | Interaction to Next Paint | ≤ 200 ms |
| CLS | Cumulative Layout Shift | ≤ 0.1 |

INP replaced First Input Delay (FID) in March 2024.

## Improving LCP

- Preload the hero image with `<link rel="preload" as="image">`.
- Serve images in next-gen formats (WebP, AVIF).
- Use a CDN to reduce time-to-first-byte (TTFB).
- Eliminate render-blocking resources (defer non-critical CSS/JS).

## Reducing CLS

- Always set explicit `width` and `height` attributes on `<img>` and `<video>` elements.
- Reserve space for ads and embeds before they load.
- Avoid inserting DOM content above the fold after the page loads.

## Improving INP

- Minimise main-thread work: break long tasks with `scheduler.yield()`.
- Lazy-load third-party scripts that block interaction.
- Use `content-visibility: auto` to skip rendering off-screen sections.

## Measuring

Use PageSpeed Insights (field data from CrUX) and Lighthouse (lab data) together. Field data reflects real users and is what Google actually uses for ranking.
