// crew#1813: every test's audit appends land before its cleanup removes their dir.
//
// `AuditLog.record()` appends on a promise chain after the route has answered (src/api/audit.ts), so a test that
// removes its temp dir in `afterEach`/`afterAll` (or anywhere after its body) could race the last append: on Linux an
// append landing mid-`rm` fails the test with ENOTEMPTY. Tests built `new AuditLog(...)` inline in dozens of files and
// mostly never flushed it.
//
// One mechanism, no per-file `flush()`: this setup file (run before every test file, in that file's module graph)
// notes each AuditLog that records, and the suite's runner (`audit-flush-runner.ts`) awaits all of them when a test's
// body ends: before any `afterEach` runs, so before any cleanup a test file registers. A test may still call
// `audit.flush()` itself (it is the same chain).
import { AuditLog } from '../../src/api/audit.js';

/** The logs that recorded since the last settle, shared with the runner through the worker's global. */
const KEY = '__crewPendingAuditLogs';
type Holder = { [KEY]?: Set<AuditLog> };

function pending(): Set<AuditLog> {
  const g = globalThis as Holder;
  g[KEY] ??= new Set();
  return g[KEY];
}

const record = AuditLog.prototype.record;
AuditLog.prototype.record = function trackedRecord(this: AuditLog, ...args: Parameters<AuditLog['record']>): number {
  pending().add(this);
  return record.apply(this, args);
};

/** Await every append any AuditLog issued so far (each log's own `flush()`), then forget them. */
export async function settleAuditLogs(): Promise<void> {
  const logs = [...pending()];
  pending().clear();
  await Promise.all(logs.map((l) => l.flush()));
}

(globalThis as { __crewSettleAuditLogs?: () => Promise<void> }).__crewSettleAuditLogs = settleAuditLogs;
