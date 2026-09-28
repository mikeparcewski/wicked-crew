/**
 * The MCP broker's call path (DES-MCP-TOOLS-001 §6; slice S3). A worker on any seat reaches an
 * upstream MCP tool only through here (the garden shim, `wicked-garden run mcp call`, sends
 * `POST /api/v1/mcp/call {token, subject, args}`), and every step below runs in order:
 *
 *  1-3. **Judge.** The subject is resolved in the registry (unknown, disabled, `gone` or changed
 *       tools go to the engine as `registered: false`, D-5), then core's `evaluateMcpCall` verifies
 *       the token, judges the call for the unit the token is bound to (D-1 phase role, policy,
 *       first use, the run's mode) and records the claim. `deny` and `ask` never reach an upstream.
 *  4.   **Budget.** At most {@link DEFAULT_MCP_CALL_BUDGET} invoked calls per unit attempt
 *       (`WICKED_MCP_CALL_BUDGET` overrides it).
 *  5.   **Breaker.** After {@link BREAKER_THRESHOLD} consecutive upstream failures a tool is refused
 *       for {@link BREAKER_OPEN_MS}; then one call is let through, and one more failure reopens it.
 *  6.   **Invoke** with a deadline. The upstream's secret is resolved here, and only here.
 *  7.   **Retry** READ tools only, at most {@link MAX_READ_RETRIES} times, and only on transport
 *       errors, 429 and 5xx. A write or destructive tool is never retried: a second attempt could
 *       apply the write twice.
 *  8.   **Post.** The result is scrubbed (the exact secrets injected on this call, then credential
 *       field names and value shapes, D-2), then core's `evaluateMcpOutput` judges it; a deny
 *       withholds it. A crash anywhere here is `guard_error`: refused, fail closed.
 *  9.   **Record** (D-3). Every judged call is written to `calls.ndjson`; a call whose record cannot
 *       be written is refused and its result withheld. The record then rides `/ws`
 *       (`mcpCallCompleted`) and the bus (`wicked.crew.mcp_call.completed`).
 *
 * A call that ran and then could not be recorded HAS happened upstream; refusing it withholds the
 * result from the worker, it does not undo the side effect. The record is written after the call
 * because the span it records (timing, status, bytes) only exists then.
 */

import { randomBytes } from 'node:crypto';

import type {
  McpCallBody,
  McpCallDecision,
  McpCallOutcome,
  McpCallRecord,
  McpCallResponse,
  McpToolClass,
  McpUpstreamKind,
} from '../core/types.js';
import type { McpEngineGate } from '../core/adapter.js';
import { parseMcpSubject } from './classify.js';
import type { McpCallRecordSink } from './call-records.js';
import { classifyUpstreamError, invokeMcpTool, MCP_CALL_TIMEOUT_MS, type Invoker, type UpstreamToolResult } from './invoke.js';
import { scrubResult } from './redact.js';
import type { McpRegistry } from './registry.js';
import { scrubSecrets } from './secrets.js';

/** The bus event each call record rides. */
export const MCP_CALL_COMPLETED = 'wicked.crew.mcp_call.completed';
export const DEFAULT_MCP_CALL_BUDGET = 200;
export const BREAKER_THRESHOLD = 5;
export const BREAKER_OPEN_MS = 60_000;
export const MAX_READ_RETRIES = 2;
/** Units whose budget counters are kept; the oldest is dropped first. */
const BUDGET_UNITS_MAX = 4096;

/** The engine's verdict for a call (`Core.evaluateMcpCall`). */
interface EngineVerdict {
  decision: 'allow' | 'ask' | 'deny';
  subject: string;
  class: McpToolClass;
  ruleIds: string[];
  obligations: string[];
  reason?: string;
  remedy?: string;
  claimId: string;
  unit: { runId: string; ord: number; attempt: number; phase: string; seat: string };
}

/** The engine's output verdict (`Core.evaluateMcpOutput`). */
interface EngineOutputVerdict {
  decision: 'allow' | 'deny';
  subject: string;
  ruleIds: string[];
  reason?: string;
  remedy?: string;
  claimId?: string;
}

/** The HTTP status each outcome is answered with. */
export const OUTCOME_STATUS: Record<McpCallOutcome, number> = {
  ok: 200,
  denied: 403,
  withheld: 403,
  pending_approval: 409,
  budget_exhausted: 429,
  breaker_open: 503,
  upstream_error: 502,
  guard_error: 500,
};

/** A call the broker answered: the HTTP status and the body. */
export interface McpBrokerAnswer {
  status: number;
  body: McpCallResponse | { error: string; code: 'invalid_token' | 'bad_request' };
}

export interface McpBrokerDeps {
  registry: Pick<McpRegistry, 'resolveCall' | 'callSecret'>;
  /** The engine's gate, read per call; `null` = the linked engine has none (every call refused). */
  engine: () => McpEngineGate | null;
  records: McpCallRecordSink;
  invoke?: Invoker;
  /** Called with every record once it is written (`/ws` + bus). Never throws into the call. */
  publish?: (record: McpCallRecord) => void | Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  budgetPerUnit?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

interface BreakerState {
  failures: number;
  openUntil: number;
}

/** The context a call carries into its record, filled as the steps run. */
interface Span {
  start: number;
  spanId: string;
  subject: string;
  verdict: EngineVerdict | null;
  kind: McpUpstreamKind | null;
  retries: number;
  bytesOut: number;
}

export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['WICKED_MCP_CALL_BUDGET'];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MCP_CALL_BUDGET;
}

export class McpBroker {
  private readonly invoke: Invoker;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly budget: number;
  private readonly timeoutMs: number;
  private readonly used = new Map<string, number>();
  private readonly breakers = new Map<string, BreakerState>();

  constructor(private readonly deps: McpBrokerDeps) {
    this.invoke = deps.invoke ?? invokeMcpTool;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.budget = deps.budgetPerUnit ?? budgetFromEnv();
    this.timeoutMs = deps.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
  }

  async call(body: McpCallBody): Promise<McpBrokerAnswer> {
    const parts = parseMcpSubject(body.subject);
    if (parts === null) return { status: 400, body: { error: `subject must be mcp:<server>/<tool> (got ${JSON.stringify(body.subject)})`, code: 'bad_request' } };
    const span: Span = { start: this.now(), spanId: randomBytes(8).toString('hex'), subject: body.subject, verdict: null, kind: null, retries: 0, bytesOut: 0 };

    // ── 1-3. Resolve and judge ──────────────────────────────────────────────────────────────
    const gate = this.deps.engine();
    if (gate === null) {
      return this.refuse(span, 'guard_error', 'guard_error', 'broker', [], 'the linked engine has no MCP gate (wicked-core-ts predates evaluateMcpCall/evaluateMcpOutput)', 'upgrade the engine; no MCP call runs unjudged');
    }
    let target: Awaited<ReturnType<McpBrokerDeps['registry']['resolveCall']>>;
    try {
      target = await this.deps.registry.resolveCall(parts.server, parts.tool);
    } catch (err) {
      return this.refuse(span, 'guard_error', 'guard_error', 'broker', [], `the MCP registry could not be read: ${message(err)}`, 'the operator fixes the registry in studio → MCP tools');
    }
    span.kind = target?.config.kind ?? null;
    const call = {
      server: parts.server,
      tool: parts.tool,
      args: body.args ?? {},
      annotations: target?.annotations ?? null,
      classOverride: target?.classOverride ?? null,
      registered: target?.registered ?? false,
      ...(target !== null ? { kind: target.config.kind } : {}),
      carrier: 'shim',
    };
    let verdict: EngineVerdict;
    try {
      verdict = JSON.parse(await gate.evaluateCall(JSON.stringify({ token: body.token, call }))) as EngineVerdict;
    } catch (err) {
      const msg = message(err);
      if (msg.startsWith('invalid_token')) return { status: 401, body: { error: msg, code: 'invalid_token' } };
      if (msg.startsWith('bad_request')) return { status: 400, body: { error: msg, code: 'bad_request' } };
      return this.refuse(span, 'guard_error', 'guard_error', 'engine', [], `the call could not be judged or recorded: ${msg}`, 'nothing ran; try again, and report it if it persists');
    }
    span.verdict = verdict;
    if (verdict.decision === 'deny') {
      return this.refuse(span, 'denied', 'deny', verdict.ruleIds[0] ?? 'policy', verdict.ruleIds, verdict.reason, verdict.remedy);
    }
    if (verdict.decision === 'ask') {
      return this.refuse(span, 'pending_approval', 'ask', verdict.ruleIds[0] ?? 'policy', verdict.ruleIds, verdict.reason, verdict.remedy);
    }
    if (target === null || !target.registered) {
      // The engine allowed a subject the registry does not hold as registered (unknown, disabled,
      // `gone` or changed since its preview): never invoke it (D-5 holds even if the engine errs).
      return this.refuse(span, 'guard_error', 'guard_error', 'broker', verdict.ruleIds, `${body.subject} is not a registered, enabled tool`, 'register it in studio → MCP tools');
    }

    // ── 4. Budget ───────────────────────────────────────────────────────────────────────────
    const unitKey = `${verdict.unit.runId}:${verdict.unit.ord}:${verdict.unit.attempt}`;
    const used = this.used.get(unitKey) ?? 0;
    if (used >= this.budget) {
      return this.refuse(span, 'budget_exhausted', 'deny', 'budget', [], `this unit has made its ${this.budget} MCP calls`, 'finish with what you have; the budget is per unit');
    }

    // ── 5. Breaker ──────────────────────────────────────────────────────────────────────────
    const breaker = this.breakers.get(body.subject) ?? { failures: 0, openUntil: 0 };
    if (breaker.openUntil > this.now()) {
      const secs = Math.ceil((breaker.openUntil - this.now()) / 1000);
      return this.refuse(span, 'breaker_open', 'deny', 'breaker', [], `${body.subject} failed ${BREAKER_THRESHOLD} times in a row; refused for ${secs} s more`, 'continue without it, or try again later');
    }

    // ── 6. The secret, resolved here and only here. A call refused at this step never reaches the
    //       upstream, so it spends no budget and does not move the breaker. ─────────────────────
    let secret: string | null;
    try {
      const resolved = await this.deps.registry.callSecret(target.config);
      if (resolved.missing) {
        return this.refuse(span, 'upstream_error', 'allow', verdict.ruleIds[0] ?? 'policy', verdict.ruleIds, `${target.config.auth?.ref ?? 'the secret'} resolves to no secret; the call was not made unauthenticated`, 'the operator sets the secret in studio → MCP tools', 'secret_missing');
      }
      secret = resolved.secret;
    } catch (err) {
      return this.refuse(span, 'guard_error', 'guard_error', 'broker', verdict.ruleIds, `the upstream's secret could not be read (${message(err)}); nothing ran`, 'try again, and report it if it persists');
    }
    if (breaker.openUntil !== 0) {
      // Half-open: this call is let through, and one more failure reopens the breaker.
      breaker.openUntil = 0;
      breaker.failures = BREAKER_THRESHOLD - 1;
    }
    this.used.delete(unitKey);
    this.used.set(unitKey, used + 1);
    while (this.used.size > BUDGET_UNITS_MAX) this.used.delete(this.used.keys().next().value as string);

    // ── 6-7. Invoke, retrying read tools on transient failures only ─────────────────────────
    const secrets = secret === null ? [] : [secret];
    let result: UpstreamToolResult | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await this.invoke(target.config, secret, parts.tool, call.args, this.timeoutMs);
        break;
      } catch (err) {
        const failure = classifyUpstreamError(err);
        if (verdict.class === 'read' && failure.retryable && attempt < MAX_READ_RETRIES) {
          span.retries += 1;
          await this.sleep(200 * (attempt + 1));
          continue;
        }
        breaker.failures += 1;
        if (breaker.failures >= BREAKER_THRESHOLD) breaker.openUntil = this.now() + BREAKER_OPEN_MS;
        this.breakers.set(body.subject, breaker);
        const reason = scrubResult(`${body.subject} failed upstream (${failure.errorClass}): ${failure.message}`, secrets);
        return this.refuse(span, 'upstream_error', 'allow', verdict.ruleIds[0] ?? 'policy', verdict.ruleIds, reason, 'the call may be retried later; a write may or may not have applied', failure.errorClass);
      }
    }
    breaker.failures = 0;
    this.breakers.set(body.subject, breaker);

    // ── 8. Post: scrub, then the output decision; a crash is guard_error ─────────────────────
    let scrubbed: UpstreamToolResult;
    let output: EngineOutputVerdict;
    try {
      scrubbed = scrubResult(result, secrets);
      const raw = JSON.stringify(scrubbed);
      span.bytesOut = Buffer.byteLength(raw, 'utf8');
      output = JSON.parse(await gate.evaluateOutput(JSON.stringify({ token: body.token, call, raw }))) as EngineOutputVerdict;
      if (output.decision !== 'allow' && output.decision !== 'deny') throw new Error(`unknown output decision ${JSON.stringify(output.decision)}`);
    } catch (err) {
      return this.refuse(span, 'guard_error', 'guard_error', 'engine:mcp-output', [], `the result could not be checked (${scrubSecrets(message(err), secrets)}); it is withheld`, 'the call ran; its result is not shown');
    }
    if (output.decision === 'deny') {
      return this.refuse(span, 'withheld', 'deny', output.ruleIds[0] ?? 'policy', output.ruleIds, output.reason, output.remedy, null, output.claimId ?? null);
    }

    // ── 9. Record, then answer ──────────────────────────────────────────────────────────────
    const isError = scrubbed['isError'] === true;
    const record = this.record(span, 'ok', 'allow', verdict.ruleIds[0] ?? 'policy', verdict.ruleIds, isError ? 'tool_error' : null, verdict.claimId);
    try {
      await this.deps.records.append(record);
    } catch (err) {
      this.deps.log?.(`[mcp] the call record for ${body.subject} could not be written (${message(err)}); its result is withheld`);
      return {
        status: OUTCOME_STATUS.guard_error,
        body: {
          outcome: 'guard_error',
          subject: body.subject,
          callId: null,
          ruleIds: [],
          reason: 'the call could not be recorded (D-3); its result is withheld',
          remedy: 'the call ran; its result is not shown',
        },
      };
    }
    this.publish(record);
    return { status: 200, body: { outcome: 'ok', subject: body.subject, callId: span.spanId, result: scrubbed, ruleIds: verdict.ruleIds } };
  }

  private record(
    span: Span,
    outcome: McpCallOutcome,
    decision: McpCallDecision,
    by: string,
    ruleIds: string[],
    errorClass: string | null,
    claimId: string | null,
  ): McpCallRecord {
    const end = this.now();
    const v = span.verdict;
    return {
      traceId: v?.unit.runId ?? null,
      spanId: span.spanId,
      parentSpanId: v === null ? null : `${v.unit.ord}:${v.unit.attempt}`,
      name: 'mcp.tool.call',
      start: new Date(span.start).toISOString(),
      end: new Date(end).toISOString(),
      ms: end - span.start,
      status: { code: errorClass === null && outcome === 'ok' ? 'ok' : 'error', errorClass: errorClass ?? (outcome === 'ok' ? null : outcome) },
      decision: { decision, by, ruleIds, claimId },
      outcome,
      attrs: {
        'mcp.subject': span.subject,
        'mcp.class': v?.class ?? null,
        'mcp.kind': span.kind,
        'wicked.seat': v?.unit.seat ?? null,
        'wicked.phase': v?.unit.phase ?? null,
        'wicked.carrier': 'shim',
        'bytes.out': span.bytesOut,
        retries: span.retries,
      },
    };
  }

  /**
   * Answer a call that does not hand a result back, after recording it. A refusal is a refusal
   * whether or not its record lands; a failed write is logged, and the answer keeps its outcome
   * (a deny is never re-labelled `guard_error`, I5).
   */
  private async refuse(
    span: Span,
    outcome: Exclude<McpCallOutcome, 'ok'>,
    decision: McpCallDecision,
    by: string,
    ruleIds: string[],
    reason: string | undefined,
    remedy: string | undefined,
    errorClass: string | null = null,
    claimId: string | null = span.verdict?.claimId ?? null,
  ): Promise<McpBrokerAnswer> {
    const record = this.record(span, outcome, decision, by, ruleIds, errorClass ?? outcome, claimId);
    let recorded = true;
    try {
      await this.deps.records.append(record);
    } catch (err) {
      recorded = false;
      this.deps.log?.(`[mcp] the call record for ${span.subject} (${outcome}) could not be written: ${message(err)}`);
    }
    if (recorded) this.publish(record);
    const body: McpCallResponse = {
      outcome,
      subject: span.subject,
      callId: recorded ? span.spanId : null,
      ruleIds,
      ...(reason !== undefined ? { reason } : {}),
      ...(remedy !== undefined ? { remedy } : {}),
      ...(outcome === 'pending_approval' ? { pending_approval: span.subject } : {}),
      ...(outcome === 'denied' || outcome === 'withheld' ? { denied: true as const } : {}),
    };
    const status = outcome === 'upstream_error' && errorClass === 'timeout' ? 504 : OUTCOME_STATUS[outcome];
    return { status, body };
  }

  private publish(record: McpCallRecord): void {
    const publish = this.deps.publish;
    if (publish === undefined) return;
    try {
      void Promise.resolve(publish(record)).catch((err: unknown) => this.deps.log?.(`[mcp] publishing call ${record.spanId} failed: ${message(err)}`));
    } catch (err) {
      this.deps.log?.(`[mcp] publishing call ${record.spanId} failed: ${message(err)}`);
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
