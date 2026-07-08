// Clean-exit proof for the daemon bridge (DES-STUDIO-001: "ensure the process
// exits cleanly"). Boots the daemon in-process against the STUB engine, drives
// launch → gate → complete over HTTP, opens+closes a WS client, then tears down
// (ws.close + app.close + adapter.close) and RETURNS FROM main WITHOUT
// process.exit(). If the adapter's Subscription.close() released the core-ts pump
// thread (unref'd tsfn), the process exits on its own; if a handle leaked, the
// watchdog below fails it. Mirrors core-ts smoke-lifecycle SIG-2, but through the
// daemon's Fastify + ws stack.
//
// Run: WICKED_MEMORY_EMBEDDER=hash node scripts/verify-clean-exit.mjs
process.env.WICKED_MEMORY_EMBEDDER = 'hash';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CoreAdapter } from '../dist/core/adapter.js';
import { createServer } from '../dist/api/server.js';

const watchdog = setTimeout(() => {
  console.error('\n[clean-exit] FAIL ❌ — process did not exit on its own within 10s (leaked handle)');
  process.exit(1);
}, 10000);
watchdog.unref(); // do NOT keep the loop alive; we WANT the process to exit by itself

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-clean-exit-'));
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });

  const completed = new Promise((resolve) => {
    adapter.onEvent((e) => {
      if (e.type === 'sessionCompleted') resolve();
    });
  });

  const app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}/api/v1`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

  const clis = JSON.stringify([
    { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
    { key: 'beta', display_name: 'Beta', binary: 'beta', headless_invocation: 'beta {PROMPT}' },
  ]);

  const launch = await fetch(`${base}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ problem: 'Do step one. Do step two', sessionId: 'ce-1', clisJson: clis, humanConfirm: 'before:1' }),
  });
  if (launch.status !== 201) throw new Error(`launch failed: ${launch.status}`);

  // Poll until the run is paused at the gate, then approve over HTTP.
  for (let i = 0; i < 100; i++) {
    const g = await fetch(`${base}/runs/ce-1/gate`);
    if (g.status === 200) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const gate = await fetch(`${base}/runs/ce-1/gate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: true }),
  });
  if (gate.status !== 200) throw new Error(`gate failed: ${gate.status}`);

  await completed;
  console.log('[clean-exit] ✓ launch → gate → sessionCompleted through the daemon');

  // Tear down and return WITHOUT process.exit — the process must now end on its own.
  ws.close();
  await app.close();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
  clearTimeout(watchdog);
  console.log('[clean-exit] ✓ torn down; returning from main WITHOUT process.exit — expecting self-exit');
}

main().catch((e) => { console.error(`[clean-exit] FAIL ❌ — ${e.stack || e}`); process.exit(1); });
