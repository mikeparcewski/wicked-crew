import { setTimeout as sleep } from 'node:timers/promises';

import { EstateMcpError } from '../core/estate-mcp-client.js';
import { Semaphore } from '../mcp/estate-relay.js';

// Each call spawns a writer process. Sources and trackers must share one lane per daemon (crew#1524).
const writer = new Semaphore(1);
const LOCK_RETRY_DELAYS_MS = [250, 1_000, 3_000];

/**
 * (crew#1741) Run one other estate call (a read that spawns its own process) on the same single lane as the writes, so
 * a boot's confirmation reads never start a process per source at once, nor overlap a write.
 */
export function onEstateLane<T>(fn: () => Promise<T>): Promise<T> {
  return writer.run(fn);
}

/** Retry only SQLite contention refusals: estate committed nothing, so the same generation is safe to resend. */
export function replaceSource(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  args: Record<string, unknown>,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<unknown> {
  return writer.run(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call('knowledge.replace_source', args);
      } catch (err) {
        const delay = LOCK_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !(err instanceof EstateMcpError) || err.refusal === undefined || !/database is (?:locked|busy)/i.test(err.refusal)) throw err;
        await (opts.sleep ?? sleep)(delay);
      }
    }
  });
}
