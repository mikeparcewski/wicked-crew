// DC-S7 — "considered · set aside · cited (unchecked)" for chat turns and run units
// (DES-decision-capture §4.7): considered and set-aside come from core-ts `considerRules`; a cited
// `[rule:<id>]` renders "unchecked" and is never counted as followed; the `considered` key includes
// the attempt; an out-of-scope rule shows as set aside. Plus how seats learn the rules: the scope
// statement lists them, and a rule remembered mid-chat reaches the seats as a disclosed preface.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { extractCitations, verifyCitations } from '../src/api/chat-citations.js';
import { chatScopeStatement, prepareChatScratch } from '../src/api/chat-scope.js';
import { ChatTranscriptStore } from '../src/api/chat-transcripts.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { ConformanceRule, Consideration, CoreEvent } from '../src/core/types.js';
import {
  ConsiderationService,
  RULE_CITED_LABEL,
  extractRuleCitations,
  rulesPreface,
} from '../src/decisions/consider.js';
import { RULE_CONSIDERED } from '../src/decisions/events.js';
import { DecisionLedger } from '../src/decisions/ledger.js';
import type { DecisionRecord } from '../src/decisions/types.js';
import { MembershipIndex } from '../src/projects/membership-index.js';

const scratches: string[] = [];
afterEach(() => {
  for (const s of scratches.splice(0)) rmSync(s, { recursive: true, force: true });
});

function rule(id: string, statement: string, extra: Partial<ConformanceRule> = {}): ConformanceRule {
  return {
    id,
    rule_type: 'policy',
    statement,
    severity: 'warn',
    confidence: 1,
    targets: {},
    provenance: { source: 'proposal', ref: id, source_kinds: ['operator-words'] },
    ...extra,
  };
}

const GLOBAL = rule('proposal:g1', 'Never force-push to main.', { severity: 'error', steering_type: 'operations' });
const KESTREL = rule('proposal:k1', 'Always run the repo checks before a walkthrough.', { targets: { project: 'kestrel' }, steering_type: 'testing' });
const HERON = rule('proposal:h1', 'Prefer feature flags over long branches.', { targets: { project: 'heron' }, severity: 'info' });

function engine(opts: { considerRules?: boolean } = {}) {
  const rules = [GLOBAL, KESTREL, HERON];
  const adapter = {
    projectRulesSupported: vi.fn(() => opts.considerRules !== false),
    listConformanceRules: vi.fn(async () => rules),
    considerRules: vi.fn(async (q: { projects?: string[] }) => ({
      in_force: rules.filter((r) => r.targets.project === undefined || (q.projects ?? []).includes(r.targets.project)),
      set_aside: rules
        .filter((r) => r.targets.project !== undefined && !(q.projects ?? []).includes(r.targets.project))
        .map((r) => ({ id: r.id, statement: r.statement, reason: 'out_of_scope' as const })),
    })),
  };
  if (opts.considerRules === false) delete (adapter as Partial<typeof adapter>).considerRules;
  return adapter;
}

function offered(ledger: DecisionLedger, project: string, statement: string): string {
  const id = `dec_${Math.random().toString(16).slice(2, 10)}`;
  const record: DecisionRecord = {
    op: 'record',
    v: 1,
    id,
    at: Date.now(),
    project_id: project,
    host: 'gate',
    origin: {
      actor: { id: 'op', kind: 'human', trust: 'operator' },
      auth_mode: 'off',
      run_id: 'r1',
      words: statement,
      message_sha256: 'x',
      proposal: null,
      words_source: 'typed',
      redacted: false,
    },
    labels: { deterministic: { template: 'T1-always', exclusions: [], dgc: { durable: true, general: true, checkable: true }, recurrence: { count: 0, first_at: 0, projects: [] } } },
    derived: { statement, polarity: 'do', key: 'k', scope: 'project', steering_type: 'testing' },
    route: 'offer',
  };
  ledger.appendRecord(record);
  ledger.appendOutcome({ op: 'outcome', id, at: Date.now(), state: 'offered', by: { id: 'crew', kind: 'system' }, proposal_id: `p-${id}` });
  return id;
}

function service(opts: { considerRules?: boolean; emit?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'consider-'));
  scratches.push(dir);
  const ledger = new DecisionLedger(join(dir, 'decisions'));
  const transcripts = new ChatTranscriptStore({ dir: join(dir, 'chats') });
  const adapter = engine(opts);
  const emitted: Array<{ type: string; payload: Record<string, unknown>; key: string }> = [];
  const projects = new Map<string, string>([['c1', 'kestrel'], ['r1', 'kestrel'], ['c2', 'heron']]);
  const svc = new ConsiderationService({
    adapter: {
      ...adapter,
      sessionsDetail: vi.fn(async () => [
        {
          session: { id: 'r1' },
          units: [
            { id: 'r1:u0', ord: 0, description: 'plan' },
            { id: 'r1:implement', ord: 1, description: 'implement' },
          ],
        },
      ]),
      workOutput: vi.fn(async (unitId: string) => (unitId === 'r1:implement' ? 'Ran lint first [rule:proposal:k1]; also [rule:proposal:nope].' : null)),
    } as never,
    ledger,
    transcripts,
    projectOf: (id) => projects.get(id),
    emit: opts.emit === false ? null : async (type, payload, key) => {
      emitted.push({ type, payload, key });
      return true;
    },
  });
  return { dir, ledger, transcripts, adapter, svc, emitted };
}

describe('extractRuleCitations', () => {
  it('finds `[rule:<id>]` tokens once each, in order, and ignores look-alikes', () => {
    expect(extractRuleCitations('see [rule:proposal:k1] and [rule:OPS-WATCH-001] then [rule:proposal:k1] again; not [rule:] nor [rule: x]')).toEqual([
      'proposal:k1',
      'OPS-WATCH-001',
    ]);
  });
});

describe('ConsiderationService.forChatTurn', () => {
  it('considered = the engine\'s in-force set for the chat\'s project; set aside = the engine\'s + crew\'s not-confirmed candidates; cited = the replies\' [rule:] tokens, unchecked when in force and unverified otherwise', async () => {
    const h = service();
    h.transcripts.appendUser('c1', 't1', 'plan the test pass', ['codex']);
    h.transcripts.observe({ type: 'chatReply', chat: 'c1', cliKey: 'codex', turn_id: 't1', ok: true, text: 'I will run checks first [rule:proposal:k1] and skip [rule:proposal:zzz].' } as unknown as CoreEvent);
    const pending = offered(h.ledger, 'kestrel', 'Always rebase before review.');
    const c = (await h.svc.forChatTurn('c1', 't1'))!;
    expect(c).not.toBeNull();
    expect(c.subject).toEqual({ kind: 'chat', chat_id: 'c1', turn_id: 't1' });
    expect(c.key).toBe('considered:c1:t1');
    expect(c.project_id).toBe('kestrel');
    expect(c.source).toBe('considerRules');
    // Severity-ordered: the global error rule before the project warn rule.
    expect(c.considered.map((r) => r.id)).toEqual(['proposal:g1', 'proposal:k1']);
    expect(c.considered[1]).toMatchObject({ statement: KESTREL.statement, severity: 'warn', steering_type: 'testing', project: 'kestrel' });
    expect(c.set_aside).toEqual(
      expect.arrayContaining([
        { id: 'proposal:h1', statement: HERON.statement, reason: 'out_of_scope' },
        { id: `p-${pending}`, statement: 'Always rebase before review.', reason: 'not_confirmed' },
      ]),
    );
    expect(c.cited).toEqual([
      { id: 'proposal:k1', by: 'codex', status: 'unchecked', label: RULE_CITED_LABEL },
      { id: 'proposal:zzz', by: 'codex', status: 'unverified', label: 'not an in-force rule here' },
    ]);
    // B4: nothing is ever summed into a "followed" count — not a key, not a label.
    expect(JSON.stringify(c).toLowerCase()).not.toContain('followed');
  });

  it('a P2 chat shows the P1 rule as set aside (out of scope), and answers null for a turn the transcript does not hold', async () => {
    const h = service();
    h.transcripts.appendUser('c2', 't1', 'hello', ['codex']);
    const c = (await h.svc.forChatTurn('c2', 't1'))!;
    expect(c.considered.map((r) => r.id)).toEqual(['proposal:g1', 'proposal:h1']);
    expect(c.set_aside).toContainEqual({ id: 'proposal:k1', statement: KESTREL.statement, reason: 'out_of_scope' });
    expect(await h.svc.forChatTurn('c2', 'nope')).toBeNull();
    expect(await h.svc.forChatTurn('c-unknown', 't1')).toBeNull();
  });

  it('on an engine without considerRules only the global rules are considered, and the source says so', async () => {
    const h = service({ considerRules: false });
    h.transcripts.appendUser('c1', 't1', 'hello', ['codex']);
    const c = (await h.svc.forChatTurn('c1', 't1'))!;
    expect(c.source).toBe('global-only');
    expect(c.considered.map((r) => r.id)).toEqual(['proposal:g1']);
  });
});

describe('ConsiderationService.forUnit', () => {
  it('reads the unit\'s captured output, keys by (run, ord, attempt), and resolves the unit by any key resolveUnit accepts', async () => {
    const h = service();
    const c = (await h.svc.forUnit('r1', 'implement', 2))!;
    expect(c.subject).toEqual({ kind: 'unit', run_id: 'r1', ord: 1, attempt: 2 });
    expect(c.key).toBe('considered:r1:1:2');
    expect(c.cited).toEqual([
      { id: 'proposal:k1', by: 'r1:implement', status: 'unchecked', label: RULE_CITED_LABEL },
      { id: 'proposal:nope', by: 'r1:implement', status: 'unverified', label: 'not an in-force rule here' },
    ]);
    const byOrd = (await h.svc.forUnit('r1', '1'))!;
    expect(byOrd.key).toBe('considered:r1:1:0');
    expect(await h.svc.forUnit('r1', 'u0')).not.toBeNull();
    expect((await h.svc.forUnit('r1', 'u0'))!.cited).toEqual([]);
    expect(await h.svc.forUnit('r1', 'nope')).toBeNull();
    expect(await h.svc.forUnit('r9', '0')).toBeNull();
  });
});

describe('the bus fact wicked.crew.rule.considered', () => {
  it('carries counts and ids only — never a statement — keyed per turn and per (run, ord, attempt)', async () => {
    const h = service();
    h.transcripts.appendUser('c1', 't1', 'plan', ['codex']);
    h.transcripts.observe({ type: 'chatReply', chat: 'c1', cliKey: 'codex', turn_id: 't1', ok: true, text: 'ok [rule:proposal:k1]' } as unknown as CoreEvent);
    await h.svc.onChatTurn('c1', 't1');
    await h.svc.onUnitCaptured('r1', 1, 3);
    expect(h.emitted.map((e) => e.key)).toEqual(['considered:c1:t1', 'considered:r1:1:3']);
    expect(h.emitted[0]).toMatchObject({ type: RULE_CONSIDERED, payload: { chat_id: 'c1', turn_id: 't1', considered_count: 2, set_aside_count: 1, cited_count: 1 } });
    expect(h.emitted[1]).toMatchObject({ type: RULE_CONSIDERED, payload: { run_id: 'r1', ord: 1, attempt: 3, considered_count: 2, cited_count: 2 } });
    expect(JSON.stringify(h.emitted)).not.toContain('force-push');
  });
});

describe('how seats learn the rules', () => {
  it('the scope statement lists the project\'s in-force rules as [rule:<id>] lines, severity-ordered and capped at 20, with the cite instruction', () => {
    const many = Array.from({ length: 25 }, (_, i) => rule(`proposal:m${i}`, `Rule number ${i}.`, { severity: i % 2 === 0 ? 'warn' : 'info' }));
    const text = chatScopeStatement(
      'c1',
      { kind: 'project', projectId: 'kestrel', repos: [], cwd: join(tmpdir(), 'c1'), graph: { bound: false, reason: 'x' }, dangling: [] } as unknown as Parameters<typeof chatScopeStatement>[1],
      [HERON, KESTREL, GLOBAL, ...many],
    );
    const start = text.indexOf('## Rules in force');
    expect(start).toBeGreaterThan(text.indexOf('## Answer format'));
    expect(start).toBeLessThan(text.indexOf('## Decisions'));
    const section = text.slice(start, text.indexOf('## Decisions'));
    const lines = section.split('\n').filter((l) => l.startsWith('- [rule:'));
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('- [rule:proposal:g1] Never force-push to main.');
    expect(lines[1]).toBe('- [rule:proposal:k1] Always run the repo checks before a walkthrough.');
    // Every warn rule precedes every info rule.
    const firstInfo = lines.findIndex((l) => /Rule number \d*[13579]\.|Prefer feature flags/.test(l));
    const lastWarn = lines.map((l, i) => (/Rule number \d*[02468]\./.test(l) ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(lastWarn).toBeLessThan(firstInfo);
    expect(section).toMatch(/8 more rule/);
    expect(section).toMatch(/\[rule:<id>\]/);
    expect(section).toMatch(/cited — unchecked/);
    expect(section.toLowerCase()).not.toContain('followed');
    // No rules: no section at all.
    const bare = chatScopeStatement('c1', { kind: 'none', repos: [], cwd: join(tmpdir(), 'c1'), graph: { bound: false, reason: 'x' }, dangling: [] } as unknown as Parameters<typeof chatScopeStatement>[1]);
    expect(bare).not.toContain('## Rules in force');
  });

  it('prepareChatScratch writes the rules into AGENTS.md and CLAUDE.md', () => {
    const base = mkdtempSync(join(tmpdir(), 'consider-scratch-'));
    scratches.push(base);
    const cwd = join(base, 'c1');
    prepareChatScratch('c1', { kind: 'none', repos: [], cwd, graph: { bound: false, reason: 'x' }, dangling: [] }, [GLOBAL]);
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      expect(readFileSync(join(cwd, name), 'utf8')).toContain('- [rule:proposal:g1] Never force-push to main.');
    }
  });

  it('a rule remembered mid-chat reaches the seats as a crew-authored wicked-context preface on the next send, once', async () => {
    const h = service();
    h.svc.noteChatOpen('c1', [GLOBAL]);
    // Nothing new: no preface.
    expect(await h.svc.prefaceForSend('c1', { inForce: [GLOBAL] })).toBeNull();
    // The project rule lands after the open: the next send carries it, the one after does not.
    const first = await h.svc.prefaceForSend('c1', { inForce: [GLOBAL, KESTREL] });
    expect(first).toBe(rulesPreface([KESTREL]));
    expect(first).toContain('<wicked-context>');
    expect(first).toContain('[rule:proposal:k1] Always run the repo checks before a walkthrough.');
    expect(first).toContain('</wicked-context>');
    expect(await h.svc.prefaceForSend('c1', { inForce: [GLOBAL, KESTREL] })).toBeNull();
    // A chat this daemon did not open (a restart): the first send only seeds, never prefaces.
    expect(await h.svc.prefaceForSend('c9', { inForce: [GLOBAL] })).toBeNull();
    h.svc.chatClosed('c1');
    expect(await h.svc.prefaceForSend('c1', { inForce: [GLOBAL, KESTREL] })).toBeNull();
  });
});

describe('chat citations: the `rule` kind', () => {
  it('extracts [rule:<id>] as kind rule; in force → unchecked with the cited label, unknown → unverified, no in-force set → unchecked', async () => {
    const text = 'Done per [rule:proposal:k1]; see also [rule:proposal:zzz].';
    expect(extractCitations(text, []).map((c) => ({ kind: c.kind, ruleId: c.ruleId }))).toEqual([
      { kind: 'rule', ruleId: 'proposal:k1' },
      { kind: 'rule', ruleId: 'proposal:zzz' },
    ]);
    const deps = {
      fileExists: () => false,
      readLines: async () => null,
      listFiles: async () => [],
      commitExists: async () => ({ outcome: 'missing' as const }),
      now: () => 0,
    } as unknown as Parameters<typeof verifyCitations>[2];
    const withSet = await verifyCitations(text, [], deps, { ruleIds: new Set(['proposal:k1']) });
    expect(withSet.items).toEqual([
      { raw: '[rule:proposal:k1]', kind: 'rule', status: 'unchecked', note: RULE_CITED_LABEL },
      { raw: '[rule:proposal:zzz]', kind: 'rule', status: 'unverified', note: 'not an in-force rule here' },
    ]);
    expect(withSet.verified).toBe(0);
    const noSet = await verifyCitations(text, [], deps, {});
    expect(noSet.items.every((i) => i.status === 'unchecked' && i.note === RULE_CITED_LABEL)).toBe(true);
  });
});

describe('the routes', () => {
  const apps: Array<{ app: FastifyInstance; dir: string }> = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) {
      await a.app.close();
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  async function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'consider-routes-'));
    const transcripts = new ChatTranscriptStore({ dir: join(dir, 'chats') });
    const adapter = {
      ...engine(),
      sessionsDetail: vi.fn(async () => [
        { session: { id: 'r1', workflow_id: 'bug', status: 'completed', clis: ['claude'], unit_ix: 0, attempt: 0 }, units: [{ id: 'r1:u0', ord: 0, description: 'plan', status: 'done' }] },
      ]),
      sessions: vi.fn(async () => ['r1']),
      listRepos: vi.fn(async () => []),
      workOutput: vi.fn(async () => 'All good [rule:proposal:k1].'),
      steeringSupported: vi.fn(() => true),
    };
    const index = new MembershipIndex();
    index.set('r1', 'kestrel');
    index.set('c1', 'kestrel');
    const app = Fastify({ logger: false });
    app.decorateRequest('actor', null as unknown as never);
    app.addHook('onRequest', async (req) => {
      const h = req.headers['x-actor'];
      if (typeof h === 'string') {
        const [kind, trust] = h.split(':');
        (req as unknown as { actor: unknown }).actor = { id: `${kind}-1`, kind, trust };
      }
    });
    registerRoutes(
      app,
      adapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index, log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'required' },
      { chatTranscripts: transcripts, decisionLedger: new DecisionLedger(join(dir, 'decisions')), decisionsMode: 'ledger', broadcast: () => undefined },
    );
    await app.ready();
    apps.push({ app, dir });
    return { app, transcripts };
  }

  it('GET /chats/:id/turns/:turnId/considered and GET /runs/:id/units/:unitKey/considered?attempt= answer the Consideration (operator+), 404 for an unknown subject', async () => {
    const h = await harness();
    h.transcripts.appendUser('c1', 't1', 'plan it', ['codex']);
    h.transcripts.observe({ type: 'chatReply', chat: 'c1', cliKey: 'codex', turn_id: 't1', ok: true, text: 'sure [rule:proposal:k1]' } as unknown as CoreEvent);
    const chat = await h.app.inject({ method: 'GET', url: '/api/v1/chats/c1/turns/t1/considered', headers: { 'x-actor': 'human:operator' } });
    expect(chat.statusCode, chat.body).toBe(200);
    const c = chat.json() as Consideration;
    expect(c.key).toBe('considered:c1:t1');
    expect(c.cited).toEqual([{ id: 'proposal:k1', by: 'codex', status: 'unchecked', label: RULE_CITED_LABEL }]);
    const unit = await h.app.inject({ method: 'GET', url: '/api/v1/runs/r1/units/u0/considered?attempt=2', headers: { 'x-actor': 'human:operator' } });
    expect(unit.statusCode, unit.body).toBe(200);
    expect((unit.json() as Consideration).key).toBe('considered:r1:0:2');
    expect((unit.json() as Consideration).considered.map((r) => r.id)).toEqual(['proposal:g1', 'proposal:k1']);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/runs/r1/units/u0/considered?attempt=x', headers: { 'x-actor': 'human:operator' } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/chats/c1/turns/t9/considered', headers: { 'x-actor': 'human:operator' } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/runs/r9/units/u0/considered', headers: { 'x-actor': 'human:operator' } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/chats/c1/turns/t1/considered', headers: { 'x-actor': 'human:observer' } })).statusCode).toBe(403);
  });
});
