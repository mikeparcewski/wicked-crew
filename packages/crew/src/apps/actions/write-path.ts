/**
 * The shared write path (DES-APPS-001 §7.3, §7.4, §9.4): grant, prepare, run, records, for both kinds of
 * action. The library crew's routes serve and the app server (K6) reuses.
 *
 *  - GRANT (a person, once per action version): the version's tree is accepted, the action is in it and
 *    its lock entry is crew's; the source's descriptor and the action's contract recomputed NOW equal the
 *    lock's; a row write needs its source's Allow writes on and passes the table safety check now. The grant
 *    binds the action hash, the contract hash (with the fingerprint) and the descriptor. Audited
 *    `apps.action.granted` / `revoked`.
 *  - PREPARE and RUN each recheck: not `APPS_READ_ONLY`; the tree still holds its receipt; the grant still
 *    matches the action and contract hashes; the source's descriptor still matches; a database source still
 *    has Allow writes on. A stale grant is withdrawn (any change withdraws it). Prepare also re-runs the
 *    safety check (the card says "checked just now"), validates the parameters (a viewer-bound one from the
 *    viewer only), fills crew's `now` / `new uuid`, asks the database whether each value fits (P28), and
 *    makes the CARD from the resolved operation; the record expires in 2 minutes.
 *  - RUN moves the record from `prepared` to `running` under the store's lock, persisted BEFORE the call:
 *    the linearization point (a revoke or an Allow-writes-off before it wins). Then the call; the outcome
 *    is persisted, audited `apps.action.ran` (no values), and the app's read cache is invalidated.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Actor, AppAction, AppActionCard, AppActionCardValue, AppActionGrant, AppActionPrepareResponse, AppActionRecordView, AppActionRunResponse, AppApiAction, AppRowWriteAction, AppValue } from '../../core/types.js';
import type { AuditLog } from '../../api/audit.js';
import { canonicalJson } from '../../mcp/classify.js';
import type { McpRegistry } from '../../mcp/registry.js';
import type { McpToolRecord } from '../../mcp/registry-store.js';
import type { DialOptions } from '../../sources/dialer.js';
import { pgPrivileges } from '../../sources/catalog/postgres.js';
import { pgReadOnly } from '../../sources/drivers/postgres.js';
import { sqlConnectArgs } from '../../sources/kinds.js';
import { pgTableSafety, type SafetyColumn } from '../../sources/safety/postgres.js';
import { actionHash } from '../check.js';
import { graphqlMutationContract, graphqlRootSignatures, rowWriteContract, splitTable, toolActionContract } from '../exec/contract.js';
import { type AppExecutor, graphqlVariablesProblem } from '../exec/executor.js';
import { AppLimits, RateLimited } from '../exec/limits.js';
import { bindParams, ParamError, type Viewer } from '../exec/params.js';
import { checkRowValues } from '../exec/source-stage.js';
import { lookupSource, pinOf, type AppSource } from '../exec/sources.js';
import type { AppStore } from '../store.js';
import { callMutation, callTool, describeMutation, describeToolRequest, idempotencyArg, mutationField, type ApiOutcome } from './api-action.js';
import { baseTypeSql, pgExactFitIn, type FitItem } from './pg-fit.js';
import { generateStatement, runRowWrite, type WriteHooks } from './pg-write.js';
import type { ActionRecord, AppActionStore, ResolvedOperation } from './store.js';
import { crewNow, inputForm, writableKind } from './values.js';

export const RECORD_TTL_MS = 2 * 60 * 1000;

/** crew itself, for withdrawals no person asked for (a changed source, Allow writes off). */
const CREW: Actor = { id: 'wicked-crew', kind: 'system', trust: 'admin' };

export class AppWriteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: { retryAfterMs?: number } = {},
  ) {
    super(message);
  }
}

export interface WritePathDeps {
  store: AppStore;
  actions: AppActionStore;
  registry: McpRegistry | null;
  audit: Pick<AuditLog, 'record'>;
  viewerOf: (actor: Actor) => Promise<Viewer>;
  /** The read cache to invalidate after every outcome. */
  executor?: Pick<AppExecutor, 'invalidate'>;
  env?: NodeJS.ProcessEnv;
  dial?: DialOptions;
  now?: () => number;
  /** TESTS ONLY: the race seams inside a row write's transaction. */
  hooks?: WriteHooks;
}

const sha = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex');
const LABEL: Record<AppActionCardValue['from'], string> = { param: 'you entered it', app: 'fixed by the app', viewer: 'your sign-in', crew: 'filled by studio' };

/** A grant or record check that failed, with the words for the person. */
const refuse = (status: number, code: string, message: string): AppWriteError => new AppWriteError(status, code, message);

/** What an action resolves to against the source now: its contract and what the run needs. */
interface Resolved {
  source: AppSource;
  contractHash: string;
  /** A row write: the safety result now. */
  safety?: { fingerprint: string; columns: SafetyColumn[] };
  /** An API tool. */
  tool?: McpToolRecord;
  /** A mutation's root field name (for the card), and the key its result arrives under (its alias, or the name). */
  field?: string;
  responseKey?: string;
}

export class AppWritePath {
  readonly limits: AppLimits;
  private readonly now: () => number;

  constructor(private readonly deps: WritePathDeps) {
    this.now = deps.now ?? Date.now;
    this.limits = new AppLimits(this.now);
    // A run a stopped daemon left `running` gets its audit line now, as `unknown` (codex r1).
    for (const r of deps.actions.recoveredAtBoot) {
      this.audited('apps.action.ran', CREW, { app: r.app, action: r.action, record: r.id, viewer: r.viewer, descriptorHash: r.descriptorHash, paramsDigest: r.paramHash, outcome: 'unknown', reason: 'crew stopped during the run', recovered: true });
    }
  }

  private readOnly(): boolean {
    const v = (this.deps.env ?? process.env)['APPS_READ_ONLY'];
    return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  }

  private refuseReadOnly(): void {
    if (this.readOnly()) throw refuse(409, 'read_only', 'APPS_READ_ONLY is set: no action runs on this daemon');
  }

  /** The action at an accepted version, with its lock entry (crew's). */
  private async actionAt(app: string, version: number | string, id: string) {
    const at = await this.deps.store.acceptedFiles(app, version);
    const action = at.files.spec.actions.find((a) => a.id === id);
    if (action === undefined) throw refuse(404, 'unknown_action', `this version of ${app} has no action ${id}`);
    const locked = Object.hasOwn(at.files.lock.actions, id) ? at.files.lock.actions[id]! : undefined;
    const pinned = Object.hasOwn(at.files.lock.sources, action.source) ? at.files.lock.sources[action.source]! : undefined;
    if (locked === undefined || pinned === undefined || locked.actionHash !== actionHash(action)) throw refuse(409, 'contract_changed', `action ${id} was never checked in this version: check it again`);
    return { at, action, locked, pinned };
  }

  /** Recompute the action's contract against the source now (never executes it). */
  private async resolve(action: AppAction, snapshot?: AppSource | null): Promise<Resolved> {
    // ONE snapshot of the source for the check and the call (codex r1: two lookups could see two saves).
    const source = snapshot !== undefined ? snapshot : await lookupSource(this.deps.registry, action.source);
    if (source === null) throw refuse(409, 'contract_changed', `${action.source} is gone`);
    if (action.kind === 'row-write') {
      if (source.kind !== 'sql' || source.config.sql?.driver !== 'postgres') throw refuse(409, 'contract_changed', `${action.source} is not a Postgres source`);
      const { schema, name } = splitTable(action.table);
      const set = Object.keys(action.set ?? {});
      const key = Object.keys(action.key);
      const secret = await this.secret(source);
      const r = await pgTableSafety(sqlConnectArgs(source.config, secret, this.deps.dial ?? {}), schema, name, { op: action.op, set, key }).catch((err: unknown) => {
        throw refuse(502, 'source_unavailable', `the safety check on ${action.table} could not run (${(err as { errorClass?: string }).errorClass ?? 'connection'})`);
      });
      if (!r.safe) throw refuse(409, 'table_changed', `${action.table} does not pass the table safety check now: ${r.reasons.map((x) => x.detail).join('; ')}`);
      return { source, contractHash: rowWriteContract({ schema, table: name, op: action.op, set, key, fingerprint: r.fingerprint }), safety: { fingerprint: r.fingerprint, columns: r.columns } };
    }
    if (action.call.kind === 'tool') {
      if (source.kind !== 'rest' && source.kind !== 'mcp-http' && source.kind !== 'mcp-stdio') throw refuse(409, 'contract_changed', `${action.source} is not a REST or MCP server now`);
      const t = await this.deps.registry!.appTool(source.name, action.call.tool);
      if (t === null || !t.bound || pinOf(t.config).descriptorHash !== source.pin.descriptorHash) throw refuse(409, 'contract_changed', `${action.source}/${action.call.tool} changed since this version was checked`);
      return { source, contractHash: toolActionContract(source.kind, t.tool), tool: t.tool };
    }
    if (source.kind !== 'graphql' || source.description?.introspection === undefined) throw refuse(409, 'contract_changed', `${action.source} is not a described GraphQL source now`);
    const sigs = graphqlRootSignatures(action.call.mutation, source.description.introspection, 'mutation');
    if (sigs === null) throw refuse(409, 'contract_changed', `the mutation no longer fits ${action.source}'s schema`);
    return { source, contractHash: graphqlMutationContract(sigs), field: mutationField(action.call.mutation).name, responseKey: mutationField(action.call.mutation).key };
  }

  private async secret(s: AppSource): Promise<string | null> {
    if (s.kind === 'crew') return null;
    const r = await this.deps.registry!.callSecret(s.config);
    if (r.missing) throw refuse(409, 'source_failed', `${s.name}'s secret resolves to nothing; set it first`);
    return r.secret;
  }

  private audited(what: 'apps.action.granted' | 'apps.action.revoked' | 'apps.action.ran', actor: Actor, detail: Record<string, unknown>): void {
    this.deps.audit.record(what, actor, { detail });
  }

  /** Withdraw a grant that no longer holds (any change withdraws it), audited, then refuse. */
  private async withdraw(app: string, action: string, why: string, code: string, message: string, observed?: AppActionGrant): Promise<never> {
    // Only the grant that was judged stale goes: one granted again meanwhile stays (codex r1).
    const gone = await this.deps.actions.locked((tx) => {
      const g = tx.grant(app, action);
      if (g === null || (observed !== undefined && (g.grantedAt !== observed.grantedAt || g.contractHash !== observed.contractHash || g.actionHash !== observed.actionHash || g.descriptorHash !== observed.descriptorHash))) return false;
      return tx.dropGrant(app, action);
    });
    if (gone) this.audited('apps.action.revoked', CREW, { app, action, reason: why });
    throw refuse(409, code, message);
  }

  // ── grant / revoke ───────────────────────────────────────────────────────────────────────────

  async grant(app: string, id: string, input: { version: number | string; actor: Actor }): Promise<AppActionGrant> {
    const { action, locked, pinned } = await this.actionAt(app, input.version, id);
    const source = await lookupSource(this.deps.registry, action.source);
    if (source !== null && source.kind === 'sql' && !source.allowWrites) throw refuse(409, 'writes_off', `${action.source}'s Allow writes switch is off: turn it on before granting a row write`);
    const r = await this.resolve(action);
    // The writer login must hold what the write needs (§7.4 "The writer login"): say exactly which GRANTs are missing.
    if (action.kind === 'row-write' && r.source.kind === 'sql') {
      const { schema, name } = splitTable(action.table);
      const report = await pgPrivileges(sqlConnectArgs(r.source.config, await this.secret(r.source), this.deps.dial ?? {}), [{ schema, table: name, op: action.op, set: Object.keys(action.set ?? {}), key: Object.keys(action.key) }]).catch(() => null);
      // No report is no evidence: the grant waits for one (codex r1).
      if (report === null || report.writes[0] === undefined) throw refuse(502, 'source_unavailable', `the privilege report for ${action.table} could not be read; nothing was granted`);
      const missing = report.writes[0].missing;
      if (missing.length > 0) throw refuse(409, 'missing_grants', `${r.source.config.sql?.user ?? 'the login'} cannot make this write yet; run: ${missing.join(' ')}`);
    }
    if (r.source.pin.descriptorHash !== pinned.descriptorHash) throw refuse(409, 'contract_changed', `${action.source}'s connection changed since this version was checked: check it again`);
    if (r.contractHash !== locked.contractHash) throw refuse(409, action.kind === 'row-write' ? 'table_changed' : 'contract_changed', `what action ${id} uses at ${action.source} changed since this version was checked: check it again`);
    const grant: AppActionGrant = {
      app,
      action: id,
      kind: action.kind === 'row-write' ? 'row-write' : 'api',
      source: action.source,
      actionHash: locked.actionHash,
      contractHash: locked.contractHash,
      descriptorHash: pinned.descriptorHash,
      ...(r.safety !== undefined ? { fingerprint: r.safety.fingerprint } : {}),
      grantedBy: input.actor,
      grantedAt: this.now(),
    };
    // Allow writes is read again under the lock, so a switch turned off meanwhile (its withdrawal waits for this lock) wins.
    await this.deps.actions.locked(async (tx) => {
      if (action.kind === 'row-write') {
        const now = await lookupSource(this.deps.registry, action.source);
        if (now === null || now.kind !== 'sql' || !now.allowWrites || now.pin.descriptorHash !== pinned.descriptorHash) throw refuse(409, 'writes_off', `${action.source}'s Allow writes switch is off`);
      }
      tx.setGrant(grant);
    });
    this.audited('apps.action.granted', input.actor, { app, action: id, kind: grant.kind, source: grant.source, actionHash: grant.actionHash, contractHash: grant.contractHash, descriptorHash: grant.descriptorHash, ...(grant.fingerprint !== undefined ? { fingerprint: grant.fingerprint } : {}) });
    return grant;
  }

  async revoke(app: string, id: string, actor: Actor): Promise<boolean> {
    const gone = await this.deps.actions.locked((tx) => tx.dropGrant(app, id));
    if (gone) this.audited('apps.action.revoked', actor, { app, action: id });
    return gone;
  }

  getGrant(app: string, id: string): AppActionGrant | null {
    return this.deps.actions.grant(app, id);
  }

  /** K1's Allow writes switch: off withdraws every row-write grant on the source (under the store's lock). */
  async withdrawForSource(source: string): Promise<number> {
    const gone = await this.deps.actions.locked((tx) => tx.dropRowWriteGrants(source));
    for (const g of gone) this.audited('apps.action.revoked', CREW, { app: g.app, action: g.action, reason: 'allow_writes_off' });
    return gone.length;
  }

  // ── prepare ──────────────────────────────────────────────────────────────────────────────────

  /** Every recheck prepare and run share; answers the grant and what the action resolves to now. */
  private async recheck(app: string, action: AppAction, tree: string, record?: Pick<ActionRecord, 'descriptorHash' | 'contractHash' | 'actionHash'>): Promise<{ grant: AppActionGrant; resolved: Resolved }> {
    this.refuseReadOnly();
    if (this.deps.store.acceptedReceipt(app, tree) === null) throw refuse(409, 'not_accepted', `tree ${tree} no longer holds an accepted receipt for ${app}`);
    const grant = this.deps.actions.grant(app, action.id);
    const hash = actionHash(action);
    if (grant === null) throw refuse(409, 'not_granted', `action ${action.id} is not granted: a person grants it in the data panel first`);
    // The grant is for another version of the action (an older tab, or a newer grant): refused, and that
    // grant stays (codex r1).
    if (grant.actionHash !== hash || (record !== undefined && (record.actionHash !== hash || record.actionHash !== grant.actionHash || record.contractHash !== grant.contractHash))) {
      throw refuse(409, 'not_granted', `this version of action ${action.id} is not the one granted: grant it again to use it`);
    }
    const source = await lookupSource(this.deps.registry, action.source);
    if (source === null || source.pin.descriptorHash !== grant.descriptorHash || (record !== undefined && record.descriptorHash !== source.pin.descriptorHash)) {
      return this.withdraw(app, action.id, 'source_changed', 'contract_changed', `${action.source}'s connection changed since the grant: the grant is withdrawn`, grant);
    }
    if (source.kind !== 'crew' && !source.enabled) throw refuse(409, 'contract_changed', `${action.source} is switched off`);
    if (action.kind === 'row-write' && (source.kind !== 'sql' || !source.allowWrites)) throw refuse(409, 'writes_off', `${action.source}'s Allow writes switch is off`);
    let resolved: Resolved;
    try {
      resolved = await this.resolve(action, source);
    } catch (err) {
      if (err instanceof AppWriteError && (err.code === 'table_changed' || err.code === 'contract_changed')) return this.withdraw(app, action.id, err.code, err.code, `${err.message}: the grant is withdrawn`, grant);
      throw err;
    }
    if (resolved.contractHash !== grant.contractHash) {
      return this.withdraw(app, action.id, 'contract_changed', action.kind === 'row-write' ? 'table_changed' : 'contract_changed', `what action ${action.id} uses at ${action.source} changed since the grant (for a table: its safety fingerprint): the grant is withdrawn`, grant);
    }
    return { grant, resolved };
  }

  async prepareAction(app: string, id: string, input: { version: number | string; params?: Record<string, unknown>; actor: Actor }): Promise<AppActionPrepareResponse> {
    this.refuseReadOnly();
    this.rate(app, input.actor, 'prepare');
    const { at, action } = await this.actionAt(app, input.version, id);
    const { grant, resolved } = await this.recheck(app, action, at.tree);
    const viewer = await this.deps.viewerOf(input.actor);
    let bound: ReturnType<typeof bindParams>;
    try {
      bound = bindParams(action.params, input.params, viewer);
    } catch (err) {
      if (err instanceof ParamError) throw refuse(err.code === 'bad_params' ? 400 : 409, err.code, err.message);
      throw err;
    }
    const nowAt = new Date(this.now());
    const value = (v: AppValue): { value: unknown; from: AppActionCardValue['from']; label: string } => {
      if (v.kind === 'param') {
        const decl = action.params?.properties[v.name];
        if (decl?.from !== undefined) return { value: bound.byName[v.name], from: 'viewer', label: LABEL.viewer };
        return { value: bound.byName[v.name], from: 'param', label: LABEL.param };
      }
      if (v.kind === 'literal') return { value: v.value, from: 'app', label: LABEL.app };
      if (v.kind === 'viewer') {
        const claim = v.claim === 'email' ? viewer.email : v.claim === 'name' ? viewer.name : viewer.id;
        if (claim === null) throw refuse(409, 'viewer_unavailable', `the action needs your ${v.claim}, and crew does not know it: set your git user.${v.claim}`);
        return { value: claim, from: 'viewer', label: LABEL.viewer };
      }
      return { value: v.value === 'now' ? '' : randomUUID(), from: 'crew', label: `${LABEL.crew}: ${v.value === 'now' ? 'now' : 'new uuid'}` };
    };
    // The record's id is chosen first: an operation that sends it (an idempotency key) shows it on the card.
    const recordId = randomUUID();
    let card: AppActionCard;
    let operation: ResolvedOperation;
    if (action.kind === 'row-write') ({ card, operation } = await this.prepareRow(app, action, resolved, value, nowAt));
    else ({ card, operation } = this.prepareApi(app, action, resolved, value, nowAt, bound.absent, recordId));
    const t = this.now();
    const rec = await this.deps.actions.locked((tx) => {
      // The grant is read again under the lock: a revoke meanwhile wins.
      const g = tx.grant(app, id);
      if (g === null || g.contractHash !== grant.contractHash || g.actionHash !== grant.actionHash || g.descriptorHash !== grant.descriptorHash) throw refuse(409, 'not_granted', `action ${id} was revoked or granted again while it was being prepared`);
      return tx.addRecord({
        id: recordId,
        app,
        tree: at.tree,
        commit: at.commit,
        version: at.version,
        action: id,
        actionHash: grant.actionHash,
        contractHash: grant.contractHash,
        descriptorHash: grant.descriptorHash,
        source: action.source,
        ...(grant.fingerprint !== undefined ? { fingerprint: grant.fingerprint } : {}),
        paramHash: sha(operation),
        viewer: input.actor.id,
        state: 'prepared',
        card,
        operation,
        createdAt: t,
        expiresAt: t + RECORD_TTL_MS,
        epoch: this.deps.actions.epoch,
      });
    });
    return { record: rec.id, card: rec.card, expiresAt: rec.expiresAt };
  }

  private async prepareRow(
    app: string,
    action: AppRowWriteAction,
    resolved: Resolved,
    value: (v: AppValue) => { value: unknown; from: AppActionCardValue['from']; label: string },
    nowAt: Date,
  ): Promise<{ card: AppActionCard; operation: ResolvedOperation }> {
    const columns = resolved.safety!.columns;
    // The declaration against the columns as they are now (the source stage's rule, again).
    try {
      checkRowValues(action, columns);
    } catch (err) {
      throw refuse(409, 'table_changed', err instanceof Error ? err.message : String(err));
    }
    const { schema, name } = splitTable(action.table);
    const set = Object.keys(action.set ?? {});
    const key = Object.keys(action.key);
    const stmt = generateStatement({ schema, table: name, op: action.op, set, key, columns });
    const texts = new Map<string, { text: string | null; card: AppActionCardValue }>();
    const fit: FitItem[] = [];
    const resolveCol = (column: string, v: AppValue): { text: string | null; card: AppActionCardValue } => {
      const c = columns.find((x) => x.name === column)!;
      const kind = writableKind(c)!;
      const r = value(v);
      const raw = v.kind === 'crew' && v.value === 'now' ? crewNow(kind, nowAt) : r.value;
      const f = inputForm(kind, raw, { nullable: !c.notnull, ...(c.enumLabels !== undefined ? { enumLabels: c.enumLabels } : {}) });
      if (!f.ok) throw refuse(400, 'bad_params', `the value for ${action.table}.${column} ${f.why}`);
      if (f.text !== null) fit.push({ column, full: c.type, base: baseTypeSql(c), text: f.text });
      const shown = typeof raw === 'number' || typeof raw === 'boolean' || raw === null ? raw : String(f.text);
      return { text: f.text, card: { name: column, value: shown, from: r.from, label: r.label } };
    };
    for (const c of set) texts.set(`set:${c}`, resolveCol(c, action.set![c]!));
    for (const k of key) if (!texts.has(`key:${k}`)) texts.set(`key:${k}`, resolveCol(k, action.key[k]!));
    const source = resolved.source as Extract<AppSource, { kind: 'sql' }>;
    const args = sqlConnectArgs(source.config, await this.secret(source), this.deps.dial ?? {});
    const misfits = await pgReadOnly(args, (tx) => pgExactFitIn(tx, fit)).catch((err: unknown) => {
      throw refuse(502, 'source_unavailable', `the values could not be checked at ${action.source} (${(err as { errorClass?: string }).errorClass ?? 'connection'})`);
    });
    if (misfits.length > 0) throw refuse(409, 'value_does_not_fit', misfits.map((m) => `${JSON.stringify(fit.find((f) => f.column === m.column)?.text ?? '')} ${m.why}`).join('; '));
    const values = stmt.slots.map((s) => texts.get(`${s.role}:${s.column}`)!.text);
    const keyValues = Object.fromEntries(key.map((k) => [k, texts.get(`key:${k}`)!.card.value]));
    const verb = action.op === 'insert' ? 'INSERT' : action.op === 'update' ? 'UPDATE' : 'DELETE';
    const card: AppActionCard = {
      kind: 'row-write',
      app,
      action: action.id,
      source: action.source,
      login: source.config.sql?.user ?? '',
      verb,
      table: action.table,
      columns: set.map((c) => texts.get(`set:${c}`)!.card),
      key: key.map((k) => texts.get(`key:${k}`)!.card),
      rows: 'exactly 1 row, verified',
      checks: 'plain table: no triggers, rules, inheritance or row security; checked just now',
      statement: stmt.text,
      ...(action.description !== undefined ? { appSays: action.description } : {}),
    };
    return { card, operation: { kind: 'row-write', schema, table: name, op: action.op, statement: stmt.text, values, set, key, keyValues } };
  }

  private prepareApi(
    app: string,
    action: AppApiAction,
    resolved: Resolved,
    value: (v: AppValue) => { value: unknown; from: AppActionCardValue['from']; label: string },
    nowAt: Date,
    absent: ReadonlySet<string>,
    recordId: string,
  ): { card: AppActionCard; operation: ResolvedOperation } {
    const cards: AppActionCardValue[] = [];
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(action.args)) {
      // An absent optional parameter's argument is left out of the call (and off the card), never sent as null.
      if (v.kind === 'param' && absent.has(v.name)) continue;
      const r = value(v);
      const sent = v.kind === 'crew' && v.value === 'now' ? nowAt.toISOString() : r.value;
      args[k] = sent;
      cards.push({ name: k, value: sent === undefined ? null : (sent as AppActionCardValue['value']), from: r.from, label: r.label });
    }
    const source = resolved.source as Extract<AppSource, { kind: 'rest' | 'mcp-http' | 'mcp-stdio' | 'graphql' }>;
    let shown: { operation: string; request: string };
    let operation: ResolvedOperation;
    if (action.call.kind === 'tool') {
      const tool = resolved.tool!;
      // An operation that maps an Idempotency-Key header gets the record id, on the card like any value (codex/pi r1).
      const idem = idempotencyArg(tool.rest);
      if (idem !== null && !Object.hasOwn(args, idem)) {
        args[idem] = recordId;
        cards.push({ name: idem, value: recordId, from: 'crew', label: `${LABEL.crew}: the record id` });
      }
      shown = describeToolRequest(source.config, tool.name, tool.rest, args);
      operation = { kind: 'tool', tool: tool.name, args };
    } else {
      // graphql-js's own coercion of the variables, before any card (Int range, enums, nulls).
      const introspection = (source as Extract<AppSource, { kind: 'graphql' }>).description?.introspection;
      const problem = introspection === undefined ? 'the source is not described' : graphqlVariablesProblem(action.call.mutation, introspection, args);
      if (problem !== null) throw refuse(400, 'bad_params', problem);
      shown = describeMutation(source.config, action.call.mutation, args, resolved.field ?? 'mutation');
      operation = { kind: 'mutation', document: action.call.mutation, variables: args };
    }
    const card: AppActionCard = {
      kind: 'api',
      app,
      action: action.id,
      source: action.source,
      sourceKind: source.kind,
      operation: shown.operation,
      args: cards,
      request: shown.request,
      ...(action.description !== undefined ? { appSays: action.description } : {}),
    };
    return { card, operation };
  }

  private rate(app: string, actor: Actor, bucket: 'action' | 'prepare'): void {
    try {
      this.limits.rate(bucket, app, actor.id);
    } catch (err) {
      if (err instanceof RateLimited) throw new AppWriteError(429, 'rate_limited', err.message, { retryAfterMs: err.retryAfterMs });
      throw err;
    }
  }

  // ── run ──────────────────────────────────────────────────────────────────────────────────────

  async runAction(app: string, id: string, input: { record: string; actor: Actor }): Promise<AppActionRunResponse> {
    this.refuseReadOnly();
    this.rate(app, input.actor, 'action');
    const snap = this.deps.actions.record(input.record);
    if (snap === null || snap.app !== app || snap.action !== id || snap.viewer !== input.actor.id) throw refuse(404, 'unknown_record', `no record ${input.record} of ${app}/${id} for you`);
    if (snap.state !== 'prepared') throw refuse(409, 'record_used', `record ${snap.id} is ${snap.state}: an action record runs once`);
    if (this.now() >= snap.expiresAt) throw refuse(409, 'record_expired', `record ${snap.id} expired: prepare the action again`);
    const files = await this.deps.store.acceptedFiles(app, snap.commit).catch((err: unknown) => {
      throw refuse(409, 'not_accepted', `the version record ${snap.id} was prepared on is no longer accepted (${(err as { code?: string }).code ?? 'unreadable'})`);
    });
    const action = files.files.spec.actions.find((a) => a.id === id);
    if (action === undefined || files.tree !== snap.tree) throw refuse(409, 'not_accepted', `the version this record was prepared on no longer holds action ${id}`);
    const { resolved } = await this.recheck(app, action, snap.tree, snap);
    const secret = await this.secret(resolved.source);
    await this.deps.hooks?.beforeRunning?.();
    // The linearization point: prepared → running, persisted, under the lock a revoke and Allow-writes-off take
    // too. The awaited read of the source comes FIRST; every check after it is synchronous, right before the
    // step (codex r1: expiry or APPS_READ_ONLY could otherwise change during the await).
    const rec = await this.deps.actions.locked(async (tx) => {
      const now = await lookupSource(this.deps.registry, action.source);
      const r = tx.record(snap.id);
      if (r === null || r.state !== 'prepared') throw refuse(409, 'record_used', `record ${snap.id} already ran`);
      if (this.now() >= r.expiresAt) throw refuse(409, 'record_expired', `record ${snap.id} expired: prepare the action again`);
      if (this.readOnly()) throw refuse(409, 'read_only', 'APPS_READ_ONLY is set: no action runs on this daemon');
      const g = tx.grant(app, id);
      if (g === null || g.actionHash !== r.actionHash || g.contractHash !== r.contractHash || g.descriptorHash !== r.descriptorHash) throw refuse(409, 'not_granted', `action ${id} was revoked or granted again`);
      // The source the call goes to is the one checked: its descriptor is the record's, for every kind (codex r1).
      if (now === null || now.pin.descriptorHash !== r.descriptorHash || resolved.source.pin.descriptorHash !== r.descriptorHash) throw refuse(409, 'contract_changed', `${action.source} changed while the action was starting`);
      if (now.kind !== 'crew' && !now.enabled) throw refuse(409, 'contract_changed', `${action.source} is switched off`);
      if (action.kind === 'row-write' && (now.kind !== 'sql' || !now.allowWrites)) throw refuse(409, 'writes_off', `${action.source}'s Allow writes switch is off`);
      return structuredClone(tx.update(r, { state: 'running', startedAt: this.now(), epoch: this.deps.actions.epoch }));
    });
    let outcome: { state: 'succeeded' | 'failed' | 'unknown'; reason?: string; result?: unknown };
    const started = this.now();
    try {
      outcome = await this.execute(rec, resolved, secret);
    } catch (err) {
      // Only reached by a bug: the call may have gone out, so the outcome is not known.
      outcome = { state: 'unknown', reason: `the run ended unexpectedly (${err instanceof Error ? err.name : 'error'}): whether it happened is not known` };
    }
    // The outcome is known now: it is answered, audited and the cache invalidated even if saving it fails
    // (codex r1); the record then stays `running` on disk and the next start makes it `unknown`.
    const patch = { state: outcome.state, ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}), ...(outcome.result !== undefined ? { result: outcome.result } : {}), endedAt: this.now() };
    let done: ActionRecord = { ...rec, ...patch };
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      try {
        done = await this.deps.actions.locked((tx) => structuredClone(tx.update(tx.record(rec.id)!, patch)));
        saved = true;
      } catch {
        // retried once
      }
    }
    this.deps.executor?.invalidate(app);
    const op = rec.operation;
    this.audited('apps.action.ran', input.actor, {
      app,
      action: id,
      record: rec.id,
      viewer: rec.viewer,
      descriptorHash: rec.descriptorHash,
      operation: op.kind === 'row-write' ? `${op.op.toUpperCase()} ${op.schema}.${op.table}` : rec.card.kind === 'api' ? rec.card.operation.replace(/\s.*$/, '') + (op.kind === 'tool' ? ` ${op.tool}` : '') : op.kind,
      paramsDigest: rec.paramHash,
      ...(rec.fingerprint !== undefined ? { fingerprint: rec.fingerprint } : {}),
      outcome: done.state,
      ...(done.reason !== undefined ? { reason: done.reason } : {}),
      ...(saved ? {} : { recordNotSaved: true }),
      ms: this.now() - started,
    });
    return { record: done.id, state: done.state as AppActionRunResponse['state'], ...(done.reason !== undefined ? { reason: done.reason } : {}), ...(done.result !== undefined ? { result: done.result } : {}) };
  }

  private async execute(rec: ActionRecord, resolved: Resolved, secret: string | null): Promise<{ state: 'succeeded' | 'failed' | 'unknown'; reason?: string; result?: unknown }> {
    const op = rec.operation;
    if (op.kind === 'row-write') {
      const source = resolved.source as Extract<AppSource, { kind: 'sql' }>;
      const out = await runRowWrite(sqlConnectArgs(source.config, secret, this.deps.dial ?? {}), { ...op, fingerprint: rec.fingerprint ?? '' }, this.deps.hooks ?? {});
      if (out.state === 'succeeded') return { state: 'succeeded', result: { table: `${op.schema}.${op.table}`, op: op.op, key: op.keyValues } };
      return { state: out.state, reason: out.reason };
    }
    const source = resolved.source as Extract<AppSource, { kind: 'rest' | 'mcp-http' | 'mcp-stdio' | 'graphql' }>;
    let out: ApiOutcome;
    if (op.kind === 'tool') {
      out = await callTool(source.config, secret, op.tool, resolved.tool?.rest, op.args);
    } else {
      out = await callMutation(source.config, secret, op.document, op.variables, resolved.responseKey ?? mutationField(op.document).key, this.deps.dial ?? {});
    }
    return out.state === 'succeeded' ? { state: 'succeeded', result: out.result } : { state: out.state, reason: out.reason };
  }

  /** `GET …/records/:id`: the person who prepared it. */
  recordView(app: string, id: string, actor: Actor): AppActionRecordView {
    const r = this.deps.actions.record(id);
    if (r === null || r.app !== app || r.viewer !== actor.id) throw refuse(404, 'unknown_record', `no record ${id} of ${app} for you`);
    return {
      id: r.id,
      app: r.app,
      action: r.action,
      version: r.version,
      tree: r.tree,
      state: r.state,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      ...(r.result !== undefined ? { result: r.result } : {}),
      card: r.card,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
    };
  }
}
