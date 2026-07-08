import { WebSocket } from 'ws';

const clients: Set<WebSocket> = new Set();

export function registerClient(ws: WebSocket): void {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => { clients.delete(ws); ws.terminate(); });
}

export function broadcast(event: Record<string, unknown>): void {
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

// In-flight external emits, so a graceful shutdown can flush them before exit
// (fire-and-forget callers use `void emit(...)`; without this the trailing
// event's subprocess is killed on SIGTERM and never lands in the bus).
const pendingEmits = new Set<Promise<unknown>>();

/** Await all in-flight external bus emits (bounded), for graceful shutdown. */
export function flushPendingEmits(timeoutMs = 3000): Promise<unknown> {
  return Promise.race([
    Promise.allSettled([...pendingEmits]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// Fire-and-forget wicked-bus emit via dynamic import (optional dep).
// Set WICKED_CREW_BUS_DB to route events to an isolated bus DB (used by the
// evidence harness so runs are readable and don't pollute the shared bus).
// Set WICKED_CREW_DISABLE_BUS=1 to skip external emit entirely (WS broadcast
// still fires). The WebSocket broadcast above is the in-process event surface
// studio consumes; the external wicked-bus emit is the durable cross-tool bus.
export async function emit(type: string, payload: Record<string, unknown>): Promise<void> {
  const event = { type, payload, ts: new Date().toISOString() };
  broadcast(event);

  if (process.env['WICKED_CREW_DISABLE_BUS'] === '1') return;

  const work = (async () => {
    try {
      const { execa } = await import('execa');
      const busDb = process.env['WICKED_CREW_BUS_DB'];
      await execa('npx', [
        '--no-install', 'wicked-bus', 'emit',
        ...(busDb ? ['--db-path', busDb] : []),
        '--type', type,
        '--domain', 'wicked-crew',
        '--subdomain', 'crew',
        '--payload', JSON.stringify(payload),
      ], { reject: false, timeout: 3000 });
    } catch {
      // wicked-bus not installed or unavailable — not fatal
    }
  })();
  pendingEmits.add(work);
  void work.finally(() => pendingEmits.delete(work));
  await work;
}
