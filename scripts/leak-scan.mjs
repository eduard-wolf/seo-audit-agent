#!/usr/bin/env node
/**
 * scripts/leak-scan.mjs — CI Gate: scan git-tracked files for customer data / secrets.
 *
 * Hard-block (exit 1) on:
 *   - confidential client brand(s) — matched by a one-way SHA-256 hash of each word token,
 *     so the plaintext brand is NOT stored in this (public) repo yet an accidental
 *     reintroduction is still caught. Hashing is irreversible: the brand cannot be recovered.
 *   - sk_live_ (Stripe live key)
 *   - AKIA[0-9A-Z]{16} (AWS access key)
 *   - -----BEGIN [A-Z ]* PRIVATE KEY----- (PEM private key)
 *   - ghp_[0-9A-Za-z]{20,} (GitHub classic PAT)
 *   - github_pat_[0-9A-Za-z_]{20,} (GitHub fine-grained PAT)
 *   - AIza[0-9A-Za-z_-]{35} (Google API key — consumed by crux.mjs / safe-browsing.mjs)
 *   - sk-ant-[0-9A-Za-z_-]{20,} (Anthropic API key)
 *   - sk-[0-9A-Za-z]{20,} (OpenAI API key)
 *
 * Warn-only (exit 0):
 *   - Email addresses (may be legitimate in contact docs)
 *
 * Reports file:line for every hit; never prints the secret value itself.
 *
 * Usage: node scripts/leak-scan.mjs
 * The script excludes itself from scanning to avoid false positives on the
 * pattern definitions it contains.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';

// ── Pattern catalogue ─────────────────────────────────────────────────────────

const HARD_PATTERNS = [
  { label: 'sk_live',      re: /sk_live_/,                                             severity: 'error' },
  { label: 'aws-key',      re: /AKIA[0-9A-Z]{16}/,                                    severity: 'error' },
  { label: 'private-key',  re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                  severity: 'error' },
  { label: 'github-pat',   re: /ghp_[0-9A-Za-z]{20,}/,                                severity: 'error' },
  { label: 'github-fine',  re: /github_pat_[0-9A-Za-z_]{20,}/,                        severity: 'error' },
  // Google API key — the format actually consumed by crawl/crux.mjs + crawl/safe-browsing.mjs.
  { label: 'google-key',   re: /AIza[0-9A-Za-z_-]{35}/,                               severity: 'error' },
  { label: 'anthropic-key', re: /sk-ant-[0-9A-Za-z_-]{20,}/,                          severity: 'error' },
  { label: 'openai-key',   re: /sk-[0-9A-Za-z]{20,}/,                                 severity: 'error' },
];

// Warn-only: an email address is not a secret and contact docs legitimately
// contain one — surface it for human review without failing the CI gate.
const WARN_PATTERNS = [
  { label: 'email', re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/, severity: 'warn' },
];

const ALL_PATTERNS = [...HARD_PATTERNS, ...WARN_PATTERNS];

// Confidential brand tokens matched by one-way SHA-256 (lowercased). The plaintext is
// deliberately absent from this repo; a leaked brand is still caught because we hash every
// word token and compare. Irreversible — the hash cannot be turned back into the brand.
//   - client-brand:    the real confidential client brand (plaintext never stored here).
//   - selftest-brand:  a synthetic sentinel so the hashing path stays test-covered.
const HASHED_BRANDS = [
  { label: 'client-brand',   sha256: '196f8248503bd56ac0a15613ffe6fbf337c44c8f730d0c16d0c175449144bb02', severity: 'error' },
  { label: 'selftest-brand', sha256: '184bb40d88a2f6a6cfa7514a2da9071eceb7e1508a6f6862028dc47852e32987', severity: 'error' },
];
const HASHED_BY_DIGEST = new Map(HASHED_BRANDS.map(b => [b.sha256, b]));

/**
 * One-way SHA-256 (lowercased) of a single word token — used to match confidential brands
 * without ever storing their plaintext. Exported so tests can exercise the hashing path.
 * @param {string} token
 * @returns {string} hex digest
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token.toLowerCase()).digest('hex');
}

/**
 * Scan a single block of text for leak patterns.
 *
 * @param {string} filename  — display name (used in output, not for I/O)
 * @param {string} text      — full file content
 * @returns {{ label: string, severity: 'error'|'warn', file: string, line: number }[]}
 */
export function scanText(filename, text) {
  const hits = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    for (const { label, re, severity } of ALL_PATTERNS) {
      if (re.test(lines[i])) {
        hits.push({ label, severity, file: filename, line: lineNo });
      }
    }
    // Confidential-brand check: hash every word token and compare to the known digests.
    if (HASHED_BY_DIGEST.size > 0) {
      for (const token of lines[i].split(/[^A-Za-z0-9]+/)) {
        if (token.length < 3) continue;                 // skip trivial tokens
        const brand = HASHED_BY_DIGEST.get(hashToken(token));
        if (brand) hits.push({ label: brand.label, severity: brand.severity, file: filename, line: lineNo });
      }
    }
  }
  return hits;
}

// ── Gating catalogue (shared by runScan) ──────────────────────────────────────

// Files explicitly excluded from scanning: they contain pattern definitions or
// fixture strings intentionally, so scanning them yields guaranteed false
// positives. Paths are repo-relative (match git ls-files output from repo root).
export const EXCLUDED = new Set([
  'scripts/leak-scan.mjs',     // this script itself (defines the patterns above)
  'test/leak-scan.test.mjs',   // test fixture strings
  'test/example-run.test.mjs', // asserts a denied token is ABSENT from the README
]);

// `py` and `toml` are included so secrets in the optional Python extensions
// (crawl/gsc.py, kb/pgvector_store.py, tests/python/*, pyproject.toml) are covered.
const TEXT_EXT = /\.(mjs|js|ts|py|json|md|yml|yaml|txt|sh|env|cfg|ini|toml|html|css|svg|pem|key|crt)$/i;

/**
 * Pure CLI-scan runner: scan an eligible subset of `files` and return the
 * aggregated hits plus the process exit code. No I/O, argv, or process.exit —
 * the file list and reader are injected so the gating is unit-testable.
 *
 * Gating (identical to the former inline CLI body):
 *   - files in EXCLUDED are skipped
 *   - files whose name does not match TEXT_EXT are skipped
 *   - files that fail to read (readFile throws) are skipped (binary/unreadable)
 *   - exitCode is 1 iff any hit has severity 'error', else 0
 *
 * @param {string[]} files — repo-relative paths (e.g. `git ls-files` output)
 * @param {(file: string) => string} readFile — reads UTF-8 content; may throw
 * @returns {{ hits: { label: string, severity: 'error'|'warn', file: string, line: number }[], exitCode: 0|1 }}
 */
export function runScan(files, readFile) {
  const hits = [];

  for (const file of files) {
    if (EXCLUDED.has(file)) continue;
    if (!TEXT_EXT.test(file)) continue;

    let content;
    try {
      content = readFile(file);
    } catch {
      continue; // binary or unreadable — skip
    }

    hits.push(...scanText(file, content));
  }

  const exitCode = hits.some(h => h.severity === 'error') ? 1 : 0;
  return { hits, exitCode };
}

// ── CLI runner (only executes when run directly) ──────────────────────────────

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  let trackedFiles;
  try {
    trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean);
  } catch (err) {
    console.error('leak-scan: git ls-files failed:', err.message);
    process.exit(2);
  }

  const { hits, exitCode } = runScan(trackedFiles, (f) => readFileSync(f, 'utf8'));

  // Report — never prints the secret value itself, only file:line + pattern label.
  for (const { label, severity, file, line } of hits) {
    const tag = severity === 'error' ? '[ERROR]' : '[WARN] ';
    console.log(`${tag} ${file}:${line}  pattern="${label}"`);
  }

  if (hits.length === 0) {
    console.log('leak-scan: clean — no matches found.');
  }

  process.exit(exitCode);
}
