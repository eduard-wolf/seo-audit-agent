/**
 * test/report-pdf.test.mjs — Unit G addendum: integrated PDF export.
 *
 * Five concerns:
 *   1. Print-CSS    — the inline stylesheet carries the DIN-A4 @page rule,
 *                     print-color-adjust and break-inside guards: the layout
 *                     contract the headless-Chrome print step relies on.
 *   2. Detection    — findChrome(): an explicit pin (--chrome/$CHROME_PATH)
 *                     wins and never silently falls back; platform candidates
 *                     and $PATH scan work; null when nothing exists.
 *   3. Degradation  — CLI without a findable Chrome: exit 0, HTML written,
 *                     loud warning, no report.pdf; --no-pdf skips deliberately;
 *                     a stale report.pdf from an earlier run is always removed.
 *   4. Fake Chrome  — the found-but-failing branches, hermetically via a stub
 *                     binary: print fails → degrade; unclean exit with a
 *                     complete PDF → salvage; "success" without a file → warn.
 *   5. Happy path   — with an installed Chrome: a real vector PDF (magic
 *                     bytes, %%EOF trailer, /Font resources ⇒ selectable
 *                     text). Skipped — not failed — on machines without
 *                     Chrome, mirroring the CLI's own graceful degradation.
 *
 * Isolation: CLI runs use a copy of the example findings re-hosted to
 * pdf-test.example, so this file owns report/pdf-test.example/ exclusively
 * and cannot race test/report.test.mjs over report/example.com.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { render, findChrome, pdfLooksComplete } from '../report/build-report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'report', 'build-report.mjs');
const EXAMPLE = path.join(ROOT, 'examples', 'findings.example.json');
const OUT_DIR = path.join(ROOT, 'report', 'pdf-test.example');
const IS_WINDOWS = process.platform === 'win32';

const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));

// CLI fixture: the example findings re-hosted to a host only this file uses.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'report-pdf-test-'));
const FIXTURE = path.join(TMP, 'findings.pdf-test.json');
{
  const fixture = structuredClone(example);
  fixture.meta.url = 'https://pdf-test.example/';
  fs.writeFileSync(FIXTURE, JSON.stringify(fixture), 'utf8');
}

/** Run the CLI as a child process; returns { status, stdout, stderr }. */
function runCli(args, envOverride = {}) {
  const res = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...envOverride },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/** Write an executable stub "Chrome" shell script (POSIX only). */
function writeFakeChrome(name, script) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Print-CSS — the PDF's layout contract inside the inline stylesheet
// ─────────────────────────────────────────────────────────────────────────────
describe('print stylesheet — DIN-A4 layout contract for the PDF step', () => {
  const html = render(example);
  const printBlock = html.slice(html.indexOf('@media print'));

  it('declares a DIN-A4 @page rule with margins and a running page counter', () => {
    assert.ok(html.includes('@page'), '@page rule present');
    assert.ok(/size:\s*A4/.test(html), 'page size is A4');
    assert.ok(/@page\s*\{[^{]*margin:/s.test(html), '@page sets print margins');
    assert.ok(html.includes('counter(page)') && html.includes('counter(pages)'),
      'margin box renders "page / pages" (Chrome ≥ 131; older engines ignore it)');
  });

  it('keeps the @page margin-box strings static (no interpolated report data)', () => {
    const pageBlock = html.slice(html.indexOf('@page'), html.indexOf('@media print'));
    assert.ok(pageBlock.includes('content: "SEO-Audit-Report"'),
      'the only content string is the fixed report label');
    assert.ok(!pageBlock.includes('example.com'),
      'no untrusted/host data is ever interpolated into CSS');
  });

  it('forces colour printing — severity colours are an information channel', () => {
    assert.ok(/print-color-adjust:\s*exact/.test(printBlock), 'print-color-adjust: exact');
    assert.ok(/-webkit-print-color-adjust:\s*exact/.test(printBlock), 'WebKit alias present');
  });

  it('keeps finding cards and tiles unbroken across page boundaries', () => {
    const avoidRule = printBlock.match(/([^{}]+)\{[^}]*break-inside:\s*avoid/);
    assert.ok(avoidRule, 'a break-inside: avoid rule exists in the print block');
    assert.ok(avoidRule[1].includes('.finding'), 'finding cards are atomic in print');
    assert.ok(avoidRule[1].includes('.tile'), 'summary tiles are atomic in print');
  });

  it('keeps section headings attached to their content (no orphaned titles)', () => {
    assert.ok(/break-after:\s*avoid/.test(printBlock), 'headings carry break-after: avoid');
  });

  it('renders the TOC as a static table of contents (links become plain text)', () => {
    assert.ok(/a\s*\{\s*color:\s*var\(--ink\);\s*text-decoration:\s*none;\s*\}/.test(printBlock),
      'anchors lose link styling in print');
  });

  it('hides the screen-only skip link in print', () => {
    assert.ok(/\.skip-link\s*\{\s*display:\s*none;?\s*\}/.test(printBlock),
      'skip link is hidden in the printed document');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. findChrome — detection and explicit-pin semantics
// ─────────────────────────────────────────────────────────────────────────────
describe('findChrome — detection', () => {
  it('returns an explicit path when it exists', () => {
    assert.equal(findChrome({ explicit: process.execPath }), process.execPath);
  });

  it('an explicit pin that does not exist yields null — never a silent fallback', () => {
    // Real platform + env: even with browsers installed, the pin must win.
    assert.equal(findChrome({ explicit: '/definitiv/nicht/vorhanden/chrome' }), null);
  });

  it('finds a binary via $PATH scan (linux-style)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-path-'));
    try {
      fs.writeFileSync(path.join(dir, 'chromium'), '');
      assert.equal(
        findChrome({ platform: 'linux', env: { PATH: dir } }),
        path.join(dir, 'chromium'),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers google-chrome over chromium on $PATH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-path-'));
    try {
      fs.writeFileSync(path.join(dir, 'chromium'), '');
      fs.writeFileSync(path.join(dir, 'google-chrome'), '');
      assert.equal(
        findChrome({ platform: 'linux', env: { PATH: dir } }),
        path.join(dir, 'google-chrome'),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the Windows install-location candidate via env roots', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-win-'));
    try {
      const exe = path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe');
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, '');
      assert.equal(
        findChrome({ platform: 'win32', env: { PROGRAMFILES: dir, PATH: '' } }),
        exe,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when nothing is installed anywhere', () => {
    assert.equal(findChrome({ platform: 'linux', env: { PATH: '' } }), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b. pdfLooksComplete — the salvage probe
// ─────────────────────────────────────────────────────────────────────────────
describe('pdfLooksComplete — completeness probe', () => {
  const write = (name, content) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, content);
    return p;
  };

  it('accepts a fully flushed PDF (magic + %%EOF trailer)', () => {
    assert.equal(pdfLooksComplete(write('ok.pdf', `%PDF-1.4\n${'x'.repeat(500)}\nstartxref\n42\n%%EOF\n`)), true);
  });

  it('rejects a torso without the %%EOF trailer (killed mid-write)', () => {
    assert.equal(pdfLooksComplete(write('torso.pdf', `%PDF-1.4\n${'x'.repeat(500)}`)), false);
  });

  it('rejects non-PDF content and missing files', () => {
    assert.equal(pdfLooksComplete(write('nope.pdf', 'hello %%EOF')), false);
    assert.equal(pdfLooksComplete(path.join(TMP, 'fehlt.pdf')), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CLI degradation — HTML always ships, exit stays 0
// ─────────────────────────────────────────────────────────────────────────────
describe('CLI — graceful degradation without Chrome', () => {
  after(() => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

  it('unfindable $CHROME_PATH: exit 0, HTML written, loud warning, no PDF', () => {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    const { status, stdout, stderr } = runCli([FIXTURE], { CHROME_PATH: '/definitiv/nicht/da/chrome' });
    assert.equal(status, 0, 'build must not fail because Chrome is missing');
    assert.ok(fs.existsSync(path.join(OUT_DIR, 'index.html')), 'HTML report ships normally');
    assert.ok(stdout.includes(path.join(OUT_DIR, 'index.html')), 'stdout keeps the HTML-path contract');
    assert.ok(!fs.existsSync(path.join(OUT_DIR, 'report.pdf')), 'no PDF is written');
    assert.ok(/WARNUNG/.test(stderr), 'warning is loud');
    assert.ok(/PDF übersprungen/.test(stderr), 'warning names the skipped PDF');
    assert.ok(stderr.includes('/definitiv/nicht/da/chrome'), 'warning names the bad pin');
  });

  it('--no-pdf skips deliberately (no warning tone) and exits 0', () => {
    const { status, stderr } = runCli([FIXTURE, '--no-pdf']);
    assert.equal(status, 0);
    assert.ok(fs.existsSync(path.join(OUT_DIR, 'index.html')), 'HTML written');
    assert.ok(!fs.existsSync(path.join(OUT_DIR, 'report.pdf')), 'no PDF with --no-pdf');
    assert.ok(/übersprungen \(--no-pdf\)/.test(stderr), 'skip is stated');
    assert.ok(!/WARNUNG/.test(stderr), 'a deliberate skip is not a warning');
  });

  it('removes a stale report.pdf so it can never ship next to fresher HTML', () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stale = path.join(OUT_DIR, 'report.pdf');
    fs.writeFileSync(stale, 'veraltetes pdf');
    const { status } = runCli([FIXTURE, '--no-pdf']);
    assert.equal(status, 0);
    assert.ok(!fs.existsSync(stale), 'stale PDF from an earlier run is removed');
  });

  it('an undeletable stale report.pdf degrades to a warning — HTML still ships, exit 0', (t) => {
    if (IS_WINDOWS) return t.skip('chmod-basierter Test — POSIX only');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'report.pdf'), 'veraltetes pdf');
    fs.chmodSync(OUT_DIR, 0o555); // dir read-only → unlink fails with EACCES
    try {
      const { status, stdout, stderr } = runCli([FIXTURE, '--no-pdf']);
      assert.equal(status, 0, 'a locked stale PDF must never abort the build');
      assert.ok(stdout.includes(path.join(OUT_DIR, 'index.html')), 'stdout contract survives');
      assert.ok(/WARNUNG: altes report\.pdf konnte nicht entfernt werden/.test(stderr),
        'the un-removable stale PDF is loudly flagged as possibly outdated');
    } finally {
      fs.chmodSync(OUT_DIR, 0o755);
    }
  });

  it('rejects unknown flags with usage (exit 1)', () => {
    const { status, stderr } = runCli([FIXTURE, '--pdf-bitte']);
    assert.equal(status, 1);
    assert.ok(/Unbekanntes Flag/.test(stderr) && /Usage/.test(stderr));
  });

  it('rejects --chrome without a path (exit 1)', () => {
    const { status, stderr } = runCli([FIXTURE, '--chrome']);
    assert.equal(status, 1);
    assert.ok(/--chrome braucht einen Pfad/.test(stderr));
  });

  it('refuses to eat a following flag as the --chrome path (exit 1)', () => {
    const { status, stderr } = runCli([FIXTURE, '--chrome', '--no-pdf']);
    assert.equal(status, 1, '--chrome --no-pdf is an argument error, not a bogus pin');
    assert.ok(/--chrome braucht einen Pfad/.test(stderr));
  });

  it('rejects an empty --chrome= (exit 1) — no silent fall-through past the pin', () => {
    const { status, stderr } = runCli([FIXTURE, '--chrome='], { CHROME_PATH: '/definitiv/nicht/da/chrome' });
    assert.equal(status, 1, 'empty pin must error like the bare form');
    assert.ok(/--chrome braucht einen Pfad/.test(stderr));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Fake Chrome — found-but-failing branches, hermetic via stub binaries
// ─────────────────────────────────────────────────────────────────────────────
describe('CLI — Chrome found but failing (stub binary, POSIX)', () => {
  after(() => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

  it('print failure degrades: exit 0, HTML ships, loud warning, no PDF', (t) => {
    if (IS_WINDOWS) return t.skip('Shell-Stub — POSIX only');
    const fake = writeFakeChrome('chrome-fails', '#!/bin/sh\nexit 1\n');
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    const { status, stdout, stderr } = runCli([FIXTURE, '--chrome', fake]);
    assert.equal(status, 0, 'a failing Chrome must not fail the build');
    assert.ok(fs.existsSync(path.join(OUT_DIR, 'index.html')), 'HTML ships');
    assert.ok(stdout.includes(path.join(OUT_DIR, 'index.html')), 'stdout contract survives');
    assert.ok(!fs.existsSync(path.join(OUT_DIR, 'report.pdf')), 'no PDF artifact');
    assert.ok(/WARNUNG: PDF-Erzeugung fehlgeschlagen/.test(stderr), 'failure is loud');
  });

  it('salvage: unclean Chrome exit with a complete PDF keeps the artifact + warns', (t) => {
    if (IS_WINDOWS) return t.skip('Shell-Stub — POSIX only');
    const fake = writeFakeChrome('chrome-salvage', [
      '#!/bin/sh',
      'for a in "$@"; do case "$a" in --print-to-pdf=*) out="${a#--print-to-pdf=}";; esac; done',
      'printf \'%%PDF-1.4\\nsalvage-test\\nstartxref\\n0\\n%%%%EOF\\n\' > "$out"',
      'exit 1',
      '',
    ].join('\n'));
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    const { status, stderr } = runCli([FIXTURE, '--chrome', fake]);
    assert.equal(status, 0);
    const pdfPath = path.join(OUT_DIR, 'report.pdf');
    assert.ok(fs.existsSync(pdfPath), 'the complete PDF is kept');
    assert.ok(pdfLooksComplete(pdfPath), 'kept artifact passes the completeness probe');
    assert.ok(/WARNUNG: Chrome beendete sich nicht sauber/.test(stderr), 'salvage is flagged');
    assert.ok(/pdf written:/.test(stderr), 'the salvaged PDF is still reported as written');
  });

  it('a torso PDF (Chrome killed mid-write) is removed — never ships next to fresh HTML', (t) => {
    if (IS_WINDOWS) return t.skip('Shell-Stub — POSIX only');
    const fake = writeFakeChrome('chrome-torso', [
      '#!/bin/sh',
      'for a in "$@"; do case "$a" in --print-to-pdf=*) out="${a#--print-to-pdf=}";; esac; done',
      'printf \'%%PDF-1.4\\nabgebrochen-mitten-im-schreiben\' > "$out"',
      'exit 1',
      '',
    ].join('\n'));
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    const { status, stderr } = runCli([FIXTURE, '--chrome', fake]);
    assert.equal(status, 0, 'degradation, not failure');
    assert.ok(fs.existsSync(path.join(OUT_DIR, 'index.html')), 'HTML ships');
    assert.ok(!fs.existsSync(path.join(OUT_DIR, 'report.pdf')),
      'the incomplete PDF is deleted, not left beside fresh HTML');
    assert.ok(/WARNUNG: PDF-Erzeugung fehlgeschlagen/.test(stderr), 'failure is loud');
  });

  it('"success" without a written file is a loud degradation, not a silent pass', (t) => {
    if (IS_WINDOWS) return t.skip('Shell-Stub — POSIX only');
    const fake = writeFakeChrome('chrome-liar', '#!/bin/sh\nexit 0\n');
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    const { status, stderr } = runCli([FIXTURE, '--chrome', fake]);
    assert.equal(status, 0);
    assert.ok(!fs.existsSync(path.join(OUT_DIR, 'report.pdf')), 'no phantom artifact');
    assert.ok(/WARNUNG: PDF-Erzeugung fehlgeschlagen/.test(stderr), 'failure is loud');
    assert.ok(/nicht geschrieben/.test(stderr), 'the missing file is named');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Happy path — a real vector PDF from an installed Chrome
// ─────────────────────────────────────────────────────────────────────────────
describe('CLI — PDF happy path (skipped without an installed Chrome)', () => {
  // Same resolution the CLI itself uses: $CHROME_PATH pin, else auto-detect.
  const chrome = findChrome({ explicit: process.env.CHROME_PATH || null });

  after(() => {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('writes report/<host>/report.pdf as a real, selectable vector PDF', (t) => {
    if (!chrome) return t.skip('kein Chrome/Chromium installiert — PDF-Happy-Path übersprungen');

    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    let run = runCli([FIXTURE]);
    if (!/pdf written:/.test(run.stderr)) {
      // One retry: a cold-starting Chrome can fail transiently; the CLI then
      // takes its designed degradation path. A repeatable failure stays red.
      run = runCli([FIXTURE]);
    }
    assert.equal(run.status, 0, `CLI failed:\n${run.stderr}`);
    assert.ok(run.stdout.includes(path.join(OUT_DIR, 'index.html')), 'stdout contract unchanged');
    assert.ok(/pdf written:/.test(run.stderr), `stderr reports the written PDF:\n${run.stderr}`);

    const pdfPath = path.join(OUT_DIR, 'report.pdf');
    assert.ok(fs.existsSync(pdfPath), 'report.pdf exists');
    const pdf = fs.readFileSync(pdfPath, 'latin1');
    assert.ok(pdf.startsWith('%PDF-'), 'PDF magic bytes');
    assert.ok(pdfLooksComplete(pdfPath), 'fully flushed (%%EOF trailer)');
    assert.ok(pdf.includes('/Font'), 'embeds fonts — vector text, selectable, no screenshot');
    assert.ok(pdf.length > 20_000, `plausible size, got ${pdf.length} bytes`);
  });
});
