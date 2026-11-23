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
  const cancels: string[] = [];
  const logs: string[] = [];
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
    cancelRun: async (runId: string) => {
      cancels.push(runId);
      if (runId === 'cap-refused') throw new Error('the engine refused the stop');
      return 'cancelled';
    },
  } as unknown as CoreAdapter;
  const chain = new OnboardingCaptureChain({
    adapter,
    runTimingIndex,
    audit,
    projectOf: (runId) => (runId === 'onb-1' ? 'proj-1' : undefined),
    projectAutoCapture: (projectId) => (projectId === 'proj-1' ? opts.projectAutoCapture : undefined),
    fileRun: (runId, projectId) => filed.push([runId, projectId]),
    broadcast: (f) => frames.push(f as unknown as Record<string, unknown>),
    log: (m) => logs.push(m),
  });
  return { chain, audit, runTimingIndex, launches, filed, frames, cancels, logs };
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

  it('crew#1365: a capture onboarding started that stops at a gate is ended by crew, saying why in one line; it never waits on the person', async () => {
    const h = harness();
    h.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    await settle();
    expect(h.launches).toHaveLength(1);
    // A run nobody chained, parked at a gate: the person's, as before.
    h.chain.onEvent({ type: 'awaitingHuman', session: 'someone-elses', gateKind: 'escalation' } as unknown as CoreEvent);
    // The small repository's first step had nothing to review; its floor escalated.
    const parked = { type: 'awaitingHuman', session: 'cap-1', ord: 1, gateKind: 'escalation', prompt: 'phase produced no reviewable\nsubstance' } as unknown as CoreEvent;
    h.chain.onEvent(parked);
    h.chain.onEvent(parked); // the same frame again (a replay): one stop
    await settle();
    expect(h.cancels).toEqual(['cap-1']);
    // A replay after the stop took, before its end frame: still one (review r1).
    h.chain.onEvent(parked);
    await settle();
    expect(h.cancels).toEqual(['cap-1']);
    await h.audit.flush();
    const lines = await h.audit.readAll({ action: 'run.cancelled' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      runId: 'cap-1',
      actor: { id: 'onboarding', kind: 'system' },
      detail: { status: 'cancelled', reason: 'Capture learnings from alpha stopped at escalation (phase produced no reviewable substance): onboarding started it, so crew ends it rather than ask you. Run Capture learnings yourself to try again.' },
    });
    // Its end frees the slot, and a later frame for it stops nothing more.
    h.chain.onEvent(frame('runCancelled', 'cap-1'));
    h.chain.onEvent(parked);
    await settle();
    expect(h.cancels).toEqual(['cap-1']);
  });

  it('core#1799 (train-12 cert): a capture whose review failed is ended with what the review said, never the answers nobody gives', async () => {
    const h = harness();
    h.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    await settle();
    // The engine's own frames, in their order (cert run 3b395499: gateEscalated, then awaitingHuman, same ord).
    h.chain.onEvent({
      type: 'gateEscalated', session: 'cap-1', ord: 5, condition: 'verdict_not_pass', denialSource: 'evaluator_verdict',
      verdictSummary: "the evaluator's verdict is FAIL\nEvaluator review; no repository files changed.\n\nThe capture report counts 4 proposals but two cite no source.",
    } as unknown as CoreEvent);
    h.chain.onEvent({
      type: 'awaitingHuman', session: 'cap-1', ord: 5, gateKind: 'escalation',
      prompt: "Unit 5 verdict is NOT PASS (the evaluator's verdict is FAIL) — confirm to retry the phase, request changes to send the review back to the creator phase, or reject to cancel the run [engine gate: a denied unit pauses for a decision instead of failing the run (core#464)]",
    } as unknown as CoreEvent);
    await settle();
    expect(h.cancels).toEqual(['cap-1']);
    await h.audit.flush();
    const lines = await h.audit.readAll({ action: 'run.cancelled' });
    expect(lines).toHaveLength(1);
    const reason = String((lines[0]!.detail as Record<string, unknown>)['reason']);
    expect(reason).toBe(
      "Capture learnings from alpha stopped at escalation (Unit 5 verdict is NOT PASS (the evaluator's verdict is FAIL)): onboarding started it, so crew ends it rather than ask you. Its review said: “Evaluator review; no repository files changed. The capture report counts 4 proposals but two cite no source.” Run Capture learnings yourself to try again.",
    );
    expect(reason).not.toMatch(/confirm to retry|request changes|reject to cancel/u);
  });

  it('crew#1365: a stop the engine refuses is logged and leaves no audit line', async () => {
    const h = harness();
    const adapter = (h.chain as unknown as { deps: { adapter: { launchRun: unknown } } }).deps.adapter;
    adapter.launchRun = async (input: Record<string, unknown>) => { h.launches.push(input); return 'cap-refused'; };
    h.chain.onEvent(frame('sessionCompleted', 'onb-2'));
    await settle();
    h.chain.onEvent({ type: 'awaitingHuman', session: 'cap-refused', gateKind: 'escalation' } as unknown as CoreEvent);
    await settle();
    expect(h.cancels).toEqual(['cap-refused']);
    await h.audit.flush();
    expect(await h.audit.readAll({ action: 'run.cancelled' })).toEqual([]);
    expect(h.logs.some((l) => l.includes('cap-refused') && l.includes('the engine refused the stop'))).toBe(true);
    // The next gate frame tries again.
    h.chain.onEvent({ type: 'awaitingHuman', session: 'cap-refused', gateKind: 'escalation' } as unknown as CoreEvent);
    await settle();
    expect(h.cancels).toEqual(['cap-refused', 'cap-refused']);
  });

  it('crew#1365 review r1: after a restart the launch entry says the capture is the chain’s; a run a person launched never is', async () => {
    const first = harness();
    first.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    await settle();
    recordRunLaunched(first.audit, first.runTimingIndex, { id: 'local', kind: 'human', trust: 'admin' } as never, 'by-hand', { workflow: CAPTURE_LEARNINGS_WORKFLOW, repoRef: 'repo-a', chainedFrom: 'onb-1' });
    await first.audit.flush();
    const index = new RunTimingIndex();
    index.hydrateFromLaunchEntries(await first.audit.readAll({ action: 'run.launched' }));
    const restarted = harness({ audit: first.audit, index });
    restarted.chain.onEvent({ type: 'awaitingHuman', session: 'by-hand', gateKind: 'escalation' } as unknown as CoreEvent);
    restarted.chain.onEvent({ type: 'awaitingHuman', session: 'cap-1', gateKind: 'escalation' } as unknown as CoreEvent);
    await settle();
    expect(restarted.cancels).toEqual(['cap-1']);
  });

  it('crew#1365 review r1: a gate the capture reaches before its launch answers is still the chain’s', async () => {
    const h = harness();
    const adapter = (h.chain as unknown as { deps: { adapter: { launchRun: unknown } } }).deps.adapter;
    adapter.launchRun = async (input: Record<string, unknown>) => {
      h.launches.push(input);
      h.chain.onEvent({ type: 'awaitingHuman', session: input['sessionId'], gateKind: 'escalation' } as unknown as CoreEvent);
      return String(input['sessionId']);
    };
    h.chain.onEvent(frame('sessionCompleted', 'onb-1'));
    await settle();
    expect(h.cancels).toEqual([String(h.launches[0]!['sessionId'])]);
  });
});
