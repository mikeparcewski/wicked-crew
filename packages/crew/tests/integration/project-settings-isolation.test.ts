// crew#353 — the project settings store must FOLLOW `--db`, never escape to the real home.
//
// # The bug this file pins
//
// `wicked-crew serve --db $SCRATCH/core.db` read as a fully isolated daemon — and then
// `createServer`'s `new ProjectSettingsStore()` resolved `~/.wicked-crew/project-settings.json`
// from `homedir()` unconditionally: the scratch daemon READ the operator's real bindings and a
// scratch PATCH REWROTE them. The graphs got this fix in crew#330/#351; the settings store was
// the last durable store still escaping.
//
// # The shape under test
//
// The exact daemon lifecycle, in-process over the REAL stub engine (the same seams
// `project-routes.test.ts` uses): configure the state home the way the CLI bootstrap does from
// `--db`, boot, create a project, PATCH its `interactiveRoot`, then RESTART (fresh adapter +
// server over the same core.db) and read the binding back. The settings landed under the --db
// parent, survived the restart from there, and the developer's real home holds no trace of the
// marker value — the crew#330 test's "$HOME holds no trace" observation, applied to settings.
//
// The marker value is unique per run, so a real daemon's settings file on the machine running
// the tests can never produce a false failure — or mask a real one. The real-home checks are
// READ-ONLY throughout.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { setCrewStateHome, stateHomeOfDb } from '../../src/projects/state-home.js';
import type { Project } from '../../src/core/types.js';

const MARKER = `/srv/decks-crew353-${process.pid}-${Date.now()}`;
const REAL_DEFAULT = join(homedir(), '.wicked-crew', 'project-settings.json');

let work: string;
let stateHome: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let savedEnvOverride: string | undefined;

async function boot(): Promise<void> {
  // What the CLI bootstrap does for `--db <stateHome>/core.db`, in order: seam first, server after.
  setCrewStateHome(stateHomeOfDb(join(stateHome, 'core.db')));
  adapter = new CoreAdapter({ dbPath: join(stateHome, 'core.db'), stub: true });
  app = await createServer(adapter, { projectEvents: { disabled: true } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/v1`;
}

async function shutdown(): Promise<void> {
  await app.close();
  adapter.close();
}

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'crew-353-'));
  stateHome = join(work, 'state');
  mkdirSync(stateHome, { recursive: true });
  // The point of the test: NO env override (the suite setup pins one for every other file). The
  // configured state home must carry alone, exactly as it does for a daemon launched with --db.
  savedEnvOverride = process.env['WICKED_CREW_PROJECT_SETTINGS'];
  delete process.env['WICKED_CREW_PROJECT_SETTINGS'];
  await boot();
}, 60_000);

afterAll(async () => {
  await shutdown();
  if (savedEnvOverride === undefined) delete process.env['WICKED_CREW_PROJECT_SETTINGS'];
  else process.env['WICKED_CREW_PROJECT_SETTINGS'] = savedEnvOverride;
  setCrewStateHome(undefined);
  rmSync(work, { recursive: true, force: true });
});

describe('project settings under an isolated state home (crew#353)', () => {
  it('PATCH persists under the --db parent, survives a restart, and leaves $HOME untouched', { timeout: 60_000 }, async () => {
    const created = await req('POST', '/projects', { name: 'isolation-353' });
    expect(created.status).toBe(201);
    const projectId = (created.json['project'] as Project).id;

    const patched = await req('PATCH', `/projects/${projectId}`, { interactiveRoot: MARKER });
    expect(patched.status).toBe(200);
    expect((patched.json['project'] as Project).interactiveRoot).toBe(MARKER);

    // The binding landed INSIDE the isolated state home…
    const isolatedFile = join(stateHome, 'project-settings.json');
    expect(existsSync(isolatedFile)).toBe(true);
    expect(JSON.parse(readFileSync(isolatedFile, 'utf8'))).toEqual({
      projects: { [projectId]: { interactiveRoot: MARKER } },
    });

    // …and the developer's real home holds NO trace of it (read-only check; the file may
    // legitimately pre-exist on a developer machine, but it can never contain THIS run's marker).
    if (existsSync(REAL_DEFAULT)) {
      expect(readFileSync(REAL_DEFAULT, 'utf8')).not.toContain(MARKER);
    }

    // RESTART: fresh adapter + server over the same core.db, empty caches — the durable read.
    await shutdown();
    await boot();

    const readBack = await req('GET', `/projects/${projectId}`);
    expect(readBack.status).toBe(200);
    expect((readBack.json['project'] as Project).interactiveRoot).toBe(MARKER);
  });
});
