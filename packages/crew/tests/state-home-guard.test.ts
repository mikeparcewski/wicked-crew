// The state-home escape guard (crew#330 → crew#353, lane-2).
//
// Three times now a durable store spelled `join(homedir(), '.wicked-crew')` itself and silently
// escaped `--db` isolation into the operator's real home: the project graphs (crew#330), the
// project settings store (crew#353), then the audit trail + the exec-seam bus default + four
// interactive handoff ledgers (this lane's E2E gate). The rule the seam module states — "a new
// durable store should resolve here too, never from `homedir()` directly" — is exactly the kind
// of rule that holds until the next PR, so this test makes it structural: the quoted
// `'.wicked-crew'` path segment may appear in ONLY the two files that define the seam.
//
//   • projects/state-home.ts — the definition: `crewStateHome()`'s homedir fallback
//   • projects/settings.ts   — the legacy-shadow warning's deliberate spelling of the OLD path
//
// Everything else resolves through `crewStateHome()` (or takes an explicit path/env override).
// A hit here is not a style nit — it is the crew#330 bug about to ship again.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ALLOWED = new Set(['projects/state-home.ts', 'projects/settings.ts']);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('durable stores resolve through the state-home seam', () => {
  it("no src file outside the seam spells the '.wicked-crew' path segment", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes("'.wicked-crew'") || text.includes('".wicked-crew"')) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `these files spell the crew state home themselves instead of resolving through ` +
        `crewStateHome() (projects/state-home.ts) — under \`--db\` they will escape into the ` +
        `operator's real ~/.wicked-crew: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
