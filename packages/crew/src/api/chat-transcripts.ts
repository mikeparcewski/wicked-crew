/**
 * The chat transcript AT REST (DES-L5 §5-d; D-13 / BC-33; F-RC1-112 = F-RECON-018, crew#503).
 *
 * The engine keeps a chat's warm seats and their conversation memory, but no transcript: every
 * `chatDelta` / `chatReply` is seen exactly once, on `/ws`, by whoever is connected at that moment.
 * P6 reproduced the consequence — a reload (or a second tab) of a LIVE chat rendered a blank thread,
 * and the reply nobody was watching for was simply gone. The daemon sees every frame once too, at
 * the ONE hook that already stamps `turn_id` (`server.ts` → `chatTurns.decorate`), so the record is
 * written there: one append-only JSONL file per chat under the state home, served back on
 * `GET /chats/:id` as `messages` (api-types 0.38.0 `ChatTranscriptRecord`, append order).
 *
 * Retention = the chat's LIFETIME (D-13, as designed — no age sweep, no second mechanism):
 *  - the file is DROPPED on the engine's `chatClosed` (requested, idle and pool_cap alike — the one
 *    arm `server.ts` already folds for the scope index);
 *  - the directory is CLEARED at daemon boot (orphaned files), EXCEPT transcripts held for a
 *    promoted run that is still non-terminal — those are preserved so Continue-in-Build prefill
 *    remains reproducible across a daemon restart (crew#619);
 *  - only frames a live turn STAMPED (`turn_id` present) are persisted, so a straggler `chatReply`
 *    after the close cannot recreate a file, and `turnId` is never null on a record.
 *
 * Privacy posture: the directory is 0700 and each file 0600 (the transcript is the operator's
 * conversation); the file name is the chat id, admitted by the SAME guard the scratch root applies
 * (`CHAT_ID` — one sanitizer, no second regex), so an arbitrary `GET /chats/:id` can never name a
 * path. `messages` is unbounded — a reply may be up to the engine's 8 MB cap (wave 1, noted).
 *
 * Registered in `tests/fixtures/state-home-subtrees.json` as `chats` (crew half; the core half —
 * the worker Read fence — landed with core-ts 0.7.26), and named in `state-home-registry.ts`.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';

import type { ChatTranscriptRecord, ChatUsage, CoreEvent } from '../core/types.js';
import { crewStateHome } from '../projects/state-home.js';
import { CHAT_ID } from './chat-scope.js';

/** The state-home entry (`<state home>/chats/`) — the name the fixture registers. */
export const CHAT_TRANSCRIPTS_DIRNAME = 'chats';

/** One repo root → name mapping entry used for path rewriting (crew#618). */
export interface ChatRepoRoot {
  /** Resolved absolute path of the repo root (from `EngineChatScope.readRoots`). */
  absRoot: string;
  /** The repo's display name, used as the path prefix in rewritten citations. */
  name: string;
}

/**
 * Rewrite absolute host paths in seat reply text to repo-relative form (crew#618).
 *
 * `/srv/repos/alpha/src/foo.ts` → `alpha/src/foo.ts` when `alpha`'s root is `/srv/repos/alpha`.
 * Longest roots are matched first so a path under a more-specific root is never truncated by a
 * parent root. Pure string substitution: no regex, no parsing — LLM-generated paths rarely use
 * special characters in the path components themselves.
 */
export function rewriteHostPaths(text: string, roots: ReadonlyArray<ChatRepoRoot>): string {
  if (roots.length === 0) return text;
  const sorted = [...roots].sort((a, b) => b.absRoot.length - a.absRoot.length);
  let result = text;
  for (const { absRoot, name } of sorted) {
    const prefix = absRoot.endsWith(sep) || absRoot.endsWith('/') ? absRoot : `${absRoot}/`;
    // Replace all occurrences of the absolute prefix with the repo-name prefix.
    result = result.split(prefix).join(`${name}/`);
    // Also handle the path spelling with the other separator (LLMs on Windows may use '/').
    if (sep === '\\') {
      const fwdPrefix = prefix.replace(/\\/g, '/');
      result = result.split(fwdPrefix).join(`${name}/`);
    }
  }
  return result;
}

/** Where the transcripts live: under the daemon's state home, like every other crew store. */
export function defaultChatTranscriptsDir(): string {
  return join(crewStateHome(), 'chats');
}

/** The `usage` a `chatReply` may carry (core-ts ≥ 0.7.26): the engine's `Usage`, or `null`. */
function usageOf(value: unknown): ChatUsage | null {
  if (value === null || typeof value !== 'object') return null;
  const u = value as Record<string, unknown>;
  const num = (k: string): number => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : 0);
  return {
    inputTokens: num('inputTokens'),
    outputTokens: num('outputTokens'),
    cacheReadTokens: num('cacheReadTokens'),
    cacheCreationTokens: num('cacheCreationTokens'),
    costUsd: typeof u['costUsd'] === 'number' && Number.isFinite(u['costUsd']) ? (u['costUsd'] as number) : null,
  };
}

export class ChatTranscriptStore {
  private readonly dir: string;
  private readonly now: () => number;
  /** Per-chat roots registered at open time, used to rewrite absolute host paths (crew#618). */
  private readonly chatRoots = new Map<string, ReadonlyArray<ChatRepoRoot>>();

  constructor(opts: { dir?: string; now?: () => number } = {}) {
    this.dir = opts.dir ?? defaultChatTranscriptsDir();
    this.now = opts.now ?? Date.now;
  }

  /**
   * Register the repo roots for a chat so that absolute host paths in seat replies are rewritten
   * to repo-relative form before being stored (crew#618). Must be called at chat open time, after
   * `ChatScopeIndex.set()` confirms the chat is live. Idempotent: a second call for the same
   * `chatId` replaces the previous roots.
   */
  registerRoots(chatId: string, repos: ReadonlyArray<ChatRepoRoot>): void {
    this.chatRoots.set(chatId, repos);
  }

  /** The directory this store writes under (diagnostics / tests). */
  get directory(): string {
    return this.dir;
  }

  /** `<dir>/<chatId>.jsonl` — or `null` for an id the chat-id guard refuses (never a path). */
  private fileOf(chatId: string): string | null {
    return CHAT_ID.test(chatId) ? join(this.dir, `${chatId}.jsonl`) : null;
  }

  private append(chatId: string, record: ChatTranscriptRecord): void {
    const file = this.fileOf(chatId);
    if (file === null) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const fresh = !existsSync(file);
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    // `mode` applies on creation only; enforce on the first write and on the directory (mkdir's
    // `mode` is masked by the umask) — the transcript is the operator's conversation.
    if (process.platform !== 'win32') {
      if (fresh) chmodSync(file, 0o600);
      chmodSync(this.dir, 0o700);
    }
  }

  /** The operator's message a send delivered, with the seats the engine reached (the 202's `seats`). */
  appendUser(chatId: string, turnId: string, text: string, seats: readonly string[]): void {
    this.append(chatId, { at: this.now(), turnId, kind: 'user', text, seats: [...seats] });
  }

  /**
   * Fold one STAMPED frame (call with `chatTurns.decorate(event)`'s result): a seat's `chatReply`
   * carrying `turn_id` becomes a `seat` record — ok or not (an eviction's `ok: false` text names the
   * budget). Every other frame, and a reply no live turn stamped, is ignored.
   *
   * Absolute host paths in the reply text are rewritten to repo-relative form (crew#618) using the
   * roots registered for the chat via {@link registerRoots}.
   */
  observe(stamped: CoreEvent): void {
    if (stamped.type !== 'chatReply') return;
    const frame = stamped as CoreEvent & Record<string, unknown>;
    const chatId = typeof frame['chat'] === 'string' ? frame['chat'] : undefined;
    const cliKey = typeof frame['cliKey'] === 'string' ? frame['cliKey'] : undefined;
    const turnId = typeof frame['turn_id'] === 'string' ? frame['turn_id'] : undefined;
    if (chatId === undefined || cliKey === undefined || turnId === undefined) return;
    const rawText = typeof frame['text'] === 'string' ? frame['text'] : '';
    const roots = this.chatRoots.get(chatId);
    const text = roots !== undefined && roots.length > 0 ? rewriteHostPaths(rawText, roots) : rawText;
    this.append(chatId, {
      at: this.now(),
      turnId,
      kind: 'seat',
      cliKey,
      text,
      ok: frame['ok'] === true,
      usage: usageOf(frame['usage']),
    });
  }

  /** Every record of the chat in append order; `[]` for a chat with no file (or a refused id). */
  read(chatId: string): ChatTranscriptRecord[] {
    const file = this.fileOf(chatId);
    if (file === null || !existsSync(file)) return [];
    const out: ChatTranscriptRecord[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as ChatTranscriptRecord);
      } catch {
        // A torn last line (a crash mid-append) is not a reason to lose the rest of the record.
      }
    }
    return out;
  }

  /** The chat is gone (`chatClosed`, any reason): its transcript goes with it. */
  drop(chatId: string): void {
    this.chatRoots.delete(chatId);
    const file = this.fileOf(chatId);
    if (file !== null) rmSync(file, { force: true });
  }

  /**
   * Daemon boot: remove every transcript NOT in `retainedChatIds` (crew#619 — promoted-run
   * transcripts must survive a restart so Continue-in-Build prefill is reproducible). Pass an
   * empty set to clear everything (equivalent to the old `clearAll`).
   */
  clearOrphaned(retainedChatIds: ReadonlySet<string>): void {
    if (!existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const chatId = file.slice(0, -6);
      if (!retainedChatIds.has(chatId)) {
        rmSync(join(this.dir, file), { force: true });
      }
    }
  }

  /** Daemon boot: no chat survives a restart, so every file here is an orphan — remove them all. */
  clearAll(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
