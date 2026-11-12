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
 *  6.   **Invoke** with a deadline. The upstream's secret is resolved here, and only here. A `rest`
 *       tool (slice S5a, `rest.ts`) sends only its allowlisted arguments, and only to its pinned
 *       base URL: a request that would leave it is refused unsent, recorded as `guard_error`
 *       (`rest_host_escape`, I6).
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
 * The reserved server `estate` is not a registered upstream: `mcp:estate/<tool>` is the estate
 * relay (wicked-core#1018, `estate-relay.ts`), a container seat's only way to its run's estate.
 * Its judge is the relay's own (the token resolved to its unit by the engine, a fixed tool list,
 * the run's scope); budget, record and publish are the steps above.
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
import { ESTATE_SERVER, parseMcpSubject } from './classify.js';
import type { McpCallRecordSink } from './call-records.js';
import {
  classifyUpstreamError,
  hostLoad,
  invokeMcpTool,
  MCP_CALL_TIMEOUT_MS,
  mcpCallBound,
  type HostLoad,
  type Invoker,
  type UpstreamToolResult,
} from './invoke.js';
import { scrubResult } from './redact.js';
import { UpstreamCallError } from './upstream-error.js';
import { McpRegistryError, type McpRegistry } from './registry.js';
import { FENCE_REASON, FENCE_REMEDY, FENCE_RULE, pickAllows, PICK_RULE, type RunFence, type SourcePicks } from './run-fence.js';
import { scrubSecrets } from './secrets.js';
import {
  ESTATE_PROPOSAL_TOOL,
  ESTATE_VISIBLE_TOOLS,
  RULES_RECALL_TOOL,
  proposalIdOf,
  releaseVisible,
  rpcErrorEnvelope,
  scopeEstateArgs,
  type EstateRelay,
  type VisibleRelease,
} from './estate-relay.js';
import { type DataGate, GateTokenError } from '../knowledge/gate/gate.js';

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
  /** The per-call deadline on a host with headroom; scaled with host load at each call (crew#1212). */
  timeoutMs?: number;
  /** The host load the deadline scales with, read at each call. */
  load?: () => HostLoad;
  log?: (message: string) => void;
  /** The estate relay behind `mcp:estate/<tool>` (wicked-core#1018); absent = those calls are refused. */
  estate?: EstateRelay;
  /**
   * (DES-KNOWLEDGE-DATA-001 §7) The data gate: a subject whose server is a live source (`mcp:<source>/<tool>`)
   * goes through it, never to the registry's upstream path. Absent = those subjects take the registry path,
   * where a source has no registered tool, so they are refused (D-5).
   */
  gate?: DataGate;
  /** (DES-CATALOG-002 §2.3) A run fenced off every capability (the `detect-shape` turn): each of its calls is refused
   *  once its unit is known, before anything runs. Absent = no run is fenced. */
  fence?: RunFence;
  /** A job's pick narrows source calls across every unit of its run. */
  picks?: SourcePicks;
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

/**
 * A timeout from an MCP server names the call's load-scaled bound and how load set it (crew#1212).
 * A REST tool's deadline is `min(bound, its mapping's own timeout)`, and its message already says
 * which seconds ran out, so it carries no load note it did not run into (xreview on #1217).
 */
export function boundedTimeout(kind: string, failure: UpstreamCallError, note: string): UpstreamCallError {
  if (failure.errorClass !== 'timeout' || kind === 'rest') return failure;
  return new UpstreamCallError('timeout', failure.retryable, `${failure.message} (bound ${note})`);
}

export class McpBroker {
  private readonly invoke: Invoker;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly budget: number;
  private readonly timeoutMs: number;
  private readonly load: () => HostLoad;
  private readonly used = new Map<string, number>();
  private readonly breakers = new Map<string, BreakerState>();

  constructor(private readonly deps: McpBrokerDeps) {
    this.invoke = deps.invoke ?? invokeMcpTool;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.budget = deps.budgetPerUnit ?? budgetFromEnv();
    this.timeoutMs = deps.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
    this.load = deps.load ?? hostLoad;
  }

  /** Whether the unit's run is fenced; a fence that throws fences (it was asked because a fence exists). */
  private async fenced(runId: string): Promise<boolean> {
    if (this.deps.fence === undefined) return false;
    try {
      return await this.deps.fence(runId);
    } catch {
      return true;
    }
  }

  async call(body: McpCallBody): Promise<McpBrokerAnswer> {
    const parts = parseMcpSubject(body.subject);
    if (parts === null) return { status: 400, body: { error: `subject must be mcp:<server>/<tool> (got ${JSON.stringify(body.subject)})`, code: 'bad_request' } };
    const span: Span = { start: this.now(), spanId: randomBytes(8).toString('hex'), subject: body.subject, verdict: null, kind: null, retries: 0, bytesOut: 0 };
    if (parts.server === ESTATE_SERVER) return this.callEstate(span, body, parts.tool);
    // ── The gate step (DES-KNOWLEDGE-DATA-001 §7): a live source is never reached as a plain upstream. ──
    if (this.deps.gate !== undefined) {
      let gated: boolean;
      try {
        gated = await this.deps.gate.owns(parts.server);
      } catch (err) {
        return this.refuse(span, 'guard_error', 'guard_error', 'broker', [], `the MCP registry could not be read: ${message(err)}`, 'the operator fixes the registry in studio → MCP tools');
      }
      if (gated) return this.callGated(this.deps.gate, span, body, parts.server, parts.tool);
    }

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
    // (DES-PM-001 §3.1) A PM entry is never reached as a plain upstream, even on a broker with no gate.
    if (target?.pm === true) {
      return this.refuse(span, 'guard_error', 'guard_error', 'broker:gate', [], `${body.subject} is a project-management source's tool: only crew's data gate may call it, and this daemon has none`, 'nothing ran; report it', null, null);
    }
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
    if (await this.fenced(verdict.unit.runId)) return this.refuse(span, 'denied', 'deny', FENCE_RULE, [FENCE_RULE], FENCE_REASON, FENCE_REMEDY);
    if (verdict.decision === 'deny' && target?.resaveRequired === true) {
      // (G2) The engine denied an unregistered tool (D-5); say the one thing that fixes it.
      return this.refuse(span, 'denied', 'deny', verdict.ruleIds[0] ?? 'policy', verdict.ruleIds, resaveReason(body.subject), RESAVE_REMEDY);
    }
    if (verdict.decision === 'deny') {
      return this.refuse(span, 'denied', 'deny', verdict.ruleIds[0] ?? 'policy', verdict.ruleIds, verdict.reason, verdict.remedy);
    }
    if (verdict.decision === 'ask') {
      return this.refuse(span, 'pending_approval', 'ask', verdict.ruleIds[0] ?? 'policy', verdict.ruleIds, verdict.reason, verdict.remedy);
    }
    if (target === null || !target.registered) {
      // The engine allowed a subject the registry does not hold as registered (unknown, disabled,
      // `gone` or changed since its preview): never invoke it (D-5 holds even if the engine errs).
      if (target?.resaveRequired === true) return this.refuse(span, 'guard_error', 'guard_error', 'broker', verdict.ruleIds, resaveReason(body.subject), RESAVE_REMEDY);
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
      // A gh credential refused by name (signed out, another active account): the refusal carries that code.
      if (err instanceof McpRegistryError && err.code.startsWith('gh_')) {
        return this.refuse(span, 'upstream_error', 'allow', verdict.ruleIds[0] ?? 'policy', verdict.ruleIds, err.message, 'the operator signs gh in as the pinned account', err.code);
      }
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
    // ONE load-scaled deadline for the whole call, retries and their backoff included: each attempt
    // gets what is left, so three slow attempts cannot outlast the shim's wait (xreview on #1217).
    const bound = mcpCallBound(this.timeoutMs, this.load());
    const deadlineAt = this.now() + bound.ms;
    for (let attempt = 0; ; attempt++) {
      try {
        const left = Math.max(1, deadlineAt - this.now());
        result = await this.invoke(target.config, secret, parts.tool, call.args, left, target.rest);
        break;
      } catch (err) {
        const failure = boundedTimeout(target.config.kind, classifyUpstreamError(err), bound.note);
        if (failure.errorClass === 'boundary') {
          // I6: a REST request that would leave its pinned host was refused before it was sent (or a
          // redirect off the host was not followed). Not the tool's failure, so the breaker is not
          // moved; recorded as a guard_error, which fails closed.
          const reason = scrubResult(`${body.subject} was refused: ${failure.message}`, secrets);
          return this.refuse(span, 'guard_error', 'guard_error', 'broker:rest-host-pin', verdict.ruleIds, reason, 'call it with arguments that keep the request on the API\'s own host and path', 'rest_host_escape');
        }
        const backoff = 200 * (attempt + 1);
        if (verdict.class === 'read' && failure.retryable && attempt < MAX_READ_RETRIES && deadlineAt - this.now() > backoff) {
          span.retries += 1;
          await this.sleep(backoff);
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

  /**
   * `mcp:estate/<tool>`: the estate relay (module doc of `estate-relay.ts`). Resolve the token to
   * its unit and scope, refuse what the relay never makes, spend the unit's budget, run the call on
   * the host's estate, bound and scrub its result, then record it like any brokered call. A landed
   * proposal is also handed to the relay's audit hook.
   */
  private async callEstate(span: Span, body: McpCallBody, tool: string): Promise<McpBrokerAnswer> {
    const relay = this.deps.estate;
    if (relay === undefined) {
      return this.refuse(span, 'guard_error', 'guard_error', 'broker:estate', [], 'this daemon has no estate relay', 'continue without estate; report it if it persists');
    }
    let scope: Awaited<ReturnType<EstateRelay['resolve']>>;
    try {
      scope = await relay.resolve(body.token);
    } catch (err) {
      const msg = message(err);
      if (msg.startsWith('invalid_token')) return { status: 401, body: { error: msg, code: 'invalid_token' } };
      if (msg.startsWith('bad_request')) return { status: 400, body: { error: msg, code: 'bad_request' } };
      return this.refuse(span, 'guard_error', 'guard_error', 'broker:estate', [], `the token's estate scope could not be read: ${msg}`, 'nothing ran; try again, and report it if it persists');
    }
    if (scope === null) {
      return this.refuse(span, 'guard_error', 'guard_error', 'broker:estate', [], 'the linked engine predates the estate relay (wicked-core-ts has no resolveEstateScope)', 'upgrade the engine; no estate call runs unscoped');
    }
    const write = tool === ESTATE_PROPOSAL_TOOL;
    span.kind = 'mcp-stdio';
    span.verdict = { decision: 'allow', subject: body.subject, class: write ? 'write' : 'read', ruleIds: [], obligations: [], claimId: '', unit: scope.unit };
    if (await this.fenced(scope.unit.runId)) return this.refuse(span, 'denied', 'deny', FENCE_RULE, [FENCE_RULE], FENCE_REASON, FENCE_REMEDY, null, null);
    const refused = relay.refusal(tool, scope);
    if (refused !== null) return this.refuse(span, 'denied', 'deny', refused.ruleId, [refused.ruleId], refused.reason, refused.remedy, null, null);

    const unitKey = `${scope.unit.runId}:${scope.unit.ord}:${scope.unit.attempt}`;
    const used = this.used.get(unitKey) ?? 0;
    if (used >= this.budget) {
      return this.refuse(span, 'budget_exhausted', 'deny', 'budget', [], `this unit has made its ${this.budget} MCP calls`, 'finish with what you have; the budget is per unit', null, null);
    }
    this.used.delete(unitKey);
    this.used.set(unitKey, used + 1);
    while (this.used.size > BUDGET_UNITS_MAX) this.used.delete(this.used.keys().next().value as string);

    // (DES-KNOWLEDGE-DATA-001 §4.3) A knowledge read carries the unit's visible set, read from the registry now.
    const gated = ESTATE_VISIBLE_TOOLS.has(tool);
    let visible: string[] = [];
    if (gated) {
      try {
        visible = await relay.visibleFor(scope);
      } catch (err) {
        this.deps.log?.(`[mcp] ${body.subject}: the unit's visible set could not be read: ${message(err)}`);
        return this.refuse(span, 'guard_error', 'guard_error', 'broker:estate', [], 'the registry could not be read to decide what this step may see, so nothing ran', 'try again, and report it if it persists', null, null);
      }
    }
    const args = scopeEstateArgs(tool, body.args ?? {}, scope, visible);
    let result: Record<string, unknown>;
    try {
      const answer = await relay.run({ tool, args, scope, timeoutMs: relay.timeoutMs });
      result = 'rpcError' in answer ? rpcErrorEnvelope(answer.rpcError) : answer.result;
    } catch (err) {
      const failure = classifyUpstreamError(err);
      const timedOut = /did not answer .* within/.test(failure.message);
      return this.refuse(span, 'upstream_error', 'allow', 'broker:estate', [], `mcp:estate/${tool} failed: ${failure.message}`, write ? 'keep the proposal in your output; it may or may not have landed' : 'continue without it, or try again later', timedOut ? 'timeout' : failure.errorClass, null);
    }
    if (gated) {
      // The release re-check, against a FRESH read: a switch turned off while estate answered holds now.
      let released: VisibleRelease;
      try {
        released = releaseVisible(tool, result, new Set(await relay.visibleFor(scope)));
      } catch (err) {
        this.deps.log?.(`[mcp] ${body.subject}: the release check could not run: ${message(err)}`);
        released = { ok: false, reason: 'the registry could not be read to re-check what this step may see, so the answer is withheld' };
      }
      if (!released.ok) return this.refuse(span, 'withheld', 'deny', 'broker:estate-visible', ['estate:visible'], released.reason, 'work from what this step may see; a person decides which sources a project sees on the source sheet', null, null);
      result = released.result;
    }
    // `rules.recall` is crew's own answer (the operator's rule text the judge reads), not an upstream's output: it is
    // released verbatim, so a seat reads the words it is judged on. The redactor works on the serialized text and
    // would change a statement (`Bearer …`) or break its JSON (`"password=…"`), leaving the rule unreadable.
    const scrubbed = tool === RULES_RECALL_TOOL ? result : scrubResult(result, []);
    const raw = JSON.stringify(scrubbed);
    span.bytesOut = Buffer.byteLength(raw, 'utf8');
    if (span.bytesOut > relay.maxResultBytes) {
      return this.refuse(span, 'withheld', 'deny', 'broker:estate-bound', ['estate:result-bound'], `mcp:estate/${tool} answered ${span.bytesOut} bytes, over the relay's ${relay.maxResultBytes}-byte bound`, tool === RULES_RECALL_TOOL ? 'pull fewer rules at once: name them in "ids", or page with "limit" and "offset"' : 'narrow the call (a lower limit or depth, a narrower query), or page it with cursor', null, null);
    }
    const record = this.record(span, 'ok', 'allow', 'broker:estate', [], scrubbed['isError'] === true ? 'tool_error' : null, null);
    try {
      await this.deps.records.append(record);
    } catch (err) {
      this.deps.log?.(`[mcp] the call record for ${body.subject} could not be written (${message(err)}); its result is withheld`);
      return {
        status: OUTCOME_STATUS.guard_error,
        body: { outcome: 'guard_error', subject: body.subject, callId: null, ruleIds: [], reason: 'the call could not be recorded (D-3); its result is withheld', remedy: write ? 'the proposal may have landed; keep it in your output' : 'the call ran; its result is not shown' },
      };
    }
    this.publish(record);
    if (write) {
      const proposalId = proposalIdOf(scrubbed);
      const kindType = typeof args['kind_type'] === 'string' ? args['kind_type'] : '';
      if (proposalId !== null) relay.landed({ ...scope.unit, proposalId, kindType, callId: span.spanId });
    }
    return { status: 200, body: { outcome: 'ok', subject: body.subject, callId: span.spanId, result: scrubbed, ruleIds: [] } };
  }

  /**
   * `mcp:<source>/<tool>` through the data gate (DES-KNOWLEDGE-DATA-001 §7, §8.1). The token is resolved to its
   * unit and run project by the ENGINE; the engine then judges the exact call, its arguments included (crew#1337), for that unit (absent = denied:
   * an operator's policy, or an Apps unit's write tool, D-7 as §9.3 narrows it; a first-use ask is admitted, the per-source switch being
   * the consent); the unit's budget is spent; the gate answers (structure from crew's stored catalog, or one
   * read through the policy, the scheduler and the adapter); the call is recorded like any brokered call (never
   * its arguments), and a read's rows are released only after the gate's two-step record.
   */
  private async callGated(gate: DataGate, span: Span, body: McpCallBody, server: string, tool: string): Promise<McpBrokerAnswer> {
    span.kind = 'sql';
    let scope: Awaited<ReturnType<DataGate['resolve']>>;
    try {
      scope = await gate.resolve(body.token);
    } catch (err) {
      const msg = message(err);
      if (err instanceof GateTokenError) {
        if (msg.startsWith('bad_request')) return { status: 400, body: { error: msg, code: 'bad_request' } };
        return { status: 401, body: { error: msg, code: 'invalid_token' } };
      }
      this.deps.log?.(`[mcp] ${body.subject}: the token's unit could not be read: ${msg}`);
      return this.refuse(span, 'guard_error', 'guard_error', 'broker:gate', [], "the token's unit could not be read", 'nothing ran; try again, and report it if it persists', null, null);
    }
    if (scope === null) {
      return this.refuse(span, 'guard_error', 'guard_error', 'broker:gate', [], 'the linked engine cannot bind or judge a data-source call (wicked-core-ts predates resolveEstateScope or listMcpTools)', 'upgrade the engine; no data-source call runs unjudged', null, null);
    }
    span.verdict = { decision: 'allow', subject: body.subject, class: 'read', ruleIds: [], obligations: [], claimId: '', unit: scope.unit };
    if (await this.fenced(scope.unit.runId)) return this.refuse(span, 'denied', 'deny', FENCE_RULE, [FENCE_RULE], FENCE_REASON, FENCE_REMEDY, null, null);
    // The job's pick is a run boundary, before admission or budget: a later unit cannot widen it.
    if (!pickAllows(this.deps.picks, scope.unit.runId, server)) {
      let reason = "this job's source pick could not be read";
      try {
        const ids = this.deps.picks?.get(scope.unit.runId);
        reason = `this job did not pick ${server}; it reads only ${ids !== null && ids !== undefined && ids.length > 0 ? ids.join(', ') : 'no sources'}`;
      } catch {
        // Forgetting an unreadable pick would widen access; the refusal still carries the pick rule.
      }
      return this.refuse(span, 'denied', 'deny', PICK_RULE, [PICK_RULE], reason, 'work from the sources and documents this job picked', null, null);
    }
    let admitted: Awaited<ReturnType<DataGate['admitted']>>;
    try {
      admitted = await gate.admitted(body.token, [{ server, tool, disclosure: null, args: body.args ?? {} }]);
    } catch (err) {
      const msg = message(err);
      if (err instanceof GateTokenError) {
        if (msg.startsWith('bad_request')) return { status: 400, body: { error: msg, code: 'bad_request' } };
        return { status: 401, body: { error: msg, code: 'invalid_token' } };
      }
      this.deps.log?.(`[mcp] ${body.subject}: the call could not be judged: ${msg}`);
      return this.refuse(span, 'guard_error', 'guard_error', 'broker:gate', [], 'the data-source call could not be judged', 'nothing ran; try again, and report it if it persists', null, null);
    }
    if (admitted === null) {
      return this.refuse(span, 'guard_error', 'guard_error', 'broker:gate', [], 'the linked engine cannot bind or judge a data-source call (wicked-core-ts predates resolveEstateScope or listMcpTools)', 'upgrade the engine; no data-source call runs unjudged', null, null);
    }
    const judged = admitted.get(body.subject);
    if (judged === undefined) {
      return this.refuse(span, 'denied', 'deny', 'engine:gated-tool', ['engine:gated-tool'], `${body.subject} is refused for this unit by the engine (an operator policy, or an engine that predates DES-KNOWLEDGE-DATA-001 §9.3 and gives an Apps run no source tool)`, 'work from the files and the task as given', null, null);
    }
    if (judged === 'ask') {
      return this.refuse(span, 'pending_approval', 'ask', 'engine:gated-tool', ['engine:gated-tool'], `an operator policy asks for approval of ${body.subject}; a live source's tools are allowed by its switches, never by a per-call approval`, 'the operator changes the policy, or the switches on the source sheet', null, null);
    }
    const unitKey = `${scope.unit.runId}:${scope.unit.ord}:${scope.unit.attempt}`;
    const used = this.used.get(unitKey) ?? 0;
    if (used >= this.budget) {
      return this.refuse(span, 'budget_exhausted', 'deny', 'budget', [], `this unit has made its ${this.budget} MCP calls`, 'finish with what you have; the budget is per unit', null, null);
    }
    this.used.delete(unitKey);
    this.used.set(unitKey, used + 1);
    while (this.used.size > BUDGET_UNITS_MAX) this.used.delete(this.used.keys().next().value as string);

    let out: Awaited<ReturnType<DataGate['unitCall']>>;
    try {
      out = await gate.unitCall(scope, server, tool, body.args ?? {}, span.spanId);
    } catch (err) {
      // crew's own words stay in crew's log: an error's text can name a host or a path.
      this.deps.log?.(`[mcp] ${body.subject} failed in crew's gate: ${message(err)}`);
      return this.refuse(span, 'guard_error', 'guard_error', 'broker:gate', [], `${body.subject} failed in crew; nothing is shown`, 'try again, and report it if it persists', null, null);
    }
    if (!out.ok) return this.refuse(span, out.outcome, 'deny', out.ruleId, [out.ruleId], out.reason, out.remedy, null, null);
    const result: Record<string, unknown> = { content: [{ type: 'text', text: JSON.stringify(out.answer) }], isError: out.isError };
    span.bytesOut = Buffer.byteLength(JSON.stringify(result), 'utf8');
    const record = this.record(span, 'ok', 'allow', 'broker:gate', [], out.isError ? 'tool_error' : null, null);
    try {
      await this.deps.records.append(record);
    } catch (err) {
      // A read's rows stay unreleased: the gate record's last entry is still "unconfirmed".
      this.deps.log?.(`[mcp] the call record for ${body.subject} could not be written (${message(err)}); its result is withheld`);
      out.abandon?.();
      return {
        status: OUTCOME_STATUS.guard_error,
        body: { outcome: 'guard_error', subject: body.subject, callId: null, ruleIds: [], reason: 'the call could not be recorded (D-3); its result is withheld', remedy: 'the call ran; its result is not shown' },
      };
    }
    // The release boundary: a read's rows go out only once its release is checked and recorded.
    if (out.commit !== undefined) {
      let c: Awaited<ReturnType<NonNullable<typeof out.commit>>>;
      try {
        c = await out.commit();
      } catch (err) {
        this.deps.log?.(`[mcp] ${body.subject}: the release could not be recorded: ${message(err)}`);
        c = { ok: false, ruleId: 'gate:record', reason: 'crew could not record the release, so the rows are withheld' };
      }
      if (!c.ok) {
        this.deps.log?.(`[mcp] ${body.subject}: the result was withheld at release (${c.ruleId})`);
        return { status: OUTCOME_STATUS.withheld, body: { outcome: 'withheld', subject: body.subject, callId: span.spanId, ruleIds: [c.ruleId], reason: c.reason, remedy: 'ask the person; nothing of the result is shown', denied: true } };
      }
    }
    this.publish(record);
    return { status: 200, body: { outcome: 'ok', subject: body.subject, callId: span.spanId, result, ruleIds: [] } };
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

/**
 * (G2) Why a `rest` tool whose saved hash does not cover its target is refused: it was saved
 * before the target was part of the hash, or its url or auth header changed outside a save. Its hash is
 * not re-computed silently (DES-data-connectors §3): the operator re-saves it, which also withdraws
 * its earlier approvals and leaves its write tools off until they are granted again.
 */
function resaveReason(subject: string): string {
  return `${subject} is refused: its saved approval does not cover where the API's calls go (the base URL's origin and path, and the auth header), because it was saved before crew bound REST approvals to that target or the target changed without a save. The operator must re-save the server`;
}
const RESAVE_REMEDY =
  'the operator re-saves the server in studio → MCP tools (preview it, then save), re-granting any write tools; the first call then asks again. ' +
  'If the preview says the host is a loopback or private address, a human operator previews it again with address.allow naming a range that covers it (and address.plaintext for plain http on a private range); ' +
  "if the save answers egress_unconfirmed (a base URL the spec's servers don't name), a human operator saves it through POST /api/v1/mcp/servers with allowOrigin set to the preview's egress.origin";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
