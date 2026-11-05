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

function view(id: string) {
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude', 'pi'], status: 'awaiting_human', human_confirm: 'none', unit_ix: 3, attempt: 2,
      workdir: null, repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [
      { id: `${id}:verify`, session_id: id, ord: 4, description: 'verify', status: 'rejected', assigned_cli: 'pi', denial: { source: 'rules_unchecked', reason: 'x' } },
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
      sessionsDetail: vi.fn().mockResolvedValue([view('run-rules')]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      confirmGate: vi.fn(async (...args: unknown[]) => {
        confirmCalls.push(args);
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

  const post = (body: Record<string, unknown>, actor = 'human/operator') =>
    app.inject({ method: 'POST', url: '/api/v1/runs/run-rules/gate', headers: { 'x-test-actor': actor }, payload: body });

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
