// crew#1813: the suite's test runner. Vitest's own runner, plus one step: when a test's body ends (passed or failed),
// every audit append it issued is awaited (`settleAuditLogs`, tests/setup/audit-settle.ts) before any `afterEach` or
// `afterAll` runs. A setup file's own `afterEach` would run LAST (after-hooks run in reverse order of registration),
// after the test file's cleanup has already removed the dir, so the step lives here: the runner's `onTaskFinished`
// runs between the body and the after-hooks.
import { TestRunner } from 'vitest';

export default class AuditFlushRunner extends TestRunner {
  async onTaskFinished(): Promise<void> {
    const settle = (globalThis as { __crewSettleAuditLogs?: () => Promise<void> }).__crewSettleAuditLogs;
    if (settle !== undefined) await settle();
  }
}
