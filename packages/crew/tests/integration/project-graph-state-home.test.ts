/**
 * crew#330 — `--db` must move the PROJECT GRAPH too, not just the core store.
 *
 * # The defect
 *
 * `wicked-crew serve --db <scratch>/core.db --bus-db <scratch>/bus.db` reads as a fully isolated
 * daemon: the engine store moves, the bus moves. The project code graph did NOT. `graph-paths.ts`
 * resolved its root from `homedir()`, so a graph built by a scratch daemon was written into the
 * developer's REAL state home:
 *
 *     $HOME/.wicked-crew/project-graphs/<projectId>/code-graph.db     (41.7 MB for three repos)
 *
 * — keyed by project ids that exist only in the scratch store, so nothing ever reaps them. Anyone
 * proving a change against an isolated daemon (CI, a reproduction, an agent) wrote into a real home
 * without being told.
 *
 * # Why this test spawns the real binary
 *
 * The unit tests for `projectGraphRoot` pass an `env` object, so they can never see this: the bug
 * was that NOTHING put the daemon's resolved state home INTO that env. The seam under test is the
 * bootstrap wiring between `--db` and the graph paths, and the only honest way to exercise it is to
 * hand the actual CLI the actual flag. `HOME`/`USERPROFILE` are pointed at a scratch directory so a
 * regression writes there instead of into the developer's home while the suite runs.
 *
 * # Why it can assert without building a graph
 *
 * `GET /projects/:id/graph` reports `dbPath` for any project whose graph file exists, before any
 * repo is attached (`state: no-repo-members` still carries the resolved path). Seeding BOTH
 * candidate locations with a stub file makes the response name the root the daemon actually chose,
 * so the assertion reads as "which of these two did it pick" rather than "is it null" — and the
 * pre-fix failure prints the `$HOME` path verbatim.
 */
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/cli/index.js');

let proc: ChildProcess | undefined;
let root: string;
let fakeHome: string;
let stateHome: string;
let baseUrl: string;

/** The daemon's stdout up to now — the READY line, and the whole log if a boot goes wrong. */
let out = '';
/** The parsed WICKED_CREW_READY payload — the machine-readable line an evidence harness reads. */
let readyFields: Record<string, unknown> = {};

async function bootDaemon(): Promise<void> {
  // A CLEAN env: the vitest setup file exports WICKED_CREW_* overrides into this process, and
  // inheriting them would pre-answer the very question this test asks.
  const env: NodeJS.ProcessEnv = {
    ...(process.env['PATH'] !== undefined ? { PATH: process.env['PATH'] } : {}),
    ...(process.env['SystemRoot'] !== undefined ? { SystemRoot: process.env['SystemRoot'] } : {}),
    ...(process.env['TMPDIR'] !== undefined ? { TMPDIR: process.env['TMPDIR'] } : {}),
    ...(process.env['TEMP'] !== undefined ? { TEMP: process.env['TEMP'] } : {}),
    HOME: fakeHome,
    USERPROFILE: fakeHome, // homedir() reads this one on Windows
    WICKED_MEMORY_EMBEDDER: 'hash',
  };
  proc = spawn(
    process.execPath,
    [
      DIST,
      'serve',
      '--db', join(stateHome, 'core.db'),
      '--bus-db', join(stateHome, 'bus.db'),
      '--port', '0',
      '--stub',
      // The cross-product event seams are irrelevant here and would only add a bus to boot.
      '--no-interactive-draft-events',
      '--no-interactive-edit-events',
      '--no-interactive-chat-events',
      '--no-interactive-demo-events',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stdout?.on('data', (c: Buffer) => {
    out += c.toString();
  });
  proc.stderr?.on('data', (c: Buffer) => {
    out += c.toString();
  });

  const ready = await new Promise<Record<string, unknown>>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`daemon never printed WICKED_CREW_READY:\n${out}`)), 90_000);
    const poll = setInterval(() => {
      const line = out.split('\n').find((l) => l.startsWith('WICKED_CREW_READY '));
      if (line === undefined) return;
      clearInterval(poll);
      clearTimeout(timer);
      res(JSON.parse(line.slice('WICKED_CREW_READY '.length)) as Record<string, unknown>);
    }, 100);
    proc?.on('exit', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      rej(new Error(`daemon exited with ${String(code)} before READY:\n${out}`));
    });
  });
  baseUrl = `http://127.0.0.1:${String(ready['port'])}/api/v1`;
  readyFields = ready;
}

beforeAll(async () => {
  if (!existsSync(DIST)) {
    throw new Error(
      `${DIST} is missing — this test drives the real CLI. Run \`npm run -w packages/crew build\` first.`,
    );
  }
  root = mkdtempSync(join(tmpdir(), 'crew330-'));
  fakeHome = join(root, 'home');
  stateHome = join(root, 'state');
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  await bootDaemon();
}, 120_000);

afterAll(async () => {
  proc?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1000));
  proc?.kill('SIGKILL');
  if (root !== undefined) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('a daemon given --db keeps its project graph under that state home (crew#330)', () => {
  it('resolves the project graph next to the store it was given, NOT under $HOME', async () => {
    const created = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'crew330-isolation' }),
    });
    expect(created.status).toBe(201);
    const projectId = ((await created.json()) as { project: { id: string } }).project.id;

    // Both candidates seeded: the answer names the root the daemon CHOSE, not the only one present.
    const underHome = join(fakeHome, '.wicked-crew', 'project-graphs', projectId, 'code-graph.db');
    const underState = join(stateHome, 'project-graphs', projectId, 'code-graph.db');
    for (const db of [underHome, underState]) {
      mkdirSync(dirname(db), { recursive: true });
      writeFileSync(db, 'stub-graph');
    }

    const res = await fetch(`${baseUrl}/projects/${projectId}/graph`);
    expect(res.status).toBe(200);
    const { status } = (await res.json()) as { status: { dbPath: string | null } };

    // The failure this pins, verbatim from the issue: a scratch daemon writing a 41 MB graph into
    // the developer's real ~/.wicked-crew, keyed by a project id only the scratch store knows.
    expect(status.dbPath).toBe(underState);
    expect(status.dbPath).not.toBe(underHome);
  });

  it('SAYS where the graphs land on the readiness line', () => {
    // The half of this defect that made it survive: nothing announced the root, so a harness that
    // read every field of WICKED_CREW_READY still could not tell an isolated daemon from one
    // quietly filling the developer's home. `db` moved with the flag and this did not, unsaid.
    expect(readyFields['projectGraphs']).toBe(join(stateHome, 'project-graphs'));
  });
});
