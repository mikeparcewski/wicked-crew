// J6 K1 — CoreAdapter.launchRun hands the engine a domain model run's scope as core's `scopeJson`, and refuses it on
// an addon that would drop it (napi ignores an undeclared field). The route tests replace launchRun, so this pins the
// adapter's own forwarding (codex round 1 on crew#1909). Same fake-engine technique as
// optional-read-roots-launch.test.ts: an own property shadows the napi method; the addon's probe is stubbed.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { LaunchOptions } from 'wicked-core-ts';
import { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

const SCOPE = JSON.stringify({ intent: 'the payroll rules', scope_hash: 'a'.repeat(64) });
// The adapter reads the addon through require (adapter.ts); the same class object is stubbed here.
const probe = (createRequire(import.meta.url)('wicked-core-ts') as { Core: object }).Core as { supportsDomainScope?: () => boolean };
const had = Object.getOwnPropertyDescriptor(probe, 'supportsDomainScope');

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
  if (had !== undefined) Object.defineProperty(probe, 'supportsDomainScope', had);
  else delete probe.supportsDomainScope;
  adapter.close();
  removeScratch(dir);
});

const stubProbe = (v: (() => boolean) | undefined): void => {
  Object.defineProperty(probe, 'supportsDomainScope', { value: v, configurable: true, writable: true });
};

describe('launchRun forwards a domain model run\'s scope (J6 K1)', () => {
  it('hands the engine the scope exactly as given', async () => {
    stubProbe(() => true);
    await adapter.launchRun({ problem: 'p', sessionId: 'run-scope', clisJson: '[]', workflow: 'domain-extraction', domainScopeJson: SCOPE });
    expect(launched.at(-1)!.scopeJson).toBe(SCOPE);
  });

  it('sends no scope when given none', async () => {
    stubProbe(() => true);
    await adapter.launchRun({ problem: 'p', sessionId: 'run-none', clisJson: '[]' });
    expect(launched.at(-1)!).not.toHaveProperty('scopeJson');
  });

  it.each([undefined, () => false])('refuses, launching nothing, on an addon that would drop it (%s)', async (p) => {
    stubProbe(p);
    await expect(adapter.launchRun({ problem: 'p', sessionId: 'run-old', clisJson: '[]', workflow: 'domain-extraction', domainScopeJson: SCOPE })).rejects.toThrow(/supportsDomainScope/u);
    expect(launched).toHaveLength(0);
  });
});
