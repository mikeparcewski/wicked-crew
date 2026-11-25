// J6 K1 — CoreAdapter.launchRun hands the engine a domain model run's scope as core's `scopeJson`, and refuses it on
// an addon that would drop it (napi ignores an undeclared field). The route tests replace launchRun, so this pins the
// adapter's own forwarding (codex round 1 on crew#1909). Same fake-engine technique as
// optional-read-roots-launch.test.ts: an own property shadows the napi method.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchOptions } from 'wicked-core-ts';
import { addonSupportsDomainScope, CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

const SCOPE = JSON.stringify({ intent: 'the payroll rules', scope_hash: 'a'.repeat(64) });
// The linked addon answers for itself (its napi static cannot be redefined): an engine with wicked-core#1922 (crew CI
// builds core main) takes the forwarding branch, an older published one the refusal.
const supported = addonSupportsDomainScope();

let dir: string;
let adapter: CoreAdapter;
let launched: Array<LaunchOptions & { scopeJson?: string }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'domain-scope-launch-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  launched = [];
  (adapter as unknown as { core: Record<string, unknown> }).core['launchRun'] = (opts: LaunchOptions) => {
    launched.push(opts);
    return Promise.resolve(opts.sessionId);
  };
});

afterEach(() => {
  adapter.close();
  removeScratch(dir);
});

describe('launchRun forwards a domain model run\'s scope (J6 K1)', () => {
  it.runIf(supported)('hands the engine the scope exactly as given', async () => {
    await adapter.launchRun({ problem: 'p', sessionId: 'run-scope', clisJson: '[]', workflow: 'domain-extraction', domainScopeJson: SCOPE });
    expect(launched.at(-1)!.scopeJson).toBe(SCOPE);
  });

  it('sends no scope when given none', async () => {
    await adapter.launchRun({ problem: 'p', sessionId: 'run-none', clisJson: '[]' });
    expect(launched.at(-1)!).not.toHaveProperty('scopeJson');
  });

  it.skipIf(supported)('refuses, launching nothing, on an addon that would drop it', async () => {
    await expect(adapter.launchRun({ problem: 'p', sessionId: 'run-old', clisJson: '[]', workflow: 'domain-extraction', domainScopeJson: SCOPE })).rejects.toThrow(/supportsDomainScope/u);
    expect(launched).toHaveLength(0);
  });
});
