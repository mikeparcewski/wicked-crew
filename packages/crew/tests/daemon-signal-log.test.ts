// crew#411 — signal instrumentation: DaemonSignalLog write path + SeatHealthTracker
// correlation for session_died acpFallback events.
//
// Both the "daemon also signalled" and "no daemon signal" branches are covered.
// WICKED_APPS_EMIT_DEADLETTER is set to a per-process temp file by
// tests/setup/hermetic-home.ts (registered in vitest.config.ts setupFiles).

import { describe, expect, it } from 'vitest';
import {
  DaemonSignalLog,
  SIGNAL_CORRELATION_WINDOW_MS,
} from '../src/core/daemon-signal-log.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import type { CoreEvent } from '../src/core/types.js';

const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;

const acpFallbackEvent = (cliKey: string, fallbackKind: string, ts: number, reason = 'bridge exited 0'): CoreEvent =>
  ev({ type: 'acpFallback', session: 'r-411', cliKey, reason, fallbackKind, ts });

/** wicked-core#925: the reason a governed unit's refusal carries, opened by the engine's cause. */
const refusalReason = (cause: string): string =>
  `${cause}; NOT falling back to the single-shot wrapped carrier: the unit is governed, and 'pi' is governed only on its ACP carrier (crew#998)`;

// ── 1. Signal-log write path ──────────────────────────────────────────────────

describe('DaemonSignalLog (crew#411)', () => {
  it('record() appends entries; findInWindow() finds within the window and returns undefined outside', () => {
    const log = new DaemonSignalLog();
    expect(log.entries()).toHaveLength(0);

    const T = 1_000_000;
    log.record('SIGTERM', T);
    expect(log.entries()).toEqual([{ signal: 'SIGTERM', at: T }]);

    // Within the window on both sides and on the boundary.
    expect(log.findInWindow(T + 2_000)).toEqual({ signal: 'SIGTERM', at: T });
    expect(log.findInWindow(T - 2_000)).toEqual({ signal: 'SIGTERM', at: T });
    expect(log.findInWindow(T + SIGNAL_CORRELATION_WINDOW_MS)).toEqual({ signal: 'SIGTERM', at: T });

    // One millisecond past the boundary → no match.
    expect(log.findInWindow(T + SIGNAL_CORRELATION_WINDOW_MS + 1)).toBeUndefined();
    expect(log.findInWindow(T - SIGNAL_CORRELATION_WINDOW_MS - 1)).toBeUndefined();
  });
});

// ── 2 & 3. Correlation branches ───────────────────────────────────────────────

describe('SeatHealthTracker acpFallback(session_died) correlation (crew#411)', () => {
  it('logs "daemon also received" when a SIGTERM falls within the correlation window', () => {
    const signalLog = new DaemonSignalLog();
    const logs: string[] = [];
    const tracker = new SeatHealthTracker({ signalLog, log: (m) => logs.push(m) });

    const T = Date.parse('2026-09-01T10:00:00Z');
    signalLog.record('SIGTERM', T - 3_000); // 3 s before the bridge event

    tracker.ingest(acpFallbackEvent('claude', 'session_died', T));

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('daemon also received SIGTERM');
    expect(logs[0]).toContain('Δ3000ms');
    expect(logs[0]).toContain('likely group/terminal signal');
    expect(logs[0]).toContain('crew#411');
  });

  it('logs "no daemon signal" when the signal log has no entry within the window', () => {
    const signalLog = new DaemonSignalLog();
    const logs: string[] = [];
    const tracker = new SeatHealthTracker({ signalLog, log: (m) => logs.push(m) });

    const T = Date.parse('2026-09-01T10:00:00Z');
    signalLog.record('SIGTERM', T - 60_000); // too far back — outside the ±5 s window

    tracker.ingest(acpFallbackEvent('claude', 'session_died', T));

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('no daemon signal');
    expect(logs[0]).toContain('pid-targeted external signal or transport close');
    expect(logs[0]).toContain('crew#411');
  });

  it('does not log correlation for non-session_died fallbacks (e.g. binary_unavailable)', () => {
    const signalLog = new DaemonSignalLog();
    const logs: string[] = [];
    const tracker = new SeatHealthTracker({ signalLog, log: (m) => logs.push(m) });
    signalLog.record('SIGTERM', Date.now()); // signal present but irrelevant fallbackKind

    tracker.ingest(acpFallbackEvent('claude', 'binary_unavailable', Date.now()));

    expect(logs).toHaveLength(0);
  });

  it('correlates a GOVERNED worker death (wicked-core#925: governed_requires_acp after a session death)', () => {
    const T = Date.now();
    for (const cause of ["[wicked-core] ACP session exited for 'pi'", "[wicked-core] ACP error for 'pi' (broken pipe)"]) {
      const signalLog = new DaemonSignalLog();
      const logs: string[] = [];
      const tracker = new SeatHealthTracker({ signalLog, log: (m) => logs.push(m) });
      signalLog.record('SIGTERM', T - 1_000);
      tracker.ingest(acpFallbackEvent('pi', 'governed_requires_acp', T, refusalReason(cause)));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('acpFallback(governed_requires_acp) for pi');
      expect(logs[0]).toContain('daemon also received SIGTERM');
    }
  });

  it('does not correlate a governed refusal whose cause is not a session death (e.g. a startup failure)', () => {
    const signalLog = new DaemonSignalLog();
    const logs: string[] = [];
    const tracker = new SeatHealthTracker({ signalLog, log: (m) => logs.push(m) });
    signalLog.record('SIGTERM', Date.now());
    tracker.ingest(
      acpFallbackEvent('pi', 'governed_requires_acp', Date.now(), refusalReason("[wicked-core] ACP unavailable for 'pi' (spawn failed)")),
    );
    expect(logs).toHaveLength(0);
  });
});
