import { createMachine, assign, fromPromise } from 'xstate';
import type { WorkflowType } from './workflow-types.js';

interface SessionContext {
  sessionId: string;
  lastActivePhase: string;
}

export interface PhaseResult {
  result: 'approved' | 'rejected' | 'paused';
  conditions?: string;
}

export function buildSessionMachine(
  workflowType: WorkflowType,
  sessionId: string,
  gateKindOverrides: Record<string, import('../store/types.js').GateKind> = {},
) {
  const phaseIds = workflowType.phases.map((p) => p.id);

  const phaseStates = Object.fromEntries(
    phaseIds.map((phaseId, i) => [
      phaseId,
      {
        entry: assign({ lastActivePhase: () => phaseId }),
        invoke: {
          src: 'phaseMachine',
          input: ({ context }: { context: SessionContext }) => ({
            phaseId,
            sessionId: context.sessionId,
            gateKind: gateKindOverrides[phaseId] ?? workflowType.phases[i]?.gate_kind ?? 'auto',
            workerIds: [],
          }),
          onDone: [
            {
              guard: ({ event }: { event: { output: PhaseResult } }) => event.output.result === 'paused',
              target: 'paused',
            },
            {
              guard: ({ event }: { event: { output: PhaseResult } }) => event.output.result === 'approved',
              target: phaseIds[i + 1] ?? 'completed',
            },
            { target: 'failed' },
          ],
          onError: { target: 'failed' },
        },
      },
    ]),
  );

  // Guard-array resume: evaluate each phase guard in order (first match wins).
  const resumeTransitions = phaseIds.map((phaseId) => ({
    guard: ({ context }: { context: SessionContext }) => context.lastActivePhase === phaseId,
    target: phaseId,
  }));

  return createMachine(
    {
      id: 'session',
      types: { context: {} as SessionContext },
      initial: phaseIds[0] as string,
      context: { sessionId, lastActivePhase: phaseIds[0] as string },
      states: {
        ...phaseStates,
        completed: { type: 'final' as const },
        failed: { type: 'final' as const },
        paused: {
          on: { RESUME: resumeTransitions },
        },
      },
    },
    {
      actors: {
        phaseMachine: fromPromise(async (): Promise<PhaseResult> => { throw new Error('phaseMachine not wired'); }),
      },
    },
  );
}
