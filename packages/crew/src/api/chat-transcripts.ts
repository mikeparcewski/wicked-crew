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

import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { ChatAttachment, ChatCitationItem, ChatContextBinding, ChatTranscriptRecord, ChatUsage, CoreEvent, DecisionView } from '../core/types.js';
import { DecisionFenceFilter, splitDecisionsBlock, splitMakeBlocks } from '../decisions/chat-recorder.js';
import { crewStateHome } from '../projects/state-home.js';
import { CHAT_ID } from './chat-scope.js';

/** The state-home entry (`<state home>/chats/`) — the name the fixture registers. */
export const CHAT_TRANSCRIPTS_DIRNAME = 'chats';

// The host-path rewrite (crew#618, crew#634 R5) lives in `core/host-paths.ts` — dependency-free, so
// the deliver composer (crew#886) applies the same rewrite without importing this store.
export { rewriteHostPaths, withRootAliases, type ChatRepoRoot } from '../core/host-paths.js';
import { rewriteHostPaths, withRootAliases, type ChatRepoRoot } from '../core/host-paths.js';

/**
 * A2 (xreview r2): `'\n'` when the file's last byte is not one — a crash mid-append left a torn line, and the next
 * record must start on its own line rather than be swallowed into the torn one (readers skip a malformed line).
 */
export function tornTailPrefix(file: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return '';
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a ? '' : '\n';
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
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

/**
 * A2: host paths in a `wicked-make` block's string values, rewritten like the reply's — on the PARSED values, so the
 * JSON stays valid whatever a root's name holds and an escaped (Windows) path is matched as written. A body that is not
 * JSON is left as it is (the resolver refuses it anyway).
 */
function rewriteBlockPaths(body: string, roots: ReadonlyArray<ChatRepoRoot>): string {
  // Bounded: a block is a few levels deep (`theme.patch`), so anything deeper or larger is not one — it is left as it
  // is (the resolver refuses it), and nothing a seat writes can make this fold throw.
  if (body.length > 64 * 1024) return body;
  try {
    let nodes = 0;
    const walk = (v: unknown, depth: number): unknown => {
      nodes += 1;
      if (depth > 6 || nodes > 2000) throw new Error('not a block');
      return typeof v === 'string' ? rewriteHostPaths(v, roots)
        : Array.isArray(v) ? v.map((x) => walk(x, depth + 1))
          : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]))
            : v;
    };
    return JSON.stringify(walk(JSON.parse(body), 0));
  } catch {
    return body;
  }
}

export class ChatTranscriptStore {
  private readonly dir: string;
  private readonly now: () => number;
  /** Per-chat roots registered at open time, used to rewrite absolute host paths (crew#618). */
  private readonly chatRoots = new Map<string, ReadonlyArray<ChatRepoRoot>>();
  /** DC-S4b: the `chatDelta` fence filter (per chat + seat) — a `wicked-decisions` block never streams. */
  private readonly fence = new DecisionFenceFilter();
  /** DC-S4b: the block body cut from a seat's latest `chatReply`, until the recorder takes it. */
  private readonly blocks = new Map<string, string>();
  /** DES-CHAT-ARTIFACTS-001 §4.1 (A2): the `wicked-make` block bodies cut from a seat's latest `chatReply`, until the
   *  proposal resolver takes them. */
  private readonly makeBlocks = new Map<string, string[]>();

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
    // crew#634 R5: a seat citing the realpath / `/private` spelling of a root is rewritten too.
    this.chatRoots.set(chatId, withRootAliases(repos));
  }

  /** The directory this store writes under (diagnostics / tests). */
  get directory(): string {
    return this.dir;
  }

  /** The live transcript's path (the history copies it when the chat ends — `chat-history.ts`). */
  pathOf(chatId: string): string | null {
    return this.fileOf(chatId);
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
    appendFileSync(file, `${fresh ? '' : tornTailPrefix(file)}${JSON.stringify(record)}\n`, { mode: 0o600 });
    // `mode` applies on creation only; enforce on the first write and on the directory (mkdir's
    // `mode` is masked by the umask) — the transcript is the operator's conversation.
    if (process.platform !== 'win32') {
      if (fresh) chmodSync(file, 0o600);
      chmodSync(this.dir, 0o700);
    }
  }

  /** The operator's message a send delivered, with the seats the engine reached (the 202's `seats`). */
  appendUser(chatId: string, turnId: string, text: string, seats: readonly string[], attachments?: readonly ChatAttachment[], owner = false): void {
    this.append(chatId, {
      at: this.now(),
      turnId,
      kind: 'user',
      text,
      seats: [...seats],
      ...(attachments !== undefined && attachments.length > 0 ? { attachments: [...attachments] } : {}),
      // A2: the chat's owner, a person, sent it — only these words count as the person's for a proposal.
      ...(owner ? { owner: true as const } : {}),
    });
  }

  /**
   * DES-CHAT-ARTIFACTS-001 §5.1 (A1): what the turn's seats were given beside the operator's words — the open
   * artifact's copies, the run briefs, what was refused, and every run and document named in the chat so far.
   * Written with the turn's `user` record, so a later turn (and a later `message:` source) can name what it saw.
   */
  appendContext(chatId: string, turnId: string, binding: ChatContextBinding): void {
    this.append(chatId, { at: this.now(), turnId, kind: 'context', ...binding });
  }

  /** DC-S7: a crew-authored preface the seats received with that turn's message — disclosed, verbatim. */
  appendSystem(chatId: string, turnId: string, text: string): void {
    this.append(chatId, { at: this.now(), turnId, kind: 'system', text });
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

  /**
   * The citation verdicts of a reply already recorded (crew#561): appended as their OWN record,
   * because the transcript is append-only and verification finishes AFTER the reply is stored. A
   * reader folds it onto the `seat` record with the same `turnId` + `cliKey` — which is what keeps
   * a fabricated SHA marked across a reload, instead of rendering as plain text again.
   *
   * Only a STAMPED frame is recorded: without a `turn_id` there is no reply to fold it onto (the
   * same rule {@link observe} applies), and a straggler must never recreate a dropped file.
   */
  recordCitations(frame: {
    chat: string;
    cliKey: string;
    turn_id?: string;
    verified: number;
    unverifiable: number;
    corrected: number;
    unchecked: number;
    items: ChatCitationItem[];
  }): void {
    if (frame.turn_id === undefined) return;
    const file = this.fileOf(frame.chat);
    // No file ⇒ no reply was ever recorded for this chat (a reclaimed id, a refused chat id): a
    // citations record alone would recreate a transcript that has nothing to fold onto.
    if (file === null || !existsSync(file)) return;
    this.append(frame.chat, {
      at: this.now(),
      turnId: frame.turn_id,
      kind: 'citations',
      cliKey: frame.cliKey,
      verified: frame.verified,
      unverifiable: frame.unverifiable,
      corrected: frame.corrected,
      unchecked: frame.unchecked,
      items: frame.items,
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

  /**
   * Rewrite absolute host paths in a `chatReply` frame's `text` field, returning a NEW event
   * object when the text changed or the SAME object when not applicable (crew#618).
   *
   * Call BEFORE `observe` and `broadcast` so the live `/ws` frame already carries the
   * repo-relative form that studio renders and promotes from (Acceptance 1).
   */
  rewriteEvent(event: CoreEvent): CoreEvent {
    const frame = event as CoreEvent & Record<string, unknown>;
    const chatId = typeof frame['chat'] === 'string' ? frame['chat'] : undefined;
    const cliKey = typeof frame['cliKey'] === 'string' ? frame['cliKey'] : undefined;
    if (event.type === 'chatDelta') {
      // DC-S4b (review S4 / N8): the streamed reply never shows the block — a tail that could still
      // become the fence is held back, and from the fence on nothing streams until the reply.
      if (chatId === undefined || cliKey === undefined) return event;
      const rawText = typeof frame['text'] === 'string' ? frame['text'] : '';
      const text = this.fence.delta(chatId, cliKey, rawText);
      return text === rawText ? event : ({ ...(frame as unknown as CoreEvent), text } as CoreEvent);
    }
    if (event.type !== 'chatReply') return event;
    if (chatId === undefined) return event;
    const rawText = typeof frame['text'] === 'string' ? frame['text'] : '';
    let text = rawText;
    if (cliKey !== undefined) {
      // DC-S4b: the reply is the clean full text; the block is kept for the recorder (one take).
      this.fence.reset(chatId, cliKey);
      const split = splitDecisionsBlock(text);
      text = split.text;
      const key = `${chatId}\u0000${cliKey}`;
      if (split.block !== null) this.blocks.set(key, split.block);
      else this.blocks.delete(key);
      // A2: every `wicked-make` block goes too (the resolver takes the last one that parses); never shown, never stored.
      const made = splitMakeBlocks(text);
      text = made.text;
      // The block's words reach a card (and the transcript) too: host paths in them are rewritten like the reply's.
      const blockRoots = this.chatRoots.get(chatId);
      const bodies = blockRoots !== undefined && blockRoots.length > 0 ? made.blocks.map((b) => rewriteBlockPaths(b, blockRoots)) : made.blocks;
      if (bodies.length > 0) this.makeBlocks.set(key, bodies);
      else this.makeBlocks.delete(key);
    }
    const roots = this.chatRoots.get(chatId);
    if (roots !== undefined && roots.length > 0) text = rewriteHostPaths(text, roots);
    if (text === rawText) return event;
    return { ...(frame as unknown as CoreEvent), text } as CoreEvent;
  }

  /**
   * DC-S4b: the `wicked-decisions` block body {@link rewriteEvent} cut from this seat's latest reply,
   * handed over ONCE (a second call answers `null`). Call right after `rewriteEvent` for the reply.
   */
  takeDecisionsBlock(chatId: string, cliKey: string): string | null {
    const key = `${chatId}\u0000${cliKey}`;
    const block = this.blocks.get(key) ?? null;
    this.blocks.delete(key);
    return block;
  }

  /**
   * DES-CHAT-ARTIFACTS-001 §4.2 (A2): the `wicked-make` block bodies {@link rewriteEvent} cut from this seat's latest
   * reply, handed over ONCE (`[]` after). Call right after `rewriteEvent` for the reply.
   */
  takeMakeBlocks(chatId: string, cliKey: string): string[] {
    const key = `${chatId}\u0000${cliKey}`;
    const blocks = this.makeBlocks.get(key) ?? [];
    this.makeBlocks.delete(key);
    return blocks;
  }

  /**
   * DES-CHAT-ARTIFACTS-001 §4.2-§4.3 (A2): a proposal record (`proposal`, `proposal_accepting`, `proposal_decided`)
   * on a LIVE chat's transcript. Like `decisions`, a record alone never recreates a dropped file: `false` when there
   * is no transcript to append to (the caller then writes the kept history copy, `chat-history.ts`).
   */
  appendProposalRecord(chatId: string, record: ChatTranscriptRecord): boolean {
    const file = this.fileOf(chatId);
    if (file === null || !existsSync(file)) return false;
    this.append(chatId, record);
    return true;
  }

  /**
   * DC-S4b: the decisions recorded from one turn's operator message, appended as their OWN record
   * (the `citations` pattern: the transcript is append-only and derivation finishes after the
   * replies are stored). A reader folds it onto the turn's `user` record. Only a chat that has a
   * transcript gets one: a record alone must never recreate a dropped file.
   */
  recordDecisions(frame: { chat: string; turnId: string; items: DecisionView[] }): void {
    const file = this.fileOf(frame.chat);
    if (file === null || !existsSync(file)) return;
    this.append(frame.chat, { at: this.now(), turnId: frame.turnId, kind: 'decisions', items: frame.items });
  }

  /** The chat is gone (`chatClosed`, any reason): its transcript goes with it. */
  drop(chatId: string): void {
    this.chatRoots.delete(chatId);
    for (const key of [...this.blocks.keys()]) if (key.startsWith(`${chatId}\u0000`)) this.blocks.delete(key);
    for (const key of [...this.makeBlocks.keys()]) if (key.startsWith(`${chatId}\u0000`)) this.makeBlocks.delete(key);
    const file = this.fileOf(chatId);
    if (file !== null) rmSync(file, { force: true });
  }

  /**
   * Daemon boot: remove every transcript NOT in `retainedChatIds` (crew#619 — promoted-run
   * transcripts must survive a restart so Continue-in-Build prefill is reproducible). Pass an
   * empty set to clear everything.
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
}
