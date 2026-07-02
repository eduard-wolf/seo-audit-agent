/**
 * test/fixture-server.test.mjs
 *
 * TDD tests for the fixture server (Deliverable 3).
 * These tests import fixture-server.mjs which does not exist yet → RED.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './fixture-server.mjs';

describe('fixture-server', () => {
  let base;
  let closeServer;

  before(async () => {
    const srv = await startFixtureServer();
    base = srv.baseUrl;
    closeServer = srv.close;
  });

  after(async () => {
    await closeServer();
  });

  it('starts and exposes a baseUrl on 127.0.0.1 with an ephemeral port', () => {
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/,
      'baseUrl must be http://127.0.0.1:<port>');
  });

  it('GET /index.html → 200 with brand marker', async () => {
    const res = await fetch(base + '/index.html');
    assert.equal(res.status, 200, 'index.html must return 200');
    const html = await res.text();
    assert.ok(
      html.includes('Demo Kaffeerösterei'),
      'index.html must contain "Demo Kaffeerösterei"',
    );
  });

  it('GET / → 200 (directory index)', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200, 'root / must return 200');
  });

  it('GET /gone-page.html → 410', async () => {
    const res = await fetch(base + '/gone-page.html', { redirect: 'manual' });
    assert.equal(res.status, 410, 'gone-page.html must return 410 Gone');
  });

  it('GET /notfound-xyz → 404', async () => {
    const res = await fetch(base + '/notfound-xyz');
    assert.equal(res.status, 404, 'unknown path must return 404');
  });

  it('GET /redirect-1 follows 301 chain → /redirect-final.html → 200', async () => {
    const res = await fetch(base + '/redirect-1');
    assert.equal(res.status, 200, 'redirect chain must end with 200');
    const finalPath = new URL(res.url).pathname;
    assert.equal(finalPath, '/redirect-final.html',
      'final URL must be /redirect-final.html');
  });

  it('GET /redirect-1 issues 301 (not followed manually)', async () => {
    const res = await fetch(base + '/redirect-1', { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/redirect-2');
  });

  it('GET /redirect-2 issues 301 to /redirect-final.html (not followed manually)', async () => {
    const res = await fetch(base + '/redirect-2', { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/redirect-final.html');
  });

  it('GET /robots.txt → 200 with correct Content-Type', async () => {
    const res = await fetch(base + '/robots.txt');
    assert.equal(res.status, 200);
    assert.ok(
      res.headers.get('content-type')?.startsWith('text/plain'),
      'robots.txt must have text/plain content-type',
    );
  });

  it('GET /sitemap.xml → 200 with XML Content-Type', async () => {
    const res = await fetch(base + '/sitemap.xml');
    assert.equal(res.status, 200);
    assert.ok(
      res.headers.get('content-type')?.includes('xml'),
      'sitemap.xml must have an XML content-type',
    );
  });

  it('GET /private/secret.html → 200 (server does not enforce robots)', async () => {
    const res = await fetch(base + '/private/secret.html');
    assert.equal(res.status, 200,
      'server must serve private/secret.html; robots enforcement is the crawler\'s job');
  });

  it('close() resolves cleanly and rejects subsequent requests', async () => {
    const tmp = await startFixtureServer();
    await tmp.close();
    let threw = false;
    try {
      await fetch(tmp.baseUrl + '/');
    } catch {
      threw = true;
    }
    assert.ok(threw, 'fetch after close() must throw (connection refused)');
  });
});
