// F-2R2-010: an onboarding run's seat pool is the seats its WORKFLOW can use. Onboarding is two tool
// phases routed to the `wicked-estate` executor, so its run carries `clis: []` — not the whole
// roster dressed as a 5-seat run with four signed-out seats. Real adapter over the stub engine in a
// mkdtemp; the launch itself is stubbed so the test pins exactly what the engine is handed.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchOptions } from 'wicked-core-ts';

import { CoreAdapter } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let priorOverlayDir: string | undefined;
let adapter: CoreAdapter;
let launched: LaunchOptions[];

function stubCore(a: CoreAdapter, name: string, impl: unknown) {
  (a as unknown as { core: Record<string, unknown> }).core[name] = impl;
}

const ROSTER = [
  { key: 'claude', display_name: 'Claude Code', binary: 'claude', headless_invocation: 'claude -p {PROMPT}' },
  { key: 'codex', display_name: 'Codex', binary: 'codex', headless_invocation: 'codex exec {PROMPT}' },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'onboarding-seats-'));
  priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
  process.env['WICKED_WORKFLOWS_DIR'] = join(dir, 'workflows');
  mkdirSync(process.env['WICKED_WORKFLOWS_DIR'], { recursive: true });
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  launched = [];
  stubCore(adapter, 'registerWorkflow', () => Promise.resolve('ok'));
  stubCore(adapter, 'launchRun', (opts: LaunchOptions) => {
    launched.push(opts);
    return Promise.resolve(opts.sessionId);
  });
  vi.spyOn(CoreAdapter, 'roster').mockReturnValue(ROSTER.map((s) => ({ ...s })));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (priorOverlayDir === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
  else process.env['WICKED_WORKFLOWS_DIR'] = priorOverlayDir;
  adapter.close();
  removeScratch(dir);
});

describe('seatsForWorkflow', () => {
  it('a workflow whose every phase is a tool executor (onboarding) gets NO seats', () => {
    const def = adapter.getWorkflow('onboarding') as WorkflowDef;
    expect(def.phases.every((p) => p.executor?.type === 'tool')).toBe(true);
    expect(adapter.seatsForWorkflow('onboarding')).toEqual([]);
  });

  it('a workflow with an agent phase keeps the full roster, and so does an unknown workflow (the engine names it)', () => {
    expect(adapter.seatsForWorkflow('feature')).toEqual(ROSTER);
    expect(adapter.seatsForWorkflow('no-such-workflow')).toEqual(ROSTER);
  });

  it('F-RECON-002/003: once the daemon wires a roster provider, agent workflows get the roster WITH standing (launchRun then benches council_eligible:false); tool-only stays []', () => {
    const standing = ROSTER.map((s) => (s.key === 'codex' ? { ...s, auth: 'signed_out', council_eligible: false } : { ...s, council_eligible: true }));
    expect(adapter.launchRoster()).toEqual(ROSTER); // no provider yet → the raw registry
    adapter.setRosterProvider(() => standing.map((s) => ({ ...s })));
    expect(adapter.launchRoster()).toEqual(standing);
    expect(adapter.seatsForWorkflow('feature')).toEqual(standing);
    expect(adapter.seatsForWorkflow('no-such-workflow')).toEqual(standing);
    expect(adapter.seatsForWorkflow('onboarding')).toEqual([]);
  });
});

describe('launchOnboardingRun', () => {
  it('hands the engine `clis: []` for the tool-routed onboarding workflow (F-2R2-010)', async () => {
    const runId = await adapter.launchOnboardingRun('repo-1', 'alpha');
    expect(launched).toHaveLength(1);
    const opts = launched[0]!;
    expect(opts.sessionId).toBe(runId);
    expect(opts.repoRef).toBe('repo-1');
    expect(opts.problem).toBe('Onboard repository: alpha');
    expect(JSON.parse(opts.clisJson)).toEqual([]);
    // The daemon remembers which repo the run was for — the completion hook's key.
    expect(adapter.getOnboardRunId('repo-1')).toBe(runId);
    expect(adapter.onboardedRepoOf(runId)).toBe('repo-1');
    expect(adapter.onboardedRepoOf('some-other-run')).toBeUndefined();
  });
});
