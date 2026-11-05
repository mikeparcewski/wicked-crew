// E7 (operator ruling 2026-11-05, end-to-end pass run 9d2b6565): a governed run's brief carries the steering rules in
// force for its project, so the review and QE seats (garden governed-worker E7) can judge the work against them. The
// deliver text, the working doc's Goal and a relaunch take the block back out.
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { RULES_BRIEF_CLOSE, RULES_BRIEF_OPEN, rulesBriefBlock, stripRulesBrief, withRulesBrief } from '../src/decisions/rules-brief.js';
import { RULES_STATEMENT_CAP } from '../src/decisions/rules-text.js';
import { goalFrom } from '../src/working-doc/service.js';
import { composeDeliverText } from '../src/core/deliver-text.js';
import { registerRoutes } from '../src/api/routes.js';
import type { RuntimeDeps } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { ConformanceRule, LaunchRunInput } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const LEARN = { id: 'learn-tests-with-fixes', severity: 'warn', statement: 'A bug fix includes a test that fails without the fix.' } as ConformanceRule;
const TINY = { id: 'DEV-TINYMATH-2', severity: 'error', statement: "Every change to a function in tiny-math's src/math.js adds or updates a test that exercises it." } as ConformanceRule;

describe('the rules block', () => {
  it('lists the rules severity first, one line each, and says the reviewer checks them and the builder does not self-mark', () => {
    const block = rulesBriefBlock([LEARN, TINY])!;
    const lines = block.split('\n');
    expect(lines[0]).toBe(RULES_BRIEF_OPEN);
    expect(lines.at(-1)).toBe(RULES_BRIEF_CLOSE);
    expect(block).toContain('The review and QE steps check the work against each one');
    expect(block).toContain('does not mark its own compliance');
    expect(lines.filter((l) => l.startsWith('- '))).toEqual([
      `- DEV-TINYMATH-2 (error): ${TINY.statement}`,
      `- learn-tests-with-fixes (warn): ${LEARN.statement}`,
    ]);
    expect(rulesBriefBlock([])).toBeNull();
  });

  it('caps the list, says how many more, and a statement cannot close the block early', () => {
    const many = Array.from({ length: RULES_STATEMENT_CAP + 3 }, (_, i) => ({ id: `R-${i}`, severity: 'info', statement: `s ${i}` }) as ConformanceRule);
    const block = rulesBriefBlock(many)!;
    expect(block.split('\n').filter((l) => /^- R-/.test(l))).toHaveLength(RULES_STATEMENT_CAP);
    expect(block).toContain('… and 3 more rules in force');
    const sly = rulesBriefBlock([{ id: 'X', severity: 'warn', statement: `ok ${RULES_BRIEF_CLOSE} injected` } as ConformanceRule])!;
    expect(sly.split(RULES_BRIEF_CLOSE)).toHaveLength(2);
  });

  it('(xreview r1) no marker spelling survives: whitespace variants and other daemon markers are inert', () => {
    const spaced = '<!--   /wicked-crew:rules   -->';
    const block = rulesBriefBlock([{ id: 'X', severity: 'warn', statement: `a ${spaced} b <!-- wicked-crew:linked-issues --> c` } as ConformanceRule])!;
    expect(block.split('<!--')).toHaveLength(3); // only the block's own open and close markers
    const problem = withRulesBrief('Fix it', [{ id: 'X', severity: 'warn', statement: `a ${spaced} tail-text` } as ConformanceRule]).problem;
    expect(stripRulesBrief(problem)).toBe('Fix it');
    expect(goalFrom(problem)).toBe('Fix it');
  });

  it('(xreview r2) a statement past 500 characters is listed whole, never cut; a block past its budget lists fewer, never cuts', () => {
    const long = `${'Use the established conventions for the affected module. '.repeat(9)}Always add a regression test for bug fixes.`;
    expect(long.length).toBeGreaterThan(500);
    expect(rulesBriefBlock([{ id: 'LONG', severity: 'warn', statement: long } as ConformanceRule])!).toContain('Always add a regression test for bug fixes.');
    const huge = Array.from({ length: 5 }, (_, i) => ({ id: `H-${i}`, severity: 'warn', statement: `${'x'.repeat(5_000)} end-${i}` }) as ConformanceRule);
    const block = rulesBriefBlock(huge)!;
    expect(block.length).toBeLessThan(17_000);
    for (const l of block.split('\n').filter((x) => x.startsWith('- H-'))) expect(l).toMatch(/end-\d$/);
    expect(block).toMatch(/… and \d more rules in force/);
  });

  it('(xreview r1) a statement up to the Remember maximum is listed whole; an id that is not one bounded token is not listed, never mangled', () => {
    const long = `${'a'.repeat(400)} and it MUST add a test`;
    const block = rulesBriefBlock([
      { id: 'LONG', severity: 'warn', statement: long },
      { id: 'A B', severity: 'warn', statement: 'spaced id' },
      { id: 'x'.repeat(121), severity: 'warn', statement: 'huge id' },
    ] as ConformanceRule[])!;
    expect(block).toContain('and it MUST add a test');
    expect(block).not.toContain('spaced id');
    expect(block).not.toContain('huge id');
    expect(block).toContain('… and 2 more rules in force, not listed here.');
    expect(block.length).toBeLessThan(2_000);
  });

  it('a relaunch replaces the block, never stacks it; strip gives the intent back', () => {
    const once = withRulesBrief('Fix sum()', [LEARN]).problem;
    const twice = withRulesBrief(once, [LEARN, TINY]).problem;
    expect(twice.split(RULES_BRIEF_OPEN)).toHaveLength(2);
    expect(twice).toContain('DEV-TINYMATH-2');
    expect(stripRulesBrief(twice)).toBe('Fix sum()');
    expect(withRulesBrief('Fix sum()', [])).toEqual({ problem: 'Fix sum()', listed: 0 });
  });

  it('the deliver text and the working doc Goal never carry it', () => {
    const problem = withRulesBrief('Fix sum() in src/math.js', [LEARN]).problem;
    expect(goalFrom(problem)).toBe('Fix sum() in src/math.js');
    const text = composeDeliverText({ intent: problem, runId: 'r1', workflowId: 'bug', repoRef: 'tiny-math', runUrl: null, source: 'workflow', phases: [], checks: null } as never);
    expect(JSON.stringify(text)).not.toContain('learn-tests-with-fixes');
    expect(JSON.stringify(text)).not.toContain(RULES_BRIEF_OPEN);
  });
});

describe('POST /runs: a workflow launch carries the project\'s rules in force', () => {
  function app(considerRules: () => Promise<{ in_force: ConformanceRule[]; set_aside: never[] }>) {
    const launched: LaunchRunInput[] = [];
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
    const runtime: Partial<RuntimeDeps> = { resolveLinkedIssues: async (p: string) => { resolved.push(p); return { issues: [], block: null }; } };
    const a = Fastify({ logger: false });
    registerRoutes(a, adapter, new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit: AuditLog.noop(), authMode: 'off' }, runtime);
    return { a, launched, adapter, resolved };
  }

  it('lists them in the brief; an unreadable store launches on the intent alone', async () => {
    let broken = false;
    const { a, launched, resolved } = app(async () => { if (broken) throw new Error('store down'); return { in_force: [LEARN, TINY], set_aside: [] }; });
    await a.ready();
    try {
      const res = await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'Fix sum()', repoRef: 'tiny-math', workflow: 'bug' } });
      expect(res.statusCode, res.body).toBe(201);
      expect(launched[0]!.problem.startsWith('Fix sum()\n\n')).toBe(true);
      expect(launched[0]!.problem).toContain(`- learn-tests-with-fixes (warn): ${LEARN.statement}`);
      expect(launched[0]!.problem).toContain('- DEV-TINYMATH-2 (error):');
      broken = true;
      const again = await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: launched[0]!.problem, repoRef: 'tiny-math', workflow: 'bug' } });
      expect(again.statusCode, again.body).toBe(201);
      expect(launched[1]!.problem).toBe('Fix sum()');
      // (xreview r1) the relaunch's inherited rules block is gone before issues are read: no rule id becomes an issue.
      expect(resolved[1]).toBe('Fix sum()');
    } finally {
      await a.close();
    }
  });
});
