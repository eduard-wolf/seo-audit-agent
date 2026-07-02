# Legal Disclaimer

## Authorised Use Only

This tool is intended exclusively for auditing **your own websites** or websites for which you have **explicit written authorisation** from the site owner. Using it against third-party sites without such authorisation may:

- Violate the site's **Terms of Service**
- Infringe **database rights** under § 87 UrhG (German Copyright Act) if the crawled content constitutes a protected database
- Constitute **unfair commercial harassment** under § 7 UWG if repeated automated requests cause unreasonable disruption

## Data Protection (DSGVO / GDPR)

- The `data/` directory is **transient and git-ignored**; crawl output must never be committed to version control. It is intended to be short-lived: the operator **MUST delete it after each audit session** by running `npm run clean` (which removes `data/` entirely). This claim matches implemented behaviour — the `clean` script is defined in `package.json`.
- **No personal data** (e-mail addresses, names, user-generated content that could identify individuals) must be persisted beyond the immediate audit session.
- Apply the principle of **data minimisation**: collect only what is technically necessary for the SEO audit.
- If the crawled site processes personal data and you are operating under EU jurisdiction, ensure your use of this tool is covered by an appropriate legal basis under Art. 6 DSGVO.

## Responsible Crawling

- The crawler honours `robots.txt` **Disallow** directives and rate-limits its
  requests (configurable `--rps`); it is designed for **small, polite audit
  crawls**, not large-scale scraping.
- You remain responsible for confirming you are **authorised** to crawl the target
  before running it. When in doubt about authorisation, **stop and ask** the site
  owner.
- The optional strategy phase may trigger **web searches**; no crawled content is
  transmitted to third parties except those requests you knowingly initiate.

## No Warranty / Limitation of Liability

This software is provided **"as is"**, without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement. In no event shall the author be liable for any claim, damages, or other liability arising from or in connection with the software or its use.

The author assumes **no responsibility** for any legal consequences arising from use of this tool contrary to the conditions above.
