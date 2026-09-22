// FINDING-002 root cause: a REJECTED registration still mutated state.
//
// The finding said user-registered workflows "vanish from the API/UI registry after daemon
// restart". That is the symptom. Reproduced end to end against a live daemon, the mechanism is:
//
//   1. POST /api/v1/workflows answered
//        400 invalid workflow JSON: unknown field `name`, expected `id` or `phases`
//   2. ...and the overlay file was written anyway, `name` included
//   3. ...and the workflow was served from `userWorkflows`, so it looked registered
//   4. on the next start core could not deserialise its own overlay file:
//        wicked-core: skipping workflow file .../probe-002-persist.json
//   5. the workflow VANISHED from the API while its file sat on disk
//
// So it is not "registration is not durable". It is "a rejected request persisted a definition
// core's own parser calls invalid, into the directory core loads at dispatch" — a poison pill that
// stays invisible until a restart.
//
// The cause was ORDERING: writeFile → userWorkflows.set → registerWorkflow(validate). Validation
// ran last, after the state it was supposed to guard.
//
// These tests pin the ordering, not the wording of any one error. A fake core stands in for the
// engine so the rejection is deterministic and the assertions are about crew's persistence
// behaviour — which is the part that was wrong.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let overlayDir: string;
let priorOverlayDir: string | undefined;
let adapter: CoreAdapter | undefined;

const DEF = {
  id: 'atomicity-probe',
  phases: [{ id: 'only', executor: { type: 'tool', cmd: ['true'] } }],
} as unknown as WorkflowDef;

/** Swap in a fake engine binding; `undefined` simulates an engine that lacks it entirely.
 *  Assigns rather than `delete`s: the binding lives on the prototype, so an own property is what
 *  actually shadows it — `delete` on the instance silently leaves the real method in place. */
function stubRegister(a: CoreAdapter, impl: ((json: string) => Promise<string>) | undefined) {
  const core = (a as unknown as { core: Record<string, unknown> }).core;
  core['registerWorkflow'] = impl;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'register-atomic-'));
  overlayDir = join(dir, 'workflows');
  mkdirSync(overlayDir, { recursive: true });
  priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
  process.env['WICKED_WORKFLOWS_DIR'] = overlayDir;
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
});

afterEach(() => {
  if (priorOverlayDir === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
  else process.env['WICKED_WORKFLOWS_DIR'] = priorOverlayDir;
  adapter?.close();
  adapter = undefined;
  removeScratch(dir);
});

describe('registerWorkflow is atomic (FINDING-002)', () => {
  /// THE invariant. The observed defect was a 400 that left a file behind.
  it('a definition core rejects leaves nothing on disk', async () => {
    stubRegister(adapter!, () =>
      Promise.reject(new Error('invalid workflow JSON: unknown field `name`')),
    );

    await expect(adapter!.registerWorkflow(DEF)).rejects.toThrow(/unknown field/);

    expect(
      readdirSync(overlayDir),
      'a rejected registration must not write to the directory core loads at dispatch',
    ).toEqual([]);
  });

  /// The other half of step 3: it must not be SERVED either. A workflow present in the catalog
  /// but absent from disk is precisely the state that "vanishes" on restart.
  it('a definition core rejects is not served from the in-memory registry', async () => {
    stubRegister(adapter!, () => Promise.reject(new Error('invalid workflow JSON')));

    await expect(adapter!.registerWorkflow(DEF)).rejects.toThrow();

    const served = adapter!.listWorkflows().map((w) => w.id);
    expect(served).not.toContain(DEF.id);
  });

  /// C4-style control: the fix must not break the working path. A def core accepts is written,
  /// served, and validated BEFORE the write — asserted by observing the file did not yet exist
  /// at validation time, which is what actually pins the ordering.
  it('an accepted definition is validated first, then written and served', async () => {
    let existedWhenValidated: boolean | undefined;
    stubRegister(adapter!, (json: string) => {
      existedWhenValidated = existsSync(join(overlayDir, `${DEF.id}.json`));
      expect(JSON.parse(json).id).toBe(DEF.id);
      return Promise.resolve('{}');
    });

    await expect(adapter!.registerWorkflow(DEF)).resolves.toBe(DEF.id);

    expect(existedWhenValidated, 'validation must run BEFORE the write, not after').toBe(false);
    expect(existsSync(join(overlayDir, `${DEF.id}.json`))).toBe(true);
    expect(adapter!.listWorkflows().map((w) => w.id)).toContain(DEF.id);
  });

  /// No validator means no safe way to persist: an unvalidated def is a file core may silently
  /// skip at load. Refusing is loud; the vanishing act it replaces was not.
  it('refuses to persist when the engine exposes no validator', async () => {
    stubRegister(adapter!, undefined);

    await expect(adapter!.registerWorkflow(DEF)).rejects.toThrow(/registerWorkflow binding/);
    expect(readdirSync(overlayDir)).toEqual([]);
  });
});

// The SAME defect lived in `_writeBuiltinOverlay`, the sibling writer `launchRun` uses to deliver
// drop-in defs. Caught in review of the fix above, which makes it the P3 shape this campaign keeps
// finding: N paths, one hardened. Fixing only the reported path would have left the poison pill
// reachable through the more commonly travelled one.
describe('the built-in overlay writer has the same ordering (FINDING-002, P3)', () => {
  /** `_writeBuiltinOverlay` is private and reached via launchRun; call it directly rather than
   *  standing up a whole run, in the same spirit as the `core` cast above. */
  function writeBuiltin(a: CoreAdapter, def: WorkflowDef): Promise<void> {
    return (a as unknown as { _writeBuiltinOverlay(d: WorkflowDef): Promise<void> })
      ._writeBuiltinOverlay(def);
  }

  it('a mirror core rejects is not left in the dispatch overlay dir', async () => {
    stubRegister(adapter!, () => Promise.reject(new Error('invalid workflow JSON')));

    await expect(writeBuiltin(adapter!, DEF)).rejects.toThrow(/invalid workflow JSON/);
    expect(
      readdirSync(overlayDir),
      'a rejected mirror must not be written — core would skip it at the next load',
    ).toEqual([]);
  });

  /// Delivery must still work. This write is the ONLY way core resolves a drop-in id, so an
  /// over-strict fix here turns a silent ungating into a hard "unknown workflow" — the regression
  /// FINDING-084's first attempted fix caused.
  it('still delivers an accepted mirror', async () => {
    stubRegister(adapter!, () => Promise.resolve('{}'));

    await expect(writeBuiltin(adapter!, DEF)).resolves.toBeUndefined();
    expect(readdirSync(overlayDir)).toEqual([`${DEF.id}.json`]);
  });

  /// Deliberately UNLIKE registerWorkflow: a built-in mirror is asserted field-for-field against
  /// core's own workflows/<id>.json by builtin-overlay-shadow.test.ts, so its parseability is
  /// established at build time. Refusing here would break delivery for no runtime gain.
  it('still delivers when the engine exposes no validator, unlike a user def', async () => {
    stubRegister(adapter!, undefined);

    await expect(writeBuiltin(adapter!, DEF)).resolves.toBeUndefined();
    expect(readdirSync(overlayDir)).toEqual([`${DEF.id}.json`]);
  });
});
