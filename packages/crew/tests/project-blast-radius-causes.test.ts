// crew#751 — estate (wicked-estate#222, 0.18.0+) says WHY a blast radius may be incomplete:
// `depth_horizon_reached` / `node_cap_reached` (the walk stopped), `searched_depth` (which horizon
// applied) and `truncated_dependents` (rows cut to fit the output budget). The repo route passes
// estate's JSON through verbatim; `projectBlastRadius` rebuilt the object and dropped all four, so
// a caller of the project route could not tell "no dependents" from "the walk stopped at depth 3".
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { projectBlastRadius, type Queryable } from '../src/projects/graph.js';
import { removeScratch } from './setup/scratch.js';

const dir = mkdtempSync(join(tmpdir(), 'project-blast-causes-'));
afterAll(() => removeScratch(dir));

function fakeEstate(body: Record<string, unknown>): NodeJS.ProcessEnv {
  const exe = join(dir, `estate-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(exe, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(body))});\n`);
  chmodSync(exe, 0o755);
  return { ...process.env, WICKED_ESTATE_EXE: exe };
}

const q = {
  ok: true,
  dbPath: join(dir, 'graph.db'),
  labels: new Map([['api', 'repo-api']]),
  status: { projectId: 'p1', missingRepos: [] },
} as unknown as Extract<Queryable, { ok: true }>;

describe.skipIf(process.platform === 'win32')('projectBlastRadius carries estate\'s completeness causes (crew#751)', () => {
  it('a depth-cut walk says so: depth_horizon_reached, node_cap_reached, searched_depth, truncated_dependents', async () => {
    const env = fakeEstate({
      target: 'charge',
      dependents: [{ id: 'sym api/charge', name: 'charge', kind: 'Function', file: 'api/src/pay.ts', line: 3 }],
      unresolved: 0,
      truncated_dependents: 2,
      searched_depth: 3,
      depth_horizon_reached: true,
      node_cap_reached: false,
    });
    const out = await projectBlastRadius(q, 'charge', env);
    expect(out).toMatchObject({ depth_horizon_reached: true, node_cap_reached: false, searched_depth: 3, truncated_dependents: 2 });
    expect(out.dependents).toHaveLength(1);
  });

  it('an estate before #222 omits them, and so does the answer (never a fabricated false)', async () => {
    const out = await projectBlastRadius(q, 'charge', fakeEstate({ target: 'charge', dependents: [], unresolved: 1 }));
    expect('depth_horizon_reached' in out).toBe(false);
    expect('node_cap_reached' in out).toBe(false);
    expect('searched_depth' in out).toBe(false);
    expect('truncated_dependents' in out).toBe(false);
  });
});
