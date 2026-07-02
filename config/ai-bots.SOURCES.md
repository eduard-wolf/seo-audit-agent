# ai-bots.json — provenance & last-verified

Provenance sidecar for `config/ai-bots.json`. That file is a **bare JSON array**
(consumed as an array by `crawl/sitefetch.mjs` and the U6.3 inventory test), so a
`_provenance` key cannot be added without breaking the loader — this sidecar
documents provenance instead.

The bot inventory (agent token → operator → category) is a set of
non-copyrightable facts drawn from each operator's own crawler documentation.
Each operator's official doc is the primary source for the agent tokens and
their declared purpose (training / ai-search / on-demand-fetcher / indexing).

**lastVerified: 2026-07** (all URLs below resolved and named the listed agent
tokens on this date).

| Operator | Agent token(s) in ai-bots.json | Official crawler documentation |
|----------|--------------------------------|--------------------------------|
| OpenAI | GPTBot, OAI-SearchBot, ChatGPT-User | https://developers.openai.com/api/docs/bots |
| Anthropic | ClaudeBot, Claude-SearchBot, Claude-User | https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler |
| Google | Google-Extended, Googlebot | https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers |
| Common Crawl | CCBot | https://commoncrawl.org/ccbot |
| Apple | Applebot-Extended | https://support.apple.com/en-us/119829 |
| Meta | Meta-ExternalAgent, meta-externalfetcher | https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/ |
| Amazon | Amazonbot | https://developer.amazon.com/amazonbot |
| Perplexity | PerplexityBot, Perplexity-User | https://docs.perplexity.ai/docs/resources/perplexity-crawlers |
| Microsoft | Bingbot | https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0 |
| ByteDance | Bytespider | No official operator documentation published (verified 2026-07). ByteDance publishes neither a crawler-doc page nor IP ranges; the `Bytespider` token is attested only via its user-agent string and third-party trackers, and it is widely reported to ignore robots.txt. Token retained as an observed-in-the-wild fact; no upstream URL asserted. |

## Notes

- **Category taxonomy** (`kategorie`): `training`, `ai-search`, `on-demand-fetcher`,
  `indexing` — assigned per each operator's stated purpose for the agent. For
  operators running a multi-tier fleet (OpenAI, Anthropic, Perplexity, Meta), the
  training / search / user-fetch split follows the operator's own doc.
- **Verification method**: each non-ByteDance URL was fetched and confirmed to
  name the listed agent token(s) on the lastVerified date. Bytespider is the sole
  entry without an upstream doc, and is flagged as such rather than given an
  invented URL.
- **When updating** `ai-bots.json`, re-verify the URLs above and bump
  `lastVerified`. Add new agent tokens to the JSON array only (not here first);
  this table mirrors, it does not drive, the loader.
