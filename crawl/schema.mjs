/**
 * crawl/schema.mjs — Single source of truth for crawl CSV columns.
 */

export const COLS = [
  'url', 'type', 'status', 'finalUrl', 'redirected', 'redirectChain',
  'title', 'titleLen', 'metaDesc', 'metaDescLen', 'metaMissing', 'canonical',
  'canonSelf', 'robotsMeta', 'htmlLang', 'hreflangCount', 'hreflang',
  'h1', 'h1Count', 'headingOutline', 'ldTypes', 'ldValid', 'ldContextOk', 'hasProduct',
  'hasAgg', 'hasBreadcrumb', 'hasOrg', 'hasOrgSameAs', 'hasFAQ', 'hasAuthor',
  'datePublished', 'dateModified', 'offerPrice', 'availability', 'imgTotal',
  'imgNoAlt', 'imgJpg', 'imgWebp', 'imgAvif', 'outlinksInternal',
  'outlinksAuthoritative', 'wordCount', 'rawWordCount', 'httpsOk', 'mixedContent',
  'error', 'viewportContent', 'charsetOk',
  'ogTitle', 'ogImage', 'ogUrl', 'hasFavicon', 'canonicalCount',
  'imgNoDimensions', 'firstImgLazy',
  'domNodeCount', 'headBlockingScripts', 'headBlockingStyles',
  'genericAnchorCount', 'emptyLinkCount', 'unlabeledControlCount',
  'aggRatingValue', 'aggRatingCount', 'hasShippingDetails', 'hasReturnPolicy', 'hasOrgLogo', 'hasOrgContactPoint',
  'xRobotsTag', 'hstsPresent', 'frameProtection', 'contentEncoding',
  'hreflangLinks',
  'nosniffPresent', 'referrerPolicyPresent', 'permissionsPolicyPresent',
  'cspPresent', 'cookieInsecure', 'versionDisclosure',
  'hasMicrodata', 'hasRdfa', 'resourcePaths',
];

/**
 * Escape a single field value for CSV:
 * - wrap in quotes if it contains comma, double-quote, or newline
 * - double any internal double-quotes
 */
export function csvEscape(value) {
  const str = value == null ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Serialize an object to a CSV row string (fields in COLS order, no trailing newline).
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
export function toCsvRow(obj) {
  return COLS.map(col => csvEscape(obj[col])).join(',');
}

/**
 * Parse CSV text (first line = header = COLS) into an array of plain objects.
 * Handles RFC 4180 quoting (double-quoted fields, escaped quotes as "").
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  // Skip header line (index 0) — we trust COLS order
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const fields = parseFields(line);
    const obj = {};
    for (let j = 0; j < COLS.length; j++) {
      obj[COLS[j]] = fields[j] ?? '';
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * Split a single CSV line into an array of field strings,
 * handling RFC 4180 quoted fields.
 */
function parseFields(line) {
  const fields = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let val = '';
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            val += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          val += line[i++];
        }
      }
      fields.push(val);
      // skip trailing comma
      if (line[i] === ',') i++;
    } else {
      // Unquoted field
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}
