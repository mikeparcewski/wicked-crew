/**
 * The Toolbox supervisor (DES-KNOWLEDGE-DATA-001 §6.3, §7.3, §7.6): ONE stdio process per source.
 *
 * - Spawned `--stdio --disable-reload --disable-version-check --log-level ERROR` from crew's `tools.yaml`
 *   (`document.ts`). stdio has no listener, so there is no ungated endpoint a same-user process could call;
 *   HTTP mode is never spawned (probe 06).
 * - Its environment is the one placeholder variable (the secret as a YAML-escaped body) plus a fixed PATH,
 *   HOME and TMPDIR. The daemon's own environment (its `PG*` variables included) never reaches it.
 * - Each response is read with a **byte cap** (1 MiB for `unit`): past it the process is killed, so neither
 *   Toolbox's buffering nor a 46.7 MB answer (probe 04b) reaches crew's parser. The call answers `too_large`.
 * - The **deadline kills the process**: stdio ignores cancellation notifications (`mcp.go:45-54`), so a kill is
 *   the honest stop. A process belongs to exactly one source, and the gate runs one call at a time on it, so a
 *   kill fails exactly that call. The process is respawned warm in the background.
 * - stderr is kept only after it is scrubbed of the raw and the escaped secret (start-up errors included).
 * - **Verify on open**: crew's own fixed query reads the session settings it wrote; read-only, search_path and
 *   standard_conforming_strings must hold or the source refuses to serve. A `statement_timeout` of 0 means "no
 *   source-side deadline" (the gate then runs it at concurrency 1 and holds the reservation after a kill).
 * - Reaped after 15 minutes idle.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { childEnvWithBootEstateDb, ESTATE_DB_ENGINE_ENV } from '../../../core/governance-store.js';
import { scrubSecrets } from '../../../mcp/secrets.js';
import { type ToolboxDocument, yamlQuotedBody } from './document.js';

export const TOOLBOX_IDLE_MS = 15 * 60 * 1000;
/** The first exec of the 155 MB binary can take ~19 s (an endpoint-security scan); a warm start ~1.2 s. */
export const TOOLBOX_START_MS = 60_000;
const STDERR_KEEP = 8 * 1024;
/** Crew's own answers (initialize, verify, the reservation check, list_tables) are read up to this. */
const INTERNAL_BYTES = 8 * 1024 * 1024;

export class ToolboxCallError extends Error {
  constructor(
    readonly code: 'deadline' | 'too_large' | 'adapter_exited' | 'adapter_start_failed' | 'adapter_unverified' | 'protocol',
    message: string,
  ) {
    super(message);
    this.name = 'ToolboxCallError';
  }
}

/**
 * A process's stderr as crew keeps it (§7.6: "adapter stdout and stderr are scrubbed of the raw and escaped forms
 * before anything is kept"). One streaming decoder (a multi-byte character split across chunks decodes whole) feeds
 * an UNSCRUBBED window held in memory only (as the secret itself is), larger than the kept tail by twice the
 * longest protected form, so a form split across chunks, or longer than the tail, is whole in it when scrubbed.
 * Only `view()` leaves: scrubbed, with a trailing partial form (a write not finished) cut off, then cut to the tail.
 */
export class StderrTail {
  private raw = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly window: number;

  constructor(
    private readonly forms: readonly string[],
    private readonly keep: number = STDERR_KEEP,
  ) {
    this.window = keep + 2 * Math.max(0, ...forms.map((f) => f.length));
  }

  push(chunk: Buffer): void {
    this.raw = `${this.raw}${this.decoder.write(chunk)}`.slice(-this.window);
  }

  view(): string {
    let t = scrubSecrets(this.raw, [...this.forms]);
    // The window was cut at its start: a form it began inside is no longer whole there, so that start is dropped.
    if (this.raw.length >= this.window) {
      for (const f of this.forms) {
        for (let k = Math.min(f.length - 1, t.length); k > 0; k--) {
          if (t.startsWith(f.slice(-k))) {
            t = t.slice(k);
            break;
          }
        }
      }
    }
    for (const f of this.forms) {
      for (let k = Math.min(f.length - 1, t.length); k > 0; k--) {
        if (t.endsWith(f.slice(0, k))) {
          t = t.slice(0, t.length - k);
          break;
        }
      }
    }
    return t.slice(-this.keep);
  }
}

/** A tool's MCP result as Toolbox answers it. */
export interface ToolboxResult {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
}

export interface ToolboxVerified {
  readOnly: boolean;
  searchPath: string;
  standardStrings: boolean;
  statementTimeout: string;
  /** Whether a source-side deadline holds (a non-zero `statement_timeout`). */
  sourceDeadline: boolean;
}

interface Pending {
  id: number;
  cap: number;
  resolve: (r: ToolboxResult | Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

/** One running Toolbox process for one source. */
export class ToolboxProcess {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending: Pending | null = null;
  private line: Buffer[] = [];
  private lineBytes = 0;
  /**
   * The last stderr as decoded, UNSCRUBBED, held in memory only (as the secret itself is) and never published: a
   * window larger than the kept tail by twice the longest protected form, so a form split across chunks is whole in
   * it when the tail is scrubbed. Only the scrubbed, cut view (`stderr`) ever leaves this object.
   */
  private readonly stderrTail: StderrTail;
  private exited = false;
  /** Set the moment a stop begins: a process being stopped is never handed out again, even before it exits. */
  private stopping = false;
  private idleTimer: NodeJS.Timeout | null = null;
  verified: ToolboxVerified | null = null;
  readonly secrets: string[];

  constructor(
    private readonly bin: string,
    private readonly runDir: string,
    readonly doc: ToolboxDocument,
    secret: string | null,
    private readonly idleMs: number,
    private readonly onGone: (p: ToolboxProcess) => void,
  ) {
    this.secret = secret;
    this.secrets = secret === null || secret === '' ? [] : [secret, yamlQuotedBody(secret), JSON.stringify(secret).slice(1, -1)].filter((s, i, a) => s !== '' && a.indexOf(s) === i);
    this.stderrTail = new StderrTail(this.secrets);
  }

  private readonly secret: string | null;

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get alive(): boolean {
    return this.child !== null && !this.exited && !this.stopping;
  }

  /** The last stderr, scrubbed of the secret's forms (`StderrTail`): for a human's diagnostics only. */
  get stderr(): string {
    return this.stderrTail.view();
  }

  /** Spawn, initialize and verify the session settings. */
  async start(): Promise<void> {
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    const config = join(this.runDir, 'tools.yaml');
    await writeFile(config, this.doc.yaml, { mode: 0o600 });
    if (this.doc.caPem !== null) await writeFile(join(this.runDir, 'ca.pem'), this.doc.caPem, { mode: 0o600 });
    // GOMEMLIMIT is a SOFT bound (the Go runtime collects harder near it); the hard memory limit of §7.4 comes with
    // the per-source runner container (§7.5). Host mode's residual: a process can still grow past it.
    const env: Record<string, string> = { PATH: process.platform === 'win32' ? (process.env['PATH'] ?? '') : '/usr/bin:/bin', HOME: this.runDir, TMPDIR: this.runDir, GOMEMLIMIT: '256MiB' };
    if (process.platform === 'win32' && process.env['SystemRoot'] !== undefined) env['SystemRoot'] = process.env['SystemRoot'];
    if (this.doc.secretVar !== null) env[this.doc.secretVar] = yamlQuotedBody(this.secret ?? '');
    // crew#495: every crew child routes its env through the boot-value helper; the adapter then gets no store at all.
    const childEnv = childEnvWithBootEstateDb(env);
    delete childEnv[ESTATE_DB_ENGINE_ENV];
    const child = spawn(this.bin, ['--stdio', '--config', config, '--disable-reload', '--disable-version-check', '--log-level', 'ERROR'], {
      cwd: this.runDir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail.push(chunk);
    });
    child.on('error', () => this.onExit());
    child.on('exit', () => this.onExit());
    child.stdin?.on('error', () => undefined);
    try {
      await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wicked-crew', version: '1' } }, INTERNAL_BYTES, TOOLBOX_START_MS);
      this.notify('notifications/initialized', {});
      this.verified = await this.verify();
    } catch (err) {
      this.kill();
      if (err instanceof ToolboxCallError && err.code === 'adapter_unverified') throw err;
      throw new ToolboxCallError('adapter_start_failed', `the Toolbox process for this source did not start${err instanceof Error ? ` (${scrubSecrets(err.message, this.secrets)})` : ''}`);
    }
    this.touch();
  }

  private async verify(): Promise<ToolboxVerified> {
    const r = await this.callTool(
      'execute_sql',
      {
        sql: "SELECT current_setting('default_transaction_read_only') AS ro, current_setting('transaction_read_only') AS tro, current_setting('search_path') AS sp, current_setting('standard_conforming_strings') AS scs, current_setting('statement_timeout') AS st, (SELECT s.setting FROM pg_catalog.pg_settings s WHERE s.name = 'statement_timeout') AS st_ms, current_setting('application_name') AS app, COALESCE((SELECT l.ssl FROM pg_catalog.pg_stat_ssl l WHERE l.pid = pg_catalog.pg_backend_pid()), false) AS ssl",
      },
      INTERNAL_BYTES,
      TOOLBOX_START_MS,
    );
    const row = toolboxRows(r)[0];
    if (r.isError || row === undefined) throw new ToolboxCallError('adapter_unverified', 'crew could not read the session settings it wrote for this source');
    const ms = Number(row['st_ms']);
    const v: ToolboxVerified = {
      readOnly: row['ro'] === 'on' && row['tro'] === 'on',
      searchPath: String(row['sp'] ?? ''),
      standardStrings: row['scs'] === 'on',
      statementTimeout: String(row['st'] ?? ''),
      // A source-side deadline holds only when it is in force AND no longer than the gate's: a longer one could leave
      // work running after a kill, so it counts as none (concurrency 1 and the reservation).
      sourceDeadline: Number.isFinite(ms) && ms > 0 && ms <= this.doc.statementTimeoutMs,
    };
    if (!v.readOnly || v.searchPath.replace(/\s/g, '') !== 'pg_catalog,pg_temp' || !v.standardStrings) {
      throw new ToolboxCallError('adapter_unverified', 'the source session does not hold the settings crew wrote (read-only, search_path, standard_conforming_strings), so crew does not serve it');
    }
    // The reservation finds this source's sessions by the name crew wrote, and verify-full must be on TLS.
    if (row['app'] !== this.doc.applicationName) throw new ToolboxCallError('adapter_unverified', 'the source session does not carry the application name crew wrote, so crew does not serve it');
    if (this.doc.tlsRequired && row['ssl'] !== true) throw new ToolboxCallError('adapter_unverified', 'the source session is not on TLS, so crew does not serve it');
    return v;
  }

  /** `tools/list` (the registry's preview of a Toolbox source). */
  async listTools(): Promise<Array<{ name: string; description: string | null; inputSchema: Record<string, unknown> | null; annotations: Record<string, unknown> | null }>> {
    const r = (await this.request('tools/list', {}, INTERNAL_BYTES, TOOLBOX_START_MS)) as { tools?: Array<Record<string, unknown>> };
    return (r.tools ?? [])
      .filter((t) => typeof t['name'] === 'string')
      .map((t) => ({
        name: t['name'] as string,
        description: typeof t['description'] === 'string' ? t['description'] : null,
        inputSchema: t['inputSchema'] !== null && typeof t['inputSchema'] === 'object' ? (t['inputSchema'] as Record<string, unknown>) : null,
        annotations: t['annotations'] !== null && typeof t['annotations'] === 'object' ? (t['annotations'] as Record<string, unknown>) : null,
      }));
  }

  /** `tools/call` with a byte cap on the answer and a deadline; either one kills the process. */
  async callTool(name: string, args: Record<string, unknown>, cap: number, deadlineMs: number): Promise<ToolboxResult> {
    this.touch();
    const r = (await this.request('tools/call', { name, arguments: args }, cap, deadlineMs)) as Partial<ToolboxResult>;
    this.touch();
    return { content: Array.isArray(r.content) ? r.content : [], isError: r.isError === true };
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private request(method: string, params: Record<string, unknown>, cap: number, deadlineMs: number): Promise<Record<string, unknown>> {
    if (!this.alive) return Promise.reject(new ToolboxCallError('adapter_exited', 'the Toolbox process for this source is not running'));
    if (this.pending !== null) return Promise.reject(new ToolboxCallError('protocol', 'a call is already in flight on this source (the gate runs one at a time)'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        this.kill();
        reject(new ToolboxCallError('deadline', `the read ran past its ${Math.round(deadlineMs / 1000)} s deadline; the Toolbox process was stopped`));
      }, deadlineMs);
      this.pending = {
        id,
        cap,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as Record<string, unknown>);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private onData(chunk: Buffer): void {
    let rest = chunk;
    while (rest.length > 0) {
      const nl = rest.indexOf(0x0a);
      const part = nl < 0 ? rest : rest.subarray(0, nl);
      this.lineBytes += part.length;
      const cap = this.pending?.cap ?? INTERNAL_BYTES;
      if (this.lineBytes > cap) {
        // Never parse past the cap: the process is killed, and its answer never reaches crew's parser.
        const p = this.pending;
        this.pending = null;
        this.line = [];
        this.lineBytes = 0;
        this.kill();
        p?.reject(new ToolboxCallError('too_large', `the source's answer passed the ${cap}-byte read bound; the Toolbox process was stopped`));
        return;
      }
      this.line.push(part);
      if (nl < 0) return;
      const text = Buffer.concat(this.line).toString('utf8');
      this.line = [];
      this.lineBytes = 0;
      rest = rest.subarray(nl + 1);
      this.onLine(text);
    }
  }

  private onLine(text: string): void {
    if (text.trim() === '') return;
    let msg: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    const p = this.pending;
    if (p === null || msg.id !== p.id) return; // a notification, or a late answer to a call already given up
    this.pending = null;
    if (msg.error !== undefined) {
      p.reject(new ToolboxCallError('protocol', `the Toolbox process answered a JSON-RPC error (${typeof msg.error.code === 'number' ? msg.error.code : '?'})`));
      return;
    }
    p.resolve((msg.result ?? {}) as Record<string, unknown>);
  }

  private onExit(): void {
    if (this.exited) return;
    this.exited = true;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    const p = this.pending;
    this.pending = null;
    p?.reject(new ToolboxCallError('adapter_exited', 'the Toolbox process for this source exited during the call'));
    // The process's own directory (its document, its CA): nothing of it outlives the process.
    void rm(this.runDir, { recursive: true, force: true }).catch(() => undefined);
    this.onGone(this);
  }

  private touch(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref();
  }

  /** Kill at once (a deadline, a cap): stdio cancel is ignored, so this is the stop. */
  kill(): void {
    this.stopping = true;
    if (this.child !== null && !this.exited) this.child.kill('SIGKILL');
  }

  /** A graceful stop (idle reap, shutdown). */
  stop(): void {
    this.stopping = true;
    if (this.child !== null && !this.exited) {
      this.child.kill('SIGTERM');
      const c = this.child;
      setTimeout(() => {
        if (!this.exited) c.kill('SIGKILL');
      }, 2_000).unref();
    }
  }
}

/** The row objects of a Toolbox `execute_sql` answer (one JSON object per content item, columns in order). */
export function toolboxRows(r: ToolboxResult): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const c of r.content) {
    if (c.type !== 'text' || typeof c.text !== 'string') continue;
    try {
      const v = JSON.parse(c.text) as unknown;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      // not a row
    }
  }
  return out;
}

/** The text of a Toolbox error answer (for its SQLSTATE only; the words never leave crew). */
export function toolboxErrorText(r: ToolboxResult): string {
  return r.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
}

export interface SupervisorDeps {
  /** The verified binary's path. */
  binary: () => Promise<string>;
  /** Where each source's run directory lives (`<state home>/adapters/toolbox/run`). */
  runRoot: string;
  idleMs?: number;
}

interface Slot {
  key: string;
  proc: ToolboxProcess | null;
  starting: Promise<ToolboxProcess> | null;
  /** Replaced or shut down: a start that resolves later is stopped at once. */
  retired: boolean;
}

/** The daemon's Toolbox processes, by source id; a changed document or secret restarts the source's process. */
export class ToolboxSupervisor {
  private readonly procs = new Map<string, Slot>();

  constructor(private readonly deps: SupervisorDeps) {}

  /** The running, verified process for `id` (started now if needed; spawn is not counted against a deadline). */
  async get(id: string, doc: ToolboxDocument, secret: string | null): Promise<ToolboxProcess> {
    const key = createHash('sha256').update(`${doc.yaml}\u0000${secret ?? ''}\u0000${doc.caPem ?? ''}`).digest('hex');
    let slot = this.procs.get(id);
    if (slot !== undefined && slot.key !== key) {
      // A new document or secret: the old generation is stopped, a start still in flight included (it is stopped
      // the moment it resolves), and never handed out again.
      this.retire(slot);
      this.procs.delete(id);
      slot = undefined;
    }
    if (slot?.proc?.alive === true) return slot.proc;
    if (slot?.starting != null) return slot.starting;
    const entry: Slot = slot ?? { key, proc: null, starting: null, retired: false };
    this.procs.set(id, entry);
    // A directory per process: two processes of one source (two generations, or a respawn racing the old one's
    // exit) never share, overwrite or delete one another's document.
    const dir = join(this.deps.runRoot, id.replace(/[^A-Za-z0-9_-]/g, '_'), `${key.slice(0, 12)}-${randomBytes(4).toString('hex')}`);
    entry.starting = (async () => {
      const bin = await this.deps.binary();
      const p = new ToolboxProcess(bin, dir, doc, secret, this.deps.idleMs ?? TOOLBOX_IDLE_MS, (gone) => {
        if (entry.proc === gone) entry.proc = null;
      });
      await p.start();
      if (entry.retired) {
        p.stop();
        throw new ToolboxCallError('adapter_exited', 'the source was saved again while its adapter started');
      }
      entry.proc = p;
      return p;
    })().finally(() => {
      entry.starting = null;
    });
    return entry.starting;
  }

  private retire(slot: Slot): void {
    slot.retired = true;
    slot.proc?.stop();
  }

  /**
   * A throwaway process for one preview (the registry's probe of a source not yet saved): started, handed to `fn`,
   * and stopped whatever `fn` does. Never kept in the map, so no saved source shares it.
   */
  async once<T>(label: string, doc: ToolboxDocument, secret: string | null, fn: (p: ToolboxProcess) => Promise<T>): Promise<T> {
    const bin = await this.deps.binary();
    // Its own directory per invocation: two previews (or Tests) of one entry never share or delete each other's.
    const dir = join(this.deps.runRoot, `preview-${label.replace(/[^A-Za-z0-9_-]/g, '_')}-${randomBytes(4).toString('hex')}`);
    const p = new ToolboxProcess(bin, dir, doc, secret, this.deps.idleMs ?? TOOLBOX_IDLE_MS, () => undefined);
    try {
      await p.start();
      return await fn(p);
    } finally {
      p.kill();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The source's current process, if one runs (for diagnostics and tests). */
  current(id: string): ToolboxProcess | null {
    const p = this.procs.get(id)?.proc ?? null;
    return p?.alive === true ? p : null;
  }

  stopAll(): void {
    for (const s of this.procs.values()) this.retire(s);
    this.procs.clear();
  }
}
