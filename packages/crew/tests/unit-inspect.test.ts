/**
 * The in-flight check on a working step (src/inspect; operator 2026-10-30: "if it's been running long you can have an
 * agent analyze right there, to make sure no tokens are wasted and no problems are occurring"):
 *  - crew's own reading of the step's newest attempt: looping (a fixture loop), stuck, wasteful, progressing;
 *  - the route: a human operator only, audited; a step not working is refused;
 *  - the check run: a seat that is not the step's own, read-only (one neutral no-code phase, no repository, no
 *    roots), its reply parsed; it never steers or stops the run it looks at; its budget and clock bound it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuditLog } from '../src/api/audit.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { isSystemWorkflow } from '../src/core/run-identity.js';
import { LOOP_SAME_FILE_EDITS, readUnit, timeline } from '../src/inspect/reading.js';
import { registerInspectRoutes } from '../src/inspect/routes.js';
import {
  INSPECT_WORKFLOW,
  INSPECT_WORKFLOW_FILE,
  InspectService,
  loadInspectWorkflow,
  parseInspectReply,
  pickInspectSeat,
} from '../src/inspect/service.js';
import { NO_LEARNINGS_WORKFLOWS } from '../src/learnings/service.js';
import { removeScratch } from './setup/scratch.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeScratch(d);
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'unit-inspect-'));
  dirs.push(d);
  return d;
}

const T0 = 1_793_400_000_000;
const MIN = 60_000;
const RUN = 'run-1';

type Ev = Record<string, unknown>;
const dispatched = (at: number, attempt = 0): Ev => ({ type: 'unitDispatched', session: RUN, ord: 2, attempt, ts: at });
let n = 0;
function call(at: number, tool: string, kind: string, target: string, ok: boolean | null, attempt = 0, ms = 2000): Ev[] {
  n += 1;
  const id = `c${n}`;
  const start = { type: 'toolActivity', session: RUN, ord: 2, attempt, ts: at, at, id, state: 'started', kind, tool, target, ok: null, durationMs: null };
  if (ok === null) return [start];
  return [start, { type: 'toolActivity', session: RUN, ord: 2, attempt, ts: at + ms, at: at + ms, id, state: 'finished', kind, tool, target, ok, durationMs: ms }];
}
const said = (at: number, text: string): Ev => ({ type: 'unitOutputDelta', session: RUN, ord: 2, attempt: 0, ts: at, text });
const usage = (at: number, inputTokens: number, outputTokens: number): Ev => ({ type: 'usageProgress', session: RUN, ord: 2, attempt: 0, ts: at, at, inputTokens, outputTokens, costUsd: null });

/** A fixture loop: the seat re-runs the same failing test, edits the same file between runs. */
function loopFixture(): Ev[] {
  const out: Ev[] = [dispatched(T0), said(T0 + 5_000, 'Fixing the JPY rounding in charge.ts.')];
  out.push(...call(T0 + 10_000, 'Read', 'read', 'src/payments/charge.ts', true));
  for (let i = 0; i < 4; i += 1) {
    const t = T0 + 30_000 + i * 60_000;
    out.push(...call(t, 'Edit', 'edit', 'src/payments/charge.ts', true));
    out.push(...call(t + 10_000, 'Bash', 'test', 'npm test -- payments/charge.test.ts', false, 0, 9000));
  }
  return out;
}

describe("crew's own reading of a working step", () => {
  it('reads a fixture loop as looping, with the repeated call as evidence, and suggests a steer', () => {
    const r = readUnit(loopFixture(), 2, T0 + 5 * MIN);
    expect(r.verdict).toBe('looping');
    expect(r.evidence).toEqual(['Ran `npm test -- payments/charge.test.ts` 4 times, 4 failed']);
    expect(r.action).toBe('steer');
    expect(r.note).toMatch(/repeating yourself/);
    expect(r.calls).toBe(9);
    expect(r.edits).toEqual([{ path: 'src/payments/charge.ts', count: 4 }]);
    expect(r.byKind).toEqual({ read: 1, edit: 4, test: 4 });
  });

  it('reads the same file edited many times as looping', () => {
    const ev: Ev[] = [dispatched(T0)];
    for (let i = 0; i < LOOP_SAME_FILE_EDITS; i += 1) {
      ev.push(...call(T0 + i * 20_000, 'Edit', 'edit', `src/a.ts`, true));
      ev.push(...call(T0 + i * 20_000 + 5000, 'Read', 'read', `src/b${i}.ts`, true));
    }
    const r = readUnit(ev, 2, T0 + 3 * MIN);
    expect(r.verdict).toBe('looping');
    expect(r.evidence.join(' ')).toMatch(/src\/a\.ts.* 6 times/);
  });

  it('reads a call open for 10 min as stuck (stop), and a step silent for 5 min as stuck (steer)', () => {
    const hung = [dispatched(T0), ...call(T0 + 10_000, 'Bash', 'test', 'npm test', null)];
    const a = readUnit(hung, 2, T0 + 12 * MIN);
    expect(a.verdict).toBe('stuck');
    expect(a.evidence[0]).toMatch(/`npm test` has been running for 12 min/);
    expect(a.action).toBe('stop');
    const quiet = [dispatched(T0), ...call(T0 + 10_000, 'Read', 'read', 'a.ts', true),
      { type: 'toolActivity', session: RUN, ord: 2, attempt: 0, ts: T0 + 7 * MIN, id: 'working-0', state: 'working', kind: 'working', tool: 'codex', target: 'last output 400 s ago' }];
    const b = readUnit(quiet, 2, T0 + 8 * MIN);
    expect(b.verdict).toBe('stuck');
    expect(b.evidence[0]).toMatch(/^Nothing for 8 min/);
    expect(b.action).toBe('steer');
  });

  it('reads tokens spent with no new words or edits as wasteful', () => {
    const ev = [dispatched(T0), said(T0 + 10_000, 'Looking at the money module.'), usage(T0 + 12_000, 50_000, 500),
      ...call(T0 + 20_000, 'Read', 'read', 'src/money.ts', true),
      usage(T0 + 2 * MIN, 200_000, 1000), usage(T0 + 4 * MIN, 600_000, 2000)];
    const r = readUnit(ev, 2, T0 + 5 * MIN);
    expect(r.verdict).toBe('wasteful');
    expect(r.evidence[0]).toMatch(/^552k tokens in the 5 min since/);
    expect(r.usage).toEqual({ inputTokens: 600_000, outputTokens: 2000, costUsd: null, source: 'live' });
  });

  it('reads a healthy step as progressing, scoped to its newest attempt', () => {
    const ev = [
      // Attempt 0's loop is history once the step is dispatched again.
      ...loopFixture(),
      dispatched(T0 + 10 * MIN, 1),
      ...call(T0 + 10 * MIN + 5000, 'Read', 'read', 'src/money.ts', true, 1),
      ...call(T0 + 10 * MIN + 20_000, 'Edit', 'edit', 'src/money.ts', true, 1),
      ...call(T0 + 10 * MIN + 40_000, 'Bash', 'test', 'npm test -- money', null, 1),
    ];
    const r = readUnit(ev, 2, T0 + 11 * MIN);
    expect(r.attempt).toBe(1);
    expect(r.verdict).toBe('progressing');
    expect(r.action).toBe('let_run');
    expect(r.doing).toBe('Running the tests `npm test -- money`');
    expect(r.evidence[0]).toBe('So far it read 1 file, ran the tests 1 time, edited 1 file');
  });

  it('gives the checking seat a compact timeline, heartbeats folded', () => {
    const lines = timeline([...loopFixture(),
      { type: 'toolActivity', session: RUN, ord: 2, attempt: 0, ts: T0 + 6 * MIN, state: 'working', target: 'last output 15 s ago' },
      { type: 'toolActivity', session: RUN, ord: 2, attempt: 0, ts: T0 + 6 * MIN + 15_000, state: 'working', target: 'last output 30 s ago' }], 2);
    expect(lines[0]).toBe('+5s said: Fixing the JPY rounding in charge.ts.');
    expect(lines.filter((l) => l.includes('quiet:'))).toEqual(['+375s quiet: last output 30 s ago']);
    expect(lines.some((l) => l.includes('done FAILED Bash npm test -- payments/charge.test.ts'))).toBe(true);
  });
});

/** An adapter double: one executing run (step 2 working on claude), a roster, launches and cancels recorded. */
function rig(opts: { roster?: unknown[]; events?: Ev[]; launchFails?: boolean; unitStatus?: string; timeoutMs?: number; onLaunch?: (id: string) => void; reply?: () => Promise<string | null> } = {}) {
  const dir = scratch();
  const launches: LaunchRunInput[] = [];
  const cancels: string[] = [];
  const frames: Array<Record<string, unknown>> = [];
  let reply: string | null = null;
  const views = (): unknown[] => [{
    session: { id: RUN, status: 'executing', unit_ix: 1, problem: 'Fix JPY rounding in charge.ts', title: 'Fix JPY rounding' },
    units: [
      { ord: 1, status: 'done', assigned_cli: 'claude' },
      { ord: 2, status: opts.unitStatus ?? 'distributed', assigned_cli: 'claude', description: 'Build the fix' },
    ],
  }];
  let ids = 0;
  const adapter = {
    sessionsDetail: async () => views(),
    runEvents: async () => opts.events ?? loopFixture(),
    seatsForWorkflow: async () => opts.roster ?? [
      { key: 'claude', cli: 'claude', health: { status: 'active' } },
      { key: 'pi', cli: 'pi', health: { status: 'active' }, council_eligible: false },
      { key: 'codex', cli: 'codex', health: { status: 'active' } },
    ],
    launchRun: async (input: LaunchRunInput) => {
      if (opts.launchFails === true) throw new Error('refused: no seat');
      launches.push(input);
      opts.onLaunch?.(input.sessionId);
      await new Promise((res) => setTimeout(res, 5));
      return input.sessionId;
    },
    cancelRun: async (id: string) => { cancels.push(id); return 'cancelled'; },
  };
  const service = new InspectService({
    adapter,
    replyOf: opts.reply ?? (async () => reply),
    dir: join(dir, 'inspections'),
    broadcast: (f) => frames.push(f),
    log: () => undefined,
    newId: () => `id-${(ids += 1)}`,
    now: () => T0 + 5 * MIN,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { dir, service, launches, cancels, frames, setReply: (r: string | null) => { reply = r; } };
}

describe('the check run', () => {
  it('is read-only by construction: one neutral phase that executes no code, no gate to answer, a system run', () => {
    const raw = JSON.parse(readFileSync(INSPECT_WORKFLOW_FILE, 'utf8')) as { phases: Array<Record<string, unknown>>; required_instruments: unknown[] };
    expect(raw.phases).toHaveLength(1);
    const p = raw.phases[0]!;
    // The engine's write posture: `executes_code: false` + a neutral role = read-only (wicked-core write_posture.rs).
    expect(p).toMatchObject({ role: 'neutral', executes_code: false, gate: 'auto', required_deliverables: [], allowed_skills: [], validator_pin: null });
    expect(String(p['instructions'])).toMatch(/no tool at all/);
    expect(raw.required_instruments).toEqual([]);
    expect(loadInspectWorkflow()).not.toHaveProperty('$comment');
    expect(isSystemWorkflow(INSPECT_WORKFLOW)).toBe(true);
    expect(NO_LEARNINGS_WORKFLOWS.has(INSPECT_WORKFLOW)).toBe(true);
  });

  it('runs on a seat that is not the step\'s own, with no repository and no roots, and the record inline', async () => {
    const r = rig();
    const rec = await r.service.start(RUN, 2, 'human-1');
    expect(rec.state).toBe('checking');
    expect(rec.workerSeat).toBe('claude');
    expect(rec.seat).toBe('codex');
    expect(r.launches).toHaveLength(1);
    const input = r.launches[0]!;
    expect(input.workflow).toBe(INSPECT_WORKFLOW);
    expect(JSON.parse(input.clisJson).map((s: { key: string }) => s.key)).toEqual(['codex']);
    expect(input.repoRef).toBeUndefined();
    expect(input.extraWriteRoots).toBeUndefined();
    expect(input.extraReadRoots).toBeUndefined();
    expect(input.problem).toMatch(/^Check on step 2 of the job "Fix JPY rounding"/);
    expect(input.problem).toContain('Ran `npm test -- payments/charge.test.ts` 4 times, 4 failed');
    expect(input.problem).toContain('done FAILED Bash npm test -- payments/charge.test.ts');
    expect(r.frames.at(-1)).toMatchObject({ type: 'unitInspection', session: RUN, ord: 2 });
    // Asking again while it checks answers the same check.
    expect((await r.service.start(RUN, 2, 'human-1')).id).toBe(rec.id);
    expect(r.launches).toHaveLength(1);
  });

  it('answers with the seat\'s verdict, and never steers, stops or edits the run it looked at', async () => {
    const r = rig();
    const rec = await r.service.start(RUN, 2, 'human-1');
    r.setReply('Reading the record.\n{"verdict": "looping", "doing": "Re-running the charge test after the same edit", "progress": "About halfway: the fix is in, one test still fails", "evidence": ["4 failed runs of the same test"], "action": "steer", "note": "Read the failing assertion before editing again."}');
    r.service.onEvent({ type: 'usageProgress', session: rec.checkRunId, inputTokens: 9000, outputTokens: 300, costUsd: null });
    r.service.onEvent({ type: 'sessionCompleted', session: rec.checkRunId });
    await new Promise((res) => setTimeout(res, 20));
    const done = r.service.list(RUN)[0]!;
    expect(done).toMatchObject({ state: 'done', source: 'seat', verdict: 'looping', action: 'steer', note: 'Read the failing assertion before editing again.', progress: 'About halfway: the fix is in, one test still fails' });
    expect(done.cost).toEqual({ inputTokens: 9000, outputTokens: 300, costUsd: null });
    // Nothing reached the source run: no cancel at all (the check ended on its own), and the adapter has no steer.
    expect(r.cancels).toEqual([]);
  });

  it('stops ITS OWN run at its budget and answers with crew\'s reading, saying why', async () => {
    const r = rig();
    const rec = await r.service.start(RUN, 2, 'human-1');
    r.service.onEvent({ type: 'usageProgress', session: rec.checkRunId, inputTokens: 450_000, outputTokens: 10, costUsd: null });
    await new Promise((res) => setTimeout(res, 20));
    expect(r.cancels).toEqual([rec.checkRunId]);
    expect(r.cancels).not.toContain(RUN);
    const done = r.service.list(RUN)[0]!;
    expect(done).toMatchObject({ state: 'done', source: 'crew', verdict: 'looping' });
    expect(done.why).toMatch(/reached its budget \(400k tokens\)/);
  });

  it('times out to crew\'s reading', async () => {
    const r = rig({ timeoutMs: 10 });
    const rec = await r.service.start(RUN, 2, 'human-1');
    await new Promise((res) => setTimeout(res, 50));
    expect(r.cancels).toEqual([rec.checkRunId]);
    expect(r.service.list(RUN)[0]!.why).toMatch(/took longer than/);
  });

  it('answers with crew\'s reading when no other seat can check, the launch is refused or the reply is unreadable', async () => {
    const solo = rig({ roster: [{ key: 'claude', cli: 'claude', health: { status: 'active' } }, { key: 'codex', cli: 'codex', health: { status: 'benched' } }] });
    const a = await solo.service.start(RUN, 2, 'human-1');
    expect(solo.launches).toEqual([]);
    expect(a).toMatchObject({ state: 'done', source: 'crew', seat: null, verdict: 'looping' });
    expect(a.why).toMatch(/No signed-in seat other than the step's own/);

    const refused = rig({ launchFails: true });
    const b = await refused.service.start(RUN, 2, 'human-1');
    expect(b).toMatchObject({ state: 'done', source: 'crew' });
    expect(b.why).toMatch(/could not start on codex/);

    const garbled = rig();
    const c = await garbled.service.start(RUN, 2, 'human-1');
    garbled.setReply('I think it is fine.');
    garbled.service.onEvent({ type: 'sessionCompleted', session: c.checkRunId });
    await new Promise((res) => setTimeout(res, 20));
    expect(garbled.service.list(RUN)[0]!.why).toMatch(/could not be read/);
  });

  it('refuses a step that is not working now', async () => {
    const r = rig({ unitStatus: 'done' });
    await expect(r.service.start(RUN, 2, 'human-1')).rejects.toMatchObject({ status: 409, code: 'not_working' });
    await expect(r.service.start(RUN, 9, 'human-1')).rejects.toMatchObject({ status: 404 });
  });

  it('picks seats away from the worker, in order, and parses only a well-formed verdict', () => {
    const roster = [{ key: 'codex' }, { key: 'claude#2', cli: 'claude' }, { key: 'pi', signed_in: false }];
    expect(pickInspectSeat(roster, 'claude')?.['key']).toBe('codex');
    expect(pickInspectSeat(roster, 'codex')?.['key']).toBe('claude#2');
    expect(pickInspectSeat([{ key: 'claude' }], 'claude#3')).toBeNull();
    expect(parseInspectReply('{"verdict":"spinning"}')).toBeNull();
    expect(parseInspectReply('x {"verdict":"stuck","action":"stop","note":"n","evidence":[1,"a"]} y')).toEqual({
      verdict: 'stuck', doing: null, progress: null, evidence: ['a'], action: 'stop', note: null,
    });
  });
});

describe('POST /runs/:id/units/:ord/inspect', () => {
  async function app(r: ReturnType<typeof rig>, audit: AuditLog) {
    const a = Fastify({ logger: false });
    a.decorateRequest('actor', null as unknown as never);
    a.addHook('onRequest', async (req) => {
      const h = req.headers['x-actor'];
      if (typeof h === 'string') {
        const [kind, trust] = h.split(':');
        (req as unknown as { actor: unknown }).actor = { id: `${kind}-1`, kind, trust };
      }
    });
    registerInspectRoutes(a, { service: r.service, audit });
    await a.ready();
    return a;
  }

  it('is a human operator\'s alone, and every check is audited', async () => {
    const r = rig();
    const audit = new AuditLog(join(r.dir, 'audit.log'));
    const a = await app(r, audit);
    for (const who of ['agent:operator', 'system:operator', 'human:viewer']) {
      const res = await a.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/units/2/inspect`, headers: { 'x-actor': who } });
      expect(res.statusCode, who).toBe(403);
    }
    expect(r.launches).toEqual([]);
    const ok = await a.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/units/2/inspect`, headers: { 'x-actor': 'human:operator' } });
    expect(ok.statusCode).toBe(202);
    const { inspection } = ok.json() as { inspection: { id: string; seat: string; checkRunId: string } };
    expect(inspection.seat).toBe('codex');
    await audit.flush();
    const lines = await audit.readAll({ action: 'unit.inspected' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: 'unit.inspected', runId: RUN, actor: { id: 'human-1', kind: 'human' } });
    expect(lines[0]!.detail).toMatchObject({ ord: 2, inspection: inspection.id, seat: 'codex', checkRunId: inspection.checkRunId });
    const list = await a.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/units/2/inspections` });
    expect((list.json() as { inspections: unknown[] }).inspections).toHaveLength(1);
    const bad = await a.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/units/two/inspect`, headers: { 'x-actor': 'human:operator' } });
    expect(bad.statusCode).toBe(400);
    await a.close();
  });

  it('says 409 for a step that is not working, and audits nothing', async () => {
    const r = rig({ unitStatus: 'done' });
    const audit = new AuditLog(join(r.dir, 'audit.log'));
    const a = await app(r, audit);
    const res = await a.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/units/2/inspect`, headers: { 'x-actor': 'human:operator' } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('not_working');
    await audit.flush();
    expect(await audit.readAll({ action: 'unit.inspected' })).toEqual([]);
    await a.close();
  });
});

describe('xreview on #1233', () => {
  it('counts an edit seen by the stream and by git once, and needs 6 edits to one file to call it a loop', () => {
    const ev: Ev[] = [dispatched(T0)];
    for (let i = 0; i < 3; i += 1) {
      ev.push(...call(T0 + i * 60_000, 'Edit', 'edit', 'src/a.ts', true));
      ev.push({ type: 'powerActivity', session: RUN, ord: 2, turn: 1, ts: T0 + i * 60_000 + 30_000, kind: 'edit', path: 'src/a.ts', added: 3, removed: 1 });
    }
    for (let i = 0; i < 2; i += 1) ev.push(...call(T0 + 200_000 + i * 1000, 'Edit', 'edit', 'src/a.ts', true));
    const r = readUnit(ev, 2, T0 + 4 * MIN);
    expect(r.edits).toEqual([{ path: 'src/a.ts', count: 5 }]);
    expect(r.verdict).toBe('progressing');
    // Git's edits stand in only where the stream said nothing of its edits.
    const gitOnly = readUnit([dispatched(T0), { type: 'powerActivity', session: RUN, ord: 2, turn: 1, ts: T0 + 1000, kind: 'edit', path: 'src/b.ts' }], 2, T0 + MIN);
    expect(gitOnly.edits).toEqual([{ path: 'src/b.ts', count: 1 }]);
  });

  it('does not call the tokens of the turn that made the last output waste', () => {
    // 420k by the time it last said something; the turn's own total lands 200 ms later; a long quiet build follows.
    const ev = [dispatched(T0), usage(T0 + MIN, 100_000, 100), said(T0 + 10 * MIN, 'Running the full build now.'),
      usage(T0 + 10 * MIN + 200, 520_000, 2000)];
    expect(readUnit(ev, 2, T0 + 13 * MIN + 30_000).verdict).toBe('progressing');
  });

  it('a second ask while one is starting joins it: one check run, one record', async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.service.start(RUN, 2, 'human-1'), r.service.start(RUN, 2, 'human-2')]);
    expect(a.id).toBe(b.id);
    expect(r.launches).toHaveLength(1);
  });

  it('a check run that ends before its launch answers is still this record\'s', async () => {
    let svc: InspectService | null = null;
    const r = rig({ onLaunch: (id) => { svc!.onEvent({ type: 'sessionCompleted', session: id }); } });
    svc = r.service;
    r.setReply('{"verdict":"progressing","doing":"d","progress":"p","evidence":[],"action":"let_run","note":""}');
    await r.service.start(RUN, 2, 'human-1');
    await new Promise((res) => setTimeout(res, 30));
    expect(r.service.list(RUN)[0]).toMatchObject({ state: 'done', source: 'seat', verdict: 'progressing', action: 'let_run' });
  });

  it('a read while the answer is being read is not taken for a restart', async () => {
    let release: (v: string) => void = () => undefined;
    const r = rig({ reply: () => new Promise<string>((res) => { release = res; }) });
    const rec = await r.service.start(RUN, 2, 'human-1');
    r.service.onEvent({ type: 'sessionCompleted', session: rec.checkRunId });
    await new Promise((res) => setTimeout(res, 5));
    expect(r.service.settle(RUN)[0]!.state).toBe('checking');
    expect((await r.service.start(RUN, 2, 'human-1')).id).toBe(rec.id);
    expect(r.launches).toHaveLength(1);
    release('{"verdict":"stuck","action":"stop","evidence":["x"]}');
    await new Promise((res) => setTimeout(res, 20));
    expect(r.service.list(RUN)[0]).toMatchObject({ state: 'done', source: 'seat', verdict: 'stuck', action: 'stop' });
  });

  it('at boot, a check a restart interrupted is cancelled and answered with crew\'s reading', async () => {
    const r = rig();
    const rec = await r.service.start(RUN, 2, 'human-1');
    // A new daemon over the same directory.
    const cancels: string[] = [];
    const fresh = new InspectService({
      adapter: { sessionsDetail: async () => [], runEvents: async () => [], seatsForWorkflow: async () => [], launchRun: async () => 'x', cancelRun: async (id: string) => { cancels.push(id); } },
      replyOf: async () => null, dir: join(r.dir, 'inspections'), broadcast: () => undefined, log: () => undefined, newId: () => 'n',
    });
    await fresh.recover();
    expect(cancels).toEqual([rec.checkRunId]);
    expect(fresh.list(RUN)[0]).toMatchObject({ state: 'done', source: 'crew' });
    expect(fresh.list(RUN)[0]!.why).toMatch(/restarted during the check, so crew stopped it/);
  });

  it('a malformed action or a steer with no note is not an answer; prose with a stray brace hides nothing', () => {
    expect(parseInspectReply('{"verdict":"stuck","action":"stpo"}')).toBeNull();
    expect(parseInspectReply('{"verdict":"looping","action":"steer","note":""}')).toBeNull();
    expect(parseInspectReply('{"verdict":"stuck"}')).toBeNull();
    const reply = 'It is stuck on `if (amount < 0) {` in charge.ts.\n{"verdict":"looping","doing":"d","evidence":[],"action":"steer","note":"Stop editing charge.ts; read the test."}';
    expect(parseInspectReply(reply)).toMatchObject({ verdict: 'looping', action: 'steer', note: 'Stop editing charge.ts; read the test.' });
  });
});

