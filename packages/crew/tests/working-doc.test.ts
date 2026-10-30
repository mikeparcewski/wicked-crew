// Program DES-POWER-MODE §8.3/§9, spike 3: the run's working document and steering from it.
//
// What is proven here: a person's edit becomes ONE steering note that reaches the run through the operator inject
// (the path that rides the next step's prompt), the step that picked it up is recorded, attribution is crew's (a
// person vs a plugin), a plugin's words never post as a person's and never steer, nothing here launches a run, and
// DOCUMENT TEXT HAS NO POWER OVER GATES: the only engine call steering makes is the inject.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { Actor, CoreEvent } from '../src/core/types.js';
import { readDocHead, foreignKindAskMessage, chatSeamAnswers, WORKING_DOC_REFUSED_MESSAGE } from '../src/interactive/chat-events.js';
import { eventDocumentId } from '../src/interactive/proxy-routes.js';
import { anchorOf, changedSections, initialHtml, sectionsOf, type SectionId } from '../src/working-doc/sections.js';
import { NO_GATE_LINE, UndeterminedWriteError, WorkingDocService, steerMarker, workingDocName, type DocBackend, type RunFacts } from '../src/working-doc/service.js';
import { WorkingDocStore, WORKING_DOC_KIND, isWorkingDocDir, writeSidecar } from '../src/working-doc/store.js';
import { registerWorkingDocRoutes } from '../src/working-doc/routes.js';
import { registerAuthHooks } from '../src/api/auth.js';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = (): string => { const h = mkdtempSync(join(tmpdir(), 'wd-')); homes.push(h); return h; };

/** An interactive stand-in: write-once versions, content edits on `data-wid` anchors, `head_moved` on a stale base. */
class FakeBackend implements DocBackend {
  versions: Array<{ html: string; author: string }> = [];
  /** Set: the next edit's outcome is not known (it lands only when `land()` is called). */
  undetermined: (() => void) | null = null;
  holdNext = false;
  async create(_p: string, _d: string, _r: string, html: string) { this.versions = [{ html, author: 'crew' }]; return { head: 0 }; }
  async read() { return this.versions.length === 0 ? null : { head: this.versions.length - 1, html: this.versions[this.versions.length - 1]!.html }; }
  async readVersion(_p: string, _d: string, v: number) { return this.versions[v]?.html ?? null; }
  async edit(_p: string, _d: string, batch: { expectHead: number; items: Array<{ selector: string; value: string }>; author: string }) {
    const head = this.versions.length - 1;
    if (batch.expectHead !== head) return { headMoved: true as const, head };
    if (this.holdNext) {
      this.holdNext = false;
      this.undetermined = () => { this.apply(head, batch); };
      throw new UndeterminedWriteError('interactive did not land the edit in 20 s; it may still land');
    }
    return this.apply(head, batch);
  }
  private apply(head: number, batch: { items: Array<{ selector: string; value: string }>; author: string }) {
    let html = this.versions[head]!.html;
    for (const it of batch.items) {
      const wid = it.selector;
      const esc = it.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html = html.replace(new RegExp(`(<div\\b[^>]*data-wid="${wid}"[^>]*>)[\\s\\S]*?(</div>)`, 'u'), `$1${esc}$2`);
    }
    this.versions.push({ html, author: batch.author });
    return { version: head + 1, parent: head };
  }
}

const HUMAN: Actor = { id: 'local', kind: 'human', trust: 'admin' };
const AGENT: Actor = { id: 'worker-1', kind: 'agent', trust: 'operator' };

function setup(over: Partial<RunFacts> = {}) {
  const backend = new FakeBackend();
  const injected: Array<{ runId: string; message: string; target: string }> = [];
  const changed: Array<string> = [];
  const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
  // The ENGINE given to the service has ONE method. Any other call (a gate answer, an amendment, a plan edit) would
  // be a TypeError: steering cannot reach a gate even by mistake.
  const hooks: { onInject?: ((message: string) => void) | undefined } = {};
  const engine = Object.freeze({
    injectWorkerMessage: async (runId: string, message: string, target: string) => {
      injected.push({ runId, message, target });
      hooks.onInject?.(message);
      return 'queued';
    },
  });
  let facts: RunFacts = {
    title: 'Fix the invoice currency', problem: 'Invoice PDFs show $ for EUR accounts.', projectId: 'default', terminal: false,
    stepOf: (ord) => ({ 6: 'fix', 7: 'review', 8: 'verify' } as Record<number, string>)[ord] ?? null, ...over,
  };
  const service = new WorkingDocService({
    store: new WorkingDocStore({ stateHome: home() }),
    backend,
    engine,
    run: async () => facts,
    changed: (runId) => changed.push(runId),
    audit: (action, _a, _r, detail) => audits.push({ action, detail }),
    now: () => 1_000,
  });
  return { service, backend, injected, changed, audits, hooks, setFacts: (f: Partial<RunFacts>) => { facts = { ...facts, ...f }; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('sections', () => {
  it('a doc name never ends in a hyphen, and a reference to no character is kept as written', () => {
    expect(workingDocName('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeeeffff-0')).not.toMatch(/-$/u);
    expect(workingDocName('---')).toBe('working-run');
    expect(sectionsOf('<div data-wid="wd-goal">&#x110000; &#999999999; ok</div>').goal).toBe('&#x110000; &#999999999; ok');
    expect(sectionsOf(initialHtml('t', { goal: 'a\r\nb' })).goal).toBe('a\nb');
  });

  it('a version reads back into its sections, each one anchored element of plain text', () => {
    const html = initialHtml('A job', { goal: 'Make <it> right & quick', constraints: 'Keep /v1\nworking' });
    expect(sectionsOf(html)).toMatchObject({ goal: 'Make <it> right & quick', constraints: 'Keep /v1\nworking', approach: '' });
    expect(html).toContain(`data-wid="${anchorOf('goal')}"`);
    expect(changedSections({ goal: 'a', next: '' }, { goal: 'a', next: 'b' } as Partial<Record<SectionId, string>>)).toEqual(['next']);
  });
});

describe('the working document', () => {
  it('is made once per run, its Goal seeded from the intent, by crew', async () => {
    const t = setup();
    const v = await t.service.ensure('run-1');
    expect(v?.sections?.goal).toBe('Invoice PDFs show $ for EUR accounts.');
    expect(v?.trail).toEqual([expect.objectContaining({ version: 0, author: { kind: 'system', id: 'crew' }, sections: ['goal'] })]);
    await t.service.ensure('run-1');
    expect(t.backend.versions).toHaveLength(1);
  });

  it('a person’s edit is theirs (the plugin named as the surface) and becomes ONE note that rides the next step', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const r = await t.service.propose('run-1', { base: 0, author: 'operator', plugin: { id: 'wicked-phase-report', version: '0.13.1' }, sections: { approach: 'Pass the currency through formatMoney().', next: 'Add GBP and JPY tests.' } }, HUMAN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.trail.at(-1)).toMatchObject({ version: 1, author: { kind: 'human', id: 'local' }, surface: 'plugin:wicked-phase-report@0.13.1', sections: ['approach', 'next'] });
    expect(t.backend.versions[1]?.author).toBe('local via plugin:wicked-phase-report@0.13.1');
    expect(t.injected).toHaveLength(1);
    const note = t.injected[0]!;
    expect(note).toMatchObject({ runId: 'run-1', target: 'all' });
    expect(note.message).toContain('- Approach: Pass the currency through formatMoney().');
    expect(note.message).toContain('- Next and trailing work: Add GBP and JPY tests.');
    expect(note.message).toContain(steerMarker('run-1', r.steer!.id));
    expect(r.steer).toMatchObject({ kind: 'next', version: 1, queuedAt: 1_000, pickedUp: null, error: null });
    expect(t.audits).toEqual([expect.objectContaining({ action: 'run.steered.doc', detail: expect.objectContaining({ version: 1, author: 'operator', surface: 'plugin:wicked-phase-report@0.13.1' }) })]);
  });

  it('the step that picked the note up is recorded when the engine injects it into that step’s prompt', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const r = await t.service.propose('run-1', { base: 0, author: 'operator', sections: { goal: 'EUR prints €1.240,00.' } }, HUMAN);
    if (!r.ok) throw new Error(r.error);
    t.service.onEvent({ type: 'unitDispatched', session: 'run-1', ord: 7 } as unknown as CoreEvent);
    t.service.onEvent({ type: 'workerMessageInjected', session: 'run-1', message: t.injected[0]!.message, target: 'all' } as unknown as CoreEvent);
    await tick(); await tick();
    const v = await t.service.view('run-1');
    expect(v.steers[0]?.pickedUp).toEqual({ ord: 7, step: 'review', at: 1_000 });
    expect(t.changed.length).toBeGreaterThan(1);
  });

  const injectedAt = (t: ReturnType<typeof setup>, ord: number, message: string) => {
    t.service.onEvent({ type: 'unitDispatched', session: 'run-1', ord } as unknown as CoreEvent);
    t.service.onEvent({ type: 'workerMessageInjected', session: 'run-1', message, target: 'all' } as unknown as CoreEvent);
  };
  const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

  it('Constraints and steering is standing: each dispatch that picks a copy up queues the next one', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const r = await t.service.propose('run-1', { base: 0, author: 'operator', sections: { constraints: 'Keep /v1/invoice.pdf working.' } }, HUMAN);
    if (!r.ok) throw new Error(r.error);
    expect(r.steer?.kind).toBe('standing');
    expect(t.injected[0]?.message).toContain('It replaces any standing constraint from an earlier version.');
    injectedAt(t, 6, t.injected[0]!.message);
    await settle();
    expect(t.injected).toHaveLength(2);
    expect(t.injected[1]?.message).toMatch(/^Standing operator constraint/u);
    expect(t.injected[1]?.message).toContain('If you also see a standing constraint from a later version, that one applies instead.');
    expect(t.injected[1]?.message).toContain('- Constraints and steering: Keep /v1/invoice.pdf working.');
    // The next step picks THAT copy up: one more copy for the step after it.
    injectedAt(t, 7, t.injected[1]!.message);
    await settle();
    expect(t.injected).toHaveLength(3);
    expect((await t.service.view('run-1')).steers[0]?.renewals).toBe(2);
  });

  it('a retry of the same unit is another dispatch: its pickup queues the next copy too', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    await t.service.propose('run-1', { base: 0, author: 'operator', sections: { constraints: 'K' } }, HUMAN);
    const pick = (ord: number, attempt: number, message: string) => {
      t.service.onEvent({ type: 'unitDispatched', session: 'run-1', ord, attempt } as unknown as CoreEvent);
      t.service.onEvent({ type: 'workerMessageInjected', session: 'run-1', message, target: 'all' } as unknown as CoreEvent);
    };
    pick(6, 0, t.injected[0]!.message);
    await settle();
    pick(6, 1, t.injected[1]!.message);
    await settle();
    expect(t.injected).toHaveLength(3);
  });

  it('a live worker that takes the copy in the same step leaves none waiting: the step’s end queues it', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    await t.service.propose('run-1', { base: 0, author: 'operator', sections: { constraints: 'K' } }, HUMAN);
    injectedAt(t, 6, t.injected[0]!.message);
    await settle();
    // The live worker of step 6 takes copy 1 at once (same dispatch): no loop.
    t.service.onEvent({ type: 'workerMessageInjected', session: 'run-1', message: t.injected[1]!.message, target: 'all' } as unknown as CoreEvent);
    await settle();
    expect(t.injected).toHaveLength(2);
    t.service.onEvent({ type: 'unitDone', session: 'run-1', ord: 6 } as unknown as CoreEvent);
    await settle();
    expect(t.injected).toHaveLength(3);
    // With a copy already waiting, a step's end queues nothing more.
    t.service.onEvent({ type: 'unitDone', session: 'run-1', ord: 6 } as unknown as CoreEvent);
    await settle();
    expect(t.injected).toHaveLength(3);
  });

  it('the dispatch is known even when it began before the run had a document', async () => {
    const t = setup();
    t.service.onEvent({ type: 'unitExecuting', session: 'run-1', ord: 4 } as unknown as CoreEvent);
    await t.service.ensure('run-1');
    await t.service.propose('run-1', { base: 0, author: 'operator', sections: { goal: 'x' } }, HUMAN);
    t.service.onEvent({ type: 'workerMessageInjected', session: 'run-1', message: t.injected[0]!.message, target: 'all' } as unknown as CoreEvent);
    await settle();
    expect((await t.service.view('run-1')).steers[0]?.pickedUp?.ord).toBe(4);
  });

  it('an edit whose outcome was unknown is settled by the next read, with its steer', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    t.backend.holdNext = true;
    await expect(t.service.propose('run-1', { base: 0, author: 'operator', sections: { next: 'ALICE' } }, HUMAN)).rejects.toThrow(/may still land/u);
    t.backend.undetermined!();
    const v = await t.service.view('run-1');
    expect(v.trail.map((x) => [x.version, x.author.id])).toEqual([[0, 'crew'], [1, 'local']]);
    expect(t.injected.map((x) => x.message.includes('ALICE'))).toEqual([true]);
  });

  it('a pickup reported while the engine is still taking the note is never lost', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    t.service.onEvent({ type: 'unitExecuting', session: 'run-1', ord: 5 } as unknown as CoreEvent);
    // The engine writes into a live worker and reports it before its own call returns.
    t.hooks.onInject = (m) => { t.hooks.onInject = undefined; t.service.onEvent({ type: 'workerMessageInjected', session: 'run-1', message: m, target: 'all' } as unknown as CoreEvent); };
    await t.service.propose('run-1', { base: 0, author: 'operator', sections: { approach: 'x' } }, HUMAN);
    await settle();
    expect((await t.service.view('run-1')).steers[0]?.pickedUp).toEqual({ ord: 5, step: null, at: 1_000 });
  });

  it('a replaced constraint is never sent after its replacement', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const old = await t.service.propose('run-1', { base: 0, author: 'operator', sections: { constraints: 'OLD' } }, HUMAN);
    if (!old.ok) throw new Error(old.error);
    // The pickup's renewal and a replacing edit race for the run's turn.
    injectedAt(t, 6, t.injected[0]!.message);
    const replaced = t.service.propose('run-1', { base: 1, author: 'operator', sections: { constraints: 'NEW' } }, HUMAN);
    await replaced;
    await settle();
    const order = t.injected.map((x) => (x.message.includes('OLD') ? 'OLD' : 'NEW'));
    expect(order.lastIndexOf('OLD')).toBeLessThan(order.indexOf('NEW'));
    // And once replaced, a pickup of the old one queues nothing.
    injectedAt(t, 7, t.injected[0]!.message);
    await settle();
    expect(t.injected.filter((x) => x.message.includes('OLD')).length).toBe(order.filter((x) => x === 'OLD').length);
  });

  it('one version is ONE note: the next-step sections and the standing constraint together', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const r = await t.service.propose('run-1', { base: 0, author: 'operator', sections: { approach: 'Use Intl.', constraints: 'Keep USD byte-identical.' } }, HUMAN);
    if (!r.ok) throw new Error(r.error);
    expect(t.injected).toHaveLength(1);
    expect(r.steer).toMatchObject({ kind: 'standing', sections: ['approach', 'constraints'] });
    expect(r.view.steers).toHaveLength(1);
    expect(r.view.trail.at(-1)?.steerId).toBe(r.steer?.id);
    expect(t.audits.at(-1)?.detail).toMatchObject({ steer: r.steer?.id, kind: 'standing', steered: ['approach', 'constraints'] });
  });

  it('an emptied Constraints is said once, as cleared, and ends the standing one', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    await t.service.propose('run-1', { base: 0, author: 'operator', sections: { constraints: 'Keep /v1' } }, HUMAN);
    const r = await t.service.propose('run-1', { base: 1, author: 'operator', sections: { constraints: '' } }, HUMAN);
    if (!r.ok) throw new Error(r.error);
    expect(r.steer?.kind).toBe('next');
    expect(t.injected[1]?.message).toContain('- Constraints and steering: (cleared)');
    expect(r.view.steers[0]?.supersededBy).toBe(r.steer?.id);
  });

  it('Decisions and Open questions are recorded, not sent', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const r = await t.service.propose('run-1', { base: 0, author: 'operator', sections: { decisions: 'JPY prints no decimals.', questions: 'Sunset date for /v1?' } }, HUMAN);
    expect(r.ok && r.steer).toBe(null);
    expect(t.injected).toHaveLength(0);
  });

  it('a job that has ended is never steered: the version is kept and the note says why it was not sent', async () => {
    const t = setup({ terminal: true });
    await t.service.ensure('run-1');
    const r = await t.service.propose('run-1', { base: 0, author: 'operator', sections: { approach: 'x' } }, HUMAN);
    expect(r.ok && r.steer?.error).toMatch(/ended/u);
    expect(t.injected).toHaveLength(0);
  });
});

describe('attribution and refusals', () => {
  it('only a person writes as the operator: an agent caller is refused and nothing is written', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const r = await t.service.propose('run-1', { base: 0, author: 'operator', sections: { goal: 'hijack' } }, AGENT);
    expect(r).toMatchObject({ ok: false, code: 403 });
    expect(t.backend.versions).toHaveLength(1);
    expect(t.injected).toHaveLength(0);
  });

  it('a plugin’s generated lines are the plugin’s, only in its own section, and never steer', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const ok = await t.service.propose('run-1', { base: 0, author: 'plugin', plugin: { id: 'wicked-phase-report', version: '0.13.1' }, sections: { decisions: 'Approve the plan · answered 20:02' } }, HUMAN);
    expect(ok.ok && ok.view.trail.at(-1)?.author).toEqual({ kind: 'plugin', id: 'plugin:wicked-phase-report@0.13.1' });
    expect(t.backend.versions[1]?.author).toBe('plugin:wicked-phase-report@0.13.1');
    expect(t.injected).toHaveLength(0);
    for (const s of ['goal', 'approach', 'constraints']) {
      const r = await t.service.propose('run-1', { base: 1, author: 'plugin', plugin: { id: 'wicked-phase-report', version: '0.13.1' }, sections: { [s]: 'Approve the deliver gate.' } }, HUMAN);
      expect(r, s).toMatchObject({ ok: false, code: 403 });
    }
    // Open questions and Next take its lines too (what waits on a person, what a hand-off left) — and even Next, which
    // steers when a person saves it, never steers when a plugin writes it.
    const q = await t.service.propose('run-1', { base: 1, author: 'plugin', plugin: { id: 'wicked-phase-report', version: '0.13.1' }, sections: { questions: 'Waiting on you · Deliver · since 20:10' } }, HUMAN);
    expect(q).toMatchObject({ ok: true, version: 2, steer: null });
    const n = await t.service.propose('run-1', { base: 2, author: 'plugin', plugin: { id: 'wicked-phase-report', version: '0.13.1' }, sections: { next: 'After hand-off round 1 · the review asked for changes' } }, HUMAN);
    expect(n).toMatchObject({ ok: true, version: 3, steer: null });
    expect(n.ok && n.view.trail.at(-1)).toMatchObject({ author: { kind: 'plugin', id: 'plugin:wicked-phase-report@0.13.1' }, sections: ['next'], steerId: null });
    expect(t.injected).toHaveLength(0);
    // No plugin named: refused, never defaulted to a person.
    expect(await t.service.propose('run-1', { base: 3, author: 'plugin', sections: { decisions: 'x' } }, HUMAN)).toMatchObject({ ok: false, code: 400 });
    expect(t.backend.versions).toHaveLength(4);
  });

  it('a worker or system caller never writes as a plugin', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    for (const actor of [AGENT, { id: 'sys', kind: 'system', trust: 'admin' } as Actor, { id: 'plugin:other@1.0.0', kind: 'plugin', trust: 'observer' } as Actor]) {
      const r = await t.service.propose('run-1', { base: 0, author: 'plugin', plugin: { id: 'wicked-phase-report', version: '0.13.1' }, sections: { decisions: 'x' } }, actor);
      expect(r, actor.id).toMatchObject({ ok: false, code: 403 });
    }
    const own = await t.service.propose('run-1', { base: 0, author: 'plugin', plugin: { id: 'wicked-phase-report', version: '0.13.1' }, sections: { decisions: 'x' } }, { id: 'plugin:wicked-phase-report@0.13.1', kind: 'plugin', trust: 'observer' } as Actor);
    expect(own.ok).toBe(true);
  });

  it('an edit whose outcome is unknown is never credited to the next caller, and is its author’s once it lands', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    t.backend.holdNext = true;
    await expect(t.service.propose('run-1', { base: 0, author: 'operator', sections: { next: 'ALICE' } }, HUMAN)).rejects.toThrow(/may still land/u);
    // Bob edits on the head he sees: refused while Alice's write is undecided.
    expect(await t.service.propose('run-1', { base: 0, author: 'operator', sections: { next: 'BOB' } }, { id: 'bob', kind: 'human', trust: 'operator' } as Actor)).toMatchObject({ ok: false, code: 409 });
    t.backend.undetermined!();
    const r = await t.service.propose('run-1', { base: 1, author: 'operator', sections: { goal: 'later' } }, { id: 'bob', kind: 'human', trust: 'operator' } as Actor);
    if (!r.ok) throw new Error(r.error);
    expect(r.view.trail.map((x) => [x.version, x.author.id, x.sections.join()])).toEqual([[0, 'crew', 'goal'], [1, 'local', 'next'], [2, 'bob', 'goal']]);
    expect(t.injected.map((x) => x.message.includes('ALICE') ? 'ALICE' : x.message.includes('BOB') ? 'BOB' : 'later')).toEqual(['ALICE', 'later']);
  });

  it('a stale base is refused with the head, an unknown section or an over-long text with 400', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    expect(await t.service.propose('run-1', { base: 5, author: 'operator', sections: { goal: 'x' } }, HUMAN)).toMatchObject({ ok: false, code: 409, head: 0 });
    expect(await t.service.propose('run-1', { base: 0, author: 'operator', sections: { gate: 'approve' } }, HUMAN)).toMatchObject({ ok: false, code: 400 });
    expect(await t.service.propose('run-1', { base: 0, author: 'operator', sections: { goal: 'x'.repeat(5_000) } }, HUMAN)).toMatchObject({ ok: false, code: 400 });
  });
});

describe('the orchestrator’s own notes (power mode)', () => {
  const notes = (over: Record<string, unknown> = {}) => ({
    type: 'powerWorkingNotes', session: 'run-1', ord: 3, attempt: 0, turn: 1, seat: 'claude', at: 1,
    approach: 'Add a cached floorCache field to diagnostics', decisions: [{ text: 'A 60 s cache', why: 'the walk is slow' }], ...over,
  }) as unknown as CoreEvent;
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

  it('the engine’s notes frame writes Approach and Decisions as agent:<seat>, makes the document if needed, and never steers', async () => {
    const t = setup();
    t.service.onEvent(notes());
    await settle();
    const v = await t.service.view('run-1');
    expect(v.sections?.approach).toBe('Add a cached floorCache field to diagnostics');
    expect(v.sections?.decisions).toBe('- A 60 s cache. Why: the walk is slow (claude, turn 1)');
    expect(v.trail.at(-1)).toMatchObject({ author: { kind: 'agent', id: 'agent:claude' }, steerId: null, sections: ['approach', 'decisions'] });
    expect(t.backend.versions.at(-1)?.author).toBe('agent:claude');
    expect(t.injected).toHaveLength(0);
    expect(t.audits.at(-1)).toMatchObject({ action: 'run.steered.doc', detail: { author: 'agent:claude' } });
    // A later turn appends its decisions and restates the approach.
    t.service.onEvent(notes({ turn: 2, approach: 'Plan B', decisions: [{ text: 'Keep the route', why: null }] }));
    await settle();
    const w = await t.service.view('run-1');
    expect(w.sections?.approach).toBe('Plan B');
    expect(w.sections?.decisions).toBe('- A 60 s cache. Why: the walk is slow (claude, turn 1)\n- Keep the route (claude, turn 2)');
    expect(t.injected).toHaveLength(0);
  });

  it('a person’s Approach stands: the agent’s restatement goes under Decisions', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const mine = await t.service.propose('run-1', { base: 0, author: 'operator', sections: { approach: 'Do it in the adapter' } }, HUMAN);
    expect(mine.ok).toBe(true);
    const steersBefore = t.injected.length;
    await t.service.agentNotes('run-1', { seat: 'claude', turn: 1, approach: 'Do it in the route', decisions: [] });
    const v = await t.service.view('run-1');
    expect(v.sections?.approach).toBe('Do it in the adapter');
    expect(v.sections?.decisions).toBe('- Approach now (claude, turn 1): Do it in the route. Your edit to Approach stands.');
    expect(t.injected.length).toBe(steersBefore);
  });

  it('a person’s write of unknown outcome does not lock the document: notes and the next edit still go through (review on #1218)', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    t.backend.holdNext = true;
    await expect(t.service.propose('run-1', { base: 0, author: 'operator', sections: { approach: 'Mine' } }, HUMAN)).rejects.toBeInstanceOf(UndeterminedWriteError);
    const within = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error('locked')), 2_000))]);
    // The agent's notes wait for the pending write to settle, and do not hang the run's lock.
    await within(t.service.agentNotes('run-1', { seat: 'claude', turn: 1, approach: null, decisions: [{ text: 'A', why: null }] }));
    t.backend.undetermined?.();
    const v = await within(t.service.view('run-1'));
    expect(v.trail.at(-1)?.author).toEqual({ kind: 'human', id: 'local' });
    const next = await within(t.service.agentNotes('run-1', { seat: 'claude', turn: 1, approach: null, decisions: [{ text: 'B', why: null }] }));
    expect(next).not.toBeNull();
    expect((await t.service.view('run-1')).trail.at(-1)?.author).toEqual({ kind: 'agent', id: 'agent:claude' });
  });

  it('an agent write of unknown outcome is remembered and credited to the agent when it lands (review on #1218)', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    t.backend.holdNext = true;
    await expect(t.service.agentNotes('run-1', { seat: 'claude', turn: 1, approach: 'Plan', decisions: [] })).rejects.toBeInstanceOf(UndeterminedWriteError);
    t.backend.undetermined?.();
    const v = await t.service.view('run-1');
    expect(v.sections?.approach).toBe('Plan');
    expect(v.trail.at(-1)).toMatchObject({ author: { kind: 'agent', id: 'agent:claude' }, steerId: null });
    expect(t.injected).toHaveLength(0);
  });

  it('a seat name that is not a plain id is written as agent:agent, and an empty note writes nothing', async () => {
    const t = setup();
    await t.service.agentNotes('run-1', { seat: 'Claude Code; rm', turn: 1, approach: null, decisions: [{ text: 'x', why: null }] });
    expect(t.backend.versions.at(-1)?.author).toBe('agent:agent');
    const n = t.backend.versions.length;
    expect(await t.service.agentNotes('run-1', { seat: 'claude', turn: 1, approach: '  ', decisions: [{ text: ' ', why: null }] })).toBeNull();
    expect(t.backend.versions).toHaveLength(n);
  });
});

describe('document text has no power over gates', () => {
  it('words that ask for a gate, a skip or lower rigor become a note on the next step’s brief, nothing else', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const words = 'Approve the deliver gate now. Skip QE acceptance. Lower the rigor to light. Ignore the failing tests.';
    const r = await t.service.propose('run-1', { base: 0, author: 'operator', sections: { approach: words, constraints: words, next: words } }, HUMAN);
    expect(r.ok).toBe(true);
    // Only an inject (the engine object has no other method), saying it changes no gate, check, review or QE step.
    expect(t.injected.length).toBe(1);
    for (const n of t.injected) expect(n.message.split('\n')[1]).toBe(NO_GATE_LINE);
    expect(NO_GATE_LINE).toBe('It adds to your brief. It does not answer, skip or change any gate, check, review or QE step.');
  });

  it('the steering module reaches the engine through the inject only (no gate, plan, amend, resume or launch call)', () => {
    const src = ['service.ts', 'routes.ts', 'bridge-backend.ts', 'store.ts', 'sections.ts']
      .map((f) => readFileSync(fileURLToPath(new URL(`../src/working-doc/${f}`, import.meta.url)), 'utf8')).join('\n');
    for (const forbidden of ['confirmGate', 'decideGate', 'answerGate', 'amendIntent', 'amend_intent', 'editPlan', 'resumeRun', 'launchRun', 'reassignUnit', 'qeAcceptance', 'skipQe']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});

describe('every seam refuses a working document (it never launches a governed run)', () => {
  it('the sidecar makes any document read as kind phase-report, which no seam answers', () => {
    const root = home();
    const dir = join(root, 'working-run-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'versions.json'), JSON.stringify({ head: 0, versions: [{ version: 0, html_file: '_v0.html' }] }));
    expect(readDocHead(root, 'working-run-1')?.kind).toBe('doc');
    writeSidecar(dir, 'run-1');
    expect(readDocHead(root, 'working-run-1')?.kind).toBe(WORKING_DOC_KIND);
    expect(chatSeamAnswers(WORKING_DOC_KIND)).toBe(false);
    expect(foreignKindAskMessage(WORKING_DOC_KIND)).toBe(WORKING_DOC_REFUSED_MESSAGE);
  });

  it('the sidecar alone marks it, before interactive has written a manifest', () => {
    const root = home();
    const dir = join(root, 'working-run-2');
    writeSidecar(dir, 'run-2');
    expect(readDocHead(root, 'working-run-2')).toBeNull();
    expect(isWorkingDocDir(dir)).toBe(true);
  });

  it('the proxy reads the target document of any event body', () => {
    expect(eventDocumentId(Buffer.from(JSON.stringify({ event_type: 'wicked.interactive.review.requested', payload: { document_id: 'working-run-1' } })))).toBe('working-run-1');
    expect(eventDocumentId(Buffer.from('not json'))).toBeNull();
  });
});

describe('the routes', () => {
  async function app(actor: Actor | undefined) {
    const t = setup();
    const a = Fastify();
    a.addHook('preHandler', async (req) => { if (actor !== undefined) (req as { actor?: Actor }).actor = actor; });
    registerWorkingDocRoutes(a, { service: t.service, exists: async (id) => id === 'run-1' });
    await a.ready();
    return { a, t };
  }

  it('GET says doc:null until one is made; POST makes it; a version comes back with its trail', async () => {
    const { a } = await app(undefined);
    expect((await a.inject({ method: 'GET', url: '/api/v1/runs/run-1/working-doc' })).json()).toMatchObject({ doc: null, trail: [] });
    expect((await a.inject({ method: 'GET', url: '/api/v1/runs/nope/working-doc' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/api/v1/runs/run-1/working-doc' })).json()).toMatchObject({ doc: { head: 0 } });
    const r = await a.inject({ method: 'POST', url: '/api/v1/runs/run-1/working-doc/versions', payload: { base: 0, author: 'operator', sections: { next: 'Ship it as a PR.' } } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ version: 1, steer: { kind: 'next' } });
  });

  it('an observer is refused; a plugin actor may write only its own lines, as itself', async () => {
    const obs = await app({ id: 'o', kind: 'human', trust: 'observer' });
    await obs.t.service.ensure('run-1');
    expect((await obs.a.inject({ method: 'POST', url: '/api/v1/runs/run-1/working-doc/versions', payload: { base: 0, author: 'operator', sections: { goal: 'x' } } })).statusCode).toBe(403);
    const plug = await app({ id: 'plugin:wicked-phase-report@0.13.1', kind: 'plugin', trust: 'observer' } as Actor);
    await plug.t.service.ensure('run-1');
    const as = (author: string, plugin: unknown, sections: Record<string, string>) =>
      plug.a.inject({ method: 'POST', url: '/api/v1/runs/run-1/working-doc/versions', payload: { base: 0, author, plugin, sections } });
    expect((await as('operator', { id: 'wicked-phase-report', version: '0.13.1' }, { goal: 'x' })).statusCode).toBe(403);
    expect((await as('plugin', { id: 'another-plugin', version: '1.0.0' }, { decisions: 'x' })).statusCode).toBe(403);
    expect((await as('plugin', { id: 'wicked-phase-report', version: '0.13.1' }, { decisions: 'Plan approved' })).statusCode).toBe(200);
    expect(plug.t.injected).toHaveLength(0);
  });

  it('with the real auth boundary: a plugin token reaches only its own-lines write, as itself', async () => {
    const t = setup();
    await t.service.ensure('run-1');
    const a = Fastify();
    const plugin: Actor = { id: 'plugin:wicked-phase-report@0.13.1', kind: 'plugin', trust: 'observer' } as Actor;
    registerAuthHooks(a, { mode: 'required', verifiers: [{ name: 'test', verify: async (tok) => (tok === 'p' ? plugin : null) }], allowedOrigins: null });
    registerWorkingDocRoutes(a, { service: t.service, exists: async (id) => id === 'run-1' });
    await a.ready();
    const send = (url: string, payload: unknown) => a.inject({ method: 'POST', url, headers: { authorization: 'Bearer p' }, payload: payload as Record<string, unknown> });
    expect((await send('/api/v1/runs/run-1/working-doc/versions', { base: 0, author: 'plugin', plugin: { id: 'wicked-phase-report', version: '0.13.1' }, sections: { decisions: 'Plan approved' } })).statusCode).toBe(200);
    expect((await send('/api/v1/runs/run-1/working-doc/versions', { base: 1, author: 'operator', sections: { goal: 'x' } })).statusCode).toBe(403);
    expect((await send('/api/v1/runs/run-1/working-doc', {})).statusCode).toBe(403);
    expect((await send('/api/v1/runs/run-1/inject', { message: 'x', target: 'all' })).statusCode).toBe(403);
    expect(t.injected).toHaveLength(0);
  });
});
