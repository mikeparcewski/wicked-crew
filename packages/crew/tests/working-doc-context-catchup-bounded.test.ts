// F35 (rig :7721, crew main fa75086): the daemon died of a JS heap OOM at boot. The context block's start-up sync
// (#1410) visited EVERY held document (139 on the rig), and each visit read every run's view (`run()`: the engine's
// whole-store sessions fold, ~30 MB parsed per caller) and the document through interactive, back to back with no pause,
// while studio's tabs reloaded and polled each parked run's gate (each also a whole-store read). The folds queue on the
// engine's one actor, so every request waited behind them and the parsed copies piled up.
//
// The start-up sync now visits only documents crew's own record says owe the engine a set, and reads which runs are live
// once.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WorkingDocService, contextOwed, type DocBackend, type RunContextBlock, type RunFacts } from '../src/working-doc/service.js';
import { WorkingDocStore, type WorkingDocRecord } from '../src/working-doc/store.js';
import { initialHtml } from '../src/working-doc/sections.js';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const N = 200;

function rig(owed: ReadonlySet<number>, o: { retryMs?: number[]; versionFailures?: number } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'wdf35-')); homes.push(h);
  const store = new WorkingDocStore({ stateHome: h });
  const html = initialHtml('t', { goal: 'Keep /v1 working.' });
  for (let i = 0; i < N; i += 1) {
    const rec: WorkingDocRecord = {
      runId: `run-${i}`, projectId: 'p', docId: `working-run-${i}`, createdAt: 0, steers: [],
      // Crew's seeded Goal on every document; a person's Goal edit on the owed ones (never set on the engine).
      trail: [
        { version: 0, parent: null, author: { kind: 'system', id: 'crew' }, surface: null, sections: ['goal'], at: 0, steerId: null },
        ...(owed.has(i) ? [{ version: 1, parent: 0, author: { kind: 'human' as const, id: 'local' }, surface: null, sections: ['goal' as const], at: 0, steerId: null }] : []),
      ],
    };
    store.put(rec);
  }
  const counts = { run: 0, liveRuns: 0, read: 0, set: 0 };
  const backend: DocBackend = {
    create: async () => ({ head: 0 }),
    read: async () => { counts.read += 1; return { head: 1, html }; },
    readVersion: async () => { if ((o.versionFailures ?? 0) > 0) { o.versionFailures! -= 1; throw new Error('interactive is starting'); } return html; },
    edit: async () => ({ version: 1, parent: 0 }),
  };
  const facts: RunFacts = { title: 't', problem: 'p', projectId: 'p', terminal: false, stepOf: () => null };
  const service = new WorkingDocService({
    store, backend,
    engine: {
      injectWorkerMessage: async () => 'queued',
      supportsRunContext: () => true,
      setRunContext: async (_r: string, ctx: RunContextBlock) => { counts.set += 1; return { version: ctx.version, accepted: true }; },
    },
    // Each call stands for a whole-store read of every run's view.
    run: async () => { counts.run += 1; return facts; },
    liveRuns: async () => { counts.liveRuns += 1; return Array.from({ length: N }, (_, i) => ({ runId: `run-${i}`, createdAt: i })); },
    catchUpGapMs: 0,
    ...(o.retryMs !== undefined ? { contextRetryMs: o.retryMs } : {}),
  });
  return { service, counts };
}

describe('F35: the start-up context sync is bounded by what is owed, not by how many documents there are', () => {
  it('200 documents with none of the person’s context: no run view, no document read, no set', async () => {
    const t = rig(new Set());
    await t.service.contextCatchUp();
    expect(t.counts).toEqual({ run: 0, liveRuns: 0, read: 0, set: 0 });
  });

  it('two documents owe a set among 200: one live-runs read, no per-document run view, two reads and two sets', async () => {
    const t = rig(new Set([7, 150]));
    await t.service.contextCatchUp();
    expect(t.counts).toEqual({ run: 0, liveRuns: 1, read: 2, set: 2 });
  });

  it('what a document owes is read from crew’s record alone', () => {
    const base: WorkingDocRecord = { runId: 'r', projectId: 'p', docId: 'd', createdAt: 0, steers: [], trail: [
      { version: 0, parent: null, author: { kind: 'system', id: 'crew' }, surface: null, sections: ['goal'], at: 0, steerId: null },
      { version: 2, parent: 0, author: { kind: 'human', id: 'local' }, surface: null, sections: ['constraints'], at: 0, steerId: null },
    ] };
    const ctx = { inForce: 2, attempted: 2, sig: 'x', sentVersion: 2, sections: ['constraints' as const], cut: [], at: 1, error: null, seenVersion: null, seenBy: [] };
    expect(contextOwed(base), 'a person’s Constraints never set').toBe(true);
    expect(contextOwed({ ...base, context: ctx }), 'set and taken').toBe(false);
    expect(contextOwed({ ...base, context: { ...ctx, retry: true } }), 'a set owed').toBe(true);
    expect(contextOwed({ ...base, context: { ...ctx, attempted: 3 } }), 'an attempt with no answer recorded').toBe(true);
    expect(contextOwed({ ...base, trail: base.trail.slice(0, 1) }), 'crew’s seeded Goal only').toBe(false);
    const pending = { expectHead: 2, author: { kind: 'human' as const, id: 'local' }, surface: null, at: 0, actor: { id: 'local', kind: 'human' } };
    expect(contextOwed({ ...base, context: ctx, pending: { ...pending, values: { goal: 'G' } } }), 'a person’s Goal write of unknown outcome').toBe(true);
    expect(contextOwed({ ...base, context: ctx, pending: { ...pending, values: { next: 'N' } } }), 'a Next write of unknown outcome').toBe(false);
  });

  it('a person’s Goal write of unknown outcome left by a restart is settled at start-up and its block set', async () => {
    const t = rig(new Set());
    const store = (t.service as unknown as { d: { store: WorkingDocStore } }).d.store;
    store.update('run-9', (r) => { r.pending = { expectHead: 0, author: { kind: 'human', id: 'local' }, surface: null, values: { goal: 'Keep /v1 working.' }, at: 0, actor: { id: 'local', kind: 'human' } }; });
    await t.service.contextCatchUp();
    expect(store.get('run-9')?.pending).toBeNull();
    expect(t.counts.set).toBe(1);
    expect(t.counts.run).toBe(0);
  });

  it('a pending person write whose first reads fail is retried until interactive answers, then its block is set', async () => {
    const t = rig(new Set(), { retryMs: [20, 20, 20], versionFailures: 2 });
    const store = (t.service as unknown as { d: { store: WorkingDocStore } }).d.store;
    store.update('run-9', (r) => { r.pending = { expectHead: 0, author: { kind: 'human', id: 'local' }, surface: null, values: { goal: 'Keep /v1 working.' }, at: 0, actor: { id: 'local', kind: 'human' } }; });
    await t.service.contextCatchUp();
    expect(t.counts.set, 'not yet: interactive did not answer').toBe(0);
    await new Promise((r) => setTimeout(r, 150));
    expect(store.get('run-9')?.pending).toBeNull();
    expect(t.counts.set).toBe(1);
  });

  it('an owed document whose run is not in the live list (archived) still gets its own check', async () => {
    const t = rig(new Set([5]));
    const svc = t.service as unknown as { d: { liveRuns: () => Promise<Array<{ runId: string; createdAt: number }>> } };
    svc.d.liveRuns = async () => { t.counts.liveRuns += 1; return []; };
    await t.service.contextCatchUp();
    expect(t.counts).toEqual({ run: 1, liveRuns: 1, read: 1, set: 1 });
  });
});
