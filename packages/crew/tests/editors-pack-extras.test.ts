// crew#1703: a pack that ships an editor plus skills and a block installs, in one consent.
//
// The fixture `tests/fixtures/editor-packs/acme-terms` is garden's real sample, byte for byte
// (wicked-garden tests/fixtures/packs/acme-terms at b3052a7, after wicked-garden#1570): an editor that passes every
// conformance case, a block (`acme-terms-review`, preset `presets/terms-review.json`, phase `critique`) and two skills.
// The `approve` body garden's installer posts is `{skills: [<dir>…], blocks: [<id>…]}` with no digest
// (wicked-garden scripts/editor/install.py:286-290, 605-608 at b3052a7); a copy whose preset names `check`, the phase
// the sample named before #1570, is refused with a plain reason.
//
// Coord rulings (2026-11-24):
// (a) each pack skill is added to the daemon skills root as `wicked-garden-<skill dir>`, rewriting only the
//     frontmatter `name:` line; the consent and the installed row show both names;
// (b) every phase of a block's preset must be a catalog phase, else that block is refused naming the phase and the
//     catalog phases it could use, and nothing installs.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EditorConformanceSummary, InstallEditorRefusal, Preset, PresetStep } from '../src/core/types.js';
import { installPack, PackInstallError, type ConformanceRunner, type PackApproval, type PackCheckRunner, type PackPresetsPort, type PackSkillsPort, requiredCases } from '../src/editors/pack-install.js';
import { packSkillsPort } from '../src/editors/pack-extras.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { EditorRegistry, sha256Of } from '../src/editors/registry.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'editor-packs', 'acme-terms');
/** Real catalog phase ids (src/workflow-catalog/catalog-data-v2.ts), the set the engine's catalog answers. */
const CATALOG = new Set(['plan', 'implement', 'review', 'critique', 'test']);
const APPROVE = { skills: ['acme-terms', 'acme-terms-checker'], blocks: ['acme-terms-review'] };

const scratches: string[] = [];
const scaffolds: Scaffold[] = [];
afterEach(() => {
  for (const d of scratches.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of scaffolds.splice(0)) removeScratch(s.base); // a published snapshot is locked read-only
});

function pack(phases?: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'pack-extras-'));
  scratches.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  if (phases !== undefined) {
    writeFileSync(join(root, 'presets', 'terms-review.json'), JSON.stringify({ id: 'acme-terms-review', label: 'Check our terms', phases }));
  }
  return root;
}

const passCheck: PackCheckRunner = async () => ({ ok: true, errors: [], warnings: [] });
function conformant(): ConformanceRunner {
  return vi.fn(async (packRoot: string): Promise<EditorConformanceSummary> => {
    const m = JSON.parse(readFileSync(join(packRoot, 'wicked-pack.json'), 'utf8')) as { editors: Array<Record<string, unknown> & { id: string; version: string; entry: string }> };
    return {
      ok: true,
      at: '2026-11-24T00:00:00.000Z',
      editors: m.editors.map((e) => ({ id: e.id, version: e.version, sha256: sha256Of(readFileSync(join(packRoot, e.entry))), ok: true, cases: Object.fromEntries(requiredCases(e).map((c) => [c, { ok: true }])), gaps: [] })),
    };
  });
}

/** The engine's preset store as the adapter answers it: put replaces, delete says whether it held one. */
function presetStore(seed: Preset[] = []): PackPresetsPort & { presets: Map<string, Preset> } {
  const presets = new Map(seed.map((p) => [p.name, p]));
  return {
    presets,
    catalogIds: async () => CATALOG,
    listPresets: async () => [...presets.values()],
    putPreset: async (name: string, steps: PresetStep[], _projectId?: string, createdBy?: string) => {
      const p = { name, scope: 'global', steps, created_by: createdBy ?? 'api', updated_at: 1 } as Preset;
      presets.set(name, p);
      return p;
    },
    deletePreset: async (name: string) => presets.delete(name),
  };
}

function rig(opts: { seedPresets?: Preset[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pack-extras-home-'));
  scratches.push(home);
  const studio = mkdtempSync(join(tmpdir(), 'pack-extras-studio-'));
  scratches.push(studio);
  const registry = new EditorRegistry({ stateHome: home, studioRoot: studio });
  const sc = scaffold();
  scaffolds.push(sc);
  sc.store.seed();
  const presets = presetStore(opts.seedPresets);
  // The production port over a real runtime: it waits for the boot ladder and publishes as POST /skills/publish does.
  const skills = packSkillsPort(new SkillsRuntime({ store: sc.store, log: () => undefined }));
  const conformance = conformant();
  return { registry, home, studio, sc, presets, conformance, deps: { check: passCheck, conformance, registry, skills, presets } };
}

/** The approval a person gives after reading the 409: exactly its list, and its digest. */
async function approvalFor(root: string, deps: Parameters<typeof installPack>[2]): Promise<PackApproval> {
  const err = await installPack(root, undefined, deps).catch((e: unknown) => e);
  const body = (err as PackInstallError).body as unknown as InstallEditorRefusal;
  expect(body.code).toBe('pack_needs_approval');
  return { skills: body.pack.skills, blocks: body.pack.blocks.map((b) => b.id), digest: body.digest! };
}

/** Edit a pack copy's manifest. */
function editManifest(root: string, change: (m: Record<string, unknown>) => Record<string, unknown>): void {
  const m = JSON.parse(readFileSync(join(root, 'wicked-pack.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(root, 'wicked-pack.json'), JSON.stringify(change(m)));
}

/** The skills port over the real store, with chosen store methods wrapped (a seam for a failure or a busy publish). */
function wrappedPort(base: PackSkillsPort, wrap: Partial<Record<'add' | 'replace' | 'isPublishing' | 'listFiles' | 'manifest', (...a: never[]) => unknown>>): PackSkillsPort {
  const store = new Proxy(base.store, {
    get(target, prop, recv) {
      const own = (wrap as Record<string | symbol, unknown>)[prop];
      if (typeof own === 'function') return own;
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { ...base, store };
}

const keys = (sc: Scaffold): string[] => Object.keys(sc.store.manifest().skills).filter((k) => k.startsWith('wicked-garden-acme'));

describe('crew#1703: an editor pack with skills and a block', () => {
  it('without the approval, the install is refused (409) with the list to approve, both skill names shown; nothing runs or is written', async () => {
    const r = rig();
    const err = await installPack(pack(['critique']), undefined, r.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackInstallError);
    expect((err as PackInstallError).status).toBe(409);
    const body = (err as PackInstallError).body as unknown as InstallEditorRefusal;
    expect(body.code).toBe('pack_needs_approval');
    // What the person installing reads: plain words and what to do, no internal design reference.
    expect(body.error).toMatch(/Nothing was installed/);
    expect(body.error).toMatch(/approve/);
    expect(body.error).not.toMatch(/DES-|§/);
    expect(body.pack.skills).toEqual(['acme-terms', 'acme-terms-checker']);
    expect(body.pack.installedSkills).toEqual([
      { name: 'acme-terms', key: 'wicked-garden-acme-terms' },
      { name: 'acme-terms-checker', key: 'wicked-garden-acme-terms-checker' },
    ]);
    expect(body.pack.blocks).toEqual([{ id: 'acme-terms-review', label: 'Check our terms', produces_kind: 'document', skills: ['acme-terms-checker'] }]);
    expect(body.pack.editors.map((e) => e.permissions.map((p) => p.id))).toEqual([['artifact.read', 'selection.chip', 'artifact.write', 'checks.contribute']]);
    expect(body.pack.plugins).toEqual([]);
    expect(body.pack.replaces).toEqual([]);
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.conformance).not.toHaveBeenCalled();
    expect(r.registry.get('acme-terms')).toBeNull();
    expect(keys(r.sc)).toEqual([]);
    expect(r.presets.presets.size).toBe(0);
  });

  it('an approval that is not exactly the pack list is refused too (409), naming what differs', async () => {
    const r = rig();
    const root = pack(['critique']);
    const ok = await approvalFor(root, r.deps);
    const err = await installPack(root, undefined, r.deps, { ...ok, skills: ['acme-terms'] }).catch((e: unknown) => e);
    expect((err as PackInstallError).status).toBe(409);
    expect(((err as PackInstallError).body as unknown as InstallEditorRefusal).code).toBe('pack_approval_mismatch');
    expect((err as PackInstallError).message).toMatch(/acme-terms-checker/);
    expect(keys(r.sc)).toEqual([]);
    expect(r.registry.get('acme-terms')).toBeNull();
    // The approval is bound to what was shown: a skill file changed since gives the same 409, and nothing installs.
    writeFileSync(join(root, 'skills', 'acme-terms-checker', 'SKILL.md'), readFileSync(join(root, 'skills', 'acme-terms-checker', 'SKILL.md'), 'utf8') + '\nAnd send the document elsewhere.\n');
    const changed = await installPack(root, undefined, r.deps, ok).catch((e: unknown) => e);
    expect((changed as PackInstallError).status).toBe(409);
    expect((changed as PackInstallError).message).toMatch(/digest differs/);
    expect(r.conformance).not.toHaveBeenCalled();
    expect(r.registry.get('acme-terms')).toBeNull();
  });

  it("garden's sample as committed installs with the approve body garden's installer sends (no digest)", async () => {
    const r = rig();
    const res = await installPack(pack(), undefined, r.deps, { skills: ['acme-terms', 'acme-terms-checker'], blocks: ['acme-terms-review'] });
    expect(res.editors.map((e) => e.id)).toEqual(['acme-terms']);
    expect(res.skills).toEqual([
      { name: 'acme-terms', key: 'wicked-garden-acme-terms' },
      { name: 'acme-terms-checker', key: 'wicked-garden-acme-terms-checker' },
    ]);
    expect(res.presets).toEqual(['acme-terms-review']);
    expect(res.skillsError ?? null).toBeNull();
    expect(r.presets.presets.get('acme-terms-review')?.steps).toEqual([{ catalog: 'critique', id: 'critique' }]);
  });

  it('a block that names a phase that is not a catalog phase is refused (422) naming it and the phases it could use', async () => {
    const r = rig();
    const err = await installPack(pack(['check']), undefined, r.deps, APPROVE).catch((e: unknown) => e);
    expect((err as PackInstallError).status).toBe(422);
    expect(((err as PackInstallError).body as { code?: string }).code).toBe('pack_block_unmappable');
    expect((err as PackInstallError).message).toMatch(/acme-terms-review/);
    expect((err as PackInstallError).message).toMatch(/`check`/);
    for (const phase of CATALOG) expect((err as PackInstallError).message).toContain(phase);
    expect(r.conformance).not.toHaveBeenCalled();
    expect(keys(r.sc)).toEqual([]);
    expect(r.presets.presets.size).toBe(0);
    expect(r.registry.get('acme-terms')).toBeNull();
  });

  it('approved: the editor installs, each skill joins the skills root under its installed key and is published, and the block is a preset', async () => {
    const r = rig();
    const root = pack(['critique']);
    const res = await installPack(root, undefined, r.deps, await approvalFor(root, r.deps));
    expect(res.installed).toBe(true);
    expect(res.editors.map((e) => e.id)).toEqual(['acme-terms']);
    expect(res.skills).toEqual([
      { name: 'acme-terms', key: 'wicked-garden-acme-terms' },
      { name: 'acme-terms-checker', key: 'wicked-garden-acme-terms-checker' },
    ]);
    expect(res.presets).toEqual(['acme-terms-review']);
    expect(res.skillsError).toBeUndefined();
    // The skill files: only the frontmatter `name:` line is rewritten.
    for (const dir of APPROVE.skills) {
      const source = readFileSync(join(root, 'skills', dir, 'SKILL.md'), 'utf8');
      const added = (await r.sc.store.readFile(`wicked-garden-${dir}`, 'SKILL.md')).content;
      expect(added).toBe(source.replace(`\nname: ${dir}\n`, `\nname: wicked-garden-${dir}\n`));
      expect(r.sc.store.manifest().skills[`wicked-garden-${dir}`]).toMatchObject({ enabled: true, provenance: 'user-added' });
    }
    // Published: the generation seats are handed holds both.
    expect(r.sc.store.currentSnapshotSkills()?.skills).toEqual(expect.arrayContaining(['wicked-garden-acme-terms', 'wicked-garden-acme-terms-checker']));
    expect(r.presets.presets.get('acme-terms-review')?.steps).toEqual([{ catalog: 'critique', id: 'critique' }]);
    // The installed row shows both names.
    const view = EditorRegistry.view(r.registry.get('acme-terms')!);
    expect(view.packSkills).toEqual(res.skills);
    expect(view.packBlocks).toEqual(['acme-terms-review']);
    // …and still after a restart: the install record carries them.
    const reread = new EditorRegistry({ stateHome: r.home, studioRoot: r.studio });
    expect(EditorRegistry.view(reread.get('acme-terms')!)).toMatchObject({ packSkills: res.skills, packBlocks: ['acme-terms-review'] });
  });

  it('installing the same pack again updates its own skills and preset in place', async () => {
    const r = rig();
    const first = pack(['critique']);
    await installPack(first, undefined, r.deps, await approvalFor(first, r.deps));
    const again = pack(['critique', 'review', 'critique']);
    writeFileSync(join(again, 'skills', 'acme-terms-checker', 'SKILL.md'), readFileSync(join(again, 'skills', 'acme-terms-checker', 'SKILL.md'), 'utf8') + '\nOne more line.\n');
    const consent = await installPack(again, undefined, r.deps).catch((e: unknown) => e);
    // The consent names what this install replaces.
    expect(((consent as PackInstallError).body as unknown as InstallEditorRefusal).pack.replaces).toEqual(['wicked-garden-acme-terms', 'wicked-garden-acme-terms-checker', 'acme-terms-review']);
    const res = await installPack(again, undefined, r.deps, await approvalFor(again, r.deps));
    expect(res.updated).toBe(true);
    expect((await r.sc.store.readFile('wicked-garden-acme-terms-checker', 'SKILL.md')).content).toMatch(/One more line\./);
    // A phase named twice gets its own step id.
    expect(r.presets.presets.get('acme-terms-review')?.steps).toEqual([{ catalog: 'critique', id: 'critique' }, { catalog: 'review', id: 'review' }, { catalog: 'critique', id: 'critique-2' }]);
  });

  it("a skill or preset name another pack or the operator already holds is refused (409); nothing is written", async () => {
    const r = rig();
    const taken = r.sc.store.add('wicked-garden-acme-terms', { 'SKILL.md': '---\nname: wicked-garden-acme-terms\ndescription: mine\n---\n' }, r.sc.store.revision());
    expect(taken.verdict).not.toBe('blocked');
    const err = await installPack(pack(['critique']), undefined, r.deps, APPROVE).catch((e: unknown) => e);
    expect((err as PackInstallError).status).toBe(409);
    expect(((err as PackInstallError).body as { code?: string }).code).toBe('pack_name_taken');
    expect((err as PackInstallError).message).toMatch(/wicked-garden-acme-terms\b/);
    expect(r.sc.store.manifest().skills['wicked-garden-acme-terms-checker']).toBeUndefined();
    expect(r.registry.get('acme-terms')).toBeNull();

    const p = rig({ seedPresets: [{ name: 'acme-terms-review', scope: 'global', steps: [], created_by: 'api', updated_at: 1 } as unknown as Preset] });
    const err2 = await installPack(pack(['critique']), undefined, p.deps, APPROVE).catch((e: unknown) => e);
    expect((err2 as PackInstallError).status).toBe(409);
    expect((err2 as PackInstallError).message).toMatch(/acme-terms-review/);
    expect(keys(p.sc)).toEqual([]);
  });

  it('a failed conformance run installs nothing: no skill, no preset, no editor', async () => {
    const r = rig();
    const failing: ConformanceRunner = async () => ({ ok: false, at: 'x', editors: [], error: 'no headless browser' });
    const root = pack(['critique']);
    const err = await installPack(root, undefined, { ...r.deps, conformance: failing }, await approvalFor(root, r.deps)).catch((e: unknown) => e);
    expect((err as PackInstallError).status).toBe(422);
    expect(keys(r.sc)).toEqual([]);
    expect(r.presets.presets.size).toBe(0);
    expect(r.registry.get('acme-terms')).toBeNull();
  });

  it('a daemon without a skills root refuses a pack that ships skills, with the reason', async () => {
    const r = rig();
    const err = await installPack(pack(['critique']), undefined, { ...r.deps, skills: null }, APPROVE).catch((e: unknown) => e);
    expect((err as PackInstallError).status).toBe(422);
    expect(((err as PackInstallError).body as { code?: string }).code).toBe('pack_skills_unavailable');
    expect(r.registry.get('acme-terms')).toBeNull();
  });

  it('review r1: reads stay inside the pack: a linked skill folder, skills folder or presets folder is refused (422)', async () => {
    const r = rig();
    const outside = mkdtempSync(join(tmpdir(), 'pack-extras-outside-'));
    scratches.push(outside);
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: x\ndescription: outside\n---\n');
    writeFileSync(join(outside, 'terms-review.json'), JSON.stringify({ phases: ['critique'] }));
    const linkedSkill = pack(['critique']);
    rmSync(join(linkedSkill, 'skills', 'acme-terms'), { recursive: true });
    symlinkSync(outside, join(linkedSkill, 'skills', 'acme-terms'));
    const linkedSkills = pack(['critique']);
    rmSync(join(linkedSkills, 'skills'), { recursive: true });
    symlinkSync(join(FIXTURE, 'skills'), join(linkedSkills, 'skills'));
    const linkedPresets = pack(['critique']);
    rmSync(join(linkedPresets, 'presets'), { recursive: true });
    symlinkSync(outside, join(linkedPresets, 'presets'));
    for (const root of [linkedSkill, linkedSkills, linkedPresets]) {
      const err = await installPack(root, undefined, r.deps).catch((e: unknown) => e);
      expect((err as PackInstallError).status, root).toBe(422);
    }
    expect(keys(r.sc)).toEqual([]);
  });

  it('review r1: a `name :` key is rewritten in place (one name), and a support file named __proto__ is kept', async () => {
    const r = rig();
    const root = pack(['critique']);
    writeFileSync(join(root, 'skills', 'acme-terms', 'SKILL.md'), '---\nname : acme-terms\ndescription: router\n---\n\n# Router\n');
    writeFileSync(join(root, 'skills', 'acme-terms', '__proto__'), 'kept');
    await installPack(root, undefined, r.deps, await approvalFor(root, r.deps));
    const md = (await r.sc.store.readFile('wicked-garden-acme-terms', 'SKILL.md')).content!;
    expect(md).toBe('---\nname: wicked-garden-acme-terms\ndescription: router\n---\n\n# Router\n');
    expect((await r.sc.store.readFile('wicked-garden-acme-terms', '__proto__')).content).toBe('kept');
  });

  it('review r1: a record that fails after the presets were written puts them back, and no skill is written', async () => {
    const r = rig();
    const root = pack(['critique']);
    const ok = await approvalFor(root, r.deps);
    const spy = vi.spyOn(r.registry, 'installPack').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(installPack(root, undefined, r.deps, ok)).rejects.toThrow(/disk full/);
    spy.mockRestore();
    expect(r.presets.presets.size).toBe(0);
    expect(keys(r.sc)).toEqual([]);
    // …and an update whose record fails restores the earlier preset.
    await installPack(root, undefined, r.deps, ok);
    const before = r.presets.presets.get('acme-terms-review');
    const again = pack(['review']);
    const ok2 = await approvalFor(again, r.deps);
    vi.spyOn(r.registry, 'installPack').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(installPack(again, undefined, r.deps, ok2)).rejects.toThrow(/disk full/);
    expect(r.presets.presets.get('acme-terms-review')?.steps).toEqual(before?.steps);
    // The retry goes through: nothing was left half-installed under the pack's names.
    vi.restoreAllMocks();
    const res = await installPack(again, undefined, r.deps, ok2);
    expect(res.installed).toBe(true);
  });

  it('review r1: an id another pack holds is refused before anything is written (409)', async () => {
    const r = rig();
    const other = pack(['critique']);
    const m = JSON.parse(readFileSync(join(other, 'wicked-pack.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(other, 'wicked-pack.json'), JSON.stringify({ ...m, name: 'other-pack', skills_dir: 'none', blocks: [] }));
    await installPack(other, undefined, r.deps);
    const root = pack(['critique']);
    const err = await installPack(root, undefined, r.deps, await approvalFor(root, r.deps)).catch((e: unknown) => e);
    expect((err as PackInstallError).status).toBe(409);
    expect((err as PackInstallError).message).toMatch(/already installed from the pack other-pack/);
    expect(keys(r.sc)).toEqual([]);
    expect(r.presets.presets.size).toBe(0);
  });

  it('review r1: a publish the skills root refuses leaves the install standing, says so, and takes the new skills out of the tree', async () => {
    const r = rig();
    const root = pack(['critique']);
    const ok = await approvalFor(root, r.deps);
    const blocked = { ...r.deps, skills: { ...r.deps.skills, publish: async () => ({ verdict: 'blocked' as const, findings: [{ kind: 'frontmatter-invalid', severity: 'blocking', skill: null, file: null, line: null, evidence: 'a broken skill elsewhere' } as never], snapshot: null }) } };
    const res = await installPack(root, undefined, blocked, ok);
    expect(res.installed).toBe(true);
    expect(res.skillsError).toMatch(/could not be published \(a broken skill elsewhere\)/);
    expect(r.sc.store.manifest().skills['wicked-garden-acme-terms']?.enabled).toBe(false);
    expect(r.sc.store.manifest().skills['wicked-garden-acme-terms-checker']?.enabled).toBe(false);
  });

  it('review r2: a block may not take the name of a registered workflow (409); nothing is written', async () => {
    const r = rig();
    const root = pack(['critique']);
    editManifest(root, (m) => ({ ...m, blocks: (m['blocks'] as Array<Record<string, unknown>>).map((b) => ({ ...b, id: 'inspect-unit' })) }));
    const deps = { ...r.deps, presets: { ...r.presets, listWorkflows: () => [{ id: 'inspect-unit' }, { id: 'interactive-review' }] } };
    const err = await installPack(root, undefined, deps).catch((e: unknown) => e);
    expect((err as PackInstallError).status).toBe(409);
    expect(((err as PackInstallError).body as { code?: string }).code).toBe('pack_name_taken');
    expect((err as PackInstallError).message).toMatch(/registered workflow/);
    expect(r.conformance).not.toHaveBeenCalled();
    expect(r.presets.presets.size).toBe(0);
    expect(keys(r.sc)).toEqual([]);
  });

  it('review r2: an editor-only pack never reads the skills root (a skills root that cannot answer does not fail it)', async () => {
    const r = rig();
    const root = pack(['critique']);
    editManifest(root, (m) => ({ ...m, skills_dir: 'none', blocks: [] }));
    const broken = wrappedPort(r.deps.skills, {});
    const throwing = { ...broken, store: new Proxy(broken.store, { get: (t, p, rcv) => (p === 'manifest' ? () => { throw new Error('skills root still seeding'); } : Reflect.get(t, p, rcv)) }) };
    const res = await installPack(root, undefined, { ...r.deps, skills: throwing });
    expect(res.installed).toBe(true);
    expect(res.skills).toBeUndefined();
  });

  it('review r2: after a blocked publish, installing again switches the skills on and publishes them', async () => {
    const r = rig();
    const root = pack(['critique']);
    const ok = await approvalFor(root, r.deps);
    const blocked = { ...r.deps, skills: { ...r.deps.skills, publish: async () => ({ verdict: 'blocked' as const, findings: [{ kind: 'frontmatter-invalid', severity: 'blocking', skill: null, file: null, line: null, evidence: 'a broken skill elsewhere' } as never], snapshot: null }) } };
    expect((await installPack(root, undefined, blocked, ok)).skillsError).toMatch(/could not be published/);
    expect(r.sc.store.manifest().skills['wicked-garden-acme-terms']?.enabled).toBe(false);
    const res = await installPack(root, undefined, r.deps, ok);
    expect(res.skillsError).toBeUndefined();
    expect(r.sc.store.manifest().skills['wicked-garden-acme-terms']?.enabled).toBe(true);
    expect(r.sc.store.manifest().skills['wicked-garden-acme-terms-checker']?.enabled).toBe(true);
    expect(r.sc.store.currentSnapshotSkills()?.skills).toEqual(expect.arrayContaining(['wicked-garden-acme-terms', 'wicked-garden-acme-terms-checker']));
  });

  it('review r2: an update whose second skill write fails puts the first back as it was; a later publish ships the old pair', async () => {
    const r = rig();
    const first = pack(['critique']);
    await installPack(first, undefined, r.deps, await approvalFor(first, r.deps));
    const v1 = (await r.sc.store.readFile('wicked-garden-acme-terms', 'SKILL.md')).content;
    const again = pack(['critique']);
    for (const dir of APPROVE.skills) writeFileSync(join(again, 'skills', dir, 'SKILL.md'), readFileSync(join(again, 'skills', dir, 'SKILL.md'), 'utf8') + '\nVersion two.\n');
    const ok = await approvalFor(again, r.deps);
    const realReplace = r.sc.store.replace.bind(r.sc.store);
    const failing = wrappedPort(r.deps.skills, {
      replace: ((name: string, files: Record<string, string>, rev: number) => {
        if (name === 'wicked-garden-acme-terms-checker' && files['SKILL.md']?.includes('Version two.')) throw new Error('disk full');
        return realReplace(name, files, rev);
      }) as never,
    });
    const res = await installPack(again, undefined, { ...r.deps, skills: failing }, ok);
    expect(res.skillsError).toMatch(/refused the skill acme-terms-checker .*disk full/);
    expect((await r.sc.store.readFile('wicked-garden-acme-terms', 'SKILL.md')).content).toBe(v1);
    expect(r.sc.store.manifest().skills['wicked-garden-acme-terms']?.enabled).toBe(true);
    const published = await r.deps.skills.publish();
    expect(published.verdict).not.toBe('blocked');
    expect((await r.sc.store.readFile('wicked-garden-acme-terms-checker', 'SKILL.md')).content).not.toMatch(/Version two\./);
  });

  it('review r2: the pack keeps its skills and preset after its last editor is removed, so a reinstall (after a restart too) updates them', async () => {
    const r = rig();
    const root = pack(['critique']);
    const ok = await approvalFor(root, r.deps);
    await installPack(root, undefined, r.deps, ok);
    expect(r.registry.removeInstalled('acme-terms')).toBe(true);
    const reread = new EditorRegistry({ stateHome: r.home, studioRoot: r.studio });
    expect(reread.get('acme-terms')).toBeNull();
    const res = await installPack(root, undefined, { ...r.deps, registry: reread }, ok);
    expect(res.installed).toBe(true);
    expect(res.skills?.map((s) => s.key)).toEqual(['wicked-garden-acme-terms', 'wicked-garden-acme-terms-checker']);
  });

  it('review r2: a preset that cannot be put back is named in the refusal, and installing again finishes the job', async () => {
    const r = rig();
    const root = pack(['critique']);
    const ok = await approvalFor(root, r.deps);
    vi.spyOn(r.registry, 'installPack').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const stuck = { ...r.deps, presets: { ...r.presets, deletePreset: async () => { throw new Error('engine store unavailable'); } } };
    await expect(installPack(root, undefined, stuck, ok)).rejects.toThrow(/putting the presets back also failed: acme-terms-review: engine store unavailable/);
    vi.restoreAllMocks();
    expect(r.presets.presets.get('acme-terms-review')?.created_by).toBe('pack:acme-terms');
    const res = await installPack(root, undefined, r.deps, ok);
    expect(res.installed).toBe(true);
    expect(res.presets).toEqual(['acme-terms-review']);
  });

  it('review r2: the consent lists a run plugin the pack also ships, with the topics it observes', async () => {
    const r = rig();
    const root = pack(['critique']);
    const html = '<!doctype html><html><body>times</body></html>';
    mkdirSync(join(root, 'plugins', 'acme-times'), { recursive: true });
    writeFileSync(join(root, 'plugins', 'acme-times', 'index.html'), html);
    const observe = [{ topic: 'wicked.run.unit.*', why: 'to show each phase' }];
    editManifest(root, (m) => ({ ...m, plugins: [{ id: 'acme-times', title: 'Phase times', version: '0.1.0', protocol: [3], inline: 'run-thread', entry: 'plugins/acme-times/index.html', sha256: sha256Of(Buffer.from(html)), observe, panels: [{ slot: 'run.details', id: 'main', title: 'Phase times', order: 1 }] }] }));
    const err = await installPack(root, undefined, r.deps).catch((e: unknown) => e);
    const body = (err as PackInstallError).body as unknown as InstallEditorRefusal;
    expect(body.code).toBe('pack_needs_approval');
    expect(body.pack.plugins).toEqual([{ id: 'acme-times', title: 'Phase times', version: '0.1.0', observe }]);
    expect(r.conformance).not.toHaveBeenCalled();
  });

  it('review r2: the skills are written only once a publish in flight has finished, all in one pass', async () => {
    const r = rig();
    const root = pack(['critique']);
    const ok = await approvalFor(root, r.deps);
    let busy = 3;
    const seen: boolean[] = [];
    const realAdd = r.sc.store.add.bind(r.sc.store);
    const port = wrappedPort(r.deps.skills, {
      isPublishing: (() => busy-- > 0) as never,
      add: ((name: string, files: Record<string, string>, rev: number) => {
        seen.push(busy > 0);
        return realAdd(name, files, rev);
      }) as never,
    });
    const res = await installPack(root, undefined, { ...r.deps, skills: port }, ok);
    expect(res.skillsError).toBeUndefined();
    expect(seen).toEqual([false, false]);
    expect(r.sc.store.currentSnapshotSkills()?.skills).toEqual(expect.arrayContaining(['wicked-garden-acme-terms', 'wicked-garden-acme-terms-checker']));
  });

  it('review r3: a registered workflow name is held even against a preset the pack already owns', async () => {
    const r = rig();
    const root = pack(['critique']);
    const ok = await approvalFor(root, r.deps);
    await installPack(root, undefined, r.deps, ok);
    const deps = { ...r.deps, presets: { ...r.presets, listWorkflows: () => [{ id: 'acme-terms-review' }] } };
    const err = await installPack(root, undefined, deps, ok).catch((e: unknown) => e);
    expect((err as PackInstallError).status).toBe(409);
    expect((err as PackInstallError).message).toMatch(/registered workflow/);
  });

  it('review r3: an editor-only update of a pack that shipped skills never waits on or reads the skills root', async () => {
    const r = rig();
    const root = pack(['critique']);
    await installPack(root, undefined, r.deps, await approvalFor(root, r.deps));
    const editorOnly = pack(['critique']);
    editManifest(editorOnly, (m) => ({ ...m, skills_dir: 'none', blocks: [] }));
    let touched = 0;
    const port = { ...wrappedPort(r.deps.skills, { manifest: (() => { touched++; throw new Error('skills root still seeding'); }) as never }), ready: async () => { touched++; } };
    const res = await installPack(editorOnly, undefined, { ...r.deps, skills: port });
    expect(res.installed).toBe(true);
    expect(touched).toBe(0);
    // The earlier skills stay the pack's own.
    expect(res.skills?.map((k) => k.key)).toEqual(['wicked-garden-acme-terms', 'wicked-garden-acme-terms-checker']);
  });

  it('review r3: a second preset write that fails puts the first back, and says so when that fails too', async () => {
    const r = rig();
    const root = pack(['critique']);
    writeFileSync(join(root, 'presets', 'second.json'), JSON.stringify({ id: 'acme-terms-second', label: 'Second', phases: ['review'] }));
    editManifest(root, (m) => ({ ...m, blocks: [...(m['blocks'] as Array<Record<string, unknown>>), { id: 'acme-terms-second', label: 'Second', preset: 'presets/second.json', produces_kind: 'document', skills: ['acme-terms-checker'] }] }));
    const ok = await approvalFor(root, r.deps);
    const realPut = r.presets.putPreset;
    const failing = {
      ...r.presets,
      putPreset: async (name: string, steps: PresetStep[], projectId?: string, createdBy?: string) => {
        if (name === 'acme-terms-second') throw new Error('engine store unavailable');
        return realPut(name, steps, projectId, createdBy);
      },
      deletePreset: async () => { throw new Error('engine store unavailable'); },
    };
    await expect(installPack(root, undefined, { ...r.deps, presets: failing }, ok)).rejects.toThrow(/putting the presets back also failed: acme-terms-review/);
    expect(r.registry.get('acme-terms')).toBeNull();
    expect(keys(r.sc)).toEqual([]);
  });

  it('review r3: an update whose current skill cannot be copied whole changes no skill', async () => {
    const r = rig();
    const first = pack(['critique']);
    await installPack(first, undefined, r.deps, await approvalFor(first, r.deps));
    const v1 = (await r.sc.store.readFile('wicked-garden-acme-terms-checker', 'SKILL.md')).content;
    const again = pack(['critique']);
    for (const dir of APPROVE.skills) writeFileSync(join(again, 'skills', dir, 'SKILL.md'), readFileSync(join(again, 'skills', dir, 'SKILL.md'), 'utf8') + '\nVersion two.\n');
    const ok = await approvalFor(again, r.deps);
    const port = wrappedPort(r.deps.skills, { listFiles: (() => { throw new Error('EACCES'); }) as never });
    const res = await installPack(again, undefined, { ...r.deps, skills: port }, ok);
    expect(res.skillsError).toMatch(/could not be copied whole/);
    expect((await r.sc.store.readFile('wicked-garden-acme-terms-checker', 'SKILL.md')).content).toBe(v1);
  });

  it('review r3: a put-back the store refuses is named, not reported as done', async () => {
    const r = rig();
    const first = pack(['critique']);
    await installPack(first, undefined, r.deps, await approvalFor(first, r.deps));
    const again = pack(['critique']);
    for (const dir of APPROVE.skills) writeFileSync(join(again, 'skills', dir, 'SKILL.md'), readFileSync(join(again, 'skills', dir, 'SKILL.md'), 'utf8') + '\nVersion two.\n');
    const ok = await approvalFor(again, r.deps);
    const realReplace = r.sc.store.replace.bind(r.sc.store);
    const port = wrappedPort(r.deps.skills, {
      replace: ((name: string, files: Record<string, string>, rev: number) => {
        if (name === 'wicked-garden-acme-terms-checker') throw new Error('disk full');
        if (!files['SKILL.md']?.includes('Version two.')) return { verdict: 'blocked', findings: [] };
        return realReplace(name, files, rev);
      }) as never,
    });
    const res = await installPack(again, undefined, { ...r.deps, skills: port }, ok);
    expect(res.skillsError).toMatch(/could not put back wicked-garden-acme-terms-checker, wicked-garden-acme-terms; install the pack again/);
  });
});
