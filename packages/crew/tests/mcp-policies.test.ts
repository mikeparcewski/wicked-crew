// DES-MCP-TOOLS-001 slice S6 — the MCP policy preview matrix and the approvals routes.
//
// The slice's proving test: the preview matrix EQUALS the engine's own evaluation over the same
// fixture rules. The route is driven over a REAL engine (a stub-runner CoreAdapter on a scratch
// store, which seeds the `mcp-defaults` pack at boot) and a real stdio MCP server
// (tests/fixtures/mcp/fixture-server.mjs); every cell the route answers is compared with a direct
// `Core.previewMcpCalls` over the same calls, and with hand-derived expectations of the posture.
// (wicked-core's own `the_preview_matrix_equals_evaluate_mcp_call_over_the_same_fixture_rules`
// proves the binding equals the token-bound `evaluateMcpCall`, cell by cell.)

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type {
  ConformanceRule,
  McpApprovalResponse,
  McpApprovalsResponse,
  McpPolicyCell,
  McpPolicyPreviewResponse,
  McpPolicyPreviewTool,
  McpPreviewResponse,
  McpToolAnnotations,
} from '../src/core/types.js';
import { deriveToolClass } from '../src/mcp/classify.js';
import { FIRST_USE_LEDGER, McpPolicies, MCP_PREVIEW_SEATS, WRITE_LEDGER } from '../src/mcp/policies.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { removeScratch } from './setup/scratch.js';

const FIXTURE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'fixture-server.mjs');

const noSecrets: SecretStore = {
  available: true,
  get: async () => null,
  has: async () => false,
  set: async () => undefined,
  delete: async () => undefined,
};

const TOOLS = [
  { name: 'wt_echo', description: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'wt_note', description: 'write a note', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
  { name: 'wt_plain', description: 'no annotations', inputSchema: { type: 'object' } },
];

let base: string;
let specPath: string;
let adapter: CoreAdapter;
let app: FastifyInstance;
let audit: AuditLog;
let auditPath: string;
let registry: McpRegistry;

function writeSpec(tools: Array<Record<string, unknown>>): void {
  writeFileSync(specPath, JSON.stringify({ tools }));
}

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url: `/api/v1${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

async function register(): Promise<McpPreviewResponse> {
  const preview = await call('POST', '/mcp/servers/preview', { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath] });
  expect(preview.statusCode, preview.body).toBe(200);
  const body = preview.json() as McpPreviewResponse;
  const saved = await call('POST', '/mcp/servers', { previewHash: body.previewHash });
  expect(saved.statusCode, saved.body).toBe(201);
  return body;
}

async function matrix(body: Record<string, unknown> = { server: 'fx' }): Promise<McpPolicyPreviewResponse> {
  const res = await call('POST', '/mcp/policies/preview', body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as McpPolicyPreviewResponse;
}

function tool(m: McpPolicyPreviewResponse, name: string): McpPolicyPreviewTool {
  const t = m.tools.find((x) => x.tool === name);
  if (t === undefined) throw new Error(`no ${name}`);
  return t;
}

function cell(t: McpPolicyPreviewTool, role: string, seat: string, mode: string): McpPolicyCell {
  const c = t.cells.find((x) => x.role === role && x.seat === seat && x.mode === mode);
  if (c === undefined) throw new Error(`no cell ${role}/${seat}/${mode}`);
  return c;
}

async function ledger(id: string): Promise<string[]> {
  const rule = (await adapter.listConformanceRules()).find((r) => r.id === id);
  return rule?.excludes ?? [];
}

async function upsert(rule: Partial<ConformanceRule> & { id: string }): Promise<void> {
  await adapter.upsertConformanceRule({
    rule_type: 'policy',
    severity: 'error',
    confidence: 1,
    targets: {},
    steering_type: 'security',
    provenance: { source: 'ui', ref: 'test', source_kinds: ['doc'] },
    statement: rule.id,
    ...rule,
  } as ConformanceRule);
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'crew-mcp-policies-'));
  specPath = join(base, 'spec.json');
  writeSpec(TOOLS);
  adapter = new CoreAdapter({ dbPath: join(base, 'core.db'), stub: true });
  registry = new McpRegistry({
    store: new McpRegistryStore(join(base, 'state', 'mcp')),
    secrets: noSecrets,
    probe: probeMcpServer,
    discover: () => [],
  });
  const policies = new McpPolicies(registry, {
    listRules: () => adapter.listConformanceRules(),
    upsertRule: (r) => adapter.upsertConformanceRule(r),
    previewCalls: (j) => adapter.previewMcpCalls(j),
  });
  auditPath = join(base, 'audit.log');
  audit = new AuditLog(auditPath, () => undefined);
  app = Fastify();
  registerMcpRoutes(app, { registry, policies, audit, actorOf: () => LOCAL_ACTOR });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  adapter.close();
  removeScratch(base);
});

describe('the policy preview matrix (S6 proving test)', () => {
  it('equals the engine evaluation over the same fixture rules, cell by cell', async () => {
    await register();
    // Fixture rules: the seeded mcp-defaults pack, the server's first use approved, one write tool
    // approved, a deny by name, and a seat-narrowed deny.
    expect((await call('POST', '/mcp/approvals', { subject: 'mcp:fx' })).statusCode).toBe(200);
    expect((await call('POST', '/mcp/approvals', { subject: 'mcp:fx/wt_plain' })).statusCode).toBe(200);
    await upsert({ id: 'SEC-FX-NO-NOTE', applies_to: ['mcp:fx/wt_note'], effect: 'deny', severity: 'critical' });
    await upsert({ id: 'SEC-FX-NO-CODEX', applies_to: ['mcp:fx'], effect: 'deny', trigger: { contains: '"seat":"codex"' } });

    const m = await matrix();
    expect(m.roles).toEqual(['creator', 'evaluator', 'recon']);
    expect(m.seats).toEqual([...MCP_PREVIEW_SEATS]);
    expect(m.modes).toEqual(['ask', 'balanced', 'autonomous']);
    expect(m.tools.map((t) => t.tool).sort()).toEqual(['wt_echo', 'wt_note', 'wt_plain']);

    // The route's cells are the engine's, over the same calls and cells.
    const cells = m.roles.flatMap((role) => m.seats.flatMap((seat) => m.modes.map((mode) => ({ role, seat, mode }))));
    const calls = m.tools.map((t) => {
      const spec = TOOLS.find((x) => x.name === t.tool);
      return { server: 'fx', tool: t.tool, annotations: spec?.annotations ?? null, classOverride: null, registered: true, kind: 'mcp-stdio' };
    });
    const direct = JSON.parse(await adapter.previewMcpCalls(JSON.stringify({ calls, cells }))) as Array<{ subject: string; cells: Array<McpPolicyCell & { reason?: string }> }>;
    for (const [i, t] of m.tools.entries()) {
      expect(t.subject).toBe(direct[i]?.subject);
      expect(t.cells).toHaveLength(54);
      expect(t.cells).toEqual(direct[i]?.cells.map((c) => ({ ...c, reason: c.reason ?? null })));
    }

    // And the posture a reader can hold it to.
    const echo = tool(m, 'wt_echo');
    const note = tool(m, 'wt_note');
    const plain = tool(m, 'wt_plain');
    expect([echo.class, note.class, plain.class]).toEqual(['read', 'destructive', 'write']);
    for (const mode of m.modes) {
      expect(cell(echo, 'evaluator', 'claude', mode).decision).toBe('allow'); // a read runs anywhere
      expect(cell(plain, 'evaluator', 'claude', mode)).toMatchObject({ decision: 'deny', ruleIds: ['engine:mcp-phase-role'] }); // D-1
      expect(cell(plain, 'recon', 'pi', mode)).toMatchObject({ decision: 'deny', ruleIds: ['engine:mcp-phase-role'] });
      expect(cell(note, 'creator', 'claude', mode)).toMatchObject({ decision: 'deny', ruleIds: ['SEC-FX-NO-NOTE'] });
      expect(cell(echo, 'creator', 'codex', mode)).toMatchObject({ decision: 'deny', ruleIds: ['SEC-FX-NO-CODEX'] });
    }
    expect(cell(plain, 'creator', 'claude', 'ask').decision).toBe('ask'); // ask mode asks for every write
    expect(cell(plain, 'creator', 'claude', 'balanced').decision).toBe('allow'); // approved tool
    expect(cell(plain, 'creator', 'claude', 'autonomous').decision).toBe('allow');
    expect(plain.approval).toEqual({ firstUse: 'server', write: 'tool' });
    expect(note.approval).toEqual({ firstUse: 'server', write: null });
  });

  it('narrows by subject, role, seat, mode and phase, and refuses a bad body', async () => {
    await register();
    const one = await matrix({ subject: 'mcp:fx/wt_plain', phaseRole: 'creator', seat: 'pi', mode: 'balanced', phaseId: 'build' });
    expect(one.tools).toHaveLength(1);
    expect(one.tools[0]?.cells).toEqual([
      expect.objectContaining({ role: 'creator', seat: 'pi', mode: 'balanced', phaseId: 'build', decision: 'ask', ruleIds: ['engine:mcp-first-use', 'MCP-POSTURE-WRITE'] }),
    ]);
    expect(one.phaseId).toBe('build');
    for (const bad of [{ subject: 'mcp:fx/wt_plain', server: 'fx' }, { phaseRole: 'owner' }, { mode: 'yolo' }, { seat: 'p i' }, { extra: 1 }]) {
      expect((await call('POST', '/mcp/policies/preview', bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await call('POST', '/mcp/policies/preview', { subject: 'mcp:fx/ghost' })).statusCode).toBe(404);
    expect((await call('POST', '/mcp/policies/preview', { server: 'nope' })).statusCode).toBe(404);
  });

  it('judges a disabled tool as unregistered (D-5), as the broker would send it', async () => {
    await register();
    await call('POST', '/mcp/approvals', { subject: 'mcp:fx' });
    const off = await app.inject({ method: 'PATCH', url: `/api/v1/mcp/tools/${encodeURIComponent('mcp:fx/wt_echo')}`, payload: { enabled: false } });
    expect(off.statusCode, off.body).toBe(200);
    const echo = tool(await matrix(), 'wt_echo');
    expect(echo.registered).toBe(false);
    expect(new Set(echo.cells.map((c) => c.ruleIds.join()))).toEqual(new Set(['engine:mcp-unregistered']));
  });

  it('answers the matrix on a server preview, judged as if saved now', async () => {
    const first = (await call('POST', '/mcp/servers/preview', { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath] })).json() as McpPreviewResponse;
    expect(first.policies?.withdrawOnSave).toEqual([]);
    const echo = first.policies?.tools.find((t) => t.tool === 'wt_echo');
    expect(echo?.registered).toBe(true);
    // Not saved and never approved: the first use asks, even for a read, in every mode.
    expect(new Set(echo?.cells.filter((c) => c.role === 'creator').map((c) => c.decision))).toEqual(new Set(['ask']));
  });
});

describe('approvals are audited edits of the ledger rules', () => {
  it('a server approval approves first use only; a tool approval approves its writes; revoke undoes both', async () => {
    await register();
    const pending = ((await call('GET', '/mcp/approvals')).json() as McpApprovalsResponse).pending;
    expect(pending.map((p) => [p.tool, p.needs])).toEqual([
      ['wt_echo', ['first-use']],
      ['wt_note', ['first-use', 'write']],
      ['wt_plain', ['first-use', 'write']],
    ]);

    const server = await call('POST', '/mcp/approvals', { subject: 'mcp:fx' });
    expect(server.json()).toEqual({ subject: 'mcp:fx', approved: true, rulesChanged: [FIRST_USE_LEDGER] } satisfies McpApprovalResponse);
    expect(await ledger(FIRST_USE_LEDGER)).toEqual(['mcp:fx']);
    expect(await ledger(WRITE_LEDGER)).toEqual([]);
    let m = await matrix();
    expect(cell(tool(m, 'wt_echo'), 'creator', 'claude', 'balanced').decision).toBe('allow');
    expect(cell(tool(m, 'wt_plain'), 'creator', 'claude', 'balanced')).toMatchObject({ decision: 'ask', ruleIds: ['MCP-POSTURE-WRITE'] });
    expect(cell(tool(m, 'wt_plain'), 'creator', 'claude', 'autonomous').decision).toBe('allow');

    const t = await call('POST', '/mcp/approvals', { subject: 'mcp:fx/wt_plain' });
    expect((t.json() as McpApprovalResponse).rulesChanged).toEqual([FIRST_USE_LEDGER, WRITE_LEDGER]);
    // Idempotent: approving again changes nothing.
    expect(((await call('POST', '/mcp/approvals', { subject: 'mcp:fx/wt_plain' })).json() as McpApprovalResponse).rulesChanged).toEqual([]);
    m = await matrix();
    expect(cell(tool(m, 'wt_plain'), 'creator', 'claude', 'balanced').decision).toBe('allow');
    expect(cell(tool(m, 'wt_plain'), 'evaluator', 'claude', 'balanced').decision).toBe('deny'); // D-1 never lifts
    const approvals = (await call('GET', '/mcp/approvals')).json() as McpApprovalsResponse;
    expect(approvals.approved).toEqual([
      { subject: 'mcp:fx', scope: 'server', firstUse: true, write: false },
      { subject: 'mcp:fx/wt_plain', scope: 'tool', firstUse: true, write: true },
    ]);
    expect(approvals.pending.map((p) => [p.tool, p.needs])).toEqual([['wt_note', ['write']]]);
    expect(approvals.ledgers.firstUse).toEqual({ id: FIRST_USE_LEDGER, present: true, retired: false });

    const revoked = await call('DELETE', `/mcp/approvals/${encodeURIComponent('mcp:fx/wt_plain')}`);
    expect(revoked.json()).toEqual({ subject: 'mcp:fx/wt_plain', approved: false, rulesChanged: [FIRST_USE_LEDGER, WRITE_LEDGER] });
    expect(await ledger(WRITE_LEDGER)).toEqual([]);
    expect(cell(tool(await matrix(), 'wt_plain'), 'creator', 'claude', 'balanced').decision).toBe('ask');

    await audit.flush();
    const trail = readFileSync(auditPath, 'utf8');
    expect(trail).toContain('mcp.approval.granted');
    expect(trail).toContain('mcp.approval.revoked');
    expect(trail).toContain('governance.rule.upserted');
  });

  it('a ledger write that fails part-way is rolled back, and what it left changed is audited', async () => {
    await register();
    let failWrite = true;
    let failRollback = false;
    const flaky = new McpPolicies(registry, {
      listRules: () => adapter.listConformanceRules(),
      upsertRule: async (r) => {
        if (r.id === WRITE_LEDGER && failWrite) throw new Error('store busy');
        if (r.id === FIRST_USE_LEDGER && failRollback && (r.excludes ?? []).length === 0) throw new Error('store gone');
        await adapter.upsertConformanceRule(r);
      },
      previewCalls: (j) => adapter.previewMcpCalls(j),
    });
    const other = Fastify();
    registerMcpRoutes(other, { registry, policies: flaky, audit, actorOf: () => LOCAL_ACTOR });
    await other.ready();
    try {
      const approve = () => other.inject({ method: 'POST', url: '/api/v1/mcp/approvals', payload: { subject: 'mcp:fx/wt_plain' } });
      let res = await approve();
      expect(res.statusCode, res.body).toBe(502);
      expect((res.json() as { code: string }).code).toBe('ledger_edit_failed');
      expect(await ledger(FIRST_USE_LEDGER)).toEqual([]); // rolled back: in both ledgers or in neither
      expect(await ledger(WRITE_LEDGER)).toEqual([]);

      failRollback = true; // the rollback fails too: the change that stuck is named and audited
      res = await approve();
      expect(res.statusCode, res.body).toBe(502);
      expect(await ledger(FIRST_USE_LEDGER)).toEqual(['mcp:fx/wt_plain']);
      await audit.flush();
      const trail = readFileSync(auditPath, 'utf8');
      expect(trail).toContain('mcp.approval.partial');
      expect(trail).toMatch(/governance\.rule\.upserted[^\n]*MCP-FIRST-USE[^\n]*partial/);
      failWrite = false;
      failRollback = false;
    } finally {
      await other.close();
    }
  });

  it('an approval never outranks a deny rule', async () => {
    await register();
    await call('POST', '/mcp/approvals', { subject: 'mcp:fx/wt_plain' });
    await upsert({ id: 'SEC-FX-NO-PLAIN', applies_to: ['mcp:fx/wt_plain'], effect: 'deny' });
    const c = cell(tool(await matrix(), 'wt_plain'), 'creator', 'claude', 'autonomous');
    expect(c).toMatchObject({ decision: 'deny', ruleIds: ['SEC-FX-NO-PLAIN'] });
  });

  it('refuses a bad subject, an unknown server or tool, and revoking what is not approved', async () => {
    await register();
    for (const subject of ['fx', 'mcp:', 'mcp:FX', 'mcp:fx/', 'mcp:fx/a b']) {
      expect((await call('POST', '/mcp/approvals', { subject: subject.padEnd(5, ' ') })).statusCode, subject).toBe(400);
    }
    expect((await call('POST', '/mcp/approvals', { subject: 'mcp:nope' })).statusCode).toBe(404);
    expect((await call('POST', '/mcp/approvals', { subject: 'mcp:fx/ghost' })).statusCode).toBe(404);
    expect((await call('DELETE', `/mcp/approvals/${encodeURIComponent('mcp:fx')}`)).statusCode).toBe(404);
  });

  it('a tool dropped and then returned with a changed schema asks on first use again', async () => {
    await register();
    await call('POST', '/mcp/approvals', { subject: 'mcp:fx/wt_plain' });
    const save = async () => {
      const p = (await call('POST', '/mcp/servers/preview', { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath] })).json() as McpPreviewResponse;
      expect((await call('POST', '/mcp/servers', { previewHash: p.previewHash })).statusCode).toBe(201);
    };
    writeSpec(TOOLS.filter((t) => t.name !== 'wt_plain'));
    await save(); // wt_plain is gone: its approval is inert (D-5) but kept with its last schema
    writeSpec(TOOLS.map((t) => (t.name === 'wt_plain' ? { ...t, description: 'back, changed' } : t)));
    await save();
    expect(await ledger(FIRST_USE_LEDGER)).toEqual([]);
    expect(await ledger(WRITE_LEDGER)).toEqual([]);
    expect(cell(tool(await matrix(), 'wt_plain'), 'creator', 'claude', 'autonomous')).toMatchObject({ decision: 'ask', ruleIds: ['engine:mcp-first-use'] });
  });

  it('a changed schema withdraws the approvals that named it, and so does removing the server', async () => {
    await register();
    await call('POST', '/mcp/approvals', { subject: 'mcp:fx' });
    await call('POST', '/mcp/approvals', { subject: 'mcp:fx/wt_plain' });
    await call('POST', '/mcp/approvals', { subject: 'mcp:fx/wt_echo' });

    // wt_plain's schema changes: re-previewing shows what the save withdraws; the save does it.
    writeSpec(TOOLS.map((t) => (t.name === 'wt_plain' ? { ...t, description: 'changed' } : t)));
    const again = (await call('POST', '/mcp/servers/preview', { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath] })).json() as McpPreviewResponse;
    expect(again.diff?.changed).toEqual(['wt_plain']);
    expect(again.policies?.withdrawOnSave).toEqual(['mcp:fx', 'mcp:fx/wt_plain']);
    expect((await call('POST', '/mcp/servers', { previewHash: again.previewHash })).statusCode).toBe(201);
    expect(await ledger(FIRST_USE_LEDGER)).toEqual(['mcp:fx/wt_echo']);
    expect(await ledger(WRITE_LEDGER)).toEqual(['mcp:fx/wt_echo']);
    const m = await matrix();
    expect(cell(tool(m, 'wt_plain'), 'creator', 'claude', 'autonomous')).toMatchObject({ decision: 'ask', ruleIds: ['engine:mcp-first-use'] });
    expect(cell(tool(m, 'wt_echo'), 'creator', 'claude', 'autonomous').decision).toBe('allow'); // its own approval stands

    expect((await call('DELETE', '/mcp/servers/fx')).statusCode).toBe(200);
    expect(await ledger(FIRST_USE_LEDGER)).toEqual([]);
    expect(await ledger(WRITE_LEDGER)).toEqual([]);
    await audit.flush();
    expect(readFileSync(auditPath, 'utf8')).toContain('mcp.approval.withdrawn');
  });
});

describe('one class derivation', () => {
  it("crew's registry class equals the engine's for every annotation shape", () => {
    const require = createRequire(import.meta.url);
    const { Core } = require('wicked-core-ts') as { Core: { mcpToolClass(a?: string | null, o?: string | null): string } };
    const shapes: Array<McpToolAnnotations | null> = [null, {}, { title: 'x' }, { openWorldHint: true }, { idempotentHint: true }];
    for (const ro of [undefined, true, false]) {
      for (const d of [undefined, true, false]) {
        const a: McpToolAnnotations = {};
        if (ro !== undefined) a.readOnlyHint = ro;
        if (d !== undefined) a.destructiveHint = d;
        shapes.push(a);
      }
    }
    for (const a of shapes) {
      expect(deriveToolClass(a), JSON.stringify(a)).toBe(Core.mcpToolClass(a === null ? null : JSON.stringify(a), null));
    }
  });
});
