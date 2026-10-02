/**
 * Watch row keys (DES-TRIGGER-REGISTRY-001 §4.5).
 *
 * Every key is `deterministic_key` byte for byte (wicked-core `crate::bus::deterministic_key`,
 * reproduced in `team/key.ts` and pinned there to the DES-TEAMING-002 vectors) over producer-
 * assigned identity only: never content, never a clock. A replay or an at-least-once redelivery
 * therefore resolves to the row already on the bus (the engine's unique index is the dedupe).
 */

import { deterministicKey } from '../team/key.js';
import { WATCH_FINDING_CLEARED, WATCH_FINDING_RAISED } from './events.js';

/** The raised row's key: `["watch", raised, run_id | "-", entry_id, entry_version, subject]`. */
export function raisedKey(runId: string | null, entryId: string, entryVersion: number, subject: string): string {
  return deterministicKey(['watch', WATCH_FINDING_RAISED, runId ?? '-', entryId, String(entryVersion), subject]);
}

/** `watch_id` = `"w-"` + the raised row's key. */
export function watchIdOf(runId: string | null, entryId: string, entryVersion: number, subject: string): string {
  return `w-${raisedKey(runId, entryId, entryVersion, subject)}`;
}

/** The cleared row's key: `["watch", cleared, watch_id, "cleared"]`. One clearing per row. */
export function clearedKey(watchId: string): string {
  return deterministicKey(['watch', WATCH_FINDING_CLEARED, watchId, 'cleared']);
}
