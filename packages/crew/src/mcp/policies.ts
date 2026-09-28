/**
 * MCP policies: the preview matrix and the approvals (DES-MCP-TOOLS-001 §4.5, §4.7, §8; slice S6).
 *
 * - **Preview.** `preview` answers what a call to each tool WOULD get, per phase role × seat × run
 *   mode, under the policies in the store right now. It is the engine's own evaluation
 *   (`Core.previewMcpCalls`, the same `evaluate` the broker's `evaluateMcpCall` runs) over
 *   synthetic unit cells, and nothing is recorded. `previewUnsaved` does the same for a server
 *   that is being added, judged as if it were saved now.
 * - **Approvals.** An approval is an audited policy edit, never a grant. It adds a token to the
 *   `excludes` of the ledger rules the `mcp-defaults` pack ships: `MCP-FIRST-USE` (the first use
 *   of a server asks in every mode) and `MCP-POSTURE-WRITE` (balanced mode asks for a write until
 *   the tool is approved). Approving a SERVER (`mcp:<server>`) approves its first use only, so its
 *   write tools still ask in balanced mode, one by one (§4.5: a server-level grant would hide the
 *   destructive tools behind the one read the operator tried). Approving a TOOL
 *   (`mcp:<server>/<tool>`) approves that tool's first use and its writes. Revoking removes the
 *   token from both. An approval never lifts an engine gate (D-1, D-5) or an explicit deny:
 *   deny dominates in the engine.
 * - **Withdrawal.** A saved tool whose schema changed, and a removed server, lose their approvals,
 *   so the next call asks again (operator decision 1: first use asks, "and again when a tool's
 *   schema changes"). A server-wide approval cannot exclude one tool, so a changed tool withdraws
 *   the server's approval too: the server asks again on its next first use.
 *
 * Ledger edits are read-modify-write of one rule, so they are serialized here.
 */

import type {
  ConformanceRule,
  McpApproval,
  McpApprovalsResponse,
  McpApprovalState,
  McpDecision,
  McpLedgerState,
  McpPendingApproval,
  McpPhaseRole,
  McpPolicyCell,
  McpPolicyPreviewResponse,
  McpPreviewTool,
  McpRunMode,
  McpServer,
  McpTool,
  McpToolAnnotations,
  McpToolClass,
  McpUpstreamKind,
} from '../core/types.js';
import { MCP_SERVER_NAME_RE, parseMcpSubject } from './classify.js';
import { McpRegistryError, type McpRegistry } from './registry.js';

/**
 * A ledger edit that failed part-way. `changed` names the rules still changed after the rollback
 * (empty when the rollback restored them all); the route audits those before answering 502.
 */
export class McpLedgerEditError extends McpRegistryError {
  constructor(
    readonly changed: string[],
    message: string,
  ) {
    super(502, 'ledger_edit_failed', message);
  }
}

/** The first-use approvals ledger (the engine reads its `excludes`, active or retired). */
export const FIRST_USE_LEDGER = 'MCP-FIRST-USE';
/** The balanced-mode write approvals ledger. */
export const WRITE_LEDGER = 'MCP-POSTURE-WRITE';

/** The six seats a governed unit can run on; the matrix has one column per seat. */
export const MCP_PREVIEW_SEATS = ['claude', 'codex', 'opencode', 'copilot', 'pi', 'agy'] as const;
export const MCP_PREVIEW_ROLES: readonly McpPhaseRole[] = ['creator', 'evaluator', 'recon'];
export const MCP_RUN_MODES: readonly McpRunMode[] = ['ask', 'balanced', 'autonomous'];

/** The engine seam this module needs: the rule store and the preview binding. */
export interface McpPolicyEngine {
  listRules(): Promise<ConformanceRule[]>;
  upsertRule(rule: ConformanceRule): Promise<void>;
  /** `Core.previewMcpCalls`: `{calls, cells}` → `[{subject, cells}]` as JSON. */
  previewCalls(requestJson: string): Promise<string>;
}

export interface McpPolicyQuery {
  subject?: string | undefined;
  server?: string | undefined;
  phaseRole?: McpPhaseRole | undefined;
  seat?: string | undefined;
  mode?: McpRunMode | undefined;
  phaseId?: string | undefined;
}

interface EngineCall {
  server: string;
  tool: string;
  annotations: McpToolAnnotations | null;
  classOverride: McpToolClass | null;
  registered: boolean;
  kind: McpUpstreamKind;
}

interface EngineCell {
  role: McpPhaseRole;
  seat: string;
  mode: McpRunMode;
  phaseId?: string;
}

interface EngineVerdict extends EngineCell {
  decision: McpDecision;
  class: McpToolClass;
  ruleIds: string[];
  obligations: string[];
  reason?: string;
}

/** `mcp:<server>` or `mcp:<server>/<tool>` → its parts, or `null`. */
export function parseApprovalSubject(subject: string): { server: string; tool: string | null } | null {
  if (!subject.startsWith('mcp:')) return null;
  const rest = subject.slice(4);
  if (!rest.includes('/')) return MCP_SERVER_NAME_RE.test(rest) ? { server: rest, tool: null } : null;
  const parts = parseMcpSubject(subject);
  if (parts === null || !/^[A-Za-z0-9_.-]{1,128}$/.test(parts.tool)) return null;
  return parts;
}

/** Engine tool annotations: only the hints (the engine ignores `title`). */
function hints(a: McpToolAnnotations | null): McpToolAnnotations | null {
  if (a === null) return null;
  const out: McpToolAnnotations = {};
  if (a.readOnlyHint !== undefined) out.readOnlyHint = a.readOnlyHint;
  if (a.destructiveHint !== undefined) out.destructiveHint = a.destructiveHint;
  if (a.idempotentHint !== undefined) out.idempotentHint = a.idempotentHint;
  if (a.openWorldHint !== undefined) out.openWorldHint = a.openWorldHint;
  return out;
}

function approvalState(tokens: ReadonlySet<string>, server: string, subject: string): 'server' | 'tool' | null {
  if (tokens.has(`mcp:${server}`)) return 'server';
  if (tokens.has(subject)) return 'tool';
  return null;
}

export class McpPolicies {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly registry: McpRegistry,
    private readonly engine: McpPolicyEngine,
  ) {}

  // ── the preview ────────────────────────────────────────────────────────────────────────────

  async preview(query: McpPolicyQuery): Promise<McpPolicyPreviewResponse> {
    const cells = this.cells(query);
    const { servers } = await this.registry.list();
    let targets: Array<{ server: McpServer; tool: McpTool }>;
    if (query.subject !== undefined) {
      const parts = parseMcpSubject(query.subject);
      const server = parts === null ? undefined : servers.find((s) => s.name === parts.server);
      const tool = server?.tools.find((t) => t.name === parts?.tool);
      if (server === undefined || tool === undefined) throw new McpRegistryError(404, 'unknown_tool', `no tool ${query.subject}`);
      targets = [{ server, tool }];
    } else if (query.server !== undefined) {
      const server = servers.find((s) => s.name === query.server);
      if (server === undefined) throw new McpRegistryError(404, 'unknown_server', `no MCP server named ${query.server}`);
      targets = server.tools.filter((t) => t.status !== 'gone').map((tool) => ({ server, tool }));
    } else {
      targets = servers.flatMap((server) => server.tools.filter((t) => t.status !== 'gone').map((tool) => ({ server, tool })));
    }
    const ledgers = await this.ledgers();
    const calls: EngineCall[] = targets.map(({ server, tool }) => ({
      server: server.name,
      tool: tool.name,
      annotations: hints(tool.annotations),
      classOverride: tool.classOverride,
      // What the broker will send (§6 step 2): unknown, disabled or changed is unregistered.
      registered: server.enabled && tool.enabled && tool.status === 'registered',
      kind: server.kind,
    }));
    const results = await this.judge(calls, cells);
    return {
      ...this.axes(cells, query.phaseId),
      withdrawOnSave: [],
      tools: targets.map(({ server, tool }, i) => ({
        subject: tool.subject,
        server: server.name,
        tool: tool.name,
        class: results[i]?.[0]?.class ?? tool.class,
        status: tool.status,
        enabled: server.enabled && tool.enabled,
        registered: calls[i]?.registered ?? false,
        approval: this.approvalOf(ledgers, server.name, tool.subject),
        cells: results[i] ?? [],
      })),
    };
  }

  /**
   * The matrix for a server that is being added (`POST /mcp/servers/preview`): every tool judged
   * as if the preview were saved now, so the operator sees what would run, ask or be denied.
   */
  async previewUnsaved(server: { name: string; kind: McpUpstreamKind }, tools: McpPreviewTool[]): Promise<McpPolicyPreviewResponse> {
    const cells = this.cells({});
    const ledgers = await this.ledgers();
    const withdrawOnSave = await this.withdrawnBySave({ name: server.name, tools });
    const calls: EngineCall[] = tools.map((t) => ({
      server: server.name,
      tool: t.name,
      annotations: hints(t.annotations),
      classOverride: null,
      registered: true,
      kind: server.kind,
    }));
    const results = await this.judge(calls, cells);
    return {
      ...this.axes(cells, undefined),
      withdrawOnSave,
      tools: tools.map((t, i) => ({
        subject: t.subject,
        server: server.name,
        tool: t.name,
        class: results[i]?.[0]?.class ?? t.class,
        status: 'registered',
        enabled: true,
        registered: true,
        approval: this.approvalOf(ledgers, server.name, t.subject),
        cells: results[i] ?? [],
      })),
    };
  }

  // ── approvals ──────────────────────────────────────────────────────────────────────────────

  async approvals(): Promise<McpApprovalsResponse> {
    const ledgers = await this.ledgers();
    const tokens = new Set([...ledgers.firstUse.tokens, ...ledgers.write.tokens]);
    const approved: McpApproval[] = [...tokens].sort().map((subject) => ({
      subject,
      scope: subject.includes('/') ? 'tool' : 'server',
      firstUse: ledgers.firstUse.tokens.has(subject),
      write: ledgers.write.tokens.has(subject),
    }));
    const { servers } = await this.registry.list();
    const pending: McpPendingApproval[] = [];
    for (const s of servers) {
      if (!s.enabled) continue;
      for (const t of s.tools) {
        if (!t.enabled || t.status !== 'registered') continue;
        const needs: McpPendingApproval['needs'] = [];
        if (approvalState(ledgers.firstUse.tokens, s.name, t.subject) === null) needs.push('first-use');
        if (t.class !== 'read' && approvalState(ledgers.write.tokens, s.name, t.subject) === null) needs.push('write');
        if (needs.length > 0) pending.push({ subject: t.subject, server: s.name, tool: t.name, class: t.class, needs });
      }
    }
    return { approved, pending, ledgers: { firstUse: ledgers.firstUse.state, write: ledgers.write.state } };
  }

  /** Approve a subject (a server: first use; a tool: first use and writes). Answers the rule ids that changed. */
  async approve(subject: string): Promise<string[]> {
    const parts = parseApprovalSubject(subject);
    if (parts === null) throw new McpRegistryError(400, 'bad_subject', 'a subject is mcp:<server> or mcp:<server>/<tool>');
    const server = (await this.registry.list()).servers.find((s) => s.name === parts.server);
    if (server === undefined) throw new McpRegistryError(404, 'unknown_server', `no MCP server named ${parts.server}`);
    if (parts.tool !== null && !server.tools.some((t) => t.name === parts.tool && t.status !== 'gone')) {
      throw new McpRegistryError(404, 'unknown_tool', `no tool ${subject}`);
    }
    const ledgers = parts.tool === null ? [FIRST_USE_LEDGER] : [FIRST_USE_LEDGER, WRITE_LEDGER];
    return this.edit((rule) => {
      if (!ledgers.includes(rule.id)) return null;
      const excludes = rule.excludes ?? [];
      if (excludes.includes(subject)) return null;
      return [...excludes, subject];
    });
  }

  /** Revoke a subject's approval from both ledgers. 404 when neither holds it. */
  async revoke(subject: string): Promise<string[]> {
    if (parseApprovalSubject(subject) === null) throw new McpRegistryError(400, 'bad_subject', 'a subject is mcp:<server> or mcp:<server>/<tool>');
    const changed = await this.withdraw([subject]);
    if (changed.length === 0) throw new McpRegistryError(404, 'not_approved', `${subject} is not approved`);
    return changed;
  }

  /** Remove every listed token from both ledgers (revoke, a changed schema, a removed server). */
  async withdraw(tokens: readonly string[]): Promise<string[]> {
    if (tokens.length === 0) return [];
    const drop = new Set(tokens);
    return this.edit((rule) => {
      const excludes = rule.excludes ?? [];
      const kept = excludes.filter((x) => !drop.has(x));
      return kept.length === excludes.length ? null : kept;
    });
  }

  /**
   * The approval tokens saving `next` over the registered server of the same name withdraws: each
   * tool whose saved schema changed, and the server's own token when any did (a server-wide
   * approval cannot leave one tool out). Empty for a new server or an unchanged one.
   */
  async withdrawnBySave(next: { name: string; tools: ReadonlyArray<{ name: string; schemaHash: string }> }): Promise<string[]> {
    let prior: McpServer;
    try {
      prior = await this.registry.get(next.name);
    } catch (err) {
      if (err instanceof McpRegistryError && err.status === 404) return [];
      throw err;
    }
    // A `gone` tool keeps its last saved schema hash (the registry never deletes one), so a tool
    // that is dropped and later returns with a different schema counts as changed here too; one
    // that returns unchanged keeps its approval, and while gone it is unregistered (D-5) anyway.
    const changed = prior.tools.filter((t) => {
      if (t.schemaHash === null) return false;
      const now = next.tools.find((x) => x.name === t.name);
      return now !== undefined && now.schemaHash !== t.schemaHash;
    });
    if (changed.length === 0) return [];
    const held = new Set(await this.tokensOf(next.name));
    return [`mcp:${next.name}`, ...changed.map((t) => t.subject)].filter((t) => held.has(t));
  }

  /** Every approval token that names `server` (the server's own and each of its tools'). */
  async tokensOf(server: string): Promise<string[]> {
    const l = await this.ledgers();
    return [...new Set([...l.firstUse.tokens, ...l.write.tokens])].filter((t) => t === `mcp:${server}` || t.startsWith(`mcp:${server}/`));
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────

  private cells(query: McpPolicyQuery): EngineCell[] {
    const roles = query.phaseRole !== undefined ? [query.phaseRole] : MCP_PREVIEW_ROLES;
    const seats = query.seat !== undefined ? [query.seat] : MCP_PREVIEW_SEATS;
    const modes = query.mode !== undefined ? [query.mode] : MCP_RUN_MODES;
    const cells: EngineCell[] = [];
    for (const role of roles)
      for (const seat of seats)
        for (const mode of modes) cells.push({ role, seat, mode, ...(query.phaseId !== undefined ? { phaseId: query.phaseId } : {}) });
    return cells;
  }

  private axes(cells: EngineCell[], phaseId: string | undefined): Omit<McpPolicyPreviewResponse, 'tools' | 'withdrawOnSave'> {
    const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
    return {
      roles: uniq(cells.map((c) => c.role)),
      seats: uniq(cells.map((c) => c.seat)),
      modes: uniq(cells.map((c) => c.mode)),
      phaseId: phaseId ?? null,
    };
  }

  private async judge(calls: EngineCall[], cells: EngineCell[]): Promise<McpPolicyCell[][]> {
    if (calls.length === 0) return [];
    let raw: string;
    try {
      raw = await this.engine.previewCalls(JSON.stringify({ calls, cells }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('bad_request:')) throw new McpRegistryError(400, 'bad_request', msg);
      if (msg.startsWith('mcp_preview_unsupported:')) throw new McpRegistryError(501, 'mcp_preview_unsupported', msg);
      throw new McpRegistryError(502, 'preview_failed', `the engine could not judge the preview: ${msg}`);
    }
    let parsed: Array<{ subject: string; cells: EngineVerdict[] }>;
    try {
      parsed = JSON.parse(raw) as Array<{ subject: string; cells: EngineVerdict[] }>;
      if (!Array.isArray(parsed) || parsed.length !== calls.length || !parsed.every((r) => Array.isArray(r?.cells))) throw new Error('not one verdict row per call');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new McpRegistryError(502, 'preview_failed', `the engine answered an unreadable preview: ${msg}`);
    }
    return parsed.map((r) =>
      r.cells.map((c) => ({
        role: c.role,
        seat: c.seat,
        mode: c.mode,
        ...(c.phaseId !== undefined ? { phaseId: c.phaseId } : {}),
        decision: c.decision,
        class: c.class,
        ruleIds: c.ruleIds,
        obligations: c.obligations,
        reason: c.reason ?? null,
      })),
    );
  }

  private async ledgers(): Promise<{
    firstUse: { state: McpLedgerState; tokens: Set<string> };
    write: { state: McpLedgerState; tokens: Set<string> };
  }> {
    const rules = await this.engine.listRules();
    const one = (id: string) => {
      const r = rules.find((x) => x.id === id);
      return {
        state: { id, present: r !== undefined, retired: r?.retired === true },
        tokens: new Set(r?.excludes ?? []),
      };
    };
    return { firstUse: one(FIRST_USE_LEDGER), write: one(WRITE_LEDGER) };
  }

  private approvalOf(ledgers: Awaited<ReturnType<McpPolicies['ledgers']>>, server: string, subject: string): McpApprovalState {
    return {
      firstUse: approvalState(ledgers.firstUse.tokens, server, subject),
      write: approvalState(ledgers.write.tokens, server, subject),
    };
  }

  /**
   * Apply `next` to both ledgers' `excludes`, serialized. `next` answers the new list or `null` for
   * no change. A missing ledger refuses the edit: the pack is seeded at boot, so its absence means
   * the store is not the engine's (fail closed, nothing half-written).
   */
  private edit(next: (rule: ConformanceRule) => string[] | null): Promise<string[]> {
    const run = async (): Promise<string[]> => {
      const rules = await this.engine.listRules();
      const changed: string[] = [];
      const edits: ConformanceRule[] = [];
      for (const id of [FIRST_USE_LEDGER, WRITE_LEDGER]) {
        const rule = rules.find((r) => r.id === id);
        if (rule === undefined) {
          throw new McpRegistryError(503, 'ledger_missing', `the mcp-defaults rule ${id} is not in the policy store; restart the daemon to seed it`);
        }
        const excludes = next(rule);
        if (excludes === null) continue;
        edits.push({ ...rule, excludes });
        changed.push(id);
      }
      // Two rules, no store transaction: on a failed write, put back the ones already written, so
      // an approval lands in both ledgers or in neither. What a failed rollback leaves changed is
      // named on the error, so the route audits it (every ledger change is audited, even a partial one).
      const applied: ConformanceRule[] = [];
      try {
        for (const rule of edits) {
          await this.engine.upsertRule(rule);
          applied.push(rules.find((r) => r.id === rule.id) as ConformanceRule);
        }
      } catch (err) {
        const stuck: string[] = [];
        for (const original of applied.reverse()) {
          try {
            await this.engine.upsertRule(original);
          } catch {
            stuck.push(original.id);
          }
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new McpLedgerEditError(stuck, `the approval ledger edit failed and was rolled back${stuck.length > 0 ? ` except ${stuck.join(', ')}` : ''}: ${msg}`);
      }
      return changed;
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }
}
