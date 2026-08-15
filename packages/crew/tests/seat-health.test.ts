// crew#274 — seat health: the fold transitions and the recovery probe.
//
// Pure in-memory: events are hand-built CoreEvent frames (the exact wire shapes from
// wicked-crew-api-types), the probe runs on fake timers with an injected prober. No CLI is
// ever spawned here.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_THRESHOLD,
  FALLBACK_WINDOW_MS,
  SeatHealthTracker,
  startSeatHealthProbe,
} from '../src/api/seat-health.js';
import type { CoreEvent } from '../src/core/types.js';

const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;

const distributed = (session: string, ord: number, cli: string): CoreEvent =>
  ev({ type: 'unitDistributed', session, ord, cli, routing_method: 'council' });

const outputOk = (session: string, ord: number): CoreEvent =>
  ev({ type: 'unitOutputCaptured', session, ord, attempt: 0, outputBytes: 10, stepStatus: 'ok', governed: true });

const stepFailed = (
  session: string,
  ord: number,
  detail: string,
  failureKind = 'workerError',
): CoreEvent => ev({ type: 'stepFailed', session, ord, attempt: 0, detail, failureKind });

const acpFallback = (cliKey: string, fallbackKind: string, reason: string, ts?: number): CoreEvent =>
  ev({ type: 'acpFallback', session: 'r-acp', cliKey, reason, fallbackKind, ...(ts !== undefined ? { ts } : {}) });

describe('SeatHealthTracker fold (crew#274)', () => {
  it('defaults every never-seen seat to active with no message', () => {
    const t = new SeatHealthTracker();
    const h = t.healthFor('claude');
    expect(h.status).toBe('active');
    expect(h.message).toBeUndefined();
    expect(typeof h.since).toBe('string');
  });

  it('stepFailed workerError naming the cli in its detail marks THAT seat inactive with the excerpt', () => {
    const t = new SeatHealthTracker();
    // The exact wrapped-runner shape from wicked-core execute_wrapped.rs — no assignment needed.
    t.ingest(stepFailed('r1', 4, '(cli `agy` exited 1) three narration lines and no verdict'));
    const h = t.healthFor('agy');
    expect(h.status).toBe('inactive');
    expect(h.message).toContain('(cli `agy` exited 1)');
    expect(h.lastErrorAt).toBeDefined();
    // No other seat was touched.
    expect(t.healthFor('claude').status).toBe('active');
  });

  it('stepFailed workerError without a named cli resolves the seat via unitDistributed (crew#277)', () => {
    const t = new SeatHealthTracker();
    t.ingest(distributed('r2', 1, 'codex'));
    t.ingest(stepFailed('r2', 1, 'worker exited before producing output', 'workerError'));
    const h = t.healthFor('codex');
    expect(h.status).toBe('inactive');
    expect(h.message).toBe('worker exited before producing output');
  });

  it('auth/quota/timeout detail strings are seat-level even when failureKind is not workerError', () => {
    const cases: [string, string][] = [
      ['codex', '401 Unauthorized (run codex login)'],
      ['copilot', 'quota exceeded for this billing period'],
      ['pi', 'ACP timeout waiting for response id=42'],
    ];
    for (const [seat, detail] of cases) {
      const t = new SeatHealthTracker();
      t.ingest(distributed('r3', 2, seat));
      t.ingest(stepFailed('r3', 2, detail, 'environmentRefused'));
      expect(t.healthFor(seat).status, detail).toBe('inactive');
      expect(t.healthFor(seat).message).toContain(detail.slice(0, 20));
    }
  });

  it('a non-seat-level stepFailed leaves the seat active', () => {
    const t = new SeatHealthTracker();
    t.ingest(distributed('r4', 1, 'claude'));
    t.ingest(
      stepFailed('r4', 1, 'unit reported done but did not produce its declared deliverable(s)', 'environmentRefused'),
    );
    expect(t.healthFor('claude').status).toBe('active');
  });

  it('a stepFailed for an unknown unit (no assignment, no named cli) marks nobody', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r5', 9, '401 Unauthorized'));
    expect(t.healthFor('codex').status).toBe('active');
  });

  it('one acpFallback is NOT inactive (session death falls back and can still work) but stamps lastErrorAt', () => {
    const t = new SeatHealthTracker();
    t.ingest(acpFallback('claude', 'session_died', 'bridge exited mid-run'));
    const h = t.healthFor('claude');
    expect(h.status).toBe('active');
    expect(h.message).toBeUndefined();
    expect(h.lastErrorAt).toBeDefined();
  });

  it(`${FALLBACK_THRESHOLD}+ acpFallbacks within 10 min mark the seat inactive with the reason`, () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-08-15T10:00:00Z');
    t.ingest(acpFallback('claude', 'session_died', 'bridge exited', t0));
    t.ingest(acpFallback('claude', 'binary_unavailable', 'spawn failed', t0 + 60_000));
    expect(t.healthFor('claude').status).toBe('active');
    t.ingest(acpFallback('claude', 'session_died', 'bridge exited again', t0 + 120_000));
    const h = t.healthFor('claude');
    expect(h.status).toBe('inactive');
    expect(h.message).toContain('repeated ACP fallback (3 in 10 min)');
    expect(h.message).toContain('bridge exited again');
  });

  it('fallbacks outside the 10-minute window age out of the count', () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-08-15T10:00:00Z');
    t.ingest(acpFallback('claude', 'session_died', 'a', t0));
    t.ingest(acpFallback('claude', 'session_died', 'b', t0 + FALLBACK_WINDOW_MS + 1_000));
    t.ingest(acpFallback('claude', 'session_died', 'c', t0 + FALLBACK_WINDOW_MS + 2_000));
    // Only two fall inside any 10-min window — never three.
    expect(t.healthFor('claude').status).toBe('active');
  });

  it('governance_requires_wrapped is deliberate routing, never counted toward inactive', () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-08-15T10:00:00Z');
    for (let i = 0; i < 5; i++) {
      t.ingest(acpFallback('claude', 'governance_requires_wrapped', 'governed unit', t0 + i * 1_000));
    }
    const h = t.healthFor('claude');
    expect(h.status).toBe('active');
    expect(h.lastErrorAt).toBeUndefined();
  });

  it('an ok unit output for the assigned seat flips it back to active and clears the message', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r6', 1, '(cli `agy` exited 1) transient'));
    expect(t.healthFor('agy').status).toBe('inactive');

    t.ingest(distributed('r7', 2, 'agy'));
    t.ingest(outputOk('r7', 2));
    const h = t.healthFor('agy');
    expect(h.status).toBe('active');
    expect(h.message).toBeUndefined();
    // The historical error stays visible.
    expect(h.lastErrorAt).toBeDefined();
  });

  it('a failed/cancelled unit output does NOT activate the seat', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r8', 1, '(cli `codex` exited 1) 401 Unauthorized'));
    t.ingest(distributed('r9', 3, 'codex'));
    t.ingest(
      ev({ type: 'unitOutputCaptured', session: 'r9', ord: 3, attempt: 0, outputBytes: 0, stepStatus: 'failed', governed: false }),
    );
    expect(t.healthFor('codex').status).toBe('inactive');
  });

  it('an ok output also resets the repeated-fallback window', () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-08-15T10:00:00Z');
    t.ingest(acpFallback('claude', 'session_died', 'a', t0));
    t.ingest(acpFallback('claude', 'session_died', 'b', t0 + 1_000));
    t.ingest(distributed('r10', 1, 'claude'));
    t.ingest(ev({ ...outputOk('r10', 1), ts: t0 + 2_000 }));
    // The two pre-ok fallbacks no longer count: this third one starts a fresh window.
    t.ingest(acpFallback('claude', 'session_died', 'c', t0 + 3_000));
    expect(t.healthFor('claude').status).toBe('active');
  });

  it('unitReassigned repoints the correlation to the new seat', () => {
    const t = new SeatHealthTracker();
    t.ingest(distributed('r11', 1, 'agy'));
    t.ingest(ev({ type: 'unitReassigned', session: 'r11', ord: 1, attempt: 1, previousCli: 'agy', newCli: 'claude' }));
    t.ingest(stepFailed('r11', 1, 'worker crashed with no output', 'workerError'));
    expect(t.healthFor('claude').status).toBe('inactive');
    expect(t.healthFor('agy').status).toBe('active');
  });

  it('terminal run events drop the run assignments (a finished run cannot flip seats later)', () => {
    const t = new SeatHealthTracker();
    t.ingest(distributed('r12', 1, 'codex'));
    t.ingest(ev({ type: 'sessionCompleted', session: 'r12' }));
    t.ingest(stepFailed('r12', 1, 'worker crashed', 'workerError'));
    expect(t.healthFor('codex').status).toBe('active');
  });

  it('bounds the health message to an excerpt', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r13', 1, `(cli \`agy\` exited 1) ${'x'.repeat(5_000)}`));
    const msg = t.healthFor('agy').message ?? '';
    expect(msg.length).toBeLessThanOrEqual(240);
  });
});

describe('seat-health recovery probe (crew#274 §3)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('probes INACTIVE seats only, and exit 0 flips the seat active with the message cleared', async () => {
    vi.useFakeTimers();
    const t = new SeatHealthTracker();
    t.markInactive('codex', '401 Unauthorized (run codex login)');
    const probed: string[][] = [];
    const probe = startSeatHealthProbe(
      t,
      () => [
        { key: 'codex', version_probe: ['codex', '--version'] },
        { key: 'claude', version_probe: ['claude', '--version'] },
      ],
      {
        intervalMs: FALLBACK_WINDOW_MS,
        runProbe: async (argv) => {
          probed.push(argv);
          return true;
        },
      },
    );
    await vi.advanceTimersByTimeAsync(FALLBACK_WINDOW_MS);
    probe.stop();
    // Active seats are never probed — this is a recovery path, not a monitor.
    expect(probed).toEqual([['codex', '--version']]);
    const h = t.healthFor('codex');
    expect(h.status).toBe('active');
    expect(h.message).toBeUndefined();
  });

  it('a non-zero (or timed-out) probe leaves the seat inactive with its message intact', async () => {
    vi.useFakeTimers();
    const t = new SeatHealthTracker();
    t.markInactive('codex', '401 Unauthorized (run codex login)');
    const probe = startSeatHealthProbe(
      t,
      () => [{ key: 'codex', version_probe: ['codex', '--version'] }],
      { intervalMs: 1_000, runProbe: async () => false },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    probe.stop();
    const h = t.healthFor('codex');
    expect(h.status).toBe('inactive');
    expect(h.message).toBe('401 Unauthorized (run codex login)');
  });

  it('a seat without a version_probe is skipped (only an ok output can recover it)', async () => {
    vi.useFakeTimers();
    const t = new SeatHealthTracker();
    t.markInactive('mystery', 'exploded');
    const runProbe = vi.fn(async () => true);
    const probe = startSeatHealthProbe(t, () => [{ key: 'mystery' }], {
      intervalMs: 1_000,
      runProbe,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    probe.stop();
    expect(runProbe).not.toHaveBeenCalled();
    expect(t.healthFor('mystery').status).toBe('inactive');
  });

  it('stop() ends the interval — no probes after teardown', async () => {
    vi.useFakeTimers();
    const t = new SeatHealthTracker();
    t.markInactive('codex', 'down');
    const runProbe = vi.fn(async () => false);
    const probe = startSeatHealthProbe(
      t,
      () => [{ key: 'codex', version_probe: ['codex', '--version'] }],
      { intervalMs: 1_000, runProbe },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runProbe).toHaveBeenCalledTimes(1);
    probe.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runProbe).toHaveBeenCalledTimes(1);
  });
});
