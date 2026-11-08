// First-run walk-through (2026-11-08): the daemon boots without Fastify's FSTDEP022 deprecation (P9), a
// repository folder typed as `~/code/my-app` is expanded (C1), and an onboarding that cannot start because
// wicked-estate is missing says what to install (B2). Over the REAL server assembly (the headless-boot recipe
// of audit-since-route.test.ts: stub adapter, every seam disabled).

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { onboardFailure, readRepoPath, tildePath } from '../src/api/repo-input.js';
import { removeScratch } from './setup/scratch.js';
import { expectNoHomePaths } from './fr-privacy-helpers.js';

const ESTATE_REFUSAL =
  "workflow '4e9fafbe-0000:plan-1' cannot start — unresolved tool dependencies: phase 'index' requires tool 'wicked-estate' (not found on PATH /usr/bin:/bin)";

let scratch: string;
let app: FastifyInstance;
let savedLogLevel: string | undefined;
const warnings: string[] = [];
const registered: Array<{ name: string; root: string }> = [];
let onboardThrows: string | null = null;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-fr-boot-'));
  savedLogLevel = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'error';
  const real = process.emitWarning.bind(process);
  vi.spyOn(process, 'emitWarning').mockImplementation(((w: string | Error, ...rest: unknown[]) => {
    warnings.push(typeof w === 'string' ? `${w} ${JSON.stringify(rest)}` : `${w.name} ${(w as { code?: string }).code ?? ''} ${w.message}`);
    return (real as (...a: unknown[]) => void)(w, ...rest);
  }) as typeof process.emitWarning);
  const adapter = {
    stub: true,
    projectsSupported: () => false,
    getSettings: async () => ({}),
    onLaunch: (): (() => void) => () => undefined,
    onEvent: () => () => {},
    listRepos: async () => [],
    getOnboardRunId: () => null,
    ping: async () => 'pong',
    registerRepo: async (name: string, root: string) => {
      // The engine's own refusal for a folder that is not there (core repo.rs).
      if (!existsSync(root)) throw new Error(`${root} is not a directory`);
      registered.push({ name, root });
      return { id: name, name, root_path: root };
    },
    launchOnboardingRun: async () => {
      if (onboardThrows !== null) throw new Error(onboardThrows);
      return 'run-1';
    },
  } as unknown as CoreAdapter;
  app = await createServer(adapter, {
    auth: { mode: 'off' },
    auditPath: join(scratch, 'audit.log'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
    studioRoot: join(scratch, 'no-studio'),
  });
  await app.ready();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
  if (savedLogLevel === undefined) delete process.env['LOG_LEVEL'];
  else process.env['LOG_LEVEL'] = savedLogLevel;
  removeScratch(scratch);
});

describe('boot (P9)', () => {
  it('prints no Fastify deprecation (FSTDEP022: router options at the top level)', () => {
    expect(warnings.filter((w) => w.includes('FSTDEP') || w.includes('routerOptions'))).toEqual([]);
  });

  it('still accepts a 165-character path parameter (the limit moved, it did not shrink)', async () => {
    const id = 'a'.repeat(165);
    const res = await app.inject({ method: 'GET', url: `/api/v1/repos/${id}/onboard` });
    expect(res.statusCode).toBe(200);
  });
});

describe('the real server scrubs its four diagnostic routes (privacy backstop wired)', () => {
  it.each(['health', 'diagnostics', 'system'])('GET /api/v1/%s carries no home path', async (route) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/${route}` });
    expect(res.statusCode).toBeLessThan(500);
    expectNoHomePaths(res.body);
  });

  // GET /roster is deliberately NOT rewritten: its rows go back verbatim as POST /runs `clisJson`, so a seat binary
  // under the home dir keeps its real path (pinned by tests/integration/seat-bench-next-launch.test.ts on macOS).
});

describe('readRepoPath (C1)', () => {
  const home = '/Users/alice';
  // POSIX fixtures: pinned so the same assertions hold on a Windows CI host (codex r2).
  const posix = { home, platform: 'linux' as const };
  it('expands ~ and ~/x against the home dir', () => {
    expect(readRepoPath('~/code/my-app', posix)).toEqual({ ok: true, path: '/Users/alice/code/my-app' });
    expect(readRepoPath(' ~ ', posix)).toEqual({ ok: true, path: '/Users/alice' });
  });
  it('refuses ~other and relative paths with a reason, never as "not a directory"', () => {
    const other = readRepoPath('~bob/code', posix);
    expect(other).toMatchObject({ ok: false, code: 'repo_path_relative' });
    const rel = readRepoPath('code/my-app', posix);
    expect(rel).toMatchObject({ ok: false, code: 'repo_path_relative' });
    expect(rel.ok ? '' : rel.error).toContain('full path');
  });
  it('a missing folder names it in ~ form', () => {
    const r = readRepoPath('~/nope-not-here', { home: scratch, mustExist: true, platform: process.platform });
    expect(r).toMatchObject({ ok: false, code: 'repo_path_missing' });
    expect(r.ok ? '' : r.error).toContain('~/nope-not-here');
    expect(r.ok ? '' : r.error).not.toContain(scratch);
  });
  it('tildePath', () => {
    expect(tildePath('/Users/alice/x', home)).toBe('~/x');
    expect(tildePath('/Users/alicex/y', home)).toBe('/Users/alicex/y');
  });
});

describe('POST /repos', () => {
  // os.homedir() reads $HOME on POSIX only (Windows reads USERPROFILE), so this route case is POSIX's.
  it.skipIf(process.platform === 'win32')('registers ~/<dir> as the expanded absolute folder (C1)', async () => {
    // os.homedir() reads $HOME on POSIX: aim it at the scratch dir, never the real home.
    const savedHome = process.env['HOME'];
    process.env['HOME'] = scratch;
    try {
      expect(homedir()).toBe(scratch);
      mkdirSync(join(scratch, 'code', 'tiny-calc'), { recursive: true });
      onboardThrows = null;
      const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'tiny', rootPath: '~/code/tiny-calc' } });
      expect(res.statusCode).toBe(201);
      expect(registered.at(-1)).toEqual({ name: 'tiny', root: join(scratch, 'code', 'tiny-calc') });
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
    }
  });

  it('a missing ~ folder is a plain 400 naming it in ~ form, not "<path> is not a directory"', async () => {
    const before = registered.length;
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'gone', rootPath: '~/definitely-not-a-folder-fr-c1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'repo_path_missing', error: expect.stringContaining('~/definitely-not-a-folder-fr-c1') });
    expect(registered.length).toBe(before);
  });

  it('a missing wicked-estate reads as what to install (B2)', async () => {
    const dir = join(scratch, 'repo-b2');
    mkdirSync(dir);
    onboardThrows = ESTATE_REFUSAL;
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'b2', rootPath: dir } });
    onboardThrows = null;
    expect(res.statusCode).toBe(201);
    const body = res.json() as { onboardError: string; onboardErrorCode: string; missingTool: string };
    expect(body.onboardErrorCode).toBe('tool_missing');
    expect(body.missingTool).toBe('wicked-estate');
    expect(body.onboardError).toContain('npx wicked-installer install wicked-estate');
    expect(body.onboardError).not.toContain('unresolved tool dependencies');
  });
});

describe('onboardFailure', () => {
  it('keeps every other blocker the engine listed, and names every missing tool (codex r1)', () => {
    const raw = "workflow 'w' cannot start — unresolved tool dependencies: phase 'index' requires tool 'wicked-estate' (not found on PATH or at that path); phase 'x' has an empty tool cmd; phase 'y' requires tool 'frob' (not found on PATH or at that path). Install the missing tool(s) or fix PATH, then relaunch.";
    const f = onboardFailure(raw, '/h');
    expect(f).toMatchObject({ code: 'tool_missing', tool: 'wicked-estate', tools: ['wicked-estate', 'frob'] });
    expect(f.error).toContain('npx wicked-installer install wicked-estate');
    expect(f.error).toContain('frob');
    expect(f.error).toContain("phase 'x' has an empty tool cmd");
  });
  it('a Windows path needs its drive or a UNC share (codex r1)', () => {
    expect(readRepoPath('\\repo', { home: 'C:\\Users\\a', platform: 'win32' })).toMatchObject({ ok: false, code: 'repo_path_relative' });
    expect(readRepoPath('/repo', { home: 'C:\\Users\\a', platform: 'win32' })).toMatchObject({ ok: false, code: 'repo_path_relative' });
    expect(readRepoPath('C:\\code\\app', { home: 'C:\\Users\\a', platform: 'win32' })).toEqual({ ok: true, path: 'C:\\code\\app' });
    expect(readRepoPath('\\\\server\\share\\app', { home: 'C:\\Users\\a', platform: 'win32' })).toMatchObject({ ok: true });
    expect(readRepoPath('//server/share/app', { home: 'C:\\Users\\a', platform: 'win32' })).toMatchObject({ ok: true });
  });
  it('keeps any other engine message, with the home dir as ~', () => {
    expect(onboardFailure('boom at /Users/alice/x', '/Users/alice')).toEqual({ error: 'boom at ~/x' });
  });
  it('names an unknown tool without inventing an install command', () => {
    const f = onboardFailure("phase 'x' requires tool 'frob' (not found on PATH …)", '/h');
    expect(f).toMatchObject({ code: 'tool_missing', tool: 'frob' });
    expect(f.error).not.toContain('npx');
  });
});
