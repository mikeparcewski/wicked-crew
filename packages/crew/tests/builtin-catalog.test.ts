// X-MIG M11 (DES-W7-M11 on wicked-core#649): crew serves the built-in workflows DERIVED from the
// engine — its built-in presets laid over its phase catalog — instead of hand-written mirrors.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreAdapter } from '../src/core/adapter.js';
import { builtinDefs, phaseOfStep, presetDef } from '../src/core/builtin-catalog.js';
import type { CatalogEntry, Preset } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const entry = (id: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, kind: 'build', role: 'creator', gate: 'auto', gate_type: 'execution', executes_code: true, executor: 'agent',
  validator_pin: 'pin', pinned: true, evidence_floor: true, verified_evidence: false, skill_ref: null, description: null, ...over,
});
const ENTRIES = [
  entry('understand', { kind: 'recon', role: 'neutral', gate_type: 'value', executes_code: false, validator_pin: null, pinned: false, evidence_floor: false }),
  entry('build'),
  entry('test', { kind: 'test', role: 'evaluator', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true }),
  entry('run', { kind: 'recon', role: 'neutral', gate_type: 'value', executes_code: false, executor: 'tool', validator_pin: null, pinned: false, evidence_floor: false }),
];

describe('presetDef: a preset laid over the catalog', () => {
  it('takes a step\'s own field where it states one, else the entry\'s; the role is always the entry\'s', () => {
    const def = presetDef(
      {
        name: 'flow',
        steps: [
          { catalog: 'understand', id: 'clarify', gate: { human_confirm: { unconditional: false } } },
          { catalog: 'build', id: 'build', instructions: 'do it', skill_ref: 'wicked-garden-x' },
          { catalog: 'test', id: 'verify', depends_on: ['build'] },
          { catalog: 'run', id: 'install', kind: 'build', gate: 'consent_before', executor: { type: 'tool', cmd: ['true'] } },
        ],
      },
      ENTRIES,
    )!;
    expect(def.id).toBe('flow');
    expect(def.phases.map((p) => [p.id, p.kind, p.role, p.gate, p.executes_code, p.validator_pin])).toEqual([
      ['clarify', 'recon', 'neutral', { human_confirm: { unconditional: false } }, false, null],
      ['build', 'build', 'creator', 'auto', true, 'pin'],
      ['verify', 'test', 'evaluator', { human_confirm_if: 'verdict_not_pass' }, false, 'pin'],
      ['install', 'build', 'neutral', 'consent_before', false, null],
    ]);
    expect(def.phases[1]!.instructions).toBe('do it');
    expect(def.phases[1]!.skill_ref).toBe('wicked-garden-x');
    expect(def.phases[2]!.verified_evidence).toBe(true);
    // No stated depends_on ⇒ the step before it (display only; the engine composes the real one).
    expect(def.phases[1]!.depends_on).toEqual(['clarify']);
    expect(def.phases[3]!.executor).toEqual({ type: 'tool', cmd: ['true'] });
  });
  it('a step naming an entry this engine lacks makes no def', () => {
    expect(presetDef({ name: 'x', steps: [{ catalog: 'nope', id: 'n' }] }, ENTRIES)).toBeNull();
    expect(phaseOfStep({ catalog: 'nope', id: 'n' }, undefined, null)).toBeNull();
  });
  it('builtinDefs serves the built-ins only, in name order, and names a preset it cannot serve', () => {
    const warn: string[] = [];
    const presets = [
      { name: 'zeta', scope: 'global', created_by: 'builtin', updated_at: 0, steps: [{ catalog: 'build', id: 'b' }] },
      { name: 'mine', scope: 'global', created_by: 'studio', updated_at: 0, steps: [{ catalog: 'build', id: 'b' }] },
      { name: 'alpha', scope: 'global', created_by: 'builtin', updated_at: 0, steps: [{ catalog: 'understand', id: 'u' }] },
      { name: 'broken', scope: 'global', created_by: 'builtin', updated_at: 0, steps: [{ catalog: 'nope', id: 'n' }] },
    ] as Preset[];
    expect(builtinDefs(presets, ENTRIES, (m) => warn.push(m)).map((d) => d.id)).toEqual(['alpha', 'zeta']);
    expect(warn.some((w) => w.includes("'broken'"))).toBe(true);
  });
});

describe('the adapter serves the engine\'s built-ins (the installed wicked-core-ts)', () => {
  let dir: string;
  let adapter: CoreAdapter;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'builtin-catalog-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  });
  afterAll(() => {
    adapter.close();
    removeScratch(dir);
  });
  it('serves none before the boot read, then every built-in preset with its system flag', async () => {
    expect(adapter.listWorkflows().some((w) => w.id === 'feature')).toBe(false);
    await adapter.loadBuiltinCatalog(() => {});
    const ids = adapter.listWorkflows().map((w) => w.id);
    for (const id of ['feature', 'migration', 'qe-author-tests', 'chat', 'interactive-draft']) expect(ids).toContain(id);
    const feature = adapter.getWorkflow('feature')!;
    expect(feature.phases.map((p) => p.id)).toEqual(['clarify', 'design', 'build', 'adversarial-review', 'test', 'review']);
    expect(feature.phases.find((p) => p.id === 'build')!.executes_code).toBe(true);
    expect(feature.is_system ?? false).toBe(false);
    expect(adapter.getWorkflow('chat')!.is_system).toBe(true);
    // The runtime list holds no built-in: the user's and the seams' defs only.
    expect(adapter.listRuntimeWorkflows().some((w) => w.id === 'feature')).toBe(false);
  });
});
