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
import { vi } from 'vitest';

import type { AuditLog } from '../../src/api/audit.js';

/** The logs that recorded and are not known settled, shared with the runner through the worker's global. */
const KEY = '__crewPendingAuditLogs';
const PATCHED = Symbol.for('crew.auditSettle.patched');
type Holder = { [KEY]?: Set<AuditLog> };

function pending(): Set<AuditLog> {
  const g = globalThis as Holder;
  g[KEY] ??= new Set();
  return g[KEY];
}

// Every evaluation of the audit module gets the tracking `record`, including a fresh one a test imports after
// `vi.resetModules()` (the mock factory runs again for it; xreview r1). The module itself is returned unchanged.
vi.mock('../../src/api/audit.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/api/audit.js')>();
  const proto = mod.AuditLog.prototype as AuditLog & { [PATCHED]?: true };
  if (proto[PATCHED] !== true) {
    const record = proto.record;
    proto.record = function trackedRecord(this: AuditLog, ...args: Parameters<AuditLog['record']>): number {
      pending().add(this);
      return record.apply(this, args);
    };
    proto[PATCHED] = true;
  }
  return mod;
});

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
