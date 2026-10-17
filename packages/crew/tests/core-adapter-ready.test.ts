// crew#994: in the first ~100 ms after `new CoreAdapter(...)`, a store read failed with "open estate
// store read-only … no such table: meta", or answered without the rules the engine seeds at boot. The
// engine's read bindings open the store file directly, off the actor, while the actor is still opening
// and seeding it (wicked-core `actor::run`). The adapter now holds those reads until the actor answers
// its first ping, which it does only once the store is open and seeded.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CoreAdapter } from '../src/core/adapter.js';
import { FIRST_USE_LEDGER, WRITE_LEDGER } from '../src/mcp/policies.js';
import { removeScratch } from './setup/scratch.js';

const scratch: string[] = [];
const adapters: CoreAdapter[] = [];

afterEach(() => {
  for (const a of adapters.splice(0)) a.close();
  for (const d of scratch.splice(0)) removeScratch(d);
});

function fresh(): CoreAdapter {
  const dir = mkdtempSync(join(tmpdir(), 'crew-adapter-ready-'));
  scratch.push(dir);
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapters.push(adapter);
  return adapter;
}

describe('a store read right after new CoreAdapter (crew#994)', () => {
  it('answers with the boot-seeded rules, never "no such table: meta"', async () => {
    // Each adapter is read in the same tick it was constructed: the window the issue reports.
    const reads = Array.from({ length: 8 }, () => fresh().listConformanceRules());
    const results = await Promise.allSettled(reads);
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
    expect(failures).toEqual([]);
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const ids = r.value.map((rule) => rule.id);
      expect(ids).toContain(FIRST_USE_LEDGER);
      expect(ids).toContain(WRITE_LEDGER);
    }
  });

  it('every other off-actor read waits too (policies, rule sets, claims, projects)', async () => {
    const a = fresh();
    await expect(Promise.all([a.listPolicies(), a.countRuleSets(), a.listConformanceClaims(), a.projectList()])).resolves.toHaveLength(4);
  });
});
