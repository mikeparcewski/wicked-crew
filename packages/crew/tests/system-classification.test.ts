// X-MIG M11 (codex r1 on crew A): ONE system classification for defs, presets and runs. A campaign's
// composed node (`campaign-*`) is machine-owned on every surface; before, a def of that name was
// served as ordinary work while its run read as a system run.
import { describe, expect, it } from 'vitest';
import { isSystemWorkflow, withPresetSystemFlag, withSystemFlag } from '../src/core/run-identity.js';
import type { WorkflowDef } from '../src/core/types.js';

const def = (id: string, extra: Partial<WorkflowDef> = {}): WorkflowDef => ({ id, phases: [], ...extra });

describe('the system classification agrees across defs, presets and runs', () => {
  it('a campaign-* def is system, as its preset and its run are', () => {
    expect(isSystemWorkflow('campaign-check')).toBe(true);
    expect(withSystemFlag(def('campaign-check')).is_system).toBe(true);
    expect(withPresetSystemFlag({ name: 'campaign-check' }).system).toBe(true);
  });
  it('an ordinary def is not, and a stale flag is cleared', () => {
    expect('is_system' in withSystemFlag(def('mine', { is_system: true }))).toBe(false);
    expect(withSystemFlag(def('chat')).is_system).toBe(true);
  });
});
