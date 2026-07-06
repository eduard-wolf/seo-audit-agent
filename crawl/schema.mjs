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
  'outlinksExternal',
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
 * A proper RFC 4180 state machine over the WHOLE text: quoted fields may contain
 * commas, escaped quotes (""), AND newlines (\n / \r\n). csvEscape emits such
 * multiline quoted fields (e.g. a title with an embedded newline), so the reader
 * must honour them — splitting on \n first would corrupt resume dedup.
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
export function parseCsv(text) {
  const records = parseRecords(text);
  if (records.length < 2) return [];

  // Skip header record (index 0) — we trust COLS order
  const rows = [];
  for (let r = 1; r < records.length; r++) {
    const fields = records[r];
    // Skip a blank record (a lone empty field — e.g. the trailing newline at EOF)
    if (fields.length === 1 && fields[0] === '') continue;
    const obj = {};
    for (let j = 0; j < COLS.length; j++) {
      obj[COLS[j]] = fields[j] ?? '';
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * Split CSV text into records (arrays of field strings), honouring RFC 4180
 * quoting: a `"`-quoted field may contain `,`, `""` (an escaped quote), and raw
 * newlines. A record boundary is an UNQUOTED \n or \r\n (or lone \r).
 * @param {string} text
 * @returns {string[][]}
 */
function parseRecords(text) {
  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => { endField(); records.push(record); record = []; };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { endField(); i++; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; endRecord(); i++; continue; }
    if (ch === '\n') { endRecord(); i++; continue; }
    field += ch; i++;
  }
  endRecord(); // flush the final field + record
  return records;
}
