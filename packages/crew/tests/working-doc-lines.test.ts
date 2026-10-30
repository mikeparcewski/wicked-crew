// Rig run ea73afc0: the working document's event-derived lines (Decisions answered, Open questions, Next) were written
// only by whichever studio tab had the run open, so a run nobody viewed got none. Crew now writes them from the run's
// own recorded events, as the Phase report plugin's actor, and they never steer.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CoreEvent } from '../src/core/types.js';
import { PHASE_REPORT_AUTHOR, clock, docLines, foldLines, reconcileSection } from '../src/working-doc/event-lines.js';
import { sectionsOf } from '../src/working-doc/sections.js';
import { WorkingDocService, type DocBackend, type RunFacts } from '../src/working-doc/service.js';
import { WorkingDocStore } from '../src/working-doc/store.js';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = (): string => { const h = mkdtempSync(join(tmpdir(), 'wdl-')); homes.push(h); return h; };

class FakeBackend implements DocBackend {
  versions: Array<{ html: string; author: string }> = [];
  async create(_p: string, _d: string, _r: string, html: string) { this.versions = [{ html, author: 'crew' }]; return { head: 0 }; }
  async read() { return this.versions.length === 0 ? null : { head: this.versions.length - 1, html: this.versions[this.versions.length - 1]!.html }; }
  async readVersion(_p: string, _d: string, v: number) { return this.versions[v]?.html ?? null; }
  async edit(_p: string, _d: string, batch: { expectHead: number; items: Array<{ selector: string; value: string }>; author: string }) {
    const head = this.versions.length - 1;
    if (batch.expectHead !== head) return { headMoved: true as const, head };
    let html = this.versions[head]!.html;
    for (const it of batch.items) {
      const esc = it.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html = html.replace(new RegExp(`(<div\\b[^>]*data-wid="${it.selector}"[^>]*>)[\\s\\S]*?(</div>)`, 'u'), `$1${esc}$2`);
    }
    this.versions.push({ html, author: batch.author });
    return { version: head + 1, parent: head };
  }
}

const T0 = Date.UTC(2026, 9, 30, 12, 30, 0);
const min = (n: number) => T0 + n * 60_000;
let seq = 0;
const ev = (type: string, ts: number, extra: Record<string, unknown> = {}): CoreEvent =>
  ({ type, session: 'run-1', ts, seq: ++seq, ...extra }) as unknown as CoreEvent;

function setup(log: CoreEvent[]) {
  const backend = new FakeBackend();
  const injected: string[] = [];
  const audits: Array<{ action: string; actor: { id: string; kind: string }; detail: Record<string, unknown> }> = [];
  const facts: RunFacts = { title: 'Fix it', problem: 'Fix the estate row.', projectId: 'default', terminal: false, stepOf: () => null };
  const service = new WorkingDocService({
    store: new WorkingDocStore({ stateHome: home() }),
    backend,
    engine: Object.freeze({ injectWorkerMessage: async (_r: string, m: string) => { injected.push(m); return 'queued'; } }),
    run: async () => facts,
    audit: (action, actor, _r, detail) => audits.push({ action, actor, detail }),
    events: async () => log,
    linesDelayMs: 0,
    now: () => 1_000,
  });
  const sections = async () => sectionsOf(backend.versions.at(-1)!.html);
  return { service, backend, injected, audits, sections };
}

/** A power run's log: the plan gate (answered when the build starts), then a failed floor's escalation, still open. */
function powerRun(): CoreEvent[] {
  seq = 0;
  return [
    ev('sessionStarted', min(0)),
    ev('powerIntakePlanned', min(3), { plan: { rigor: 'highest', score: 100 } }),
    ev('awaitingHuman', min(3), { ord: 1, gateKind: 'plan_approval' }),
    ev('unitExecuting', min(4), { ord: 2 }),
    ev('powerTurnStarted', min(8), { ord: 3, turn: 1 }),
    ev('awaitingHuman', min(77), { ord: 3, gateKind: 'escalation' }),
  ];
}

describe('event-derived working-document lines, written by crew', () => {
  it('a power run nobody views gets its Decisions and Open questions, as the plugin, never steering', async () => {
    const log = powerRun();
    const t = setup(log);
    const v = await t.service.syncLines('run-1');
    expect(v).toBe(1);
    const s = await t.sections();
    expect(s.decisions).toBe(`Approve the plan · answered ${clock(min(4))}`);
    expect(s.questions).toBe(`Waiting on you · A failed check or review · since ${clock(min(77))}`);
    expect(s.next).toBe('');
    expect(t.backend.versions.at(-1)!.author).toBe(PHASE_REPORT_AUTHOR);
    expect(PHASE_REPORT_AUTHOR).toMatch(/^plugin:wicked-phase-report@\d+\.\d+\.\d+$/u);
    const view = await t.service.view('run-1');
    expect(view.trail.at(-1)).toMatchObject({ author: { kind: 'plugin', id: PHASE_REPORT_AUTHOR }, sections: ['decisions', 'questions'], steerId: null });
    expect(t.injected).toEqual([]);
    expect(t.audits.at(-1)).toMatchObject({ action: 'run.steered.doc', actor: { id: PHASE_REPORT_AUTHOR, kind: 'plugin' }, detail: { author: PHASE_REPORT_AUTHOR } });
    // Nothing new: nothing written.
    expect(await t.service.syncLines('run-1')).toBeNull();
    expect(t.backend.versions).toHaveLength(2);
  });

  it('an answered gate leaves Open questions, a failed hand-off step goes under Next, and a person’s lines stay', async () => {
    const log = powerRun();
    const t = setup(log);
    await t.service.syncLines('run-1');
    // A person writes their own line under Open questions.
    const head = t.backend.versions.length - 1;
    const r = await t.service.propose('run-1', { base: head, sections: { questions: `${(await t.sections()).questions}\nShould Windows be in scope?` }, author: 'operator' }, { id: 'local', kind: 'human' });
    expect(r.ok).toBe(true);
    log.push(
      ev('resumed', min(83), { ord: 3 }),
      ev('powerHandoffStepped', min(90), { round: 1, step: { step: 'review', status: 'failed', ord: 4, at: min(90) } }),
      ev('powerHandoffStepped', min(91), { round: 2, step: { step: 'review', status: 'failed', ord: 4, at: min(91) } }),
    );
    await t.service.syncLines('run-1');
    const s = await t.sections();
    expect(s.decisions?.split('\n')).toEqual([`Approve the plan · answered ${clock(min(4))}`, `A failed check or review · answered ${clock(min(83))}`]);
    expect(s.questions).toBe('Should Windows be in scope?');
    expect(s.next).toBe('After hand-off round 2 · the review asked for changes: make them and hand off again');
    // A later round that passes the review takes the follow-up back.
    log.push(ev('powerHandoffStepped', min(120), { round: 3, step: { step: 'review', status: 'passed', ord: 4, at: min(120) } }));
    await t.service.syncLines('run-1');
    expect((await t.sections()).next).toBe('');
    expect(t.injected).toEqual([]); // Open questions is recorded, never sent; generated lines never steer
  });

  it('a live line event brings the lines up to date with no viewer, one write per burst', async () => {
    const log = powerRun();
    const t = setup(log);
    for (const e of log) t.service.onEvent(e);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.backend.versions.length).toBe(2);
    expect((await t.sections()).questions).toContain('Waiting on you · A failed check or review');
  });

  it('a phased run without a document gets none made; one that has a document gets its lines', async () => {
    seq = 0;
    const log = [ev('awaitingHuman', min(1), { ord: 1, gateKind: 'deliver' })];
    const t = setup(log);
    expect(await t.service.syncLines('run-1')).toBeNull();
    expect(t.backend.versions).toHaveLength(0);
    await t.service.ensure('run-1');
    expect(await t.service.syncLines('run-1')).toBe(1);
    expect((await t.sections()).questions).toBe(`Waiting on you · Deliver · since ${clock(min(1))}`);
  });

  it('a checkpoint pause waits on a person until the next turn, then is a decision; a finished run asks nothing', () => {
    seq = 0;
    const log = [
      ev('powerCheckpointReached', min(10), { checkpoint: 2, paused: true, pause: { reasons: ['struggling: 80 min against an estimate of 20 min; 3 failed test runs'] } }),
    ];
    expect(docLines(foldLines(log)).questions).toEqual([
      `Waiting on you · checkpoint 2 paused (taking much longer than estimated; the tests kept failing): split it, switch to phased steps, continue at high rigor, or stop? · since ${clock(min(10))}`,
    ]);
    log.push(ev('powerTurnStarted', min(12), { turn: 2 }));
    const after = docLines(foldLines(log));
    expect(after.questions).toEqual([]);
    expect(after.decisions).toEqual([`Checkpoint 2 pause (taking much longer than estimated; the tests kept failing) · answered: continue as planned · ${clock(min(12))}`]);
    log.push(ev('awaitingHuman', min(20), { ord: 5, gateKind: 'deliver' }), ev('sessionCompleted', min(21)));
    expect(docLines(foldLines(log)).questions).toEqual([]);
  });

  it('reconciling keeps a person’s lines in place and takes back only generated ones', () => {
    expect(reconcileSection('questions', 'Mine\nWaiting on you · Deliver · since 10:00', [])).toBe('Mine');
    expect(reconcileSection('decisions', 'Mine', ['A · answered 10:00'])).toBe('Mine\nA · answered 10:00');
    expect(reconcileSection('decisions', 'Mine\nA · answered 10:00', [])).toBeNull();
    expect(reconcileSection('next', '', [])).toBeNull();
  });
});
