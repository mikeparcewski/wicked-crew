/**
 * crew#552 (F-RC1-040; user decision 2026-09-13): onboarding a repo ends with its learnings
 * CAPTURED. When an onboarding run THIS daemon launched completes (`sessionCompleted`), the daemon
 * launches the `capture-learnings` workflow for the same repo — filed in the onboarding run's
 * project, with the roster WITH standing (`seatsForWorkflow`) — and records `chainedFrom` on its
 * launch entry (`AgentSession.chained_from`, a `runChained` frame on /ws). CAPTURE is automatic;
 * PROMOTION stays human-gated (proposals are inert until reviewed in Steering → Memories / Policies).
 *
 *   - OFF switches: the `onboardingAutoCapture` setting (`false`), or `autoCapture: false` on the
 *     `POST /repos` / `POST /repos/:id/onboard` that launched the onboarding run (a one-off).
 *   - Idempotent: one capture per onboarding completion — the launch entry's `chainedFrom` is read
 *     back after a restart, so a resume's second terminal frame launches nothing; a re-index is a
 *     new onboarding run and gets exactly one new capture. A failed onboarding launches nothing.
 *   - Serialized: one chained capture at a time (councils are the spikiest thing the platform does);
 *     the next waits for the running one's terminal frame.
 */

import { randomUUID } from 'node:crypto';
import type { CoreAdapter } from '../core/adapter.js';
import type { Actor, CoreEvent } from '../core/types.js';
import type { AuditLog } from './audit.js';
import { recordRunLaunched, type RunTimingIndex } from './run-timing-index.js';

/** The workflow a completed onboarding chains to (the engine's built-in preset). */
export const CAPTURE_LEARNINGS_WORKFLOW = 'capture-learnings';
/** Who launched a chained capture (the launch entry's actor). */
export const ONBOARDING_CHAIN_ACTOR: Actor = { id: 'onboarding', kind: 'system', trust: 'operator' };

export interface OnboardingCaptureDeps {
  adapter: Pick<CoreAdapter, 'onboardedRepoOf' | 'seatsForWorkflow' | 'launchRun' | 'getSettings' | 'listRepos'>;
  runTimingIndex: RunTimingIndex;
  audit: AuditLog;
  /** The project a run is filed in (the membership index), if any. */
  projectOf: (runId: string) => string | undefined;
  /** A project's own `autoCapture` override (crew-side project settings); `undefined` = none. */
  projectAutoCapture?: (projectId: string) => boolean | undefined;
  /** The post-commit half of a project-filed launch (index + membership event). */
  fileRun: (runId: string, projectId: string) => void;
  /** Where the `runChained` frame goes (/ws). */
  broadcast: (frame: CoreEvent) => void;
  log: (msg: string) => void;
}

export class OnboardingCaptureChain {
  /** Onboarding run ids waiting for their capture launch, in completion order. */
  private readonly pending: string[] = [];
  /** The chained capture run in flight (one at a time), or null. */
  private active: string | null = null;
  /** The onboarding run whose capture is being launched right now (never queued twice). */
  private launchingFor: string | null = null;
  /** Terminal frames seen while a launch was in flight: a capture that ended before `launchRun`
   *  answered must not hold the slot (codex on #552). */
  private readonly endedWhileLaunching = new Set<string>();

  constructor(private readonly deps: OnboardingCaptureDeps) {}

  /** Fold one engine frame: an onboarding completion queues a capture; a capture's end frees the slot. */
  onEvent(event: CoreEvent): void {
    const session = (event as { session?: unknown }).session;
    if (typeof session !== 'string') return;
    if (event.type === 'sessionCompleted' && this.deps.adapter.onboardedRepoOf(session) !== undefined) {
      if (!this.pending.includes(session) && session !== this.launchingFor) this.pending.push(session);
    }
    const terminal = event.type === 'sessionCompleted' || event.type === 'sessionFailed' || event.type === 'runCancelled';
    if (terminal && session === this.active) this.active = null;
    if (terminal && this.launchingFor !== null) this.endedWhileLaunching.add(session);
    void this.next();
  }

  /** Launch the next queued capture when the slot is free. Never throws. */
  private async next(): Promise<void> {
    if (this.launchingFor !== null || this.active !== null) return;
    const onboardRun = this.pending.shift();
    if (onboardRun === undefined) return;
    this.launchingFor = onboardRun;
    try {
      const runId = await this.launchFor(onboardRun);
      if (runId !== null && !this.endedWhileLaunching.has(runId)) this.active = runId;
    } catch (err) {
      this.deps.log(`[onboarding] capture-learnings after ${onboardRun} not launched: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.launchingFor = null;
      this.endedWhileLaunching.clear();
    }
    if (this.active === null) void this.next();
  }

  /** The capture launch for one completed onboarding run, or `null` when it is switched off or done. */
  private async launchFor(onboardRun: string): Promise<string | null> {
    const { adapter, runTimingIndex } = this.deps;
    const repoRef = adapter.onboardedRepoOf(onboardRun);
    if (repoRef === undefined) return null;
    if (runTimingIndex.chainedRunOf(onboardRun) !== undefined) return null; // already chained (a resume's re-terminal)
    if (runTimingIndex.autoCaptureOff(onboardRun)) {
      this.deps.log(`[onboarding] ${onboardRun}: autoCapture was false at launch — no capture-learnings run`);
      return null;
    }
    // A project's own override wins over the daemon setting.
    const projectId = this.deps.projectOf(onboardRun);
    const projectSays = projectId !== undefined ? this.deps.projectAutoCapture?.(projectId) : undefined;
    const on = projectSays ?? (await adapter.getSettings()).onboardingAutoCapture !== false;
    if (!on) {
      this.deps.log(`[onboarding] ${onboardRun}: auto-capture is off${projectSays === false ? ` for project ${projectId}` : ''} — no capture-learnings run`);
      return null;
    }
    const repoName = (await adapter.listRepos()).find((r) => r.id === repoRef)?.name ?? repoRef;
    const runId = await adapter.launchRun({
      problem: `Capture learnings from ${repoName}`,
      sessionId: randomUUID(),
      clisJson: JSON.stringify(await adapter.seatsForWorkflow(CAPTURE_LEARNINGS_WORKFLOW)),
      workflow: CAPTURE_LEARNINGS_WORKFLOW,
      repoRef,
      ...(projectId !== undefined ? { projectId } : {}),
    });
    recordRunLaunched(this.deps.audit, runTimingIndex, ONBOARDING_CHAIN_ACTOR, runId, {
      workflow: CAPTURE_LEARNINGS_WORKFLOW,
      repoRef,
      chainedFrom: onboardRun,
      deliver: 'none',
      ...(projectId !== undefined ? { projectId } : {}),
    });
    if (projectId !== undefined) this.deps.fileRun(runId, projectId);
    this.deps.broadcast({
      type: 'runChained',
      session: runId,
      from: onboardRun,
      workflow: CAPTURE_LEARNINGS_WORKFLOW,
      ...(projectId !== undefined ? { project_id: projectId } : {}),
    } as unknown as CoreEvent);
    this.deps.log(`[onboarding] ${onboardRun} completed → capture-learnings ${runId} for ${repoName}`);
    return runId;
  }
}
