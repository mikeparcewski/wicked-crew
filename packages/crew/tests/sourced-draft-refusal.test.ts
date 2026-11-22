// crew#1445: a sourced draft launches only on the built-in, or on a saved shadow that keeps the built-in's checks. The
// reads follow core's listing (`preset::list_presets`): a project's row replaces the global one by name, and the global
// listing is read with no project.
import { describe, expect, it, vi } from 'vitest';

import type { CatalogEntry, Preset } from '../src/core/types.js';
import { sourcedDraftRefusal, type DraftPresetReads } from '../src/workflow-catalog/build-v2.js';

const NAME = 'interactive-draft-sourced';
const STEPS = [{ catalog: 'produce', id: 'draft' }, { catalog: 'critique', id: 'check', rubric: 'fidelity-to-source' }];
const BUILTIN = { name: NAME, created_by: 'builtin', scope: 'global', steps: STEPS } as unknown as Preset;
const saved = (scope: string, steps: unknown[]): Preset => ({ name: NAME, created_by: 'me', scope, steps }) as unknown as Preset;
const NO_CHECK = [{ catalog: 'produce', id: 'draft' }, { catalog: 'critique', id: 'check' }];

/** Core's listing: the global rows, with the asked project's rows replacing them by name. */
function reads(rows: Preset[], catalog: () => Promise<CatalogEntry[]> = async () => []) {
  const listPresets = vi.fn(async (projectId?: string) => {
    const by = new Map<string, Preset>();
    for (const r of rows.filter((x) => x.scope === 'global')) by.set(r.name, r);
    if (projectId !== undefined) for (const r of rows.filter((x) => x.scope === `project:${projectId}`)) by.set(r.name, r);
    return [...by.values()];
  });
  return { listPresets, catalog };
}

describe('sourcedDraftRefusal (crew#1445)', () => {
  it('the built-in launches, read once', async () => {
    const r = reads([BUILTIN]);
    expect(await sourcedDraftRefusal(r, undefined, NAME)).toBeNull();
    expect(await sourcedDraftRefusal(r, 'p1', NAME)).toBeNull();
    expect(r.listPresets).toHaveBeenCalledTimes(2);
  });

  it("a project's shadow that keeps the fidelity check launches; one without it is refused with what it lacks", async () => {
    expect(await sourcedDraftRefusal(reads([BUILTIN, saved('project:p1', STEPS)]), 'p1', NAME)).toBeNull();
    expect(await sourcedDraftRefusal(reads([BUILTIN, saved('project:p1', NO_CHECK)]), 'p1', NAME))
      .toBe("your saved `interactive-draft-sourced` has fewer checks than the built-in (it lacks the fidelity-to-source check on its `check` step); delete it or add them back");
    // The check moved to another step is not the check on the step it protects.
    const moved = [{ catalog: 'produce', id: 'draft', rubric: 'fidelity-to-source' }, { catalog: 'critique', id: 'check' }];
    expect(await sourcedDraftRefusal(reads([BUILTIN, saved('project:p1', moved)]), 'p1', NAME)).toMatch(/fewer checks/u);
  });

  it("another project's shadow is not read; an Unfiled draft reads the global listing", async () => {
    expect(await sourcedDraftRefusal(reads([BUILTIN, saved('project:p2', NO_CHECK)]), 'p1', NAME)).toBeNull();
    expect(await sourcedDraftRefusal(reads([BUILTIN, saved('project:p2', NO_CHECK)]), undefined, NAME)).toBeNull();
  });

  it('no built-in to compare to (none served, an unreadable listing, or a saved global row in its place) has no sourced draft', async () => {
    const none = "this engine has no sourced draft yet; update wicked-crew's engine";
    expect(await sourcedDraftRefusal(reads([]), 'p1', NAME)).toBe(none);
    expect(await sourcedDraftRefusal({ listPresets: async () => { throw new Error('old engine'); }, catalog: async () => [] }, 'p1', NAME)).toBe(none);
    expect(await sourcedDraftRefusal(reads([saved('global', STEPS)]), undefined, NAME)).toBe(none);
    expect(await sourcedDraftRefusal(reads([saved('global', STEPS), saved('project:p1', STEPS)]), 'p1', NAME)).toBe(none);
  });

  it('a saved global row in place of the built-in row is compared with the built-in def, as the catalog does', async () => {
    const def = { id: NAME, phases: [{ id: 'draft', kind: 'produce', role: 'creator' }, { id: 'check', kind: 'critique', role: 'evaluator', rubric: 'fidelity-to-source' }] };
    const withDef = (rows: Preset[]) => ({ ...reads(rows), getWorkflow: (id: string) => (id === NAME ? def : null) }) as unknown as DraftPresetReads;
    expect(await sourcedDraftRefusal(withDef([saved('global', STEPS)]), undefined, NAME)).toBeNull();
    expect(await sourcedDraftRefusal(withDef([saved('global', NO_CHECK)]), undefined, NAME)).toMatch(/lacks the fidelity-to-source check on its `check` step/u);
    expect(await sourcedDraftRefusal(withDef([saved('global', STEPS), saved('project:p1', STEPS)]), 'p1', NAME)).toBeNull();
  });

  it('a writing step after the check makes it stale', async () => {
    const rewrite = [...STEPS, { catalog: 'produce', id: 'polish', role: 'creator' }];
    expect(await sourcedDraftRefusal(reads([BUILTIN, saved('project:p1', rewrite)]), 'p1', NAME)).toMatch(/`polish` step rewrites the output after `check`/u);
  });

  it('an unreadable phase catalog is said as that, never as a weaker preset', async () => {
    const r = reads([BUILTIN, saved('project:p1', STEPS)], async () => { throw new Error('no catalog binding'); });
    const why = await sourcedDraftRefusal(r, 'p1', NAME);
    expect(why).toMatch(/could not be checked against the built-in \(the phase catalog is unreadable: no catalog binding\)/u);
    expect(why).not.toMatch(/fewer checks/u);
  });
});
