/**
 * BRIEF-UX-002 C5 — hydrate must not lose durable facts to a read-depth cap.
 *
 * Live-verified defect: `RetryIndex.hydrate` read only the newest 1000 `run.launched`
 * entries, so a lineage fact 2,678 launches deep (run.launched 05510ebc,
 * detail.retryOf 01222b4c, in a 14,968-line trail) silently vanished from the DTOs
 * after a daemon restart and the studio chronicle rendered the retry chain as peer
 * episodes. `GuidanceIndex.hydrate` shared the same cap pattern.
 *
 * These tests write the fixture trail directly as JSONL (the exact on-disk format
 * `AuditLog.record` produces) so we can bury the load-bearing entry far deeper than
 * any cap without paying 20k serialized `appendFile`s.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/api/audit.js';
import { RetryIndex } from '../src/api/retry-index.js';
import { GuidanceIndex } from '../src/api/guidance-index.js';

const ACTOR = { id: 'op-1', kind: 'human', trust: 'operator' } as const;

interface FixtureEntry {
  action: string;
  runId: string;
  detail?: Record<string, unknown>;
}

/** Serialize entries in FILE ORDER (index 0 = oldest) with monotonic timestamps. */
function toTrail(entries: FixtureEntry[]): string {
  const base = 1_700_000_000_000;
  return entries
    .map((e, i) =>
      JSON.stringify({
        ts: base + i,
        action: e.action,
        actor: ACTOR,
        runId: e.runId,
        ...(e.detail !== undefined ? { detail: e.detail } : {}),
      }),
    )
    .join('\n');
}

describe('C5 — index hydration reads the trail exhaustively, not capped', () => {
  let dir: string;
  let trailPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crew-hydrate-depth-'));
    trailPath = join(dir, 'audit.log');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('RetryIndex hydrates a lineage entry buried under 2,700 newer launches (the live shape)', async () => {
    const entries: FixtureEntry[] = [
      // The oldest entry is the one that matters — the live defect's shape.
      { action: 'run.launched', runId: '05510ebc', detail: { retryOf: '01222b4c' } },
    ];
    for (let i = 0; i < 2_700; i++) {
      entries.push({ action: 'run.launched', runId: `run-${i}` });
    }
    await writeFile(trailPath, `${toTrail(entries)}\n`, 'utf8');

    const index = new RetryIndex();
    await index.hydrate(new AuditLog(trailPath, () => undefined));

    expect(index.retryOfFor('05510ebc')).toBe('01222b4c');
    expect(index.retryOfFor('run-0')).toBeUndefined(); // non-retries still read as absent
  });

  it('GuidanceIndex hydrates a note buried under 1,500 newer guidance writes', async () => {
    const entries: FixtureEntry[] = [
      { action: 'guidance.set', runId: 'run-deep', detail: { text: 'watch the flaky seat' } },
    ];
    for (let i = 0; i < 1_500; i++) {
      entries.push({ action: 'guidance.set', runId: `run-${i}`, detail: { text: `note ${i}` } });
    }
    await writeFile(trailPath, `${toTrail(entries)}\n`, 'utf8');

    const index = new GuidanceIndex();
    await index.hydrate(new AuditLog(trailPath, () => undefined));

    expect(index.guidanceFor('run-deep')).toBe('watch the flaky seat');
    expect(index.guidanceFor('run-0')).toBe('note 0');
  });

  it('GuidanceIndex supersession still holds across the old cap boundary (a clear is not resurrected)', async () => {
    const entries: FixtureEntry[] = [
      // Old non-empty note, then — 1,200 writes later — a clear. Exhaustive read must
      // NOT let the deep old note win over the newer clear.
      { action: 'guidance.set', runId: 'run-cleared', detail: { text: 'obsolete note' } },
    ];
    for (let i = 0; i < 1_200; i++) {
      entries.push({ action: 'guidance.set', runId: `run-${i}`, detail: { text: `note ${i}` } });
    }
    entries.push({ action: 'guidance.set', runId: 'run-cleared', detail: { text: '' } });
    await writeFile(trailPath, `${toTrail(entries)}\n`, 'utf8');

    const index = new GuidanceIndex();
    await index.hydrate(new AuditLog(trailPath, () => undefined));

    expect(index.guidanceFor('run-cleared')).toBeUndefined();
  });

  it('boot-cost sanity: a 20k-entry trail hydrates both indexes well under 2s', async () => {
    const entries: FixtureEntry[] = [];
    for (let i = 0; i < 20_000; i++) {
      // Mixed trail, lineage + guidance sprinkled throughout, load-bearing facts oldest.
      if (i === 0) {
        entries.push({ action: 'run.launched', runId: 'retry-deep', detail: { retryOf: 'origin-deep' } });
      } else if (i === 1) {
        entries.push({ action: 'guidance.set', runId: 'guided-deep', detail: { text: 'deep note' } });
      } else if (i % 3 === 0) {
        entries.push({ action: 'guidance.set', runId: `run-${i}`, detail: { text: `note ${i}` } });
      } else {
        entries.push({ action: 'run.launched', runId: `run-${i}` });
      }
    }
    await writeFile(trailPath, `${toTrail(entries)}\n`, 'utf8');

    const started = performance.now();
    const retry = new RetryIndex();
    const guidance = new GuidanceIndex();
    await retry.hydrate(new AuditLog(trailPath, () => undefined));
    await guidance.hydrate(new AuditLog(trailPath, () => undefined));
    const elapsedMs = performance.now() - started;

    expect(retry.retryOfFor('retry-deep')).toBe('origin-deep');
    expect(guidance.guidanceFor('guided-deep')).toBe('deep note');
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
