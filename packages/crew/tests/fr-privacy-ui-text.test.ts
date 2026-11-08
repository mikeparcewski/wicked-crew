// Slice B / FINDINGS B1,B2,C3a: the UI-text module — scrubHomePaths, plainRuntimeCause — and the
// one backstop (registerUiTextScrub) that re-scrubs the four read-only diagnostic routes. THE
// PRIVACY TEST lives here: four responses carrying home paths, none of which may ship them.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { plainRuntimeCause, registerUiTextScrub, scrubHomePaths } from '../src/api/ui-text.js';
import { expectNoHomePaths } from './fr-privacy-helpers.js';

const API = '/api/v1';

/** The Rancher Desktop line a new user actually saw (FINDINGS C3a / shot s3-uv/01). */
const RANCHER =
  'failed to connect to the docker API at unix:///Users/alice/.rd/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/alice/.rd/docker.sock: connect: no such file or directory';

describe('scrubHomePaths', () => {
  it('replaces the daemon home as a whole path prefix, keeping the rest', () => {
    expect(scrubHomePaths('/Users/alice/.rd/docker.sock', '/Users/alice')).toBe('~/.rd/docker.sock');
    // A different user whose name merely starts the same is untouched by the home pass; the generic
    // pass below still folds it.
    expect(scrubHomePaths('/Users/alice2/x', '/Users/alice')).toBe('~/x');
  });

  it('folds any user home: /Users, /home, C:\\Users (either slash, any drive case), even inside a unix:// URL', () => {
    const home = '/nonexistent-daemon-home';
    expect(scrubHomePaths('/Users/alice/secret', home)).toBe('~/secret');
    expect(scrubHomePaths('/home/bob/.wicked/mem.db', home)).toBe('~/.wicked/mem.db');
    expect(scrubHomePaths('C:\\Users\\Carol\\x\\.venv', home)).toBe('~\\x\\.venv');
    expect(scrubHomePaths('c:/Users/Carol/x', home)).toBe('~/x');
    expect(scrubHomePaths('unix:///Users/alice/.rd/docker.sock', home)).toBe('unix://~/.rd/docker.sock');
  });

  it('is idempotent', () => {
    const once = scrubHomePaths(RANCHER, '/nonexistent');
    expect(scrubHomePaths(once, '/nonexistent')).toBe(once);
    expectNoHomePaths(once);
  });
});

describe('plainRuntimeCause', () => {
  it('classifies the Rancher Desktop daemon-down message as "Docker isn\'t running"', () => {
    const got = plainRuntimeCause(RANCHER);
    expect(got).not.toBeNull();
    expect(got!.cause).toBe("Docker isn't running");
    expect(got!.fix).toMatch(/^Start Docker Desktop or Rancher Desktop/);
  });

  it('classifies the classic docker, podman and dial-unix daemon-down messages', () => {
    expect(plainRuntimeCause('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')?.cause).toBe("Docker isn't running");
    expect(plainRuntimeCause('Cannot connect to Podman. Please verify your connection to the Linux system')?.cause).toBe("Podman isn't running");
    expect(plainRuntimeCause('dial unix /var/run/docker.sock: connect: no such file or directory')?.cause).toBe("Docker isn't running");
  });

  it('gives permission-denied its own cause (starting the daemon will not fix it)', () => {
    const got = plainRuntimeCause('dial unix /var/run/docker.sock: connect: permission denied');
    expect(got?.cause).toMatch(/permission denied/);
    expect(got?.cause).not.toBe("Docker isn't running");
  });

  it('returns null for anything it does not recognise, so the caller keeps its own (scrubbed) text', () => {
    expect(plainRuntimeCause('some unrelated failure: disk full')).toBeNull();
    expect(plainRuntimeCause('spawn wicked-core ENOENT')).toBeNull();
  });
});

// ── THE PRIVACY TEST ─────────────────────────────────────────────────────────

/** A body on each route that, unguarded, would leak home paths of every shape. */
function dirtyRoutes() {
  const app = Fastify();
  app.get(`${API}/system`, async () => ({
    infra: [
      { key: 'gateway', reason: RANCHER, details: { error: RANCHER } },
      { key: 'estate', reason: '/home/bob/.local/state/wicked/mem.db' },
    ],
    findings: [{ message: 'uv sync did not produce C:\\Users\\Carol\\.wicked-crew\\skills\\baseline\\x\\.venv' }],
  }));
  app.get(`${API}/diagnostics`, async () => ({ memoryStore: { path: '/home/bob/.local/state/wicked/mem.db' }, note: 'state at /Users/alice/.wicked-crew' }));
  app.get(`${API}/roster`, async () => ({ seats: [{ cli: 'claude', home: '/Users/alice/worker' }] }));
  app.get(`${API}/health`, async () => ({ ok: true, root: '/Users/alice/.wicked-crew', win: 'C:\\Users\\Carol\\state' }));
  app.get(`${API}/other`, async () => ({ path: '/Users/alice/not-a-diagnostic-route' }));
  return app;
}

const GUARDED = [`${API}/health`, `${API}/diagnostics`, `${API}/system`, `${API}/roster`];

describe('registerUiTextScrub backstop', () => {
  it('scrubs home paths from all four diagnostic routes and keeps the body valid JSON', async () => {
    const app = dirtyRoutes();
    // Home that does not exist on disk → the realpath step is skipped; the generic passes still fold.
    registerUiTextScrub(app, GUARDED, '/nonexistent-daemon-home');
    for (const url of ['/system', '/diagnostics', '/roster', '/health']) {
      const res = await app.inject({ method: 'GET', url: `${API}${url}` });
      expect(res.statusCode, url).toBe(200);
      expectNoHomePaths(res.payload);
      expect(() => JSON.parse(res.payload), `${url} is valid JSON`).not.toThrow();
    }
    // A query string does not change the matched route path.
    const q = await app.inject({ method: 'GET', url: `${API}/system?refresh=1` });
    expectNoHomePaths(q.payload);
    await app.close();
  });

  it('WITHOUT the hook the same routes DO leak home paths (the guard is what removes them)', async () => {
    const app = dirtyRoutes();
    const res = await app.inject({ method: 'GET', url: `${API}/system` });
    expect(res.payload).toMatch(/\/Users\/|\/home\//); // proves the fixture is dirty; the guard above cleans it
    await app.close();
  });

  it('touches only the four routes it is given, not other routes', async () => {
    const app = dirtyRoutes();
    registerUiTextScrub(app, GUARDED, '/nonexistent-daemon-home');
    const other = await app.inject({ method: 'GET', url: `${API}/other` });
    expect(other.payload).toContain('/Users/alice'); // not a guarded route → left as-is
    await app.close();
  });
});
