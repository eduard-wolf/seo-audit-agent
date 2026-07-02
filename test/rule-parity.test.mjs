/**
 * test/rule-parity.test.mjs — rule↔detector parity guard.
 *
 * The engine silently skips any config rule whose id has no registered detector
 * (and any registered detector is dead code if no config rule references it).
 * That silent-skip footgun is closed here: we load every config rule id and the
 * registered detector ids and assert they are exactly the same set, with no
 * duplicate ids on either side.
 *
 * Pure, side-effect-free: reads config/rules/*.json via loadRules and the
 * registry snapshot via registeredDetectorIds(). No crawl, no network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, registeredDetectorIds } from '../analyze/engine.mjs';

const RULES_DIR = new URL('../config/rules', import.meta.url).pathname;

describe('rule↔detector parity', () => {
  const rules        = loadRules(RULES_DIR);
  const configIds    = rules.map(r => r.id);
  const detectorIds  = registeredDetectorIds();
  const configSet    = new Set(configIds);
  const detectorSet  = new Set(detectorIds);

  it('no duplicate config rule ids', () => {
    const dupes = configIds.filter((id, i) => configIds.indexOf(id) !== i);
    assert.deepStrictEqual([...new Set(dupes)], [],
      `duplicate config rule ids: ${JSON.stringify([...new Set(dupes)])}`);
    assert.strictEqual(configIds.length, configSet.size,
      'config rule ids must be unique');
  });

  it('no duplicate registered detector ids', () => {
    // The registry is a Map (keys are unique by construction); this guards against
    // a future enumeration that could surface duplicates.
    assert.strictEqual(detectorIds.length, detectorSet.size,
      `duplicate detector ids: ${JSON.stringify(detectorIds.filter((id, i) => detectorIds.indexOf(id) !== i))}`);
  });

  it('every config rule id has a registered detector', () => {
    const missing = configIds.filter(id => !detectorSet.has(id));
    assert.deepStrictEqual(missing, [],
      `config rule ids with NO detector (would be silently skipped): ${JSON.stringify(missing)}`);
  });

  it('every registered detector has a config rule id', () => {
    const orphanDetectors = detectorIds.filter(id => !configSet.has(id));
    assert.deepStrictEqual(orphanDetectors, [],
      `registered detectors with NO config rule (dead code): ${JSON.stringify(orphanDetectors)}`);
  });

  it('config ids and detector ids are exactly the same set (count-agnostic; self-maintaining)', () => {
    assert.strictEqual(configSet.size, detectorSet.size,
      `count mismatch: ${configSet.size} config ids vs ${detectorSet.size} detector ids`);
    assert.deepStrictEqual([...configSet].sort(), [...detectorSet].sort(),
      'config rule id set must equal registered detector id set');
  });
});
