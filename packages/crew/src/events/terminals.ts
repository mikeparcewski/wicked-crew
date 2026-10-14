import type { FastifyInstance } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import type { CoreAdapter } from '../core/adapter.js';
import type { CoreEvent } from '../core/types.js';

/**
 * Per-terminal WS fan-out (DES-TERMINAL-001 §6). The daemon's single CoreEvent
 * subscription is the source of truth; this hub routes the `terminalOutput` /
 * `terminalExited` frames for a given terminal id to the ONE browser socket that
 * opened it, keyed by id (a `Map<id, socket>`). Raw PTY output arrives
 * base64-encoded (`bytesB64`); we decode and send it as a BINARY frame so
 * xterm.js writes the exact bytes — control sequences and multi-byte UTF-8
 * survive a text-frame round-trip.
 *
 * Output a terminal writes BEFORE its browser socket attaches is held (bounded) and flushed on
 * attach: a login container prints its sign-in link and code the moment it starts, while the
 * browser opens `/ws/terminals/:id` only after the POST that created it returns — seconds later on
 * a loaded host — so without the hold the user would never see the link (wicked-core C6). A
 * terminal that exited (before or after a socket attached) closes any socket that attaches to it.
 */
/** Per-terminal bytes held for a socket that has not attached yet (the oldest are dropped). */
export const EARLY_OUTPUT_MAX_BYTES = 64 * 1024;
/** Terminals whose early output is held at once (an exited one's hold is dropped first). */
export const EARLY_OUTPUT_MAX_TERMINALS = 64;
/** Exited terminal ids remembered (insertion order, bounded; ids are never reused). */
export const REAPED_MEMORY = 8192;
/** How long a socket the engine has no terminal for stays open before it is closed: frames the
 *  engine emitted before the refusal may still be on their way through the event stream, and the
 *  terminal's own exit frame (delivered in order after its output) closes it sooner. */
export const GONE_GRACE_MS = 10_000;

/** Ids whose socket came and went, remembered (bounded) so their last frames are never held. */
const RETIRED_MEMORY = 1024;

/** Insert into a bounded insertion-ordered set, dropping the oldest entry past `cap`. */
function remember(set: Set<string>, id: string, cap: number): void {
  set.delete(id);
  set.add(id);
  if (set.size > cap) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

export class TerminalHub {
  private readonly sockets = new Map<string, WebSocket>();
  /** Output for ids no socket has attached to yet. */
  private readonly early = new Map<string, { chunks: Buffer[]; bytes: number }>();
  /** Ids whose `terminalExited` was seen (kept past their sockets: a later attach closes at once). */
  private readonly reaped = new Set<string>();
  /** Ids whose socket detached: nothing is held for them again. */
  private readonly retired = new Set<string>();
  /**
   * ids whose `terminalExited` we've already routed — so the WS close handler
   * skips a redundant `closeTerminal` (the engine already reaped that child).
   */
  private readonly exited = new Set<string>();

  /** Bind a browser socket to a terminal id (later `terminalOutput` fans out to it), first
   *  replaying what the terminal wrote before the socket attached; an exited terminal's socket
   *  is closed after the replay. */
  register(id: string, socket: WebSocket): void {
    this.sockets.set(id, socket);
    this.retired.delete(id);
    const held = this.early.get(id);
    this.early.delete(id);
    if (held !== undefined && socket.readyState === WebSocket.OPEN) {
      for (const chunk of held.chunks) socket.send(chunk);
    }
    if (this.reaped.has(id)) {
      this.exited.add(id);
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
  }

  /** Whether the hub remembers that terminal `id` exited. */
  knowsExited(id: string): boolean {
    return this.reaped.has(id);
  }

  /** Whether `socket` is the one bound to `id` now (a newer attach replaces an older one). */
  isCurrent(id: string, socket: WebSocket): boolean {
    return this.sockets.get(id) === socket;
  }

  /**
   * The engine holds no terminal `id` for `socket` (never opened, or reaped with its exit no
   * longer remembered). After [`GONE_GRACE_MS`] — time for frames already emitted to arrive and
   * be routed in order — the socket is closed if it is still open; the id's bookkeeping is
   * marked exited only if `socket` is still the bound one (a replaced socket owns nothing).
   */
  gone(id: string, socket: WebSocket, graceMs: number = GONE_GRACE_MS): void {
    const close = (): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (this.isCurrent(id, socket)) this.exited.add(id);
      socket.close();
    };
    if (graceMs <= 0) close();
    else setTimeout(close, graceMs).unref?.();
  }

  /** True once a `terminalExited` frame has been routed for this id. */
  hasExited(id: string): boolean {
    return this.exited.has(id);
  }

  /** Drop the socket + exit bookkeeping for a terminal id. */
  unregister(id: string): void {
    this.sockets.delete(id);
    this.exited.delete(id);
    this.early.delete(id);
    remember(this.retired, id, RETIRED_MEMORY);
  }

  /** Live terminal-socket count (diagnostics / tests). */
  size(): number {
    return this.sockets.size;
  }

  /** Terminals with output held for a socket that has not attached yet (diagnostics / tests). */
  heldCount(): number {
    return this.early.size;
  }

  /**
   * Route one CoreEvent frame to the terminal socket it belongs to. Called for
   * EVERY core event; non-terminal frames are no-ops, and a terminal frame for an id no socket
   * has attached to yet is held for it.
   */
  route(event: CoreEvent): void {
    const id = typeof event.id === 'string' ? event.id : undefined;
    if (id === undefined) return;
    if (event.type === 'terminalExited') remember(this.reaped, id, REAPED_MEMORY);
    const socket = this.sockets.get(id);
    if (!socket) {
      this.hold(id, event);
      return;
    }

    if (event.type === 'terminalOutput') {
      if (typeof event.bytesB64 === 'string' && socket.readyState === WebSocket.OPEN) {
        socket.send(Buffer.from(event.bytesB64, 'base64'));
      }
    } else if (event.type === 'terminalExited') {
      // The child is gone. Mark it (so the socket-close handler skips a redundant
      // closeTerminal), then close the browser socket so xterm stops cleanly.
      this.exited.add(id);
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
  }

  /** Hold a terminal's output for a socket that has not attached yet (bounded both ways). */
  private hold(id: string, event: CoreEvent): void {
    if (event.type !== 'terminalOutput' || typeof event.bytesB64 !== 'string') return;
    if (this.retired.has(id)) return;
    let held = this.early.get(id);
    if (held === undefined) {
      if (this.early.size >= EARLY_OUTPUT_MAX_TERMINALS) {
        // An exited terminal's hold goes first: a live one (a login printing its link) is the one
        // a browser is about to attach to.
        let victim: string | undefined;
        for (const key of this.early.keys()) {
          if (this.reaped.has(key)) {
            victim = key;
            break;
          }
        }
        victim ??= this.early.keys().next().value;
        if (victim !== undefined) this.early.delete(victim);
      }
      held = { chunks: [], bytes: 0 };
      this.early.set(id, held);
    }
    const whole = Buffer.from(event.bytesB64, 'base64');
    // One frame past the bound keeps only a COPY of its tail (agy c6-r1, codex c6-r6): a subarray
    // would keep the whole decoded frame alive behind 64 KiB of accounting.
    const chunk =
      whole.length > EARLY_OUTPUT_MAX_BYTES
        ? Buffer.from(whole.subarray(whole.length - EARLY_OUTPUT_MAX_BYTES))
        : whole;
    held.chunks.push(chunk);
    held.bytes += chunk.length;
    while (held.bytes > EARLY_OUTPUT_MAX_BYTES && held.chunks.length > 1) {
      held.bytes -= held.chunks.shift()?.length ?? 0;
    }
  }
}

/** Normalise a ws frame (Buffer | ArrayBuffer | Buffer[]) to a single Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/**
 * The per-terminal WS channel: `GET /ws/terminals/:id`. Binds the browser socket
 * to the terminal id in the hub (so `terminalOutput` for that id fans out to it),
 * forwards every inbound browser frame to the PTY as raw stdin bytes, and closes
 * the terminal when the socket drops (unless the PTY already exited on its own).
 */
export function registerTerminalWs(
  app: FastifyInstance,
  adapter: CoreAdapter,
  hub: TerminalHub,
): void {
  app.get('/ws/terminals/:id', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const ws = socket as unknown as WebSocket;
    // Liveness, unless the hub remembers the exit (register then closes at once; codex c6-r1/r3/r4):
    // an empty write is a no-op on a live terminal and refused for one the engine does not hold. A
    // refused socket is closed after a grace in which frames already emitted still arrive.
    const exitKnown = hub.knowsExited(id);
    hub.register(id, ws);
    if (!exitKnown) void adapter.writeTerminal(id, Buffer.alloc(0)).catch(() => hub.gone(id, ws));

    // Browser keystrokes (xterm.onData → ws.send): text or binary, both are raw
    // input bytes for the PTY. Failures (unknown/closed id) are swallowed — the
    // exit/close path tears the socket down.
    ws.on('message', (data: RawData) => {
      void adapter.writeTerminal(id, toBuffer(data)).catch(() => {
        /* terminal gone */
      });
    });

    let torn = false;
    const teardown = (): void => {
      if (torn) return;
      torn = true;
      // A socket a newer attach replaced owns nothing any more (codex c6-r2): unbinding or closing
      // here would strand the newer socket (its sign-in dialog open forever) or kill its terminal.
      if (!hub.isCurrent(id, ws)) return;
      const alreadyExited = hub.hasExited(id);
      hub.unregister(id);
      // Socket dropped by the browser (unmount) → close the PTY. Skip when the PTY
      // already exited (engine reaped it; a second closeTerminal would reject).
      if (!alreadyExited) {
        void adapter.closeTerminal(id).catch(() => {
          /* already closed / unknown id */
        });
      }
    };
    ws.on('close', teardown);
    ws.on('error', teardown);
  });
}
