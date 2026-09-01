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
// Unique per run for the same reason as MARKER — the audit trail records the project NAME, and
// the real-home trail on a developer machine must never false-fail (or mask) the escape check.
const PROJECT_NAME = `isolation-353-${process.pid}-${Date.now()}`;
const REAL_DEFAULT = join(homedir(), '.wicked-crew', 'project-settings.json');
const REAL_AUDIT = join(homedir(), '.wicked-crew', 'audit.log');

let work: string;
let stateHome: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let savedEnvOverride: string | undefined;
let savedAuditOverride: string | undefined;

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
  // The point of the test: NO env overrides (the suite setup pins them for every other file). The
  // configured state home must carry alone, exactly as it does for a daemon launched with --db —
  // for the settings store AND the audit trail (the lane-2 finding: audit was still escaping).
  savedEnvOverride = process.env['WICKED_CREW_PROJECT_SETTINGS'];
  delete process.env['WICKED_CREW_PROJECT_SETTINGS'];
  savedAuditOverride = process.env['WICKED_CREW_AUDIT_LOG'];
  delete process.env['WICKED_CREW_AUDIT_LOG'];
  await boot();
}, 60_000);

afterAll(async () => {
  await shutdown();
  if (savedEnvOverride === undefined) delete process.env['WICKED_CREW_PROJECT_SETTINGS'];
  else process.env['WICKED_CREW_PROJECT_SETTINGS'] = savedEnvOverride;
  if (savedAuditOverride === undefined) delete process.env['WICKED_CREW_AUDIT_LOG'];
  else process.env['WICKED_CREW_AUDIT_LOG'] = savedAuditOverride;
  setCrewStateHome(undefined);
  rmSync(work, { recursive: true, force: true });
});

describe('project settings under an isolated state home (crew#353)', () => {
  it('PATCH persists under the --db parent, survives a restart, and leaves $HOME untouched', { timeout: 60_000 }, async () => {
    const created = await req('POST', '/projects', { name: PROJECT_NAME });
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
    // `shutdown()` awaits the audit flush (the server's onClose hook), so the trail is settled
    // for the checks below.
    await shutdown();

    // The audit trail followed the state home too (the lane-2 finding): `project.created` for
    // THIS run's uniquely-named project landed inside the isolated home…
    const isolatedAudit = join(stateHome, 'audit.log');
    expect(existsSync(isolatedAudit)).toBe(true);
    expect(readFileSync(isolatedAudit, 'utf8')).toContain(PROJECT_NAME);
    // …and the developer's real trail holds no trace of it (read-only check).
    if (existsSync(REAL_AUDIT)) {
      expect(readFileSync(REAL_AUDIT, 'utf8')).not.toContain(PROJECT_NAME);
    }

    await boot();

    const readBack = await req('GET', `/projects/${projectId}`);
    expect(readBack.status).toBe(200);
    expect((readBack.json['project'] as Project).interactiveRoot).toBe(MARKER);
  });
});
