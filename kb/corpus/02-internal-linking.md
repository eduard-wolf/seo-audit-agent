---
source: https://developers.google.com/search/docs/crawling-indexing/links-crawlable
datum: 2025-12-10
---

# Internal Linking Best Practices

## Why Internal Links Matter

Internal links distribute PageRank (link equity) across a website and help search engines discover and understand the hierarchy of your pages. A well-structured internal link graph lets crawlers reach every important page in fewer hops and signals the topical authority of your key pages.

## Anchor Text

Use descriptive anchor text that reflects the target page's primary keyword. Avoid generic anchors such as "click here" or "read more". Over-optimised, exact-match anchor text for every link can look manipulative; vary the phrasing naturally.

## Link Depth

Keep important pages reachable within 3 clicks from the home page. Pages buried 5+ clicks deep receive less crawl attention and lower link equity.

## Orphan Pages

An **orphan page** has no inbound internal links. Even if it is listed in the XML sitemap, Googlebot may crawl it infrequently and rank it poorly. Audit for orphans regularly.

## Hub-and-Spoke Structure

Organise content into topic clusters:
- One **pillar page** covers a topic broadly and links to related **cluster pages**.
- Each cluster page links back to the pillar and to closely related siblings.

This pattern boosts topical relevance signals and keeps link equity within the cluster.

## Common Mistakes

- Linking only from the navigation or footer (editorial body links pass more equity).
- Using the same anchor text for links pointing to *different* pages.
- No-following all internal links (this starves your own pages of equity).
- Redirect chains in internal links (link to the final URL directly).
