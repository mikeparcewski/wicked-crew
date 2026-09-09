// The daemon-owned skills store (skills keystone, design v3 + v3.1/v3.2): seed → content-hash
// baseline; publish → immutable, READ-ONLY snapshot of ENABLED skills only with the generated
// copilot view, `current` flipped, generations reaped; the whole-tree validation naming file:line;
// enablement orthogonal to content (reset); CAS on every mutation; skill-scoped containment FROM
// THE ROOT (no-follow everywhere — replace/add destinations and baseline reads included); ownership
// from the deepest SKILL.md ON DISK; the core closure COMPLETE (missing refs / absent mandates
// block); the three-way refresh (a deletion is a modification); `current` verified on EVERY read;
// publish serialized and root-bound; crash-safe, idempotent publish; baselines retained while
// referenced; venv provisioning awaited, deduped, read-only, and BLOCKING when it fails.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pluginBundleFiles } from '../src/skills/bundle.js';
import { SkillPathError } from '../src/skills/contain.js';
import { pluginSourceAt } from '../src/skills/plugin-source.js';
import {
  COPILOT_VIEW_SKILLS_REL,
  RevisionMismatchError,
  SkillsCurrentInvalidError,
  SkillsPublishInFlightError,
  SkillsRootChangedError,
  SkillsSourceUnavailableError,
  SkillsStore,
  type SnapshotManifest,
} from '../src/skills/store.js';
import { hashFileSet, removeTreeForce, walkFiles } from '../src/skills/tree.js';
import { noVenv, VENV_READY_MARKER, type VenvProvisioner } from '../src/skills/venv.js';
import { removeScratch } from './setup/scratch.js';
import { CLOCK, FIXTURE_PLUGIN, REGISTERED_REFS, scaffold, type Scaffold } from './support/skills-fixture.js';

let s: Scaffold;

beforeEach(() => {
  s = scaffold();
});

afterEach(() => {
  removeScratch(s.base);
});

const rels = (dir: string): string[] => walkFiles(dir).map((f) => f.rel);
const snapshotManifest = (path: string): SnapshotManifest =>
  JSON.parse(readFileSync(join(path, 'snapshot.json'), 'utf8')) as SnapshotManifest;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
/** A published generation is locked read-only: a deliberate tamper has to unlock the parent dir and the file first. */
const unlock = (file: string): void => {
  chmodSync(dirname(file), 0o755);
  if (existsSync(file)) chmodSync(file, 0o644);
};
const viewPath = (snapshot: string, ...rest: string[]): string => join(snapshot, ...COPILOT_VIEW_SKILLS_REL.split('/'), ...rest);
/** A provisioner parked until `release()` — the seam every concurrency probe drives. */
const gatedProvisioner = (state: 'skipped' | 'synced' = 'skipped'): { provisioner: VenvProvisioner; release: () => void; calls: number[] } => {
  const calls: number[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provisioner: VenvProvisioner = async (baselineDir) => {
    calls.push(calls.length + 1);
    await gate;
    if (state === 'synced') {
      mkdirSync(join(baselineDir, '.venv', 'bin'), { recursive: true });
      writeFileSync(join(baselineDir, '.venv', 'bin', 'python'), '#!/bin/sh\n');
    }
    return state;
  };
  return { provisioner, release: () => release(), calls };
};
/** A SECOND store instance over the same root — no memo, so `current` is re-verified from disk. */
const storeOver = (sc: Scaffold): SkillsStore =>
  new SkillsStore({
    root: sc.root,
    registeredSkillRefs: () => REGISTERED_REFS,
    provisionVenv: noVenv,
    source: () => pluginSourceAt(sc.upstream),
    now: () => CLOCK,
    warn: () => undefined,
  });
const editedOnDisk = (sc: Scaffold, skill: string, body: string): void =>
  writeFileSync(join(sc.root, 'effective', 'skills', skill, 'SKILL.md'), `---\nname: wicked-garden-${skill}\n---\n\n${body}\n`);

describe('seed (design v3 §1/§4/§5)', () => {
  it('copies the dependency closure — and nothing else — into a content-hash baseline and effective/', () => {
    const result = s.store.seed();
    expect(result.seeded).toBe(true);
    const bundle = rels(join(s.root, 'baseline', result.baseline as string));
    expect(bundle).toEqual(rels(join(s.root, 'effective')));
    // The closure: manifest + catalogs, skills verbatim, scripts minus ci/wg, schemas, docs/examples, pyproject.
    expect(bundle).toContain('.claude-plugin/plugin.json');
    expect(bundle).toContain('.claude-plugin/archetypes.json');
    expect(bundle).toContain('.claude-plugin/components.json');
    expect(bundle).toContain('skills/alpha/nested/SKILL.md');
    expect(bundle).toContain('scripts/_python.sh');
    expect(bundle).toContain('schemas/evidence.json');
    expect(bundle).toContain('docs/examples/campaign.yml');
    expect(bundle).toContain('pyproject.toml');
    expect(bundle.some((r) => r.startsWith('scripts/ci/'))).toBe(false);
    expect(bundle.some((r) => r.startsWith('scripts/wg/'))).toBe(false);
    expect(bundle).not.toContain('docs/other.md');
    expect(bundle).not.toContain('hooks/hooks.json');
  });

  it('is idempotent and keys the catalog by the path-derived name with fork-first kinds, portability and the core closure', () => {
    s.store.seed();
    expect(s.store.seed().seeded).toBe(false);
    const m = s.store.manifest();
    expect(m.revision).toBe(1);
    expect(Object.keys(m.skills).sort()).toEqual([
      'wicked-garden-alpha',
      'wicked-garden-alpha-nested',
      'wicked-garden-beta',
      'wicked-garden-delta',
      'wicked-garden-epsilon',
      'wicked-garden-gamma',
    ]);
    const alpha = m.skills['wicked-garden-alpha'];
    const nested = m.skills['wicked-garden-alpha-nested'];
    expect(alpha).toMatchObject({ dir: 'skills/alpha', kind: 'router', portable: false, core: false, enabled: true, provenance: 'shipped' });
    // Fork-first: `context: fork` wins over `user-invocable: true`.
    expect(nested).toMatchObject({ dir: 'skills/alpha/nested', kind: 'fork-worker', portable: false });
    expect(m.skills['wicked-garden-beta']).toMatchObject({ kind: 'module', portable: true, core: true });
    // gamma is core THROUGH beta's SKILL.md mention (the mandate closure), not by direct reference.
    expect(m.skills['wicked-garden-gamma']).toMatchObject({ portable: true, core: true });
    expect(m.skills['wicked-garden-delta']).toMatchObject({ portable: false, core: false });
    expect(m.skills['wicked-garden-epsilon']).toMatchObject({ portable: false, core: false });
    // Every managed file has a record; a shipped one has equal hashes and no publish yet.
    expect(m.files['skills/beta/SKILL.md']).toMatchObject({ lastPublishedHash: null, conflict: false });
    expect(m.files['skills/beta/SKILL.md']?.baselineHash).toBe(m.files['skills/beta/SKILL.md']?.effectiveHash);
    // The baseline record carries the source facts; the venv is provisioned by the first publish, not the seed.
    expect(m.baselines[m.baseline]).toMatchObject({ plugin_version: '1.0.0', source: { path: s.upstream }, git_sha: null, venv: 'pending' });
  });

  it('baseline identity is the content hash of the bundle — stable across seeds, moved by one byte', () => {
    const a = s.store.seed().baseline;
    const other = scaffold();
    try {
      expect(other.store.seed().baseline).toBe(a);
      expect(a).toBe(hashFileSet(pluginBundleFiles(FIXTURE_PLUGIN)));
    } finally {
      removeScratch(other.base);
    }
    const third = scaffold();
    try {
      writeFileSync(join(third.upstream, 'skills', 'gamma', 'SKILL.md'), readFileSync(join(third.upstream, 'skills', 'gamma', 'SKILL.md'), 'utf8') + '\n');
      expect(third.store.seed().baseline).not.toBe(a);
    } finally {
      removeScratch(third.base);
    }
  });

  it('refuses loudly when no plugin is installed — crew does not vendor garden', () => {
    const none = scaffold({ source: () => null });
    try {
      expect(() => none.store.seed()).toThrow(SkillsSourceUnavailableError);
      expect(none.store.isSeeded()).toBe(false);
    } finally {
      removeScratch(none.base);
    }
  });

  it('keys a skill whose declared name differs from its path by the PATH, warns, and blocks publish with name-mismatch', async () => {
    mkdirSync(join(s.upstream, 'skills', 'zeta'), { recursive: true });
    writeFileSync(join(s.upstream, 'skills', 'zeta', 'SKILL.md'), '---\nname: wicked-garden-zzz\n---\n\nmisnamed\n');
    s.store.seed();
    expect(Object.keys(s.store.manifest().skills)).toContain('wicked-garden-zeta');
    expect(s.store.manifest().skills['wicked-garden-zzz']).toBeUndefined();
    expect(s.warnings.some((w) => w.includes('wicked-garden-zzz') && w.includes('path-derived'))).toBe(true);
    const blocked = await s.store.publish(1);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.findings.find((f) => f.kind === 'name-mismatch')).toMatchObject({
      severity: 'blocking',
      skill: 'wicked-garden-zeta',
      file: 'skills/zeta/SKILL.md',
    });
    const fixed = s.store.writeFile('wicked-garden-zeta', 'SKILL.md', '---\nname: wicked-garden-zeta\n---\n\nnamed\n', 1);
    expect(fixed.verdict).toBe('clear');
    expect((await s.store.publish(fixed.revision)).verdict).toBe('clear');
  });
});

describe('publish (design v3 §1)', () => {
  it('writes an immutable snapshot of ENABLED skills only, with the closure and a valid snapshot.json, and flips current', async () => {
    s.store.seed();
    const disabled = s.store.disable('wicked-garden-delta', 1);
    expect(disabled.verdict).toBe('clear');
    const result = await s.store.publish(disabled.revision);
    expect(result.verdict).toBe('clear');
    expect(result.snapshot).not.toBeNull();
    const snap = result.snapshot as NonNullable<typeof result.snapshot>;
    expect(snap.gen).toBe(1);
    const files = rels(snap.path);
    expect(files.some((r) => r.startsWith('skills/delta/'))).toBe(false);
    expect(files).toContain('skills/alpha/nested/SKILL.md');
    expect(files).toContain('scripts/_python.sh');
    expect(files).toContain('.claude-plugin/archetypes.json');
    expect(files).toContain('snapshot.json');
    // No env was provisioned (`noVenv` → skipped): NO `.venv` link — a dangling link would let a
    // worker's `uv run` create the env THROUGH it into the baseline. snapshot.json says why.
    expect(existsSync(join(snap.path, '.venv'))).toBe(false);
    const manifest = snapshotManifest(snap.path);
    expect(manifest.venv).toBe('skipped');
    expect(manifest.gen).toBe(1);
    expect(manifest.contentHash).toBe(snap.contentHash);
    expect(manifest.gardenSource).toMatchObject({ plugin_version: '1.0.0', baseline: s.store.manifest().baseline });
    expect(manifest.skills.map((x) => x.name)).toEqual([
      'wicked-garden-alpha',
      'wicked-garden-alpha-nested',
      'wicked-garden-beta',
      'wicked-garden-epsilon',
      'wicked-garden-gamma',
    ]);
    // Every row carries the seat-compatibility facts core requires (v3.1 §5): a boolean `portable`,
    // and `nested` for a dir deeper than `skills/<dir>` (not invocable for a Claude seat).
    expect(manifest.skills.find((x) => x.name === 'wicked-garden-alpha-nested')).toEqual({
      name: 'wicked-garden-alpha-nested',
      dir: 'skills/alpha/nested',
      kind: 'fork-worker',
      core: false,
      portable: false,
      nested: true,
    });
    expect(manifest.skills.every((x) => typeof x.portable === 'boolean' && typeof x.nested === 'boolean')).toBe(true);
    expect(manifest.skills.filter((x) => x.nested).map((x) => x.name)).toEqual(['wicked-garden-alpha-nested']);
    // The copilot view (v3.2 §4): the enabled PORTABLE skills' own files under their frontmatter
    // names, inside the snapshot, named in snapshot.json — non-portable skills (alpha, alpha/nested,
    // epsilon) and the disabled delta are not laid out. It is part of the content hash (below).
    expect(files.filter((r) => r.startsWith('views/'))).toEqual([
      'views/copilot/.github/skills/wicked-garden-beta/SKILL.md',
      'views/copilot/.github/skills/wicked-garden-gamma/SKILL.md',
    ]);
    expect(manifest.views).toEqual({ copilot: { dir: 'views/copilot', skills: ['wicked-garden-beta', 'wicked-garden-gamma'] } });
    expect(readFileSync(viewPath(snap.path, 'wicked-garden-gamma', 'SKILL.md'), 'utf8')).toBe(readFileSync(join(snap.path, 'skills', 'gamma', 'SKILL.md'), 'utf8'));
    expect(snap.contentHash).toBe(hashFileSet(walkFiles(snap.path).filter((f) => f.rel !== 'snapshot.json')));
    // Immutable by mode bits too: the generation, its dirs and its files carry no write bit.
    expect(lstatSync(snap.path).mode & 0o222).toBe(0);
    expect(lstatSync(join(snap.path, 'skills', 'gamma')).mode & 0o222).toBe(0);
    expect(lstatSync(join(snap.path, 'skills', 'gamma', 'SKILL.md')).mode & 0o222).toBe(0);
    expect(lstatSync(join(snap.path, 'snapshot.json')).mode & 0o222).toBe(0);
    if (!isRoot) expect(() => writeFileSync(join(snap.path, 'skills', 'gamma', 'SKILL.md'), 'x')).toThrow(/EACCES|EPERM/);
    // `current` resolves (verified) to the generation as an absolute REAL path (v3.1 §2 — the engine's
    // one input); the manifest records the publish and lastPublishedHash.
    expect(snap.path).toBe(realpathSync(join(s.root, 'snapshots', '000001')));
    expect(s.store.currentSnapshot()).toEqual({ gen: 1, path: snap.path });
    expect(storeOver(s).currentSnapshot()).toEqual({ gen: 1, path: snap.path });
    const m = s.store.manifest();
    expect(m.published).toMatchObject({ gen: 1, contentHash: snap.contentHash });
    expect(m.files['skills/beta/SKILL.md']?.lastPublishedHash).toBe(m.files['skills/beta/SKILL.md']?.effectiveHash);
    expect(m.files['skills/delta/SKILL.md']?.lastPublishedHash).toBeNull();
    expect(Object.hasOwn(m, 'mirror')).toBe(false); // no mirror ledger — nothing under a home dir is ever recorded
  });

  it("the copilot view carries a portable skill's WHOLE own tree and follows enablement / portability across publishes", async () => {
    s.store.seed();
    const extra = s.store.writeFile('wicked-garden-gamma', 'refs/extra.md', 'portable extra notes\n', 1);
    expect(extra.verdict).toBe('clear');
    const r1 = await s.store.publish(extra.revision);
    const p1 = (r1.snapshot as NonNullable<typeof r1.snapshot>).path;
    expect(rels(viewPath(p1, 'wicked-garden-gamma'))).toEqual(['SKILL.md', 'refs/extra.md']);
    // beta goes non-portable (a plugin-root ref) → it leaves the view; gamma stays.
    const edit = s.store.writeFile('wicked-garden-beta', 'SKILL.md', '---\nname: wicked-garden-beta\n---\n\n`${CLAUDE_PLUGIN_ROOT}/scripts/_python.sh` wicked-garden-gamma\n', r1.revision);
    expect(edit.skill?.portable).toBe(false);
    const r2 = await s.store.publish(edit.revision);
    expect(r2.verdict).toBe('clear');
    const p2 = (r2.snapshot as NonNullable<typeof r2.snapshot>).path;
    expect(existsSync(viewPath(p2, 'wicked-garden-beta'))).toBe(false);
    expect(existsSync(viewPath(p2, 'wicked-garden-gamma', 'SKILL.md'))).toBe(true);
    expect(snapshotManifest(p2).views.copilot.skills).toEqual(['wicked-garden-gamma']);
  });

  it('is BLOCKED — nothing written, revision untouched — when an enabled skill references a file the snapshot omits, naming file:line', async () => {
    s.store.seed();
    // Disabling alpha is legal (not core)… but alpha/nested links `../SKILL.md`, alpha's own file.
    const r1 = s.store.disable('wicked-garden-alpha', 1);
    expect(r1.verdict).toBe('clear');
    const blocked = await s.store.publish(r1.revision);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.snapshot).toBeNull();
    expect(s.store.currentSnapshot()).toBeNull();
    expect(existsSync(join(s.root, 'snapshots'))).toBe(false);
    const ref = blocked.findings.find((f) => f.kind === 'unresolved-ref');
    expect(ref).toMatchObject({ severity: 'blocking', skill: 'wicked-garden-alpha-nested', file: 'skills/alpha/nested/SKILL.md', line: 10 });
    expect(ref?.evidence).toContain('DISABLED skill wicked-garden-alpha');
    // A blocked publish does not stale the caller's revision — and persists nothing.
    expect(blocked.revision).toBe(r1.revision);
    expect(s.store.revision()).toBe(r1.revision);

    // A `${CLAUDE_PLUGIN_ROOT}` reference to a file the bundle never carried blocks the same way.
    // The write itself is admitted with a WARNING (beta was portable; a plugin-root ref makes it
    // Claude-only) — resolvability is publish's question, not the file manager's.
    const r2 = s.store.enable('wicked-garden-alpha', blocked.revision);
    const r3 = s.store.writeFile('wicked-garden-beta', 'refs/extra.md', 'see `${CLAUDE_PLUGIN_ROOT}/scripts/missing.py`\n', r2.revision);
    expect(r3.verdict).toBe('warnings');
    expect(r3.findings.map((f) => f.kind)).toEqual(['non-portable']);
    expect(r3.skill?.portable).toBe(false);
    const again = await s.store.publish(r3.revision);
    expect(again.verdict).toBe('blocked');
    expect(again.findings.find((f) => f.kind === 'unresolved-ref')).toMatchObject({
      skill: 'wicked-garden-beta',
      file: 'skills/beta/refs/extra.md',
      line: 1,
    });
    expect(again.findings.find((f) => f.kind === 'unresolved-ref')?.evidence).toContain('scripts/missing.py');
  });

  it('a `${CLAUDE_PLUGIN_ROOT}/..` reference is an ESCAPE (never the root); a `dir/` reference resolves', async () => {
    s.store.seed();
    const w = s.store.writeFile(
      'wicked-garden-beta',
      'refs/links.md',
      'Read `${CLAUDE_PLUGIN_ROOT}/..` and `${CLAUDE_PLUGIN_ROOT}/scripts/../../outside.md` first.\n',
      1,
    );
    expect(w.verdict).toBe('warnings'); // non-portable, admitted
    const blocked = await s.store.publish(w.revision);
    expect(blocked.verdict).toBe('blocked');
    const refs = blocked.findings.filter((f) => f.kind === 'unresolved-ref');
    expect(refs).toHaveLength(2);
    for (const f of refs) {
      expect(f.evidence).toContain('escapes the plugin root');
      expect(f).toMatchObject({ skill: 'wicked-garden-beta', file: 'skills/beta/refs/links.md', line: 1 });
    }
    // Directory references — trailing slash, trailing `/.` — resolve against the snapshot's contents.
    const w2 = s.store.writeFile(
      'wicked-garden-beta',
      'refs/links.md',
      'See `${CLAUDE_PLUGIN_ROOT}/docs/examples/`, `${CLAUDE_PLUGIN_ROOT}/schemas/.` and `${CLAUDE_PLUGIN_ROOT}/scripts/alpha/`.\n',
      blocked.revision,
    );
    const ok = await s.store.publish(w2.revision);
    expect(ok.findings.filter((f) => f.kind === 'unresolved-ref')).toEqual([]);
    expect(ok.verdict).toBe('clear');
  });

  it('keeps the newest three generations and never the one just published; no staging dirs linger', async () => {
    s.store.seed();
    let rev = s.store.revision();
    for (let i = 0; i < 5; i += 1) {
      const r = await s.store.publish(rev);
      expect(r.verdict).toBe('clear');
      rev = r.revision;
    }
    expect(s.store.generationsOnDisk()).toEqual([3, 4, 5]);
    expect(readlinkSync(join(s.root, 'current'))).toBe(join('snapshots', '000005'));
    expect(s.store.currentSnapshot()?.gen).toBe(5);
    expect(readdirSync(join(s.root, 'snapshots')).filter((e) => e.startsWith('.'))).toEqual([]);
  });

  it('allocates the generation from the FILESYSTEM (max existing + 1), sweeps torn staging, never overwrites an existing generation', async () => {
    s.store.seed();
    mkdirSync(join(s.root, 'snapshots', '000007'), { recursive: true });
    mkdirSync(join(s.root, 'snapshots', '.staging-torn'), { recursive: true });
    writeFileSync(join(s.root, 'snapshots', '.staging-torn', 'half.md'), 'torn');
    const r = await s.store.publish(1);
    expect(r.verdict).toBe('clear');
    expect(r.snapshot?.gen).toBe(8);
    expect(existsSync(join(s.root, 'snapshots', '.staging-torn'))).toBe(false);
    expect(existsSync(join(s.root, 'snapshots', '000007'))).toBe(true); // an existing destination is never removed
    expect(s.store.currentSnapshot()?.gen).toBe(8);
    expect(s.store.manifest().published?.gen).toBe(8);
  });

  it('commits the manifest BEFORE flipping current; ensureReady finishes a flip a crash interrupted', async () => {
    s.store.seed();
    const r1 = await s.store.publish(1);
    const r2 = await s.store.publish(r1.revision);
    expect(r2.snapshot?.gen).toBe(2);
    // The crash window: the manifest names gen 2, `current` still points at gen 1.
    rmSync(join(s.root, 'current'));
    symlinkSync(join('snapshots', '000001'), join(s.root, 'current'));
    const fresh = storeOver(s);
    expect(fresh.currentSnapshot()?.gen).toBe(1);
    const ready = await fresh.ensureReady();
    expect(ready).toEqual({ seeded: false, published: null }); // finished, not re-published
    expect(fresh.currentSnapshot()?.gen).toBe(2);
    expect(fresh.generationsOnDisk()).toEqual([1, 2]);
  });

  it('analyze is a PURE dry run: drift is reported, nothing persisted, the revision stays — the publish that ships it records it', async () => {
    s.store.seed();
    editedOnDisk(s, 'gamma', 'edited on disk');
    const analyzed = s.store.analyze();
    expect(analyzed.findings.find((f) => f.kind === 'fs-drift')?.evidence).toContain('skills/gamma/SKILL.md');
    expect(analyzed.revision).toBe(1);
    expect(s.store.revision()).toBe(1);
    expect(s.store.manifest().skills['wicked-garden-gamma']?.provenance).toBe('shipped');
    const published = await s.store.publish(1);
    expect(published.verdict).toBe('warnings');
    expect(published.findings.find((f) => f.kind === 'fs-drift')).toBeDefined();
    expect(published.revision).toBe(2);
    expect(s.store.manifest().skills['wicked-garden-gamma']?.provenance).toBe('override');
  });

  it('a BLOCKED publish persists nothing — not the drift it observed, not the provisioning state', async () => {
    s.store.seed();
    const off = s.store.disable('wicked-garden-alpha', 1); // alpha/nested's `../SKILL.md` now escapes the snapshot
    editedOnDisk(s, 'gamma', 'edited on disk');
    const before = JSON.stringify(s.store.manifest());
    const blocked = await s.store.publish(off.revision);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.findings.find((f) => f.kind === 'fs-drift')).toBeDefined();
    expect(s.store.revision()).toBe(off.revision);
    const m = s.store.manifest();
    expect(m.skills['wicked-garden-gamma']?.provenance).toBe('shipped');
    expect(m.files['skills/gamma/SKILL.md']?.effectiveHash).toBe(m.files['skills/gamma/SKILL.md']?.baselineHash);
    // The provisioner ran (noVenv → skipped) but the baseline record still says `pending`: the
    // manifest is byte-identical to what it was before the blocked publish (codex round 2).
    expect(m.baselines[m.baseline]?.venv).toBe('pending');
    expect(JSON.stringify(m)).toBe(before);
    expect(existsSync(join(s.root, 'snapshots'))).toBe(false);
  });

  it('an unregistered SKILL.md placed on disk blocks (nested ownership, v3 §6)', async () => {
    s.store.seed();
    mkdirSync(join(s.root, 'effective', 'skills', 'beta', 'rogue'), { recursive: true });
    writeFileSync(join(s.root, 'effective', 'skills', 'beta', 'rogue', 'SKILL.md'), '---\nname: wicked-garden-beta-rogue\n---\n');
    const r = await s.store.publish(1);
    expect(r.verdict).toBe('blocked');
    expect(r.findings.find((f) => f.kind === 'unregistered-skill')?.evidence).toContain('skills/beta/rogue/SKILL.md');
  });

  it('a registered skill_ref that names no catalog skill is BLOCKING', async () => {
    const ghost = scaffold({ registeredSkillRefs: () => new Set(['wicked-garden-beta', 'wicked-garden-ghost']) });
    try {
      ghost.store.seed();
      const r = await ghost.store.publish(1);
      expect(r.verdict).toBe('blocked');
      expect(r.findings.find((f) => f.kind === 'core-missing')).toMatchObject({ severity: 'blocking', skill: 'wicked-garden-ghost' });
      expect(ghost.store.currentSnapshot()).toBeNull();
    } finally {
      removeScratch(ghost.base);
    }
  });

  it('an absent TRANSITIVE mandate (a core skill names a skill the catalog lacks) is BLOCKING, with file:line', async () => {
    s.store.seed();
    const w = s.store.writeFile(
      'wicked-garden-beta',
      'SKILL.md',
      '---\nname: wicked-garden-beta\n---\n\nUse the **wicked-garden-gamma** skill.\nThen hand off to wicked-garden-phantom for the rest.\n',
      1,
    );
    expect(w.verdict).toBe('clear');
    const r = await s.store.publish(w.revision);
    expect(r.verdict).toBe('blocked');
    expect(r.findings.find((f) => f.kind === 'core-missing')).toMatchObject({
      severity: 'blocking',
      skill: 'wicked-garden-beta',
      file: 'skills/beta/SKILL.md',
      line: 6,
      againstSkill: 'wicked-garden-phantom',
    });
  });

  it('the plugin manifest and the runtime catalogs are REQUIRED — absent ⇒ missing-plugin-manifest, blocking', async () => {
    s.store.seed();
    rmSync(join(s.root, 'effective', '.claude-plugin', 'archetypes.json'));
    const r = await s.store.publish(1);
    expect(r.verdict).toBe('blocked');
    expect(r.findings.find((f) => f.kind === 'missing-plugin-manifest')).toMatchObject({ severity: 'blocking', file: '.claude-plugin/archetypes.json' });
    rmSync(join(s.root, 'effective', '.claude-plugin', 'plugin.json'));
    const r2 = await s.store.publish(1);
    expect(r2.findings.filter((f) => f.kind === 'missing-plugin-manifest').map((f) => f.file).sort()).toEqual([
      '.claude-plugin/archetypes.json',
      '.claude-plugin/plugin.json',
    ]);
    expect(r2.findings.some((f) => f.kind === 'missing-skill-md')).toBe(false);
  });

  it('the plugin manifest must declare its name; the catalogs must have the SHAPE their readers expect — not merely exist (codex round 2)', async () => {
    s.store.seed();
    const plugin = join(s.root, 'effective', '.claude-plugin');
    writeFileSync(join(plugin, 'plugin.json'), '{"version": "1.0.0"}');
    const noName = await s.store.publish(1);
    expect(noName.verdict).toBe('blocked');
    expect(noName.findings.find((f) => f.kind === 'name-mismatch' && f.file === '.claude-plugin/plugin.json')?.evidence).toContain('declares no "name"');
    writeFileSync(join(plugin, 'plugin.json'), '[]');
    expect((await s.store.publish(1)).findings.find((f) => f.file === '.claude-plugin/plugin.json')?.kind).toBe('catalog-invalid');
    writeFileSync(join(plugin, 'plugin.json'), '{"name": "wicked-garden", "version": "1.0.0"}');
    writeFileSync(join(plugin, 'archetypes.json'), '[]');
    const arrayCatalog = await s.store.publish(1);
    expect(arrayCatalog.findings.find((f) => f.file === '.claude-plugin/archetypes.json')).toMatchObject({ kind: 'catalog-invalid', severity: 'blocking' });
    writeFileSync(join(plugin, 'archetypes.json'), '{"version": 11}');
    expect((await s.store.publish(1)).findings.find((f) => f.file === '.claude-plugin/archetypes.json')?.evidence).toContain('no `archetypes` collection');
    writeFileSync(join(plugin, 'archetypes.json'), 'not json');
    expect((await s.store.publish(1)).findings.find((f) => f.file === '.claude-plugin/archetypes.json')?.kind).toBe('catalog-invalid');
    writeFileSync(join(plugin, 'archetypes.json'), '{"archetypes": {"build": {}}}'); // the live plugin's shape (an object) is accepted too
    writeFileSync(join(plugin, 'components.json'), '"a string"');
    expect((await s.store.publish(1)).findings.find((f) => f.file === '.claude-plugin/components.json')?.kind).toBe('catalog-invalid');
    writeFileSync(join(plugin, 'components.json'), '{"skills": []}');
    const ok = await s.store.publish(1);
    expect(ok.findings.filter((f) => f.kind === 'catalog-invalid' || f.kind === 'missing-plugin-manifest')).toEqual([]);
    expect(ok.verdict).toBe('warnings'); // the fs-drift of the catalog edits above
  });

  it('a skill — DISABLED included — whose frontmatter declares another catalog skill\'s name is a blocking name-collision, core-annotated (codex round 2)', async () => {
    s.store.seed();
    const off = s.store.disable('wicked-garden-delta', 1);
    expect(off.verdict).toBe('clear');
    editedOnDisk(s, 'delta', 'I am beta now'); // then rename it on disk to core beta's name
    writeFileSync(join(s.root, 'effective', 'skills', 'delta', 'SKILL.md'), '---\nname: wicked-garden-beta\n---\n\nshadow\n');
    const r = await s.store.publish(off.revision);
    expect(r.verdict).toBe('blocked');
    const collision = r.findings.find((f) => f.kind === 'name-collision');
    expect(collision).toMatchObject({ severity: 'blocking', skill: 'wicked-garden-delta', file: 'skills/delta/SKILL.md', againstSkill: 'wicked-garden-beta', againstIsCore: true });
    expect(collision?.evidence).toContain('skills/beta');
    // The disabled skill's own mismatch is still only a warning — the collision is what blocks.
    expect(r.findings.find((f) => f.kind === 'name-mismatch' && f.skill === 'wicked-garden-delta')?.severity).toBe('warning');
    expect(s.store.currentSnapshot()).toBeNull();
    expect(s.store.revision()).toBe(off.revision);
  });

  it('malformed frontmatter YAML (an unterminated flow sequence / quoted scalar) is BLOCKING', async () => {
    s.store.seed();
    const bad = s.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\ntags: [ranking, prose\n---\n\nx\n', 1);
    expect(bad.verdict).toBe('blocked');
    expect(bad.findings[0]?.kind).toBe('frontmatter-invalid');
    expect(bad.findings[0]?.evidence).toContain('unterminated flow sequence');
    writeFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), '---\nname: wicked-garden-gamma\ndescription: "open\n---\n\nx\n');
    const r = await s.store.publish(1);
    expect(r.verdict).toBe('blocked');
    expect(r.findings.find((f) => f.kind === 'frontmatter-invalid')?.evidence).toContain('unterminated quoted scalar');
  });
});

describe('`current` is verified, never trusted', () => {
  it('a link whose target lies outside snapshots/ is a named error, not a silent accept', async () => {
    s.store.seed();
    await s.store.publish(1);
    rmSync(join(s.root, 'current'));
    symlinkSync('effective', join(s.root, 'current'));
    expect(() => storeOver(s).currentSnapshot()).toThrow(SkillsCurrentInvalidError);
    expect(() => storeOver(s).currentSnapshot()).toThrow(/outside/);
    await expect(storeOver(s).ensureReady()).rejects.toBeInstanceOf(SkillsCurrentInvalidError);
  });

  it('a tampered snapshot (content hash mismatch) and a malformed snapshot.json are named errors', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const gen = (r.snapshot as NonNullable<typeof r.snapshot>).path;
    const pristine = JSON.parse(readFileSync(join(gen, 'snapshot.json'), 'utf8')) as { skills: Array<Record<string, unknown>> };
    const gamma = join(gen, 'skills', 'gamma', 'SKILL.md');
    const before = readFileSync(gamma, 'utf8');
    unlock(gamma); // the generation is read-only: tampering means defeating the lock first
    writeFileSync(gamma, `${before}tampered\n`);
    expect(() => storeOver(s).currentSnapshot()).toThrow(/content hash mismatch/);
    writeFileSync(gamma, before);
    expect(storeOver(s).currentSnapshot()?.gen).toBe(1);
    unlock(join(gen, 'snapshot.json'));
    writeFileSync(join(gen, 'snapshot.json'), '{"gen": "one"}');
    expect(() => storeOver(s).currentSnapshot()).toThrow(/no integer gen/);
    writeFileSync(join(gen, 'snapshot.json'), 'not json');
    expect(() => storeOver(s).currentSnapshot()).toThrow(/does not parse/);
    // A skill row without a boolean `portable` is not a snapshot core can judge a seat against (v3.1 §5).
    const broken = { ...pristine, skills: pristine.skills.map((row, i) => (i === 0 ? { ...row, portable: 'yes' } : row)) };
    writeFileSync(join(gen, 'snapshot.json'), JSON.stringify(broken));
    expect(() => storeOver(s).currentSnapshot()).toThrow(/portable: boolean/);
  });

  it('verification holds for the daemon\'s lifetime: a snapshot tampered AFTER a successful read is refused by the SAME store instance (codex round 2)', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const gen = (r.snapshot as NonNullable<typeof r.snapshot>).path;
    expect(s.store.currentSnapshot()?.gen).toBe(1);
    expect(s.store.currentSnapshot()?.gen).toBe(1); // a second read of the same link
    // Tamper a skill file — refused on the very next read, no restart, no re-link.
    const gamma = join(gen, 'skills', 'gamma', 'SKILL.md');
    unlock(gamma);
    const before = readFileSync(gamma, 'utf8');
    writeFileSync(gamma, `${before}tampered\n`);
    expect(() => s.store.currentSnapshot()).toThrow(SkillsCurrentInvalidError);
    expect(() => s.store.currentSnapshot()).toThrow(/content hash mismatch/);
    writeFileSync(gamma, before);
    expect(s.store.currentSnapshot()?.gen).toBe(1);
    // Tamper a VIEW file — the view is part of the content hash, so the same refusal.
    const view = viewPath(gen, 'wicked-garden-gamma', 'SKILL.md');
    unlock(view);
    writeFileSync(view, 'poisoned copilot view\n');
    expect(() => s.store.currentSnapshot()).toThrow(/content hash mismatch/);
    // An added file is a tamper too (the hash covers the file SET, not only known files).
    writeFileSync(view, before);
    expect(s.store.currentSnapshot()?.gen).toBe(1);
    writeFileSync(join(gen, 'skills', 'gamma', 'extra.md'), 'planted\n');
    expect(() => s.store.currentSnapshot()).toThrow(/content hash mismatch/);
  });

  it('snapshot.json metadata never names a path outside the snapshot: traversal / absolute / mismatched rows and a missing views block are refused even though the hash still verifies (codex round 2)', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const gen = (r.snapshot as NonNullable<typeof r.snapshot>).path;
    const metadata = join(gen, 'snapshot.json');
    const pristine = snapshotManifest(gen);
    unlock(metadata);
    const withRow = (patch: Record<string, unknown>): void => {
      writeFileSync(metadata, JSON.stringify({ ...pristine, skills: pristine.skills.map((row, i) => (i === 0 ? { ...row, ...patch } : row)) }));
    };
    withRow({ dir: '../../outside' });
    expect(() => s.store.currentSnapshot()).toThrow(/safe relative skills/);
    withRow({ dir: '/etc' });
    expect(() => s.store.currentSnapshot()).toThrow(SkillsCurrentInvalidError);
    withRow({ dir: 'scripts/alpha' }); // not under skills/
    expect(() => s.store.currentSnapshot()).toThrow(SkillsCurrentInvalidError);
    withRow({ name: '../x' });
    expect(() => s.store.currentSnapshot()).toThrow(SkillsCurrentInvalidError);
    withRow({ name: 'wicked-garden-alpha', dir: 'skills/zeta' }); // a dir that does not derive the name
    expect(() => s.store.currentSnapshot()).toThrow(SkillsCurrentInvalidError);
    writeFileSync(metadata, JSON.stringify({ ...pristine, views: undefined }));
    expect(() => s.store.currentSnapshot()).toThrow(/views block/);
    writeFileSync(metadata, JSON.stringify({ ...pristine, views: { copilot: { dir: '../../outside', skills: [] } } }));
    expect(() => s.store.currentSnapshot()).toThrow(/views block/);
    writeFileSync(metadata, JSON.stringify({ ...pristine, views: { copilot: { dir: 'views/copilot', skills: ['wicked-garden-alpha'] } } })); // alpha is NOT portable
    expect(() => s.store.currentSnapshot()).toThrow(/views block/);
    writeFileSync(metadata, `${JSON.stringify(pristine, null, 2)}\n`);
    expect(s.store.currentSnapshot()?.gen).toBe(1);
  });
});

describe('venv provisioning (design v3 §4)', () => {
  it('publish AWAITS the provisioner, links .venv only once synced, marks + locks it read-only, records the state with the publish, never re-runs a synced baseline', async () => {
    const calls: Array<{ baselineDir: string; cacheDir: string }> = [];
    const provisioner: VenvProvisioner = async (baselineDir, opts) => {
      calls.push({ baselineDir, cacheDir: opts.cacheDir });
      mkdirSync(join(baselineDir, '.venv', 'bin'), { recursive: true });
      writeFileSync(join(baselineDir, '.venv', 'bin', 'python'), '#!/bin/sh\n');
      return 'synced';
    };
    const v = scaffold({ provisionVenv: provisioner });
    try {
      v.store.seed();
      const hash = v.store.manifest().baseline;
      expect(v.store.manifest().baselines[hash]?.venv).toBe('pending');
      expect(calls).toEqual([]);
      const r = await v.store.publish(1);
      expect(r.verdict).toBe('clear');
      expect(calls).toEqual([{ baselineDir: join(v.root, 'baseline', hash), cacheDir: join(v.root, '.uv-cache') }]);
      const snap = r.snapshot as NonNullable<typeof r.snapshot>;
      expect(lstatSync(join(snap.path, '.venv')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(snap.path, '.venv'))).toBe(join('..', '..', 'baseline', hash, '.venv'));
      expect(snapshotManifest(snap.path).venv).toBe('synced');
      expect(v.store.manifest().baselines[hash]?.venv).toBe('synced');
      // The shared env is read-only and carries its on-disk ready marker: no dir or file under it has a write bit.
      const venvDir = join(v.root, 'baseline', hash, '.venv');
      expect(existsSync(join(venvDir, VENV_READY_MARKER))).toBe(true);
      expect(lstatSync(venvDir).mode & 0o222).toBe(0);
      expect(lstatSync(join(venvDir, 'bin')).mode & 0o222).toBe(0);
      expect(lstatSync(join(venvDir, 'bin', 'python')).mode & 0o222).toBe(0);
      // The snapshot's content hash excludes the env (never walked), so `current` still verifies.
      expect(storeOver(v).currentSnapshot()?.gen).toBe(1);
      // A second publish of the same baseline does not provision again (the marker is the authority).
      const r2 = await v.store.publish(r.revision);
      expect(r2.verdict).toBe('clear');
      expect(calls).toHaveLength(1);
      // A `.venv` WITHOUT the marker is a torn sync: removed and re-provisioned, never trusted.
      removeTreeForce(venvDir);
      mkdirSync(join(venvDir, 'bin'), { recursive: true });
      writeFileSync(join(venvDir, 'bin', 'half'), 'torn\n');
      const r3 = await v.store.publish(r2.revision);
      expect(r3.verdict).toBe('clear');
      expect(calls).toHaveLength(2);
      expect(existsSync(join(venvDir, 'bin', 'half'))).toBe(false);
      expect(existsSync(join(venvDir, VENV_READY_MARKER))).toBe(true);
    } finally {
      removeTreeForce(v.base);
    }
  });

  it('a SKIPPED provisioner (nothing to provision) yields no link, a `venv: skipped` note, and a clear publish', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    expect(r.verdict).toBe('clear');
    const snap = r.snapshot as NonNullable<typeof r.snapshot>;
    expect(existsSync(join(snap.path, '.venv'))).toBe(false);
    expect(snapshotManifest(snap.path).venv).toBe('skipped');
    expect(s.store.manifest().baselines[s.store.manifest().baseline]?.venv).toBe('skipped');
  });

  it('a FAILED provisioner is BLOCKING (venv-failed): no snapshot, no link, nothing persisted — the env is required, not optional (codex round 2)', async () => {
    const v = scaffold({ provisionVenv: async () => 'failed' });
    try {
      v.store.seed();
      const before = JSON.stringify(v.store.manifest());
      const r = await v.store.publish(1);
      expect(r.verdict).toBe('blocked');
      expect(r.snapshot).toBeNull();
      expect(r.findings.find((f) => f.kind === 'venv-failed')).toMatchObject({ severity: 'blocking' });
      expect(r.findings.find((f) => f.kind === 'venv-failed')?.explanation).toContain('Install uv');
      expect(v.store.currentSnapshot()).toBeNull();
      expect(existsSync(join(v.root, 'snapshots'))).toBe(false);
      expect(v.store.revision()).toBe(1);
      expect(v.store.manifest().baselines[v.store.manifest().baseline]?.venv).toBe('pending');
      expect(JSON.stringify(v.store.manifest())).toBe(before);
    } finally {
      removeScratch(v.base);
    }
  });

  it('a synced env the daemon cannot LOCK is a failed provisioning (the lock failure is surfaced, not swallowed)', async () => {
    if (isRoot) return; // root ignores permission bits
    const provisioner: VenvProvisioner = async (baselineDir) => {
      const sealed = join(baselineDir, '.venv', 'lib', 'sealed');
      mkdirSync(sealed, { recursive: true });
      writeFileSync(join(sealed, 'x.py'), 'x');
      chmodSync(sealed, 0o000); // unlistable → makeTreeReadOnly cannot reach its files
      return 'synced';
    };
    const v = scaffold({ provisionVenv: provisioner });
    try {
      v.store.seed();
      const r = await v.store.publish(1);
      expect(r.verdict).toBe('blocked');
      expect(r.findings.map((f) => f.kind)).toContain('venv-failed');
      expect(v.warnings.some((w) => w.includes('could not lock'))).toBe(true);
    } finally {
      chmodSync(join(v.root, 'baseline', v.store.manifest().baseline, '.venv', 'lib', 'sealed'), 0o700);
      removeTreeForce(v.base);
    }
  });
});

describe('publish is serialized and bound to its root (codex round 2)', () => {
  it('a second publish while one is in flight is refused (SkillsPublishInFlightError, one provisioning), and ensureReady waits instead of starting another', async () => {
    const gate = gatedProvisioner('synced');
    const v = scaffold({ provisionVenv: gate.provisioner });
    try {
      v.store.seed();
      const first = v.store.publish(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(v.store.isPublishing()).toBe(true);
      await expect(v.store.publish(1)).rejects.toBeInstanceOf(SkillsPublishInFlightError);
      await expect(v.store.publish(1)).rejects.toMatchObject({ revision: 1 });
      const ready = v.store.ensureReady(); // the boot / settings entry point: waits, never a second publish
      await new Promise((resolve) => setImmediate(resolve));
      expect(gate.calls).toHaveLength(1);
      gate.release();
      const r = await first;
      expect(r.verdict).toBe('clear');
      expect(r.snapshot?.gen).toBe(1);
      expect(await ready).toEqual({ seeded: false, published: null });
      expect(v.store.isPublishing()).toBe(false);
      expect(gate.calls).toHaveLength(1);
      expect(v.store.generationsOnDisk()).toEqual([1]);
      // The lock is released: the next publish runs.
      expect((await v.store.publish(r.revision)).snapshot?.gen).toBe(2);
    } finally {
      removeTreeForce(v.base);
    }
  });

  it('a publish that started on root A and finds the store re-rooted to B after its await ABORTS — nothing is written to either root (the codex root-switch probe)', async () => {
    const gate = gatedProvisioner();
    const a = scaffold({ provisionVenv: gate.provisioner });
    const b = scaffold({ provisionVenv: gate.provisioner });
    try {
      a.store.seed();
      b.store.seed(); // root B: also revision 1 — a numeric CAS alone would accept it
      const inFlight = a.store.publish(1);
      await new Promise((resolve) => setImmediate(resolve));
      a.store.reroot(b.root); // the settings changed under the running publish
      gate.release();
      await expect(inFlight).rejects.toBeInstanceOf(SkillsRootChangedError);
      await expect(inFlight).rejects.toMatchObject({ from: a.root, to: b.root });
      expect(existsSync(join(a.root, 'snapshots'))).toBe(false);
      expect(existsSync(join(b.root, 'snapshots'))).toBe(false);
      expect(b.store.currentSnapshot()).toBeNull();
      expect(b.store.revision()).toBe(1);
      expect(a.store.isPublishing()).toBe(false);
      // Aimed at B now, a fresh publish lands in B only.
      const r = await a.store.publish(1);
      expect(r.snapshot?.path).toBe(realpathSync(join(b.root, 'snapshots', '000001')));
      expect(existsSync(join(a.root, 'snapshots'))).toBe(false);
    } finally {
      removeScratch(a.base);
      removeScratch(b.base);
    }
  });
});

describe('baseline retention (a baseline lives while any snapshot references it)', () => {
  it('survives a refresh while a retained generation links it, and is reaped once that generation is', async () => {
    s.store.seed();
    const a = s.store.manifest().baseline;
    const r1 = await s.store.publish(1); // gen 1 references baseline A
    writeFileSync(join(s.upstream, 'skills', 'gamma', 'SKILL.md'), '---\nname: wicked-garden-gamma\n---\n\ngamma v2\n');
    const ref = s.store.refreshBaseline(r1.revision);
    const b = ref.baseline;
    expect(b).not.toBe(a);
    expect(s.store.baselinesOnDisk()).toEqual([a, b].sort());
    expect(Object.keys(s.store.manifest().baselines).sort()).toEqual([a, b].sort());
    let rev = ref.revision;
    for (let i = 0; i < 3; i += 1) {
      const r = await s.store.publish(rev); // gens 2, 3, 4 — gen 1 is reaped by the third
      expect(r.verdict).toBe('clear');
      rev = r.revision;
    }
    expect(s.store.generationsOnDisk()).toEqual([2, 3, 4]);
    expect(s.store.baselinesOnDisk()).toEqual([b]);
    expect(Object.keys(s.store.manifest().baselines)).toEqual([b]);
  });
});

describe('enablement, reset, CAS (design v3 §7)', () => {
  it('reset restores content from the baseline and never flips enabled', () => {
    s.store.seed();
    const off = s.store.disable('wicked-garden-delta', 1);
    const edited = s.store.writeFile('wicked-garden-delta', 'SKILL.md', '---\nname: wicked-garden-delta\n---\n\nmine\n', off.revision);
    expect(edited.skill?.provenance).toBe('override');
    expect(edited.skill?.editedAt).toBe('2026-09-08T12:00:00.000Z');
    const reset = s.store.reset('wicked-garden-delta', edited.revision);
    expect(reset.verdict).toBe('clear');
    expect(reset.skill).toMatchObject({ enabled: false, provenance: 'shipped', editedAt: null });
    expect(readFileSync(join(s.root, 'effective', 'skills', 'delta', 'SKILL.md'), 'utf8')).toBe(
      readFileSync(join(FIXTURE_PLUGIN, 'skills', 'delta', 'SKILL.md'), 'utf8'),
    );
  });

  it('reset of a parent leaves a nested child\'s override in place (deepest SKILL.md owns the file)', () => {
    s.store.seed();
    const child = s.store.writeFile('wicked-garden-alpha-nested', 'SKILL.md', '---\nname: wicked-garden-alpha-nested\ncontext: fork\n---\n\nchild edit\n', 1);
    const parent = s.store.writeFile('wicked-garden-alpha', 'refs/notes.md', 'parent edit\n', child.revision);
    const reset = s.store.reset('wicked-garden-alpha', parent.revision);
    expect(reset.skill?.provenance).toBe('shipped');
    expect(readFileSync(join(s.root, 'effective', 'skills', 'alpha', 'nested', 'SKILL.md'), 'utf8')).toContain('child edit');
    expect(s.store.manifest().skills['wicked-garden-alpha-nested']?.provenance).toBe('override');
  });

  it('ownership follows the FILESYSTEM: a nested SKILL.md added directly on disk is nobody else\'s — the parent endpoint refuses its paths, parent reset/replace leave it intact (codex round 2)', () => {
    s.store.seed();
    const child = join(s.root, 'effective', 'skills', 'gamma', 'child');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, 'SKILL.md'), '---\nname: wicked-garden-gamma-child\n---\n\nadded on disk\n');
    writeFileSync(join(child, 'notes.md'), 'child notes\n');
    // Not the parent's files: not listed, not addressable, not writable through gamma.
    expect(s.store.listFiles('wicked-garden-gamma').files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(() => s.store.resolveSkillFile('wicked-garden-gamma', 'child/notes.md')).toThrow(/belongs to the nested skill at skills\/gamma\/child/);
    const write = s.store.writeFile('wicked-garden-gamma', 'child/notes.md', 'hijacked\n', 1);
    expect(write).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(write.findings[0]?.kind).toBe('path-invalid');
    expect(readFileSync(join(child, 'notes.md'), 'utf8')).toBe('child notes\n');
    // Parent reset restores gamma's own file and leaves the child exactly as it was.
    const edit = s.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\n---\n\nmine\n', 1);
    const reset = s.store.reset('wicked-garden-gamma', edit.revision);
    expect(reset.verdict).toBe('clear');
    expect(readFileSync(join(child, 'SKILL.md'), 'utf8')).toContain('added on disk');
    expect(readFileSync(join(child, 'notes.md'), 'utf8')).toBe('child notes\n');
    // Parent replace: a file under the child is refused; a legal replace leaves the child alone.
    const bad = s.store.replace('wicked-garden-gamma', { 'SKILL.md': '---\nname: wicked-garden-gamma\n---\n', 'child/x.md': 'x' }, reset.revision);
    expect(bad.verdict).toBe('blocked');
    expect(bad.findings.some((f) => f.kind === 'path-invalid' && f.evidence.includes('skills/gamma/child'))).toBe(true);
    const ok = s.store.replace('wicked-garden-gamma', { 'SKILL.md': '---\nname: wicked-garden-gamma\n---\n\nreplaced\n' }, reset.revision);
    expect(ok.verdict).toBe('clear');
    expect(existsSync(join(child, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(child, 'notes.md'))).toBe(true);
    // And publish still names it: an unregistered skill blocks until it is registered or removed.
    expect(s.store.analyze().findings.find((f) => f.kind === 'unregistered-skill')?.evidence).toContain('skills/gamma/child/SKILL.md');
  });

  it('enable runs the content + containment guards: a missing, malformed, renamed or symlinked skill is not enabled (codex round 2)', () => {
    s.store.seed();
    const off = s.store.disable('wicked-garden-delta', 1);
    const deltaDir = join(s.root, 'effective', 'skills', 'delta');
    const skillMd = join(deltaDir, 'SKILL.md');
    const original = readFileSync(skillMd, 'utf8');
    rmSync(skillMd);
    const missing = s.store.enable('wicked-garden-delta', off.revision);
    expect(missing).toMatchObject({ verdict: 'blocked', revision: off.revision });
    expect(missing.findings[0]?.kind).toBe('missing-skill-md');
    writeFileSync(skillMd, '---\nname: wicked-garden-delta\ntags: [a, b\n---\n');
    expect(s.store.enable('wicked-garden-delta', off.revision).findings[0]?.kind).toBe('frontmatter-invalid');
    writeFileSync(skillMd, '---\nname: wicked-garden-renamed\n---\n');
    expect(s.store.enable('wicked-garden-delta', off.revision).findings[0]?.kind).toBe('name-mismatch');
    rmSync(deltaDir, { recursive: true });
    const outside = join(s.base, 'outside-delta');
    mkdirSync(outside);
    writeFileSync(join(outside, 'SKILL.md'), original);
    symlinkSync(outside, deltaDir);
    const linked = s.store.enable('wicked-garden-delta', off.revision);
    expect(linked.findings[0]?.kind).toBe('path-invalid');
    expect(linked.findings[0]?.evidence).toMatch(/crosses a symlink at delta/);
    rmSync(deltaDir);
    mkdirSync(deltaDir);
    writeFileSync(skillMd, original);
    expect(s.store.manifest().skills['wicked-garden-delta']?.enabled).toBe(false);
    const on = s.store.enable('wicked-garden-delta', off.revision);
    expect(on.verdict).toBe('clear');
    expect(on.skill?.enabled).toBe(true);
  });

  it('every mutation is CAS-guarded: a stale expectedRevision is refused and writes nothing', async () => {
    s.store.seed();
    const ok = s.store.disable('wicked-garden-delta', 1);
    expect(ok.revision).toBe(2);
    expect(() => s.store.enable('wicked-garden-delta', 1)).toThrow(RevisionMismatchError);
    expect(() => s.store.writeFile('wicked-garden-gamma', 'SKILL.md', 'x', 1)).toThrow(RevisionMismatchError);
    await expect(s.store.publish(1)).rejects.toBeInstanceOf(RevisionMismatchError);
    expect(s.store.manifest().skills['wicked-garden-delta']?.enabled).toBe(false);
    expect(s.store.revision()).toBe(2);
  });

  it('disabling a core-by-reference skill is blocked — directly referenced or reached through a mandate', () => {
    s.store.seed();
    const direct = s.store.disable('wicked-garden-beta', 1);
    expect(direct.verdict).toBe('blocked');
    expect(direct.findings[0]).toMatchObject({ kind: 'core-disable', againstSkill: 'wicked-garden-beta', againstIsCore: true });
    const viaMandate = s.store.disable('wicked-garden-gamma', 1);
    expect(viaMandate.verdict).toBe('blocked');
    expect(viaMandate.findings[0]?.kind).toBe('core-disable');
    // Nothing moved, revision untouched.
    expect(s.store.manifest().skills['wicked-garden-gamma']?.enabled).toBe(true);
    expect(s.store.revision()).toBe(1);
  });

  it('disable RECOMPUTES core membership from the live registered refs — a newly registered ref is never bypassed via the cached entry', () => {
    let refs: ReadonlySet<string> = new Set(['wicked-garden-beta']);
    const live = scaffold({ registeredSkillRefs: () => refs });
    try {
      live.store.seed();
      expect(live.store.manifest().skills['wicked-garden-delta']?.core).toBe(false);
      refs = new Set(['wicked-garden-beta', 'wicked-garden-delta']);
      const r = live.store.disable('wicked-garden-delta', 1);
      expect(r.verdict).toBe('blocked');
      expect(r.findings[0]?.kind).toBe('core-disable');
      expect(live.store.manifest().skills['wicked-garden-delta']?.enabled).toBe(true);
    } finally {
      removeScratch(live.base);
    }
  });

  it('a rename in place of a core skill is blocked; a SKILL.md placed inside a skill is blocked', () => {
    s.store.seed();
    const renamed = s.store.writeFile('wicked-garden-beta', 'SKILL.md', '---\nname: wicked-garden-omega\n---\n', 1);
    expect(renamed.verdict).toBe('blocked');
    expect(renamed.findings.map((f) => f.kind).sort()).toEqual(['core-rename', 'name-mismatch']);
    const nested = s.store.writeFile('wicked-garden-beta', 'refs/SKILL.md', '---\nname: wicked-garden-beta-refs\n---\n', 1);
    expect(nested.verdict).toBe('blocked');
    expect(nested.findings[0]?.kind).toBe('nested-skill-create');
    expect(existsSync(join(s.root, 'effective', 'skills', 'beta', 'refs'))).toBe(false);
  });

  it('add lands a user skill (no baseline), replace rewrites own files only, both guarded', () => {
    s.store.seed();
    const dup = s.store.add('wicked-garden-gamma', { 'SKILL.md': '---\nname: wicked-garden-gamma\n---\n' }, 1);
    expect(dup.verdict).toBe('blocked');
    expect(dup.findings[0]).toMatchObject({ kind: 'name-collision', againstIsCore: true });
    const bad = s.store.add('not-prefixed', { 'SKILL.md': '---\nname: not-prefixed\n---\n' }, 1);
    expect(bad.findings[0]?.kind).toBe('name-invalid');
    const added = s.store.add('wicked-garden-zeta', { 'SKILL.md': '---\nname: wicked-garden-zeta\n---\n\nnew\n', 'refs/a.md': 'a\n' }, 1);
    expect(added.verdict).toBe('clear');
    expect(added.skill).toMatchObject({ dir: 'skills/zeta', provenance: 'user-added', enabled: true, portable: true });
    expect(s.store.reset('wicked-garden-zeta', added.revision).findings[0]?.kind).toBe('no-baseline');
    const replaced = s.store.replace('wicked-garden-alpha', { 'SKILL.md': '---\nname: wicked-garden-alpha\n---\n\nportable now\n' }, added.revision);
    expect(replaced.verdict).toBe('clear');
    expect(replaced.skill).toMatchObject({ provenance: 'override', portable: true, kind: 'module' });
    expect(existsSync(join(s.root, 'effective', 'skills', 'alpha', 'refs', 'notes.md'))).toBe(false);
    expect(existsSync(join(s.root, 'effective', 'skills', 'alpha', 'nested', 'SKILL.md'))).toBe(true);
  });
});

describe('skill-scoped containment (design v3 §API) — no-follow from the ROOT', () => {
  beforeEach(() => {
    s.store.seed();
  });

  it.each([
    ['../gamma/SKILL.md', 'invalid'],
    ['/etc/passwd', 'invalid'],
    ['%2e%2e/gamma/SKILL.md', 'invalid'],
    ['refs\\notes.md', 'invalid'],
    ['C:evil', 'invalid'],
    ['', 'invalid'],
    ['refs/./notes.md', 'invalid'],
  ])('refuses %s', (rel, reason) => {
    expect(() => s.store.resolveSkillFile('wicked-garden-alpha', rel)).toThrow(SkillPathError);
    try {
      s.store.resolveSkillFile('wicked-garden-alpha', rel);
    } catch (err) {
      expect((err as SkillPathError).reason).toBe(reason);
    }
  });

  it('refuses a symlink on any path component (lstat walk, never realpath)', () => {
    symlinkSync(join(s.root, 'effective', 'skills', 'gamma'), join(s.root, 'effective', 'skills', 'alpha', 'link'));
    expect(() => s.store.resolveSkillFile('wicked-garden-alpha', 'link/SKILL.md')).toThrow(/crosses a symlink/);
    rmSync(join(s.root, 'effective', 'skills', 'alpha', 'link'));
  });

  it('refuses a skill dir REPLACED by a symlink: reads throw, writes answer a blocked path-invalid envelope, nothing outside is touched', () => {
    const outside = join(s.base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: wicked-garden-gamma\n---\n\noutside\n');
    rmSync(join(s.root, 'effective', 'skills', 'gamma'), { recursive: true });
    symlinkSync(outside, join(s.root, 'effective', 'skills', 'gamma'));
    expect(() => s.store.resolveSkillFile('wicked-garden-gamma', 'SKILL.md')).toThrow(/crosses a symlink at gamma/);
    expect(() => s.store.listFiles('wicked-garden-gamma')).toThrow(SkillPathError);
    const body = '---\nname: wicked-garden-gamma\n---\n\nhijack\n';
    const written = s.store.writeFile('wicked-garden-gamma', 'SKILL.md', body, 1);
    expect(written).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(written.findings[0]).toMatchObject({ kind: 'path-invalid', severity: 'blocking', skill: 'wicked-garden-gamma' });
    const reset = s.store.reset('wicked-garden-gamma', 1);
    expect(reset.verdict).toBe('blocked');
    expect(reset.findings[0]?.kind).toBe('path-invalid');
    const replaced = s.store.replace('wicked-garden-gamma', { 'SKILL.md': body }, 1);
    expect(replaced.verdict).toBe('blocked');
    expect(replaced.findings[0]?.kind).toBe('path-invalid');
    expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toContain('outside');
    expect(s.store.revision()).toBe(1);
  });

  it('refuses a symlink planted at a write target and preserves mode bits across write and replace', () => {
    const script = join(s.root, 'effective', 'scripts', '_python.sh');
    chmodSync(script, 0o755);
    const support = s.store.writeSupport('scripts/_python.sh', '#!/bin/sh\necho edited\n', 1);
    expect(support.verdict).toBe('warnings');
    expect(lstatSync(script).mode & 0o777).toBe(0o755);
    // replace keeps the mode of a file it rewrites; a new file takes the default.
    const notes = join(s.root, 'effective', 'skills', 'alpha', 'refs', 'notes.md');
    chmodSync(notes, 0o755);
    const replaced = s.store.replace(
      'wicked-garden-alpha',
      { 'SKILL.md': '---\nname: wicked-garden-alpha\n---\n\nreplaced\n', 'refs/notes.md': 'still executable\n', 'refs/new.md': 'new\n' },
      support.revision,
    );
    expect(replaced.verdict).toBe('clear');
    expect(lstatSync(notes).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(s.root, 'effective', 'skills', 'alpha', 'refs', 'new.md')).mode & 0o111).toBe(0);
    // A symlink planted where a write would land is refused; the file it points at is untouched.
    const victim = join(s.base, 'victim.md');
    writeFileSync(victim, 'victim\n');
    symlinkSync(victim, join(s.root, 'effective', 'skills', 'gamma', 'planted.md'));
    const planted = s.store.writeFile('wicked-garden-gamma', 'planted.md', 'pwned\n', replaced.revision);
    expect(planted.verdict).toBe('blocked');
    expect(planted.findings[0]?.kind).toBe('path-invalid');
    expect(readFileSync(victim, 'utf8')).toBe('victim\n');
    expect(readdirSync(join(s.root, 'effective', 'skills', 'gamma')).filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it('refuses a nested skill\'s path through the parent\'s endpoint, and skills/ through the support endpoint', () => {
    expect(() => s.store.resolveSkillFile('wicked-garden-alpha', 'nested/SKILL.md')).toThrow(/belongs to the nested skill wicked-garden-alpha-nested/);
    expect(() => s.store.resolveSupportFile('skills/beta/SKILL.md')).toThrow(/addressed through \/skills\/:name\/files/);
    expect(s.store.resolveSupportFile('scripts/_python.sh').rel).toBe('scripts/_python.sh');
  });

  it('refuses the names the store owns as support paths (snapshot.json, manifest.json, current, views/, .venv) — a write is a blocked envelope, the next publish stays verifiable (codex round 2)', async () => {
    for (const rel of ['snapshot.json', 'manifest.json', 'current', 'views/copilot/.github/skills/x/SKILL.md', '.venv/pyvenv.cfg']) {
      expect(() => s.store.resolveSupportFile(rel), rel).toThrow(SkillPathError);
      try {
        s.store.resolveSupportFile(rel);
      } catch (err) {
        expect((err as SkillPathError).reason, rel).toBe('reserved');
      }
      const written = s.store.writeSupport(rel, 'x', 1);
      expect(written, rel).toMatchObject({ verdict: 'blocked', revision: 1 });
      expect(written.findings[0]?.kind, rel).toBe('path-invalid');
    }
    expect(existsSync(join(s.root, 'effective', 'snapshot.json'))).toBe(false);
    expect(existsSync(join(s.root, 'effective', 'views'))).toBe(false);
    const r = await s.store.publish(1);
    expect(r.verdict).toBe('clear');
    expect(storeOver(s).currentSnapshot()?.gen).toBe(1);
  });

  it('replace never writes through a symlinked CHILD directory: every destination is walked from the root before a byte moves (the codex `gamma/link -> /outside` probe)', () => {
    const outside = join(s.base, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(s.root, 'effective', 'skills', 'gamma', 'link'));
    const before = readFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), 'utf8');
    const replaced = s.store.replace(
      'wicked-garden-gamma',
      { 'SKILL.md': '---\nname: wicked-garden-gamma\n---\n\nreplaced\n', 'link/victim.txt': 'pwned\n' },
      1,
    );
    expect(replaced).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(replaced.findings[0]).toMatchObject({ kind: 'path-invalid', skill: 'wicked-garden-gamma', file: 'link/victim.txt' });
    expect(replaced.findings[0]?.evidence).toMatch(/crosses a symlink at link/);
    expect(readdirSync(outside)).toEqual([]); // nothing landed outside
    expect(readFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), 'utf8')).toBe(before); // nothing was removed either
    // `add` through a dangling link planted where the new skill would land is refused the same way.
    symlinkSync(join(s.base, 'nowhere'), join(s.root, 'effective', 'skills', 'zeta'));
    const added = s.store.add('wicked-garden-zeta', { 'SKILL.md': '---\nname: wicked-garden-zeta\n---\n' }, 1);
    expect(added.verdict).toBe('blocked');
    expect(added.findings[0]?.kind).toBe('path-invalid');
    expect(existsSync(join(s.base, 'nowhere'))).toBe(false);
  });

  it('reset never imports through a symlinked BASELINE ancestor: `baseline/<hash>/skills -> /outside` is refused, effective untouched (the codex probe)', () => {
    const hash = s.store.manifest().baseline;
    const outside = join(s.base, 'outside');
    mkdirSync(join(outside, 'gamma'), { recursive: true });
    writeFileSync(join(outside, 'gamma', 'SKILL.md'), '---\nname: wicked-garden-gamma\n---\n\nOUTSIDE content\n');
    rmSync(join(s.root, 'baseline', hash, 'skills'), { recursive: true });
    symlinkSync(outside, join(s.root, 'baseline', hash, 'skills'));
    const edit = s.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\n---\n\nmine\n', 1);
    expect(edit.verdict).toBe('clear');
    const reset = s.store.reset('wicked-garden-gamma', edit.revision);
    expect(reset).toMatchObject({ verdict: 'blocked', revision: edit.revision });
    expect(reset.findings[0]?.kind).toBe('path-invalid');
    expect(reset.findings[0]?.evidence).toMatch(/crosses a symlink at skills/);
    expect(readFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), 'utf8')).toContain('mine');
    expect(readFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), 'utf8')).not.toContain('OUTSIDE');
  });

  it('typed capped reads flag binary and serve the baseline side on request (contained the same way)', async () => {
    writeFileSync(join(s.root, 'effective', 'skills', 'alpha', 'refs', 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    const bin = await s.store.readFile('wicked-garden-alpha', 'refs/blob.bin');
    expect(bin).toEqual({ binary: true, truncated: false, content: null, size: 4, path: 'skills/alpha/refs/blob.bin' });
    s.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\n---\n\nmine\n', 1);
    expect((await s.store.readFile('wicked-garden-gamma', 'SKILL.md')).content).toContain('mine');
    expect((await s.store.readFile('wicked-garden-gamma', 'SKILL.md', 'baseline')).content).toContain('Rank things');
    await expect(s.store.readFile('wicked-garden-gamma', 'nope.md')).rejects.toMatchObject({ code: 'ENOENT' });
    // The baseline side walks `baseline/<hash>/…` from the root too: a link planted there is refused.
    const hash = s.store.manifest().baseline;
    rmSync(join(s.root, 'baseline', hash, 'skills', 'gamma', 'SKILL.md'));
    symlinkSync(join(s.base, 'nowhere.md'), join(s.root, 'baseline', hash, 'skills', 'gamma', 'SKILL.md'));
    await expect(s.store.readFile('wicked-garden-gamma', 'SKILL.md', 'baseline')).rejects.toThrow(/crosses a symlink/);
  });
});

describe('refresh-baseline — three-way per FILE (design v3 §7)', () => {
  const upstreamWrite = (rel: string, text: string): void => {
    const p = join(s.upstream, ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };

  it('takes upstream where the user is unmodified, keeps user edits where upstream is unchanged, flags both-changed as conflict', () => {
    s.store.seed();
    const first = s.store.manifest().baseline;
    // User edits beta; upstream changes gamma only.
    const edit = s.store.writeFile('wicked-garden-beta', 'SKILL.md', '---\nname: wicked-garden-beta\n---\n\nuser beta (mentions wicked-garden-gamma)\n', 1);
    upstreamWrite('skills/gamma/SKILL.md', '---\nname: wicked-garden-gamma\ndescription: v2\n---\n\ngamma v2\n');
    const r1 = s.store.refreshBaseline(edit.revision);
    expect(r1.verdict).toBe('clear');
    expect(r1.previous_baseline).toBe(first);
    expect(r1.baseline).not.toBe(first);
    expect(r1.taken).toEqual(['wicked-garden-gamma']);
    expect(r1.kept).toEqual(['wicked-garden-beta']);
    expect(r1.conflicts).toEqual([]);
    expect(readFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), 'utf8')).toContain('gamma v2');
    expect(readFileSync(join(s.root, 'effective', 'skills', 'beta', 'SKILL.md'), 'utf8')).toContain('user beta');
    const m1 = s.store.manifest();
    expect(m1.skills['wicked-garden-beta']).toMatchObject({ provenance: 'override', upgradeAvailable: false, conflict: false });
    expect(m1.skills['wicked-garden-gamma']?.provenance).toBe('shipped');
    // Nothing was published, so nothing references the old baseline: only the current one (and its record) exists.
    expect(s.store.baselinesOnDisk()).toEqual([r1.baseline]);
    expect(Object.keys(m1.baselines)).toEqual([r1.baseline]);

    // Now upstream changes beta too: both changed → the user's content is KEPT, conflict flagged,
    // and the upstream side is readable from the baseline.
    upstreamWrite('skills/beta/SKILL.md', '---\nname: wicked-garden-beta\n---\n\nupstream beta v3 wicked-garden-gamma\n');
    const r2 = s.store.refreshBaseline(m1.revision);
    expect(r2.verdict).toBe('warnings');
    expect(r2.conflicts).toEqual(['wicked-garden-beta']);
    expect(r2.kept).toContain('wicked-garden-beta');
    expect(r2.findings.find((f) => f.kind === 'refresh-conflict')?.skill).toBe('wicked-garden-beta');
    expect(readFileSync(join(s.root, 'effective', 'skills', 'beta', 'SKILL.md'), 'utf8')).toContain('user beta');
    const m2 = s.store.manifest();
    expect(m2.skills['wicked-garden-beta']).toMatchObject({ provenance: 'override', upgradeAvailable: true, conflict: true });
    expect(m2.files['skills/beta/SKILL.md']?.conflict).toBe(true);
    expect(readFileSync(join(s.root, 'baseline', r2.baseline, 'skills', 'beta', 'SKILL.md'), 'utf8')).toContain('upstream beta v3');
    // Reset takes upstream wholesale and clears the conflict.
    const reset = s.store.reset('wicked-garden-beta', m2.revision);
    expect(reset.skill).toMatchObject({ provenance: 'shipped', conflict: false, upgradeAvailable: false });
    expect(readFileSync(join(s.root, 'effective', 'skills', 'beta', 'SKILL.md'), 'utf8')).toContain('upstream beta v3');
  });

  it('a user DELETION is a modification: it stands when upstream is unchanged, and is kept + conflict when upstream changed; reset restores upstream', async () => {
    s.store.seed();
    rmSync(join(s.root, 'effective', 'skills', 'delta', 'SKILL.md')); // upstream will NOT change delta
    rmSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md')); // upstream WILL change gamma
    upstreamWrite('skills/gamma/SKILL.md', '---\nname: wicked-garden-gamma\n---\n\ngamma v2\n');
    const r = s.store.refreshBaseline(1);
    expect(r.verdict).toBe('warnings');
    expect(r.conflicts).toEqual(['wicked-garden-gamma']);
    expect(existsSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(s.root, 'effective', 'skills', 'delta', 'SKILL.md'))).toBe(false);
    const m = s.store.manifest();
    expect(m.files['skills/gamma/SKILL.md']).toMatchObject({ effectiveHash: null, conflict: true });
    expect(m.files['skills/gamma/SKILL.md']?.baselineHash).not.toBeNull();
    expect(m.files['skills/delta/SKILL.md']).toMatchObject({ effectiveHash: null, conflict: false });
    expect(m.skills['wicked-garden-gamma']).toMatchObject({ provenance: 'override', conflict: true, upgradeAvailable: true });
    expect(m.skills['wicked-garden-delta']).toMatchObject({ provenance: 'override', conflict: false });
    expect((await s.store.readFile('wicked-garden-gamma', 'SKILL.md', 'baseline')).content).toContain('gamma v2');
    const reset = s.store.reset('wicked-garden-gamma', m.revision);
    expect(reset.skill).toMatchObject({ provenance: 'shipped', conflict: false });
    expect(readFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), 'utf8')).toContain('gamma v2');
  });

  it('adds upstream-new skills, removes upstream-deleted unmodified ones, keeps an upstream-deleted override as user-added, and flags a path-derived name collision', () => {
    s.store.seed();
    // User overrides epsilon and adds `other-theta`; upstream deletes both delta (untouched) and
    // epsilon (overridden), adds zeta, and ships `skills/other/theta` — whose path-derived name IS
    // the user-added skill's.
    const added = s.store.add('wicked-garden-other-theta', { 'SKILL.md': '---\nname: wicked-garden-other-theta\n---\n\nmine\n' }, 1);
    const edited = s.store.writeFile('wicked-garden-epsilon', 'SKILL.md', '---\nname: wicked-garden-epsilon\n---\n\nkept\n', added.revision);
    rmSync(join(s.upstream, 'skills', 'delta'), { recursive: true });
    rmSync(join(s.upstream, 'skills', 'epsilon'), { recursive: true });
    upstreamWrite('skills/zeta/SKILL.md', '---\nname: wicked-garden-zeta\n---\n\nnew upstream\n');
    upstreamWrite('skills/other/theta/SKILL.md', '---\nname: wicked-garden-other-theta\n---\n\nupstream theta\n');
    const r = s.store.refreshBaseline(edited.revision);
    expect(r.added).toEqual(['wicked-garden-zeta']);
    expect(r.removed).toEqual(['wicked-garden-delta']);
    expect(r.conflicts).toEqual(['wicked-garden-other-theta']);
    expect(existsSync(join(s.root, 'effective', 'skills', 'delta'))).toBe(false);
    expect(existsSync(join(s.root, 'effective', 'skills', 'other'))).toBe(false); // held back
    const m = s.store.manifest();
    expect(m.skills['wicked-garden-epsilon']).toMatchObject({ provenance: 'user-added', enabled: true });
    expect(m.files['skills/epsilon/SKILL.md']?.baselineHash).toBeNull();
    expect(m.skills['wicked-garden-zeta']).toMatchObject({ provenance: 'shipped', enabled: true, dir: 'skills/zeta' });
    expect(m.skills['wicked-garden-other-theta']).toMatchObject({ dir: 'skills/other-theta', provenance: 'user-added', conflict: true });
    expect(r.findings.find((f) => f.kind === 'refresh-conflict' && f.skill === 'wicked-garden-other-theta')?.evidence).toContain('skills/other/theta');
    expect(readFileSync(join(s.root, 'effective', 'skills', 'other-theta', 'SKILL.md'), 'utf8')).toContain('mine');
  });

  it('a byte-identical upstream is a no-op that keeps the revision', () => {
    s.store.seed();
    const r = s.store.refreshBaseline(1);
    expect(r).toMatchObject({ verdict: 'clear', taken: [], kept: [], added: [], removed: [], revision: 1 });
    expect(r.baseline).toBe(r.previous_baseline);
  });
});
