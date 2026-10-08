// crew#552: a completed onboarding run chains capture-learnings for its repo — filed in the
// onboarding run's project, roster with standing, `chainedFrom` on the launch entry (DTO
// `chained_from`, a `runChained` frame) — once per completion (a resume's re-terminal and a restart
// launch nothing more), never after a failed onboarding, never when switched off, one at a time.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../src/api/audit.js';
import { CAPTURE_LEARNINGS_WORKFLOW, OnboardingCaptureChain } from '../src/api/onboarding-capture.js';
import { RunTimingIndex, recordRunLaunched } from '../src/api/run-timing-index.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeScratch(d);
});

const settle = () => new Promise((r) => setTimeout(r, 10));
const frame = (type: string, session: string) => ({ type, session }) as unknown as CoreEvent;

function harness(opts: { autoCapture?: boolean; audit?: AuditLog; index?: RunTimingIndex; projectAutoCapture?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-chain-'));
  dirs.push(dir);
  const audit = opts.audit ?? new AuditLog(join(dir, 'audit.log'), () => undefined);
  const runTimingIndex = opts.index ?? new RunTimingIndex();
  const launches: Array<Record<string, unknown>> = [];
  const filed: Array<[string, string]> = [];
  const frames: Array<Record<string, unknown>> = [];
  const onboarded = new Map([['onb-1', 'repo-a'], ['onb-2', 'repo-b'], ['onb-3', 'repo-a']]);
  const adapter = {
    onboardedRepoOf: (runId: string) => onboarded.get(runId),
    seatsForWorkflow: async (id: string) => [{ key: 'claude', for: id }],
    launchRun: async (input: Record<string, unknown>) => {
      launches.push(input);
      return `cap-${launches.length}`;
    },
    getSettings: async () => ({ ...(opts.autoCapture !== undefined ? { onboardingAutoCapture: opts.autoCapture } : {}) }),
    listRepos: async () => [{ id: 'repo-a', name: 'alpha' }, { id: 'repo-b', name: 'beta' }],
  } as unknown as CoreAdapter;
  const chain = new OnboardingCaptureChain({
    adapter,
    runTimingIndex,
    audit,
    projectOf: (runId) => (runId === 'onb-1' ? 'proj-1' : undefined),
    projectAutoCapture: (projectId) => (projectId === 'proj-1' ? opts.projectAutoCapture : undefined),
    fileRun: (runId, projectId) => filed.push([runId, projectId]),
    broadcast: (f) => frames.push(f as unknown as Record<string, unknown>),
    log: () => undefined,
  });
  return { chain, audit, runTimingIndex, launches, filed, frames };
}

describe('crew#552 — onboarding → capture-learnings', () => {
  it('a completed onboarding launches ONE capture for its repo, filed in its project, with the roster for the workflow; the chain is recorded and announced', async () => {
    const h = harness();
    h.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    await settle();
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]).toMatchObject({ workflow: CAPTURE_LEARNINGS_WORKFLOW, repoRef: 'repo-a', projectId: 'proj-1', problem: 'Capture learnings from alpha' });
    expect(JSON.parse(String(h.launches[0]!['clisJson']))).toEqual([{ key: 'claude', for: 'capture-learnings' }]);
    expect(h.filed).toEqual([['cap-1', 'proj-1']]);
    expect(h.frames).toEqual([{ type: 'runChained', session: 'cap-1', from: 'onb-1', workflow: 'capture-learnings', project_id: 'proj-1' }]);
    expect(h.runTimingIndex.chainedFromOf('cap-1')).toBe('onb-1');
    expect(h.runTimingIndex.chainedRunOf('onb-1')).toBe('cap-1');
    // A resume's second terminal frame for the same onboarding launches nothing.
    h.chain.onEvent(frame('sessionCompleted', 'cap-1'));
    h.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    await settle();
    expect(h.launches).toHaveLength(1);
  });

  it('after a restart the launch entry is read back: the same onboarding chains nothing, the DTO still names its source', async () => {
    const first = harness();
    first.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    await settle();
    await first.audit.flush();
    const index = new RunTimingIndex();
    index.hydrateFromLaunchEntries(await first.audit.readAll({ action: 'run.launched' }));
    expect(index.chainedFromOf('cap-1')).toBe('onb-1');
    const restarted = harness({ audit: first.audit, index });
    restarted.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    await settle();
    expect(restarted.launches).toEqual([]);
  });

  it('a failed or cancelled onboarding, a run that is not an onboarding, the setting off, or autoCapture:false at launch: nothing', async () => {
    const h = harness();
    h.chain.onEvent(frame('sessionFailed', 'onb-1'));
    h.chain.onEvent(frame('runCancelled', 'onb-2'));
    h.chain.onEvent(frame('sessionCompleted', 'other-run'));
    await settle();
    expect(h.launches).toEqual([]);

    const off = harness({ autoCapture: false });
    off.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    await settle();
    expect(off.launches).toEqual([]);

    const oneOff = harness();
    recordRunLaunched(oneOff.audit, oneOff.runTimingIndex, { id: 'op', kind: 'human', trust: 'operator' } as never, 'onb-2', { workflow: 'onboarding', repoRef: 'repo-b', autoCapture: false });
    oneOff.chain.onEvent(frame('sessionCompleted', 'onb-2'));
    await settle();
    expect(oneOff.launches).toEqual([]);
  });

  it('a project\'s own override wins over the daemon setting, both ways', async () => {
    const projOff = harness({ projectAutoCapture: false });
    projOff.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    projOff.chain.onEvent(frame('sessionCompleted', 'onb-2')); // not in a project: the setting (on)
    await settle();
    expect(projOff.launches.map((l) => l['repoRef'])).toEqual(['repo-b']);
    const projOn = harness({ autoCapture: false, projectAutoCapture: true });
    projOn.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    await settle();
    expect(projOn.launches.map((l) => l['repoRef'])).toEqual(['repo-a']);
  });

  it('one chained capture at a time: the next launches when the running one ends; a re-index is a new onboarding and gets its own capture', async () => {
    const h = harness();
    h.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    h.chain.onEvent(frame('sessionCompleted', 'onb-2'));
    await settle();
    expect(h.launches.map((l) => l['repoRef'])).toEqual(['repo-a']);
    h.chain.onEvent(frame('sessionFailed', 'cap-1'));
    await settle();
    expect(h.launches.map((l) => l['repoRef'])).toEqual(['repo-a', 'repo-b']);
    h.chain.onEvent(frame('sessionCompleted', 'cap-2'));
    h.chain.onEvent(frame('sessionCompleted', 'onb-3')); // re-index of repo-a
    await settle();
    expect(h.launches.map((l) => l['repoRef'])).toEqual(['repo-a', 'repo-b', 'repo-a']);
    expect(h.runTimingIndex.chainedRunOf('onb-3')).toBe('cap-3');
  });

  it('codex on #552: a capture that ends before launchRun answers frees the slot; a duplicate completion during the launch is not queued again', async () => {
    const h = harness();
    let release: (id: string) => void = () => undefined;
    const adapter = (h.chain as unknown as { deps: { adapter: { launchRun: unknown } } }).deps.adapter;
    adapter.launchRun = (input: Record<string, unknown>) => {
      h.launches.push(input);
      return new Promise<string>((r) => { release = r; });
    };
    h.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    await settle();
    h.chain.onEvent(frame('sessionCompleted', 'onb-1')); // duplicate while launching
    h.chain.onEvent(frame('sessionCompleted', 'onb-2'));
    h.chain.onEvent(frame('sessionCompleted', 'cap-fast')); // the capture already ended
    release('cap-fast');
    await settle();
    adapter.launchRun = async (input: Record<string, unknown>) => {
      h.launches.push(input);
      return `cap-${h.launches.length}`;
    };
    await settle();
    // onb-1 launched once; the slot was free at once, so onb-2 launched next.
    expect(h.launches.map((l) => l['repoRef'])).toEqual(['repo-a', 'repo-b']);
  });
});
