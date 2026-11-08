// CS2 P3: installed artifacts take precedence; Publish needs both builds and an answering engine.

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import * as artifacts from '../src/apps/publish/artifacts.js';
import type { AppStore } from '../src/apps/store.js';
import type { CoreAdapter } from '../src/core/adapter.js';

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>() }));

const crew = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(crew, 'dist/apps-server');
const checkoutServer = resolve(crew, '../apps-server/dist');
const runtime = join(crew, 'dist/studio/apps-standalone');
const checkoutRuntime = resolve(crew, '../../../wicked-studio/dist/apps-standalone');
const serverFiles = ['Dockerfile', 'server/lib/bundle/server.mjs', 'server/shim/host.js', 'server/shim/host.css', 'runners/sqlite-runner.mjs'];
const runtimeFiles = ['runtime.js', 'runtime.css', 'fixture.html', 'fixture.js'];

function filesAt(...dirs: string[]): void {
  const files = new Set(dirs.flatMap((dir) => (dir.endsWith('apps-standalone') ? runtimeFiles : serverFiles).map((file) => join(dir, file))));
  vi.spyOn(fs, 'statSync').mockImplementation((path) => {
    if (!files.has(String(path))) throw new Error('missing');
    return { isFile: () => true } as fs.Stats;
  });
  vi.spyOn(fs, 'readFileSync').mockImplementation((path) => String(path).endsWith('.js') ? 'standalone js' : 'standalone css');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('publish artifact resolution', () => {
  it('prefers the server carried by the installed crew package over the checkout', () => {
    filesAt(server, checkoutServer);
    expect(artifacts.appsServerArtifact()).toBe(server);
  });

  it('uses the checkout server when the installed artifact is missing', () => {
    filesAt(checkoutServer);
    expect(artifacts.appsServerArtifact()).toBe(checkoutServer);
  });

  it.each(serverFiles)('refuses a server build missing %s', (missing) => {
    filesAt(server);
    const stat = vi.mocked(fs.statSync);
    const present = stat.getMockImplementation()!;
    stat.mockImplementation((path, options) => {
      if (path === join(server, missing)) throw new Error('missing');
      return present(path, options);
    });
    expect(artifacts.appsServerArtifact()).toBeNull();
  });

  it('prefers studio bundled with crew and returns the runtime texts for the packer', () => {
    filesAt(runtime, checkoutRuntime);
    expect(artifacts.appsRuntime()).toEqual({ dir: runtime, js: 'standalone js', css: 'standalone css' });
  });

  it('uses the sibling studio checkout when crew has no bundled runtime', () => {
    filesAt(checkoutRuntime);
    expect(artifacts.appsRuntime()?.dir).toBe(checkoutRuntime);
  });

  it.each(runtimeFiles)('refuses a runtime build missing %s', (missing) => {
    filesAt(runtime);
    const stat = vi.mocked(fs.statSync);
    const present = stat.getMockImplementation()!;
    stat.mockImplementation((path, options) => {
      if (path === join(runtime, missing)) throw new Error('missing');
      return present(path, options);
    });
    expect(artifacts.appsRuntime()).toBeNull();
  });

  it('returns null without throwing when builds are missing or inaccessible', () => {
    filesAt();
    expect(artifacts.appsServerArtifact()).toBeNull();
    expect(artifacts.appsRuntime()).toBeNull();
  });

  it('requires files, not just directories with the expected names', () => {
    filesAt(server, runtime);
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => false } as fs.Stats);
    expect(artifacts.appsServerArtifact()).toBeNull();
    expect(artifacts.appsRuntime()).toBeNull();
  });

  it('falls back on unreadable runtime files, then returns null if neither build can be read', () => {
    filesAt(runtime, checkoutRuntime);
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (String(path).startsWith(runtime)) throw new Error('unreadable');
      return 'checkout';
    });
    expect(artifacts.appsRuntime()?.dir).toBe(checkoutRuntime);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('unreadable'); });
    expect(artifacts.appsRuntime()).toBeNull();
  });
});

describe('the cached container engine probe', () => {
  async function probe() {
    vi.resetModules();
    return (await import('../src/apps/publish/artifacts.js')).containerEngineAnswers;
  }

  function engine(error: Error | null, output: string) {
    return vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
      const done = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      done(error, output, '');
      return {} as childProcess.ChildProcess;
    });
  }

  it('probes the server version with a five second deadline and caches success for 60 seconds', async () => {
    vi.useFakeTimers();
    const run = engine(null, '28.0.0\n');
    const answers = await probe();
    expect(await answers()).toBe(true);
    expect(run).toHaveBeenCalledWith('docker', ['version', '--format', '{{.Server.Version}}'], expect.objectContaining({ timeout: 5_000, killSignal: 'SIGKILL' }), expect.any(Function));
    vi.advanceTimersByTime(59_999);
    expect(await answers()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await answers()).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new Error('ENOENT'), ''],
    [new Error('daemon unavailable'), 'client only'],
    [new Error('timeout'), ''],
    [null, ' \n'],
  ])('caches an unavailable engine and retries after 60 seconds (%s)', async (error, output) => {
    vi.useFakeTimers();
    const run = engine(error, output);
    const answers = await probe();
    expect(await answers()).toBe(false);
    expect(await answers()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(await answers()).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight probe between concurrent health requests', async () => {
    let finish!: (error: Error | null, stdout: string) => void;
    const run = vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
      finish = args[3] as typeof finish;
      return {} as childProcess.ChildProcess;
    });
    const answers = await probe();
    const first = answers();
    const second = answers();
    expect(run).toHaveBeenCalledTimes(1);
    finish(null, '28.0.0');
    expect(await Promise.all([first, second])).toEqual([true, true]);
  });

  it('hands the engine CLI only where it is and which engine, never the daemon environment (review r1)', async () => {
    process.env['WICKED_MCP_TOKEN'] = 'secret-token';
    process.env['DOCKER_HOST'] = 'unix:///tmp/engine.sock';
    try {
      const run = engine(null, '28.0.0');
      expect(await (await probe())()).toBe(true);
      const env = (run.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv }).env!;
      expect(env['WICKED_MCP_TOKEN']).toBeUndefined();
      expect(env['DOCKER_HOST']).toBe('unix:///tmp/engine.sock');
      expect(env['PATH']).toBe(process.env['PATH']);
    } finally {
      delete process.env['WICKED_MCP_TOKEN'];
      delete process.env['DOCKER_HOST'];
    }
  });

  it('the health answer never waits: false until a probe answers, then the cached answer', async () => {
    let finish!: (error: Error | null, stdout: string) => void;
    vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => { finish = args[3] as typeof finish; return {} as childProcess.ChildProcess; });
    vi.resetModules();
    const { containerEngineKnown } = await import('../src/apps/publish/artifacts.js');
    expect(containerEngineKnown()).toBe(false);
    finish(null, '28.0.0');
    await new Promise((r) => setTimeout(r, 0));
    expect(containerEngineKnown()).toBe(true);
  });

  it('answers false and caches a probe that throws before starting', async () => {
    const run = vi.spyOn(childProcess, 'execFile').mockImplementation(() => { throw new Error('spawn refused'); });
    const answers = await probe();
    expect(await answers()).toBe(false);
    expect(await answers()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('the apps.publish health capability', () => {
  it.each([
    [true, true, true, true],
    [false, true, true, false],
    [true, false, true, false],
    [true, true, false, false],
  ])('server=%s runtime=%s engine=%s reports %s', async (hasServer, hasRuntime, answers, expected) => {
    vi.spyOn(artifacts, 'appsServerArtifact').mockReturnValue(hasServer ? server : null);
    vi.spyOn(artifacts, 'appsRuntimeDir').mockReturnValue(hasRuntime ? runtime : null);
    const engine = vi.spyOn(artifacts, 'containerEngineKnown').mockReturnValue(answers);
    const app = Fastify({ logger: false });
    try {
      registerRoutes(app, { ping: async () => 'ok' } as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, {
        apps: { turns: null, sourceStage: null } as unknown as AppStore,
      });
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().capabilities.apps.publish).toBe(expected);
      expect(engine).toHaveBeenCalledTimes(hasServer && hasRuntime ? 1 : 0);
    } finally {
      await app.close();
    }
  });
});
