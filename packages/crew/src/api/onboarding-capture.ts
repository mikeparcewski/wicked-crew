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
 *   - Never the person's to answer (crew#1365): nobody started the chained capture, so when it stops at a gate (a
 *     small repository's first step has nothing to review, and its floor escalates) crew stops it and says why in
 *     one line, on its `run.cancelled` audit entry as the onboarding actor. Only a capture the chain launched: this
 *     daemon's (registered under its minted id before the launch, so a gate that comes first is not missed), or one
 *     whose launch entry on the trail says so (after a restart). One already parked when the daemon starts stays.
 */

import { randomUUID } from 'node:crypto';
import type { CoreAdapter } from '../core/adapter.js';
import type { Actor, CoreEvent } from '../core/types.js';
import type { AuditLog } from './audit.js';
import { recordRunLaunched, type RunTimingIndex } from './run-timing-index.js';
import { scrubEvidence } from './seat-scrub.js';
import { scrubHomePaths } from './ui-text.js';

/** One line of engine text for the stop line: home paths and secrets masked, whitespace folded. */
function scrubbed(text: string): string {
  return scrubEvidence(scrubHomePaths(text)).replace(/\s+/gu, ' ').trim();
}

/** The workflow a completed onboarding chains to (the engine's built-in preset). */
export const CAPTURE_LEARNINGS_WORKFLOW = 'capture-learnings';
/** Who launched a chained capture (the launch entry's actor). */
export const ONBOARDING_CHAIN_ACTOR: Actor = { id: 'onboarding', kind: 'system', trust: 'operator' };

export interface OnboardingCaptureDeps {
  adapter: Pick<CoreAdapter, 'onboardedRepoOf' | 'seatsForWorkflow' | 'launchRun' | 'getSettings' | 'listRepos' | 'cancelRun'>;
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
  /** crew#1365: the captures this chain launched and not yet seen end → their repository's name. */
  private readonly launched = new Map<string, string>();
  /** crew#1365: the chain's captures seen end (a stale gate frame after it stops nothing). One per capture. */
  private readonly ended = new Set<string>();
  /** crew#1365: the captures being stopped, or stopped and not yet seen end (one stop per capture). */
  private readonly stopping = new Set<string>();
  /** (core#1799, train-12 cert) The review's own words when a capture's step escalated (`gateEscalated.verdictSummary`),
   *  by run, with the step's ord: the stop line says why the review failed, not only that it did. */
  private readonly verdicts = new Map<string, { ord: unknown; summary: string }>();

  constructor(private readonly deps: OnboardingCaptureDeps) {}

  /** Fold one engine frame: an onboarding completion queues a capture; a capture's end frees the slot. */
  onEvent(event: CoreEvent): void {
    const session = (event as { session?: unknown }).session;
    if (typeof session !== 'string') return;
    if (event.type === 'sessionCompleted' && this.deps.adapter.onboardedRepoOf(session) !== undefined) {
      if (!this.pending.includes(session) && session !== this.launchingFor) this.pending.push(session);
    }
    const terminal = event.type === 'sessionCompleted' || event.type === 'sessionFailed' || event.type === 'runCancelled';
    const owned = this.launched.has(session) || this.deps.runTimingIndex.isOnboardingCapture(session);
    // A review's words belong to the escalation they came with: a newer escalation replaces them (or clears them when it
    // has none), and a step that runs again (`resumed`, `unitDispatched`) clears them (xreview r1 on #1831).
    const type = event.type as string;
    if (type === 'gateEscalated' && owned && !this.ended.has(session)) {
      const ev = event as unknown as Record<string, unknown>;
      const summary = ev['verdictSummary'];
      if (typeof summary === 'string' && summary.trim() !== '') this.verdicts.set(session, { ord: ev['ord'], summary });
      else this.verdicts.delete(session);
    }
    if (type === 'resumed' || type === 'unitDispatched') this.verdicts.delete(session);
    if (event.type === 'awaitingHuman' && owned && !this.ended.has(session)) void this.stopParked(session, event);
    if (terminal && owned) { this.launched.delete(session); this.stopping.delete(session); this.verdicts.delete(session); this.ended.add(session); }
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

  /**
   * crew#1365: a capture this chain launched stopped at a gate. Nobody started it, so it never asks a person: crew stops
   * it, with the gate and its prompt in one line on the audit entry. A stop the engine refuses is logged; the run then
   * waits as before. Never throws.
   */
  private async stopParked(runId: string, event: CoreEvent): Promise<void> {
    if (this.stopping.has(runId)) return;
    this.stopping.add(runId);
    const repo = this.launched.get(runId) ?? 'the repository';
    const ev = event as unknown as Record<string, unknown>;
    const gate = typeof ev['gateKind'] === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/u.test(ev['gateKind']) ? ev['gateKind'].replace(/[_-]+/gu, ' ') : 'a gate';
    // (core#1799 cert) When its review failed (an `escalation` this run's last `gateEscalated` came with, same ord), the
    // line says what the review said, and the gate's sentence loses the answers it offers a person: nobody answers this
    // one. Every other gate keeps its prompt as it was. Both are scrubbed (home paths, secrets) before they are cut: the
    // line is stored on the audit trail and logged (xreview r1 on #1831).
    const verdict = this.verdicts.get(runId);
    this.verdicts.delete(runId);
    const reviewed = verdict !== undefined && ev['gateKind'] === 'escalation' && verdict.ord === ev['ord'];
    const raw = typeof ev['prompt'] === 'string' ? ev['prompt'] : '';
    const prompt = scrubbed(reviewed ? raw.split(/ — | \[engine gate/u)[0]! : raw).slice(0, 200);
    // Its first line (the verdict) is the gate's sentence already: only the review's own words follow it.
    const lines = reviewed ? verdict.summary.split('\n') : [];
    if (lines.length > 1 && prompt.includes(lines[0]!.trim())) lines.shift();
    const said = scrubbed(lines.join(' ')).slice(0, 400);
    const head = `Capture learnings from ${repo} stopped at ${gate}${prompt !== '' ? ` (${prompt})` : ''}: onboarding started it, so crew ends it rather than ask you.`;
    const reason = `${head}${said !== '' ? ` Its review said: “${said}”` : ''} Run Capture learnings yourself to try again.`;
    try {
      const status = await this.deps.adapter.cancelRun(runId);
      this.deps.audit.record('run.cancelled', ONBOARDING_CHAIN_ACTOR, { runId, detail: { status, reason } });
      this.deps.log(`[onboarding] ${reason}`);
      // Stopped: a replayed gate frame before its end frame stops nothing more (the end frame clears it).
    } catch (err) {
      // Not stopped: the next gate frame for it tries again.
      this.stopping.delete(runId);
      this.deps.log(`[onboarding] capture-learnings ${runId} stopped at ${gate}; crew could not end it: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    // Registered under its minted id BEFORE the launch: a gate it reaches before `launchRun` answers is still crew's.
    const sessionId = randomUUID();
    this.launched.set(sessionId, repoName);
    let runId: string;
    try {
      runId = await adapter.launchRun({
        problem: `Capture learnings from ${repoName}`,
        sessionId,
        clisJson: JSON.stringify(await adapter.seatsForWorkflow(CAPTURE_LEARNINGS_WORKFLOW)),
        workflow: CAPTURE_LEARNINGS_WORKFLOW,
        repoRef,
        ...(projectId !== undefined ? { projectId } : {}),
      });
    } catch (err) {
      this.launched.delete(sessionId);
      throw err;
    }
    if (runId !== sessionId) this.launched.delete(sessionId);
    recordRunLaunched(this.deps.audit, runTimingIndex, ONBOARDING_CHAIN_ACTOR, runId, {
      workflow: CAPTURE_LEARNINGS_WORKFLOW,
      repoRef,
      chainedFrom: onboardRun,
      deliver: 'none',
      ...(projectId !== undefined ? { projectId } : {}),
    });
    // A capture that already ended while its launch was answered has nothing left to stop.
    if (!this.endedWhileLaunching.has(runId)) this.launched.set(runId, repoName);
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
