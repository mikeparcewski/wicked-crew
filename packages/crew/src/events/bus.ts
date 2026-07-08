import { WebSocket } from 'ws';
import type { CoreEvent } from '../core/types.js';

// The daemon's WS fan-out surface. The adapter's single CoreEvent subscription
// pushes every parsed frame through `broadcast()` to all connected browser
// sockets, verbatim (the tagged-JSON `{ type, ...fields }` shape — additive-safe;
// DES-STUDIO-001 §2.1). No `{ type, payload, ts }` envelope: the studio switches
// directly on the CoreEvent discriminant.

const clients: Set<WebSocket> = new Set();

export function registerClient(ws: WebSocket): void {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => {
    clients.delete(ws);
    ws.terminate();
  });
}

/** Fan one CoreEvent frame out to every connected client, verbatim. */
export function broadcast(event: CoreEvent): void {
  const msg = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) {
      clients.delete(client);
      continue;
    }
    client.send(msg, (err?: Error) => {
      if (err) {
        clients.delete(client);
        client.terminate();
      }
    });
  }
}

/** Current live client count (diagnostics / tests). */
export function clientCount(): number {
  return clients.size;
}

/** Close every client socket and clear the set (graceful shutdown). */
export function closeAllClients(): void {
  for (const client of clients) {
    try {
      client.close();
    } catch {
      /* already closing */
    }
  }
  clients.clear();
}
