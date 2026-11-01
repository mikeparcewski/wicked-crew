// Run learnings (operator 2026-10-30: "with all the run activity, no memories or learnings are being saved").
// A run proposes what it learned to the approve queue: template learnings at its checkpoints, the rest
// distilled at its end by ONE seat that did not build it (raw when no such seat can run). Everything is a
// `memory` PROPOSAL attributed to the source run; nothing is written without a person's approval; an
// approved learning rides in the next matching launch's brief and never in its PR text.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { SessionView } from 'wicked-crew-api-types';
import { extractLearnings, creatorSeats } from '../src/learnings/extract.js';
import {
  DISTILL_WORKFLOW,
  FILED_FILE,
  HANDOFF_FILE,
  MAX_END_LEARNINGS,
  OUT_DIR,
  REPORT_FILE,
  RunLearningsService,
  checkedCount,
  loadDistillWorkflow,
  parseDistillReport,
  runLearningsMode,
  type ProposalRow,
  type SubmitArgs,
} from '../src/learnings/service.js';
import { RUN_LEARNINGS_OPEN, appliesTo, memoryRows, recallLearnings, stripRunLearnings, withRunLearnings } from '../src/learnings/recall.js';
import { learningSubmitEnv, proposalRows } from '../src/learnings/estate.js';
import { registerRoutes } from '../src/api/routes.js';
import type { RuntimeDeps } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import type { LooseEvent } from '../src/insights/run-facts.js';
import { removeScratch } from './setup/scratch.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeScratch(d);
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'run-learnings-'));
  dirs.push(d);
  return d;
};
const settle = () => new Promise((r) => setTimeout(r, 20));

/** A power-mode bug run shaped like the rig's acf30461: a flaky test, an override, a QE skip, notes, a steer. */
function runView(over: { id?: string; status?: string; workflow?: string; units?: unknown[] } = {}): SessionView {
  return {
    session: {
      id: over.id ?? 'run-1',
      status: over.status ?? 'completed',
      workflow_id: over.workflow ?? 'bug',
      problem: 'Fix acme-core issue #1166\n\nmore',
      title: 'Fix acme-core issue #1166',
      repo_ref: 'acme-core',
      project_id: 'proj-a',
      team: { primary: { cli: 'claude' } },
    },
    units: over.units ?? [
      {
        ord: 2,
        role: 'creator',
        assigned_cli: 'claude',
        repo_checks: {
          checks: [
            { name: 'test', decision: { outcome: 'pass' }, flaky_ids: ['FAIL tests/bridge-reaper.test.ts > finds a child'] },
            {
              name: 'test-full',
              decision: { outcome: 'base_red_unseparated', reason: 'base red, cannot separate' },
              bound_note: '3600s × 3.00 (1-min load 126.9 / 14 cpus)',
              failure_ids: ['test seat_login::tests::a_due_record_fails'],
              base: { run: { failure_ids: ['test seat_login::tests::a_due_record_fails'] } },
            },
          ],
        },
        operator_rulings: [
          {
            action: 'operator_judgment',
            text: 'floor overridden by operator (local (human)): These failures are not this change\'s. The seat_login tests are load-bound: they time out when the host is loaded.',
          },
        ],
      },
      {
        ord: 4,
        role: 'evaluator',
        assigned_cli: 'pi',
        qe_review: { outcome: 'inconclusive', reason: 'its seat has no wicked-nopush git helper, so the deliver_lift fixtures fail at setup', attempts: [{ seat: 'pi' }] },
      },
    ],
  } as unknown as SessionView;
}

const events: LooseEvent[] = [
  {
    type: 'workerMessageQueued',
    ord: 2,
    message:
      "Operator steering from the job's working document (version 1, by the operator). Its Constraints and steering is standing: follow it.\nIt adds to your brief. It does not answer, skip or change any gate.\n- Constraints and steering: Every refusal line starts with \"WICKED-RETRY none\" and names the rule.\n[working-doc 9397a34b:3d104946]",
  },
  { type: 'workerMessageQueued', ord: 2, message: 'retry the unit' },
  {
    type: 'powerWorkingNotes',
    ord: 2,
    seat: 'claude',
    decisions: [{ text: 'any git failure inside the helper keeps git\'s tree', why: 'git\'s clean result is the safe fallback and the lift must not strand.' }],
  },
  { type: 'gateEvaluated', ord: 3, agentVerdict: 'fail', agentReasoning: 'The change edits CHANGELOG.md by hand where the release tooling owns it.', judgeCli: 'codex' },
  { type: 'gateEvaluated', ord: 3, agentVerdict: 'pass', agentReasoning: 'PASS — fine.' },
];

describe('extractLearnings: what a run\'s record says it learned', () => {
  it('words templates from structured fields and keeps the rest as material', () => {
    const c = extractLearnings(runView(), events);
    const templates = c.filter((x) => x.form === 'template');
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ kind: 'gotcha', source: 'repo_checks' });
    expect(templates[0]!.content).toContain('In acme-core, the test `tests/bridge-reaper.test.ts > finds a child` (repo check `test`) is flaky');
    const material = c.filter((x) => x.form === 'material');
    expect(material.map((m) => m.source).sort()).toEqual(['operator_ruling', 'qe_review', 'repo_checks', 'review', 'steer', 'working_notes']);
    const ruling = material.find((m) => m.source === 'operator_ruling')!;
    expect(ruling.content).toMatch(/^The operator overrode a failed check: These failures are not this change's\./u);
    const steer = material.find((m) => m.source === 'steer')!;
    expect(steer.content).toContain('Every refusal line starts with "WICKED-RETRY none"');
    expect(steer.content).not.toMatch(/working-doc|It adds to your brief/u);
    expect(material.find((m) => m.source === 'working_notes')!.content).toMatch(/^Decision: any git failure .* Because: git's clean result/u);
    expect(material.find((m) => m.source === 'review')!).toMatchObject({ kind: 'pattern', cli: 'codex' });
    expect(material.find((m) => m.source === 'qe_review')!).toMatchObject({ cli: 'pi' });
    // A plain "retry the unit" is not the operator's steer, and a PASS verdict flags nothing.
    expect(c.filter((x) => x.source === 'steer')).toHaveLength(1);
    expect(c.filter((x) => x.source === 'review')).toHaveLength(1);
  });

  it('is stable: the same record yields the same keys (a checkpoint and the end agree)', () => {
    expect(extractLearnings(runView(), events).map((c) => c.key)).toEqual(extractLearnings(runView(), events).map((c) => c.key));
  });

  it('names the builders: the power lead and every creator unit', () => {
    expect(creatorSeats(runView()).sort()).toEqual(['claude']);
  });
});

function harness(opts: { seats?: unknown[]; mode?: 'distill' | 'extract'; proposals?: ProposalRow[]; memories?: string[]; launchFails?: boolean; cancelFails?: number; view?: SessionView } = {}) {
  const dir = scratch();
  const view = opts.view ?? runView();
  const submitted: Array<{ runId: string; agent: string; args: SubmitArgs }> = [];
  const queue: ProposalRow[] = [...(opts.proposals ?? [])];
  const launches: LaunchRunInput[] = [];
  const cancels: string[] = [];
  let refusals = opts.cancelFails ?? 0;
  let n = 0;
  const views: SessionView[] = [view];
  const svc = new RunLearningsService({
    adapter: {
      sessionsDetail: async () => views,
      runEvents: async () => events,
      seatsForWorkflow: async () => opts.seats ?? [{ key: 'claude' }, { key: 'codex', council_eligible: true }],
      launchRun: async (input) => {
        if (opts.launchFails) throw new Error('no capacity');
        launches.push(input);
        return input.sessionId;
      },
      cancelRun: async (runId) => {
        cancels.push(runId);
        if (refusals > 0) {
          refusals -= 1;
          throw new Error('the engine refused the stop');
        }
        return 'cancelled';
      },
    },
    submit: async (runId, agent, args) => {
      submitted.push({ runId, agent, args });
      const id = `p${queue.length + 1}`;
      queue.push({ id, kind_type: args.kind_type, state: 'pending', payload: args.payload, facets: args.facets, provenance: { run_id: runId, run_agent: agent, run_unit: '0' } });
      return id;
    },
    listProposals: async () => queue,
    listMemoryContents: async () => opts.memories ?? [],
    learningsDir: dir,
    mode: opts.mode ?? 'distill',
    log: () => undefined,
    newRunId: () => `distill-${++n}`,
  });
  return { svc, dir, submitted, queue, launches, views, cancels };
}

describe('RunLearningsService: proposals, never writes', () => {
  it('files the template learnings at a checkpoint, attributed to the run, and nothing else yet', async () => {
    const h = harness();
    h.svc.onEvent({ type: 'powerCheckpointReached', session: 'run-1' });
    await settle();
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toMatchObject({ runId: 'run-1', agent: 'crew', args: { kind_type: 'memory', facets: { repo: 'acme-core', project: 'proj-a' }, payload: { capture: 'gotcha', tier: 'semantic', reach: 'project' } } });
    expect(h.launches).toHaveLength(0);
    // A second checkpoint proposes nothing twice.
    h.svc.onEvent({ type: 'unitDone', session: 'run-1' });
    await settle();
    expect(h.submitted).toHaveLength(1);
  });

  it('at the end hands the evidence to ONE seat that did not build the run, then files what it distilled', async () => {
    const h = harness();
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    expect(h.launches).toHaveLength(1);
    const launch = h.launches[0]!;
    expect(launch.workflow).toBe(DISTILL_WORKFLOW);
    expect(JSON.parse(launch.clisJson)).toEqual([{ key: 'codex', council_eligible: true }]); // claude built it
    expect(launch.repoRef).toBeUndefined();
    expect(launch.projectId).toBe('proj-a');
    const runDir = join(h.dir, 'run-1');
    expect(launch.extraWriteRoots).toEqual([join(runDir, OUT_DIR)]);
    const handoff = JSON.parse(readFileSync(join(runDir, HANDOFF_FILE), 'utf8')) as { evidence: Array<{ id: string; text: string }>; already_proposed: string[]; source_run: string };
    expect(handoff.source_run).toBe('run-1');
    expect(handoff.evidence.length).toBe(6);
    expect(handoff.already_proposed.some((t) => t.includes('is flaky'))).toBe(true);
    // Only the template went in at the end sweep; the material waits for the seat.
    expect(h.submitted.map((s) => s.args.payload['capture'])).toEqual(['gotcha']);
    expect((await h.svc.view('run-1')).distilling).toBe(true);

    writeFileSync(
      join(runDir, OUT_DIR, REPORT_FILE),
      JSON.stringify({
        learnings: [
          { kind: 'gotcha', content: 'In acme-core, the seat_login tests time out when the host is loaded; a floor failure in them is not evidence against a change.', evidence: ['e1'] },
          { kind: 'gotcha', content: 'short' },
          { kind: 'steering', content: 'In wicked-crew, every test-related refusal line starts with "WICKED-RETRY none" and names the rule that refused.' },
        ],
      }),
    );
    h.svc.onEvent({ type: 'sessionCompleted', session: 'distill-1' });
    await settle();
    const distilled = h.submitted.slice(1);
    expect(distilled).toHaveLength(2);
    for (const s of distilled) expect(s).toMatchObject({ runId: 'run-1', agent: 'codex', args: { kind_type: 'memory' } });
    expect(existsSync(join(runDir, FILED_FILE))).toBe(true);
    const v = await h.svc.view('run-1');
    expect(v).toMatchObject({ runId: 'run-1', proposed: 3, pending: 3, approved: 0, distilling: false });

    // A resume's second terminal frame files nothing and launches nothing more.
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    h.svc.onEvent({ type: 'sessionCompleted', session: 'distill-1' });
    await settle();
    expect(h.submitted).toHaveLength(3);
    expect(h.launches).toHaveLength(1);
  });

  it('files the evidence raw (capped) when no seat other than the builder can distil it', async () => {
    const h = harness({ seats: [{ key: 'claude' }, { key: 'codex', council_eligible: false }, { key: 'pi', health: { status: 'inactive' } }] });
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    expect(h.launches).toHaveLength(0);
    const end = h.submitted.slice(1);
    expect(end).toHaveLength(MAX_END_LEARNINGS);
    expect(end.every((s) => s.agent === 'crew')).toBe(true);
    // The operator's own words first.
    expect(String(end[0]!.args.payload['content'])).toMatch(/^The operator overrode a failed check/u);
    expect(String(end[1]!.args.payload['content'])).toMatch(/^The operator steered the work/u);
  });

  it('files raw too when the distil launch is refused, in extract mode, and when the seat writes no usable report', async () => {
    const refused = harness({ launchFails: true });
    refused.svc.onEvent({ type: 'sessionFailed', session: 'run-1' });
    await settle();
    expect(refused.submitted.length).toBe(1 + MAX_END_LEARNINGS);

    const extract = harness({ mode: 'extract' });
    extract.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    expect(extract.launches).toHaveLength(0);
    expect(extract.submitted.length).toBe(1 + MAX_END_LEARNINGS);

    const silent = harness();
    silent.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    silent.svc.onEvent({ type: 'sessionFailed', session: 'distill-1' });
    await settle();
    expect(silent.submitted.length).toBe(1 + MAX_END_LEARNINGS);
    expect(silent.submitted.slice(1).every((s) => s.agent === 'crew')).toBe(true);
  });

  it('never proposes what the queue or the memory store already holds, whichever run filed it', async () => {
    const flaky = extractLearnings(runView(), events).find((c) => c.form === 'template')!.content;
    const h = harness({
      proposals: [{ id: 'old', kind_type: 'memory', state: 'approved', payload: { content: flaky.toUpperCase() }, facets: {}, provenance: { run_id: 'run-0' } }],
    });
    h.svc.onEvent({ type: 'gateDecided', session: 'run-1' });
    await settle();
    expect(h.submitted).toHaveLength(0);
    const m = harness({ memories: [flaky] });
    m.svc.onEvent({ type: 'gateDecided', session: 'run-1' });
    await settle();
    expect(m.submitted).toHaveLength(0);
  });

  it('learns nothing from runs that capture, review or set up, and nothing when switched off', async () => {
    for (const workflow of [DISTILL_WORKFLOW, 'capture-learnings', 'review-recent-work', 'onboarding']) {
      const h = harness({ view: runView({ workflow }) });
      h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
      await settle();
      expect(h.submitted, workflow).toHaveLength(0);
      expect(h.launches, workflow).toHaveLength(0);
    }
    expect(runLearningsMode({ WICKED_CREW_RUN_LEARNINGS: 'off' })).toBe('off');
    expect(runLearningsMode({})).toBe('distill');
    expect(runLearningsMode({ VITEST: 'true' })).toBe('off');
    expect(runLearningsMode({ VITEST: 'true', WICKED_CREW_RUN_LEARNINGS: 'extract' })).toBe('extract');
  });

  it('an uneventful run proposes nothing and launches no seat', async () => {
    const quiet = runView({ units: [{ ord: 1, role: 'creator', assigned_cli: 'claude' }] });
    const h = harness({ view: quiet });
    const svc = h.svc as unknown as { deps: { adapter: { runEvents: () => Promise<LooseEvent[]> } } };
    svc.deps.adapter.runEvents = async () => [];
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    expect(h.submitted).toHaveLength(0);
    expect(h.launches).toHaveLength(0);
  });
});

describe('RunLearningsService under overlap, failure and restart (xreview on crew#1227)', () => {
  it('overlapping terminal frames of a distil run file its report once', async () => {
    const h = harness();
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    writeFileSync(join(h.dir, 'run-1', OUT_DIR, REPORT_FILE), JSON.stringify({ learnings: [{ kind: 'gotcha', content: 'In acme-core, the seat_login tests time out when the host is loaded; re-run before debugging.' }] }));
    h.svc.onEvent({ type: 'sessionCompleted', session: 'distill-1' });
    h.svc.onEvent({ type: 'sessionFailed', session: 'distill-1' });
    h.svc.onEvent({ type: 'runCancelled', session: 'distill-1' });
    await settle();
    expect(h.submitted.filter((x) => x.agent === 'codex')).toHaveLength(1);
  });

  it('two runs that hit the same flaky test propose it once', async () => {
    const h = harness();
    h.views.push(runView({ id: 'run-2' }));
    h.svc.onEvent({ type: 'unitDone', session: 'run-1' });
    h.svc.onEvent({ type: 'unitDone', session: 'run-2' });
    await settle();
    expect(h.submitted).toHaveLength(1);
  });

  it('a submit that fails leaves the end retryable, and recovery files it without doubling what landed', async () => {
    const h = harness({ mode: 'extract' });
    const svc = h.svc as unknown as { deps: { submit: (...a: unknown[]) => Promise<string | null> } };
    const real = svc.deps.submit;
    let calls = 0;
    svc.deps.submit = async (...a: unknown[]) => (++calls === 3 ? Promise.reject(new Error('estate down')) : real(...a));
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    expect(existsSync(join(h.dir, 'run-1', FILED_FILE))).toBe(false);
    const landed = h.submitted.length;
    expect(landed).toBe(MAX_END_LEARNINGS); // 1 template + 4 of 5 raw; one failed
    svc.deps.submit = real;
    await h.svc.recover();
    expect(existsSync(join(h.dir, 'run-1', FILED_FILE))).toBe(true);
    const contents = h.submitted.map((x) => x.args.payload['content']);
    expect(new Set(contents).size).toBe(contents.length);
  });

  it('after a restart: a handoff with no launch is ended again; a distil run that ended while down is reconciled', async () => {
    const h = harness();
    // The daemon stopped right after the directory was made.
    mkdirSync(join(h.dir, 'run-1'), { recursive: true });
    await h.svc.recover();
    expect(h.launches).toHaveLength(1);

    // A fresh service (the restart) over the same directory: the distil run finished while it was down.
    writeFileSync(join(h.dir, 'run-1', OUT_DIR, REPORT_FILE), JSON.stringify({ learnings: [{ kind: 'pattern', content: 'In acme-core, CHANGELOG.md is owned by the release tooling; a change never edits it by hand.' }] }));
    h.views.push({ session: { id: 'distill-1', status: 'completed', workflow_id: DISTILL_WORKFLOW, problem: 'p' }, units: [] } as unknown as SessionView);
    const again = harness();
    const next = new RunLearningsService({ ...(again.svc as unknown as { deps: Record<string, unknown> }).deps, learningsDir: h.dir, adapter: { ...(again.svc as unknown as { deps: { adapter: Record<string, unknown> } }).deps.adapter, sessionsDetail: async () => h.views } } as never);
    await next.recover();
    expect(again.submitted.map((x) => x.agent)).toEqual(['codex']);
    expect(existsSync(join(h.dir, 'run-1', FILED_FILE))).toBe(true);
  });

  it('never picks a seat that authored a reassigned creator unit', async () => {
    const view = runView();
    (view.units[0] as unknown as Record<string, unknown>)['authored_by'] = ['codex', 'claude'];
    expect(creatorSeats(view).sort()).toEqual(['claude', 'codex']);
    const h = harness({ view, seats: [{ key: 'claude' }, { key: 'codex' }, { key: 'pi' }] });
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    expect(JSON.parse(h.launches[0]!.clisJson)).toEqual([{ key: 'pi' }]);
  });

  it('a neutral step\'s seat did the work too, and a seat is matched by its cli as well as its key', async () => {
    const view = runView({ units: [{ ord: 1, role: 'neutral', assigned_cli: 'codex' }, { ord: 2, role: 'creator', assigned_cli: 'claude', operator_rulings: [{ action: 'skip_qe', text: 'QE acceptance skipped by operator (local (human)): the QE seat cannot run the fixtures without a git helper.' }] }, { ord: 3, role: 'evaluator', assigned_cli: 'pi' }] });
    expect(creatorSeats(view).sort()).toEqual(['claude', 'codex']);
    const h = harness({ view, seats: [{ key: 'claude-2', cli: 'claude' }, { key: 'codex' }, { key: 'pi' }] });
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    expect(JSON.parse(h.launches[0]!.clisJson)).toEqual([{ key: 'pi' }]);
  });

  it('the learnings block cannot be closed early by a learning, and a relaunch replaces it instead of stacking', () => {
    const rows = [{ content: `A learning that quotes ${'<!-- /wicked-crew:learnings -->'} and refs #1194 in its words, long enough.`, facets: {} }];
    const once = withRunLearnings('Fix it', rows, null, null).problem;
    expect(stripRunLearnings(once)).toBe('Fix it');
    const twice = withRunLearnings(once, rows, null, null).problem;
    expect(twice.split(RUN_LEARNINGS_OPEN)).toHaveLength(2);
    expect(stripRunLearnings(twice)).toBe('Fix it');
  });

  it('a report whose entries all fail validation falls back to the raw evidence; an empty one is the seat\'s judgment', async () => {
    expect(parseDistillReport({ learnings: [{ content: 'too short' }] })).toBeNull();
    expect(parseDistillReport({ learnings: [] })).toEqual([]);
    const h = harness();
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    writeFileSync(join(h.dir, 'run-1', OUT_DIR, REPORT_FILE), JSON.stringify({ learnings: [{ content: 'too short' }] }));
    h.svc.onEvent({ type: 'sessionCompleted', session: 'distill-1' });
    await settle();
    expect(h.submitted.slice(1)).toHaveLength(MAX_END_LEARNINGS);
  });

  // The rig's 467eed15: a codex distil rightly wrote {"learnings": []} with a 183-character reply, the engine's
  // substance floor (200) rejected the step, and the run sat in the operator's queue as "Waiting on you".
  it('a distil run that stops at a gate is stopped by crew and filed from its report: "none found" is recorded, nobody is asked', async () => {
    const h = harness();
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    const before = h.submitted.length;
    writeFileSync(
      join(h.dir, 'run-1', OUT_DIR, REPORT_FILE),
      JSON.stringify({
        learnings: [],
        checked: [
          { evidence: 'e1', kept: false, why: 'already proposed' },
          { evidence: 'e2', kept: false, why: 'only true of this change' },
          { evidence: 'e2', kept: false, why: 'the same item again' },
          { evidence: 'e99', kept: false, why: 'an item the handoff never held' },
        ],
      }),
    );
    h.svc.onEvent({
      type: 'awaitingHuman',
      session: 'distill-1',
      gateKind: 'escalation',
      prompt: 'Unit 1 failed its deterministic floor (substance): phase produced no reviewable substance',
    } as never);
    await settle();
    expect(h.cancels).toEqual(['distill-1']);
    expect(h.submitted.length).toBe(before); // nothing raw: the seat's empty list is its judgment
    const filed = JSON.parse(readFileSync(join(h.dir, 'run-1', FILED_FILE), 'utf8')) as Record<string, unknown>;
    expect(filed).toMatchObject({ distilled: true, distillRunId: 'distill-1', seat: 'codex', filed: 0, found: 0, noneFound: true, checked: 2 });
    expect(String(filed['stopped'])).toMatch(/^stopped at escalation: Unit 1 failed its deterministic floor \(substance\)/u);
    expect((await h.svc.view('run-1')).distilling).toBe(false);
    // The record was replaced whole (no temp file left), and still names its run.
    expect(readdirSync(join(h.dir, 'run-1')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(h.dir, 'run-1', 'distill.json'), 'utf8'))).toMatchObject({ distillRunId: 'distill-1', seat: 'codex' });
    // The stop's own end frame files nothing more.
    h.svc.onEvent({ type: 'runCancelled', session: 'distill-1' });
    await settle();
    expect(h.submitted.length).toBe(before);
  });

  it('a distil whose seat crashed before writing a report is stopped too, and the evidence is filed raw', async () => {
    const h = harness({ cancelFails: 1 });
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    h.svc.onEvent({ type: 'awaitingHuman', session: 'distill-1', gateKind: 'escalation', prompt: 'worker failed' } as never);
    await settle();
    expect(h.cancels).toEqual(['distill-1']); // a refused stop is logged; the run is filed either way
    expect(h.submitted.slice(1)).toHaveLength(MAX_END_LEARNINGS);
    expect(h.submitted.slice(1).every((s) => s.agent === 'crew')).toBe(true);
    expect(JSON.parse(readFileSync(join(h.dir, 'run-1', FILED_FILE), 'utf8'))).toMatchObject({ distilled: false, stopped: 'stopped at escalation: worker failed' });

    // xreview on #1253: the refused stop is not abandoned. The run is still parked, so the next recovery stops it
    // again and files nothing twice; once it is terminal, recovery leaves it be.
    const filed = h.submitted.length;
    h.views.push({ session: { id: 'distill-1', status: 'awaiting_human', workflow_id: DISTILL_WORKFLOW, problem: 'p' }, units: [] } as unknown as SessionView);
    await h.svc.recover();
    expect(h.cancels).toEqual(['distill-1', 'distill-1']);
    expect(h.submitted.length).toBe(filed);
    (h.views[h.views.length - 1]!.session as unknown as Record<string, unknown>)['status'] = 'cancelled';
    await h.svc.recover();
    expect(h.cancels).toHaveLength(2);
  });

  it('recovery files a stopped distil that was not filed yet, whether its second stop takes or is refused (xreview r2 on #1253)', async () => {
    for (const refusedAgain of [false, true]) {
      // The stop was recorded, then filing failed (estate down) and the daemon restarted with the run still parked.
      const h = harness({ cancelFails: refusedAgain ? 2 : 1 });
      const svc = h.svc as unknown as { deps: { submit: (...a: unknown[]) => Promise<string | null> } };
      const real = svc.deps.submit;
      h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
      await settle();
      writeFileSync(join(h.dir, 'run-1', OUT_DIR, REPORT_FILE), JSON.stringify({ learnings: [{ kind: 'gotcha', content: 'In acme-core, the seat_login tests time out when the host is loaded; re-run before debugging.' }] }));
      svc.deps.submit = async () => Promise.reject(new Error('estate down'));
      h.svc.onEvent({ type: 'awaitingHuman', session: 'distill-1', gateKind: 'escalation', prompt: 'substance' } as never);
      await settle();
      expect(existsSync(join(h.dir, 'run-1', FILED_FILE))).toBe(false);
      svc.deps.submit = real;
      // No end frame reaches this daemon: the parked status is all recovery sees.
      h.views.push({ session: { id: 'distill-1', status: 'awaiting_human', workflow_id: DISTILL_WORKFLOW, problem: 'p' }, units: [] } as unknown as SessionView);
      await h.svc.recover();
      expect(h.cancels).toEqual(['distill-1', 'distill-1']);
      expect(h.submitted.filter((x) => x.agent === 'codex')).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(h.dir, 'run-1', FILED_FILE), 'utf8'))).toMatchObject({ distilled: true, filed: 1, stopped: 'stopped at escalation: substance' });
    }
  });

  it('recovery never stops a distil that was parked before crew stopped any (it stays the operator\'s)', async () => {
    const h = harness();
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    h.views.push({ session: { id: 'distill-1', status: 'awaiting_human', workflow_id: DISTILL_WORKFLOW, problem: 'p' }, units: [] } as unknown as SessionView);
    await h.svc.recover();
    expect(h.cancels).toEqual([]);
    expect(existsSync(join(h.dir, 'run-1', FILED_FILE))).toBe(false);
  });

  it('a gate on any run that is not a distil is never touched', async () => {
    const h = harness();
    h.svc.onEvent({ type: 'awaitingHuman', session: 'run-1', gateKind: 'escalation' } as never);
    h.svc.onEvent({ type: 'awaitingHuman', session: 'someone-else', gateKind: 'plan_approval' } as never);
    await settle();
    expect(h.cancels).toEqual([]);
    expect(h.submitted).toHaveLength(0);
  });

  it('an unreadable learnings directory is logged, never thrown into the event pump', async () => {
    const file = join(scratch(), 'not-a-dir');
    writeFileSync(file, 'x');
    const logs: string[] = [];
    const h = harness();
    const svc = new RunLearningsService({ ...(h.svc as unknown as { deps: Record<string, unknown> }).deps, learningsDir: file, log: (m: string) => logs.push(m) } as never);
    svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    await svc.recover();
    expect(logs.some((l) => /unreadable|failed/u.test(l))).toBe(true);
  });
});

describe('the distil workflow and its report', () => {
  it('is one seat, one turn, no floor, no judge', () => {
    const def = loadDistillWorkflow();
    expect(def.id).toBe(DISTILL_WORKFLOW);
    expect(def.phases).toHaveLength(1);
    expect(def.phases[0]).toMatchObject({ executes_code: false, gate: 'auto' });
    expect((def as unknown as { required_instruments: unknown[] }).required_instruments).toEqual([]);
    expect(def as unknown as Record<string, unknown>).not.toHaveProperty('$comment');
  });

  it('asks for a reviewable record: every evidence item checked, and the reply says what was kept and dropped', () => {
    const text = String(loadDistillWorkflow().phases[0]!.instructions);
    expect(text).toMatch(/one checked entry for EVERY evidence item/u);
    expect(text).toContain('one line per evidence item, "<id> (<what it says, in a few words>): kept|dropped: <why, in one sentence>"');
    expect(text).toMatch(/naming the source run by its title/u);
    expect(checkedCount({ checked: [{ evidence: 'e1', kept: false, why: 'already proposed' }, { evidence: 'e2', kept: true }, { evidence: ' ', kept: false, why: 'x' }, { evidence: 'e3', kept: false, why: ' ' }, { evidence: 'e1', kept: true, why: 'twice' }, 'junk'] })).toBe(1);
    expect(checkedCount({ learnings: [] })).toBe(0);
    const checked = { checked: [{ evidence: 'e1', kept: false, why: 'a' }, { evidence: 'e1', kept: true, why: 'b' }, { evidence: 'e7', kept: false, why: 'c' }] };
    expect(checkedCount(checked, new Set(['e1', 'e2']))).toBe(1);
    expect(checkedCount(checked)).toBe(2);
  });

  it('an update to the stop record that cannot be written leaves the run\'s identity whole (xreview r3 on #1253)', async () => {
    const h = harness();
    h.svc.onEvent({ type: 'sessionCompleted', session: 'run-1' });
    await settle();
    const record = join(h.dir, 'run-1', 'distill.json');
    const before = readFileSync(record, 'utf8');
    // The replacement cannot be written (its temp path is taken): the record is never truncated or half-written.
    mkdirSync(`${record}.${process.pid}.tmp`);
    h.svc.onEvent({ type: 'awaitingHuman', session: 'distill-1', gateKind: 'escalation', prompt: 'substance' } as never);
    await settle();
    expect(readFileSync(record, 'utf8')).toBe(before);
    expect(h.cancels).toEqual(['distill-1']);
    expect(existsSync(join(h.dir, 'run-1', FILED_FILE))).toBe(true);
  });

  it('keeps known kinds, sane lengths, at most five', () => {
    expect(parseDistillReport(null)).toBeNull();
    expect(parseDistillReport({ nope: 1 })).toBeNull();
    const long = 'x'.repeat(60);
    const got = parseDistillReport({ learnings: [...Array(8)].map(() => ({ kind: 'weird', content: long })) })!;
    expect(got).toHaveLength(MAX_END_LEARNINGS);
    expect(got[0]!.kind).toBe('gotcha');
  });
});

describe('estate: attributed submits', () => {
  it('stamps the source run and agent, and never inherits a worker\'s run markers', () => {
    const env = learningSubmitEnv('run-9', 'codex', { WICKED_RUN_ID: 'other', WICKED_RUN_PROJECT: 'x', WICKED_MEMORY_DB: '/srv/m.db', PATH: '/bin' });
    expect(env).toMatchObject({ WICKED_RUN_ID: 'run-9', WICKED_RUN_AGENT: 'codex', WICKED_RUN_UNIT: '0', WICKED_MEMORY_DB: '/srv/m.db', PATH: '/bin' });
    expect(env['WICKED_RUN_PROJECT']).toBeUndefined();
  });

  it('reads proposal.list loosely', () => {
    expect(proposalRows({ proposals: [{ id: 'a', kind_type: 'memory', state: 'pending', payload: { content: 'c' } }, 7] })).toEqual([
      { id: 'a', kind_type: 'memory', state: 'pending', payload: { content: 'c' }, facets: {}, provenance: {} },
    ]);
  });
});

describe('approved learnings reach the next run\'s brief', () => {
  const rows = memoryRows({
    items: [
      { content: 'In acme-core, the seat_login tests time out under host load.', facets: { repo: 'acme-core' }, created_at: 2 },
      { content: 'In wicked-crew, refusal lines start with WICKED-RETRY none.', facets: { repo: 'wicked-crew' }, created_at: 3 },
      { content: 'The operator wants tables in replies.', facets: {}, created_at: 1 },
      { content: 'Project B only: never touch the billing schema.', facets: { project: 'proj-b' }, created_at: 4 },
      { nope: true },
    ],
  });

  it('applies a memory only where its repo/project facets match', () => {
    expect(appliesTo({ repo: 'acme-core' }, 'acme-core', null)).toBe(true);
    expect(appliesTo({ repo: 'acme-core' }, 'wicked-crew', null)).toBe(false);
    expect(appliesTo({ project: 'proj-b' }, 'acme-core', 'proj-a')).toBe(false);
    expect(appliesTo({}, null, null)).toBe(true);
  });

  it('appends the matching ones in a marked block, scoped first, and the deliver text takes it back out', () => {
    const { problem, recalled } = withRunLearnings('Fix seat_login flake', rows, 'acme-core', 'proj-a');
    expect(recalled).toBe(2);
    expect(problem.startsWith('Fix seat_login flake\n\n' + RUN_LEARNINGS_OPEN)).toBe(true);
    expect(problem.indexOf('seat_login tests time out')).toBeLessThan(problem.indexOf('tables in replies'));
    expect(problem).not.toContain('WICKED-RETRY');
    expect(problem).not.toContain('billing schema');
    expect(stripRunLearnings(problem)).toBe('Fix seat_login flake');
    expect(withRunLearnings('x', [], 'r', null)).toEqual({ problem: 'x', recalled: 0 });
  });

  it('POST /runs puts approved learnings in a workflow launch\'s brief (and an unreadable store launches without them)', async () => {
    const launched: LaunchRunInput[] = [];
    const bug = BUILTIN_WORKFLOWS.find((w) => w.id === 'bug')!;
    const adapter = {
      sessionsDetail: vi.fn(async () => []),
      sessions: vi.fn(async () => ['run-1']),
      runEvents: vi.fn(async () => null),
      listRepos: vi.fn(async () => [{ id: 'acme-core', name: 'acme-core', root_path: '/srv/acme-core', registered_at: 1 }]),
      getWorkflow: vi.fn((id: string) => (id === 'bug' ? bug : null)),
      getSettings: vi.fn(async () => ({ deliverDefault: 'none' })),
      launchRun: vi.fn(async (input: LaunchRunInput) => {
        launched.push(input);
        return input.sessionId;
      }),
      engineCapabilities: vi.fn(() => ({ deliverGate: true, revisesPr: true })),
      ping: vi.fn(async () => 'ok'),
    } as unknown as CoreAdapter;
    let broken = false;
    const estate = async (tool: string) => {
      if (broken) throw new Error('estate down');
      expect(tool).toBe('memory.list');
      return { items: [{ content: 'In acme-core, the seat_login tests time out under host load.', facets: { repo: 'acme-core' } }] };
    };
    const runtime: Partial<RuntimeDeps> = {
      resolveLinkedIssues: async () => ({ issues: [], block: null }),
      recallLearnings: (p, r, pr) => recallLearnings(estate, p, r, pr),
      runLearnings: { view: async (id: string) => ({ runId: id, proposed: 2, pending: 1, approved: 1, rejected: 0, distilling: false, items: [] }) },
    };
    const app = Fastify({ logger: false });
    registerRoutes(app, adapter, new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit: AuditLog.noop(), authMode: 'off' }, runtime);
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'Fix the flake', repoRef: 'acme-core', workflow: 'bug' } });
      expect(res.statusCode, res.body).toBe(201);
      expect(launched[0]!.problem).toContain(RUN_LEARNINGS_OPEN);
      expect(launched[0]!.problem).toContain('seat_login tests time out under host load');
      broken = true;
      const again = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'Fix the flake', repoRef: 'acme-core', workflow: 'bug' } });
      expect(again.statusCode, again.body).toBe(201);
      expect(launched[1]!.problem).toBe('Fix the flake');

      const card = await app.inject({ method: 'GET', url: '/api/v1/runs/run-1/learnings' });
      expect(card.statusCode).toBe(200);
      expect(card.json()).toMatchObject({ runId: 'run-1', proposed: 2 });
      expect((await app.inject({ method: 'GET', url: '/api/v1/runs/nope/learnings' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// The whole loop against a real estate server, when this host has one (CI has none: skipped there).
// Opt-in (WICKED_TEST_REAL_ESTATE=1): it starts a writable server, so every store it opens is pinned to scratch.
const hasEstate =
  process.env['WICKED_TEST_REAL_ESTATE'] === '1' && (process.env['PATH'] ?? '').split(':').some((d) => d !== '' && existsSync(join(d, 'wicked-estate-mcp')));
describe.skipIf(!hasEstate)('with a real wicked-estate-mcp: proposed, not written; approved, then recalled', () => {
  it('a run\'s learning is a pending proposal attributed to the run until a person approves it, then it is in the next brief', async () => {
    const { callEstateTool } = await import('../src/core/estate-mcp-client.js');
    const { submitLearning } = await import('../src/learnings/estate.js');
    const pinned = ['WICKED_MEMORY_DB', 'WICKED_HOME', 'WICKED_ESTATE_DB', 'WICKED_KNOWLEDGE_DB', 'WICKED_XEDGE_DB'] as const;
    const before = Object.fromEntries(pinned.map((k) => [k, process.env[k]]));
    const home = scratch();
    process.env['WICKED_MEMORY_DB'] = join(home, 'memory.db');
    process.env['WICKED_HOME'] = home;
    process.env['WICKED_ESTATE_DB'] = ':memory:';
    process.env['WICKED_KNOWLEDGE_DB'] = join(home, 'knowledge.db');
    process.env['WICKED_XEDGE_DB'] = join(home, 'xedge.db');
    try {
      const content = 'In acme-core, the seat_login tests time out when the host is loaded; re-run them before debugging a change.';
      const id = await submitLearning('run-42', 'codex', { kind_type: 'memory', payload: { content, capture: 'gotcha', tier: 'semantic', reach: 'project' }, facets: { repo: 'acme-core' } });
      expect(id).toBeTruthy();
      const rows = proposalRows(await callEstateTool('proposal.list', {}));
      expect(rows.find((r) => r.id === id)).toMatchObject({ state: 'pending', provenance: { run_id: 'run-42', run_agent: 'codex' } });
      // Nothing is written without approval: the store holds no memory, and a launch recalls nothing.
      expect(memoryRows(await callEstateTool('memory.list', {}))).toEqual([]);
      expect((await recallLearnings(callEstateTool, 'Fix it', 'acme-core', null)).recalled).toBe(0);
      await callEstateTool('proposal.approve', { id });
      const next = await recallLearnings(callEstateTool, 'Fix it', 'acme-core', null);
      expect(next.recalled).toBe(1);
      expect(next.problem).toContain(content);
      expect((await recallLearnings(callEstateTool, 'Fix it', 'wicked-crew', null)).recalled).toBe(0);
    } finally {
      for (const k of pinned) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  }, 60_000);
});
