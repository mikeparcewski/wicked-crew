/**
 * The durable half of the write path (DES-APPS-001 §7.3, §9.4): GRANTS and ACTION RECORDS, in one
 * state-home file, `daemon-apps-actions.json` (the state home is fenced from every worker; the daemon loads
 * no SQLite, wicked-core#631). Written atomically (a temp file, then a rename) under one lock, so the
 * record's move to `running` and a revoke never interleave.
 *
 * A record carries the PROCESS EPOCH of the daemon that prepared or started it. At startup every `running`
 * record of an earlier epoch becomes `unknown`: the daemon stopped during its call, and nothing is ever
 * re-run. Records are kept a day after they end (a lost response is answered by `GET …/records/:id`), at
 * most 2,000.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AppActionCard, AppActionGrant, AppActionState } from '../../core/types.js';

export const APPS_ACTIONS_STATE_FILENAME = 'daemon-apps-actions.json';

/** What a run sends, fixed at prepare (crew's `now` and `new uuid` included). */
export type ResolvedOperation =
  | {
      kind: 'row-write';
      schema: string;
      table: string;
      op: 'insert' | 'update' | 'delete';
      /** The statement as generated, and its `$n` values (input-form text, or null). */
      statement: string;
      values: Array<string | null>;
      set: string[];
      key: string[];
      /** The key values, for the result (`{ id: 4821 }`). */
      keyValues: Record<string, unknown>;
    }
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'mutation'; document: string; variables: Record<string, unknown> };

export interface ActionRecord {
  id: string;
  app: string;
  tree: string;
  /** The commit it was prepared on (the run re-reads that version). */
  commit: string;
  version: number | null;
  action: string;
  actionHash: string;
  contractHash: string;
  descriptorHash: string;
  source: string;
  /** A row write: the granted fingerprint the run's check under the lock must equal. */
  fingerprint?: string;
  paramHash: string;
  /** The actor id that prepared it; only they may run or read it. */
  viewer: string;
  state: AppActionState;
  reason?: string;
  result?: unknown;
  card: AppActionCard;
  operation: ResolvedOperation;
  createdAt: number;
  expiresAt: number;
  startedAt?: number;
  endedAt?: number;
  epoch: string;
}

interface StateFile {
  version: 1;
  grants: Record<string, AppActionGrant>;
  records: Record<string, ActionRecord>;
}

const KEEP_ENDED_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 2_000;

const grantKey = (app: string, action: string): string => `${app}\u0000${action}`;

export class AppActionStore {
  /** This process's epoch: a `running` record of any other epoch is from a daemon that stopped. */
  readonly epoch = randomBytes(8).toString('hex');
  private state: StateFile;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly stateFile: string,
    private readonly now: () => number = Date.now,
  ) {
    this.state = this.read();
    // Boot recovery: nothing that was running is re-run; it ends `unknown`.
    let changed = false;
    for (const r of Object.values(this.state.records)) {
      if (r.state === 'running' && r.epoch !== this.epoch) {
        r.state = 'unknown';
        r.reason = 'crew stopped while this action ran: whether it happened is not known (check the source); it is not run again';
        r.endedAt = this.now();
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private read(): StateFile {
    if (!existsSync(this.stateFile)) return { version: 1, grants: {}, records: {} };
    const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as StateFile;
    if (parsed.version !== 1 || typeof parsed.grants !== 'object' || typeof parsed.records !== 'object') throw new Error(`${this.stateFile} is not an actions store this daemon can read`);
    return parsed;
  }

  private persist(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  /** Run `fn` under the store's one lock; a mutation it makes is persisted, or undone when the write fails. */
  async locked<T>(fn: (tx: ActionTx) => T | Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const before = structuredClone(this.state);
      const tx = new ActionTx(this.state);
      try {
        const out = await fn(tx);
        if (tx.dirty) {
          this.prune();
          this.persist();
        }
        return out;
      } catch (err) {
        this.state = before;
        throw err;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** A read outside the lock (a snapshot). */
  grant(app: string, action: string): AppActionGrant | null {
    const g = this.state.grants[grantKey(app, action)];
    return g === undefined ? null : structuredClone(g);
  }

  record(id: string): ActionRecord | null {
    const r = Object.hasOwn(this.state.records, id) ? this.state.records[id] : undefined;
    return r === undefined ? null : structuredClone(r);
  }

  private prune(): void {
    const t = this.now();
    const all = Object.values(this.state.records);
    for (const r of all) {
      const done = r.state !== 'prepared' && r.state !== 'running';
      if ((done && t - (r.endedAt ?? r.createdAt) > KEEP_ENDED_MS) || (r.state === 'prepared' && t - r.expiresAt > 60 * 60 * 1000)) delete this.state.records[r.id];
    }
    const left = Object.values(this.state.records).filter((r) => r.state !== 'running').sort((a, b) => a.createdAt - b.createdAt);
    while (Object.keys(this.state.records).length > MAX_RECORDS && left.length > 0) delete this.state.records[left.shift()!.id];
  }
}

/** The mutations available under the lock. */
export class ActionTx {
  dirty = false;
  constructor(private readonly state: StateFile) {}

  grant(app: string, action: string): AppActionGrant | null {
    return this.state.grants[grantKey(app, action)] ?? null;
  }

  setGrant(g: AppActionGrant): void {
    this.state.grants[grantKey(g.app, g.action)] = g;
    this.dirty = true;
  }

  dropGrant(app: string, action: string): boolean {
    const k = grantKey(app, action);
    if (this.state.grants[k] === undefined) return false;
    delete this.state.grants[k];
    this.dirty = true;
    return true;
  }

  /** Every row-write grant on `source` (any app) withdrawn; answers them. */
  dropRowWriteGrants(source: string): AppActionGrant[] {
    const gone: AppActionGrant[] = [];
    for (const [k, g] of Object.entries(this.state.grants)) {
      if (g.kind === 'row-write' && g.source === source) {
        gone.push(g);
        delete this.state.grants[k];
      }
    }
    if (gone.length > 0) this.dirty = true;
    return gone;
  }

  record(id: string): ActionRecord | null {
    return Object.hasOwn(this.state.records, id) ? this.state.records[id]! : null;
  }

  addRecord(r: Omit<ActionRecord, 'id'>): ActionRecord {
    const rec: ActionRecord = { ...r, id: randomUUID() };
    this.state.records[rec.id] = rec;
    this.dirty = true;
    return rec;
  }

  update(r: ActionRecord, patch: Partial<ActionRecord>): ActionRecord {
    Object.assign(r, patch);
    this.dirty = true;
    return r;
  }
}
