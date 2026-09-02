/**
 * In-process signal receipt log (crew#411).
 *
 * Node's `process.on('SIGTERM'/'SIGINT')` callbacks receive no sender pid —
 * there is no SA_SIGINFO equivalent in the JS runtime. The best-effort record
 * is therefore: signal name + epoch-ms timestamp.
 *
 * The log is read by `SeatHealthTracker` when an ACP bridge dies silently
 * (`acpFallback` with `fallbackKind: session_died`) to distinguish:
 *
 *   - "daemon also received SIGTERM at T" → likely a group/terminal signal that
 *     killed both the bridge and the daemon together
 *   - "no daemon signal within ±5s" → a pid-targeted external signal sent
 *     directly to the bridge, or a transport close (neither woke the daemon)
 *
 * The ring is bounded (64 entries) because signals are rare and the entries are
 * tiny; the oldest entry is dropped once the cap is exceeded.
 */

export interface SignalEntry {
  signal: 'SIGTERM' | 'SIGINT';
  at: number; // epoch ms
}

/** Half-width of the default correlation window used by `findInWindow`. */
export const SIGNAL_CORRELATION_WINDOW_MS = 5_000;

export class DaemonSignalLog {
  private readonly _entries: SignalEntry[] = [];
  private static readonly MAX = 64;

  /**
   * Append a signal receipt. `at` defaults to `Date.now()`; injectable so tests
   * can set exact timestamps without mocking the clock process-wide.
   */
  record(signal: 'SIGTERM' | 'SIGINT', at = Date.now()): void {
    this._entries.push({ signal, at });
    if (this._entries.length > DaemonSignalLog.MAX)
      this._entries.splice(0, this._entries.length - DaemonSignalLog.MAX);
  }

  /**
   * Return the closest entry within [`aroundMs` ± `halfWindowMs`], or
   * `undefined` when no entry falls in that interval.
   * `halfWindowMs` defaults to `SIGNAL_CORRELATION_WINDOW_MS` (5 s).
   */
  findInWindow(aroundMs: number, halfWindowMs = SIGNAL_CORRELATION_WINDOW_MS): SignalEntry | undefined {
    let best: SignalEntry | undefined;
    let bestDelta = Infinity;
    for (const e of this._entries) {
      const delta = Math.abs(e.at - aroundMs);
      if (delta <= halfWindowMs && delta < bestDelta) {
        best = e;
        bestDelta = delta;
      }
    }
    return best;
  }

  /** All recorded entries, oldest first. Read-only view. */
  entries(): readonly SignalEntry[] {
    return this._entries;
  }
}

/** The daemon-wide singleton. The CLI records into it; the seat-health tracker reads from it. */
export const daemonSignalLog = new DaemonSignalLog();
