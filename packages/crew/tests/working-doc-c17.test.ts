// The run's context document and its run learnings (map cluster crew-C17):
//  - crew#1392: a person's dock steer (`POST /runs/:id/inject`) shows under Decisions with its words.
//  - crew#1240: the document's times name their zone ("14:05 UTC+1"), and a line crew wrote before it did is replaced,
//    never shown twice.
//  - crew#1409: a write is journaled before interactive is asked, so a daemon that dies between interactive's commit
//    and crew's trail save still attributes the version after a restart (the person's section reaches the block).
//  - crew#1408: the person's Goal, Approach and Constraints are read from the document for the run's learnings.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Actor } from '../src/core/types.js';
import { clock, isGenerated, noteLine, personNotes, reconcileSection, zoneless, type AuditLike } from '../src/working-doc/event-lines.js';
import { PersonNotesIndex } from '../src/working-doc/notes-index.js';
import { UndeterminedWriteError, WorkingDocService, type DocBackend, type RunContextBlock } from '../src/working-doc/service.js';
import { WorkingDocStore } from '../src/working-doc/store.js';

const homes: string[] = [];
const TZ = process.env['TZ'];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  if (TZ === undefined) delete process.env['TZ'];
  else process.env['TZ'] = TZ;
});
const home = (): string => { const h = mkdtempSync(join(tmpdir(), 'wdc17-')); homes.push(h); return h; };

/** interactive, one version list per document. `crash`: the next edit commits its version and never answers (the
 *  daemon died before it heard back). `refuse`: the next edit fails with a known refusal. */
class FakeBackend implements DocBackend {
  docs = new Map<string, Array<{ html: string; author: string }>>();
  crash = false;
  refuse = false;
  moved = false;
  undetermined = false;
  async create(_p: string, docId: string, _r: string, html: string) { this.docs.set(docId, [{ html, author: 'crew' }]); return { head: 0 }; }
  async read(_p: string, docId: string) { const v = this.docs.get(docId); return v === undefined ? null : { head: v.length - 1, html: v.at(-1)!.html }; }
  async readVersion(_p: string, docId: string, n: number) { return this.docs.get(docId)?.[n]?.html ?? null; }
  async edit(_p: string, docId: string, batch: { expectHead: number; items: Array<{ selector: string; value: string }>; author: string }) {
    if (this.refuse) { this.refuse = false; throw new Error('interactive refused the batch'); }
    const v = this.docs.get(docId)!;
    const head = v.length - 1;
    if (batch.expectHead !== head) return { headMoved: true as const, head };
    if (this.moved) { this.moved = false; v.push({ html: v[head]!.html, author: 'someone' }); return { headMoved: true as const, head: head + 1 }; }
    let html = v[head]!.html;
    for (const it of batch.items) {
      const esc = it.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html = html.replace(new RegExp(`(<div\\b[^>]*data-wid="${it.selector}"[^>]*>)[\\s\\S]*?(</div>)`, 'u'), `$1${esc}$2`);
    }
    v.push({ html, author: batch.author });
    if (this.crash) { this.crash = false; return new Promise<never>(() => undefined); }
    if (this.undetermined) { this.undetermined = false; throw new UndeterminedWriteError('no version in time'); }
    return { version: head + 1, parent: head };
  }
}

class FakeEngine {
  calls: RunContextBlock[] = [];
  injected: string[] = [];
  async injectWorkerMessage(_r: string, m: string) { this.injected.push(m); return 'queued'; }
  supportsRunContext() { return true; }
  async setRunContext(_runId: string, ctx: RunContextBlock) { this.calls.push(structuredClone(ctx)); return { version: ctx.version, accepted: true }; }
}

const HUMAN: Actor = { id: 'local', kind: 'human', trust: 'admin' };

function setup(o: { stateHome?: string; backend?: FakeBackend } = {}) {
  const stateHome = o.stateHome ?? home();
  const backend = o.backend ?? new FakeBackend();
  const engine = new FakeEngine();
  const store = new WorkingDocStore({ stateHome });
  let now = 1_000;
  const service = new WorkingDocService({
    store,
    backend,
    engine,
    run: async () => ({ title: 'Fix it', problem: 'Invoice PDFs show $ for EUR accounts.', projectId: 'default', terminal: false, stepOf: () => null }),
    liveRuns: async () => [{ runId: 'run-1', createdAt: 1 }],
    now: () => (now += 1),
    catchUpGapMs: 0,
  });
  const head = () => (backend.docs.get('working-run-1')?.length ?? 0) - 1;
  return { service, backend, engine, store, stateHome, head };
}

describe('crew#1392: a dock steer is a Decisions line with its words', () => {
  const at = Date.UTC(2026, 10, 6, 11, 46);
  it('a person’s inject is “steered” with their words; a worker’s or the system’s is no line', () => {
    const entries: AuditLike[] = [
      { ts: at, action: 'run.injected', runId: 'run-1', actor: { id: 'local', kind: 'human' }, detail: { target: 'all', words: 'Keep the old\n URL working.' } },
      { ts: at + 1, action: 'run.injected', runId: 'run-1', actor: { id: 'worker-1', kind: 'agent' }, detail: { target: 'all', words: 'from a worker' } },
      { ts: at + 2, action: 'run.injected', runId: 'run-1', actor: { id: 'crew', kind: 'system' }, detail: { target: 'all', words: 'from crew' } },
      // An entry from before the words were recorded makes no line (nothing to show).
      { ts: at + 3, action: 'run.injected', runId: 'run-1', actor: { id: 'local', kind: 'human' }, detail: { target: 'all' } },
    ];
    const notes = personNotes(entries);
    expect(notes).toEqual([{ at, who: 'You', verb: 'steered', subject: null, words: 'Keep the old URL working.' }]);
    const line = noteLine(notes[0]!);
    expect(line).toBe(`You · ${clock(at)} · steered: “Keep the old URL working.”`);
    expect(isGenerated('decisions', line)).toBe(true);
    // The live index takes it (and so nudges the run's document).
    expect(new PersonNotesIndex().add(entries[0]!)).toBeNull(); // not hydrated yet: it waits
    const idx = new PersonNotesIndex();
    idx.hydrate([]);
    expect(idx.add(entries[0]!)).toBe('run-1');
    expect(idx.add(entries[1]!)).toBeNull();
  });
});

describe('crew#1240: times name their zone', () => {
  const t = Date.UTC(2026, 0, 15, 10, 0);
  it('the daemon’s offset from UTC, at the time written', () => {
    process.env['TZ'] = 'UTC';
    expect(clock(t)).toBe('10:00 UTC');
    process.env['TZ'] = 'Asia/Kolkata';
    expect(clock(t)).toBe('15:30 UTC+5:30');
    process.env['TZ'] = 'America/New_York';
    expect(clock(t)).toBe('05:00 UTC-5');
    // Summer time: the offset in force then.
    expect(clock(Date.UTC(2026, 6, 15, 10, 0))).toBe('06:00 UTC-4');
  });

  it('zoned lines are crew’s shape; a zoneless line of crew’s is replaced by its zoned twin, a person’s line never is', () => {
    expect(isGenerated('decisions', 'A failed check or review · answered 10:00 UTC+1')).toBe(true);
    expect(isGenerated('decisions', 'Checkpoint 2 pause · answered: continue as planned · 10:00 UTC-4')).toBe(true);
    expect(isGenerated('decisions', 'You · 10:00 UTC+5:30 · approved: “Ship it.”')).toBe(true);
    expect(zoneless('You · 10:00 UTC+5:30 · approved: “Ship it.”')).toBe('You · 10:00 · approved: “Ship it.”');
    const old = 'A failed check or review · answered 10:00';
    const now = 'A failed check or review · answered 10:00 UTC+1';
    // crew wrote `old` (it is in crew's own record): the zoned line takes its place, once.
    expect(reconcileSection('decisions', `Mine\n${old}`, [now], Infinity, new Set([old]))).toBe(`Mine\n${now}`);
    // Again: nothing changes.
    expect(reconcileSection('decisions', `Mine\n${now}`, [now], Infinity, new Set([now]))).toBeNull();
    // A line of that shape crew never wrote is a person's: it stays.
    expect(reconcileSection('decisions', old, [now], Infinity, new Set())).toBe(`${old}\n${now}`);
    // Only the line's own time loses its zone, never a person's quoted words (review r1).
    const quotedOld = 'You · 10:00 · approved: “Deploy at 12:00 UTC+1.”';
    const quotedNow = 'You · 10:00 UTC-5 · approved: “Deploy at 12:00 UTC+1.”';
    expect(zoneless(quotedNow)).toBe(quotedOld);
    expect(reconcileSection('decisions', quotedOld, [quotedNow], Infinity, new Set([quotedOld]))).toBe(quotedNow);
  });
});

describe('crew#1409: a write is journaled before interactive is asked', () => {
  it('a daemon that dies after interactive committed a person’s Goal and before the trail save: the restart attributes it and sets the block', async () => {
    const a = setup();
    await a.service.ensure('run-1');
    a.backend.crash = true;
    // The person's edit commits in interactive; the daemon never hears back (it died).
    void a.service.propose('run-1', { base: 0, author: 'operator', sections: { goal: 'EUR prints €1.240,00.' } }, HUMAN);
    await new Promise((r) => setTimeout(r, 20));
    expect(a.head()).toBe(1);
    expect(a.store.get('run-1')?.trail.map((x) => x.version)).toEqual([0]);

    // A new daemon on the same state and the same interactive.
    const b = setup({ stateHome: a.stateHome, backend: a.backend });
    await b.service.contextCatchUp();
    expect(b.engine.calls.map((c) => c.sections.map((x) => [x.id, x.text, x.author.id]))).toEqual([[['goal', 'EUR prints €1.240,00.', 'the operator']]]);
    const trail = b.store.get('run-1')!.trail;
    expect(trail.map((x) => [x.version, x.author.kind, x.author.id])).toEqual([[0, 'system', 'crew'], [1, 'human', 'local']]);
    expect(b.store.get('run-1')!.pending).toBeNull();
  });

  it('a known outcome leaves no journal: a landed write, a moved head, a refusal; an unknown one keeps it', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const ok = await t.service.propose('run-1', { base: 0, author: 'operator', sections: { constraints: 'Reuse the stack’s route.' } }, HUMAN);
    expect(ok.ok).toBe(true);
    expect(t.store.get('run-1')!.pending ?? null).toBeNull();
    // interactive says the head moved under it: nothing landed, nothing journaled stays.
    t.backend.moved = true;
    const moved = await t.service.propose('run-1', { base: 1, author: 'operator', sections: { next: 'Then the PDF.' } }, HUMAN);
    expect(moved).toMatchObject({ ok: false, code: 409 });
    expect(t.store.get('run-1')!.pending ?? null).toBeNull();
    // A later edit on the new head goes through.
    expect((await t.service.propose('run-1', { base: 2, author: 'operator', sections: { next: 'Then the PDF.' } }, HUMAN)).ok).toBe(true);
    t.backend.refuse = true;
    await expect(t.service.propose('run-1', { base: 3, author: 'operator', sections: { next: 'Then the invoice.' } }, HUMAN)).rejects.toThrow(/refused/u);
    expect(t.store.get('run-1')!.pending ?? null).toBeNull();
    t.backend.undetermined = true;
    await expect(t.service.propose('run-1', { base: 3, author: 'operator', sections: { next: 'Then the invoice.' } }, HUMAN)).rejects.toThrow(UndeterminedWriteError);
    expect(t.store.get('run-1')!.pending).toMatchObject({ expectHead: 3, author: { kind: 'human', id: 'local' }, values: { next: 'Then the invoice.' } });
    // It landed: the next read attributes it to the person.
    await t.service.view('run-1');
    expect(t.store.get('run-1')!.pending).toBeNull();
    expect(t.store.get('run-1')!.trail.at(-1)).toMatchObject({ version: 4, author: { kind: 'human', id: 'local' }, sections: ['next'] });
    // review r2: a value with a line separator reads back as a line break; it is still recognized as landed.
    t.backend.undetermined = true;
    await expect(t.service.propose('run-1', { base: 4, author: 'operator', sections: { goal: 'First\u2028Second' } }, HUMAN)).rejects.toThrow(UndeterminedWriteError);
    await t.service.view('run-1');
    expect(t.store.get('run-1')!.trail.at(-1)).toMatchObject({ version: 5, author: { kind: 'human', id: 'local' }, sections: ['goal'] });
  });
});

describe('crew#1408: the person’s context for the run’s learnings', () => {
  it('only a person’s Goal, Approach and Constraints, as the document holds them now', async () => {
    const t = setup();
    expect(await t.service.personContextOf('run-1')).toEqual([]);
    await t.service.ensure('run-1');
    // crew's seeded Goal is not the person's.
    expect(await t.service.personContextOf('run-1')).toEqual([]);
    await t.service.propose('run-1', { base: 0, author: 'operator', sections: { constraints: 'Reuse the stack’s route, never a hand-rolled one.', next: 'Then the PDF.' } }, HUMAN);
    await t.service.propose('run-1', { base: 1, author: 'operator', sections: { approach: 'Fix the formatter first.' } }, HUMAN);
    expect(await t.service.personContextOf('run-1')).toEqual([
      { id: 'approach', text: 'Fix the formatter first.' },
      { id: 'constraints', text: 'Reuse the stack’s route, never a hand-rolled one.' },
    ]);
  });

  it('a write still settling is not read as the context: it throws, so the run’s end waits for it (review r1)', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    t.backend.crash = true;
    void t.service.propose('run-1', { base: 0, author: 'operator', sections: { goal: 'EUR prints €1.240,00.' } }, HUMAN);
    await new Promise((r) => setTimeout(r, 20));
    // A new daemon whose clock says the write is fresh, and interactive has not shown it yet.
    const b = setup({ stateHome: t.stateHome, backend: new FakeBackend() });
    b.backend.docs.set('working-run-1', [t.backend.docs.get('working-run-1')![0]!]);
    await expect(b.service.personContextOf('run-1')).rejects.toThrow(/not settled/u);
  });
});
