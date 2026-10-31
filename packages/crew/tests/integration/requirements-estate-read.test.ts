// Operator ruling 2026-10-31: a repository's requirements graph is read from its estate store
// through the engine (core-ts `getRequirementsGraphForRepo`, wicked-core#1223). The adapter parses
// the engine's JSON, and an engine without the read is an error that names the upgrade — never an
// empty graph that would read as "not generated".

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { removeScratch } from '../setup/scratch.js';

let adapter: CoreAdapter;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'requirements-estate-read-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
});

afterAll(() => {
  adapter.close();
  removeScratch(dir);
});

describe('CoreAdapter.getRequirementsGraphForRepo', () => {
  it('an engine without the read is an error naming the upgrade', async () => {
    const core = (adapter as unknown as { core: Record<string, unknown> }).core;
    // Shadowed, not deleted: an engine built from wicked-core main carries the read as a prototype
    // method, which `delete` on the instance never removes (crew main CI, 2026-10-31).
    core['getRequirementsGraphForRepo'] = undefined;
    await expect(adapter.getRequirementsGraphForRepo('tiny-math')).rejects.toThrow(/upgrade wicked-core-ts/);
  });

  it("parses the engine's { graph, coverage } for the repository it names", async () => {
    const core = (adapter as unknown as { core: Record<string, unknown> }).core;
    const asked: string[] = [];
    core['getRequirementsGraphForRepo'] = async (repoRef: string) => {
      asked.push(repoRef);
      return JSON.stringify({
        graph: { metadata: { schema_version: '1.1.0' }, domains: { src: { requirements: {}, entities: {} } } },
        coverage: { mapped_pct: 3, min_pct: 80, behavior_bearing: 8109, mapped: 300, resolved: 99, unmapped: 7809 },
      });
    };
    const read = await adapter.getRequirementsGraphForRepo('wicked-crew');
    expect(asked).toEqual(['wicked-crew']);
    expect(read.coverage).toMatchObject({ mapped_pct: 3, min_pct: 80 });
    expect(read.graph?.domains).toHaveProperty('src');
  });
});
