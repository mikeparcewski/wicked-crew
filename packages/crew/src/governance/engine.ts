import { Engine } from 'json-rules-engine';
import type { GateFacts, GateEvalResult, PolicyRule } from './types.js';

export async function evaluateGate(policies: PolicyRule[], facts: GateFacts): Promise<GateEvalResult> {
  const engine = new Engine();

  for (const policy of policies) {
    engine.addRule({
      name: policy.name,
      conditions: policy.conditions as Parameters<typeof engine.addRule>[0]['conditions'],
      event: policy.event,
    });
  }

  const { failureEvents } = await engine.run(facts as unknown as Record<string, unknown>);

  // Deny-dominates: any failing rule → rejected
  if (failureEvents.length > 0) {
    return {
      result: 'rejected',
      blockingPolicies: failureEvents.map((e: { type: string }) => e.type),
    };
  }

  return { result: 'approved', blockingPolicies: [] };
}

export function buildGateFacts(opts: {
  evidenceKinds: string[];
  blockingRaidCount: number;
  workerExitCodes: number[];
  gateKind: 'auto' | 'human' | 'council';
  councilScore: number | null;
  testVerdict: string | null;
  humanOverride: boolean;
}): GateFacts {
  return {
    evidence_kinds: opts.evidenceKinds,
    blocking_raid_count: opts.blockingRaidCount,
    worker_exit_codes: opts.workerExitCodes,
    worker_all_success: opts.workerExitCodes.every((c) => c === 0),
    gate_kind: opts.gateKind,
    council_score: opts.councilScore,
    test_verdict: opts.testVerdict,
    human_override: opts.humanOverride,
  };
}
