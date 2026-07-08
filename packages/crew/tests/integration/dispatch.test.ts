import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { dispatch, dispatchCouncil } from '../../src/dispatch/dispatcher.js';

const FIXTURE_WORKER = resolve('tests/fixtures/mock-worker.mjs');

function mockWorkerConfig(args: string[] = []) {
  return { id: 'mock-worker', command: 'node', args: [FIXTURE_WORKER, ...args], timeout_ms: 10000 };
}

describe('single dispatch', () => {
  it('dispatches fixture worker and parses structured output', async () => {
    const result = await dispatch(mockWorkerConfig(), 'test prompt', '{}');
    expect(result.exitCode).toBe(0);
    expect(result.output?.status).toBe('ok');
    expect(result.output?.test_verdict).toBe('PASS');
    expect(result.startedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();
  });

  it('returns exit code 1 and error status for failing worker', async () => {
    const result = await dispatch(mockWorkerConfig(['--exit', '1']), 'p', '{}');
    expect(result.exitCode).toBe(1);
    expect(result.output?.status).toBe('error');
  });

  it('returns -1 exit code on timeout', async () => {
    // Use a worker that sleeps longer than the timeout
    const sleepWorker = { id: 'sleep', command: 'node', args: ['-e', 'setTimeout(()=>{},9999)'], timeout_ms: 200 };
    const result = await dispatch(sleepWorker, '', '');
    expect(result.exitCode).toBe(-1);
  });
});

describe('council dispatch', () => {
  it('dispatches multiple workers in parallel (both start before either finishes)', async () => {
    // Both workers finish quickly, so measure that startedAt[1] < completedAt[0]
    const workers = [
      { id: 'w1', command: 'node', args: [FIXTURE_WORKER, '--council'], timeout_ms: 10000 },
      { id: 'w2', command: 'node', args: [FIXTURE_WORKER, '--council'], timeout_ms: 10000 },
    ];
    const result = await dispatchCouncil(workers, 'p', '{}');
    expect(result.workerResults.length).toBe(2);
    expect(result.workerResults.every((r) => r.exitCode === 0)).toBe(true);
    expect(result.synthesisScore).toBeGreaterThanOrEqual(0);
    expect(result.synthesisScore).toBeLessThanOrEqual(1);
    expect(result.recommendation).toBeTruthy();

    // Concurrency check: worker-2 started before worker-1 completed
    const [r1, r2] = result.workerResults;
    if (r1 && r2) {
      expect(new Date(r2.startedAt).getTime()).toBeLessThan(new Date(r1.completedAt!).getTime());
    }
  });

  it('returns synthesis score 0 when no workers have votes', async () => {
    // No --council flag → no votes field
    const workers = [
      { id: 'w1', command: 'node', args: [FIXTURE_WORKER], timeout_ms: 10000 },
      { id: 'w2', command: 'node', args: [FIXTURE_WORKER], timeout_ms: 10000 },
    ];
    const result = await dispatchCouncil(workers, 'p', '{}');
    expect(result.synthesisScore).toBe(0);
  });
});
