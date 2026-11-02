/**
 * THE DURABLE PER-DOCUMENT BINDING OF A CHAT-MADE DOCUMENT (DES-CHAT-ARTIFACTS-001 §5.2, §6.2; slice A3).
 *
 * A proposal's Go makes (or fills again) one document, `<mount>/<doc>`. Everything crew must still know about it after
 * the chat has ended or the daemon has restarted lives here, in crew's own state (the registered `chats/` entry of the
 * state home, which no worker can read or write):
 *
 *  - who owns it, the chat and the first proposal it came from, and the conversation cutoff;
 *  - the repositories it is grounded on (filed or Unfiled: a chat-made document is grounded on the chat's scope) and
 *    the stored code-graph binding;
 *  - the CANONICAL SOURCE PACKET: every file a run of it was given, by an immutable name, with its sha256. The bytes
 *    are kept here too, so each run's inbox gets a COPY (the writer can change its copy; the checker verifies it
 *    against the hashes crew holds, §5.3);
 *  - its ATTEMPTS: one per run id (the first create, and every Try again), each with the head it started from, when
 *    crew announced its draft, and its recorded outcome. The chat and the document stay busy until an attempt's
 *    outcome is recorded, not just until the engine run ends (§6.2), and the boot reconcile reads the attempts
 *    without an outcome.
 *
 * One JSON file per document (`<mount>__<doc>.json`, written atomically) and one directory of packet bytes beside it.
 * `__` cannot occur in a document name (`DOC_NAME`), so the split at the last `__` is unambiguous.
 */

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync, writeSync, constants as fsc } from 'node:fs';
import { join } from 'node:path';

import { ARTIFACT_REF } from '../api/chat-context.js';

/** One attempt at the document: a run, its starting head, and how it ended. */
export interface DocBindingAttempt {
  /** The proposal this attempt answers (`<chat>:<turn>` or `<chat>:retry:<runId>`). */
  pid: string;
  runId: string;
  /** Unix millis the attempt was recorded (before anything was created or launched). */
  at: number;
  /** The document's head when the attempt started (0: a new document's placeholder). */
  base: number;
  /** The run was handed to the engine (unix millis). */
  launchedAt?: number;
  /** Crew announced the draft (`draft.completed`) at this time: from here, only a landing or a refusal ends it. */
  emittedAt?: number;
  outcome?: { kind: 'landed'; version: number; at: number } | { kind: 'failed'; reason: string; at: number };
  /** The retry proposal crew appended for this failure, once it did. */
  retryPid?: string;
  /** A failure's publication (the run's `landing_failed` and the retry card) is done. Until it is, the boot reconcile
   *  publishes it again (both halves are idempotent), so a crash between the outcome and its publication loses nothing. */
  published?: boolean;
}

/** A repository the document is grounded on, as the chat's scope held it at Go. */
export interface BoundRepo {
  id: string;
  name: string;
  rootPath: string;
}

export interface DocBinding {
  /** `<mount>/<doc>`. */
  ref: string;
  mount: string;
  doc: string;
  /** The project it is filed in; `null` = Unfiled. */
  projectId: string | null;
  /** The person's actor id (the proposal's accepting actor). */
  owner: string;
  chatId: string;
  /** The chat's instance (its history nonce): a reused chat id is another chat, and the binding follows its own
   *  instance to the archive id a reuse moved it to. `null` = unknown. */
  chatInstance: string | null;
  /** The project the chat itself was filed in when the proposal was made (`null`: none). When it differs from
   *  {@link projectId} (an everything chat's document moved into a project), every attempt's packet is re-checked
   *  against the document's project. */
  scopeProject: string | null;
  /** The first proposal that made it. */
  proposalId: string;
  /** The turn the conversation snapshot is cut at (the first proposal's turn). */
  cutoffTurnId: string | null;
  repos: BoundRepo[];
  /** The code graph the draft gets (`LaunchRunInput.projectGraph.dbPath`); `null` = none. */
  graphDb: string | null;
  /** Canonical packet: file name → sha256 of its bytes (kept beside this record). */
  packet: Record<string, string>;
  /** Source token → the packet files it brought (a `chat` token brings its conversation and its briefs). */
  tokens: Record<string, string[]>;
  attempts: DocBindingAttempt[];
  createdAt: number;
}

/** A packet file name: a lowercase word, then id characters. Never a path. */
export const PACKET_NAME = /^(brief|conversation|message|run|doc|attachment|page|MANIFEST)-[A-Za-z0-9._-]{1,200}$/;

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** The file stem of a ref: `<mount>__<doc>`. */
export function refStem(ref: string): string | null {
  const m = ARTIFACT_REF.exec(ref);
  return m === null ? null : `${m[1]}__${m[2]}`;
}

export class DocBindingError extends Error {}

export class DocBindingStore {
  private readonly cache = new Map<string, DocBinding>();
  private loaded = false;

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  private file(ref: string): string {
    const stem = refStem(ref);
    if (stem === null) throw new DocBindingError(`not a document reference: ${ref.slice(0, 80)}`);
    return join(this.dir, `${stem}.json`);
  }

  /** The directory holding a document's canonical packet bytes. */
  packetDir(ref: string): string {
    const stem = refStem(ref);
    if (stem === null) throw new DocBindingError(`not a document reference: ${ref.slice(0, 80)}`);
    return join(this.dir, `${stem}.packet`);
  }

  private ensureDir(d: string): void {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const st = lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new DocBindingError(`refusing ${d}: not a real directory`);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const b = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as DocBinding;
        if (typeof b.ref === 'string' && refStem(b.ref) === name.slice(0, -5) && Array.isArray(b.attempts)) this.cache.set(b.ref, b);
      } catch {
        /* a torn or foreign file binds nothing */
      }
    }
  }

  private write(b: DocBinding): void {
    this.ensureDir(this.dir);
    const path = this.file(b.ref);
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(b, null, 1), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
    this.cache.set(b.ref, b);
  }

  get(ref: string): DocBinding | null {
    this.load();
    const b = this.cache.get(ref);
    return b === undefined ? null : structuredClone(b);
  }

  all(): DocBinding[] {
    this.load();
    return [...this.cache.values()].map((b) => structuredClone(b));
  }

  /** The document and attempt a run id belongs to. */
  attemptOf(runId: string): { binding: DocBinding; attempt: DocBindingAttempt } | null {
    this.load();
    for (const b of this.cache.values()) {
      const a = b.attempts.find((x) => x.runId === runId);
      if (a !== undefined) return { binding: structuredClone(b), attempt: { ...a } };
    }
    return null;
  }

  /** Whether a run id is a proposal-bound attempt (the boot resume sweep skips those). */
  isBound(runId: string): boolean {
    return this.attemptOf(runId) !== null;
  }

  /**
   * Record an attempt BEFORE anything is created or launched. The first attempt creates the binding from `init`; a
   * later one (Try again) is appended. Idempotent per run id: a retry of the same Go returns what is recorded.
   */
  begin(init: Omit<DocBinding, 'packet' | 'tokens' | 'attempts' | 'createdAt'>, attempt: { pid: string; runId: string; base: number }): DocBinding {
    this.load();
    const held = this.cache.get(init.ref);
    if (held !== undefined) {
      if (held.attempts.some((a) => a.runId === attempt.runId)) return structuredClone(held);
      const next: DocBinding = { ...structuredClone(held), attempts: [...held.attempts, { ...attempt, at: this.now() }] };
      this.write(next);
      return structuredClone(next);
    }
    const b: DocBinding = { ...init, packet: {}, tokens: {}, attempts: [{ ...attempt, at: this.now() }], createdAt: this.now() };
    this.write(b);
    return structuredClone(b);
  }

  private update(ref: string, runId: string, fn: (a: DocBindingAttempt) => boolean): boolean {
    this.load();
    const held = this.cache.get(ref);
    if (held === undefined) return false;
    const next = structuredClone(held);
    const a = next.attempts.find((x) => x.runId === runId);
    if (a === undefined || !fn(a)) return false;
    this.write(next);
    return true;
  }

  markLaunched(ref: string, runId: string): void {
    this.update(ref, runId, (a) => {
      if (a.launchedAt !== undefined) return false;
      a.launchedAt = this.now();
      return true;
    });
  }

  markEmitted(ref: string, runId: string): void {
    this.update(ref, runId, (a) => {
      if (a.emittedAt !== undefined) return false;
      a.emittedAt = this.now();
      return true;
    });
  }

  /** Record how an attempt ended. Only the FIRST outcome counts; `true` when this call recorded it. */
  setOutcome(ref: string, runId: string, outcome: { kind: 'landed'; version: number } | { kind: 'failed'; reason: string }): boolean {
    return this.update(ref, runId, (a) => {
      if (a.outcome !== undefined) return false;
      a.outcome = outcome.kind === 'landed' ? { kind: 'landed', version: outcome.version, at: this.now() } : { kind: 'failed', reason: outcome.reason, at: this.now() };
      return true;
    });
  }

  markPublished(ref: string, runId: string): void {
    this.update(ref, runId, (a) => {
      if (a.published === true) return false;
      a.published = true;
      return true;
    });
  }

  setRetry(ref: string, runId: string, retryPid: string): void {
    this.update(ref, runId, (a) => {
      if (a.retryPid !== undefined) return false;
      a.retryPid = retryPid;
      return true;
    });
  }

  /** An attempt that has no recorded outcome keeps the chat and the document busy (§6.2). */
  live(runId: string): boolean {
    const hit = this.attemptOf(runId);
    return hit !== null && hit.attempt.outcome === undefined;
  }

  /** Whether any attempt at the document is still without an outcome (the one-live-job-per-document rule). */
  busy(ref: string): DocBindingAttempt | null {
    this.load();
    const b = this.cache.get(ref);
    return b?.attempts.find((a) => a.outcome === undefined) ?? null;
  }

  /**
   * Add files to the canonical packet. A name is immutable: the same bytes again is a no-op, different bytes under a
   * held name is an error (§5.3). The bytes are written with an exclusive create, never through a link.
   */
  addPacket(ref: string, files: ReadonlyArray<{ name: string; bytes: Buffer }>, tokens: Record<string, string[]>): DocBinding {
    this.load();
    const held = this.cache.get(ref);
    if (held === undefined) throw new DocBindingError(`no binding for ${ref}`);
    const next = structuredClone(held);
    const dir = this.packetDir(ref);
    this.ensureDir(dir);
    for (const f of files) {
      if (!PACKET_NAME.test(f.name)) throw new DocBindingError(`refusing packet file name ${f.name.slice(0, 80)}`);
      const sum = sha256(f.bytes);
      const had = next.packet[f.name];
      if (had !== undefined) {
        if (had !== sum) throw new DocBindingError(`two different contents under one name: ${f.name}`);
        continue;
      }
      const path = join(dir, f.name);
      if (existsSync(path)) {
        // A crash after the bytes and before the record: the same bytes are adopted, different ones refused.
        if (sha256(readExact(path)) !== sum) throw new DocBindingError(`two different contents under one name: ${f.name}`);
      } else {
        const fd = openSync(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
        try {
          writeSync(fd, f.bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      next.packet[f.name] = sum;
    }
    for (const [token, names] of Object.entries(tokens)) next.tokens[token] = [...new Set([...(next.tokens[token] ?? []), ...names])];
    this.write(next);
    return structuredClone(next);
  }

  /** A canonical packet file's bytes, checked against the recorded hash. */
  packetBytes(ref: string, name: string): Buffer {
    const b = this.get(ref);
    const want = b?.packet[name];
    if (want === undefined || !PACKET_NAME.test(name)) throw new DocBindingError(`${name} is not in ${ref}'s packet`);
    const bytes = readExact(join(this.packetDir(ref), name));
    if (sha256(bytes) !== want) throw new DocBindingError(`${name} in ${ref}'s packet does not match its recorded hash`);
    return bytes;
  }
}

/** Read a regular file that is not a link. */
function readExact(path: string): Buffer {
  const fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
