// Unit tests: CoreAdapter.resolveElicitation is WIRED, not a stub (crew#357 / crew#358).
//
// Until these issues, the adapter body was a deliberate always-throw
// (`ElicitationUnsupportedError` on every call) even though the installed wicked-core-ts
// has shipped the `resolveElicitation` NAPI binding since 0.7.2. These tests pin the fix:
//   1. the adapter FORWARDS to the binding with the flat NAPI signature (runId,
//      elicitationId, action, response) — response null for decline/cancel;
//   2. against the real addon the call CROSSES the NAPI boundary — the engine's own
//      rejection comes back, never the 501-shaped ElicitationUnsupportedError;
//   3. an addon without the binding (pre-0.7.2) still gets the honest
//      ElicitationUnsupportedError → HTTP 501, the interactionRequests/runEvents
//      feature-detect convention.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, ElicitationUnsupportedError } from '../src/core/adapter.js';

let dir: string;
let adapter: CoreAdapter;

/** Shadow a napi prototype method with an own property (delete would silently keep the real one). */
function stubCore(a: CoreAdapter, name: string, impl: unknown) {
  (a as unknown as { core: Record<string, unknown> }).core[name] = impl;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elicit-adapter-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
});

afterEach(() => {
  adapter.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('CoreAdapter.resolveElicitation', () => {
  it('forwards accept to the binding with the flat NAPI signature', async () => {
    const spy = vi.fn().mockResolvedValue('ok');
    stubCore(adapter, 'resolveElicitation', spy);

    await adapter.resolveElicitation('run-1', 'e-1', 'accept', 'ship it');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('run-1', 'e-1', 'accept', 'ship it');
  });

  it('forwards decline with response null (never a fabricated value)', async () => {
    const spy = vi.fn().mockResolvedValue('ok');
    stubCore(adapter, 'resolveElicitation', spy);

    await adapter.resolveElicitation('run-1', 'e-1', 'decline', null);

    expect(spy).toHaveBeenCalledWith('run-1', 'e-1', 'decline', null);
  });

  it('propagates the binding rejection untouched (route maps it to 500, not 501)', async () => {
    stubCore(
      adapter,
      'resolveElicitation',
      vi.fn().mockRejectedValue(new Error('no matching elicitation')),
    );
    await expect(
      adapter.resolveElicitation('run-1', 'e-stale', 'accept', 'x'),
    ).rejects.toThrow('no matching elicitation');
  });

  it('CROSSES the NAPI boundary on the real installed addon (the always-throw stub is gone)', async () => {
    // No stubbing: this drives the actual wicked-core-ts binding. The stub engine has no
    // pending elicitation for this run, so the ENGINE rejects — and that engine rejection,
    // not ElicitationUnsupportedError, is the proof the adapter forwarded the call.
    let caught: unknown;
    try {
      await adapter.resolveElicitation('run-none', 'e-none', 'cancel', null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(ElicitationUnsupportedError);
  });

  it('throws ElicitationUnsupportedError when the addon predates the binding', async () => {
    // Simulate a pre-0.7.2 addon: the method simply does not exist at runtime.
    stubCore(adapter, 'resolveElicitation', undefined);
    await expect(
      adapter.resolveElicitation('run-1', 'e-1', 'accept', 'x'),
    ).rejects.toBeInstanceOf(ElicitationUnsupportedError);
  });
});
