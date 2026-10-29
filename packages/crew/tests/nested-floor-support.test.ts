// crew#1191 — the support the delivery end-to-end suites use inside the repo-checks floor
// (tests/support/nested-floor.ts): the opt-in is taken only on the engine's own "cannot arm" answer,
// and a delivery wait stops as soon as the run decided without one.
import { describe, expect, it } from 'vitest';
import { deliveryCannotCome, optInWhenFloorCannotArm, UNSANDBOXED_OPT_IN_ENV } from './support/nested-floor.js';

const adapterAnswering = (answer: unknown) => ({
  core: { hostBoundary: async () => (typeof answer === 'string' ? answer : JSON.stringify(answer)) },
});

describe('optInWhenFloorCannotArm (crew#1191)', () => {
  it('opts in when the engine cannot arm a boundary, and restores the environment as it was', async () => {
    const env: NodeJS.ProcessEnv = {};
    const r = await optInWhenFloorCannotArm(
      adapterAnswering({ armed: false, reason: 'cannot_arm', reasonText: 'sandbox-exec cannot be applied here' }),
      env,
    );
    expect(r.optedIn).toBe(true);
    expect(r.reason).toBe('sandbox-exec cannot be applied here');
    expect(env[UNSANDBOXED_OPT_IN_ENV]).toBe('1');
    r.restore();
    expect(UNSANDBOXED_OPT_IN_ENV in env).toBe(false);

    const set: NodeJS.ProcessEnv = { [UNSANDBOXED_OPT_IN_ENV]: 'true' };
    const again = await optInWhenFloorCannotArm(adapterAnswering({ armed: false }), set);
    again.restore();
    expect(set[UNSANDBOXED_OPT_IN_ENV]).toBe('true');
  });

  it('changes nothing where a boundary arms, or when the engine gives no usable answer', async () => {
    for (const adapter of [
      adapterAnswering({ armed: true, tool: 'sandbox-exec' }),
      adapterAnswering({}),
      adapterAnswering('not json'),
      adapterAnswering('null'),
      { core: { hostBoundary: async () => Promise.reject(new Error('no addon')) } },
      { core: {} },
      {},
    ]) {
      const env: NodeJS.ProcessEnv = {};
      const r = await optInWhenFloorCannotArm(adapter, env);
      expect(r.optedIn).toBe(false);
      expect(env).toEqual({});
    }
  });
});

describe('deliveryCannotCome (crew#1191)', () => {
  it('a run parked at a gate cannot deliver in a suite that answers none', () => {
    expect(deliveryCannotCome({ status: 'awaiting_human', delivery: 'none' })).toBe(true);
  });

  it('a running run, and an ended one whose delivery field may still resolve late, keep waiting (xreview on #1195)', () => {
    for (const status of ['running', 'pending', 'planning', 'completed', 'failed']) {
      expect(deliveryCannotCome({ status, delivery: 'none' })).toBe(false);
    }
  });
});
