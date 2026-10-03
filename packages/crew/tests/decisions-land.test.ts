// DC-S4a — the decision ledger, the one landing path and the structured hosts, driven through the
// real routes (Fastify inject) with a mock engine and an in-memory estate review queue.
//
// Acceptance (DES-decision-capture §9 S4a): under `required` a gate note "always X" from a human
// token auto-remembers in P with ORIGIN; an agent token records nothing; auth=off → offer, never
// auto; a forged payload → no ORIGIN; `/decisions` GET is operator+; no words on the bus.

import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes, type RegisteredRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { ConformanceRule, DecisionView } from '../src/core/types.js';
import { DecisionLedger } from '../src/decisions/ledger.js';
import { DecisionService } from '../src/decisions/land.js';
import { MembershipIndex } from '../src/projects/membership-index.js';

interface Proposal {
  id: string;
  kind_type: string;
  payload: Record<string, unknown>;
  facets: Record<string, string>;
  state: 'pending' | 'approved' | 'rejected';
}

function estateQueue() {
  const proposals = new Map<string, Proposal>();
  let n = 0;
  const tool = vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case 'proposal.submit': {
        n += 1;
        const id = `p${n}`;
        proposals.set(id, {
          id,
          kind_type: String(args.kind_type),
          payload: args.payload as Record<string, unknown>,
          facets: (args.facets ?? {}) as Record<string, string>,
          state: 'pending',
        });
        return { id };
      }
      case 'proposal.approve': {
        const p = proposals.get(String(args.id));
        if (p === undefined || p.state !== 'pending') throw new Error(`no pending proposal ${String(args.id)}`);
        p.state = 'approved';
        return p.kind_type.startsWith('policy:')
          ? { outcome: 'handed_off', payload: p.payload }
          : { outcome: 'promoted', active_id: `m-${p.id}` };
      }
      case 'proposal.reject': {
        const p = proposals.get(String(args.id));
        if (p === undefined) throw new Error('unknown proposal');
        p.state = 'rejected';
        return { ok: true };
      }
      case 'proposal.list': {
        const state = args.state as string | undefined;
        return { proposals: [...proposals.values()].filter((p) => state === undefined || p.state === state) };
      }
      default:
        throw new Error(`unexpected estate tool ${name}`);
    }
  });
  return { proposals, tool };
}

function runView(id: string) {
  return {
    session: {
      id,
      workflow_id: 'bug',
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['claude'],
      status: 'awaiting_human',
      human_confirm: 'all',
      unit_ix: 0,
      attempt: 0,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  };
}

interface Harness {
  app: FastifyInstance;
  registered: RegisteredRoutes;
  service: DecisionService;
  ledger: DecisionLedger;
  dir: string;
  estate: ReturnType<typeof estateQueue>;
  rules: Map<string, ConformanceRule>;
  adapter: Record<string, ReturnType<typeof vi.fn>>;
  emitted: Array<{ type: string; payload: Record<string, unknown>; key: string }>;
  frames: unknown[];
  elicitations: ElicitationCache;
}

const harnesses: Harness[] = [];

async function harness(opts: { authMode?: 'off' | 'required'; mode?: 'off' | 'ledger' | 'on'; dir?: string; inForce?: ConformanceRule[]; dropProject?: boolean } = {}): Promise<Harness> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'crew-decisions-'));
  const rules = new Map<string, ConformanceRule>();
  for (const r of opts.inForce ?? []) rules.set(r.id, r);
  const adapter = {
    sessionsDetail: vi.fn(async () => [runView('r1'), runView('r2')]),
    sessions: vi.fn(async () => ['r1', 'r2']),
    listRepos: vi.fn(async () => []),
    confirmGate: vi.fn(async () => 'executing'),
    injectWorkerMessage: vi.fn(async () => undefined),
    resolveElicitation: vi.fn(async () => undefined),
    steeringSupported: vi.fn(() => true),
    projectRulesSupported: vi.fn(() => true),
    upsertConformanceRule: vi.fn(async (rule: ConformanceRule) => {
      const stored: ConformanceRule = { ...rule, targets: { ...rule.targets } };
      if (opts.dropProject === true) delete stored.targets.project;
      rules.set(rule.id, stored);
    }),
    readConformanceRule: vi.fn(async (id: string) => rules.get(id) ?? null),
    retireConformanceRule: vi.fn(async (id: string) => {
      const r = rules.get(id);
      if (r !== undefined) rules.set(id, { ...r, retired: true });
      return r !== undefined;
    }),
    listConformanceRules: vi.fn(async () => [...rules.values()]),
    considerRules: vi.fn(async (q: { projects?: string[] }) => ({
      in_force: [...rules.values()].filter(
        (r) => r.retired !== true && (r.targets.project === undefined || (q.projects ?? []).includes(r.targets.project)),
      ),
      set_aside: [],
    })),
  };
  const estate = estateQueue();
  const index = new MembershipIndex();
  index.set('r1', 'kestrel');
  index.set('r2', 'heron');
  const emitted: Harness['emitted'] = [];
  const frames: unknown[] = [];
  const elicitations = new ElicitationCache();
  const ledger = new DecisionLedger(join(dir, 'decisions'));
  const app = Fastify({ logger: false });
  app.decorateRequest('actor', null as unknown as never);
  app.addHook('onRequest', async (req) => {
    const h = req.headers['x-actor'];
    if (typeof h === 'string') {
      const [kind, trust] = h.split(':');
      (req as unknown as { actor: unknown }).actor = { id: `${kind}-1`, kind, trust };
    }
  });
  const registered = registerRoutes(
    app,
    adapter as unknown as CoreAdapter,
    new GateCache(),
    elicitations,
    { bus: null, index, log: () => undefined },
    { audit: AuditLog.noop(), authMode: opts.authMode ?? 'required' },
    {
      callEstateTool: estate.tool as (t: string, a: Record<string, unknown>) => Promise<unknown>,
      decisionLedger: ledger,
      decisionsMode: opts.mode ?? 'on',
      decisionsEmit: async (type, payload, key) => {
        emitted.push({ type, payload, key });
        return true;
      },
      broadcast: (frame) => frames.push(frame),
    },
  );
  await app.ready();
  const h: Harness = { app, registered, service: registered.decisions!, ledger, dir, estate, rules, adapter, emitted, frames, elicitations };
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.app.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

const HUMAN = { 'x-actor': 'human:operator' };
const AGENT = { 'x-actor': 'agent:operator' };
const OBSERVER = { 'x-actor': 'human:observer' };
const ALWAYS = 'always run the repo checks before a walkthrough';

async function gateNote(h: Harness, run: string, amend: string, headers: Record<string, string> = HUMAN): Promise<void> {
  const res = await h.app.inject({ method: 'POST', url: `/api/v1/runs/${run}/gate`, headers, payload: { approve: true, amend } });
  expect(res.statusCode, res.body).toBe(200);
  await h.service.idle();
}

async function list(h: Harness, headers: Record<string, string> = HUMAN, q = ''): Promise<DecisionView[]> {
  const res = await h.app.inject({ method: 'GET', url: `/api/v1/decisions${q}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { decisions: DecisionView[] }).decisions;
}

describe('DC-S4a structured hosts → ledger → one landing path', () => {
  it('under required, a human gate note "always X" auto-remembers in the run\'s project with ORIGIN', async () => {
    const h = await harness();
    await gateNote(h, 'r1', ALWAYS);
    const [d] = await list(h);
    expect(d).toMatchObject({
      project_id: 'kestrel',
      host: 'gate',
      route: 'auto',
      state: 'remembered',
      how: 'auto',
      rule_id: 'proposal:p1',
      proposal_id: 'p1',
      origin: { actor: { id: 'human-1', kind: 'human', trust: 'operator' }, auth_mode: 'required', run_id: 'r1', words: ALWAYS, words_source: 'typed', redacted: false, choice: 'approve' },
      derived: { statement: 'Always run the repo checks before a walkthrough.', scope: 'project', steering_type: 'testing', template: 'T1-always' },
    });
    const rule = h.rules.get('proposal:p1')!;
    expect(rule.targets.project).toBe('kestrel');
    expect(rule.provenance).toEqual({ source: 'proposal', ref: 'proposal:p1', source_kinds: ['operator-words'] });
    expect(rule.severity).toBe('warn');
    expect(rule.effect).toBeUndefined();
    // The payload estate holds carries only the decision id beside the rule text.
    expect(h.estate.proposals.get('p1')!.payload).toEqual({ rule: 'Always run the repo checks before a walkthrough.', severity: 'warn', capture: 'decision', decision: { id: d!.id } });
    expect(h.estate.proposals.get('p1')!.facets).toEqual({ project: 'kestrel' });
    expect(h.frames).toContainEqual({ type: 'decisionChanged', id: d!.id, state: 'remembered', rule_id: 'proposal:p1', project_id: 'kestrel' });
  });

  it('an agent token records nothing (and lands nothing)', async () => {
    const h = await harness();
    await gateNote(h, 'r1', ALWAYS, AGENT);
    expect(await list(h)).toEqual([]);
    expect(h.adapter.upsertConformanceRule).not.toHaveBeenCalled();
    expect(h.estate.tool).not.toHaveBeenCalled();
  });

  it('auth=off records as the local operator but only OFFERS — never auto', async () => {
    const h = await harness({ authMode: 'off' });
    await gateNote(h, 'r1', ALWAYS, {});
    const [d] = await list(h, {});
    expect(d).toMatchObject({ route: 'offer', state: 'offered', proposal_id: 'p1', origin: { auth_mode: 'off', actor: { id: 'local', kind: 'human' } } });
    expect(h.adapter.upsertConformanceRule).not.toHaveBeenCalled();
    expect(h.estate.proposals.get('p1')!.state).toBe('pending');
  });

  it('GET /decisions is operator+ (an observer is refused); writes refuse an agent with 403', async () => {
    const h = await harness();
    await gateNote(h, 'r1', 'rebase onto main before requesting review');
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/decisions', headers: OBSERVER })).statusCode).toBe(403);
    const [d] = await list(h);
    expect(d!.state).toBe('offered');
    for (const headers of [AGENT, OBSERVER]) {
      const res = await h.app.inject({ method: 'POST', url: `/api/v1/decisions/${d!.id}/remember`, headers, payload: {} });
      expect(res.statusCode).toBe(403);
    }
    expect(h.adapter.upsertConformanceRule).not.toHaveBeenCalled();
  });

  it('the chip: Remember with an edit lands the edited rule; ORIGIN keeps the original words', async () => {
    const h = await harness();
    await gateNote(h, 'r1', 'rebase onto main before requesting review');
    const [d] = await list(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${d!.id}/remember`,
      headers: HUMAN,
      payload: { statement: 'Rebase onto main before asking for any review.' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ rule_id: 'proposal:p1', proposal_id: 'p1', project: 'kestrel' });
    expect(h.rules.get('proposal:p1')!.statement).toBe('Rebase onto main before asking for any review.');
    const [after] = await list(h);
    expect(after).toMatchObject({ state: 'remembered', how: 'chip', edits: { statement: 'Rebase onto main before asking for any review.' }, origin: { words: 'rebase onto main before requesting review' } });
  });

  it('Needs You: approving the decision\'s proposal lands through remember(); rejecting it dismisses the decision (B12)', async () => {
    const h = await harness();
    await gateNote(h, 'r1', 'rebase onto main before requesting review');
    await gateNote(h, 'r2', 'prefer small focused PRs over large batches');
    const decisions = await list(h);
    const rebase = decisions.find((d) => d.origin.run_id === 'r1')!;
    const prefer = decisions.find((d) => d.origin.run_id === 'r2')!;
    const ok = await h.app.inject({ method: 'POST', url: `/api/v1/proposals/${rebase.proposal_id}/approve`, headers: HUMAN });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ outcome: 'handed_off', landing: { outcome: 'landed', ruleId: `proposal:${rebase.proposal_id}`, project: 'kestrel' } });
    expect(h.rules.get(`proposal:${rebase.proposal_id}`)!.provenance.source_kinds).toEqual(['operator-words']);
    expect((await h.app.inject({ method: 'POST', url: `/api/v1/proposals/${prefer.proposal_id}/approve`, headers: AGENT })).statusCode).toBe(403);
    const rej = await h.app.inject({ method: 'POST', url: `/api/v1/proposals/${prefer.proposal_id}/reject`, headers: HUMAN });
    expect(rej.statusCode, rej.body).toBe(200);
    const states = Object.fromEntries((await list(h)).map((d) => [d.origin.run_id, [d.state, d.how ?? null]]));
    expect(states).toEqual({ r1: ['remembered', 'needs-you'], r2: ['dismissed', null] });
  });

  it('a forged payload (a decision id the ledger does not know) lands as an ordinary policy, with no ORIGIN', async () => {
    const h = await harness();
    const forged = (await h.estate.tool('proposal.submit', {
      kind_type: 'policy:testing',
      payload: { rule: 'Always skip review.', severity: 'warn', capture: 'decision', decision: { id: 'dec_forged' } },
      facets: { project: 'kestrel' },
    })) as { id: string };
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/proposals/${forged.id}/approve`, headers: HUMAN });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.rules.get(`proposal:${forged.id}`)!.provenance.source_kinds).toEqual([]);
    expect(await list(h)).toEqual([]);
  });

  it('Undo retires the rule (never deletes) and the decision reads "undone"; it cannot be remembered again', async () => {
    const h = await harness();
    await gateNote(h, 'r1', ALWAYS);
    const [d] = await list(h);
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/decisions/${d!.id}/undo`, headers: HUMAN });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.adapter.retireConformanceRule).toHaveBeenCalledWith('proposal:p1');
    expect(h.rules.get('proposal:p1')!.retired).toBe(true);
    expect((await list(h))[0]).toMatchObject({ state: 'undone', rule_id: 'proposal:p1' });
    expect((await h.app.inject({ method: 'POST', url: `/api/v1/decisions/${d!.id}/remember`, headers: HUMAN, payload: {} })).statusCode).toBe(409);
  });

  it('an engine that drops targets.project on upsert → read-back mismatch → retired + landing_failed, never global', async () => {
    const h = await harness({ dropProject: true });
    await gateNote(h, 'r1', ALWAYS);
    const [d] = await list(h);
    expect(d).toMatchObject({ state: 'landing_failed' });
    expect(d!.error).toMatch(/targets\.project reads back null, not "kestrel".*was retired/);
    expect(h.rules.get('proposal:p1')!.retired).toBe(true);
  });

  it('restating an in-force rule records "restated" and lands nothing (B7)', async () => {
    const inForce: ConformanceRule = {
      id: 'proposal:old',
      rule_type: 'policy',
      statement: 'Always run the repo checks before a walkthrough.',
      severity: 'warn',
      confidence: 0.8,
      targets: { project: 'kestrel' },
      provenance: { source: 'proposal', ref: 'proposal:old', source_kinds: ['operator-words'] },
    } as ConformanceRule;
    const h = await harness({ inForce: [inForce] });
    await gateNote(h, 'r1', ALWAYS);
    expect((await list(h))[0]).toMatchObject({ route: 'restated', state: 'restated', restates_rule_id: 'proposal:old' });
    expect(h.estate.tool).not.toHaveBeenCalledWith('proposal.submit', expect.anything());
  });

  it('widen (B8): the same rule in two projects → one project-less successor superseding both', async () => {
    const h = await harness();
    await gateNote(h, 'r1', ALWAYS);
    await gateNote(h, 'r2', ALWAYS);
    const decisions = await list(h);
    expect(decisions.map((d) => d.widen)).toEqual([{ projects: ['heron', 'kestrel'] }, { projects: ['heron', 'kestrel'] }]);
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/decisions/${decisions[0]!.id}/widen`, headers: HUMAN });
    expect(res.statusCode, res.body).toBe(200);
    const { rule_id } = res.json() as { rule_id: string };
    const successor = h.rules.get(rule_id)!;
    expect(successor.targets.project).toBeUndefined();
    expect(successor.supersedes).toEqual(['proposal:p1', 'proposal:p2']);
    expect(h.rules.get('proposal:p1')!.retired).toBe(true);
    expect(h.rules.get('proposal:p2')!.retired).toBe(true);
    expect((await list(h)).map((d) => d.state)).toEqual(['widened', 'widened']);
  });

  it('elicitation free text and run inject are hosts; a picked option is a choice', async () => {
    const h = await harness();
    h.elicitations.create({ runId: 'r1', elicitationId: 'e1', message: 'How?', options: null });
    const el = await h.app.inject({
      method: 'POST',
      url: '/api/v1/runs/r1/elicitation',
      headers: HUMAN,
      payload: { elicitationId: 'e1', action: 'accept', content: { response: 'never mock the payment provider in walkthroughs' } },
    });
    expect(el.statusCode, el.body).toBe(200);
    h.elicitations.create({ runId: 'r2', elicitationId: 'e2', message: 'Which?', options: ['a', 'b'] });
    await h.app.inject({ method: 'POST', url: '/api/v1/runs/r2/elicitation', headers: HUMAN, payload: { elicitationId: 'e2', action: 'accept', content: { response: 'b' } } });
    const inj = await h.app.inject({ method: 'POST', url: '/api/v1/runs/r1/inject', headers: HUMAN, payload: { message: 'from now on, prefer small commits over large ones' } });
    expect(inj.statusCode, inj.body).toBe(200);
    await h.service.idle();
    const byHost = (await list(h)).map((d) => [d.host, d.route, d.origin.choice ?? null, d.origin.elicitation_id ?? null]);
    expect(byHost).toEqual(
      expect.arrayContaining([
        ['elicitation', 'auto', null, 'e1'],
        ['elicitation', 'ledger', 'b', 'e2'],
        ['inject', 'offer', null, null],
      ]),
    );
  });

  it('no words on the bus: every fact carries ids, enums and counts only', async () => {
    const h = await harness();
    await gateNote(h, 'r1', ALWAYS);
    await gateNote(h, 'r2', 'rebase onto main before requesting review');
    const [offered] = (await list(h)).filter((d) => d.state === 'offered');
    await h.app.inject({ method: 'POST', url: `/api/v1/decisions/${offered!.id}/dismiss`, headers: HUMAN, payload: { reason: 'one-off' } });
    const types = h.emitted.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['wicked.crew.decision.detected', 'wicked.crew.decision.remembered', 'wicked.crew.decision.offered', 'wicked.crew.decision.dismissed']),
    );
    const wire = JSON.stringify(h.emitted);
    for (const words of [ALWAYS, 'rebase onto main', 'Always run the repo checks', 'walkthrough']) expect(wire).not.toContain(words);
  });

  it('mode `ledger` records and labels but offers and lands nothing', async () => {
    const h = await harness({ mode: 'ledger' });
    await gateNote(h, 'r1', ALWAYS);
    const [d] = await list(h);
    expect(d).toMatchObject({ route: 'auto', state: 'recorded' });
    expect(h.estate.tool).not.toHaveBeenCalled();
  });

  it('the ledger is 0600 files in a 0700 dir, one per project', async () => {
    const h = await harness();
    await gateNote(h, 'r1', ALWAYS);
    const dir = join(h.dir, 'decisions');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toEqual(['kestrel.jsonl']);
    expect(statSync(join(dir, 'kestrel.jsonl')).mode & 0o777).toBe(0o600);
    const lines = readFileSync(join(dir, 'kestrel.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { op: string });
    expect(lines.map((l) => l.op)).toEqual(['record', 'outcome']);
  });

  it('a restart re-drives an un-acted record exactly once (the proposal is keyed by the decision id)', async () => {
    const h = await harness({ mode: 'ledger' });
    await gateNote(h, 'r1', 'rebase onto main before requesting review');
    // Same ledger dir, now `on`: the boot re-drive offers it; a second re-drive files nothing new.
    const ledger = new DecisionLedger(join(h.dir, 'decisions'));
    const service = new DecisionService({ ...h.service.deps, ledger, mode: 'on' });
    expect(await service.redrive()).toBe(1);
    expect(await service.redrive()).toBe(0);
    const submits = h.estate.tool.mock.calls.filter(([name]) => name === 'proposal.submit');
    expect(submits).toHaveLength(1);
    expect(ledger.list()[0]).toMatchObject({ state: 'offered', proposal_id: 'p1' });
  });
});

describe('DC-S4a codex adjudication fixes', () => {
  it('a record captured under required auth is re-driven as an OFFER by a daemon now under auth=off', async () => {
    const h = await harness({ mode: 'ledger' });
    await gateNote(h, 'r1', ALWAYS);
    const service = new DecisionService({ ...h.service.deps, ledger: new DecisionLedger(join(h.dir, 'decisions')), mode: 'on', authMode: 'off' });
    expect(await service.redrive()).toBe(1);
    expect(service.deps.ledger.list()[0]).toMatchObject({ route: 'auto', state: 'offered' });
    expect(h.adapter.upsertConformanceRule).not.toHaveBeenCalled();
  });

  it('two concurrent Remember clicks land ONE rule', async () => {
    const h = await harness();
    await gateNote(h, 'r1', 'rebase onto main before requesting review');
    const [d] = await list(h);
    const [a, b] = await Promise.all([
      h.app.inject({ method: 'POST', url: `/api/v1/decisions/${d!.id}/remember`, headers: HUMAN, payload: {} }),
      h.app.inject({ method: 'POST', url: `/api/v1/decisions/${d!.id}/remember`, headers: HUMAN, payload: {} }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json()).toEqual(b.json());
    expect(h.adapter.upsertConformanceRule).toHaveBeenCalledTimes(1);
    expect(h.estate.tool.mock.calls.filter(([n]) => n === 'proposal.submit')).toHaveLength(1);
  });

  it('a torn last line is terminated on load, so the next append survives a reload', async () => {
    const h = await harness();
    await gateNote(h, 'r1', ALWAYS);
    appendFileSync(join(h.dir, 'decisions', 'kestrel.jsonl'), '{"op":"outcome","id":"torn');
    const again = await harness({ dir: h.dir });
    await gateNote(again, 'r1', 'rebase onto main before requesting review');
    const reloaded = new DecisionLedger(join(h.dir, 'decisions')).list();
    expect(reloaded.map((d) => d.state).sort()).toEqual(['offered', 'remembered']);
  });

  it('a proposal crew filed but has not linked yet still lands only through remember() (an agent is refused)', async () => {
    const h = await harness({ mode: 'ledger' });
    await gateNote(h, 'r1', 'rebase onto main before requesting review');
    const [d] = await list(h);
    // The publish window: the proposal is in estate, the `offered` outcome is not in the ledger yet.
    const filed = (await h.estate.tool('proposal.submit', {
      kind_type: 'policy:development',
      payload: { rule: 'Rebase onto main before requesting review.', severity: 'warn', capture: 'decision', decision: { id: d!.id } },
      facets: { project: 'kestrel' },
    })) as { id: string };
    const agent = await h.app.inject({ method: 'POST', url: `/api/v1/proposals/${filed.id}/approve`, headers: AGENT });
    expect(agent.statusCode).toBe(403);
    expect(h.adapter.upsertConformanceRule).not.toHaveBeenCalled();
    const human = await h.app.inject({ method: 'POST', url: `/api/v1/proposals/${filed.id}/approve`, headers: HUMAN });
    expect(human.statusCode, human.body).toBe(200);
    expect(h.rules.get(`proposal:${filed.id}`)!.provenance.source_kinds).toEqual(['operator-words']);
    expect((await list(h))[0]).toMatchObject({ state: 'remembered', proposal_id: filed.id, how: 'needs-you' });
  });

  it('a decision whose landing failed can still be dismissed (its proposal is already approved)', async () => {
    const h = await harness({ dropProject: true });
    await gateNote(h, 'r1', ALWAYS);
    const [d] = await list(h);
    expect(d!.state).toBe('landing_failed');
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/decisions/${d!.id}/dismiss`, headers: HUMAN, payload: { reason: 'not-a-rule' } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await list(h))[0]!.state).toBe('dismissed');
  });

  it('widen lands the EFFECTIVE (edited) statement the operator remembered', async () => {
    const h = await harness();
    await gateNote(h, 'r1', 'rebase onto main before requesting review');
    await gateNote(h, 'r2', 'rebase onto main before requesting review');
    for (const d of await list(h)) {
      const r = await h.app.inject({ method: 'POST', url: `/api/v1/decisions/${d.id}/remember`, headers: HUMAN, payload: { statement: 'Rebase on main before any review.' } });
      expect(r.statusCode, r.body).toBe(200);
    }
    const [first] = await list(h);
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/decisions/${first!.id}/widen`, headers: HUMAN });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.rules.get((res.json() as { rule_id: string }).rule_id)!.statement).toBe('Rebase on main before any review.');
  });
});
