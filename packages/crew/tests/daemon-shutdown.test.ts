// crew#1835 — a daemon that stops mid-install stops the engine's install-time editor conformance harness too.
//
// The harness (Core.runEditorConformance) runs in its own process group, so neither the bridge reap nor the exit reached
// it: the jailed browser ran on until its deadline (up to 900 s). The engine's static Core.shutdownEditorConformance
// (wicked-core#1830) stops every call in flight; the daemon's SIGTERM/SIGINT path calls it before it exits, and the
// plain exit path calls it too.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { installDaemonShutdown } from '../src/core/shutdown.js';

function rig(core: { shutdownEditorConformance?: () => string }) {
  const proc = new EventEmitter();
  const order: string[] = [];
  let exited: () => void = () => undefined;
  const done = new Promise<void>((r) => { exited = r; });
  installDaemonShutdown({
    on: (event, fn) => { proc.on(event, fn); },
    core,
    reap: async () => { order.push('reap'); },
    sweepSync: () => { order.push('sweep'); },
    close: () => { order.push('close'); },
    exit: (code) => { order.push(`exit ${code}`); exited(); },
    onSignal: (signal) => { order.push(signal); },
  });
  return { proc, order, done };
}

describe('crew#1835 daemon shutdown stops the install-time conformance harness', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`on ${signal}, the engine's conformance shutdown runs before the exit, once`, async () => {
      // The stop records what had already happened when it ran: only the signal, so it ran before the reap and the exit.
      const seenAtStop: string[][] = [];
      const r = rig({ shutdownEditorConformance: () => { seenAtStop.push([...r.order]); return JSON.stringify({ stopped: 1, settled: true }); } });
      r.proc.emit(signal);
      r.proc.emit(signal); // a second signal while shutting down starts nothing new
      await r.done;
      expect(seenAtStop).toEqual([[signal]]);
      expect(r.order).toEqual([signal, 'reap', signal, 'close', 'exit 0']);
    });
  }

  it('the plain exit path stops it too, beside the synchronous bridge sweep', () => {
    let stops = 0;
    const { proc, order } = rig({ shutdownEditorConformance: () => { stops += 1; return '{"stopped":0,"settled":true}'; } });
    proc.emit('exit');
    expect(stops).toBe(1);
    expect(order).toEqual(['sweep']);
  });

  it('an engine without the binding, or one that throws, never blocks the exit', async () => {
    const old = rig({});
    old.proc.emit('SIGTERM');
    await old.done;
    expect(old.order).toEqual(['SIGTERM', 'reap', 'close', 'exit 0']);
    const throwing = rig({ shutdownEditorConformance: () => { throw new Error('boom'); } });
    throwing.proc.emit('SIGTERM');
    await throwing.done;
    expect(throwing.order).toEqual(['SIGTERM', 'reap', 'close', 'exit 0']);
    expect(() => throwing.proc.emit('exit')).not.toThrow();
  });
});
