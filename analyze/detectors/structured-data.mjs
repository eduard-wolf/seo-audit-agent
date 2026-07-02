/**
 * analyze/detectors/structured-data.mjs — detectors for config/rules/structured-data.json.
 *
 * Split out of analyze/engine.mjs verbatim (behaviour-neutral). Each entry is
 * [id, detector]; engine.mjs imports `detectors` and registers them into the registry.
 */

import { normalizeUrl } from '../../crawl/linkgraph.mjs';
import { contentRows, ARTICLE_TYPES } from './_shared.mjs';

export const detectors = [

// schema:invalid — ldValid=0 (at least one JSON-LD block has a parse error)
['schema:invalid', (ctx) => {
  const rows     = contentRows(ctx.rows);
  const affected = rows.filter(r => r.ldValid === '0');
  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// schema:product-no-aggregate — hasProduct=1 AND hasAgg=0
// Redirect rows excluded via contentRows(): the detector would otherwise flag the redirect
// destination's content (hasProduct/hasAgg) under the original redirect URL — false attribution.
['schema:product-no-aggregate', (ctx) => {
  const affected = contentRows(ctx.rows).filter(
    r => r.hasProduct === '1' && r.hasAgg === '0',
  );
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'AggregateRating nur mit echten, nutzergenerierten Bewertungen ergänzen — fabrizierte/Self-serving Ratings riskieren eine Manual Action',
  };
}],

// schema:no-organization — site-level: no page has hasOrg=1
// GATE (false-positive guard): the hasOrg signal is JSON-LD-only. A site marked up
// in Microdata or RDFa instead of JSON-LD yields hasOrg='0' everywhere, so this
// ABSENCE rule would misfire. Google supports JSON-LD, Microdata AND RDFa equally
// (Search Central — Structured data intro, 2026-06), so suppress the finding when
// any crawled page carries non-JSON-LD structured data.
['schema:no-organization', (ctx) => {
  const hasOrg     = ctx.rows.some(r => r.hasOrg === '1');
  const nonJsonLd  = ctx.rows.some(r => r.hasMicrodata === '1' || r.hasRdfa === '1');
  if (hasOrg || nonJsonLd) return { count: 0, affectedUrls: [], detail: '' };
  return {
    count:        1,
    affectedUrls: [],
    detail:       'Kein Organization-Schema auf der gesamten Site gefunden',
  };
}],

// schema:missing-dates — Article/NewsArticle/BlogPosting LD present but datePublished empty.
// Broadened from exact 'Article' to ARTICLE_TYPES (Article, NewsArticle, BlogPosting) per
// Google's Article structured-data doc. Redirect rows excluded via contentRows(): the parsed
// content (ldTypes/datePublished) from the redirect destination must not be attributed to the
// original redirect URL.
['schema:missing-dates', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    if (!r.ldTypes) return false;
    const types = r.ldTypes.split(',').map(t => t.trim());
    return types.some(t => ARTICLE_TYPES.has(t)) && (!r.datePublished || r.datePublished === '');
  });
  return { count: affected.length, affectedUrls: affected.map(r => r.url), detail: '' };
}],

// schema:org-missing-same-as — pages with Organization JSON-LD that lack sameAs.
// sameAs links the entity to external knowledge bases (Wikidata, Wikipedia, etc.)
// and is essential for knowledge-graph entity disambiguation in AI-powered search.
// Redirect rows excluded via contentRows(): hasOrg/hasOrgSameAs from the destination must not
// be attributed to the redirect source URL.
['schema:org-missing-same-as', (ctx) => {
  const affected = contentRows(ctx.rows).filter(
    r => r.hasOrg === '1' && r.hasOrgSameAs !== '1',
  );
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Organization-Schema ohne sameAs (Entity-Erkennung eingeschränkt)',
  };
}],

// schema:breadcrumb-missing — deep pages (depth >= params.minDepth) without BreadcrumbList schema.
// BreadcrumbList is recommended for Breadcrumb Rich-Result eligibility, not required for indexing.
// Gracefully no-fires when depth data is unavailable (same pattern as links:deep).
// Redirect rows excluded via contentRows(): hasBreadcrumb from the redirect destination must not
// be mis-attributed to the original redirect URL.
['schema:breadcrumb-missing', (ctx, params) => {
  const minDepth   = params?.minDepth ?? 2;
  const depthByUrl = ctx.linkgraph?.depthByUrl ?? {};
  const affected = contentRows(ctx.rows).filter(r => {
    // GATE: hasBreadcrumb is JSON-LD-only — don't claim a missing BreadcrumbList on
    // a page whose structured data is Microdata/RDFa (both Google-supported) instead.
    if (r.hasMicrodata === '1' || r.hasRdfa === '1') return false;
    const d = depthByUrl[normalizeUrl(r.url)];
    if (typeof d !== 'number') return false;        // no depth data → graceful no-fire
    return d >= minDepth && r.hasBreadcrumb !== '1';
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       `Seiten ab Klicktiefe ${minDepth} ohne BreadcrumbList-strukturierte-Daten — Breadcrumb-Rich-Result nicht möglich; Breadcrumbs erleichtern Nutzern und Crawlern die Einordnung`,
  };
}],

// schema:article-no-author — Article/NewsArticle/BlogPosting without author field.
// author is RECOMMENDED by Google for E-E-A-T signals, not required; absence is not a
// schema validation error. Uses ARTICLE_TYPES set.
// Collector limitation: hasAuthor=1 is set only when a Person- or Author-typed JSON-LD node
// is present; author as Organization or plain string gives hasAuthor=0 (Welle-3 signal ext.).
// Redirect rows excluded via contentRows().
['schema:article-no-author', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    if (!r.ldTypes) return false;
    const types = r.ldTypes.split(',').map(t => t.trim());
    return types.some(t => ARTICLE_TYPES.has(t)) && r.hasAuthor !== '1';
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Article/NewsArticle/BlogPosting ohne author-Angabe — author ist von Google empfohlen (nicht erforderlich); fehlende Autorschaft schwächt E-E-A-T-/Vertrauenssignale. Hinweis: author wird nur als Person-/Author-typisierter Knoten erkannt; ein als Organization oder reiner String angegebener author wird (noch) nicht erkannt.',
  };
}],

// schema:offer-no-price — Product pages with Product schema but no price in Offer.
// price IS required by Google for Product Rich-Results and Merchant Listings.
// Collector limitation: only offer.price is read from the crawl signal (offerPrice);
// offer.priceSpecification.price is NOT collected (Welle-3 signal extension).
// Redirect rows excluded via contentRows().
['schema:offer-no-price', (ctx) => {
  const affected = contentRows(ctx.rows).filter(
    r => r.hasProduct === '1' && (r.offerPrice ?? '').trim() === '',
  );
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Produktseite mit Product-Schema, aber ohne price im Offer — Google verlangt einen Preis für Produkt-Rich-Results und Merchant-Listings. Hinweis: erkannt wird derzeit nur ein direkter offer.price; priceSpecification.price wird (noch) nicht ausgewertet.',
  };
}],

// schema:date-inconsistent — dateModified is before datePublished (logically impossible).
// This is a LOGICAL data-integrity check, not a schema.org validation violation.
// Date.parse(isoString) is deterministic (does not read the clock).
// Redirect rows excluded via contentRows().
['schema:date-inconsistent', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => {
    if (!r.datePublished || !r.dateModified) return false;     // need both
    const pub = Date.parse(r.datePublished);
    const mod = Date.parse(r.dateModified);
    if (isNaN(pub) || isNaN(mod)) return false;                // unparseable → skip
    return mod < pub;                                          // modified before published = impossible
  });
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'dateModified liegt zeitlich vor datePublished — logisch unmöglich; Datenqualitäts-/Konsistenzfehler im Schema',
  };
}],

// schema:aggregaterating-incomplete — AggregateRating present (hasAgg=1) but ratingValue
// and/or ratingCount|reviewCount missing. Disjoint from schema:product-no-aggregate, which
// fires when hasAgg=0. Redirect rows excluded via contentRows().
['schema:aggregaterating-incomplete', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r =>
    r.hasAgg === '1' && ((r.aggRatingValue ?? '') === '' || (r.aggRatingCount ?? '') === ''));
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'AggregateRating ohne ratingValue und/oder ohne ratingCount|reviewCount — Google verlangt beide für Sterne-Rich-Results; unvollständig ⇒ die Bewertung wird nicht als Sterne-Snippet angezeigt. Rich-Result-Eligibility, KEIN Ranking-Signal.',
  };
}],

// schema:merchant-shipping-returns — Product page (hasProduct=1) whose Offer lacks
// shippingDetails and/or hasMerchantReturnPolicy. Both are RECOMMENDED by Google for
// Merchant Listing experiences; absence omits shipping/return annotations only.
// Merchant Center note: shipping/return data can be supplied via Merchant Center instead.
// Redirect rows excluded via contentRows().
['schema:merchant-shipping-returns', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r =>
    r.hasProduct === '1' && (r.hasShippingDetails !== '1' || r.hasReturnPolicy !== '1'));
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Product/Offer ohne shippingDetails und/oder hasMerchantReturnPolicy. Diese Properties sind für Merchant-Listing-Erlebnisse EMPFOHLEN (nicht erforderlich) — ihr Fehlen unterbindet nur die Versand-/Rückgabe-Annotationen im Rich Result, das Produktergebnis bleibt gültig. Hinweis: Versand-/Rückgabe-Angaben können alternativ im Google Merchant Center hinterlegt werden — Fehlen im Markup bedeutet daher nicht zwingend fehlende Angabe. KEIN Ranking-Signal.',
  };
}],

// schema:organization-logo — Organization present (hasOrg=1) but no logo property found.
// logo is a RECOMMENDED Organization property used by Google for logo in search results
// and Knowledge Panel. Rich-Result-/Knowledge-Panel-Eligibility, NOT a ranking signal.
// Redirect rows excluded via contentRows().
['schema:organization-logo', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => r.hasOrg === '1' && r.hasOrgLogo !== '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Organization-Markup ohne logo-Property. logo ist eine empfohlene Organization-Property — Google nutzt sie für das Logo in Suchergebnissen und im Knowledge Panel. Rich-Result-/Knowledge-Panel-Eligibility, KEIN Ranking-Signal.',
  };
}],

// schema:organization-contact — Organization present (hasOrg=1) but no contactPoint found.
// contactPoint is a RECOMMENDED Organization property; enriches Google's entity understanding
// and Knowledge Panel profile. Knowledge-Panel-Eligibility/Entity-Disambiguation, NOT ranking.
// Redirect rows excluded via contentRows().
['schema:organization-contact', (ctx, params) => {
  const affected = contentRows(ctx.rows).filter(r => r.hasOrg === '1' && r.hasOrgContactPoint !== '1');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Organization-Markup ohne contactPoint-Property. contactPoint ist eine empfohlene Organization-Property — sie reichert Googles Entity-Verständnis und das Knowledge-Panel-Profil an. Knowledge-Panel-Eligibility/Entity-Disambiguierung, KEIN Ranking-Signal.',
  };
}],

// schema:microdata-only — informational nudge: a page carries Microdata/RDFa
// structured data but NO JSON-LD (ldTypes empty). This is explicitly NOT a defect —
// Google supports all three formats — but JSON-LD is Google's recommended format
// (easier to maintain, bundleable in <head>, less error-prone). severity niedrig.
// Redirect/js-guard rows excluded via contentRows().
['schema:microdata-only', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r =>
    (r.hasMicrodata === '1' || r.hasRdfa === '1') && (r.ldTypes ?? '') === '');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Microdata/RDFa-Markup erkannt, aber kein JSON-LD. Google unterstützt JSON-LD, Microdata UND RDFa gleichwertig — dies ist KEIN Defekt. JSON-LD wird von Google jedoch empfohlen (leichter zu pflegen, im <head> bündelbar, weniger fehleranfällig). Optionaler Hinweis, keine Pflicht.',
  };
}],

// schema:context-invalid — a page has PARSEABLE JSON-LD, but a top-level object is missing a
// schema.org @context (absent or pointing elsewhere). Without a schema.org @context Google cannot
// map the markup to schema.org types, so the structured data is silently ineligible for rich
// results. Rich-result ELIGIBILITY, NOT a ranking factor. Derived from the parse-time ldContextOk
// column ('' = no JSON-LD → not applicable, 1 = ok, 0 = a parseable block lacks a schema.org
// @context). Redirect/js-guard rows excluded via contentRows().
['schema:context-invalid', (ctx) => {
  const affected = contentRows(ctx.rows).filter(r => r.ldContextOk === '0');
  return {
    count:        affected.length,
    affectedUrls: affected.map(r => r.url),
    detail:       'Die Seite enthält parsebares JSON-LD, aber mindestens ein Objekt hat kein schema.org-@context (fehlt oder zeigt woanders hin). Ohne schema.org-@context kann Google das Markup keinen schema.org-Typen zuordnen — die strukturierten Daten sind still nicht rich-result-fähig. Rich-Result-Eligibility, KEIN Ranking-Faktor.',
  };
}],

];
