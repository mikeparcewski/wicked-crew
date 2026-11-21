import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StallWatchdogDeps } from '../src/api/stall-watchdog.js';
import type { registerTeamRoutes } from '../src/team/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { removeScratch } from './setup/scratch.js';

const captured = vi.hoisted(() => ({ watchdog: undefined as StallWatchdogDeps | undefined, exclusive: undefined as Parameters<typeof registerTeamRoutes>[3]['exclusive'] | undefined, startOutcome: undefined as Promise<unknown> | undefined }));
vi.mock('../src/api/stall-watchdog.js', async (original) => {
  const mod = await original<typeof import('../src/api/stall-watchdog.js')>();
  return { ...mod, WorkerStallWatchdog: class extends mod.WorkerStallWatchdog {
    constructor(deps: StallWatchdogDeps) { super(deps); captured.watchdog = deps; }
    override start(): void {
      // Escalate at the earliest possible moment to catch a start before route registration.
      captured.startOutcome = captured.watchdog!.escalation!.reassign('r', 4, 'codex').then(() => undefined, (err: unknown) => err);
    }
  } };
});
vi.mock('../src/team/routes.js', async (original) => {
  const mod = await original<typeof import('../src/team/routes.js')>();
  return { ...mod, registerTeamRoutes: (...args: Parameters<typeof mod.registerTeamRoutes>) => {
    captured.exclusive = args[3].exclusive; return mod.registerTeamRoutes(...args);
  } };
});
describe('watchdog decision lock', () => {
  it('arms only after the registered decision lock is available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-start-'));
    const run = { session: { id: 'r', status: 'executing', unit_ix: 0 }, units: [{ ord: 4, status: 'running', phase_ref: 'build' }] };
    const adapter = { stub: true, projectsSupported: () => false, getSettings: async () => ({}),
      onLaunch: () => () => undefined, onEvent: () => () => undefined,
      sessionsDetail: async () => [run], runView: vi.fn(async () => run), listRepos: async () => [],
      reassignUnit: vi.fn(async () => undefined) };
    captured.startOutcome = undefined;
    const app = await createServer(adapter as unknown as CoreAdapter, { auth: { mode: 'off' }, auditPath: join(dir, 'audit.log'),
      projectEvents: { disabled: true }, interactiveWsRelay: { disabled: true }, stallWatchdog: { enabled: true }, studioRoot: join(dir, 'no-studio') });
    try {
      expect(captured.startOutcome).toBeDefined();
      expect(await captured.startOutcome).toBeUndefined();
      expect(adapter.reassignUnit).toHaveBeenCalledExactlyOnceWith('r', 4, 'codex');
    } finally { await app.close(); removeScratch(dir); }
  });
  it.each(['awaiting_human', 'executing'])('waits for a decision and refuses after status/cursor moved (%s)', async (status) => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-lock-'));
    const run = { session: { id: 'r', status: 'executing', unit_ix: 0 }, units: [{ ord: 4, status: 'running', phase_ref: 'build' }] };
    const adapter = { stub: true, projectsSupported: () => false, getSettings: async () => ({}),
      onLaunch: () => () => undefined, onEvent: () => () => undefined,
      sessionsDetail: async () => [run], runView: vi.fn(async () => run), listRepos: async () => [],
      reassignUnit: vi.fn(async () => undefined) };
    const app = await createServer(adapter as unknown as CoreAdapter, { auth: { mode: 'off' }, auditPath: join(dir, 'audit.log'),
      projectEvents: { disabled: true }, interactiveWsRelay: { disabled: true }, stallWatchdog: { enabled: false }, studioRoot: join(dir, 'no-studio') });
    let release!: () => void;
    try {
      const exclusive = captured.exclusive!;
      expect(exclusive).toBeTypeOf('function');
      const held = exclusive('r', async () => { await new Promise<void>((r) => { release = r; }); run.session.status = status; run.units[0]!.ord = 5; });
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const reassign = captured.watchdog!.escalation!.reassign('r', 4, 'codex');
      const outcome = reassign.then(() => undefined, (err: unknown) => err);
      await Promise.resolve(); await Promise.resolve();
      expect(adapter.runView).not.toHaveBeenCalled();
      expect(adapter.reassignUnit).not.toHaveBeenCalled();
      release(); await held;
      expect(await outcome).toBeInstanceOf(Error);
      expect(String(await outcome)).toMatch(/moved on.*(status|cursor).*nothing.*reassigned/i);
      expect(adapter.reassignUnit).not.toHaveBeenCalled();
    } finally { release?.(); await app.close(); removeScratch(dir); }
  });
});
