import { createActor, fromPromise } from 'xstate';
import type Database from 'better-sqlite3';
import { buildSessionMachine, type PhaseResult } from './session-machine.js';
import { getWorkflowType } from './workflow-types.js';
import { saveSnapshot, loadSnapshot } from '../store/snapshots.js';
import { createSession, updateSessionStatus, createPhase, updatePhaseState, getSession, getPhase, listPhases, listActiveSessions } from '../store/sessions.js';
import { getWorker, listWorkers } from '../dispatch/workers.js';
import { dispatch, dispatchCouncil } from '../dispatch/dispatcher.js';
import { evaluateGate, buildGateFacts } from '../governance/engine.js';
import { builtInPolicies } from '../governance/built-in-policies/index.js';
import { emit } from '../events/bus.js';
import type { GateKind } from '../store/types.js';
import { randomUUID } from 'node:crypto';

export interface StartSessionOpts {
  type: string;
  goal: string;
  workers?: string[];
  phaseGateOverrides?: Record<string, GateKind>;
}

interface HumanGateResolution {
  decision: 'approved' | 'rejected';
  conditions?: string;
}

// Deferred promises for human gate approvals, keyed by "sessionId:phaseId"
const pendingHumanGates = new Map<string, (result: HumanGateResolution) => void>();

// Sessions whose next phase should pause before dispatching
const pauseRequested = new Set<string>();

// One live actor per session. Creating a new actor for a session stops and
// replaces any existing one, so no session can ever have two concurrent actors
// (prevents duplicate dispatch + orphaned human-gate promises on repeated resume).
const actors = new Map<string, ReturnType<typeof createActor>>();

function gateKey(sessionId: string, phaseId: string): string {
  return `${sessionId}:${phaseId}`;
}

export function pauseSession(sessionId: string): void {
  pauseRequested.add(sessionId);
}

export function resolveHumanGate(
  sessionId: string,
  phaseId: string,
  decision: 'approved' | 'rejected',
  conditions?: string,
): boolean {
  const key = gateKey(sessionId, phaseId);
  const resolve = pendingHumanGates.get(key);
  if (!resolve) return false;
  pendingHumanGates.delete(key);
  resolve({ decision, ...(conditions !== undefined ? { conditions } : {}) });
  return true;
}

export async function startSession(db: Database.Database, opts: StartSessionOpts): Promise<string> {
  const workflowType = getWorkflowType(opts.type);
  const workerIds = opts.workers ?? listWorkers().map((w) => w.id);
  const session = createSession(db, { type: opts.type, goal: opts.goal, workers: workerIds });

  for (const phaseDef of workflowType.phases) {
    const gateKind = opts.phaseGateOverrides?.[phaseDef.id] ?? phaseDef.gate_kind;
    createPhase(db, { session_id: session.id, phase_id: phaseDef.id, gate_kind: gateKind });
  }

  updateSessionStatus(db, session.id, 'running');
  void emit('wicked.crew.session.started', { session_id: session.id, type: opts.type });

  startActor(db, session.id, workerIds);
  return session.id;
}

export async function resumeSession(db: Database.Database, sessionId: string): Promise<void> {
  const session = getSession(db, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const rawSnapshot = loadSnapshot(db, sessionId);
  const snapshotIsPaused =
    rawSnapshot !== null &&
    typeof rawSnapshot === 'object' &&
    (rawSnapshot as Record<string, unknown>)['value'] === 'paused';
  // The actor's subscribe flips status paused → running the moment RESUME
  // moves it out of the paused state (sendResume below), which closes the
  // /resume guard loophole. lastStatus starts from the current 'paused' DB
  // value so the transient restored-paused snapshot does not re-emit paused.
  startActor(db, sessionId, session.workers, true, snapshotIsPaused);
}

/**
 * Re-create FSM actors for every session left incomplete by a prior daemon
 * process (crash recovery). Called on daemon startup. Sessions in a terminal
 * state (completed/failed) are skipped. Returns the ids that were resumed.
 */
export function resumeAllIncompleteSessions(db: Database.Database): string[] {
  const sessions = listActiveSessions(db);
  const resumed: string[] = [];
  for (const session of sessions) {
    startActor(db, session.id, session.workers, true, false);
    resumed.push(session.id);
  }
  return resumed;
}

function startActor(
  db: Database.Database,
  sessionId: string,
  workerIds: string[],
  fromSnapshot = false,
  sendResume = false,
): void {
  const session = getSession(db, sessionId);
  if (!session) return;
  const workflowType = getWorkflowType(session.type);

  // Load actual gate kinds from SQLite so phaseGateOverrides are honoured
  const phases = listPhases(db, sessionId);
  const gateKindOverrides = Object.fromEntries(phases.map((p) => [p.phase_id, p.gate_kind]));

  const machine = buildSessionMachine(workflowType, sessionId, gateKindOverrides).provide({
    actors: {
      phaseMachine: fromPromise(async ({ input }: { input: { phaseId: string; sessionId: string; gateKind: GateKind; workerIds: string[] } }): Promise<PhaseResult> => {
        return runPhase(db, input.sessionId, input.phaseId, input.gateKind, workerIds);
      }),
    },
  });

  // Stop and drop any prior actor for this session before starting a new one.
  const existing = actors.get(sessionId);
  if (existing) existing.stop();

  const snapshot = fromSnapshot ? loadSnapshot(db, sessionId) : undefined;
  const actor = snapshot
    ? createActor(machine, { snapshot: snapshot as Parameters<typeof createActor>[1] extends { snapshot?: infer S } ? S : never })
    : createActor(machine);
  actors.set(sessionId, actor);

  // Derive the DB session status from every machine snapshot. Tracking the last
  // written status keeps writes/emits idempotent and, crucially, flips
  // paused → running the instant the resumed actor leaves the paused state
  // (so the /resume guard rejects duplicate resumes). Starts from the current DB
  // status so a resume-into-paused transient does not re-emit session.paused.
  let lastStatus: string | null = getSession(db, sessionId)?.status ?? null;
  actor.subscribe((snap) => {
    // Persist via getPersistedSnapshot() — the serializable form that records
    // which invoked (fromPromise) children were active, so a fresh process can
    // re-invoke runPhase for the in-flight phase on restore. The plain state
    // snapshot loses child refs across a JSON round-trip.
    saveSnapshot(db, sessionId, actor.getPersistedSnapshot());

    const next = snap.status === 'done'
      ? (String(snap.value) === 'completed' ? 'completed' : 'failed')
      : (String(snap.value) === 'paused' ? 'paused' : 'running');
    if (next === lastStatus) return;
    lastStatus = next;

    updateSessionStatus(db, sessionId, next as import('../store/types.js').SessionStatus);
    if (next === 'paused') {
      void emit('wicked.crew.session.paused', { session_id: sessionId });
    } else if (next === 'completed' || next === 'failed') {
      if (actors.get(sessionId) === actor) actors.delete(sessionId);
      void emit(`wicked.crew.session.${next}`, { session_id: sessionId });
    }
  });

  actor.start();
  if (sendResume) {
    actor.send({ type: 'RESUME' });
  }
}

async function runPhase(
  db: Database.Database,
  sessionId: string,
  phaseId: string,
  gateKind: GateKind,
  workerIds: string[],
): Promise<PhaseResult> {
  // Check for pause signal before starting any dispatch work
  if (pauseRequested.has(sessionId)) {
    pauseRequested.delete(sessionId);
    return { result: 'paused' };
  }

  // Idempotency guard for crash recovery: if this phase already reached a
  // terminal gate decision in a prior process, don't re-dispatch workers —
  // just replay the recorded outcome so the FSM advances. (Workers are still
  // at-least-once for phases interrupted mid-flight, i.e. not yet decided.)
  const existingPhase = getPhase(db, sessionId, phaseId);
  if (existingPhase?.state === 'Approved') return { result: 'approved' };
  if (existingPhase?.state === 'Rejected') return { result: 'rejected' };

  updatePhaseState(db, sessionId, phaseId, 'InProgress');
  void emit('wicked.crew.dispatch.started', { session_id: sessionId, phase_id: phaseId });

  const workers = workerIds.map((id) => getWorker(id));
  const prompt = `Phase: ${phaseId}`;
  const context = JSON.stringify({ session_id: sessionId, phase_id: phaseId });

  let exitCodes: number[];
  let testVerdict: string | null = null;
  let councilScore: number | null = null;

  if (gateKind === 'council') {
    updatePhaseState(db, sessionId, phaseId, 'AwaitingCouncil');
    const councilResult = await dispatchCouncil(workers, prompt, context);
    exitCodes = councilResult.workerResults.map((r) => r.exitCode);
    councilScore = councilResult.synthesisScore;
    for (const r of councilResult.workerResults) {
      recordDispatch(db, sessionId, phaseId, r.workerId, prompt, r);
    }
  } else if (gateKind === 'human') {
    // For human gates: dispatch workers for context, then wait for HTTP approval
    if (workers.length > 0) {
      const results = await Promise.all(workers.map((w) => dispatch(w, prompt, context)));
      for (const r of results) {
        recordDispatch(db, sessionId, phaseId, r.workerId, prompt, r);
      }
    }
    updatePhaseState(db, sessionId, phaseId, 'AwaitingHuman');
    void emit('wicked.crew.gate.awaiting_human', { session_id: sessionId, phase_id: phaseId });

    const humanResult = await new Promise<HumanGateResolution>((resolve) => {
      pendingHumanGates.set(gateKey(sessionId, phaseId), resolve);
    });

    const now = new Date().toISOString();
    if (humanResult.decision === 'approved') {
      updatePhaseState(db, sessionId, phaseId, 'Approved');
      // Match the /approve-with-conditions HTTP fallback: record the
      // conditioned result string when conditions were supplied.
      const gateResult = humanResult.conditions !== undefined ? 'approved-with-conditions' : 'approved';
      db.prepare(`
        INSERT INTO gates (id, session_id, phase_id, result, blocking_policies, council_score, conditions, evaluated_at, created_at)
        VALUES (?, ?, ?, ?, '[]', NULL, ?, ?, ?)
      `).run(randomUUID(), sessionId, phaseId, gateResult, humanResult.conditions ?? null, now, now);
      void emit('wicked.crew.phase.gate.approved', { session_id: sessionId, phase_id: phaseId, human_override: true });
      return { result: 'approved', ...(humanResult.conditions !== undefined ? { conditions: humanResult.conditions } : {}) };
    } else {
      updatePhaseState(db, sessionId, phaseId, 'Rejected');
      db.prepare(`
        INSERT INTO gates (id, session_id, phase_id, result, blocking_policies, council_score, conditions, evaluated_at, created_at)
        VALUES (?, ?, ?, 'rejected', '[]', NULL, NULL, ?, ?)
      `).run(randomUUID(), sessionId, phaseId, now, now);
      void emit('wicked.crew.phase.gate.rejected', { session_id: sessionId, phase_id: phaseId, human_override: true });
      return { result: 'rejected' };
    }
  } else {
    const results = await Promise.all(workers.map((w) => dispatch(w, prompt, context)));
    exitCodes = results.map((r) => r.exitCode);
    for (const r of results) {
      recordDispatch(db, sessionId, phaseId, r.workerId, prompt, r);
      if (r.output?.test_verdict) testVerdict = r.output.test_verdict;
    }
  }

  updatePhaseState(db, sessionId, phaseId, 'GateRunning');
  const { cnt: blockingRaidCount } = db.prepare(
    'SELECT COUNT(*) as cnt FROM raid_items WHERE session_id = ? AND blocking = 1',
  ).get(sessionId) as { cnt: number };
  const facts = buildGateFacts({
    evidenceKinds: ['worker-output'],
    blockingRaidCount,
    workerExitCodes: exitCodes!,
    gateKind,
    councilScore,
    testVerdict,
    humanOverride: false,
  });

  const evalResult = await evaluateGate(builtInPolicies, facts);

  db.prepare(`
    INSERT INTO gates (id, session_id, phase_id, result, blocking_policies, council_score, conditions, evaluated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    randomUUID(), sessionId, phaseId,
    evalResult.result === 'approved' ? 'approved' : 'rejected',
    JSON.stringify(evalResult.blockingPolicies),
    councilScore, new Date().toISOString(), new Date().toISOString(),
  );

  if (evalResult.result === 'approved') {
    updatePhaseState(db, sessionId, phaseId, 'Approved');
    void emit('wicked.crew.phase.gate.approved', { session_id: sessionId, phase_id: phaseId });
    return { result: 'approved' };
  } else {
    updatePhaseState(db, sessionId, phaseId, 'Rejected');
    void emit('wicked.crew.phase.gate.rejected', { session_id: sessionId, phase_id: phaseId, policies: evalResult.blockingPolicies });
    return { result: 'rejected' };
  }
}

function recordDispatch(
  db: Database.Database,
  sessionId: string,
  phaseId: string,
  workerId: string,
  prompt: string,
  result: { exitCode: number; stdout: string; stderr: string; startedAt: string; completedAt: string | null },
): void {
  db.prepare(`
    INSERT INTO dispatches (id, session_id, phase_id, worker_id, prompt, exit_code, stdout, stderr, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), sessionId, phaseId, workerId, prompt,
    result.exitCode, result.stdout, result.stderr,
    result.startedAt, result.completedAt,
  );
}
