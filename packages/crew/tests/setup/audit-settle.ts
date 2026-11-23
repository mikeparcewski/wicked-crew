// crew#1813: every test's audit appends land before its cleanup removes their dir.
//
// `AuditLog.record()` appends on a promise chain after the route has answered (src/api/audit.ts), so a test that
// removes its temp dir in `afterEach`/`afterAll` (or anywhere after its body) could race the last append: on Linux an
// append landing mid-`rm` fails the test with ENOTEMPTY. Tests built `new AuditLog(...)` inline in dozens of files and
// mostly never flushed it.
//
// One mechanism, no per-file `flush()`: this setup file (run before every test file) notes each AuditLog that records,
// and the suite's runner (`audit-flush-runner.ts`) awaits all of them when a test's body ends: before any `afterEach`
// runs, so before any cleanup a test file registers. A test may still call `audit.flush()` itself (the same chain).
import { AuditLog } from '../../src/api/audit.js';

/** The logs that recorded and are not known settled, shared with the runner through the worker's global. */
const KEY = '__crewPendingAuditLogs';
type Holder = { [KEY]?: Set<AuditLog> };

function pending(): Set<AuditLog> {
  const g = globalThis as Holder;
  g[KEY] ??= new Set();
  return g[KEY];
}

// The class this test file's module graph uses. A test that re-imports the audit module after `vi.resetModules()` would
// get an untracked class; none does (the suite's resetModules users re-import publish/artifacts, hermetic-home and
// voice/tts). A module mock would cover that case but keeps the audit module, and the state home it read, across every
// reset, which changes what such a test sees (xreview r1, r2).
const record = AuditLog.prototype.record;
AuditLog.prototype.record = function trackedRecord(this: AuditLog, ...args: Parameters<AuditLog['record']>): number {
  pending().add(this);
  return record.apply(this, args);
};

/**
 * Await every append any AuditLog issued so far (each log's own `flush()`). A log leaves the set only when nothing was
 * recorded on it while this settle waited, so a settle that overlaps another (concurrent tests) still waits for the
 * logs the other is draining rather than finding the set empty (xreview r1).
 */
export async function settleAuditLogs(): Promise<void> {
  const logs = [...pending()];
  const chains = logs.map((l) => l.flush());
  await Promise.all(chains);
  logs.forEach((l, i) => {
    if (l.flush() === chains[i]) pending().delete(l);
  });
}

(globalThis as { __crewSettleAuditLogs?: () => Promise<void> }).__crewSettleAuditLogs = settleAuditLogs;
