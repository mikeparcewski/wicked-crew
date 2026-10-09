// IG1-crew-2 smoke — a floor-class seat on the REAL engine (`stub: false`): a one-unit build run
// bound to a registered repository and pinned to a seat with no admitted ACP adapter
// (`acp_input_governance` false, no `os_sandbox` on the record) is NOT denied `input_governance`.
// It runs under the OS-sandbox floor (or, on a host whose engine cannot arm the floor, the
// repository boundary), completes, and `GET /runs/:id/acceptance` records the unit
// `mode: 'os_sandbox'` with the worktree in `fence.write_roots` and the run `contained`.
//
// The seat is a WRAPPED stub (a node script, no `[cli.acp]` section): the engine classes a seat
// with no admitted adapter and no refused floor `os_sandbox` (wicked-council `governance_class`),
// which is exactly the class under test — a stub ACP adapter would add an ACP protocol stub and
// change nothing the class reads.
//
// crew CI builds `wicked-core-ts` from core MAIN (`scripts/use-local-core-ts.mjs`); the engine
// half (the `os_sandbox` class, the fold accepting the floor) needs a core-ts carrying IG1-core-1..3
// (>= 0.7.41). The host arm is asserted whichever way it goes and printed.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';
import { baseSkillOff } from '../setup/base-skill-off.js';

const SEAT = 'floor-seat';
const WORKFLOW = 'os-sandbox-floor-build';
const RUN = 'it-os-sandbox-floor-run';
/** wicked-core `builtin_floors::EVIDENCE_FLOOR_PIN` — the worktree carries a change. */
const EVIDENCE_FLOOR_PIN = 'e2e7af1db9e48454';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** The worker: writes one file into its working directory (the run worktree) and reports done. */
const WORKER_CLI = `
require('node:fs').writeFileSync('floor-seat-work.txt', 'written under the floor\\n');
process.stdout.write('Wrote floor-seat-work.txt; the unit is done.\\n');
process.exit(0);
`;

type Ev = Record<string, unknown>;

let dir: string;
let savedEnv: Record<string, string | undefined> = {};
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let session: Record<string, unknown>;
let events: Ev[];
let acceptance: Record<string, unknown>;

const ofType = (evs: Ev[], type: string): Ev[] => evs.filter((e) => e['type'] === type);

async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postJson(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'crew-os-sandbox-floor-')));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'wicked-council'), { recursive: true });
  for (const [k, v] of Object.entries({ HOME: home, USERPROFILE: home, GH_ACCOUNT: '', WICKED_CREW_AUDIT_LOG: join(dir, 'audit.log') })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  const workerPath = join(dir, 'floor-seat-cli.cjs');
  writeFileSync(workerPath, WORKER_CLI);
  writeFileSync(
    join(home, '.config', 'wicked-council', 'clis.toml'),
    [
      '[[cli]]',
      `key = ${JSON.stringify(SEAT)}`,
      `display_name = "Floor seat"`,
      `binary = ${JSON.stringify(process.execPath)}`,
      `headless_invocation = ${JSON.stringify(`${process.execPath} ${workerPath} {PROMPT}`)}`,
      '',
    ].join('\n'),
  );

  // A registered repository (deliver-e2e's recipe): the run is BOUND to it — a worktree.
  const repo = join(dir, 'workspace');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'runner@test');
  git(repo, 'config', 'user.name', 'runner');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# os-sandbox floor workspace\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: false });
  baseSkillOff(); // run mechanics, not grounding — no published generation here (see tests/setup/base-skill-off.ts)
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  await adapter.registerRepo('os-sandbox-floor-ws', repo);
  const repoId = (await adapter.listRepos()).find((r) => r.name === 'os-sandbox-floor-ws')!.id;

  const wf = await postJson('/api/v1/workflows', {
    id: WORKFLOW,
    phases: [
      {
        id: 'build',
        kind: 'build',
        gate_type: null,
        gate: 'auto',
        executes_code: true,
        verified_evidence: false,
        required_deliverables: [],
        depends_on: [],
        role: 'neutral',
        skill_ref: null,
        allowed_skills: [],
        // The built-in evidence floor: the gate re-derives "done" from the worktree diff (the
        // engine refuses an executes_code phase whose gate evaluates nothing).
        validator_pin: EVIDENCE_FLOOR_PIN,
      },
    ],
  });
  expect(wf.status, JSON.stringify(wf.body)).toBeLessThan(300);

  // The seat exactly as the roster serves it (the studio's launch), engine class and all.
  const { body: rosterBody } = await getJson('/api/v1/roster');
  const seat = (rosterBody['roster'] as Array<Record<string, unknown>>).find((s) => s['key'] === SEAT);
  expect(seat, JSON.stringify(rosterBody)).toBeDefined();

  const launch = await postJson('/api/v1/runs', {
    problem: 'Write floor-seat-work.txt in the repository.',
    sessionId: RUN,
    workflow: WORKFLOW,
    repoRef: repoId,
    humanConfirm: 'none',
    deliver: 'none',
    clisJson: JSON.stringify([seat]),
  });
  expect(launch.status, JSON.stringify(launch.body)).toBe(201);

  const deadline = Date.now() + 150_000;
  for (;;) {
    const { body } = await getJson(`/api/v1/runs/${RUN}`);
    const run = body['run'] as { session: Record<string, unknown> } | undefined;
    if (run) {
      session = run.session;
      const status = String(run.session['status']);
      if (TERMINAL.has(status) || status === 'awaiting_human') break;
    }
    if (Date.now() > deadline) {
      const evs = (await getJson(`/api/v1/runs/${RUN}/events`)).body['events'] as Ev[];
      throw new Error(`${RUN} never settled; last session: ${JSON.stringify(session)}; events: ${JSON.stringify(evs.map((e) => e['type']))}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  events = (await getJson(`/api/v1/runs/${RUN}/events`)).body['events'] as Ev[];
  const acc = await getJson(`/api/v1/runs/${RUN}/acceptance`);
  expect(acc.status, JSON.stringify(acc.body)).toBe(200);
  acceptance = acc.body;
}, 210_000);

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    adapter?.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    savedEnv = {};
    removeScratch(dir);
  }
});

describe('IG1-crew-2 smoke — a floor-class seat on the real engine is contained, not denied', () => {
  it('the roster names the seat os_sandbox from the engine class', async () => {
    const { body } = await getJson('/api/v1/roster');
    const seat = (body['roster'] as Array<Record<string, unknown>>).find((s) => s['key'] === SEAT)!;
    expect(seat['governance_class']).toBe('os_sandbox');
    // The roster states the mode per scope kind: a bound run is fenced by the repository
    // boundary; with no record sandbox and no own sandbox, an unbound scope has no fence.
    const modes = seat['governance_mode'] as Record<string, { mode: string; source: string }>;
    expect(modes['scoped_bound']).toMatchObject({ mode: 'os_sandbox', source: 'repo_boundary' });
    expect(modes['scoped']).toMatchObject({ mode: 'none' });
  });

  it('the one-unit bound build run completes with no input_governance denial', () => {
    const escalations = ofType(events, 'gateEscalated');
    expect(escalations.filter((e) => e['denialSource'] === 'input_governance'), JSON.stringify(escalations)).toHaveLength(0);
    expect(String(session['status']), JSON.stringify(ofType(events, 'stepFailed'))).toBe('completed');
  });

  it('acceptance records the unit os_sandbox with the worktree fenced and the run contained', () => {
    const enforcement = (acceptance['conformance'] as { enforcement: Record<string, unknown> }).enforcement;
    const units = enforcement['units'] as Array<Record<string, unknown>>;
    const posture = ofType(events, 'sandboxPosture').map((e) => e['posture']);
    const governed = ofType(events, 'unitOutputCaptured').map((e) => e['governed']);
    const unenforced = ofType(events, 'governanceUnenforced').length;
    // Which arm this host took — printed for the PR.
    console.log(
      `[os-sandbox-floor] host arm: sandboxPosture=${JSON.stringify(posture)} governed=${JSON.stringify(governed)} ` +
        `governanceUnenforced=${unenforced} units=${JSON.stringify(units)} status=${String(enforcement['status'])}`,
    );
    expect(enforcement['status'], JSON.stringify(enforcement)).toBe('contained');
    const unit = units.find((u) => u['ord'] === 1);
    expect(unit, JSON.stringify(units)).toBeDefined();
    expect(unit!['mode']).toBe('os_sandbox');
    expect(unit!['cli']).toBe(SEAT);
    const worktree = String(session['workdir']);
    expect((unit!['fence'] as { write_roots: string[] }).write_roots).toContain(worktree);
    if (posture.includes('os')) {
      // The engine arms the floor on this host.
      expect(governed).toContain(true);
    } else {
      // No OS launcher: the engine reports it unenforced; the bound run's repository boundary held it.
      expect(unenforced).toBeGreaterThan(0);
      expect(unit!['source']).toBe('repo_boundary');
    }
  });
});
