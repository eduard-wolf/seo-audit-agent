/**
 * crawl/profiles.mjs — Named crawl profiles (Welle 5 C-1.1).
 * loadProfile(name) → a plain opts object suitable for runCrawl/crawl.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../config/crawl-profiles.json'), 'utf8'),
);

/** The CLI default profile (replaces the legacy 200/25-min library default for CLI runs). */
export const DEFAULT_PROFILE = 'standard';

/** All known profile names. */
export const PROFILE_NAMES = Object.keys(PROFILES);

/**
 * Return the crawl-opts for a named profile (maxUrls/maxDepth/rps/concurrency/wallClockMs).
 * The `description` field is NOT included in the returned opts (metadata only).
 * @param {string} name
 * @returns {{maxUrls:number, maxDepth:number, rps:number, concurrency:number, wallClockMs:number}}
 */
export function loadProfile(name) {
  const p = PROFILES[name];
  if (!p) {
    throw new Error(`Unknown crawl profile: "${name}". Known: ${PROFILE_NAMES.join(', ')}`);
  }
  const { description, ...opts } = p;   // strip metadata
  return opts;
}
