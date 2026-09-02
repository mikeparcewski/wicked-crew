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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { Campaign } from '../../src/core/types.js';

const require = createRequire(import.meta.url);
const { Core } = require('wicked-core-ts') as { Core: { prototype: Record<string, unknown> } };
// The campaign path is platform-independent on the ^0.7.8 floor (crew#415): the engine sanitizes
// its own worktree names, so the paths are NTFS-safe and win32 no longer falls back to a per-run fan.
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

/** A worktree's admin dir, the way the engine derives it (wicked-core `repo.rs`
 *  `worktree_admin_dir`) — `rev-parse` from inside the tree, never a hand-parsed `.git` file. */
function adminDir(wt: string): string {
  return execFileSync('git', ['-C', wt, 'rev-parse', '--absolute-git-dir'], { stdio: 'pipe' })
    .toString()
    .trim();
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

      // ── crew#415: the trees are the ENGINE's, minted natively — no crew pre-provisioning ──
      // Sampled HERE, with both siblings parked at their intake gate. The engine resolves the
      // workdir at LAUNCH (wicked-core actor.rs `resolve_workdir`, before the gate pause), so the
      // trees already exist; after completion a clean tree may be reaped, so this is the only
      // window that is both correct and stable.
      for (const repo of ['alpha', 'beta'] as const) {
        const runId = `${campaign}:${repo}:a0`;
        const repoRoot = join(scratch, 'repos', repo);
        // The campaign label is `[a-z0-9-]` and node ids are repo names, so ':' is the run id's
        // ONLY illegal char — the engine's sanitizer takes its hashless colon tier and the name
        // is exactly what crew's deleted `branchSafe()` used to spell. Pin the id SHAPE, or a
        // future id change would silently move the engine to its hash-suffixed tier and leave
        // these path expectations quietly wrong.
        expect(runId).toMatch(/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)+$/);
        const sanitized = runId.replaceAll(':', '-');

        // The engine minted at its SANITIZED path …
        const engineTree = join(repoRoot, 'wicked-worktrees', sanitized);
        expect(existsSync(engineTree), `engine-native worktree for ${runId}`).toBe(true);
        // … and the RAW path — the one crew's deleted pre-provisioning produced — is ABSENT.
        // That absence is the actual proof this run went through the engine-native path: mere
        // existence would also pass if crew still pre-provisioned, because the engine ADOPTS.
        expect(
          existsSync(join(repoRoot, 'wicked-worktrees', runId)),
          `no crew-pre-provisioned tree for ${runId}`,
        ).toBe(false);
        // The ownership marker is the engine's signature: crew's workaround never wrote one.
        expect(readFileSync(join(adminDir(engineTree), 'wicked-run-id'), 'utf8').trim()).toBe(runId);
        // And the branch carries the engine's one spelling.
        const listed = execFileSync(
          'git', ['-C', repoRoot, 'branch', '--list', `wicked/${sanitized}`], { stdio: 'pipe' },
        ).toString().trim();
        expect(listed, `wicked/${sanitized} branch`).not.toBe('');
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

  // crew#415's third removal check: `POST /campaigns` NEVER carried the pre-provisioning
  // workaround, so on the ^0.7.8 floor a repo-scoped node must provision engine-natively on its
  // own. That path had no real-engine coverage at all (campaign-dag.test.ts runs repo-LESS
  // nodes), so the claim "both campaign entry points behave identically" was reasoned, not
  // tested — this closes it.
  //
  // The assertion is the BRANCH, not the tree: this campaign is UNGATED, so there is no stable
  // pause to sample the filesystem in, and a terminal run's clean worktree may be reaped. The
  // branch is the durable artifact — `reap_worktree_if_clean` never touches it — and it can only
  // exist because `git worktree add -b wicked/<sanitized>` created it.
  it(
    'a repo-scoped POST /campaigns node provisions engine-natively too — no crew pre-provisioning',
    async () => {
      const campaign = 'crew415-direct';
      const launch = await api('/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: campaign,
          scenarios: [{ id: 'survey', agent: { problem: 'inventory the API surface' } }],
          repoRefs: ['alpha'],
        }),
      });
      expect(launch.status, `POST /campaigns → ${JSON.stringify(launch.body)}`).toBe(201);

      // One repo ⇒ the node id keeps the scenario's own spelling, so the run id is deterministic.
      const runId = `${campaign}:survey:a0`;
      const sanitized = runId.replaceAll(':', '-');
      const repoRoot = join(scratch, 'repos', 'alpha');

      // Poll for the branch rather than a node status: worktree creation happens at LAUNCH, so
      // this proves provisioning independently of whether the stub node then passes or fails.
      const branch = await until(async () => {
        const listed = execFileSync(
          'git', ['-C', repoRoot, 'branch', '--list', `wicked/${sanitized}`], { stdio: 'pipe' },
        ).toString().trim();
        return listed === '' ? null : listed;
      });
      expect(branch, `the engine must mint wicked/${sanitized} for the repo-scoped node`).not.toBeNull();

      // And crew minted nothing of its own at the raw, colon-carrying spelling.
      expect(
        existsSync(join(repoRoot, 'wicked-worktrees', runId)),
        `no crew-pre-provisioned tree for ${runId}`,
      ).toBe(false);
    },
    120_000,
  );
});
