// F-E2E-011 (crew half): the seeded `onboarding` workflow, launched through the SAME path the
// studio's "Register & onboard" uses (`POST /repos`), against the REAL engine addon.
//
// crew#533 (F-2R2-010) made `seatsForWorkflow('onboarding')` return `[]` — a workflow whose every
// phase is a TOOL executor convenes no council — and pinned that with a unit test over a STUBBED
// launch. Nothing ever handed the seeded def plus `clis: []` to the engine, so the composition with
// wicked-core's plan-time seat check (`distribute_units_against_benched`, F-7R2-006/#449 — "no
// eligible seat … every configured seat is benched") shipped unseen: on crew 0.7.31 + core-ts 0.7.22
// every onboarding run failed ~1 s after launch, before a single unit executed, on every repo.
//
// This test closes that gap by driving the real thing: a scratch git repo is registered over
// `POST /repos`, the daemon launches onboarding with the seat pool it hands the engine in
// production (none), and the run must get PAST distribution to its first tool unit — the refusal
// above must not appear, `index` must actually be dispatched. A `wicked-estate` shim on PATH
// (temp dir, argv logged) stands in for the estate binary so the outcome does not depend on what
// the host has installed; CI has none. `seatsForWorkflow()` is deliberately NOT weakened here —
// the seat pool stays `[]` (F-2R2-010 stays fixed) and the engine is expected to route tool units
// without a seat (wicked-core F-E2E-011 fix). Until that engine change is in the addon CI builds,
// this file is RED — that is the finding, reproduced.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { RecordedEvent, RepoEntry, SessionView } from '../../src/core/types.js';
import { removeScratch } from '../setup/scratch.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
/** The engine's plan-time refusal this finding is about — must never appear for a tool-only plan. */
const SEAT_REFUSAL = /council distribution failed|no eligible seat/i;
/** Event types that prove a unit was handed to an executor (any of them is "past distribution"). */
const DISPATCH_TYPES = new Set(['unitDistributed', 'unitExecuting', 'toolExecutorDispatched']);

let dir: string;
let repoDir: string;
let shimLog: string;
let priorPath: string | undefined;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'onboarding-launch-'));

  // A real git repo with one commit — registerRepo prepares a worktree and insists on both.
  // Identity is set locally so this does not depend on a global git config.
  repoDir = join(dir, 'repo');
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, 'README.md'), '# onboarding launch fixture\n');
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'onboarding launch fixture');
  git('add', '-A');
  git('commit', '-qm', 'root');

  // The estate binary the two tool phases spawn (`wicked-estate index …`, `wicked-estate clusters
  // --annotate …`), shimmed: records its argv, exits 0. The engine resolves the command through
  // the process PATH at spawn time (`Command::new("wicked-estate")`), so prepending the shim dir
  // BEFORE the engine spawns is what makes the shim the binary the run sees.
  const shimDir = join(dir, 'bin');
  mkdirSync(shimDir);
  shimLog = join(dir, 'wicked-estate.calls.log');
  writeFileSync(
    join(shimDir, 'wicked-estate'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${shimLog}'\necho "shim: wicked-estate $*"\nexit 0\n`,
  );
  chmodSync(join(shimDir, 'wicked-estate'), 0o755);
  priorPath = process.env['PATH'];
  process.env['PATH'] = `${shimDir}${delimiter}${priorPath ?? ''}`;

  // The daemon, in-process, over the real engine addon (stub dispatcher/runner: no real CLI is
  // ever needed — onboarding plans no agent unit — and the plan/distribute path is the SAME code
  // the production engine runs).
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 60_000);

afterAll(async () => {
  if (priorPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = priorPath;
  await app?.close();
  adapter?.close();
  removeScratch(dir);
});

describe('onboarding launched through POST /repos against the real engine (F-E2E-011)', () => {
  it('hands the engine NO seats and the run gets past distribution to its first tool unit', async () => {
    // The daemon's own pool for the workflow — `[]`, and this test does not change that.
    expect(adapter.seatsForWorkflow('onboarding')).toEqual([]);

    // "Register & onboard": register, then launch onboarding — one request, as the studio sends it.
    const res = await fetch(`${baseUrl}/api/v1/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'onboard-me', rootPath: repoDir }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { repo, onboardRunId } = (await res.json()) as { repo: RepoEntry; onboardRunId: string };
    expect(repo.id).toBe('onboard-me');
    expect(onboardRunId).toMatch(/^[0-9a-f-]{36}$/);

    // Follow the run to a terminal state (or a generous ceiling — the stub path is quick).
    let view: SessionView | undefined;
    let events: RecordedEvent[] = [];
    for (let i = 0; i < 600; i++) {
      const run = await getJson<{ run: SessionView }>(`/api/v1/runs/${onboardRunId}`);
      view = run.body.run;
      const log = await getJson<{ events?: RecordedEvent[] }>(`/api/v1/runs/${onboardRunId}/events`);
      if (log.status === 200 && Array.isArray(log.body.events)) events = log.body.events;
      if (TERMINAL.has(view.session.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(view, 'the run must be readable over GET /runs/:id').toBeDefined();
    const session = view!.session;
    const trail = events.map((e) => `${e.type}${'ord' in e && e.ord !== undefined ? `#${e.ord}` : ''}`).join(' → ');

    // 1. The seat pool the engine saw is empty — tool phases convene no council (F-2R2-010).
    expect(session.clis).toEqual([]);
    const started = events.find((e) => e.type === 'sessionStarted') as
      | (RecordedEvent & { cliCount?: number })
      | undefined;
    expect(started, `no sessionStarted recorded; trail: ${trail}`).toBeDefined();
    expect(started!.cliCount).toBe(0);

    // 2. THE regression: a tool-only plan must not be refused for want of a seat.
    const refusals = events.filter(
      (e) => e.type === 'error' && SEAT_REFUSAL.test(String((e as { message?: unknown }).message)),
    );
    expect(
      refusals,
      `the engine refused the tool-only onboarding plan for want of a seat (F-E2E-011):\n` +
        `${JSON.stringify(refusals, null, 2)}\ntrail: ${trail}`,
    ).toEqual([]);

    // 3. Past distribution: unit 1 (`index`) was handed to its executor and left `pending`.
    const dispatched = events.some(
      (e) => DISPATCH_TYPES.has(e.type) && 'ord' in e && e.ord === 1,
    );
    expect(dispatched, `unit 1 (index) was never dispatched; trail: ${trail}`).toBe(true);
    const index = view!.units.find((u) => u.ord === 1);
    expect(index?.status, `unit 1 status; trail: ${trail}`).not.toBe('pending');

    // 4. The tool unit really ran: the estate shim was invoked as `index <repo root> --db <graph>`
    //    — core's `{repo_root}` / `{code_graph_db}` placeholders bound per run from `repoRef`.
    //    (A POSIX shim; on Windows the engine spawns whatever `wicked-estate` the host has.)
    if (process.platform !== 'win32') {
      expect(existsSync(shimLog), `the wicked-estate shim was never spawned; trail: ${trail}`).toBe(true);
      const calls = readFileSync(shimLog, 'utf8').trim().split('\n');
      expect(calls[0]).toMatch(/^index /);
      expect(calls[0]).toContain(repo.root_path);
      expect(calls[0]).toMatch(/--db \S+estate\.db/);
      // With both tool phases succeeding (shim exits 0), the run completes.
      expect(calls.some((c) => /^clusters --annotate /.test(c)), `annotate never ran; calls: ${calls.join(' | ')}`).toBe(true);
      expect(session.status, `terminal status; trail: ${trail}`).toBe('completed');
    }
  }, 120_000);
});
