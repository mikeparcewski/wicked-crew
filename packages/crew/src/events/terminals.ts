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
 */
export class TerminalHub {
  private readonly sockets = new Map<string, WebSocket>();
  /**
   * ids whose `terminalExited` we've already routed — so the WS close handler
   * skips a redundant `closeTerminal` (the engine already reaped that child).
   */
  private readonly exited = new Set<string>();

  /** Bind a browser socket to a terminal id (later `terminalOutput` fans out to it). */
  register(id: string, socket: WebSocket): void {
    this.sockets.set(id, socket);
  }

  /** True once a `terminalExited` frame has been routed for this id. */
  hasExited(id: string): boolean {
    return this.exited.has(id);
  }

  /** Drop the socket + exit bookkeeping for a terminal id. */
  unregister(id: string): void {
    this.sockets.delete(id);
    this.exited.delete(id);
  }

  /** Live terminal-socket count (diagnostics / tests). */
  size(): number {
    return this.sockets.size;
  }

  /**
   * Route one CoreEvent frame to the terminal socket it belongs to. Called for
   * EVERY core event; non-terminal frames and frames for an unknown id are no-ops.
   */
  route(event: CoreEvent): void {
    const id = typeof event.id === 'string' ? event.id : undefined;
    if (id === undefined) return;
    const socket = this.sockets.get(id);
    if (!socket) return;

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
    hub.register(id, ws);

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
