/**
 * The system chat's HISTORY (DES-SYSTEM-CHAT "Crew" §1, api-types 0.137.0).
 *
 * A chat's live transcript (`chat-transcripts.ts`) lives as long as the chat. The history keeps it
 * after: every chat opened on this daemon gets an entry (`<state home>/chats/history/<id>.json`:
 * who opened it, where, which CLI, when, open or closed), and when the chat ends — Close, the
 * engine's idle or pool-cap close, a daemon restart — its transcript is COPIED beside the entry
 * (`<id>.jsonl`). Only `DELETE /chats/:id` removes an entry, with its transcript and attachments.
 *
 * Title, message count and last activity are DERIVED from the transcript when read (the live file
 * for an open chat, the kept copy for a closed one), never stored twice.
 *
 * A chat id is minted by the client and may be reused. Opening an id whose history is closed moves
 * the old entry to `<id>--<closedAt ms>` first, so a reuse never overwrites a past conversation.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ChatHistoryEntry, ChatStartedOn, ChatTranscriptRecord } from '../core/types.js';
import { crewStateHome } from '../projects/state-home.js';
import type { ChatAttachmentStore } from './chat-attachments.js';
import { CHAT_ID } from './chat-scope.js';

export const CHAT_HISTORY_DEFAULT_LIMIT = 20;
export const CHAT_HISTORY_MAX_LIMIT = 100;
const TITLE_MAX = 80;

export function defaultChatHistoryDir(): string {
  return join(crewStateHome(), 'chats', 'history');
}

/** What is stored per entry; the rest is derived from the transcript. */
interface StoredEntry {
  id: string;
  startedOn: ChatStartedOn | null;
  cli: string | null;
  createdAt: number;
  status: 'open' | 'closed';
  closedAt?: number;
  /** The opener's actor id (filters the list under `auth: required`). */
  actorId: string | null;
}

/** The transcript reader the history derives from (the live store). */
export interface TranscriptReader {
  /** `<dir>/<id>.jsonl` of the LIVE transcript, or null for a refused id. */
  pathOf(chatId: string): string | null;
}

/** The first operator message, whitespace-collapsed and cut at {@link TITLE_MAX} characters. */
export function titleOf(records: readonly ChatTranscriptRecord[]): string {
  const first = records.find((r) => r.kind === 'user');
  if (first === undefined || first.kind !== 'user') return 'New chat';
  const t = first.text.replace(/\s+/g, ' ').trim();
  if (t === '') return 'New chat';
  return t.length <= TITLE_MAX ? t : `${t.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

function readRecords(path: string): ChatTranscriptRecord[] {
  if (!existsSync(path)) return [];
  const out: ChatTranscriptRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as ChatTranscriptRecord);
    } catch {
      // a torn last line (a crash mid-append) costs that line only
    }
  }
  return out;
}

/** An opaque page cursor: the last item's `updatedAt` ms and id. */
function encodeCursor(updatedAt: number, id: string): string {
  return Buffer.from(JSON.stringify([updatedAt, id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { updatedAt: number; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'string') return { updatedAt: v[0], id: v[1] };
  } catch {
    /* fall through */
  }
  return null;
}

export class ChatHistoryStore {
  readonly dir: string;
  private readonly now: () => number;

  constructor(
    private readonly transcripts: TranscriptReader,
    private readonly attachments: ChatAttachmentStore | null,
    opts: { dir?: string; now?: () => number } = {},
  ) {
    this.dir = opts.dir ?? defaultChatHistoryDir();
    this.now = opts.now ?? Date.now;
  }

  private valid(id: string): boolean {
    return CHAT_ID.test(id) && id !== '.' && id !== '..';
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private keptPath(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(this.dir, 0o700);
  }

  private read(id: string): StoredEntry | null {
    if (!this.valid(id)) return null;
    try {
      return JSON.parse(readFileSync(this.metaPath(id), 'utf8')) as StoredEntry;
    } catch {
      return null;
    }
  }

  private write(e: StoredEntry): void {
    this.ensureDir();
    const tmp = `${this.metaPath(e.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 });
    renameSync(tmp, this.metaPath(e.id));
  }

  /** A chat was opened: a fresh entry. A CLOSED entry under the same id is kept under a new id. */
  opened(id: string, opts: { startedOn?: ChatStartedOn | undefined; cli: string | null; actorId: string | null }): void {
    if (!this.valid(id)) return;
    let prev = this.read(id);
    // An entry still `open` here is stale: this daemon only opens an id it does not hold, so that
    // chat ended without the close fold seeing it. Close it (keeping its transcript) first.
    if (prev !== null && prev.status === 'open') {
      this.closed(id);
      prev = this.read(id);
    }
    if (prev !== null) {
      const keptId = this.freeArchiveId(id, prev.closedAt ?? this.now());
      this.attachments?.rename(id, keptId);
      if (existsSync(this.keptPath(id))) renameSync(this.keptPath(id), this.keptPath(keptId));
      this.write({ ...prev, id: keptId });
      rmSync(this.metaPath(id), { force: true });
    }
    this.write({
      id,
      startedOn: opts.startedOn ?? null,
      cli: opts.cli,
      createdAt: this.now(),
      status: 'open',
      actorId: opts.actorId,
    });
  }

  /** An archive id for a reused chat id that names NOTHING yet — no entry, no kept transcript, no
   *  attachments (a client may have chosen `x--T` itself; it is never overwritten). */
  private freeArchiveId(id: string, closedAt: number): string {
    const base = `${id}--${closedAt}`;
    for (let n = 0; ; n += 1) {
      const candidate = n === 0 ? base : `${base}-${n}`;
      if (!existsSync(this.metaPath(candidate)) && !existsSync(this.keptPath(candidate)) && !(this.attachments?.exists(candidate) ?? false)) {
        return candidate;
      }
    }
  }

  /** The chat's answering CLI became known (the path's primary agent). */
  setCli(id: string, cli: string): void {
    const e = this.read(id);
    if (e !== null && e.cli !== cli) this.write({ ...e, cli });
  }

  /** The chat ended (any reason): keep its transcript. Idempotent; no entry ⇒ nothing (a chat this
   *  daemon never opened). */
  closed(id: string): void {
    const e = this.read(id);
    if (e === null || e.status === 'closed') return;
    const live = this.transcripts.pathOf(id);
    if (live !== null && existsSync(live)) {
      this.ensureDir();
      copyFileSync(live, this.keptPath(id));
      if (process.platform !== 'win32') chmodSync(this.keptPath(id), 0o600);
      // The copy keeps the conversation's own last-activity time (the list sorts on it), never the
      // moment of the close (xreview r1 on #1140).
      const st = statSync(live);
      utimesSync(this.keptPath(id), st.atime, st.mtime);
    }
    this.write({ ...e, status: 'closed', closedAt: this.now() });
  }

  /** `DELETE /chats/:id`: the entry, its kept transcript and its attachments go. */
  remove(id: string): void {
    if (!this.valid(id)) return;
    rmSync(this.metaPath(id), { force: true });
    rmSync(this.keptPath(id), { force: true });
    this.attachments?.removeChat(id);
  }

  /** Daemon boot: every entry still `open` belonged to the previous process — close it (keeping its
   *  transcript) BEFORE the live transcripts are cleared. */
  closeOrphaned(): number {
    if (!existsSync(this.dir)) return 0;
    let n = 0;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const e = this.read(f.slice(0, -5));
      if (e?.status === 'open') {
        this.closed(e.id);
        n += 1;
      }
    }
    return n;
  }

  /** The records of a chat: the live transcript while open, the kept copy once closed. */
  messages(id: string): ChatTranscriptRecord[] | null {
    const e = this.read(id);
    if (e === null) return null;
    return readRecords(this.sourceOf(e) ?? '');
  }

  private sourceOf(e: StoredEntry): string | null {
    if (e.status === 'closed') return this.keptPath(e.id);
    const live = this.transcripts.pathOf(e.id);
    return live;
  }

  private updatedAtOf(e: StoredEntry): number {
    const src = this.sourceOf(e);
    try {
      if (src !== null) return Math.max(e.createdAt, Math.floor(statSync(src).mtimeMs));
    } catch {
      /* no transcript yet */
    }
    return e.createdAt;
  }

  private view(e: StoredEntry, updatedAt: number, liveCli?: string | null, isLive?: (id: string) => boolean): ChatHistoryEntry {
    // An entry still marked open whose chat this daemon no longer holds ended without the close fold
    // seeing it (a route set without the fold): it reads closed, never a live chat that is not.
    const records = readRecords(this.sourceOf(e) ?? '');
    if (e.status === 'open' && isLive !== undefined && !isLive(e.id)) e = { ...e, status: 'closed' };
    return {
      id: e.id,
      title: titleOf(records),
      startedOn: e.startedOn,
      cli: liveCli ?? e.cli,
      createdAt: new Date(e.createdAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
      messageCount: records.filter((r) => r.kind === 'user' || r.kind === 'seat').length,
      attachmentCount: this.attachments?.count(e.id) ?? 0,
      status: e.status,
      ...(e.status === 'closed' && e.closedAt !== undefined ? { closedAt: new Date(e.closedAt).toISOString() } : {}),
    };
  }

  /** Whether `actorId` may see the entry: entries are per opener under `auth: required`
   *  (`actorId` null = local mode, everyone). An unknown id is nobody's. */
  visibleTo(id: string, actorId: string | null): boolean {
    const e = this.read(id);
    if (e === null) return false;
    return actorId === null || e.actorId === null || e.actorId === actorId;
  }

  /** One entry, or null. `liveCli`: the answering CLI the live path knows now. */
  entry(id: string, liveCli?: string | null, isLive?: (id: string) => boolean): ChatHistoryEntry | null {
    const e = this.read(id);
    return e === null ? null : this.view(e, this.updatedAtOf(e), liveCli, isLive);
  }

  /** A page of entries, newest activity first. */
  list(opts: {
    limit?: number;
    cursor?: string | null;
    status?: 'open' | 'closed' | 'all';
    actorId?: string | null;
    liveCli?: (id: string) => string | null;
    /** Whether the chat is held live by this daemon now. */
    isLive?: (id: string) => boolean;
  }): { items: ChatHistoryEntry[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(opts.limit ?? CHAT_HISTORY_DEFAULT_LIMIT, 1), CHAT_HISTORY_MAX_LIMIT);
    if (!existsSync(this.dir)) return { items: [], nextCursor: null };
    const after = opts.cursor ? decodeCursor(opts.cursor) : null;
    const all = readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.read(f.slice(0, -5)))
      .filter((e): e is StoredEntry => e !== null)
      // The EFFECTIVE status (an `open` entry whose chat is not live reads closed) is what filters.
      .map((e) => (e.status === 'open' && opts.isLive !== undefined && !opts.isLive(e.id) ? { ...e, status: 'closed' as const } : e))
      .filter((e) => opts.status === undefined || opts.status === 'all' || e.status === opts.status)
      .filter((e) => opts.actorId === undefined || opts.actorId === null || e.actorId === opts.actorId)
      .map((e) => ({ e, at: this.updatedAtOf(e) }))
      .sort((a, b) => b.at - a.at || b.e.id.localeCompare(a.e.id));
    const start = after === null ? 0 : all.findIndex((x) => x.at < after.updatedAt || (x.at === after.updatedAt && x.e.id.localeCompare(after.id) < 0));
    const page = start < 0 ? [] : all.slice(start, start + limit);
    const last = page[page.length - 1];
    const more = start >= 0 && start + limit < all.length;
    return {
      items: page.map(({ e, at }) => this.view(e, at, e.status === 'open' ? opts.liveCli?.(e.id) ?? null : null, opts.isLive)),
      nextCursor: more && last !== undefined ? encodeCursor(last.at, last.e.id) : null,
    };
  }
}
