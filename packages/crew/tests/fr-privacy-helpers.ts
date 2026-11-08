// Shared assertion for the fr-privacy (Slice B) suites: a serialized response body must carry no
// home path. Exported here so each new privacy test gets the same floor (FINDINGS B1/B2/C3a).
import { expect } from 'vitest';

/**
 * Fail if `body` (a serialized JSON string, or any text a user could read) carries a home path:
 * `/Users/<name>`, `/home/<name>`, or `C:\Users\<name>` — either slash, any case of the drive
 * letter, in plain OR JSON-escaped (doubled-backslash) form.
 */
export function expectNoHomePaths(body: string): void {
  expect(body, 'contains a /Users/ path').not.toMatch(/\/Users\//);
  expect(body, 'contains a /home/ path').not.toMatch(/\/home\//);
  // Windows drive path, drive letter case-insensitive, one or two backslashes (JSON doubles them).
  expect(body, 'contains a C:\\Users path').not.toMatch(/[A-Za-z]:(?:\\\\|\\|\/)Users/);
}
