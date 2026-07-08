import { describe, it, expect } from 'vitest';

// Pure synthesis math extracted so it can be tested without side effects.
// Mirrors the logic in dispatcher.ts synthesizeCouncil.

interface WorkerVotes {
  recommendation: string;
  confidence: number;
  rationale: string;
  dimensions: Record<string, 'agree' | 'disagree' | 'uncertain'>;
}

function synthesizeCouncil(votesList: WorkerVotes[]): {
  synthesisScore: number;
  recommendation: string;
  dimensionAgreements: Record<string, number>;
} {
  if (votesList.length === 0) {
    return { synthesisScore: 0, recommendation: '', dimensionAgreements: {} };
  }

  const allDimensions = new Set<string>();
  for (const v of votesList) Object.keys(v.dimensions).forEach((k) => allDimensions.add(k));

  const dimensionAgreements: Record<string, number> = {};
  for (const dim of allDimensions) {
    let agreeCount = 0;
    for (const v of votesList) {
      if (v.dimensions[dim] === 'agree') agreeCount++;
    }
    dimensionAgreements[dim] = agreeCount / votesList.length;
  }

  const scores = Object.values(dimensionAgreements);
  const synthesisScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  const recCounts = new Map<string, number>();
  for (const v of votesList) {
    recCounts.set(v.recommendation, (recCounts.get(v.recommendation) ?? 0) + 1);
  }
  let recommendation = '';
  let maxCount = 0;
  for (const [rec, count] of recCounts) {
    if (count > maxCount) { maxCount = count; recommendation = rec; }
  }

  return { synthesisScore, recommendation, dimensionAgreements };
}

describe('council synthesis math', () => {
  it('100% agreement produces score 1.0', () => {
    const votes: WorkerVotes[] = [
      { recommendation: 'a', confidence: 0.9, rationale: 'r1', dimensions: { feasibility: 'agree', risk: 'agree' } },
      { recommendation: 'a', confidence: 0.8, rationale: 'r2', dimensions: { feasibility: 'agree', risk: 'agree' } },
    ];
    const result = synthesizeCouncil(votes);
    expect(result.synthesisScore).toBeCloseTo(1.0);
    expect(result.recommendation).toBe('a');
  });

  it('0% agreement produces score 0.0', () => {
    // Both workers disagree — 0/2 agree on the single dimension
    const votes: WorkerVotes[] = [
      { recommendation: 'a', confidence: 0.9, rationale: 'r1', dimensions: { feasibility: 'disagree' } },
      { recommendation: 'b', confidence: 0.8, rationale: 'r2', dimensions: { feasibility: 'disagree' } },
    ];
    const result = synthesizeCouncil(votes);
    expect(result.synthesisScore).toBeCloseTo(0.0);
  });

  it('partial agreement computes correct mean', () => {
    // feasibility: 2/2 agree = 1.0; risk: 1/2 agree = 0.5; mean = 0.75
    const votes: WorkerVotes[] = [
      { recommendation: 'a', confidence: 0.9, rationale: 'r1', dimensions: { feasibility: 'agree', risk: 'agree' } },
      { recommendation: 'a', confidence: 0.8, rationale: 'r2', dimensions: { feasibility: 'agree', risk: 'disagree' } },
    ];
    const result = synthesizeCouncil(votes);
    expect(result.synthesisScore).toBeCloseTo(0.75);
  });

  it('plurality recommendation is majority vote', () => {
    const votes: WorkerVotes[] = [
      { recommendation: 'a', confidence: 0.9, rationale: 'r', dimensions: {} },
      { recommendation: 'b', confidence: 0.8, rationale: 'r', dimensions: {} },
      { recommendation: 'a', confidence: 0.7, rationale: 'r', dimensions: {} },
    ];
    expect(synthesizeCouncil(votes).recommendation).toBe('a');
  });

  it('empty vote list returns score 0 and empty recommendation', () => {
    const result = synthesizeCouncil([]);
    expect(result.synthesisScore).toBe(0);
    expect(result.recommendation).toBe('');
  });
});
