// DC-S3 against the REAL engine (wicked-core-ts >= 0.7.35): the rule a policy proposal lands as keeps
// `targets.project` and `provenance.ref` through the store, so the route's read-back passes on a
// faithful engine and the probe reports project rules supported.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { policyProposalToRule } from '../src/api/routes.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let adapter: CoreAdapter;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'policy-landing-project-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
});

afterAll(() => {
  adapter.close();
  removeScratch(dir);
});

describe('a project policy landing round-trips through the engine (DC-S3)', () => {
  it('the engine keeps targets.project and provenance.ref; the read-back sees them', async () => {
    expect(adapter.projectRulesSupported()).toBe(true);
    const built = policyProposalToRule('pp-engine', 'policy:development', { rule: 'always run the linter', severity: 'warn' }, {
      project: 'proj-a',
      language: 'ts',
    });
    if ('error' in built) throw new Error(built.error);
    await adapter.upsertConformanceRule(built.rule);
    const stored = await adapter.readConformanceRule('proposal:pp-engine');
    expect(stored?.targets).toEqual({ language: 'ts', project: 'proj-a' });
    expect(stored?.provenance.ref).toBe('proposal:pp-engine');
    expect(await adapter.readConformanceRule('proposal:absent')).toBeNull();
  });
});
