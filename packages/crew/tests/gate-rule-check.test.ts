// (DES-RULE-CHECK-001 S2/S4, api-types 0.190.0) The review gate's steering-rule check on the wire:
// `retry_rules` re-runs the check on the same work; `skip_rules` skips unchecked rules, each with the
// person's written reason (`skipRules: [{id, reason}]`), which crew hands the engine as JSON in
// `amend`; skipping is the human operator's call alone. Every rule's verdict rides the receipt
// (`AssuranceReceipt.rules`), and the delivery and the PR body say "N rules checked: K kept, B
// broken, X not applicable".
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GateSchema, registerRoutes, skipRulesAmend } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { type CoreAdapter } from '../src/core/adapter.js';
import { aggregateReceipt, worstRulePerRule } from '../src/api/delivery-assurance.js';
import { rulesLabel, rulesSummaryLine } from '../src/core/deliver-text.js';
import type { RuleVerdict, SessionView } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const row = (ruleId: string, status: RuleVerdict['status'], reason = 'r'): RuleVerdict => ({
  ruleId,
  status,
  how: status === 'n_a' ? 'fact' : status === 'skipped' ? 'operator' : status === 'unchecked' ? 'none' : 'judge',
  reason,
  ruleKey: 'k',
});

describe('GateSchema — retry_rules and skip_rules', () => {
  const ok = (b: unknown) => GateSchema.safeParse(b).success;
  it('retry_rules is approve-shaped and carries nothing else', () => {
    expect(ok({ approve: true, action: 'retry_rules' })).toBe(true);
    expect(ok({ approve: false, action: 'retry_rules' })).toBe(false);
    expect(ok({ approve: true, action: 'retry_rules', amend: 'again' })).toBe(false);
  });
  it('skip_rules needs skipRules, each with an id and a written reason, no rule twice', () => {
    expect(ok({ approve: true, action: 'skip_rules', skipRules: [{ id: 'R1', reason: 'the judge cannot read the fixture' }] })).toBe(true);
    for (const bad of [
      { approve: true, action: 'skip_rules' },
      { approve: true, action: 'skip_rules', skipRules: [] },
      { approve: true, action: 'skip_rules', skipRules: [{ id: 'R1', reason: '   ' }] },
      { approve: true, action: 'skip_rules', skipRules: [{ id: '', reason: 'x' }] },
      { approve: true, action: 'skip_rules', skipRules: [{ id: 'R1', reason: 'a' }, { id: 'R1', reason: 'b' }] },
      { approve: true, action: 'skip_rules', skipRules: [{ id: 'R1', reason: 'x' }], amend: 'also' },
      { approve: false, action: 'skip_rules', skipRules: [{ id: 'R1', reason: 'x' }] },
      { approve: true, skipRules: [{ id: 'R1', reason: 'x' }] },
    ]) {
      expect(ok(bad), JSON.stringify(bad)).toBe(false);
    }
  });
  it("the engine's amend is the skips as JSON, reasons trimmed", () => {
    expect(skipRulesAmend([{ id: 'R1', reason: ' binary fixture ' }])).toBe('[{"id":"R1","reason":"binary fixture"}]');
  });
});

// (DES-RULE-CHECK-001 rev 2, wicked-core-ts >= 0.15.30) A dispute no council settled, as the engine serializes it
// (core `RuleVerdict` / `RuleCouncil`, camelCase): every field must reach the skin as the engine wrote it.
const DISPUTED: RuleVerdict = {
  ruleId: 'DEV-TINYMATH-2',
  status: 'disputed',
  how: 'council',
  reason: 'no_quorum: 1 of 3 seats answered',
  judge: 'claude',
  ruleKey: 'k'.repeat(64),
  evidenceKey: 'e'.repeat(64),
  origin: 'council',
  judgeIds: ['claude'],
  evidenceComplete: true,
  reviewer: { by: 'reviewer', seat: 'codex', status: 'kept', cite: 'src/add.rs:3 adds the overflow check', ids: ['codex'] },
  council: {
    taskId: 'council-7',
    positions: [
      { by: 'rule_judge', seat: 'claude', status: 'broken', cite: 'no test covers the overflow', ids: ['claude'] },
      { by: 'reviewer', seat: 'codex', status: 'kept', cite: 'src/add.rs:3 adds the overflow check', ids: ['codex'] },
    ],
    votes: [
      { seat: 'agy', status: 'kept', counted: false, whyNot: 'names no changed file' },
      { seat: 'pi', counted: false, whyNot: 'no framed answer' },
      { seat: 'opencode', status: 'broken', counted: true },
    ],
    seated: 3,
    returned: 1,
    agreementPct: 0,
    consensus: false,
    seed: 2 ** 53 - 1,
    eligible: ['agy', 'pi', 'opencode', 'copilot'],
    ballotsIn: 'seat containers',
    reason: 'no_quorum',
  },
};
const settled = (status: 'kept' | 'broken' | 'n_a' | 'waived', votes: Array<[string, RuleVerdict['status'], boolean]>): RuleVerdict => ({
  ...row('S', status),
  how: 'council',
  origin: 'council',
  council: {
    taskId: 't', positions: [], ruling: status, seated: 3, returned: votes.length, agreementPct: 67, consensus: true, seed: 1, eligible: [],
    votes: votes.map(([seat, st, counted]) => ({ seat, status: st, counted })),
  },
});

function view(id: string, denial: Record<string, unknown> = { source: 'rules_unchecked', reason: 'x' }) {
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude', 'pi'], status: 'awaiting_human', human_confirm: 'none', unit_ix: 0, attempt: 2,
      workdir: null, repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [
      {
        id: `${id}:verify`, session_id: id, ord: 4, description: 'verify', status: 'rejected', assigned_cli: 'pi', denial,
        assurance: { mode: 'full', required: [], ran: [], skipped: [], creator: null, evaluator: null, judge: null, tree: null, attempt: 2, rules: [DISPUTED, row('BROKEN-1', 'broken')] },
      },
    ],
  };
}

describe('POST /runs/:id/gate — the rule answers reach the engine; a skip is a human operator\'s', () => {
  let app: FastifyInstance;
  const confirmCalls: unknown[][] = [];
  const audit = { record: vi.fn(() => Date.now()) } as unknown as AuditLog;
  const audited = (action: string) => (audit.record as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === action);

  beforeAll(async () => {
    const mockAdapter = {
      // `run-fail`: the disputed row is BEHIND the reviewer's FAIL (the winning denial is the verdict's).
      sessionsDetail: vi.fn().mockResolvedValue([
        view('run-rules'),
        view('run-fail', { source: 'evaluator_verdict', reason: 'FAIL' }),
      ]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      confirmGate: vi.fn(async (...args: unknown[]) => {
        confirmCalls.push(args);
        // The engine's own refusal (core `rules_recheck_request`): only a held row can be skipped.
        if (args[3] === 'skip_rules' && String(args[2]).includes('BROKEN-1')) {
          throw new Error('rule `BROKEN-1` is not an unchecked rule (nor a disputed one) of unit 4 — only a rule no judge or council ruled on can be skipped (a broken rule denies the gate)');
        }
        return 'executing';
      }),
    };
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      const named = req.headers['x-test-actor'];
      if (typeof named === 'string') {
        const [kind, trust] = named.split('/');
        (req as unknown as { actor: unknown }).actor = { id: `test-${kind}`, kind, trust };
      }
    });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, { audit, authMode: 'off' });
    await app.ready();
  });
  beforeEach(() => {
    confirmCalls.length = 0;
    (audit.record as ReturnType<typeof vi.fn>).mockClear();
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (body: Record<string, unknown>, actor = 'human/operator', run = 'run-rules') =>
    app.inject({ method: 'POST', url: `/api/v1/runs/${run}/gate`, headers: { 'x-test-actor': actor }, payload: body });

  it('(rev 2) a skip of a disputed row reaches the engine, audited with its reason', async () => {
    const skipRules = [{ id: 'DEV-TINYMATH-2', reason: 'the council could not rule; I read the diff and the test is there' }];
    const res = await post({ approve: true, action: 'skip_rules', skipRules });
    expect(res.statusCode, res.body).toBe(200);
    expect(confirmCalls).toEqual([['run-rules', true, JSON.stringify(skipRules), 'skip_rules', undefined, undefined]]);
    // The decision resolved the held unit (ord 4): its receipt, council and all, is the one the answer carries.
    expect(res.json().assurance.rules[0]).toEqual(DISPUTED);
    const lines = audited('gate.rules_skipped');
    expect(lines).toHaveLength(1);
    expect(lines[0]![2]).toMatchObject({ runId: 'run-rules', detail: { ord: 4, skips: skipRules } });
  });

  it('(rev 2) GET /runs/:id carries the disputed row, its parties, votes and seed as the engine wrote them', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-rules', headers: { 'x-test-actor': 'human/operator' } });
    expect(res.statusCode, res.body).toBe(200);
    const rules = res.json().run.units[0].assurance.rules;
    expect(rules[0]).toEqual(DISPUTED);
    expect(rules[0].council.seed).toBe(2 ** 53 - 1);
  });

  it('(rev 2) behind a reviewer FAIL, retry_rules and a skip of the disputed row still reach the engine (crew does not filter by the winning denial)', async () => {
    const retry = await post({ approve: true, action: 'retry_rules' }, 'human/operator', 'run-fail');
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().assurance.rules[0]).toEqual(DISPUTED);
    const skipRules = [{ id: 'DEV-TINYMATH-2', reason: 'reviewed it myself' }];
    const skip = await post({ approve: true, action: 'skip_rules', skipRules }, 'human/operator', 'run-fail');
    expect(skip.statusCode, skip.body).toBe(200);
    expect(confirmCalls.map((c) => [c[0], c[3]])).toEqual([['run-fail', 'retry_rules'], ['run-fail', 'skip_rules']]);
    expect(audited('gate.rules_skipped')[0]![2]).toMatchObject({ runId: 'run-fail', detail: { ord: 4 } });
  });

  it('negative control: a skip naming a broken row is still a 409 with the engine\'s words, the gate left open and no skip audited', async () => {
    const res = await post({ approve: true, action: 'skip_rules', skipRules: [{ id: 'BROKEN-1', reason: 'I disagree' }] });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatch(/BROKEN-1.*broken rule denies the gate/u);
    expect(audited('gate.rules_skipped')).toHaveLength(0);
    expect(audited('gate.decided')).toHaveLength(0);
  });

  it('negative control: a seat cannot skip a disputed row either (403, nothing reaches the engine)', async () => {
    const res = await post({ approve: true, action: 'skip_rules', skipRules: [{ id: 'DEV-TINYMATH-2', reason: 'x' }] }, 'agent/operator');
    expect(res.statusCode, res.body).toBe(403);
    expect(confirmCalls).toEqual([]);
  });

  it('retry_rules goes to confirmGate as an approve with nothing else', async () => {
    const res = await post({ approve: true, action: 'retry_rules' });
    expect(res.statusCode, res.body).toBe(200);
    expect(confirmCalls).toEqual([['run-rules', true, undefined, 'retry_rules', undefined, undefined]]);
  });

  it("skip_rules goes to confirmGate with the skips as JSON in amend, and is audited with each reason", async () => {
    const skipRules = [{ id: 'learn-tests-with-fixes', reason: 'the fix is a docs typo; there is nothing to test' }];
    const res = await post({ approve: true, action: 'skip_rules', skipRules });
    expect(res.statusCode, res.body).toBe(200);
    expect(confirmCalls).toEqual([['run-rules', true, JSON.stringify(skipRules), 'skip_rules', undefined, undefined]]);
    const lines = audited('gate.rules_skipped');
    expect(lines).toHaveLength(1);
    expect(lines[0]![2]).toMatchObject({ runId: 'run-rules', detail: { skips: skipRules } });
  });

  it('a seat or a standing order cannot skip a rule: 403, audited, nothing confirmed', async () => {
    for (const actor of ['agent/operator', 'system/operator']) {
      const res = await post({ approve: true, action: 'skip_rules', skipRules: [{ id: 'R1', reason: 'x' }] }, actor);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().code).toBe('human_operator_only');
    }
    expect(confirmCalls).toEqual([]);
    expect(audited('gate.skip_rules_refused')).toHaveLength(2);
  });
});

describe('the rule verdicts on the delivery and the PR body', () => {
  it('a post-hoc delivery keeps the worst row per rule across gates', () => {
    const v = {
      session: { assurance: { mode: 'full', required: ['judge'] } },
      units: [
        { ord: 2, assurance: { mode: 'full', required: [], ran: [], skipped: [], creator: null, evaluator: null, judge: null, tree: null, attempt: 1, rules: [row('A', 'kept'), row('B', 'skipped', 'skipped by operator: fixture')] } },
        { ord: 4, assurance: { mode: 'full', required: [], ran: [], skipped: [], creator: null, evaluator: null, judge: null, tree: null, attempt: 1, rules: [row('A', 'broken'), row('C', 'n_a')] } },
      ],
    } as unknown as SessionView;
    const r = aggregateReceipt(v, null);
    expect(r?.rules?.map((x) => [x.ruleId, x.status])).toEqual([['A', 'broken'], ['B', 'skipped'], ['C', 'n_a']]);
    expect(worstRulePerRule([])).toEqual([]);
    expect(aggregateReceipt({ ...v, units: [] } as unknown as SessionView, null)).not.toHaveProperty('rules');
  });

  it('"N rules checked: K kept, B broken, X not applicable", and each skip with its reason', () => {
    expect(rulesSummaryLine([row('A', 'kept'), row('B', 'broken'), row('C', 'n_a'), row('D', 'n_a')])).toBe(
      '4 rules checked: 1 kept, 1 broken, 2 not applicable',
    );
    expect(rulesSummaryLine([row('A', 'kept'), row('U', 'unchecked'), row('S', 'skipped', 'skipped by operator: binary fixture')])).toBe(
      '3 rules checked: 1 kept, 0 broken, 0 not applicable, 1 unchecked, 1 skipped by operator (S: binary fixture)',
    );
    expect(rulesLabel({ assurance: { rules: [row('A', 'kept')] } })).toBe('1 rules checked: 1 kept, 0 broken, 0 not applicable');
    expect(rulesLabel({ assurance: { rules: [] } })).toBeNull();
    expect(rulesLabel({})).toBeNull();
  });
});

describe('(SWAP 6) a rule deferred to delivery', () => {
  it('is counted on the line and the delivery verdict replaces it', () => {
    expect(rulesSummaryLine([row('A', 'kept'), row('learn-linked-issue', 'deferred')])).toBe(
      '2 rules checked: 1 kept, 0 broken, 0 not applicable, 1 deferred to delivery',
    );
    expect(worstRulePerRule([row('learn-linked-issue', 'deferred'), row('learn-linked-issue', 'broken')]).map((r) => r.status)).toEqual(['broken']);
    expect(worstRulePerRule([row('learn-linked-issue', 'deferred'), row('learn-linked-issue', 'n_a')]).map((r) => r.status)).toEqual(['n_a']);
  });
});

describe('(DES-RULE-CHECK-001 rev 2) disputed rows, council rulings and process rows on the line and the delivery', () => {
  it('a disputed row is named on the line, never folded into the counts silently', () => {
    expect(rulesSummaryLine([row('A', 'kept'), row('U', 'unchecked'), DISPUTED])).toBe(
      '3 rules checked: 1 kept, 0 broken, 0 not applicable, 1 unchecked, 1 disputed (you decide)',
    );
  });
  it('a status this crew does not know yet is counted as not ruled', () => {
    expect(rulesSummaryLine([row('A', 'kept'), { ...row('X', 'kept'), status: 'contested' as RuleVerdict['status'] }])).toBe(
      '2 rules checked: 1 kept, 0 broken, 0 not applicable, 1 not ruled',
    );
  });
  it('a council ruling names the rule, the ruling and the counted vote', () => {
    expect(rulesSummaryLine([settled('kept', [['agy', 'kept', true], ['pi', 'kept', true], ['opencode', 'broken', true]])])).toBe(
      '1 rules checked: 1 kept, 0 broken, 0 not applicable, 1 settled by council (S: kept 2-1)',
    );
    // An uncounted vote is not in the tally.
    expect(rulesSummaryLine([settled('broken', [['agy', 'broken', true], ['pi', 'broken', true], ['opencode', 'kept', false]])])).toBe(
      '1 rules checked: 0 kept, 1 broken, 0 not applicable, 1 settled by council (S: broken 2-0)',
    );
    // A ruling reused from the cache (`how: 'cache'`, origin kept) is still the council's.
    expect(rulesSummaryLine([{ ...settled('n_a', [['agy', 'n_a', true], ['pi', 'n_a', true], ['opencode', 'n_a', true]]), how: 'cache' }])).toBe(
      '1 rules checked: 0 kept, 0 broken, 1 not applicable, 1 settled by council (S: not applicable 3-0)',
    );
    // A kept vote that rested on the person's instruction counts toward a waiver, which still holds.
    expect(rulesSummaryLine([settled('waived', [['agy', 'kept', true], ['pi', 'kept', true], ['opencode', 'broken', true]])])).toBe(
      '1 rules checked: 0 kept, 0 broken, 0 not applicable, 1 waived by instruction (to confirm), 1 settled by council (S: waived by instruction 2-1)',
    );
    // No ruling (a disputed row), a plain judge row, and a ruling that is not the row's status are not "settled".
    expect(rulesSummaryLine([DISPUTED, row('J', 'kept')])).not.toContain('settled by council');
    expect(rulesSummaryLine([{ ...settled('kept', [['agy', 'kept', true]]), status: 'broken' }])).not.toContain('settled by council');
  });
  it('process rows (blocking: false) stay out of the gate counts and are reported apart', () => {
    const proc = (id: string, status: RuleVerdict['status']): RuleVerdict => ({ ...row(id, status), party: 'reviewer', blocking: false });
    expect(rulesSummaryLine([row('A', 'kept'), row('B', 'n_a'), proc('RVWL-1001', 'broken'), proc('RVWL-1004', 'kept')])).toBe(
      '2 rules checked: 1 kept, 0 broken, 1 not applicable; 2 process rules reported (do not block): 1 kept, 1 broken, 0 not applicable',
    );
  });
  it('the delivery keeps a disputed row over a later kept one (it held), and a broken one over it', () => {
    expect(worstRulePerRule([DISPUTED, { ...row('DEV-TINYMATH-2', 'kept') }]).map((r) => r.status)).toEqual(['disputed']);
    expect(worstRulePerRule([{ ...row('DEV-TINYMATH-2', 'n_a') }, DISPUTED]).map((r) => r.status)).toEqual(['disputed']);
    expect(worstRulePerRule([DISPUTED, row('DEV-TINYMATH-2', 'broken')]).map((r) => r.status)).toEqual(['broken']);
    // The kept row loses whole: the council record stays on the delivery.
    expect(worstRulePerRule([row('DEV-TINYMATH-2', 'kept'), DISPUTED])[0]).toEqual(DISPUTED);
  });
});
