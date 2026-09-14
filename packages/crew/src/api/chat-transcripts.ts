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
 *  - the directory is CLEARED at daemon boot — no chat survives a restart (the engine's pool is in
 *    memory), so every file present at boot is an orphan;
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

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { ChatTranscriptRecord, ChatUsage, CoreEvent } from '../core/types.js';
import { crewStateHome } from '../projects/state-home.js';
import { CHAT_ID } from './chat-scope.js';

/** The state-home entry (`<state home>/chats/`) — the name the fixture registers. */
export const CHAT_TRANSCRIPTS_DIRNAME = 'chats';

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

  constructor(opts: { dir?: string; now?: () => number } = {}) {
    this.dir = opts.dir ?? defaultChatTranscriptsDir();
    this.now = opts.now ?? Date.now;
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
   */
  observe(stamped: CoreEvent): void {
    if (stamped.type !== 'chatReply') return;
    const frame = stamped as CoreEvent & Record<string, unknown>;
    const chatId = typeof frame['chat'] === 'string' ? frame['chat'] : undefined;
    const cliKey = typeof frame['cliKey'] === 'string' ? frame['cliKey'] : undefined;
    const turnId = typeof frame['turn_id'] === 'string' ? frame['turn_id'] : undefined;
    if (chatId === undefined || cliKey === undefined || turnId === undefined) return;
    this.append(chatId, {
      at: this.now(),
      turnId,
      kind: 'seat',
      cliKey,
      text: typeof frame['text'] === 'string' ? frame['text'] : '',
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
    const file = this.fileOf(chatId);
    if (file !== null) rmSync(file, { force: true });
  }

  /** Daemon boot: no chat survives a restart, so every file here is an orphan — remove them all. */
  clearAll(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
