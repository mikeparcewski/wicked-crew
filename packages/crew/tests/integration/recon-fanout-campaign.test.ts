// crew#390 + crew#391 end-to-end over the REAL stub engine: a 2-repo recon fan-out registers an
// ENGINE campaign (not a label-only fan), every sibling PAUSES at its intake gate before any
// unit runs, approving each gate over the standard run API resumes it, and the finished fan is
// served by GET /campaigns with real per-node stats — the exact surface the D3/D4 dogfood found
// dark (siblings launched `human_confirm: none`, dashboard empty).
//
// The engine is the stub build (deterministic workers, real actor/scheduler/gates), the repos
// are real git checkouts in scratch, and the whole flow rides /api/v1 — launch, gate reads,
// approvals, campaign reads — never the adapter directly (except repo registration, which skips
// the onboarding-run noise POST /repos would add).
//
// Requires an engine addon carrying the campaign bindings; SKIPS on one that predates them
// (the route unit suite pins the fallback fan for exactly that case).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { Campaign } from '../../src/core/types.js';

const require = createRequire(import.meta.url);
const { Core } = require('wicked-core-ts') as { Core: { prototype: Record<string, unknown> } };
const supported = typeof Core.prototype['launchCampaign'] === 'function';

let scratch: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl = '';
const savedEnv: Record<string, string | undefined> = {};

/** Init a one-commit git repo (worktree material for the sibling runs). */
function makeRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), '# scratch\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  git('add', '.');
  git(
    '-c', 'user.email=test@example.invalid',
    '-c', 'user.name=recon-fanout-test',
    'commit', '-q', '-m', 'init',
  );
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/v1${path}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Poll until `check` returns truthy or the deadline hits (returns the last value either way). */
async function until<T>(check: () => Promise<T | null>, ms = 60_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last !== null) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

beforeAll(async () => {
  if (!supported) return;
  scratch = mkdtempSync(join(tmpdir(), 'recon-fanout-'));

  // Lane isolation (the campaign-dag.test.ts idiom): the engine's side-channels stay in scratch.
  for (const key of ['WICKED_ESTATE_DB', 'WICKED_ESTATE_REPO_GRAPH_ROOT', 'WICKED_CREW_PROJECT_GRAPH_ROOT']) {
    savedEnv[key] = process.env[key];
  }
  process.env['WICKED_ESTATE_DB'] = join(scratch, 'estate-emit.db');
  process.env['WICKED_ESTATE_REPO_GRAPH_ROOT'] = join(scratch, 'repo-graphs');
  process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'] = join(scratch, 'project-graphs');

  makeRepo(join(scratch, 'repos', 'alpha'));
  makeRepo(join(scratch, 'repos', 'beta'));

  adapter = new CoreAdapter({ dbPath: join(scratch, 'core.db'), stub: true });
  await adapter.registerRepo('alpha', join(scratch, 'repos', 'alpha'));
  await adapter.registerRepo('beta', join(scratch, 'repos', 'beta'));

  app = await createServer(adapter, { auditPath: join(scratch, 'audit.log') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 120_000);

afterAll(async () => {
  if (!supported) return;
  await app.close();
  adapter.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!supported)('recon fan-out as an engine campaign (crew#390/#391)', () => {
  it(
    '2-repo fan → two intake gates → approve both over the run API → GET /campaigns serves the stats',
    async () => {
      // ── Launch ────────────────────────────────────────────────────────────────
      const launch = await api('/testing/recon', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ problem: 'inventory the API surface', repoRefs: ['alpha', 'beta'] }),
      });
      expect(launch.status).toBe(201);
      expect(launch.body['campaignRegistered']).toBe(true);
      const campaign = launch.body['campaign'] as string;
      const runIds = launch.body['runIds'] as string[];
      expect(runIds).toEqual([`${campaign}:alpha:a0`, `${campaign}:beta:a0`]);

      // ── Both siblings pause at their intake gates (nothing runs unattended) ──
      const gated = await until(async () => {
        const res = await api(`/campaigns/${encodeURIComponent(campaign)}`);
        if (res.status !== 200) return null;
        const c = res.body['campaign'] as unknown as Campaign;
        const statuses = Object.values(c.node_status);
        return statuses.length === 2 && statuses.every((s) => s === 'awaiting_human') ? c : null;
      });
      expect(gated, 'both siblings should reach awaiting_human (the intake gate)').not.toBeNull();

      // Each gate is readable over the standard gate surface — the studio's gate card wire.
      for (const runId of runIds) {
        const gate = await api(`/runs/${encodeURIComponent(runId)}/gate`);
        expect(gate.status, `open intake gate for ${runId}`).toBe(200);
        expect(typeof gate.body['prompt']).toBe('string');
      }

      // ── Approve both over the standard run API (a resume of a gated run IS approval) ──
      for (const runId of runIds) {
        const resumed = await api(`/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' });
        expect(resumed.status, `gate approval for ${runId}`).toBe(200);
      }

      // ── The fan runs to terminal and the campaign reports it ──────────────────
      const done = await until(async () => {
        const res = await api(`/campaigns/${encodeURIComponent(campaign)}`);
        if (res.status !== 200) return null;
        const c = res.body['campaign'] as unknown as Campaign;
        const statuses = Object.values(c.node_status);
        return statuses.length === 2 && statuses.every((s) => s === 'completed') ? c : null;
      });
      expect(done, 'both siblings should complete after approval').not.toBeNull();
      expect(done!.status).toBe('completed');

      // ── crew#390's headline: the fan is VISIBLE on GET /campaigns, with real stats ──
      const list = await api('/campaigns');
      expect(list.status).toBe(200);
      const listed = (list.body['campaigns'] as Campaign[]).find((c) => c.id === campaign);
      expect(listed, 'the recon fan must appear on GET /campaigns').toBeDefined();
      expect(listed!.def.nodes).toHaveLength(2);
      expect(Object.values(listed!.node_status)).toEqual(['completed', 'completed']);
      expect(listed!.node_run_id).toEqual({
        alpha: `${campaign}:alpha:a0`,
        beta: `${campaign}:beta:a0`,
      });
    },
    120_000,
  );
});
