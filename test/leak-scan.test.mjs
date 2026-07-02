import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, runScan, EXCLUDED } from '../scripts/leak-scan.mjs';

describe('scanText', () => {
  it('returns no hits for clean text', () => {
    const hits = scanText('README.md', 'This is a perfectly clean README with no secrets.');
    assert.deepEqual(hits, []);
  });

  it('detects a confidential brand via the one-way hash path (synthetic sentinel token)', () => {
    const hits = scanText('notes.txt', 'Client codename leakscanselftestsentinel, campaign Monday.');
    assert.ok(hits.length > 0, 'Expected a hit for the hashed brand token');
    assert.ok(hits.some(h => h.label === 'selftest-brand'), 'Expected a hit with label "selftest-brand"');
  });

  it('the hashed brand path is case-insensitive', () => {
    const hits = scanText('config.json', '{"client": "LEAKSCANSELFTESTSENTINEL"}');
    assert.ok(hits.some(h => h.label === 'selftest-brand'));
  });

  it('detects sk_live_ secret', () => {
    const hits = scanText('env.txt', 'STRIPE_KEY=sk_live_abcdef1234567890');
    assert.ok(hits.some(h => h.label === 'sk_live'));
  });

  it('detects AWS access key', () => {
    const hits = scanText('credentials.txt', 'AKIAIOSFODNN7EXAMPLE12');
    assert.ok(hits.some(h => h.label === 'aws-key'));
  });

  it('detects PEM private key header', () => {
    const hits = scanText('key.pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIEo...\n-----END RSA PRIVATE KEY-----');
    assert.ok(hits.some(h => h.label === 'private-key'));
  });

  it('detects GitHub PAT', () => {
    const hits = scanText('script.sh', 'TOKEN=ghp_abcdefGHIJKLMNOP1234567890');
    assert.ok(hits.some(h => h.label === 'github-pat'));
  });

  it('detects Google API key (AIza + 35 chars) as a hard hit', () => {
    // 35 chars after the AIza prefix — the format crux.mjs / safe-browsing.mjs consume.
    const hits = scanText('config.env', 'GOOGLE_KEY=AIza' + 'B'.repeat(35));
    const hit = hits.find(h => h.label === 'google-key');
    assert.ok(hit, `Expected a google-key hit, got: ${JSON.stringify(hits)}`);
    assert.strictEqual(hit.severity, 'error');
  });

  it('detects Anthropic API key (sk-ant-...) as a hard hit', () => {
    const hits = scanText('config.env', 'ANTHROPIC_API_KEY=sk-ant-' + 'a'.repeat(24));
    const hit = hits.find(h => h.label === 'anthropic-key');
    assert.ok(hit, `Expected an anthropic-key hit, got: ${JSON.stringify(hits)}`);
    assert.strictEqual(hit.severity, 'error');
  });

  it('detects OpenAI API key (sk-...) as a hard hit', () => {
    const hits = scanText('config.env', 'OPENAI_API_KEY=sk-' + 'a'.repeat(40));
    const hit = hits.find(h => h.label === 'openai-key');
    assert.ok(hit, `Expected an openai-key hit, got: ${JSON.stringify(hits)}`);
    assert.strictEqual(hit.severity, 'error');
  });

  it('detects GitHub fine-grained PAT (github_pat_...) as a hard hit', () => {
    const hits = scanText('script.sh', 'TOKEN=github_pat_' + 'A1b2'.repeat(8));
    const hit = hits.find(h => h.label === 'github-fine');
    assert.ok(hit, `Expected a github-fine hit, got: ${JSON.stringify(hits)}`);
    assert.strictEqual(hit.severity, 'error');
  });

  it('detects email address (WARN only)', () => {
    const hits = scanText('contact.txt', 'Send email to user@example.com for details.');
    const emailHits = hits.filter(h => h.label === 'email' && h.severity === 'warn');
    assert.ok(emailHits.length > 0, 'Expected warn-level email hit');
  });

  it('does not flag its own file path (self-exclusion)', () => {
    // scanText is a function-level test — the self-exclusion in the CLI runner
    // (scripts/leak-scan.mjs) prevents the script from scanning itself.
    // Here we verify that the function itself still catches patterns when called
    // directly (exclusion is the CLI runner's responsibility).
    const hits = scanText('some-other-file.md', 'sk_live_testtesttest12345');
    assert.ok(hits.length > 0);
  });

  it('does not produce hits for an empty string', () => {
    const hits = scanText('empty.txt', '');
    assert.deepEqual(hits, []);
  });
});

describe('runScan — CLI gating (file enumeration + EXCLUDED + exit code)', () => {
  // Build a reader over an in-memory file map so no real I/O touches the repo.
  const reader = (files) => (name) => {
    if (!(name in files)) throw new Error(`no such file: ${name}`);
    return files[name];
  };

  it('exitCode 1 when a hard secret is present in a scanned file', () => {
    const files = {
      'src/config.env': 'STRIPE_KEY=sk_live_abcdef1234567890',
      'src/creds.txt':  'AWS=AKIAIOSFODNN7EXAMPLE12',
    };
    const { hits, exitCode } = runScan(Object.keys(files), reader(files));
    assert.strictEqual(exitCode, 1, 'a hard hit must yield exit code 1');
    assert.ok(hits.some(h => h.label === 'sk_live' && h.file === 'src/config.env'));
    assert.ok(hits.some(h => h.label === 'aws-key' && h.file === 'src/creds.txt'));
  });

  it('skips EXCLUDED files even when they contain a hard "hit" → exitCode 0', () => {
    // 'test/leak-scan.test.mjs' is a stable EXCLUDED entry (this very file).
    const excludedName = 'test/leak-scan.test.mjs';
    assert.ok(EXCLUDED.has(excludedName), 'precondition: name must be in the allowlist');
    const files = { [excludedName]: 'STRIPE_KEY=sk_live_shouldbeignored12345' };
    const { hits, exitCode } = runScan(Object.keys(files), reader(files));
    assert.deepEqual(hits, [], 'EXCLUDED file must not be scanned');
    assert.strictEqual(exitCode, 0);
  });

  it('exitCode 0 for a clean file set', () => {
    const files = {
      'README.md':     '# Project\nNothing secret here.',
      'src/index.mjs': 'export const answer = 42;',
    };
    const { hits, exitCode } = runScan(Object.keys(files), reader(files));
    assert.deepEqual(hits, []);
    assert.strictEqual(exitCode, 0);
  });

  it('skips non-text extensions and unreadable files', () => {
    const files = {
      'logo.png':     'AKIAIOSFODNN7EXAMPLE12', // non-text ext → skipped by TEXT_EXT
      'notes.txt':    'clean line',
    };
    // 'ghost.txt' is enumerated but not in the map → readFile throws → skipped.
    const { hits, exitCode } = runScan([...Object.keys(files), 'ghost.txt'], reader(files));
    assert.deepEqual(hits, []);
    assert.strictEqual(exitCode, 0);
  });

  it('a warn-only hit does not raise the exit code', () => {
    const files = { 'contact.txt': 'Reach us at hello@example.com' };
    const { hits, exitCode } = runScan(Object.keys(files), reader(files));
    assert.ok(hits.some(h => h.label === 'email' && h.severity === 'warn'));
    assert.strictEqual(exitCode, 0, 'warn hits must not fail the gate');
  });
});
