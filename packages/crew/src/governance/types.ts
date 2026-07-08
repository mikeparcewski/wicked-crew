export interface GateFacts {
  evidence_kinds: string[];
  blocking_raid_count: number;
  worker_exit_codes: number[];
  worker_all_success: boolean;
  gate_kind: 'auto' | 'human' | 'council';
  council_score: number | null;
  test_verdict: string | null;
  human_override: boolean;
}

export interface GateEvalResult {
  result: 'approved' | 'rejected';
  blockingPolicies: string[];
}

export interface PolicyRule {
  name: string;
  conditions: Record<string, unknown>;
  event: { type: string };
}
