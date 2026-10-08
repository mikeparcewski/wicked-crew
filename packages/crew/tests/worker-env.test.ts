// crew#844: the daemon defaults Claude Code's background-task switch off for every worker, and an
// operator's own value is never overwritten.
import { describe, expect, it } from 'vitest';
import { DISABLE_BACKGROUND_TASKS_ENV, ensureForegroundOnlyWorkers } from '../src/core/worker-env.js';

describe('ensureForegroundOnlyWorkers (crew#844)', () => {
  it('sets CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 when unset or empty, idempotently', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(ensureForegroundOnlyWorkers(env)).toEqual({ value: '1', defaulted: true });
    expect(env[DISABLE_BACKGROUND_TASKS_ENV]).toBe('1');
    expect(ensureForegroundOnlyWorkers(env)).toEqual({ value: '1', defaulted: false });
    const empty: NodeJS.ProcessEnv = { [DISABLE_BACKGROUND_TASKS_ENV]: '' };
    expect(ensureForegroundOnlyWorkers(empty).defaulted).toBe(true);
    expect(empty[DISABLE_BACKGROUND_TASKS_ENV]).toBe('1');
  });

  it("respects an operator's opt-out (0) and reports it", () => {
    const env: NodeJS.ProcessEnv = { [DISABLE_BACKGROUND_TASKS_ENV]: '0' };
    expect(ensureForegroundOnlyWorkers(env)).toEqual({ value: '0', defaulted: false });
    expect(env[DISABLE_BACKGROUND_TASKS_ENV]).toBe('0');
  });
});
