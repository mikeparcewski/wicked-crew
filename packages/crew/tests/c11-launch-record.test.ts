// crew-C11 seam B: the run's `run.launched` trail entry is the durable record of what it addresses and what it picked.
//   - crew#1352: the tracker-addresses store is a bounded cache (newest 5,000 runs, a write that can fail). A run it no
//     longer holds reads its addresses from the launch record, and the deliver script's EMBEDDED fallback names them.
//   - crew#1442 item 2: a run whose pick store entry is gone keeps the pick its launch recorded (fail closed).
//   - crew#1367 (P3): a classified upstream HTTP failure keeps its status, so "the server answered HTTP" names it.

import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LOCAL_ACTOR } from '../src/api/auth.js';
import { RunTimingIndex } from '../src/api/run-timing-index.js';
import { RunSourcePicks } from '../src/api/run-sources.js';
import { composeDeliverWorkflow, DELIVER_PHASE_ID } from '../src/core/deliver.js';
import type { AuditEntry } from '../src/core/types.js';
import { upstreamFailure } from '../src/knowledge/trackers/gate-pm.js';
import { TrackerAddresses, type RunAddress } from '../src/knowledge/trackers/addresses.js';
import { trackerGenerationBody } from '../src/knowledge/trackers/projector.js';
import { pickAllows } from '../src/mcp/run-fence.js';
import { classifyUpstreamError } from '../src/mcp/invoke.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const scratch: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'crew-c11-launch-'));
  scratch.push(d);
  return d;
};
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

const JIRA: RunAddress = { trackerId: 'trk_jira_1', source: 'acme-jira', system: 'jira', ref: 'PROJA-1', asked: 'PROJA-1', closing: true };
const GH: RunAddress = { trackerId: 'trk_gh_1', source: 'acme-gh', system: 'github', ref: 'acme/app#42', asked: '#42', closing: true };

function launchEntry(runId: string, ts: number, detail: Record<string, unknown>): AuditEntry {
  return { ts, action: 'run.launched', actor: LOCAL_ACTOR, runId, detail } as AuditEntry;
}

describe('RunTimingIndex: a launch entry carries the run\'s addresses and pick (crew#1352, crew#1442)', () => {
  it('reads them back live and after a restart\'s hydrate, as copies', () => {
    const entry = launchEntry('run-a', 1_000, { projectId: 'proj', repoRef: 'repo', trackerAddresses: [JIRA, GH], sourcePick: ['support-pg'] });
    const live = new RunTimingIndex();
    live.applyLaunchEntry(entry);
    const restarted = new RunTimingIndex();
    restarted.hydrateFromLaunchEntries([entry]);
    for (const idx of [live, restarted]) {
      expect(idx.addressesOf('run-a')).toEqual({ runId: 'run-a', at: 1_000, projectId: 'proj', repoId: 'repo', addresses: [JIRA, GH] });
      expect(idx.sourcePickOf('run-a')).toEqual(['support-pg']);
      expect(idx.sourcePickOf('run-none')).toBeNull();
    }
    // A caller cannot widen the recorded pick or change the recorded addresses.
    live.sourcePickOf('run-a')!.push('billing-pg');
    live.addressesOf('run-a')!.addresses.push(GH);
    expect(live.sourcePickOf('run-a')).toEqual(['support-pg']);
    expect(live.addressesOf('run-a')!.addresses).toHaveLength(2);
  });

  it('keeps nothing it cannot trust: a malformed address list or pick is dropped whole', () => {
    const idx = new RunTimingIndex();
    idx.applyLaunchEntry(launchEntry('run-b', 2_000, { trackerAddresses: [JIRA, { trackerId: 'x', source: 's', system: 'svn', ref: 'r' }], sourcePick: ['Not A Name'] }));
    expect(idx.addressesOf('run-b')).toBeUndefined();
    expect(idx.sourcePickOf('run-b')).toBeNull();
    // An empty pick is a pick.
    idx.applyLaunchEntry(launchEntry('run-c', 3_000, { sourcePick: [] }));
    expect(idx.sourcePickOf('run-c')).toEqual([]);
  });

  it('lists every run with addresses, oldest launch first', () => {
    const idx = new RunTimingIndex();
    idx.applyLaunchEntry(launchEntry('run-late', 9_000, { trackerAddresses: [GH] }));
    idx.applyLaunchEntry(launchEntry('run-early', 1_000, { trackerAddresses: [JIRA] }));
    idx.applyLaunchEntry(launchEntry('run-plain', 5_000, {}));
    expect(idx.allAddresses().map((r) => r.runId)).toEqual(['run-early', 'run-late']);
  });
});

describe('TrackerAddresses: the store is a cache; the launch record lasts the run\'s lifetime (crew#1352)', () => {
  const launched = (runs: Array<{ runId: string; at: number; addresses: RunAddress[] }>) => ({
    of: (runId: string) => {
      const r = runs.find((x) => x.runId === runId);
      return r === undefined ? undefined : { ...r, projectId: 'proj', repoId: 'repo' };
    },
    all: () => runs.map((r) => ({ ...r, projectId: 'proj', repoId: 'repo' })),
  });

  it('a run the cache does not hold (evicted, or its write failed) still reads its addresses (fails before the fix)', async () => {
    const store = new TrackerAddresses(dir(), { launched: launched([{ runId: 'run-old', at: 1, addresses: [JIRA] }]) });
    expect(await store.of('run-old')).toEqual([JIRA]);
    expect(await store.of('run-unknown')).toEqual([]);
  });

  it('the cache wins for a run it holds, and the projection sees both, oldest first, each run once', async () => {
    const d = dir();
    const store = new TrackerAddresses(d, { launched: launched([{ runId: 'run-old', at: Date.parse('2026-01-01T00:00:00Z'), addresses: [JIRA] }, { runId: 'run-new', at: Date.parse('2026-03-01T00:00:00Z'), addresses: [JIRA] }]) });
    await store.record('run-new', [GH], { projectId: 'proj', repoId: 'repo' }, () => Date.parse('2026-03-01T00:00:00Z'));
    expect(await store.of('run-new')).toEqual([GH]);
    expect((await store.all()).map((r) => [r.runId, r.addresses[0]?.ref])).toEqual([['run-old', 'PROJA-1'], ['run-new', 'acme/app#42']]);
  });

  it('an unreadable cache is still an error (never read as "no issues"), unless the launch record holds the run (xreview)', async () => {
    const d = dir();
    writeFileSync(join(d, 'tracker-addresses.json'), '{ not json');
    const store = new TrackerAddresses(d, { launched: launched([{ runId: 'run-held', at: 1, addresses: [JIRA] }]) });
    await expect(store.all()).rejects.toThrow();
    expect(await store.of('run-held')).toEqual([JIRA]);
    await expect(store.of('run-other')).rejects.toThrow();
  });

  it('the projection of a whole history stays bounded per issue: the newest runs, at most 200 links (xreview)', () => {
    const t = { id: 'trk_gh_1', key: 'acme/app', label: 'app', tenant: 'github.com', tenantLabel: null, links: [] };
    const runs = Array.from({ length: 1_000 }, (_, i) => ({ runId: `run-${String(i).padStart(4, '0')}`, projectId: 'proj', repoId: 'repo', addresses: [GH] }));
    const body = trackerGenerationBody({ name: 'acme-gh', system: 'github' }, 'trk_gh_1', t, runs);
    const doc = body.docs.find((x) => x.key === 'issue/acme/app#42')!;
    expect(doc.links!.length).toBeLessThanOrEqual(200);
    // The newest run (last in the list) is drawn; the oldest is not.
    expect(doc.links!.map((l) => l.end.id)).toContain('run:run-0999');
    expect(doc.links!.map((l) => l.end.id)).not.toContain('run:run-0000');
  });
});

describe('RunSourcePicks: a lost store entry keeps the launch record\'s pick (crew#1442 item 2)', () => {
  it('a run whose store file was deleted reads its recorded pick, not "no pick" (fails before the fix)', () => {
    const file = join(dir(), 'mcp', 'run-source-picks.json');
    new RunSourcePicks(file).set('run-p', ['support-pg']);
    rmSync(file);
    const recorded = new Map([['run-p', ['support-pg']]]);
    const picks = new RunSourcePicks(file, (runId) => recorded.get(runId) ?? null);
    expect(picks.get('run-p')).toEqual(['support-pg']);
    picks.get('run-p')!.push('billing-pg');
    expect(picks.get('run-p')).toEqual(['support-pg']);
    // A run with no recorded pick is still "no pick".
    expect(picks.get('run-open')).toBeNull();
  });

  it('a pick the launch record holds cannot be replaced through the store (xreview)', () => {
    const file = join(dir(), 'mcp', 'run-source-picks.json');
    const picks = new RunSourcePicks(file, (runId) => (runId === 'run-r' ? [] : null));
    expect(() => picks.set('run-r', ['web'])).toThrow(/can't change/);
    expect(picks.get('run-r')).toEqual([]);
    // The same pick again is no change.
    expect(() => picks.set('run-r', [])).not.toThrow();
  });

  it('after a failed boot read of the trail, a run of unknown pick fails closed; a run launched since does not (xreview)', () => {
    const idx = new RunTimingIndex();
    idx.markLaunchHistoryUnreadable();
    idx.applyLaunchEntry(launchEntry('run-new', 5, {}));
    idx.applyLaunchEntry(launchEntry('run-new-picked', 6, { sourcePick: ['support-pg'] }));
    const picks = new RunSourcePicks(join(dir(), 'mcp', 'run-source-picks.json'), (runId) => idx.recordedPickOf(runId));
    expect(() => picks.get('run-old')).toThrow(/unknown/);
    expect(pickAllows(picks, 'run-old', 'support-pg')).toBe(false);
    expect(picks.get('run-new')).toBeNull();
    expect(picks.get('run-new-picked')).toEqual(['support-pg']);
    // A new pick is still recorded (the unreadable history is not read as a pick for a new run).
    expect(() => picks.set('run-fresh', ['web'])).not.toThrow();
    // With the history read, an unknown run is simply unpicked.
    expect(new RunTimingIndex().recordedPickOf('run-old')).toBeNull();
  });

  it('the store stays the authority for a run it holds', () => {
    const file = join(dir(), 'mcp', 'run-source-picks.json');
    new RunSourcePicks(file).set('run-q', ['support-pg']);
    // A reader whose launch record says otherwise still answers the store's pick for a run the store holds.
    const picks = new RunSourcePicks(file, () => ['other-pg']);
    expect(picks.get('run-q')).toEqual(['support-pg']);
  });
});

describe('the deliver script\'s embedded fallback names the tracker issues (crew#1352)', () => {
  const feature = BUILTIN_WORKFLOWS.find((w) => w.id === 'feature')!;
  const scriptOf = (trackerRefs?: Array<{ system: 'github' | 'jira'; ref: string; asked?: string }>): string => {
    const composed = composeDeliverWorkflow(feature, 'run-123', 'ship the tracker fix\n\nFixes #42', trackerRefs !== undefined ? { trackerRefs } : {});
    const phase = composed.phases.find((p) => p.id === DELIVER_PHASE_ID)!;
    return (phase.executor as { cmd: string[] }).cmd.join('\n');
  };

  it('a Jira key leads the fallback title and a resolved #N links back as owner/repo#N (fails before the fix)', () => {
    const script = scriptOf([{ system: 'jira', ref: 'PROJA-1', asked: 'PROJA-1' }, { system: 'github', ref: 'acme/app#42', asked: '#42' }]);
    // The title is `<key> <conventional prefix>: <intent>`: the key leads, so a cut at the title's bound never drops it.
    expect(script).toMatch(/\nPROJA-1 [^\n]*ship the tracker fix\n/);
    expect(script).toContain('Fixes acme/app#42');
  });

  it('with no tracker refs the fallback is as before', () => {
    const script = scriptOf();
    expect(script).not.toContain('PROJA-1');
    expect(script).toContain('Fixes #42');
  });
});

describe('a classified upstream HTTP failure keeps its status (crew#1367 P3)', () => {
  it('"the server answered HTTP" names the code after the invoker classified it (fails before the fix)', () => {
    const raw = new StreamableHTTPError(403, 'Forbidden');
    expect(upstreamFailure(raw)).toBe('the server answered HTTP 403');
    // The invoker throws the classified error, not the SDK's: the status must survive that.
    expect(upstreamFailure(classifyUpstreamError(raw))).toBe('the server answered HTTP 403');
    expect(classifyUpstreamError(new StreamableHTTPError(503, 'busy'))).toMatchObject({ errorClass: 'http', retryable: true, status: 503 });
  });
});
