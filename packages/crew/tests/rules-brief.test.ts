// E7 (operator ruling 2026-11-05) + DES-RULE-CHECK-001 S1: a governed run's brief names EVERY steering rule in force
// for its project, matched against the job (applies / may apply / not applicable with the fact), none cut. The deliver
// text, the working doc's Goal and a relaunch take the block back out.
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  RULES_BRIEF_CLOSE,
  RULES_BRIEF_OPEN,
  RULES_BLOCK_MAX_BYTES,
  matchRulesForJob,
  rulesBriefBlock,
  stripRulesBrief,
  withRulesBrief,
  type RuleMatch,
} from '../src/decisions/rules-brief.js';
import { goalFrom } from '../src/working-doc/service.js';
import { composeDeliverText } from '../src/core/deliver-text.js';
import { registerRoutes } from '../src/api/routes.js';
import type { RuntimeDeps } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { ConformanceRule, LaunchRunInput } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const LEARN = { id: 'learn-tests-with-fixes', severity: 'warn', steering_type: 'testing', statement: 'A bug fix includes a test that fails without the fix.' } as ConformanceRule;
const TINY = { id: 'DEV-TINYMATH-2', severity: 'warn', steering_type: 'development', statement: "Every change to a function in tiny-math's src/math.js adds or updates a test that exercises it." } as ConformanceRule;

const MCPS = ['scope', 'design', 'build', 'test', 'security-review', 'observability-review', 'install'];
const r = (id: string, severity: ConformanceRule['severity'], steering_type: string, applies_to: string[] = []): ConformanceRule =>
  ({ id, severity, steering_type, applies_to, statement: `${id} statement.` }) as unknown as ConformanceRule;

/** The 30 rules in force on the test rig for E7 job 4ded4922, in the store order that cut learn-tests-with-fixes. */
function rigRules(): ConformanceRule[] {
  return [
    r('MCPS-1004', 'critical', 'security', MCPS),
    r('EDITOR-GRANTS', 'error', 'security', ['editor']),
    r('MCP-FIRST-USE', 'error', 'security', ['mcp']),
    r('MCP-MODE-ASK-WRITE', 'error', 'security', ['mcp-mode:ask']),
    r('MCP-POSTURE-WRITE', 'error', 'security', ['mcp-mode:balanced']),
    r('MCPS-1001', 'error', 'architecture', MCPS),
    r('MCPS-1002', 'error', 'operations', MCPS),
    r('MCPS-1003', 'error', 'operations', MCPS),
    r('MCPS-1005', 'error', 'security', MCPS),
    r('MCPS-1006', 'error', 'testing', MCPS),
    r('POL-2101', 'error', 'development', ['build', 'review']),
    r('RVWL-1001', 'error', 'testing', ['review', 'adversarial-review', 'test', 'verify', 'security-review', 'observability-review']),
    r('RVWL-1002', 'error', 'development', ['build', 'implement', 'fix', 'execute', 'test', 'verify']),
    r('RVWL-1003', 'error', 'operations', ['build', 'implement', 'fix', 'review', 'adversarial-review', 'test', 'verify']),
    r('DEV-TINYMATH-1', 'warn', 'development'),
    TINY,
    r('MCPS-1007', 'warn', 'compliance', MCPS),
    r('RVWL-1004', 'warn', 'operations', ['scope', 'clarify', 'plan', 'design']),
    r('learn-accessible', 'warn', 'design-ux'),
    r('learn-linked-issue', 'warn', 'development'),
    r('learn-no-secrets', 'warn', 'security'),
    r('learn-reversible-migrations', 'warn', 'operations'),
    r('learn-small-prs', 'warn', 'development'),
    LEARN,
    r('EDITOR-BUILTIN', 'info', 'security', ['editor-origin:first-party']),
    r('EDITOR-BUILTIN-DOC-MEDIA', 'info', 'security', ['editor-origin:first-party']),
    r('EDITOR-BUILTIN-PAGE-MEDIA', 'info', 'security', ['editor-origin:first-party']),
    r('EDITOR-BUILTIN-THEME', 'info', 'security', ['editor-origin:first-party']),
    r('EDITOR-OPEN-DEFAULTS', 'info', 'security', ['editor']),
    r('MCP-POSTURE-READ', 'info', 'security', ['mcp']),
  ];
}

const bugJob = () => ({ workflow: 'bug', steps: null, kinds: BUILTIN_WORKFLOWS.find((w) => w.id === 'bug')!.phases.map((p) => String(p.kind)), project: null });

/** A stand-in engine answer: the given statuses, every other rule may apply. */
function answer(statuses: Record<string, RuleMatch['status']>) {
  return async (argsJson: string): Promise<string> => {
    const { rules } = JSON.parse(argsJson) as { rules: ConformanceRule[] };
    return JSON.stringify({
      matches: rules.map((x) => ({
        rule_id: x.id,
        status: statuses[x.id] ?? 'may_apply',
        facts: [{ kind: statuses[x.id] === 'not_applicable' ? 'phase' : 'unscoped', detail: statuses[x.id] === 'not_applicable' ? `selected for install; bug has triage, reproduce, fix, verify` : 'no scope' }],
      })),
    });
  };
}

const ruleLines = (block: string) => block.split('\n').filter((l) => l.startsWith('- '));

describe('the rules block', () => {
  it('lists every rule with its match: rules to check whole, not-applicable ones with their fact', async () => {
    const rules = [LEARN, TINY, r('MCPS-1004', 'critical', 'security', MCPS)];
    const matches = await matchRulesForJob(rules, bugJob(), answer({ 'MCPS-1004': 'not_applicable', 'DEV-TINYMATH-2': 'applies' }));
    const block = rulesBriefBlock(rules, matches)!;
    const lines = block.split('\n');
    expect(lines[0]).toBe(RULES_BRIEF_OPEN);
    expect(lines.at(-1)).toBe(RULES_BRIEF_CLOSE);
    expect(block).toContain('3 in force, 2 to check (1 apply, 1 may apply), 1 not applicable');
    expect(block).toContain('does not mark its own compliance');
    expect(block).toContain(`- [may apply] learn-tests-with-fixes (warn): ${LEARN.statement}`);
    expect(block).toContain(`- [applies] DEV-TINYMATH-2 (warn): ${TINY.statement}`);
    expect(block).toContain('- MCPS-1004: selected for install; bug has triage, reproduce, fix, verify');
    expect(rulesBriefBlock([], [])).toBeNull();
  });

  it('(S1) the rig bug job: nothing is cut. Store order with 25+ rules ahead still lists learn-tests-with-fixes and DEV-TINYMATH-2, and every not-applicable rule carries its fact', async () => {
    const rules = rigRules();
    const na = Object.fromEntries(
      ['EDITOR-GRANTS', 'MCP-FIRST-USE', 'MCP-MODE-ASK-WRITE', 'MCP-POSTURE-WRITE', 'EDITOR-BUILTIN', 'EDITOR-BUILTIN-DOC-MEDIA', 'EDITOR-BUILTIN-PAGE-MEDIA', 'EDITOR-BUILTIN-THEME', 'EDITOR-OPEN-DEFAULTS', 'MCP-POSTURE-READ'].map((id) => [id, 'not_applicable' as const]),
    );
    const matches = await matchRulesForJob(rules, bugJob(), answer(na));
    const block = rulesBriefBlock(rules, matches)!;
    expect(ruleLines(block)).toHaveLength(30);
    for (const x of rules) expect(block).toContain(x.id);
    expect(block).toContain(`learn-tests-with-fixes (warn): ${LEARN.statement}`);
    expect(block).toContain(`DEV-TINYMATH-2 (warn): ${TINY.statement}`);
    expect(block).toContain('20 to check');
    const naSection = block.slice(block.indexOf('Not applicable to this job'));
    for (const id of Object.keys(na)) expect(naSection).toMatch(new RegExp(`- ${id}: selected for install; bug has triage`));
    expect(block).not.toMatch(/more rules? in force, not listed/);
  });

  it('(S1) a 100-rule store: no rule is dropped; statements past the size limit drop to the id, never the rule', async () => {
    const rules = Array.from({ length: 100 }, (_, i) => ({ id: `R-${String(i).padStart(3, '0')}`, severity: 'warn', statement: `${'x'.repeat(2_000)} end-${i}` }) as ConformanceRule);
    const matches = await matchRulesForJob(rules, bugJob(), answer({ 'R-007': 'not_applicable' }));
    expect(matches).toHaveLength(100);
    const block = rulesBriefBlock(rules, matches)!;
    expect(ruleLines(block)).toHaveLength(100);
    for (const x of rules) expect(block).toContain(x.id);
    expect(block).toContain("did not fit this brief's size limit");
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(RULES_BLOCK_MAX_BYTES);
    for (const l of ruleLines(block).filter((x) => x.includes('end-'))) expect(l).toMatch(/end-\d+$/u);
  });

  it('(xreview r1 on S1) the WHOLE block is bounded in UTF-8 bytes: CJK statements, hundreds of long not-applicable facts, six hundred rules', async () => {
    const cjk = Array.from({ length: 128 }, (_, i) => ({ id: `C-${i}`, severity: 'warn', statement: '規'.repeat(500) }) as ConformanceRule);
    const naMany = Array.from({ length: 400 }, (_, i) => ({ id: `N-${i}`, severity: 'warn', statement: 's' }) as ConformanceRule);
    const longFact = async (argsJson: string) => {
      const { rules } = JSON.parse(argsJson) as { rules: ConformanceRule[] };
      return JSON.stringify({ matches: rules.map((x) => ({ rule_id: x.id, status: 'not_applicable', facts: [{ kind: 'phase', detail: 'y'.repeat(400) }] })) });
    };
    const thousand = Array.from({ length: 600 }, (_, i) => ({ id: `T-${i}`, severity: 'warn', statement: 'z'.repeat(300) }) as ConformanceRule);
    for (const [rules, match] of [[cjk, null], [naMany, longFact], [thousand, null]] as const) {
      const block = rulesBriefBlock(rules, await matchRulesForJob(rules, bugJob(), match))!;
      expect(Buffer.byteLength(block)).toBeLessThanOrEqual(RULES_BLOCK_MAX_BYTES);
      for (const x of rules) expect(block).toContain(`${x.id}`);
    }
    // Ids of thousands of characters cannot all fit: the rest is said in one line, never dropped silently.
    const huge = Array.from({ length: 40 }, (_, i) => ({ id: `H${i}-${'q'.repeat(3_000)}`, severity: 'warn', statement: 's' }) as ConformanceRule);
    const block = rulesBriefBlock(huge, await matchRulesForJob(huge, bugJob(), null))!;
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(RULES_BLOCK_MAX_BYTES);
    const named = ruleLines(block).filter((l) => l.startsWith('- [may apply]')).length;
    expect(block).toContain(`- … and ${40 - named} more rules in force whose ids did not fit`);
    // (xreview r2 on S1) an oversized id is skipped, not the end: the short ids after it are still named.
    const mixed = [{ id: `BIG-${'q'.repeat(30_000)}`, severity: 'critical', statement: 's' }, ...Array.from({ length: 5 }, (_, i) => ({ id: `S-${i}`, severity: 'warn', statement: 'short' }))] as ConformanceRule[];
    const m = rulesBriefBlock(mixed, await matchRulesForJob(mixed, bugJob(), null))!;
    for (let i = 0; i < 5; i += 1) expect(m).toContain(`- [may apply] S-${i} (warn): short`);
    expect(m).toContain('- … and 1 more rule in force whose ids did not fit');
  });

  it('(S1) an engine without matchRules, a failure or a short answer: every rule still listed, the rest as may apply', async () => {
    const rules = rigRules();
    expect((await matchRulesForJob(rules, bugJob(), null)).every((m) => m.status === 'may_apply')).toBe(true);
    expect(await matchRulesForJob(rules, bugJob(), async () => { throw new Error('boom'); })).toHaveLength(30);
    const short = await matchRulesForJob(rules, bugJob(), async () => JSON.stringify({ matches: [{ rule_id: 'MCPS-1004', status: 'not_applicable', facts: [{ kind: 'phase', detail: 'x' }] }, { rule_id: 'not-a-rule', status: 'applies', facts: [] }] }));
    expect(short).toHaveLength(30);
    expect(short[0]).toMatchObject({ rule_id: 'MCPS-1004', status: 'not_applicable' });
    expect(short.find((m) => m.rule_id === 'learn-tests-with-fixes')!.facts[0]!.kind).toBe('unmatched');
  });

  it.runIf(CoreAdapter.ruleMatcher() !== null)('(S1) the real engine match on the rig bug launch: learn-tests-with-fixes and DEV-TINYMATH-2 to check, the tool-token rules ruled out by fact', async () => {
    const matches = await matchRulesForJob(rigRules(), bugJob(), CoreAdapter.ruleMatcher());
    const status = (id: string) => matches.find((m) => m.rule_id === id)!.status;
    expect(matches).toHaveLength(30);
    expect(status('learn-tests-with-fixes')).toBe('may_apply');
    expect(status('DEV-TINYMATH-2')).toBe('may_apply');
    expect(status('MCPS-1004')).toBe('may_apply');
    for (const id of ['MCP-FIRST-USE', 'EDITOR-BUILTIN', 'EDITOR-GRANTS']) expect(status(id)).toBe('not_applicable');
    for (const m of matches.filter((x) => x.status === 'not_applicable')) expect(m.facts.length).toBeGreaterThan(0);
  });

  it('a statement cannot close the block early; no marker spelling survives', async () => {
    const spaced = '<!--   /wicked-crew:rules   -->';
    const rules = [{ id: 'X', severity: 'warn', statement: `ok ${RULES_BRIEF_CLOSE} a ${spaced} b <!-- wicked-crew:linked-issues --> c` } as ConformanceRule];
    const block = rulesBriefBlock(rules, await matchRulesForJob(rules, bugJob(), null))!;
    expect(block.split('<!--')).toHaveLength(3); // only the block's own open and close markers
    const problem = withRulesBrief('Fix it', rules, await matchRulesForJob(rules, bugJob(), null)).problem;
    expect(stripRulesBrief(problem)).toBe('Fix it');
    expect(goalFrom(problem)).toBe('Fix it');
  });

  it('(xreview r1 on S1) an id that is not one bounded token is listed whole and reversible, and distinct ids stay distinct', async () => {
    const long = 'x'.repeat(120);
    const rules = [
      { id: 'A B', severity: 'warn', statement: 'spaced id' },
      { id: 'A  B', severity: 'warn', statement: 'double-spaced id' },
      { id: `${long}A`, severity: 'warn', statement: 'long A' },
      { id: `${long}B`, severity: 'warn', statement: 'long B' },
      { id: 'evil<!--x-->', severity: 'warn', statement: 'marker id' },
      { id: 'E', severity: 'warn', statement: '' },
    ] as ConformanceRule[];
    const block = rulesBriefBlock(rules, await matchRulesForJob(rules, bugJob(), null))!;
    expect(block).toContain('[may apply] "A B" (warn): spaced id');
    expect(block).toContain('[may apply] "A  B" (warn): double-spaced id');
    expect(block).toContain(`"${long}A" (warn): long A`);
    expect(block).toContain(`"${long}B" (warn): long B`);
    expect(block).toContain('"evil\\u003c!--x--\\u003e" (warn): marker id');
    expect(JSON.parse('"evil\\u003c!--x--\\u003e"')).toBe('evil<!--x-->');
    expect(block.split('<!--')).toHaveLength(3);
    expect(block).toContain('- [may apply] E (warn): (no statement recorded)');
  });

  it('a relaunch replaces the block, never stacks it; strip gives the intent back', async () => {
    const once = withRulesBrief('Fix sum()', [LEARN], await matchRulesForJob([LEARN], bugJob(), null)).problem;
    const twice = withRulesBrief(once, [LEARN, TINY], await matchRulesForJob([LEARN, TINY], bugJob(), null)).problem;
    expect(twice.split(RULES_BRIEF_OPEN)).toHaveLength(2);
    expect(twice).toContain('DEV-TINYMATH-2');
    expect(stripRulesBrief(twice)).toBe('Fix sum()');
    expect(withRulesBrief('Fix sum()', [], [])).toEqual({ problem: 'Fix sum()', listed: 0, notApplicable: 0 });
  });

  it('the deliver text and the working doc Goal never carry it', async () => {
    const problem = withRulesBrief('Fix sum() in src/math.js', [LEARN], await matchRulesForJob([LEARN], bugJob(), null)).problem;
    expect(goalFrom(problem)).toBe('Fix sum() in src/math.js');
    const text = composeDeliverText({ intent: problem, runId: 'r1', workflowId: 'bug', repoRef: 'tiny-math', runUrl: null, source: 'workflow', phases: [], checks: null } as never);
    expect(JSON.stringify(text)).not.toContain('learn-tests-with-fixes');
    expect(JSON.stringify(text)).not.toContain(RULES_BRIEF_OPEN);
  });
});

describe("POST /runs: a workflow launch carries the project's rules in force, matched, none cut", () => {
  function app(considerRules: () => Promise<{ in_force: ConformanceRule[]; set_aside: never[] }>, matchRules?: (a: string) => Promise<string>) {
    const launched: LaunchRunInput[] = [];
    const matchArgs: unknown[] = [];
    const bug = BUILTIN_WORKFLOWS.find((w) => w.id === 'bug')!;
    const adapter = {
      sessionsDetail: vi.fn(async () => []),
      sessions: vi.fn(async () => []),
      runEvents: vi.fn(async () => null),
      listRepos: vi.fn(async () => [{ id: 'tiny-math', name: 'tiny-math', root_path: '/srv/tiny-math', registered_at: 1 }]),
      getWorkflow: vi.fn((id: string) => (id === 'bug' ? bug : null)),
      getSettings: vi.fn(async () => ({ deliverDefault: 'none' })),
      launchRun: vi.fn(async (input: LaunchRunInput) => { launched.push(input); return input.sessionId; }),
      engineCapabilities: vi.fn(() => ({ deliverGate: true, revisesPr: true })),
      projectRulesSupported: () => true,
      considerRules: vi.fn(considerRules),
      ping: vi.fn(async () => 'ok'),
    } as unknown as CoreAdapter;
    const resolved: string[] = [];
    const runtime: Partial<RuntimeDeps> = {
      resolveLinkedIssues: async (p: string) => { resolved.push(p); return { issues: [], block: null }; },
      // No engine matcher by default: every rule may apply, none cut (the addon this daemon may run on).
      matchRules: matchRules ?? (async () => { throw new Error('no matchRules on this addon'); }),
    };
    if (matchRules !== undefined) {
      runtime.matchRules = async (a: string) => { matchArgs.push(JSON.parse(a)); return matchRules(a); };
    }
    const a = Fastify({ logger: false });
    registerRoutes(a, adapter, new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit: AuditLog.noop(), authMode: 'off' }, runtime);
    return { a, launched, adapter, resolved, matchArgs };
  }

  it('(S1, fails on main) the rig bug job: the brief lists learn-tests-with-fixes and DEV-TINYMATH-2 behind 25+ MCP and review-loop rules', async () => {
    const { a, launched } = app(async () => ({ in_force: rigRules(), set_aside: [] }));
    await a.ready();
    try {
      const res = await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'Fix sum()', repoRef: 'tiny-math', workflow: 'bug' } });
      expect(res.statusCode, res.body).toBe(201);
      const problem = launched[0]!.problem;
      expect(problem).toContain(`learn-tests-with-fixes (warn): ${LEARN.statement}`);
      expect(problem).toContain(`DEV-TINYMATH-2 (warn): ${TINY.statement}`);
      for (const x of rigRules()) expect(problem).toContain(x.id);
      expect(problem).not.toMatch(/more rules? in force, not listed/);
    } finally {
      await a.close();
    }
  });

  it('(xreview r2 on S1) a launch with an explicit plan carries the rules too', async () => {
    const { a, launched } = app(async () => ({ in_force: [LEARN, TINY], set_aside: [] }));
    await a.ready();
    try {
      const res = await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'Fix sum()', repoRef: 'tiny-math', plan: { steps: [{ catalog: 'build' }] } } });
      expect(res.statusCode, res.body).toBe(201);
      expect(launched[0]!.problem).toContain(`learn-tests-with-fixes (warn): ${LEARN.statement}`);
    } finally {
      await a.close();
    }
  });

  it('(xreview r1 on S1) a free-text relaunch drops an inherited rules block and lists none', async () => {
    const { a, launched } = app(async () => ({ in_force: [LEARN], set_aside: [] }));
    await a.ready();
    try {
      const inherited = withRulesBrief('Make it faster', [LEARN], await matchRulesForJob([LEARN], bugJob(), null)).problem;
      const res = await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: inherited, repoRef: 'tiny-math' } });
      expect(res.statusCode, res.body).toBe(201);
      expect(launched[0]!.problem).toBe('Make it faster');
    } finally {
      await a.close();
    }
  });

  it("hands the engine the workflow's kinds and the project; renders its answer; an unreadable store launches on the intent alone", async () => {
    let broken = false;
    const { a, launched, resolved, matchArgs } = app(
      async () => { if (broken) throw new Error('store down'); return { in_force: [LEARN, TINY], set_aside: [] }; },
      answer({ 'DEV-TINYMATH-2': 'applies' }),
    );
    await a.ready();
    try {
      const res = await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'Fix sum()', repoRef: 'tiny-math', workflow: 'bug' } });
      expect(res.statusCode, res.body).toBe(201);
      expect(matchArgs[0]).toMatchObject({ job: { workflow: 'bug', project: null, steps: null, kinds: ['recon', 'test', 'build', 'test'] } });
      expect(launched[0]!.problem.startsWith('Fix sum()\n\n')).toBe(true);
      expect(launched[0]!.problem).toContain(`- [may apply] learn-tests-with-fixes (warn): ${LEARN.statement}`);
      expect(launched[0]!.problem).toContain('- [applies] DEV-TINYMATH-2 (warn):');
      broken = true;
      const again = await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: launched[0]!.problem, repoRef: 'tiny-math', workflow: 'bug' } });
      expect(again.statusCode, again.body).toBe(201);
      expect(launched[1]!.problem).toBe('Fix sum()');
      // (xreview r1 on #1363) the relaunch's inherited rules block is gone before issues are read.
      expect(resolved[1]).toBe('Fix sum()');
    } finally {
      await a.close();
    }
  });
});
