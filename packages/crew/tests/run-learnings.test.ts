// Run learnings (operator 2026-10-30: "with all the run activity, no memories or learnings are being saved").
// A run proposes what it learned to the approve queue: template learnings at its checkpoints, the rest
// distilled at its end by ONE seat that did not build it (raw when no such seat can run). Everything is a
// `memory` PROPOSAL attributed to the source run; nothing is written without a person's approval; an
// approved learning rides in the next matching launch's brief and never in its PR text.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
      problem: 'Fix wicked-core issue #1166\n\nmore',
      title: 'Fix wicked-core issue #1166',
      repo_ref: 'wicked-core',
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
    expect(templates[0]!.content).toContain('In wicked-core, the test `tests/bridge-reaper.test.ts > finds a child` (repo check `test`) is flaky');
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

function harness(opts: { seats?: unknown[]; mode?: 'distill' | 'extract'; proposals?: ProposalRow[]; memories?: string[]; launchFails?: boolean; view?: SessionView } = {}) {
  const dir = scratch();
  const view = opts.view ?? runView();
  const submitted: Array<{ runId: string; agent: string; args: SubmitArgs }> = [];
  const queue: ProposalRow[] = [...(opts.proposals ?? [])];
  const launches: LaunchRunInput[] = [];
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
  return { svc, dir, submitted, queue, launches, views };
}

describe('RunLearningsService: proposals, never writes', () => {
  it('files the template learnings at a checkpoint, attributed to the run, and nothing else yet', async () => {
    const h = harness();
    h.svc.onEvent({ type: 'powerCheckpointReached', session: 'run-1' });
    await settle();
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toMatchObject({ runId: 'run-1', agent: 'crew', args: { kind_type: 'memory', facets: { repo: 'wicked-core', project: 'proj-a' }, payload: { capture: 'gotcha', tier: 'semantic', reach: 'project' } } });
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
          { kind: 'gotcha', content: 'In wicked-core, the seat_login tests time out when the host is loaded; a floor failure in them is not evidence against a change.', evidence: ['e1'] },
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

describe('the distil workflow and its report', () => {
  it('is one seat, one turn, no floor, no judge', () => {
    const def = loadDistillWorkflow();
    expect(def.id).toBe(DISTILL_WORKFLOW);
    expect(def.phases).toHaveLength(1);
    expect(def.phases[0]).toMatchObject({ executes_code: false, gate: 'auto' });
    expect((def as unknown as { required_instruments: unknown[] }).required_instruments).toEqual([]);
    expect(def as unknown as Record<string, unknown>).not.toHaveProperty('$comment');
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
      { content: 'In wicked-core, the seat_login tests time out under host load.', facets: { repo: 'wicked-core' }, created_at: 2 },
      { content: 'In wicked-crew, refusal lines start with WICKED-RETRY none.', facets: { repo: 'wicked-crew' }, created_at: 3 },
      { content: 'The operator wants tables in replies.', facets: {}, created_at: 1 },
      { content: 'Project B only: never touch the billing schema.', facets: { project: 'proj-b' }, created_at: 4 },
      { nope: true },
    ],
  });

  it('applies a memory only where its repo/project facets match', () => {
    expect(appliesTo({ repo: 'wicked-core' }, 'wicked-core', null)).toBe(true);
    expect(appliesTo({ repo: 'wicked-core' }, 'wicked-crew', null)).toBe(false);
    expect(appliesTo({ project: 'proj-b' }, 'wicked-core', 'proj-a')).toBe(false);
    expect(appliesTo({}, null, null)).toBe(true);
  });

  it('appends the matching ones in a marked block, scoped first, and the deliver text takes it back out', () => {
    const { problem, recalled } = withRunLearnings('Fix seat_login flake', rows, 'wicked-core', 'proj-a');
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
      listRepos: vi.fn(async () => [{ id: 'wicked-core', name: 'wicked-core', root_path: '/srv/wicked-core', registered_at: 1 }]),
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
      return { items: [{ content: 'In wicked-core, the seat_login tests time out under host load.', facets: { repo: 'wicked-core' } }] };
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
      const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'Fix the flake', repoRef: 'wicked-core', workflow: 'bug' } });
      expect(res.statusCode, res.body).toBe(201);
      expect(launched[0]!.problem).toContain(RUN_LEARNINGS_OPEN);
      expect(launched[0]!.problem).toContain('seat_login tests time out under host load');
      broken = true;
      const again = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'Fix the flake', repoRef: 'wicked-core', workflow: 'bug' } });
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
const hasEstate = (process.env['PATH'] ?? '').split(':').some((d) => d !== '' && existsSync(join(d, 'wicked-estate-mcp')));
describe.skipIf(!hasEstate)('with a real wicked-estate-mcp: proposed, not written; approved, then recalled', () => {
  it('a run\'s learning is a pending proposal attributed to the run until a person approves it, then it is in the next brief', async () => {
    const { callEstateTool } = await import('../src/core/estate-mcp-client.js');
    const { submitLearning } = await import('../src/learnings/estate.js');
    const before = process.env['WICKED_MEMORY_DB'];
    process.env['WICKED_MEMORY_DB'] = join(scratch(), 'memory.db');
    try {
      const content = 'In wicked-core, the seat_login tests time out when the host is loaded; re-run them before debugging a change.';
      const id = await submitLearning('run-42', 'codex', { kind_type: 'memory', payload: { content, capture: 'gotcha', tier: 'semantic', reach: 'project' }, facets: { repo: 'wicked-core' } });
      expect(id).toBeTruthy();
      const rows = proposalRows(await callEstateTool('proposal.list', {}));
      expect(rows.find((r) => r.id === id)).toMatchObject({ state: 'pending', provenance: { run_id: 'run-42', run_agent: 'codex' } });
      // Nothing is written without approval: the store holds no memory, and a launch recalls nothing.
      expect(memoryRows(await callEstateTool('memory.list', {}))).toEqual([]);
      expect((await recallLearnings(callEstateTool, 'Fix it', 'wicked-core', null)).recalled).toBe(0);
      await callEstateTool('proposal.approve', { id });
      const next = await recallLearnings(callEstateTool, 'Fix it', 'wicked-core', null);
      expect(next.recalled).toBe(1);
      expect(next.problem).toContain(content);
      expect((await recallLearnings(callEstateTool, 'Fix it', 'wicked-crew', null)).recalled).toBe(0);
    } finally {
      if (before === undefined) delete process.env['WICKED_MEMORY_DB'];
      else process.env['WICKED_MEMORY_DB'] = before;
    }
  }, 60_000);
});
