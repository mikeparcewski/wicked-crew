// crew#1145: a warm boot spent 50.6 s in the `skills` stage (the walk and hash of the current
// generation, run twice, synchronously) before the daemon listened. `wicked-crew serve` now listens
// first and runs the skills ladder in the background (`skills.background`): the seam reports
// `publishing` until it lands, and every engine launch waits for it, so the FIRST launch still reads
// the snapshot the ladder exported — never an unset engine input.
//
// Hermetic like boot-stages.test.ts: a stub engine, the fixture plugin, an injected provisioner
// held open so the ladder is observably in flight.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type StartedServer } from '../src/api/server.js';
import { CoreAdapter, type LaunchNotice } from '../src/core/adapter.js';
import { DEFAULT_SETTINGS } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { pluginSourceAt } from '../src/skills/plugin-source.js';
import type { VenvProvisioner } from '../src/skills/venv.js';
import { removeScratch } from './setup/scratch.js';
import { FIXTURE_PLUGIN } from './support/skills-fixture.js';

const savedSnapshotEnv = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
const armedStateHome = crewStateHome();

describe('skills boot off the critical path (crew#1145)', () => {
  let dir: string;
  let adapter: CoreAdapter;
  const started: StartedServer[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-skills-bg-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    adapter.listWorkflows = () => [];
    adapter.getSettings = async () => ({ ...DEFAULT_SETTINGS });
    setCrewStateHome(dir);
    delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  });

  afterEach(async () => {
    for (const s of started.splice(0)) await s.app.close();
    adapter.close();
    if (savedSnapshotEnv === undefined) delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
    else process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = savedSnapshotEnv;
    setCrewStateHome(armedStateHome);
    removeScratch(dir);
  });

  it('the daemon listens while the ladder runs: skills read "publishing", a launch waits, and the first launch is handed the exported snapshot', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const provisioner: VenvProvisioner = async (baselineDir) => {
      await held; // the first publish is in flight until the test lets it finish
      mkdirSync(join(baselineDir, '.venv', 'bin'), { recursive: true });
      writeFileSync(join(baselineDir, '.venv', 'bin', 'python'), '#!/bin/sh\n');
      return 'synced';
    };
    const s = await startServer(adapter, 0, '127.0.0.1', {
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      auditPath: join(dir, 'audit.log'),
      studioRoot: join(dir, 'no-studio'),
      skills: { source: () => pluginSourceAt(FIXTURE_PLUGIN), provisionVenv: provisioner, background: true },
    });
    started.push(s);
    expect(s.port).toBeGreaterThan(0); // listening with the ladder still held

    const diag = await s.app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
    expect(diag.statusCode).toBe(200);
    expect((diag.json() as { skills: { state: string } }).skills.state).toBe('publishing');
    expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBeUndefined();

    // A launch made now waits at the gate: no `handed` notice, no engine call, until the ladder lands.
    const handed: Array<{ notice: LaunchNotice; engineInput: string | undefined }> = [];
    adapter.onLaunch((notice) => {
      if (notice.status === 'handed') handed.push({ notice, engineInput: process.env[SKILLS_SNAPSHOT_ENGINE_ENV] });
    });
    const resume = adapter.resumeRun('no-such-run').catch(() => 'refused');
    await new Promise((r) => setTimeout(r, 100));
    expect(handed).toEqual([]);

    release();
    await s.app.skillsBootSettled?.();
    const after = await s.app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
    const skills = (after.json() as { skills: { state: string; current: { gen: number } | null } }).skills;
    expect(skills.state).toBe('published');
    expect(skills.current?.gen).toBe(1);
    await resume;
    expect(handed).toHaveLength(1);
    // The safety claim: the first launch read the snapshot the ladder exported, not an unset input.
    expect(handed[0]?.engineInput?.endsWith(join('snapshots', '000001'))).toBe(true);
  });

  it('a warm background boot verifies the current generation once and exports it', async () => {
    const opts = {
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      auditPath: join(dir, 'audit.log'),
      studioRoot: join(dir, 'no-studio'),
    };
    const noop: VenvProvisioner = async (baselineDir) => {
      mkdirSync(join(baselineDir, '.venv', 'bin'), { recursive: true });
      writeFileSync(join(baselineDir, '.venv', 'bin', 'python'), '#!/bin/sh\n');
      return 'synced';
    };
    const first = await startServer(adapter, 0, '127.0.0.1', { ...opts, skills: { source: () => pluginSourceAt(FIXTURE_PLUGIN), provisionVenv: noop } });
    await first.app.close();
    delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];

    const second = await startServer(adapter, 0, '127.0.0.1', { ...opts, skills: { source: () => pluginSourceAt(FIXTURE_PLUGIN), provisionVenv: noop, background: true } });
    started.push(second);
    await second.app.skillsBootSettled?.();
    const diag = await second.app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
    expect((diag.json() as { skills: { state: string } }).skills.state).toBe('published');
    expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]?.endsWith(join('snapshots', '000001'))).toBe(true);
  });
});
