import { describe, it, expect } from 'vitest';
import { evaluateGate, buildGateFacts } from '../../src/governance/engine.js';
import { builtInPolicies } from '../../src/governance/built-in-policies/index.js';
import type { GateFacts } from '../../src/governance/types.js';

function passingFacts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    evidence_kinds: ['worker-output'],
    blocking_raid_count: 0,
    worker_exit_codes: [0],
    worker_all_success: true,
    gate_kind: 'auto',
    council_score: null,
    test_verdict: null,
    human_override: false,
    ...overrides,
  };
}

describe('evaluateGate', () => {
  it('approves when all built-in policies pass', async () => {
    const result = await evaluateGate(builtInPolicies, passingFacts());
    expect(result.result).toBe('approved');
    expect(result.blockingPolicies).toHaveLength(0);
  });

  it('is deterministic — 100 identical runs', async () => {
    const facts = passingFacts();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => evaluateGate(builtInPolicies, facts)),
    );
    expect(results.every((r) => r.result === 'approved')).toBe(true);
  });

  it('rejects when worker_all_success is false', async () => {
    const result = await evaluateGate(builtInPolicies, passingFacts({ worker_all_success: false }));
    expect(result.result).toBe('rejected');
    expect(result.blockingPolicies).toContain('worker-exit-success');
  });

  it('rejects when blocking_raid_count > 0', async () => {
    const result = await evaluateGate(builtInPolicies, passingFacts({ blocking_raid_count: 2 }));
    expect(result.result).toBe('rejected');
    expect(result.blockingPolicies).toContain('no-blocking-raid');
  });

  it('rejects when test_verdict is FAIL', async () => {
    const result = await evaluateGate(builtInPolicies, passingFacts({ test_verdict: 'FAIL' }));
    expect(result.result).toBe('rejected');
    expect(result.blockingPolicies).toContain('test-verdict-pass');
  });

  it('approves when test_verdict is PASS', async () => {
    const result = await evaluateGate(builtInPolicies, passingFacts({ test_verdict: 'PASS' }));
    expect(result.result).toBe('approved');
  });

  it('approves when test_verdict is CONDITIONAL', async () => {
    const result = await evaluateGate(builtInPolicies, passingFacts({ test_verdict: 'CONDITIONAL' }));
    expect(result.result).toBe('approved');
  });

  it('deny-dominates — multiple failing policies all reported', async () => {
    const result = await evaluateGate(builtInPolicies, passingFacts({
      worker_all_success: false,
      blocking_raid_count: 1,
      test_verdict: 'FAIL',
    }));
    expect(result.result).toBe('rejected');
    expect(result.blockingPolicies.length).toBeGreaterThanOrEqual(3);
  });

  it('handles empty policy set → approved', async () => {
    const result = await evaluateGate([], passingFacts());
    expect(result.result).toBe('approved');
  });
});

describe('buildGateFacts', () => {
  it('sets worker_all_success=true when all exit codes are 0', () => {
    const facts = buildGateFacts({
      evidenceKinds: ['k'],
      blockingRaidCount: 0,
      workerExitCodes: [0, 0, 0],
      gateKind: 'auto',
      councilScore: null,
      testVerdict: null,
      humanOverride: false,
    });
    expect(facts.worker_all_success).toBe(true);
  });

  it('sets worker_all_success=false for any non-zero exit code', () => {
    const facts = buildGateFacts({
      evidenceKinds: ['k'],
      blockingRaidCount: 0,
      workerExitCodes: [0, 1],
      gateKind: 'auto',
      councilScore: null,
      testVerdict: null,
      humanOverride: false,
    });
    expect(facts.worker_all_success).toBe(false);
  });

  it('sets worker_all_success=false for timeout sentinel -1', () => {
    const facts = buildGateFacts({
      evidenceKinds: [],
      blockingRaidCount: 0,
      workerExitCodes: [-1],
      gateKind: 'auto',
      councilScore: null,
      testVerdict: null,
      humanOverride: false,
    });
    expect(facts.worker_all_success).toBe(false);
  });
});
