// crew-0183: the repo watcher's routes and its `/diagnostics.repoWatch` block.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiagnosticsResponse, RepoWatchStatus } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { RepoEntry, SessionView } from '../src/core/types.js';
import { createServer } from '../src/api/server.js';
import { RepoWatcher } from '../src/projects/repo-watch.js';
import { registerRepoWatchRoutes } from '../src/projects/repo-watch-routes.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'repo-watch-routes-')); });
afterEach(() => removeScratch(dir));

function app(views: SessionView[] = [], enabled = true) {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-c', 'core.fsmonitor=false', 'init', '-q', repo]);
  const db = join(dir, 'estate.db');
  writeFileSync(db, '');
  const entry = { id: 'r1', name: 'r1', root_path: repo, default_branch: 'main', registered_at: 1, code_graph_db: db } as RepoEntry;
  const w = new RepoWatcher({
    listRepos: async () => [entry], runViews: async () => views, indexRepoGraph: async () => ({ outcome: 'indexed' }),
    refreshProjects: async () => undefined, statePath: join(dir, 'repo-watch.json'), stateHome: null, enabled, log: () => undefined,
  });
  const a = Fastify();
  registerRepoWatchRoutes(a, w);
  return a;
}

describe('repo watch routes', () => {
  it('GET /repo-watch lists the onboarded repo with what "current" covers', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/api/v1/repo-watch' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as RepoWatchStatus;
    expect(body).toMatchObject({ enabled: true, disabledBy: null, cap: 24 });
    expect(body.covers).toMatch(/Symbols, files and references/);
    expect(body.repos.map((r) => [r.repoId, r.state, r.enabled])).toEqual([['r1', 'starting', true]]);
  });

  it('PUT /repos/:id/watch turns one repo off and on; 400 on a bad body, 404 on an unknown repo', async () => {
    const a = app();
    expect((await a.inject({ method: 'PUT', url: '/api/v1/repos/r1/watch', payload: { enabled: 'no' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PUT', url: '/api/v1/repos/nope/watch', payload: { enabled: false } })).statusCode).toBe(404);
    const off = await a.inject({ method: 'PUT', url: '/api/v1/repos/r1/watch', payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ repoId: 'r1', state: 'off', enabled: false });
    const on = await a.inject({ method: 'PUT', url: '/api/v1/repos/r1/watch', payload: { enabled: true } });
    expect(on.json()).toMatchObject({ repoId: 'r1', enabled: true });
  });

  it('POST /repos/:id/graph/reindex queues (202), or answers 409 naming the job that holds the map', async () => {
    expect((await app().inject({ method: 'POST', url: '/api/v1/repos/r1/graph/reindex' })).statusCode).toBe(202);
    const held = app([{ session: { id: 'run-1', status: 'executing', repo_ref: 'r1', workflow_id: 'wf-run-1' }, units: [] } as unknown as SessionView]);
    const res = await held.inject({ method: 'POST', url: '/api/v1/repos/r1/graph/reindex' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ queued: false, waitingOn: [{ runId: 'run-1', reason: 'executing' }] });
    expect(res.json().error).toMatch(/A job on this repository is using its code map/);
  });

  it('with the watcher off for the daemon, the status says so and the writes answer 409', async () => {
    const a = app([], false);
    expect((await a.inject({ method: 'GET', url: '/api/v1/repo-watch' })).json()).toMatchObject({ enabled: false, disabledBy: 'env' });
    expect((await a.inject({ method: 'POST', url: '/api/v1/repos/r1/graph/reindex' })).statusCode).toBe(409);
    expect((await a.inject({ method: 'PUT', url: '/api/v1/repos/r1/watch', payload: { enabled: false } })).statusCode).toBe(409);
  });
});

describe('/diagnostics.repoWatch', () => {
  it('carries the watcher block on the daemon', async () => {
    const adapter = {
      stub: true,
      projectsSupported: () => false,
      getSettings: async () => ({}),
      onLaunch: (): (() => void) => () => undefined,
      onEvent: () => () => {},
    } as unknown as CoreAdapter;
    const server = await createServer(adapter, {
      auth: { mode: 'off' }, auditPath: join(dir, 'audit.log'), projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true }, stallWatchdog: { enabled: false },
    });
    try {
      await server.ready();
      const body = (await server.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse;
      expect(body.repoWatch).toMatchObject({ enabled: true, cap: 24, repos: [], queue: [], watched: 0 });
    } finally {
      await server.close();
    }
  });
});
