/**
 * analyze/detectors/geo.mjs — detectors for config/rules/geo.json.
 *
 * Split out of analyze/engine.mjs verbatim (behaviour-neutral). Each entry is
 * [id, detector]; engine.mjs imports `detectors` and registers them into the registry.
 */

import { contentRows, ARTICLE_TYPES } from './_shared.mjs';

export const detectors = [

// geo:ai-bot-blocked — site-level: any known AI bot has Disallow: / in robots.txt.
// Consequence depends on bot kategorie:
//   training   → training-blocked
//   ai-search  → ai-search-blocked   (most urgent: kills ChatGPT/Perplexity citations)
//   indexing   → indexing-blocked
['geo:ai-bot-blocked', (ctx) => {
  const blocked = (ctx.signals.robots?.aiBots ?? [])
    .filter(b => b.disallowAll && b.kategorie !== 'on-demand-fetcher');
  if (blocked.length === 0) return { count: 0, affectedUrls: [], detail: '' };

  const CONSEQUENCE = {
    'training':  'training-blocked',
    'ai-search': 'ai-search-blocked',
    'indexing':  'indexing-blocked',
  };
  const details = blocked.map(b => {
    const c = CONSEQUENCE[b.kategorie] ?? b.kategorie;
    return `${b.agent} (${c})`;
  });
  return {
    count:        blocked.length,
    affectedUrls: [],
    detail:       details.join('; '),
  };
}],

// geo:llms-txt-malformed — llms.txt missing OR structurally invalid (per https://llmstxt.org):
//   must start with "# " (H1) and contain at least one "> " blockquote summary.
['geo:llms-txt-malformed', (ctx) => {
  const llms = ctx.signals.llms;
  // No llms object in signals → can't evaluate → skip (treat as positive)
  if (!llms) return { count: 0, affectedUrls: [], detail: '' };
  // File exists and is valid → positive
  if (llms.exists && llms.valid) return { count: 0, affectedUrls: [], detail: '' };

  const detail = !llms.exists
    ? 'llms.txt nicht gefunden'
    : `llms.txt ungültig: ${(llms.problems ?? []).join('; ')}`;
  return { count: 1, affectedUrls: [], detail };
}],

// geo:missing-citations — substantive content pages with outlinksAuthoritative === 0.
// "Cite Sources" is the single highest-impact GEO lever (+115 % AI visibility,
// arXiv 2311.09735). JS-guard pages excluded via contentRows().
// Only pages with wordCount >= params.minCitationWords (default 80) are evaluated:
// trivial/thin pages (homepage, navigation stubs, landing pages) rarely make
// verifiable claims and would inflate the finding count without actionable value.
['geo:missing-citations', (ctx, params) => {
  const minWords = (params && params.minCitationWords != null) ? params.minCitationWords : 80;
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => {
    const wc = parseInt(r.wordCount, 10);
    if (isNaN(wc) || wc < minWords) return false;
    // Flag only pages with NO external outlinks at all — a page that cites any
    // off-site source (authoritative or not) is making an effort to attribute,
    // so flagging it on the narrower "no authoritative domain" test was a false
    // positive. outlinksExternal counts every cross-origin <a href>.
    const ext = parseInt(r.outlinksExternal, 10);
    return !isNaN(ext) && ext === 0;
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Substanzielle Seiten ohne jegliche externe Quellenangabe (kein Outlink zu einer anderen Domain). "Cite Sources" ist der stärkste GEO-Hebel für KI-Sichtbarkeit.',
  };
}],

// geo:no-faq-howto — site-level: no page has FAQPage or HowTo JSON-LD.
// Structured Q&A schemas increase GEO answer-surface significantly.
['geo:no-faq-howto', (ctx) => {
  const hasFaqOrHowTo = ctx.rows.some(r => {
    if (!r.ldTypes) return false;
    const types = r.ldTypes.split(',').map(t => t.trim());
    return types.includes('FAQPage') || types.includes('HowTo');
  });
  if (hasFaqOrHowTo) return { count: 0, affectedUrls: [], detail: '' };
  return {
    count:        1,
    affectedUrls: [],
    detail:       'Kein FAQPage-/HowTo-Schema (strukturierte Q&A für AI-Antwort-Surfaces) auf der gesamten Site gefunden',
  };
}],

// geo:ai-snippet-suppressed — pages whose robots meta contains a snippet-suppressing directive
// that ALSO suppresses AI-answer eligibility: nosnippet OR max-snippet:0.
// max-image-preview:none is intentionally NOT matched — verified against Google's robots-meta
// spec (2026-03): it only suppresses image previews and has NO documented AI-text impact;
// including it would overclaim.
['geo:ai-snippet-suppressed', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    const m = (r.robotsMeta ?? '').toLowerCase();
    // nosnippet OR max-snippet:0 — both block use as input for AI Overviews / AI Mode.
    // max-image-preview:none is intentionally NOT matched (image-preview only, no AI-text impact).
    return /\bnosnippet\b/.test(m) || /\bmax-snippet\s*:\s*0(?!\d)/.test(m);
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url),
    detail: 'robots-meta enthält nosnippet oder max-snippet:0 — Google nutzt den Inhalt dann nicht als Eingabe für AI Overviews/AI Mode (und zeigt kein Text-Snippet); bei indexierten Seiten verschenkt das KI-Sichtbarkeit. max-image-preview:none betrifft nur Bild-Vorschauen und ist hier bewusst nicht erfasst.' };
}],

// geo:noimageindex — robots meta contains noimageindex, opting this page's images out of
// Google Images / image results. Derived from the already-collected robotsMeta column (zero new
// extraction). Visibility/Eligibility opt-out (fewer image-search entry points, weaker visual
// presence in AI answers with image previews), NOT a ranking factor. Redirect/js-guard rows
// excluded via contentRows().
['geo:noimageindex', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => /\bnoimageindex\b/.test((r.robotsMeta ?? '').toLowerCase()));
  return { count: affected.length, affectedUrls: affected.map(r => r.url),
    detail: 'robots-meta enthält noimageindex — die Bilder dieser Seite werden aus Google Images / den Bild-Ergebnissen ausgeschlossen. Das reduziert visuelle Sichtbarkeits-Einstiegspunkte (auch in KI-Antworten mit Bild-Vorschau). Eligibility-Opt-out, KEIN Ranking-Faktor.' };
}],

// geo:content-stale — article-like pages missing dateModified.
// Deterministic presence-check of the recency signal (NOT wall-clock age — that would be
// non-deterministic and would overclaim, since freshness is query-dependent (QDF), not a
// universal ranking signal). Flags article-like pages missing dateModified only.
// Reuses module-scope ARTICLE_TYPES set (Article, NewsArticle, BlogPosting).
['geo:content-stale', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    if (!r.ldTypes) return false;
    const types = r.ldTypes.split(',').map(t => t.trim());
    return types.some(t => ARTICLE_TYPES.has(t)) && (r.dateModified ?? '').trim() === '';
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url),
    detail: 'Article/NewsArticle/BlogPosting ohne dateModified — Google fehlt damit präzise Aktualitäts-Information; Freshness wirkt bei Google query-abhängig (Query-Deserves-Freshness), ist KEIN universelles Ranking-Signal. dateModified ist empfohlen, nicht erforderlich.' };
}],

// geo:ai-user-fetcher-blocked — an on-demand AI fetcher (user-triggered live retrieval) is disallowed in
// robots.txt (site-wide or per-path). Unlike a training-crawler opt-out, this prevents the AI assistant
// from loading + citing the CURRENT page when a user asks. Blocking is a legitimate publisher choice →
// neutral intent question, NOT a defect. NOT a ranking signal.
['geo:ai-user-fetcher-blocked', (ctx) => {
  const fetchers = (ctx.signals.robots?.aiBots ?? [])
    .filter(b => b.kategorie === 'on-demand-fetcher' && (b.disallowAll || (b.disallowPaths ?? []).length > 0));
  if (fetchers.length === 0) return { count: 0, affectedUrls: [], detail: '' };
  const parts = fetchers.map(b => {
    const scope = b.disallowAll ? 'die gesamte Site (Disallow: /)' : `Pfade: ${(b.disallowPaths ?? []).join(', ')}`;
    return `${b.agent} (${b.operator ?? 'On-Demand-Fetcher'}) — gesperrt für ${scope}`;
  });
  return {
    count: fetchers.length,
    affectedUrls: [],
    detail: `On-Demand-Fetcher in robots.txt gesperrt: ${parts.join('; ')}. On-Demand-Fetcher rufen Seiteninhalte LIVE ab, wenn Nutzende den KI-Assistenten danach fragen — eine Sperre verhindert, dass der Assistent den aktuellen Inhalt laden und zitieren kann (anders als ein Training-Crawler-Opt-out, das nur künftiges Training betrifft). Ist die Sperre beabsichtigt, besteht kein Handlungsbedarf. Hinweis: manche On-Demand-Fetcher (z. B. ChatGPT-User, Perplexity-User) ignorieren robots.txt bei nutzer-initiierten Abrufen — die Sperre greift dann ggf. nicht. KEIN Ranking-Signal.`,
  };
}],

// geo:poor-chunkability — a long page (> minWords) with at most maxHeadings headings (essentially no
// sub-structure). AI/RAG retrievers use headings as semantic chunk anchors; without them, chunking falls
// back to character splitting → worse AI extractability/citation. STRUCTURE heuristic only (practitioner
// evidence, not a Google spec). NOT a Google ranking signal, NOT a word-count-quality claim.
['geo:poor-chunkability', (ctx, params) => {
  const minWords    = params?.minWords    ?? 900;
  const maxHeadings = params?.maxHeadings ?? 1;
  const affected = contentRows(ctx.rows).filter(r => {
    const wc = parseInt(r.wordCount, 10);
    if (isNaN(wc) || wc <= minWords) return false;
    const headingCount = (r.headingOutline ?? '').split(',').filter(Boolean).length;
    return headingCount <= maxHeadings;
  });
  return {
    count: affected.length,
    affectedUrls: affected.map(r => r.url),
    detail: 'Lange Seite ohne Zwischenüberschriften (H2/H3): KI-Retriever und RAG-Systeme nutzen Überschriften als strukturelle Segmentierungs-Anker. Fehlt jede Untergliederung, fällt das Chunking auf zeichenbasiertes Splitting zurück — das erhöht das Risiko von Themenüberlagerung und schlechterer Zitierbarkeit durch KI-Systeme. KEIN Google-Ranking-Signal, KEIN Wortzahl-Qualitätshinweis; rein struktureller Hinweis für KI-Extrahierbarkeit (Praktiker-Evidenz) — manuelle Prüfung empfohlen.',
  };
}],

];
