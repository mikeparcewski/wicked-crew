// Shared assertion for the fr-privacy (Slice B) suites: a serialized response body must carry no
// home path. Exported here so each new privacy test gets the same floor (FINDINGS B1/B2/C3a).
import { expect } from 'vitest';

/**
 * Fail if `body` (a serialized JSON string, or any text a user could read) carries a home path:
 * `/Users/<name>`, `/home/<name>`, or `C:\Users\<name>`, in any case, with any separator spelling
 * (`/`, `\`, and the JSON-escaped `\/` and `\\`).
 */
export function expectNoHomePaths(body: string): void {
  const sep = String.raw`(?:\\\\|\\\/|\\|\/)`;
  expect(body, 'contains a /Users/ or /home/ path').not.toMatch(new RegExp(`${sep}(?:users|home)${sep}`, 'i'));
  expect(body, 'contains a C:\\Users path').not.toMatch(new RegExp(`[a-z]:${sep}+users`, 'i'));
}
