// crew#828: GET /watch?run=<id> coverage on an ENDED run never reads "not yet". Three cases:
// (1) still running — the in-progress wording; (2) ended, the entry saw nothing to judge —
// "nothing to check: …"; (3) ended having recorded NO events at all — one block-level line
// (`coverage_summary`), each entry carrying the same reason, never eight contradictions.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreEvent } from '../src/core/types.js';
import { NO_EVIDENCE_REASON, WatchRegistry } from '../src/watch/registry.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let registry: WatchRegistry;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'watch-ended-'));
  registry = new WatchRegistry({
    dbPath: join(dir, 'bus', 'bus.db'),
    settings: async () => undefined,
    projectOf: () => undefined,
    flushMs: 0,
    tickMs: 0,
    pollIntervalMs: 20,
    sleep: async () => undefined,
  });
  await registry.arm();
});

afterEach(async () => {
  await registry.stop();
  removeScratch(dir);
});

const reasons = (cov: ReturnType<WatchRegistry['coverage']>): Record<string, string> =>
  Object.fromEntries(cov.map((c) => [c.entry_id, c.state === 'checked' ? 'checked' : c.reason]));

describe('crew#828 — coverage of an ended run', () => {
  it('(1) a live run keeps the in-progress wording; no facts = unknown = the same', () => {
    expect(registry.armed).toBe(true);
    for (const facts of [{ ended: false, events: null }, null]) {
      const r = reasons(registry.coverage('run-live', facts));
      expect(r['deliver-audit']).toBe('nothing was delivered on this run yet');
      expect(r['what-catches']).toBe('the run has not ended yet');
      expect(registry.feed({ run: 'run-live', runFacts: facts }).coverage_summary).toBeUndefined();
    }
  });

  it('(2) an ended run that recorded events: an entry with nothing to judge says "nothing to check: …"; nothing says "yet"', async () => {
    // The registry saw one governed frame of the run (a gate with nothing ungated).
    registry.offer({ type: 'gateEvaluated', session: 'run-done', ord: 1, ungated: false } as unknown as CoreEvent);
    await registry.flush();
    const r = reasons(registry.coverage('run-done', { ended: true, events: 12 }));
    expect(r['deliver-audit']).toBe('nothing to check: no delivery on this run');
    expect(r['scope-drift']).toBe('nothing to check: no creator floor ran on this run');
    expect(r['risky-call']).toBe('nothing to check: no governed tool call reached a gate on this run');
    expect(r['quiet-after-claim']).toBe('nothing to check: no step handed back on this run');
    expect(r['path-repicked']).toBe('nothing to check: no team path row on this run');
    expect(r['what-catches']).toBe('the run ended while this daemon was not watching it');
    expect(r['ungated']).toBe('checked');
    // An unseen run on the same ended facts gets the ended wording of claim-vs-evidence too.
    expect(reasons(registry.coverage('run-unseen', { ended: true, events: 3 }))['claim-vs-evidence']).toBe('nothing to check: no step ran its checks on this run');
    for (const [id, reason] of Object.entries(r)) expect(reason, id).not.toMatch(/\byet\b/);
    expect(registry.feed({ run: 'run-done', runFacts: { ended: true, events: 12 } }).coverage_summary).toBeUndefined();
  });

  it('(3) an ended run with NO events at all: one block-level line, the same reason on every entry', () => {
    const feed = registry.feed({ run: 'run-old', runFacts: { ended: true, events: 0 } });
    expect(feed.coverage_summary).toEqual({ state: 'no_evidence', reason: NO_EVIDENCE_REASON });
    expect(feed.coverage!.length).toBeGreaterThan(0);
    for (const c of feed.coverage!) expect(c).toEqual({ entry_id: c.entry_id, state: 'not_checked', reason: NO_EVIDENCE_REASON });
    // Events the engine cannot count are unknown, never "none".
    expect(registry.feed({ run: 'run-old', runFacts: { ended: true, events: null } }).coverage_summary).toBeUndefined();
  });
});
