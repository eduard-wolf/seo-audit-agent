/**
 * test/fixture-server.mjs — Dependency-free HTTP fixture server.
 *
 * Serves examples/fixture-site/ as static files with correct Content-Type
 * headers and simulates HTTP behaviours that static files cannot express:
 *
 *   GET /redirect-1        → 301  Location: /redirect-2
 *   GET /redirect-2        → 301  Location: /redirect-final.html
 *   GET /redirect-final.html → 200 (static file)
 *   GET /gone-page.html    → 410
 *   GET /notfound-*        → 404  (any path without a matching static file)
 *
 * The /private/secret.html file IS served (robots enforcement is the
 * crawler's responsibility, not the server's).
 *
 * @module fixture-server
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../examples/fixture-site');

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.avif': 'image/avif',
};

/**
 * Resolve the file-system path for a URL pathname.
 * Returns null if the resolved path escapes FIXTURE_DIR (path-traversal guard).
 *
 * @param {string} urlPathname
 * @returns {string|null}
 */
function resolveStaticPath(urlPathname) {
  // Strip query string / fragment if present
  const pathname = urlPathname.split('?')[0].split('#')[0];

  // Map "/" to "index.html"
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');

  const resolved = path.resolve(FIXTURE_DIR, relative);

  // Path-traversal guard
  if (!resolved.startsWith(FIXTURE_DIR + path.sep) && resolved !== FIXTURE_DIR) {
    return null;
  }
  return resolved;
}

/**
 * Start an ephemeral HTTP fixture server on 127.0.0.1 (port 0 = OS-assigned).
 *
 * @param {{
 *   sitemapMode?:     'index'|'gzip',
 *   robotsBody?:      string,
 *   robotsStatus?:    number,
 *   sitemapUrls?:     string[],
 *   always429Paths?:  string[],
 *   responseHeaders?: Record<string, string>,
 *   compress?:        boolean,
 * }} [opts]
 *   opts.sitemapMode === 'index' — serve a sitemapindex at /sitemap.xml whose
 *   children (/sitemap-a.xml, /sitemap-b.xml) are urlset files with 2 content
 *   locs each. Default (no option) behaviour is byte-identical to before.
 *
 *   opts.sitemapMode === 'gzip' — serve /sitemap.xml as Content-Type:
 *   application/gzip containing a gzip-compressed urlset with 3 content <loc>
 *   entries (g-1.html, g-2.html, g-3.html). The route /sitemap-corrupt.gz is
 *   always available (any sitemapMode) as a corrupt gzip payload.
 *
 *   opts.robotsBody — when set, serve this string as GET /robots.txt
 *   (text/plain; charset=utf-8) instead of the static fixture file.
 *   Coexists with sitemapMode; default (no option) behaviour is byte-identical.
 *
 *   opts.robotsStatus — when set (number), return this HTTP status code for
 *   GET /robots.txt with a short text/plain body. Coexists with sitemapMode.
 *   Takes precedence over robotsBody if both are supplied.
 *
 *   opts.sitemapUrls — when set (string[]), serve a /sitemap.xml urlset whose
 *   <loc> entries are http://<host><path> for each path. Precedence:
 *   sitemapMode==='index' > sitemapUrls > static file.
 *
 *   opts.always429Paths — when set (string[]), any GET to one of these paths
 *   always returns 429 with Retry-After: 0. Used to test 429-throttling logic.
 *
 *   opts.responseHeaders — when set (object), merge its entries into the 200
 *   response headers for static file serves. Useful to inject X-Robots-Tag /
 *   Strict-Transport-Security / X-Frame-Options etc. Default (no option): not merged.
 *
 *   opts.compress — when true, gzip-encode the static file body when the request
 *   Accept-Encoding includes gzip, and send Content-Encoding: gzip + adjusted
 *   Content-Length. Default (false): uncompressed (byte-identical to before).
 *
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
export function startFixtureServer(opts = {}) {
  const { sitemapMode, robotsBody, robotsStatus, sitemapUrls, always429Paths, responseHeaders, compress } = opts;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';

      // ── always429Paths — for politeness / 429-throttling tests (U3.8-5) ──

      if (always429Paths?.includes(url.split('?')[0])) {
        res.writeHead(429, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Retry-After': '0',
        });
        res.end('429 Too Many Requests');
        return;
      }

      // ── sitemapUrls override ──────────────────────────────────────────────

      if (sitemapMode !== 'index' && sitemapUrls != null && url === '/sitemap.xml') {
        const origin = `http://${req.headers.host}`;
        const locs = sitemapUrls.map(p => `  <url><loc>${origin}${p}</loc></url>`).join('\n');
        const body = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          locs,
          '</urlset>',
        ].join('\n');
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(body);
        return;
      }

      // ── sitemapMode === 'gzip' routes ─────────────────────────────────────

      if (sitemapMode === 'gzip' && url === '/sitemap.xml') {
        const origin = `http://${req.headers.host}`;
        const xmlBody = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          `  <url><loc>${origin}/g-1.html</loc></url>`,
          `  <url><loc>${origin}/g-2.html</loc></url>`,
          `  <url><loc>${origin}/g-3.html</loc></url>`,
          '</urlset>',
        ].join('\n');
        const compressed = zlib.gzipSync(Buffer.from(xmlBody, 'utf8'));
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Length': compressed.byteLength,
        });
        res.end(compressed);
        return;
      }

      // ── /sitemap-corrupt.gz — always available ────────────────────────────

      if (url === '/sitemap-corrupt.gz') {
        const corrupt = Buffer.from('not gzip');
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Length': corrupt.byteLength,
        });
        res.end(corrupt);
        return;
      }

      // ── /gzip-big — always available (gzip-bomb bound test, U3.6 fix) ─────
      // Serves a valid gzip whose DECOMPRESSED output (~2 KB) far exceeds any
      // small maxBodyBytes override used in tests. The compressed payload itself
      // is tiny (< 50 B) so readBodyCapped passes — only gunzipSync is bounded.

      if (url === '/gzip-big') {
        const payload = 'x'.repeat(2048); // 2 048 B decompressed, ~30 B compressed
        const compressed = zlib.gzipSync(Buffer.from(payload, 'utf8'));
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Length': compressed.byteLength,
        });
        res.end(compressed);
        return;
      }

      // ── sitemapMode === 'index' routes ────────────────────────────────────

      if (sitemapMode === 'index') {
        if (url === '/sitemap.xml') {
          const origin = `http://${req.headers.host}`;
          const body = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            `  <sitemap><loc>${origin}/sitemap-a.xml</loc></sitemap>`,
            `  <sitemap><loc>${origin}/sitemap-b.xml</loc></sitemap>`,
            '</sitemapindex>',
          ].join('\n');
          res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
          res.end(body);
          return;
        }

        if (url === '/sitemap-a.xml') {
          const body = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            '  <url><loc>http://demo.example/a-1.html</loc></url>',
            '  <url><loc>http://demo.example/a-2.html</loc></url>',
            '</urlset>',
          ].join('\n');
          res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
          res.end(body);
          return;
        }

        if (url === '/sitemap-b.xml') {
          const body = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            '  <url><loc>http://demo.example/b-1.html</loc></url>',
            '  <url><loc>http://demo.example/b-2.html</loc></url>',
            '</urlset>',
          ].join('\n');
          res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
          res.end(body);
          return;
        }
      }

      // ── robotsStatus override ─────────────────────────────────────────────

      if (robotsStatus != null && url === '/robots.txt') {
        res.writeHead(robotsStatus, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`${robotsStatus} robots.txt override`);
        return;
      }

      // ── robotsBody override ───────────────────────────────────────────────

      if (robotsBody != null && url === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(robotsBody);
        return;
      }

      // ── Special routes ────────────────────────────────────────────────────

      if (url === '/redirect-1') {
        res.writeHead(301, { 'Location': '/redirect-2' });
        res.end();
        return;
      }

      if (url === '/redirect-2') {
        res.writeHead(301, { 'Location': '/redirect-final.html' });
        res.end();
        return;
      }

      // Redirect chain longer than MAX_REDIRECTS (5) — used to test
      // too-many-redirects error handling in politeFetch.
      // /redirect-deep-1 → /redirect-deep-2 → … → /redirect-deep-6 (6 hops)
      for (let i = 1; i <= 6; i++) {
        if (url === `/redirect-deep-${i}`) {
          res.writeHead(301, { 'Location': `/redirect-deep-${i + 1}` });
          res.end();
          return;
        }
      }

      if (url === '/gone-page.html') {
        res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('410 Gone');
        return;
      }

      // Slow-drip body: headers arrive immediately, body trickles (or never completes).
      // Used to test that the AbortController timer stays armed during body read.
      if (url === '/slow-body') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.write('<html><body>partial');
        // Fallback timer ends the response after 2 s — but client aborts first in tests.
        const t = setTimeout(() => { try { res.end('</body></html>'); } catch {} }, 2000);
        res.on('close', () => clearTimeout(t));
        return;
      }

      // Broken redirect: malformed Location (unclosed IPv6 literal) — new URL() throws
      if (url === '/redirect-broken') {
        res.writeHead(301, { 'Location': 'http://[::1' });
        res.end();
        return;
      }

      // SSRF redirect to cloud-metadata endpoint (different host than 127.0.0.1)
      if (url === '/redirect-ssrf') {
        res.writeHead(301, { 'Location': 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }

      // SSRF redirect to RFC-1918 private address
      if (url === '/redirect-rfc1918') {
        res.writeHead(301, { 'Location': 'http://10.0.0.1/' });
        res.end();
        return;
      }

      // SSRF redirect to a bracketed-IPv6 loopback literal (new URL().hostname
      // yields the bracketed form) — must be blocked by the SSRF guard.
      if (url === '/redirect-ipv6-loopback') {
        res.writeHead(301, { 'Location': 'http://[::1]/' });
        res.end();
        return;
      }

      // ── Static file serving ───────────────────────────────────────────────

      const filePath = resolveStaticPath(url);

      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('400 Bad Request');
        return;
      }

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }

      if (!stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

      let body;
      try {
        body = fs.readFileSync(filePath);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error');
        return;
      }

      // opts.compress: gzip the body when client accepts gzip
      let responseBody = body;
      const extraHeaders = {};
      if (compress) {
        const acceptEncoding = req.headers['accept-encoding'] ?? '';
        if (/\bgzip\b/i.test(acceptEncoding)) {
          responseBody = zlib.gzipSync(body);
          extraHeaders['Content-Encoding'] = 'gzip';
        }
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': responseBody.byteLength,
        ...extraHeaders,
        ...(responseHeaders ?? {}),
      });
      res.end(responseBody);
    });

    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      /**
       * Gracefully shut down the server.
       * @returns {Promise<void>}
       */
      function close() {
        return new Promise((res, rej) => {
          server.close((err) => (err ? rej(err) : res()));
        });
      }

      resolve({ baseUrl, close });
    });
  });
}
