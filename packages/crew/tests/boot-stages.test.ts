// crew#741: boot time swung 25 s → 194 s with host load and `startupMs` was one number, so nobody
// could say WHICH stage ate the seconds (35.8 s of one boot was the skills baseline `uv sync`).
// Now the daemon times its boot per EXCLUSIVE stage — `preflight` and `engine` (cli), then the
// server's `setup`, `skills`, `venv` (the provisioner's time, carved out of `skills`), `routes`,
// `studio`, `listen` — and hands the breakdown back from `startServer` (the `serve` ready line
// carries it as `stages`, summing to `startupMs`).
// And the acceptance that matters under load: a SECOND boot over an unchanged skills baseline —
// a new process, a new `SkillsStore` — re-runs no `uv sync`: the provisioner is not called and
// `venv` reads 0 ms, because the baseline env already carries its verified ready marker.
//
// Hermetic like settings-skills.test.ts: a stub engine, the fixture plugin as the source, an
// injected provisioner (a boot test never runs the host's `uv`), no studio bundle.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BootStageClock, startServer, type StartedServer } from '../src/api/server.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { DEFAULT_SETTINGS } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { pluginSourceAt } from '../src/skills/plugin-source.js';
import { noVenv, type VenvProvisioner } from '../src/skills/venv.js';
import { removeScratch } from './setup/scratch.js';
import { FIXTURE_PLUGIN } from './support/skills-fixture.js';

const SERVER_STAGES = ['setup', 'skills', 'venv', 'routes', 'studio', 'listen'];
const savedSnapshotEnv = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
const armedStateHome = crewStateHome();

describe('BootStageClock (crew#741)', () => {
  it('laps name the stage that ran since the previous lap, rounded to whole non-negative ms, in recording order; set records a stage measured elsewhere', () => {
    const clock = new BootStageClock();
    expect(clock.lap('setup')).toBeGreaterThanOrEqual(0);
    clock.set('venv', 12.6);
    clock.set('negative-clamped', -3);
    expect(clock.lap('routes')).toBeGreaterThanOrEqual(0);
    const stages = clock.snapshot();
    expect(Object.keys(stages)).toEqual(['setup', 'venv', 'negative-clamped', 'routes']);
    expect(stages['venv']).toBe(13);
    expect(stages['negative-clamped']).toBe(0);
    for (const ms of Object.values(stages)) expect(Number.isInteger(ms) && ms >= 0).toBe(true);
    expect(clock.describe()).toMatch(/^setup \d+ms · venv 13ms · negative-clamped 0ms · routes \d+ms$/);
    // The snapshot is a copy: a later lap does not reach into what was handed out.
    clock.lap('later');
    expect(Object.keys(stages)).toHaveLength(4);
  });
});

describe('daemon boot stages (crew#741): startServer hands back per-stage ms; a second boot over an unchanged baseline re-runs no uv sync', () => {
  let dir: string;
  let adapter: CoreAdapter;
  let provisions: string[];
  const started: StartedServer[] = [];

  /** A provisioner that records every call and lays down a minimal env — never the host's `uv`. */
  const provisioner: VenvProvisioner = async (baselineDir) => {
    provisions.push(baselineDir);
    mkdirSync(join(baselineDir, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(baselineDir, '.venv', 'bin', 'python'), '#!/bin/sh\n');
    return 'synced';
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-boot-stages-'));
    provisions = [];
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    adapter.listWorkflows = () => []; // the fixture catalog carries none of the built-in skill_refs (settings-skills.test.ts)
    adapter.getSettings = async () => ({ ...DEFAULT_SETTINGS });
    setCrewStateHome(dir); // what `serve --db <dir>/core.db` does
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

  const boot = async (skills: { disabled?: boolean; provisionVenv?: VenvProvisioner }): Promise<StartedServer> => {
    const s = await startServer(adapter, 0, '127.0.0.1', {
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      auditPath: join(dir, 'audit.log'),
      studioRoot: join(dir, 'no-studio'),
      skills: skills.disabled === true ? { disabled: true } : { source: () => pluginSourceAt(FIXTURE_PLUGIN), provisionVenv: skills.provisionVenv ?? noVenv },
    });
    started.push(s);
    return s;
  };

  it('the first boot provisions the baseline env once and reports every server stage; the SECOND boot (a new store over the same state home) calls no provisioner and reads venv 0 ms', async () => {
    const first = await boot({ provisionVenv: provisioner });
    expect(Object.keys(first.stages)).toEqual(SERVER_STAGES);
    for (const ms of Object.values(first.stages)) expect(Number.isInteger(ms) && ms >= 0).toBe(true);
    expect(provisions).toHaveLength(1); // the first publish provisioned the baseline env
    expect(first.port).toBeGreaterThan(0);
    // The clock the server decorated itself with agrees with what startServer handed back.
    expect(first.app.bootStages?.snapshot()).toEqual(first.stages);
    await first.app.close();
    started.splice(0);

    // A second daemon over the SAME state home: `ensureReady` finds `current` published and the
    // baseline env marked ready — nothing is provisioned, nothing re-synced, `venv` is 0 ms.
    const second = await boot({ provisionVenv: provisioner });
    expect(Object.keys(second.stages)).toEqual(SERVER_STAGES);
    expect(provisions).toHaveLength(1); // unchanged: the provisioner was never reached
    expect(second.stages['venv']).toBe(0);
    expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toMatch(/snapshots\/000001$/); // the same generation is handed to the engine
  });

  it('a boot with the skills seam disabled still reports the stages (skills and venv at 0 ms)', async () => {
    const s = await boot({ disabled: true });
    expect(Object.keys(s.stages)).toEqual(SERVER_STAGES);
    expect(s.stages['venv']).toBe(0);
    // No store, no publish: `skills` is the cost of the disabled branch itself — a wall-clock lap,
    // so no ceiling is asserted (a loaded host can deschedule between two laps; codex on #846).
    expect(Number.isInteger(s.stages['skills']) && (s.stages['skills'] ?? -1) >= 0).toBe(true);
    expect(provisions).toHaveLength(0);
  });
});
