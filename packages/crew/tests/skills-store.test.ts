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
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inBundleClosure, pluginBundleFiles } from '../src/skills/bundle.js';
import { containedPath, SkillPathError } from '../src/skills/contain.js';
import { applySkillsSnapshotEnv } from '../src/skills/engine-env.js';
import { PluginSourceSymlinkError, pluginSourceAt } from '../src/skills/plugin-source.js';
import { PORTABILITY_RULES_IDENTITY } from '../src/skills/refs.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import {
  COPILOT_VIEW_SKILLS_REL,
  RevisionMismatchError,
  SkillsCurrentInvalidError,
  SkillsManifestCorruptError,
  SkillsPublishInFlightError,
  SkillsRootChangedError,
  SkillsRootInvalidError,
  SkillsSourceUnavailableError,
  SkillsStore,
  type SnapshotManifest,
  type SnapshotSkillRow,
} from '../src/skills/store.js';
import { hashFileSet, hashTree, removeTreeForce, sha256Hex, walkEntries, walkFiles, walkTree } from '../src/skills/tree.js';
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
/**
 * Re-stamp `manifest.published` from the snapshot.json currently on disk (codex round 7): the manifest
 * AUTHENTICATES the metadata, so an edited snapshot.json alone is refused by the metadata hash. The
 * probes below that exercise the DEEPER checks (link text, symlink enumeration, baseline cross-check,
 * row re-derivation) model an attacker who also holds manifest.json — those checks stay defense in depth.
 */
const stampPublished = (root: string, snapshotJson: string): void => {
  const raw = readFileSync(snapshotJson, 'utf8');
  const parsed = JSON.parse(raw) as { contentHash: string };
  const manifestPath = join(root, 'manifest.json');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { published: { contentHash: string; snapshotHash: string } };
  m.published.contentHash = parsed.contentHash;
  m.published.snapshotHash = sha256Hex(raw);
  writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
};
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
    // F-079: every entry says WHY, with `file:line` evidence, and `portability.portable` repeats `portable`.
    expect(alpha?.portability).toEqual({ portable: false, reasons: ['plugin-root'], evidence: ['skills/alpha/SKILL.md:10'] });
    expect(nested?.portability).toEqual({ portable: false, reasons: ['cross-skill-path', 'relative-link'], evidence: ['skills/alpha/nested/SKILL.md:10'] });
    expect(m.skills['wicked-garden-delta']?.portability).toEqual({ portable: false, reasons: ['cross-skill-path', 'relative-link'], evidence: ['skills/delta/SKILL.md:8'] });
    expect(m.skills['wicked-garden-epsilon']?.portability).toEqual({ portable: false, reasons: ['cwd-script'], evidence: ['skills/epsilon/SKILL.md:8'] });
    expect(m.skills['wicked-garden-beta']?.portability).toEqual({ portable: true, reasons: [], evidence: [] });
    expect(m.skills['wicked-garden-gamma']?.portability).toEqual({ portable: true, reasons: [], evidence: [] });
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

  it('names the fix when no plugin is installed (design v3.6): the installer, or registering the plugin with Claude Code', () => {
    const none = scaffold({ source: () => null });
    try {
      expect(() => none.store.seed()).toThrow(/install wicked-garden first — `npx wicked-installer install wicked-garden`, or register the plugin with Claude Code/);
      expect(() => none.store.seed()).toThrow(/neither the marketplace cache .* nor the installer-managed copy/);
    } finally {
      removeScratch(none.base);
    }
  });

  it('an installer-copy source (design v3.6) is held to the same rules as every kind: the baseline and the published snapshot record kind installer-copy (the persisted enums accept it), and a linked designated entry refuses the seed before the root exists', async () => {
    const copy = scaffold({ source: () => ({ path: FIXTURE_PLUGIN, kind: 'installer-copy', plugin_version: '1.0.0' }) });
    try {
      copy.store.seed();
      const m = copy.store.manifest(); // the manifest validator re-reads the persisted kind — an unknown kind would refuse the whole manifest
      expect(m.baselines[m.baseline]?.source).toEqual({ kind: 'installer-copy', path: FIXTURE_PLUGIN });
      const result = await copy.store.publish(m.revision);
      expect(result.verdict).toBe('clear');
      const snap = result.snapshot as NonNullable<typeof result.snapshot>;
      expect(snapshotManifest(snap.path).gardenSource).toMatchObject({ kind: 'installer-copy', path: FIXTURE_PLUGIN, plugin_version: '1.0.0', baseline: m.baseline });
      expect(copy.store.currentSnapshot()).toMatchObject({ gen: 1, path: realpathSync(snap.path) }); // verifyCurrent validates gardenSource.kind against the known kinds
    } finally {
      removeScratch(copy.base);
    }
    // The no-follow rule (codex round 6) does not care which tier found the copy: a linked skill dir
    // in a copy is refused by name and nothing is created.
    const linked = scaffold();
    try {
      const outside = join(linked.base, 'outside-skill');
      mkdirSync(outside);
      writeFileSync(join(outside, 'SKILL.md'), '---\nname: wicked-garden-gamma\n---\n\noutside\n');
      rmSync(join(linked.upstream, 'skills', 'gamma'), { recursive: true });
      symlinkSync(outside, join(linked.upstream, 'skills', 'gamma'));
      const asCopy = scaffold({ source: () => ({ path: linked.upstream, kind: 'installer-copy', plugin_version: '1.0.0' }) });
      try {
        expect(() => asCopy.store.seed()).toThrow(PluginSourceSymlinkError);
        expect(() => asCopy.store.seed()).toThrow(/skills\/gamma is a symlink/);
        expect(existsSync(asCopy.root)).toBe(false);
      } finally {
        removeScratch(asCopy.base);
      }
    } finally {
      removeScratch(linked.base);
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
      // F-079: the per-reason claim rides the row — `../SKILL.md` into the parent is a relative link INTO another skill.
      portability: { portable: false, reasons: ['cross-skill-path', 'relative-link'], evidence: ['skills/alpha/nested/SKILL.md:10'] },
      nested: true,
    });
    expect(manifest.skills.every((x) => typeof x.portable === 'boolean' && typeof x.nested === 'boolean')).toBe(true);
    // Every row's `portability` agrees with `portable` and names the reasons its files carry (F-079).
    expect(manifest.skills.every((x) => x.portability?.portable === x.portable && (x.portability.reasons.length === 0) === x.portable)).toBe(true);
    expect(Object.fromEntries(manifest.skills.map((x) => [x.name, x.portability?.reasons]))).toEqual({
      'wicked-garden-alpha': ['plugin-root'],
      'wicked-garden-alpha-nested': ['cross-skill-path', 'relative-link'],
      'wicked-garden-beta': [],
      'wicked-garden-epsilon': ['cwd-script'],
      'wicked-garden-gamma': [],
    });
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
    // The content hash covers the files (snapshot.json excluded), the links and the DIRECTORY entries (codex round 9).
    const walked = walkTree(snap.path);
    expect(snap.contentHash).toBe(hashTree(walked.files.filter((f) => f.rel !== 'snapshot.json'), walked.links, walked.dirs));
    expect(snap.contentHash).not.toBe(hashFileSet(walked.files.filter((f) => f.rel !== 'snapshot.json')));
    // Immutable by mode bits too: the generation, its dirs and its files carry no write bit.
    expect(lstatSync(snap.path).mode & 0o222).toBe(0);
    expect(lstatSync(join(snap.path, 'skills', 'gamma')).mode & 0o222).toBe(0);
    expect(lstatSync(join(snap.path, 'skills', 'gamma', 'SKILL.md')).mode & 0o222).toBe(0);
    expect(lstatSync(join(snap.path, 'snapshot.json')).mode & 0o222).toBe(0);
    if (!isRoot) expect(() => writeFileSync(join(snap.path, 'skills', 'gamma', 'SKILL.md'), 'x')).toThrow(/EACCES|EPERM/);
    // `current` resolves (verified) to the generation as an absolute REAL path (v3.1 §2 — the engine's
    // one input); the manifest records the publish and lastPublishedHash.
    expect(snap.path).toBe(realpathSync(join(s.root, 'snapshots', '000001')));
    expect(s.store.currentSnapshot()).toMatchObject({ gen: 1, path: snap.path });
    expect(storeOver(s).currentSnapshot()).toMatchObject({ gen: 1, path: snap.path });
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

  it('a reference whose target is MISSING inside the plugin root is a WARNING: the publish LANDS (snapshot written, current flipped, verdict warnings) naming file:line — design v3.4 §1', async () => {
    s.store.seed();
    // Disabling alpha is legal (not core)… but alpha/nested links `../SKILL.md`, alpha's own file —
    // a target the snapshot OMITS (it belongs to a disabled skill): inside the root, missing.
    const r1 = s.store.disable('wicked-garden-alpha', 1);
    expect(r1.verdict).toBe('clear');
    const r = await s.store.publish(r1.revision);
    expect(r.verdict).toBe('warnings');
    expect(r.snapshot).toMatchObject({ gen: 1 });
    expect(s.store.currentSnapshot()?.gen).toBe(1);
    const ref = r.findings.find((f) => f.kind === 'unresolved-ref');
    expect(ref).toMatchObject({ severity: 'warning', skill: 'wicked-garden-alpha-nested', file: 'skills/alpha/nested/SKILL.md', line: 10 });
    expect(ref?.evidence).toContain('DISABLED skill wicked-garden-alpha');
    expect(ref?.explanation).toContain("content bug the skill's author owns");
    expect(r.findings.some((f) => f.severity === 'blocking')).toBe(false);
    // The publish moved the revision (it landed); analyze mirrors the same warnings without moving it.
    expect(r.revision).toBe(r1.revision + 1);
    const analyzed = s.store.analyze();
    expect(analyzed.verdict).toBe('warnings');
    expect(analyzed.findings.filter((f) => f.kind === 'unresolved-ref')).toHaveLength(1);
    expect(s.store.revision()).toBe(r.revision);

    // A `${CLAUDE_PLUGIN_ROOT}` reference to a file the bundle never carried is the same kind of
    // warning. The write itself is admitted with a WARNING (beta was portable; a plugin-root ref makes
    // it Claude-only) — resolvability is publish's question, not the file manager's.
    const r2 = s.store.enable('wicked-garden-alpha', r.revision);
    const r3 = s.store.writeFile('wicked-garden-beta', 'refs/extra.md', 'see `${CLAUDE_PLUGIN_ROOT}/scripts/missing.py`\n', r2.revision);
    expect(r3.verdict).toBe('warnings');
    expect(r3.findings.map((f) => f.kind)).toEqual(['non-portable']);
    expect(r3.skill?.portable).toBe(false);
    const again = await s.store.publish(r3.revision);
    expect(again.verdict).toBe('warnings');
    expect(again.snapshot?.gen).toBe(2);
    const missing = again.findings.filter((f) => f.kind === 'unresolved-ref');
    expect(missing).toHaveLength(1); // alpha is enabled again, so alpha/nested's link resolves; only beta's is left
    expect(missing[0]).toMatchObject({ severity: 'warning', skill: 'wicked-garden-beta', file: 'skills/beta/refs/extra.md', line: 1 });
    expect(missing[0]?.evidence).toContain('scripts/missing.py — no such file in effective/');
    // The warning ships WITH the snapshot: the file is in the generation exactly as written.
    expect(readFileSync(join(again.snapshot?.path ?? '', 'skills', 'beta', 'refs', 'extra.md'), 'utf8')).toContain('missing.py');
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
    // Only the PUBLISHED generation's metadata is authenticated (codex round 7): a torn `current` behind
    // it is refused loudly, never served on trust — and ensureReady finishes the flip from the
    // authenticated published generation BEFORE it verifies `current`.
    expect(() => fresh.currentSnapshot()).toThrow(/not the generation manifest\.json published/);
    const ready = await fresh.ensureReady();
    expect(ready).toEqual({ seeded: false, source: null, published: null }); // finished, not re-published
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
    // An ESCAPING ref blocks (v3.4 §1 — a merely missing target would publish with a warning).
    const off = s.store.writeFile('wicked-garden-beta', 'refs/escape.md', 'see `${CLAUDE_PLUGIN_ROOT}/../x`\n', 1);
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

  it('frontmatter is parsed by a REAL YAML grammar: what the parser rejects is BLOCKING (codex round 3)', async () => {
    s.store.seed();
    // Cases the old bracket-depth heuristic accepted but a real YAML parser rejects.
    const bad = s.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\ntags: [a, {b: c]]\n---\n\nx\n', 1);
    expect(bad.verdict).toBe('blocked');
    expect(bad.findings[0]?.kind).toBe('frontmatter-invalid');
    expect(bad.findings[0]?.evidence).toContain('skills/gamma/SKILL.md');
    for (const value of ['"bad\\q"', '"hello" "world"', 'tags: [ranking, prose', 'description: "open']) {
      writeFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), `---\nname: wicked-garden-gamma\n${value.includes(':') ? value : `tags: ${value}`}\n---\n\nx\n`);
      const r = await s.store.publish(1);
      expect(r.verdict, value).toBe('blocked');
      expect(r.findings.find((f) => f.kind === 'frontmatter-invalid'), value).toBeDefined();
      expect(s.store.currentSnapshot(), value).toBeNull();
    }
    // A valid flow value (the live catalog's shape) still parses and publishes clear.
    writeFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), '---\nname: wicked-garden-gamma\ntags: [ranking, prose]\n---\n\nx\n');
    const ok = await s.store.publish(1);
    expect(ok.findings.find((f) => f.kind === 'frontmatter-invalid')).toBeUndefined();
    expect(ok.verdict).toBe('warnings'); // fs-drift of the direct edit only
  });
});

describe('persisted manifest paths never escape the root (codex round 3)', () => {
  it('a crafted manifest `dir` (../../outside) is refused at PARSE, and a crafted file record at RESOLVE', () => {
    s.store.seed();
    const manifestPath = join(s.root, 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { skills: Record<string, { dir: string }>; files: Record<string, unknown> };
    // A traversal in a skill `dir` is a corrupt manifest refused loudly — never a path the store joins onto the root.
    const escaped = structuredClone(raw);
    (escaped.skills['wicked-garden-gamma'] as { dir: string }).dir = '../../outside';
    writeFileSync(manifestPath, JSON.stringify(escaped));
    expect(() => storeOver(s).manifest()).toThrow(/not a skills manifest|dir/);
    // A crafted file-record path is refused too.
    const badFile = structuredClone(raw);
    badFile.files['../../outside/victim.txt'] = { baselineHash: null, effectiveHash: 'x', lastPublishedHash: null, conflict: false };
    writeFileSync(manifestPath, JSON.stringify(badFile));
    expect(() => storeOver(s).manifest()).toThrow(/not a skills manifest|file record/);
    // A crafted baseline identifier (not a content hash) is refused.
    writeFileSync(manifestPath, JSON.stringify({ ...raw, baseline: '../../outside' }));
    expect(() => storeOver(s).manifest()).toThrow(/not a skills manifest|content hash/);
    // Restore a sane manifest so afterEach teardown is quiet.
    writeFileSync(manifestPath, JSON.stringify(raw));
  });

  it('containedPath re-checks the FINAL joined path — a `..` in any component is refused, independent of manifest trust', () => {
    s.store.seed();
    const root = s.root;
    // A safe joined path resolves; the resolve-side defense is separate from the manifest-parse one.
    expect(() => containedPath(root, ['effective', 'skills', 'gamma', 'SKILL.md'])).not.toThrow();
    // A `..` smuggled in via a "trusted" `dir` segment is refused LEXICALLY, before the join escapes —
    // even with no symlink present (the lstat walk alone would follow `..` out of the root).
    expect(() => containedPath(root, ['effective', '..', '..', 'outside', 'victim.txt'])).toThrow(SkillPathError);
    try {
      containedPath(root, ['effective', '..', 'x']);
    } catch (err) {
      expect((err as SkillPathError).reason).toBe('invalid');
    }
    // The request path is validated the same way through resolveSkillFile (the raw `..` never reaches disk).
    expect(() => s.store.resolveSkillFile('wicked-garden-gamma', '../../outside/victim.txt')).toThrow(SkillPathError);
  });
});

describe('persisted skill KEYS never escape the root (codex round 4)', () => {
  it("a crafted skill KEY (../../../../outside) is refused at PARSE — before it could ever become a copilot-view path — and so is a key that is not its dir's path-derived name", async () => {
    s.store.seed();
    const manifestPath = join(s.root, 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { skills: Record<string, unknown> };
    const gamma = raw.skills['wicked-garden-gamma'];
    // The codex probe: the key becomes `views/copilot/.github/skills/<key>/SKILL.md` at publish.
    const escaped = structuredClone(raw);
    delete escaped.skills['wicked-garden-gamma'];
    escaped.skills['../../../../outside'] = gamma;
    writeFileSync(manifestPath, JSON.stringify(escaped));
    expect(() => storeOver(s).manifest()).toThrow(SkillsManifestCorruptError);
    expect(() => storeOver(s).manifest()).toThrow(/skill key/);
    await expect(storeOver(s).publish(1)).rejects.toBeInstanceOf(SkillsManifestCorruptError);
    expect(existsSync(join(s.root, 'snapshots'))).toBe(false); // nothing was staged, let alone copied
    expect(existsSync(join(s.root, 'outside'))).toBe(false);
    expect(existsSync(join(s.base, 'outside'))).toBe(false);
    // A well-formed key that is NOT the path-derived name of its dir is refused too: the key, the
    // directory and the invocation identity are one thing (a shadow of another skill's identity).
    const shadow = structuredClone(raw);
    delete shadow.skills['wicked-garden-gamma'];
    shadow.skills['wicked-garden-beta-shadow'] = gamma; // sits at skills/gamma, which derives wicked-garden-gamma
    writeFileSync(manifestPath, JSON.stringify(shadow));
    expect(() => storeOver(s).manifest()).toThrow(/path-derived name/);
    // A key without the prefix (a copilot-view segment that is not a skill name) is refused.
    const bare = structuredClone(raw);
    delete bare.skills['wicked-garden-gamma'];
    bare.skills['gamma'] = gamma;
    writeFileSync(manifestPath, JSON.stringify(bare));
    expect(() => storeOver(s).manifest()).toThrow(/skill key/);
    writeFileSync(manifestPath, JSON.stringify(raw)); // restore so teardown is quiet
    expect(storeOver(s).manifest().revision).toBe(1);
  });
});

describe('the skills root ITSELF is checked before every read and mutation (codex round 4)', () => {
  const ops = (store: SkillsStore): Array<[string, () => unknown]> => [
    ['manifest', () => store.manifest()],
    ['isSeeded', () => store.isSeeded()],
    ['listFiles', () => store.listFiles('wicked-garden-gamma')],
    ['resolveSkillFile', () => store.resolveSkillFile('wicked-garden-gamma', 'SKILL.md')],
    ['resolveSupportFile', () => store.resolveSupportFile('scripts/_python.sh')],
    ['writeFile', () => store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\n---\n\nhijack\n', 1)],
    ['writeSupport', () => store.writeSupport('scripts/_python.sh', 'hijack\n', 1)],
    ['enable', () => store.enable('wicked-garden-delta', 1)],
    ['disable', () => store.disable('wicked-garden-delta', 1)],
    ['reset', () => store.reset('wicked-garden-gamma', 1)],
    ['add', () => store.add('wicked-garden-zeta', { 'SKILL.md': '---\nname: wicked-garden-zeta\n---\n' }, 1)],
    ['replace', () => store.replace('wicked-garden-gamma', { 'SKILL.md': '---\nname: wicked-garden-gamma\n---\n' }, 1)],
    ['refreshBaseline', () => store.refreshBaseline(1)],
    ['analyze', () => store.analyze()],
    ['currentSnapshot', () => store.currentSnapshot()],
  ];
  const treeDigest = (dir: string): string => JSON.stringify(walkFiles(dir).map((f) => [f.rel, sha256Hex(readFileSync(f.abs))]));

  it('a root replaced by a symlink to a COPIED store after boot refuses EVERY operation (reads, writes, commit, publish, refresh, current) — and the copy is untouched', async () => {
    s.store.seed(); // boot: the store binds the root's identity here
    expect(s.store.manifest().revision).toBe(1);
    const copy = join(s.base, 'copy');
    cpSync(s.root, copy, { recursive: true });
    const before = treeDigest(copy);
    rmSync(s.root, { recursive: true });
    symlinkSync(copy, s.root);
    // The SAME instance (bound at boot) — every op is refused by the root check, none redirected.
    for (const [name, op] of ops(s.store)) {
      expect(op, name).toThrow(SkillsRootInvalidError);
      expect(op, name).toThrow(/symlink stands in for the skills root/);
    }
    await expect(s.store.readFile('wicked-garden-gamma', 'SKILL.md')).rejects.toBeInstanceOf(SkillsRootInvalidError);
    await expect(s.store.readSupport('scripts/_python.sh')).rejects.toBeInstanceOf(SkillsRootInvalidError);
    await expect(s.store.publish(1)).rejects.toBeInstanceOf(SkillsRootInvalidError);
    await expect(s.store.ensureReady()).rejects.toBeInstanceOf(SkillsRootInvalidError);
    // A FRESH instance (a restart) refuses too — a link standing in for the root is never bound.
    for (const [name, op] of ops(storeOver(s))) expect(op, name).toThrow(SkillsRootInvalidError);
    // Reaping from the event listener never throws — it skips, and says so.
    s.store.reapStale();
    expect(s.warnings.some((w) => w.includes('reaping skipped') && w.includes('skills root'))).toBe(true);
    // Nothing reached the copy: no file changed, no manifest commit, no snapshot, no staging.
    expect(treeDigest(copy)).toBe(before);
    expect(existsSync(join(copy, 'snapshots'))).toBe(false);
    expect(readdirSync(copy).filter((e) => e.startsWith('.staging-'))).toEqual([]);
    rmSync(s.root); // the link only — teardown removes the copy with the base
  });

  it("an ANCESTOR swapped under the running daemon (the root's canonical path moved) is refused by the bound identity, although the root entry is a real directory through the link; a FRESH store binds afresh (the root is never re-aimed — codex round 5)", () => {
    const parent = join(s.base, 'parent');
    const root = join(parent, 'root');
    mkdirSync(parent, { recursive: true });
    const store = new SkillsStore({
      root,
      registeredSkillRefs: () => REGISTERED_REFS,
      provisionVenv: noVenv,
      source: () => pluginSourceAt(s.upstream),
      now: () => CLOCK,
      warn: () => undefined,
    });
    store.seed(); // binds realpath(<base>/parent/root)
    expect(store.manifest().revision).toBe(1);
    renameSync(parent, join(s.base, 'parent-moved'));
    symlinkSync(join(s.base, 'parent-moved'), parent);
    expect(lstatSync(root).isDirectory()).toBe(true); // reached THROUGH the parent link — lstat alone would pass it
    expect(() => store.manifest()).toThrow(SkillsRootInvalidError);
    expect(() => store.manifest()).toThrow(/canonical path/);
    expect(() => store.writeSupport('scripts/_python.sh', 'x', 1)).toThrow(SkillsRootInvalidError);
    // A restart (a fresh store over the same path) binds the identity it now sees — there is no
    // `reroot`: the root is `<state home>/skills` for the store's whole lifetime.
    const fresh = new SkillsStore({
      root,
      registeredSkillRefs: () => REGISTERED_REFS,
      provisionVenv: noVenv,
      source: () => pluginSourceAt(s.upstream),
      now: () => CLOCK,
      warn: () => undefined,
    });
    expect(fresh.manifest().revision).toBe(1);
    expect('reroot' in store).toBe(false);
    rmSync(parent);
  });
});

describe('provisioning paths are validated before ANY filesystem operation (codex round 4)', () => {
  it('a symlinked `baseline/<hash>` refuses the publish before the provisioner runs, before any removal, marker write or chmod — the link target is untouched; a symlinked uv cache and a missing baseline dir are refused too', async () => {
    let calls = 0;
    const v = scaffold({
      provisionVenv: async (baselineDir) => {
        calls += 1;
        mkdirSync(join(baselineDir, '.venv', 'bin'), { recursive: true });
        writeFileSync(join(baselineDir, '.venv', 'bin', 'python'), '#!/bin/sh\n');
        return 'synced';
      },
    });
    try {
      v.store.seed();
      const hash = v.store.manifest().baseline;
      const hashDir = join(v.root, 'baseline', hash);
      const outside = join(v.base, 'outside-baseline');
      cpSync(hashDir, outside, { recursive: true });
      // An env WITHOUT a ready marker under the link target: the old code removed it THROUGH the link.
      mkdirSync(join(outside, '.venv', 'bin'), { recursive: true });
      writeFileSync(join(outside, '.venv', 'bin', 'half'), 'torn\n');
      const modeBefore = lstatSync(outside).mode;
      rmSync(hashDir, { recursive: true });
      symlinkSync(outside, hashDir);
      // A symlinked `baseline/<hash>` is `baseline-corrupt` BEFORE the provisioner runs (codex round 7: a
      // baseline is re-verified before every reuse) — the 2xx blocked envelope, nothing provisioned or written.
      const corrupt = await v.store.publish(1);
      expect(corrupt.verdict).toBe('blocked');
      expect(corrupt.snapshot).toBeNull();
      expect(corrupt.findings[0]).toMatchObject({ kind: 'baseline-corrupt', severity: 'blocking', file: `baseline/${hash}` });
      expect(corrupt.findings[0]?.evidence).toContain('is a symlink');
      expect(calls).toBe(0); // uv never ran
      expect(existsSync(join(outside, '.venv', 'bin', 'half'))).toBe(true); // nothing removed through the link
      expect(existsSync(join(outside, '.venv', VENV_READY_MARKER))).toBe(false); // no marker written
      expect(lstatSync(outside).mode).toBe(modeBefore); // no chmod
      expect(lstatSync(join(outside, '.venv', 'bin', 'half')).mode & 0o222).not.toBe(0);
      expect(existsSync(join(v.root, 'snapshots'))).toBe(false);
      expect(v.store.revision()).toBe(1);
      // Restore a real baseline dir; a symlinked `.uv-cache` (where uv would write) is refused the same way.
      rmSync(hashDir);
      cpSync(outside, hashDir, { recursive: true });
      rmSync(join(hashDir, '.venv'), { recursive: true });
      symlinkSync(join(v.base, 'outside-cache'), join(v.root, '.uv-cache'));
      await expect(v.store.publish(1)).rejects.toThrow(/\.uv-cache/);
      expect(calls).toBe(0);
      rmSync(join(v.root, '.uv-cache'));
      // A manifest naming a baseline that is NOT on disk is `baseline-corrupt`, never provisioned into a void.
      rmSync(hashDir, { recursive: true });
      const missing = await v.store.publish(1);
      expect(missing.verdict).toBe('blocked');
      expect(missing.findings[0]).toMatchObject({ kind: 'baseline-corrupt' });
      expect(missing.findings[0]?.evidence).toContain('does not exist');
      expect(calls).toBe(0);
      // With the baseline back, the same publish provisions and lands.
      cpSync(outside, hashDir, { recursive: true });
      rmSync(join(hashDir, '.venv'), { recursive: true });
      const ok = await v.store.publish(1);
      expect(ok.verdict).toBe('clear');
      expect(calls).toBe(1);
    } finally {
      removeTreeForce(v.base);
    }
  });
});

describe('mandates come from the PARSED frontmatter (codex round 4)', () => {
  it('an escaped scalar counts: `mandates: ["wicked-garden-\\u0067amma"]` makes gamma core; a declared mandate the catalog lacks blocks with its frontmatter line; a non-string entry is frontmatter-invalid', async () => {
    s.store.seed();
    // beta's BODY no longer mentions gamma; the frontmatter DECLARES it — spelled with a YAML escape
    // the raw text does not contain — plus a phantom in the Claude colon form.
    const w = s.store.writeFile(
      'wicked-garden-beta',
      'SKILL.md',
      '---\nname: wicked-garden-beta\nmandates:\n  - "wicked-garden-\\u0067amma"\n  - wicked-garden:phantom\n---\n\nNo prose mention of any skill here.\n',
      1,
    );
    expect(w.verdict).toBe('clear');
    expect(s.store.manifest().skills['wicked-garden-gamma']?.core).toBe(true);
    const off = s.store.disable('wicked-garden-gamma', w.revision);
    expect(off.verdict).toBe('blocked');
    expect(off.findings[0]?.kind).toBe('core-disable');
    const r = await s.store.publish(w.revision);
    expect(r.verdict).toBe('blocked');
    expect(r.findings.find((f) => f.kind === 'core-missing')).toMatchObject({
      severity: 'blocking',
      skill: 'wicked-garden-beta',
      file: 'skills/beta/SKILL.md',
      line: 5,
      againstSkill: 'wicked-garden-phantom',
    });
    expect(s.store.currentSnapshot()).toBeNull();
    // A frontmatter SCALAR mentioning a name is not prose and not a mandate: only the declared list
    // and the body count (the frontmatter block is never regex-scanned).
    const desc = s.store.writeFile(
      'wicked-garden-beta',
      'SKILL.md',
      '---\nname: wicked-garden-beta\ndescription: unlike wicked-garden-ghost, this one ranks\n---\n\nUse the **wicked-garden-gamma** skill.\n',
      w.revision,
    );
    expect(desc.verdict).toBe('clear');
    const ok = await s.store.publish(desc.revision);
    expect(ok.findings.filter((f) => f.kind === 'core-missing')).toEqual([]);
    expect(ok.verdict).toBe('clear');
    // A non-string entry is a strict-subset failure, never a silently skipped mandate.
    const bad = s.store.writeFile('wicked-garden-beta', 'SKILL.md', '---\nname: wicked-garden-beta\nmandates: [123]\n---\n', ok.revision);
    expect(bad.verdict).toBe('blocked');
    expect(bad.findings[0]?.kind).toBe('frontmatter-invalid');
    expect(bad.findings[0]?.evidence).toContain('non-empty strings');
  });
});

describe('symlinked storage ancestors are refused (codex round 3)', () => {
  it('a `snapshots -> outside` symlink refuses publish before the first copy, and a redirected snapshots boundary does not verify', async () => {
    s.store.seed();
    await s.store.publish(1); // gen 1 exists (locked read-only)
    const outside = join(s.base, 'outside-snapshots');
    mkdirSync(outside, { recursive: true });
    removeTreeForce(join(s.root, 'snapshots')); // the published generation is locked; force it
    symlinkSync(outside, join(s.root, 'snapshots'));
    // Publish is refused before writing anything (the redirected ancestor).
    await expect(storeOver(s).publish(storeOver(s).revision())).rejects.toThrow(/storage directory is a symlink|snapshots/);
    expect(readdirSync(outside)).toEqual([]); // nothing was copied into the redirect
    // `current` verification refuses the redirected snapshots boundary instead of accepting its realpath.
    expect(() => storeOver(s).currentSnapshot()).toThrow(SkillsCurrentInvalidError);
    rmSync(join(s.root, 'snapshots'));
  });

  it('a `baseline -> outside` symlink refuses baseline capture (a refresh)', () => {
    s.store.seed();
    const outside = join(s.base, 'outside-baseline');
    mkdirSync(outside, { recursive: true });
    removeTreeForce(join(s.root, 'baseline'));
    symlinkSync(outside, join(s.root, 'baseline'));
    writeFileSync(join(s.upstream, 'skills', 'gamma', 'SKILL.md'), '---\nname: wicked-garden-gamma\n---\n\nv2\n');
    expect(() => s.store.refreshBaseline(1)).toThrow(/storage directory is a symlink|baseline/);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(s.root, 'baseline'));
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

  it('a synced env the daemon cannot LOCK is a FAILED provisioning that leaves NO marker; a retry re-provisions and re-locks — no silent synced (codex round 3)', async () => {
    if (isRoot) return; // root ignores permission bits
    let call = 0;
    const provisioner: VenvProvisioner = async (baselineDir) => {
      call += 1;
      mkdirSync(join(baselineDir, '.venv', 'bin'), { recursive: true });
      writeFileSync(join(baselineDir, '.venv', 'bin', 'python'), '#!/bin/sh\n');
      if (call === 1) {
        // First attempt: an env that cannot be locked read-only (an unlistable dir the lock chokes on).
        const sealed = join(baselineDir, '.venv', 'lib', 'sealed');
        mkdirSync(sealed, { recursive: true });
        writeFileSync(join(sealed, 'x.py'), 'x');
        chmodSync(sealed, 0o000);
      }
      return 'synced';
    };
    const v = scaffold({ provisionVenv: provisioner });
    try {
      v.store.seed();
      const hash = v.store.manifest().baseline;
      const venvDir = join(v.root, 'baseline', hash, '.venv');
      // First publish: the lock fails → a blocking `venv-failed`, and the whole partial env is
      // removed so no ready marker survives (it must not be trusted on retry).
      const r1 = await v.store.publish(1);
      expect(r1.verdict).toBe('blocked');
      expect(r1.findings.map((f) => f.kind)).toContain('venv-failed');
      expect(v.warnings.some((w) => w.includes('could not lock'))).toBe(true);
      expect(existsSync(join(venvDir, VENV_READY_MARKER))).toBe(false);
      expect(existsSync(venvDir)).toBe(false); // no partial env left behind
      expect(v.store.currentSnapshot()).toBeNull();
      expect(v.store.manifest().baselines[hash]?.venv).toBe('pending'); // never recorded synced

      // Retry: the provisioner runs AGAIN (no silent synced off a stale marker) and this time the
      // env locks — a clean publish.
      const r2 = await v.store.publish(1);
      expect(r2.verdict).toBe('clear');
      expect(call).toBe(2);
      expect(existsSync(join(venvDir, VENV_READY_MARKER))).toBe(true);
      expect(lstatSync(venvDir).mode & 0o222).toBe(0); // actually read-only now
      expect(v.store.manifest().baselines[hash]?.venv).toBe('synced');
    } finally {
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
      expect(await ready).toEqual({ seeded: false, source: null, published: null });
      expect(v.store.isPublishing()).toBe(false);
      expect(gate.calls).toHaveLength(1);
      expect(v.store.generationsOnDisk()).toEqual([1]);
      // The lock is released: the next publish runs.
      expect((await v.store.publish(r.revision)).snapshot?.gen).toBe(2);
    } finally {
      removeTreeForce(v.base);
    }
  });

  it('a publish whose root MOVES under it during its await (an ancestor link repointed at a copy) ABORTS — nothing is written to either tree (the codex root-switch probe, without a reroot: the root is never re-aimed)', async () => {
    const gate = gatedProvisioner();
    const base = mkdtempSync(join(tmpdir(), 'skills-switch-'));
    try {
      // The store's root is reached THROUGH `via -> a`; `b` is a byte-identical copy (also revision 1 —
      // a numeric CAS alone would accept it).
      const a = join(base, 'a');
      const b = join(base, 'b');
      mkdirSync(a);
      symlinkSync(a, join(base, 'via'));
      const upstream = join(base, 'upstream');
      cpSync(FIXTURE_PLUGIN, upstream, { recursive: true });
      const store = new SkillsStore({
        root: join(base, 'via', 'root'),
        registeredSkillRefs: () => REGISTERED_REFS,
        provisionVenv: gate.provisioner,
        source: () => pluginSourceAt(upstream),
        now: () => CLOCK,
        warn: () => undefined,
      });
      store.seed();
      cpSync(a, b, { recursive: true });
      const inFlight = store.publish(1);
      await new Promise((resolve) => setImmediate(resolve));
      rmSync(join(base, 'via'));
      symlinkSync(b, join(base, 'via')); // the root's canonical path now lands in the copy
      gate.release();
      // The bound identity refuses first (`SkillsRootInvalidError`); had the root vanished instead,
      // `SkillsRootChangedError` names it — either way nothing is written to either tree.
      await expect(inFlight).rejects.toThrow(/canonical path/);
      expect(existsSync(join(a, 'root', 'snapshots'))).toBe(false);
      expect(existsSync(join(b, 'root', 'snapshots'))).toBe(false);
      expect(store.isPublishing()).toBe(false);
      expect(readdirSync(join(a, 'root')).filter((e) => e.startsWith('.staging-'))).toEqual([]);
      expect(readdirSync(join(b, 'root')).filter((e) => e.startsWith('.staging-'))).toEqual([]);
    } finally {
      removeScratch(base);
    }
  });

  it('a root that VANISHES during the await is SkillsRootChangedError (the 2xx root-changed envelope) — nothing published', async () => {
    const gate = gatedProvisioner();
    const v = scaffold({ provisionVenv: gate.provisioner });
    try {
      v.store.seed();
      const inFlight = v.store.publish(1);
      await new Promise((resolve) => setImmediate(resolve));
      rmSync(v.root, { recursive: true, force: true });
      gate.release();
      await expect(inFlight).rejects.toBeInstanceOf(SkillsRootChangedError);
      await expect(inFlight).rejects.toMatchObject({ root: v.root, revision: 1 });
      await expect(inFlight).rejects.toThrow(/vanished/);
      expect(existsSync(v.root)).toBe(false);
    } finally {
      removeScratch(v.base);
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

  it('reset honours EFFECTIVE nested ownership: a child added under refs/ (absent from the baseline) keeps its notes byte-for-byte (codex round 3)', () => {
    s.store.seed();
    // Turn `alpha/refs` into a nested skill ON DISK (the baseline has no SKILL.md there) and modify
    // its notes — those files are now owned by `alpha/refs`, not by alpha.
    const refsDir = join(s.root, 'effective', 'skills', 'alpha', 'refs');
    writeFileSync(join(refsDir, 'SKILL.md'), '---\nname: wicked-garden-alpha-refs\n---\n\nchild\n');
    writeFileSync(join(refsDir, 'notes.md'), 'CHILD-OWNED notes\n');
    const childNotes = readFileSync(join(refsDir, 'notes.md'), 'utf8');
    const edit = s.store.writeFile('wicked-garden-alpha', 'SKILL.md', '---\nname: wicked-garden-alpha\nuser-invocable: true\n---\n\nmine\n', 1);
    const reset = s.store.reset('wicked-garden-alpha', edit.revision);
    expect(reset.verdict).toBe('clear');
    // alpha's own SKILL.md is restored from the baseline…
    expect(readFileSync(join(s.root, 'effective', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe(
      readFileSync(join(FIXTURE_PLUGIN, 'skills', 'alpha', 'SKILL.md'), 'utf8'),
    );
    // …but the nested child's notes are NOT overwritten with baseline content — kept byte-for-byte.
    expect(readFileSync(join(refsDir, 'notes.md'), 'utf8')).toBe(childNotes);
    expect(readFileSync(join(refsDir, 'SKILL.md'), 'utf8')).toContain('child');
  });

  it('reset preflights before mutating: a symlinked child dir blocks the reset with NOTHING removed and the revision unchanged (codex round 3)', () => {
    s.store.seed();
    const edit = s.store.writeFile('wicked-garden-alpha', 'SKILL.md', '---\nname: wicked-garden-alpha\nuser-invocable: true\n---\n\nmine\n', 1);
    const before = readFileSync(join(s.root, 'effective', 'skills', 'alpha', 'SKILL.md'), 'utf8');
    const rev = edit.revision;
    // Replace `alpha/refs` with a symlink to outside — its baseline `notes.md` would restore THROUGH it.
    const outside = join(s.base, 'outside-refs');
    mkdirSync(outside, { recursive: true });
    rmSync(join(s.root, 'effective', 'skills', 'alpha', 'refs'), { recursive: true });
    symlinkSync(outside, join(s.root, 'effective', 'skills', 'alpha', 'refs'));
    const reset = s.store.reset('wicked-garden-alpha', rev);
    expect(reset).toMatchObject({ verdict: 'blocked', revision: rev });
    expect(reset.findings[0]?.kind).toBe('path-invalid');
    expect(reset.findings[0]?.evidence).toMatch(/crosses a symlink at refs/);
    // NOTHING was removed: alpha's own SKILL.md is exactly what it was, the revision did not move,
    // and nothing was written through the link.
    expect(readFileSync(join(s.root, 'effective', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe(before);
    expect(s.store.revision()).toBe(rev);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(s.root, 'effective', 'skills', 'alpha', 'refs'));
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

describe('catalog recomputation is CONTAINED — every internal read walks from the root (codex round 5)', () => {
  /** Point `effective/skills/gamma` OUTSIDE the store, at a copy whose bytes would flip every derived field if read. */
  const linkGammaOutside = (): string => {
    const outside = join(s.base, 'outside-gamma');
    mkdirSync(join(outside, 'refs'), { recursive: true });
    // If these bytes were ever read: kind → fork-worker (context: fork), portable → false (a plugin-root ref), and beta's mandate chain would change.
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: wicked-garden-gamma\ncontext: fork\n---\n\nrun ${CLAUDE_PLUGIN_ROOT}/scripts/x.py — OUTSIDE BYTES\n');
    writeFileSync(join(outside, 'refs', 'leak.md'), 'python3 scripts/leak.py\n');
    rmSync(join(s.root, 'effective', 'skills', 'gamma'), { recursive: true });
    symlinkSync(outside, join(s.root, 'effective', 'skills', 'gamma'));
    return outside;
  };

  it('analyze/publish over `effective/skills/gamma -> /outside` BLOCK with a path-invalid naming gamma; kind/portable are NOT derived from the outside bytes', () => {
    s.store.seed();
    const before = s.store.manifest().skills['wicked-garden-gamma'];
    expect(before).toMatchObject({ kind: 'module', portable: true, core: true });
    linkGammaOutside();
    const analyzed = s.store.analyze();
    expect(analyzed.verdict).toBe('blocked');
    const refusal = analyzed.findings.find((f) => f.kind === 'path-invalid');
    expect(refusal).toMatchObject({ severity: 'blocking', skill: 'wicked-garden-gamma', file: 'skills/gamma' });
    expect(refusal?.evidence).toMatch(/crosses a symlink at gamma/);
    // The derived fields kept their last honest values — the outside SKILL.md (fork, plugin-root ref) was never consumed.
    const after = s.store.manifest().skills['wicked-garden-gamma'];
    expect(after).toMatchObject({ kind: 'module', portable: true });
    // fs-drift is reported too (the recorded files are no longer regular files on a link-free path), never trusted.
    expect(analyzed.findings.some((f) => f.kind === 'fs-drift')).toBe(true);
  });

  it('a mutation on ANOTHER skill still lands, carries the refusal as a WARNING naming gamma, and reads nothing outside', () => {
    s.store.seed();
    linkGammaOutside();
    const off = s.store.disable('wicked-garden-delta', 1);
    expect(off.verdict).toBe('warnings');
    expect(off.revision).toBe(2);
    expect(off.findings.find((f) => f.kind === 'path-invalid')).toMatchObject({ severity: 'warning', skill: 'wicked-garden-gamma' });
    expect(s.store.manifest().skills['wicked-garden-delta']?.enabled).toBe(false);
    expect(s.store.manifest().skills['wicked-garden-gamma']).toMatchObject({ kind: 'module', portable: true });
    const edit = s.store.writeFile('wicked-garden-beta', 'SKILL.md', '---\nname: wicked-garden-beta\nmandates: [wicked-garden-gamma]\n---\n\nedited\n', off.revision);
    expect(edit.verdict).toBe('warnings');
    expect(edit.findings.map((f) => f.kind)).toContain('path-invalid');
    // A mutation ON the linked skill is refused outright (containment on the write path).
    const own = s.store.writeFile('wicked-garden-gamma', 'SKILL.md', 'x', edit.revision);
    expect(own).toMatchObject({ verdict: 'blocked', revision: edit.revision });
  });

  it('a recorded FILE replaced by a link (the leaf) is drift, never read — its bytes never judge portability; a linked SUBDIRECTORY inside a real skill dir is refused by name', () => {
    s.store.seed();
    const outside = join(s.base, 'outside-notes.md');
    writeFileSync(outside, 'python3 scripts/leak.py\n'); // a cwd-script: would flip beta to non-portable if read
    const beta = join(s.root, 'effective', 'skills', 'beta');
    const edit = s.store.writeFile('wicked-garden-beta', 'refs/notes.md', 'plain notes\n', 1);
    expect(edit.verdict).toBe('clear');
    expect(s.store.manifest().skills['wicked-garden-beta']?.portable).toBe(true);
    rmSync(join(beta, 'refs', 'notes.md'));
    symlinkSync(outside, join(beta, 'refs', 'notes.md'));
    const leaf = s.store.analyze();
    expect(leaf.findings.find((f) => f.kind === 'fs-drift')?.evidence).toContain('skills/beta/refs/notes.md');
    expect(s.store.manifest().skills['wicked-garden-beta']?.portable).toBe(true); // the linked file's cwd-script never counted
    // A linked SUBDIRECTORY (`beta/refs -> outside dir` holding the recorded file): a mutation's
    // recompute walks to the record and REFUSES it by name (a warning on the other skill's
    // mutation); the validation pass sees the record vanish from the link-free walk (drift) —
    // either way the outside bytes never judge portability.
    rmSync(join(beta, 'refs'), { recursive: true });
    const outsideDir = join(s.base, 'outside-refs');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'notes.md'), 'python3 scripts/leak.py\n');
    symlinkSync(outsideDir, join(beta, 'refs'));
    const off = s.store.disable('wicked-garden-delta', edit.revision);
    expect(off.verdict).toBe('warnings');
    const refusal = off.findings.find((f) => f.kind === 'path-invalid');
    expect(refusal).toMatchObject({ severity: 'warning', skill: 'wicked-garden-beta', file: 'skills/beta/refs/notes.md' });
    expect(refusal?.evidence).toMatch(/crosses a symlink at refs/);
    expect(s.store.manifest().skills['wicked-garden-beta']?.portable).toBe(true);
    const dir = s.store.analyze();
    expect(dir.findings.find((f) => f.kind === 'fs-drift')?.evidence).toContain('skills/beta/refs/notes.md');
    expect(s.store.manifest().skills['wicked-garden-beta']?.portable).toBe(true);
  });
});

describe('incompatible file-map paths are refused BEFORE mutation; replace/add are staged (codex round 5)', () => {
  it("codex's map — a valid SKILL.md plus `x` AND `x/y` — is blocked for replace with the notes intact and the revision unchanged", () => {
    s.store.seed();
    const notes = join(s.root, 'effective', 'skills', 'alpha', 'refs', 'notes.md');
    const before = readFileSync(notes, 'utf8');
    const replaced = s.store.replace(
      'wicked-garden-alpha',
      { 'SKILL.md': '---\nname: wicked-garden-alpha\n---\n\nreplaced\n', x: 'a file\n', 'x/y': 'needs x as a directory\n' },
      1,
    );
    expect(replaced).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(replaced.findings.filter((f) => f.kind === 'path-invalid')).toHaveLength(1);
    expect(replaced.findings[0]).toMatchObject({ kind: 'path-invalid', skill: 'wicked-garden-alpha', file: 'x' });
    expect(replaced.findings[0]?.evidence).toBe('"x" is a file AND a directory prefix of "x/y"');
    expect(readFileSync(notes, 'utf8')).toBe(before);
    expect(readFileSync(join(s.root, 'effective', 'skills', 'alpha', 'SKILL.md'), 'utf8')).not.toContain('replaced');
    expect(existsSync(join(s.root, 'effective', 'skills', 'alpha', 'x'))).toBe(false);
    expect(s.store.revision()).toBe(1);
    // Deeper prefixes count too (`a/b` under `a/b/c`), whichever order the keys arrive in.
    const deep = s.store.replace('wicked-garden-alpha', { 'a/b/c': '1', 'SKILL.md': '---\nname: wicked-garden-alpha\n---\n', 'a/b': '2' }, 1);
    expect(deep.verdict).toBe('blocked');
    expect(deep.findings.find((f) => f.kind === 'path-invalid')).toMatchObject({ file: 'a/b' });
  });

  it('add has the same rule: `x` + `x/y` is blocked with no directory created and no manifest entry', () => {
    s.store.seed();
    const added = s.store.add('wicked-garden-zeta', { 'SKILL.md': '---\nname: wicked-garden-zeta\n---\n\nz\n', x: '1', 'x/y': '2' }, 1);
    expect(added).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(added.findings.find((f) => f.kind === 'path-invalid')).toMatchObject({ skill: 'wicked-garden-zeta', file: 'x' });
    expect(existsSync(join(s.root, 'effective', 'skills', 'zeta'))).toBe(false);
    expect(s.store.manifest().skills['wicked-garden-zeta']).toBeUndefined();
  });

  it('a key colliding with an existing entry OF THE OTHER KIND on disk is refused before mutation: a directory the swap cannot clear, a non-own file where a parent is needed', () => {
    s.store.seed();
    // `alpha/refs/` holds a nested skill? No — plant a symlink inside it so the directory survives the own-file removal.
    const alphaRefs = join(s.root, 'effective', 'skills', 'alpha', 'refs');
    symlinkSync(join(s.base, 'nowhere'), join(alphaRefs, 'dangling'));
    const before = readFileSync(join(alphaRefs, 'notes.md'), 'utf8');
    const asFile = s.store.replace('wicked-garden-alpha', { 'SKILL.md': '---\nname: wicked-garden-alpha\n---\n', refs: 'refs is a file now\n' }, 1);
    expect(asFile).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(asFile.findings[0]).toMatchObject({ kind: 'path-invalid', file: 'refs' });
    expect(asFile.findings[0]?.evidence).toContain('names an existing directory');
    expect(readFileSync(join(alphaRefs, 'notes.md'), 'utf8')).toBe(before);
    rmSync(join(alphaRefs, 'dangling'));
    // A directory made ONLY of own files (and empty dirs) IS clearable: `refs` as a file lands once notes.md is parked.
    const cleared = s.store.replace('wicked-garden-alpha', { 'SKILL.md': '---\nname: wicked-garden-alpha\n---\n', refs: 'refs is a file now\n' }, 1);
    expect(cleared.verdict).toBe('clear');
    expect(readFileSync(join(alphaRefs), 'utf8')).toBe('refs is a file now\n');
    expect(existsSync(join(s.root, 'effective', 'skills', 'alpha', 'nested', 'SKILL.md'))).toBe(true); // the nested child untouched
    // Now `refs` is an own regular FILE: a key needing it as a directory is fine for replace (the file is parked first)…
    const back = s.store.replace('wicked-garden-alpha', { 'SKILL.md': '---\nname: wicked-garden-alpha\n---\n', 'refs/notes.md': 'notes again\n' }, cleared.revision);
    expect(back.verdict).toBe('clear');
    expect(readFileSync(join(alphaRefs, 'notes.md'), 'utf8')).toBe('notes again\n');
    // …but a key needing a NON-own file as a directory — the nested child's SKILL.md — is refused before mutation.
    const throughChild = s.store.replace('wicked-garden-alpha', { 'SKILL.md': '---\nname: wicked-garden-alpha\n---\n', 'nested/SKILL.md/x.md': 'x' }, back.revision);
    expect(throughChild).toMatchObject({ verdict: 'blocked', revision: back.revision });
    expect(throughChild.findings[0]?.kind).toBe('path-invalid'); // the nested-ownership guard names it first; either way nothing moved
    expect(readFileSync(join(alphaRefs, 'notes.md'), 'utf8')).toBe('notes again\n');
  });
});

describe('snapshot verification sees SYMLINKS (codex round 5)', () => {
  const syncedProvisioner: VenvProvisioner = async (baselineDir) => {
    mkdirSync(join(baselineDir, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(baselineDir, '.venv', 'bin', 'python'), '#!/bin/sh\n');
    return 'synced';
  };

  it('the content hash covers link entries (path + link text): the permitted `.venv` link verifies, and is part of the recorded hash', async () => {
    const v = scaffold({ provisionVenv: syncedProvisioner });
    try {
      v.store.seed();
      const r = await v.store.publish(1);
      expect(r.verdict).toBe('clear');
      const snap = r.snapshot as NonNullable<typeof r.snapshot>;
      const hash = v.store.manifest().baseline;
      const tree = walkTree(snap.path);
      expect(tree.links).toEqual([{ rel: '.venv', abs: join(snap.path, '.venv'), target: join('..', '..', 'baseline', hash, '.venv') }]);
      const files = tree.files.filter((f) => f.rel !== 'snapshot.json');
      expect(snap.contentHash).toBe(hashTree(files, tree.links, tree.dirs)); // files, the link AND the directory entries (codex round 9)
      expect(snap.contentHash).not.toBe(hashFileSet(files)); // a hash that skipped the link would not be this one
      expect(snap.contentHash).not.toBe(hashTree(files, tree.links)); // …nor one that skipped the directories
      expect(storeOver(v).currentSnapshot()).toMatchObject({ gen: 1, path: snap.path });
    } finally {
      removeTreeForce(v.base);
    }
  });

  it('an injected outside-pointing link is REFUSED by the same store instance — hash mismatch first, unexpected-link by name when the hash is forged', async () => {
    const v = scaffold({ provisionVenv: syncedProvisioner });
    try {
      v.store.seed();
      const r = await v.store.publish(1);
      const snap = r.snapshot as NonNullable<typeof r.snapshot>;
      chmodSync(snap.path, 0o755);
      symlinkSync(join(v.base, 'outside'), join(snap.path, 'evil'));
      expect(() => v.store.currentSnapshot()).toThrow(SkillsCurrentInvalidError);
      expect(() => v.store.currentSnapshot()).toThrow(/content hash mismatch/);
      // Forge the hash to cover the link: the link itself is then refused by name.
      const tree = walkTree(snap.path);
      const forged = snapshotManifest(snap.path);
      forged.contentHash = hashTree(tree.files.filter((f) => f.rel !== 'snapshot.json'), tree.links, tree.dirs);
      unlock(join(snap.path, 'snapshot.json'));
      writeFileSync(join(snap.path, 'snapshot.json'), `${JSON.stringify(forged, null, 2)}\n`);
      expect(() => v.store.currentSnapshot()).toThrow(/not the metadata this root published/); // the manifest authenticates the metadata (codex round 7)
      stampPublished(v.root, join(snap.path, 'snapshot.json')); // …and with the manifest forged too, the link is refused by name
      expect(() => v.store.currentSnapshot()).toThrow(/unexpected symlink evil -> /);
      rmSync(join(snap.path, 'evil'));
    } finally {
      removeTreeForce(v.base);
    }
  });

  it('the `.venv` link must be EXACTLY the baseline env link: re-pointed outside → refused; present while snapshot.json says skipped → refused; absent while it says synced → refused', async () => {
    const v = scaffold({ provisionVenv: syncedProvisioner });
    try {
      v.store.seed();
      const r = await v.store.publish(1);
      const snap = r.snapshot as NonNullable<typeof r.snapshot>;
      const forgeHash = (): void => {
        const tree = walkTree(snap.path);
        const forged = snapshotManifest(snap.path);
        forged.contentHash = hashTree(tree.files.filter((f) => f.rel !== 'snapshot.json'), tree.links, tree.dirs);
        unlock(join(snap.path, 'snapshot.json'));
        writeFileSync(join(snap.path, 'snapshot.json'), `${JSON.stringify(forged, null, 2)}\n`);
        stampPublished(v.root, join(snap.path, 'snapshot.json')); // the attacker-with-manifest model: the deeper link checks stay defense in depth
      };
      chmodSync(snap.path, 0o755);
      // Re-pointed at an outside env (the hash forged to match): refused for its link text.
      const outsideVenv = join(v.base, 'outside-venv');
      mkdirSync(outsideVenv);
      rmSync(join(snap.path, '.venv'));
      symlinkSync(outsideVenv, join(snap.path, '.venv'));
      forgeHash();
      expect(() => v.store.currentSnapshot()).toThrow(/\.venv -> .* is not the baseline env link publish wrote/);
      // Restored to the exact text publish wrote (it resolves to this root's baseline env): verifies again.
      const hash = v.store.manifest().baseline;
      rmSync(join(snap.path, '.venv'));
      symlinkSync(join('..', '..', 'baseline', hash, '.venv'), join(snap.path, '.venv'));
      forgeHash();
      expect(v.store.currentSnapshot()?.gen).toBe(1);
      // Absent while synced: refused.
      rmSync(join(snap.path, '.venv'));
      forgeHash();
      expect(() => v.store.currentSnapshot()).toThrow(/records the baseline env as synced but the generation has no \.venv link/);
    } finally {
      removeTreeForce(v.base);
    }
  });

  it('a snapshot published WITHOUT an env (skipped) refuses an injected `.venv` link even when it points at a real baseline env', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const snap = r.snapshot as NonNullable<typeof r.snapshot>;
    const hash = s.store.manifest().baseline;
    mkdirSync(join(s.root, 'baseline', hash, '.venv'), { recursive: true });
    chmodSync(snap.path, 0o755);
    symlinkSync(join('..', '..', 'baseline', hash, '.venv'), join(snap.path, '.venv'));
    expect(() => s.store.currentSnapshot()).toThrow(/content hash mismatch/);
    const tree = walkTree(snap.path);
    const forged = snapshotManifest(snap.path);
    forged.contentHash = hashTree(tree.files.filter((f) => f.rel !== 'snapshot.json'), tree.links, tree.dirs);
    unlock(join(snap.path, 'snapshot.json'));
    writeFileSync(join(snap.path, 'snapshot.json'), `${JSON.stringify(forged, null, 2)}\n`);
    stampPublished(s.root, join(snap.path, 'snapshot.json'));
    expect(() => s.store.currentSnapshot()).toThrow(/is present although snapshot\.json records the env as skipped/);
  });

  it('the recorded baseline never authorizes the link as free text (codex round 6): a traversal string and an unknown 64-hex hash are refused although the hash verifies; a `baseline/<hash>/.venv` replaced by a link is refused by the walk, never resolved; the legitimate link verifies', async () => {
    const v = scaffold({ provisionVenv: syncedProvisioner });
    try {
      v.store.seed();
      const r = await v.store.publish(1);
      expect(r.verdict).toBe('clear');
      const snap = r.snapshot as NonNullable<typeof r.snapshot>;
      const hash = v.store.manifest().baseline;
      const pristine = snapshotManifest(snap.path);
      const metadata = join(snap.path, 'snapshot.json');
      unlock(metadata);
      const withBaseline = (baseline: string): void => {
        writeFileSync(metadata, `${JSON.stringify({ ...pristine, gardenSource: { ...pristine.gardenSource, baseline } }, null, 2)}\n`);
        stampPublished(v.root, metadata); // the attacker-with-manifest model (codex round 7): the checks below stay defense in depth
      };
      // snapshot.json is not part of the content hash, so these edits alone would have verified under
      // the old code, which JOINED the baseline string straight into the expected link target.
      withBaseline('../../../outside');
      expect(() => v.store.currentSnapshot()).toThrow(SkillsCurrentInvalidError);
      expect(() => v.store.currentSnapshot()).toThrow(/gardenSource\.baseline that is a sha256 content hash/);
      withBaseline('a'.repeat(64)); // well-formed, but no baseline THIS root's manifest.json ever captured
      expect(() => v.store.currentSnapshot()).toThrow(/which manifest\.json does not know/);
      writeFileSync(metadata, `${JSON.stringify({ ...pristine, venv: 'sync' }, null, 2)}\n`); // an enum outside the four states
      expect(() => v.store.currentSnapshot()).toThrow(/has no venv state/);
      withBaseline(hash);
      expect(v.store.currentSnapshot()?.gen).toBe(1); // the legitimate link verifies
      // The env ITSELF replaced by a link to an outside dir — link text, hash and manifest untouched:
      // the lstat walk from the root refuses the crossing at `.venv`; nothing is resolved through it.
      const envDir = join(v.root, 'baseline', hash, '.venv');
      const outside = join(v.base, 'outside-env');
      mkdirSync(join(outside, 'bin'), { recursive: true });
      removeTreeForce(envDir);
      symlinkSync(outside, envDir);
      expect(() => v.store.currentSnapshot()).toThrow(/not reachable without following a link/);
      expect(readdirSync(outside)).toEqual(['bin']); // nothing read or written through it
    } finally {
      removeTreeForce(v.base);
    }
  });
});

describe('skill-scoped containment (design v3 §API) — no-follow from the ROOT', () => {
  beforeEach(() => {
    s.store.seed();
  });

  it.each([
    ['../gamma/SKILL.md', 'invalid'],
    ['/etc/passwd', 'invalid'],
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

  it('never URL-decodes a path itself (codex round 5): Fastify decodes the wildcard ONCE before the store sees it, so a literal `%2e%2e` or `%2F` here is a filename, not an escape', () => {
    // At the route, `%2e%2e%2Fgamma/SKILL.md` arrives as `../gamma/SKILL.md` and is refused (tests/skills-routes.test.ts);
    // a store fed the literal spelling (as a client sending `%252e%252e` would produce) addresses a file of that odd name.
    expect(s.store.resolveSkillFile('wicked-garden-alpha', '%2e%2e/gamma/SKILL.md').rel).toBe('%2e%2e/gamma/SKILL.md');
    expect(s.store.resolveSkillFile('wicked-garden-alpha', 'a%2Fb.txt').rel).toBe('a%2Fb.txt');
    expect(s.store.resolveSkillFile('wicked-garden-alpha', '100%.txt').rel).toBe('100%.txt');
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

  it('is ATOMIC against a refused destination: an upstream plugin-version change AHEAD of an upstream-added file whose effective parent is a symlink → 2xx blocked path-invalid with NOTHING changed (codex round 4)', () => {
    s.store.seed();
    const before = JSON.stringify(s.store.manifest());
    const pluginJson = join(s.root, 'effective', '.claude-plugin', 'plugin.json');
    const pluginJsonBefore = readFileSync(pluginJson, 'utf8');
    const baselinesBefore = s.store.baselinesOnDisk();
    // Upstream: bump the plugin version (`.claude-plugin/…` sorts BEFORE `skills/…` — the old code
    // copied it first) and add a file under gamma/refs.
    upstreamWrite('.claude-plugin/plugin.json', '{"name": "wicked-garden", "version": "1.1.0"}\n');
    upstreamWrite('skills/gamma/refs/new.md', 'new upstream file\n');
    // Effective: `skills/gamma/refs` is a symlink to outside — the added file's destination crosses it.
    const outside = join(s.base, 'outside-refs');
    mkdirSync(outside);
    symlinkSync(outside, join(s.root, 'effective', 'skills', 'gamma', 'refs'));
    const r = s.store.refreshBaseline(1);
    expect(r).toMatchObject({ verdict: 'blocked', revision: 1, taken: [], kept: [], added: [], removed: [], conflicts: [] });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'path-invalid', severity: 'blocking', skill: 'wicked-garden-gamma', file: 'skills/gamma/refs/new.md' });
    expect(r.findings[0]?.evidence).toMatch(/crosses a symlink at refs/);
    // NOTHING changed: the file ahead of the refusal was not copied, nothing landed through the
    // link, the manifest is byte-identical, no baseline was captured, no staging lingers.
    expect(readFileSync(pluginJson, 'utf8')).toBe(pluginJsonBefore);
    expect(readdirSync(outside)).toEqual([]);
    expect(JSON.stringify(s.store.manifest())).toBe(before);
    expect(s.store.revision()).toBe(1);
    expect(s.store.baselinesOnDisk()).toEqual(baselinesBefore);
    expect(readdirSync(s.root).filter((e) => e.startsWith('.staging-'))).toEqual([]);
    // With the destination fixed, the SAME refresh lands whole.
    rmSync(join(s.root, 'effective', 'skills', 'gamma', 'refs'));
    const ok = s.store.refreshBaseline(1);
    expect(ok.verdict).toBe('clear');
    expect(ok.revision).toBe(2);
    expect(readFileSync(pluginJson, 'utf8')).toContain('1.1.0');
    expect(readFileSync(join(s.root, 'effective', 'skills', 'gamma', 'refs', 'new.md'), 'utf8')).toBe('new upstream file\n');
    expect(ok.taken).toEqual(['wicked-garden-gamma']);
    expect(s.store.baselinesOnDisk()).toEqual([ok.baseline]);
  });
});

describe('design v3.4 §1 — the live 12.32.0 shapes publish with WARNINGS; an escape still BLOCKS', () => {
  it('a `${CLAUDE_PLUGIN_ROOT}` path to a file that does not exist, a `../` link resolving inside the root to nothing, and a prose `../` into a sibling checkout are three warnings — snapshot written, current flipped; `${CLAUDE_PLUGIN_ROOT}/../x` blocks', async () => {
    // The three shapes the integrated functional test found in wicked-garden 12.32.0 (18 findings in
    // 7 skills; wicked-garden#1111 tracks the content fixes), planted in a beta refs file BEFORE the seed.
    mkdirSync(join(s.upstream, 'skills', 'beta', 'refs'), { recursive: true });
    writeFileSync(
      join(s.upstream, 'skills', 'beta', 'refs', 'live-shapes.md'),
      [
        'sh "${CLAUDE_PLUGIN_ROOT}/scripts/_python.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/some/script.py"', // runtime-exec/SKILL.md:24 — the first resolves, the second names nothing
        'Formal JSON Schema: [`schemas/evidence.json`](../schemas/evidence.json)', // qe/refs/evidence.md:35 → skills/beta/schemas/… (inside the root, absent)
        '   as the sibling checkout `../wicked-core/crates/wicked-governance/schemas`, or', // domain/vendor/README.md:41 → skills/beta/wicked-core/… (inside the root, absent)
        '',
      ].join('\n'),
    );
    s.store.seed();
    const r = await s.store.publish(1);
    expect(r.verdict).toBe('warnings');
    expect(r.snapshot?.gen).toBe(1);
    expect(s.store.currentSnapshot()?.gen).toBe(1);
    const refs = r.findings.filter((f) => f.kind === 'unresolved-ref');
    expect(refs.map((f) => [f.severity, f.file, f.line])).toEqual([
      ['warning', 'skills/beta/refs/live-shapes.md', 1],
      ['warning', 'skills/beta/refs/live-shapes.md', 2],
      ['warning', 'skills/beta/refs/live-shapes.md', 3],
    ]);
    expect(refs[0]?.evidence).toContain('scripts/some/script.py — no such file in effective/');
    expect(refs[1]?.evidence).toContain('../schemas/evidence.json');
    expect(refs[2]?.evidence).toContain('../wicked-core/crates/wicked-governance/schemas');
    expect(r.findings.some((f) => f.severity === 'blocking')).toBe(false);
    expect(r.findings.length).toBeGreaterThan(0); // the wire's `warnings` verdict: a non-empty findings[] AND a snapshot
    expect(existsSync(join(r.snapshot?.path ?? '', 'skills', 'beta', 'refs', 'live-shapes.md'))).toBe(true);
    // An ESCAPE is still a boundary claim — blocking, nothing written, the revision unchanged.
    const w = s.store.writeFile('wicked-garden-beta', 'refs/escape.md', 'see `${CLAUDE_PLUGIN_ROOT}/../x`\n', r.revision);
    const blocked = await s.store.publish(w.revision);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.snapshot).toBeNull();
    const escape = blocked.findings.find((f) => f.kind === 'unresolved-ref' && f.severity === 'blocking');
    expect(escape).toMatchObject({ file: 'skills/beta/refs/escape.md', line: 1 });
    expect(escape?.evidence).toContain('escapes the plugin root');
    expect(blocked.findings.filter((f) => f.kind === 'unresolved-ref' && f.severity === 'warning')).toHaveLength(3); // the warnings are still reported beside it
    expect(s.store.generationsOnDisk()).toEqual([1]);
    expect(s.store.revision()).toBe(w.revision);
  });
});

describe('metadata is read NO-FOLLOW (codex round 6)', () => {
  it('a `manifest.json` replaced by a symlink to a copy is refused by name — nothing is read or committed through it, and the seed does not wipe around it', () => {
    s.store.seed();
    const copy = join(s.base, 'manifest-copy.json');
    cpSync(join(s.root, 'manifest.json'), copy);
    rmSync(join(s.root, 'manifest.json'));
    symlinkSync(copy, join(s.root, 'manifest.json'));
    expect(s.store.isSeeded()).toBe(true); // a link counts as "seeded": the seed never wipes effective/ around it
    expect(() => s.store.manifest()).toThrow(SkillsManifestCorruptError);
    expect(() => s.store.manifest()).toThrow(/manifest\.json is a symlink/);
    expect(() => s.store.listFiles('wicked-garden-alpha')).toThrow(SkillsManifestCorruptError);
    expect(() => s.store.disable('wicked-garden-alpha', 1)).toThrow(SkillsManifestCorruptError);
    expect(s.store.seed().seeded).toBe(false);
    expect(existsSync(join(s.root, 'effective', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(readFileSync(copy, 'utf8')).toContain('"revision": 1'); // the copy is untouched: no commit went through the link
  });

  it('a `snapshot.json` replaced by a symlink to a valid copy is refused by name — `current` never reads snapshot metadata through a link', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const gen = (r.snapshot as NonNullable<typeof r.snapshot>).path;
    const metadata = join(gen, 'snapshot.json');
    const copy = join(s.base, 'snapshot-copy.json');
    cpSync(metadata, copy);
    unlock(metadata);
    rmSync(metadata);
    symlinkSync(copy, metadata);
    expect(() => s.store.currentSnapshot()).toThrow(SkillsCurrentInvalidError);
    expect(() => s.store.currentSnapshot()).toThrow(/snapshot\.json in .* is a symlink/);
    await expect(storeOver(s).ensureReady()).rejects.toThrow(/is a symlink/);
  });
});

describe('the plugin SOURCE is ingested no-follow below its root (codex round 6)', () => {
  it('a symlinked plugin.json, a symlinked catalog, or a symlinked skills/<x> dir refuses the SEED by name — nothing is created under the root', () => {
    const outside = join(s.base, 'outside-src');
    mkdirSync(join(outside, 'skill'), { recursive: true });
    writeFileSync(join(outside, 'plugin.json'), '{"name": "wicked-garden", "version": "9.9.9"}\n');
    writeFileSync(join(outside, 'archetypes.json'), '{"archetypes": {}}\n');
    writeFileSync(join(outside, 'skill', 'SKILL.md'), '---\nname: wicked-garden-gamma\n---\n\noutside\n');
    for (const [rel, target] of [
      ['.claude-plugin/plugin.json', join(outside, 'plugin.json')],
      ['.claude-plugin/archetypes.json', join(outside, 'archetypes.json')],
      ['skills/gamma', join(outside, 'skill')],
    ] as const) {
      const fresh = scaffold();
      try {
        const p = join(fresh.upstream, ...rel.split('/'));
        rmSync(p, { recursive: true, force: true });
        symlinkSync(target, p);
        expect(() => fresh.store.seed(), rel).toThrow(PluginSourceSymlinkError);
        expect(() => fresh.store.seed(), rel).toThrow(new RegExp(`${rel.replace(/[./]/g, '\\$&')} is a symlink`));
        expect(existsSync(fresh.root), rel).toBe(false); // refused BEFORE the root is created: nothing copied
      } finally {
        removeScratch(fresh.base);
      }
    }
  });

  it('a symlinked source ROOT with a clean tree is accepted (operators symlink their config dir): the root is resolved once, its contents walked no-follow, the same bundle identity', () => {
    const link = join(s.base, 'upstream-link');
    symlinkSync(s.upstream, link);
    const viaLink = new SkillsStore({
      root: s.root,
      registeredSkillRefs: () => REGISTERED_REFS,
      provisionVenv: noVenv,
      source: () => pluginSourceAt(link),
      now: () => CLOCK,
      warn: () => undefined,
    });
    const seeded = viaLink.seed();
    expect(seeded.seeded).toBe(true);
    expect(seeded.source?.path).toBe(link); // recorded as the operator spelled it
    expect(rels(join(s.root, 'effective'))).toEqual(pluginBundleFiles(s.upstream).map((f) => f.rel));
    expect(seeded.baseline).toBe(hashFileSet(pluginBundleFiles(s.upstream))); // through the link or not: the same bundle, the same identity
  });

  it('a REFRESH over a source that grew a symlinked entry is the 2xx blocked path-invalid envelope naming the entry — nothing copied, no baseline captured, the revision unchanged', () => {
    s.store.seed();
    const before = JSON.stringify(s.store.manifest());
    const baselines = s.store.baselinesOnDisk();
    const outside = join(s.base, 'outside-refs');
    mkdirSync(outside);
    writeFileSync(join(outside, 'evil.md'), 'outside bytes\n');
    mkdirSync(join(s.upstream, 'skills', 'gamma', 'refs'), { recursive: true });
    symlinkSync(outside, join(s.upstream, 'skills', 'gamma', 'refs', 'linked'));
    const r = s.store.refreshBaseline(1);
    expect(r).toMatchObject({ verdict: 'blocked', revision: 1, taken: [], added: [], removed: [], conflicts: [] });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'path-invalid', severity: 'blocking', file: 'skills/gamma/refs/linked' });
    expect(r.findings[0]?.evidence).toContain('skills/gamma/refs/linked is a symlink');
    expect(JSON.stringify(s.store.manifest())).toBe(before);
    expect(s.store.baselinesOnDisk()).toEqual(baselines);
    expect(existsSync(join(s.root, 'effective', 'skills', 'gamma', 'refs'))).toBe(false);
    expect(rels(join(s.root, 'effective')).some((rel) => rel.includes('evil'))).toBe(false);
  });
});

describe('the bundle closure is the ONE allowlist (codex round 6)', () => {
  it('a support add/PUT outside the closure is a blocked `outside-closure` envelope (nothing written); inside it lands', () => {
    s.store.seed();
    for (const rel of ['hooks/hooks.json', 'tests/x.py', 'docs/other.md', 'scripts/ci/release.sh', 'scripts/wg/tool.py', 'site/index.html', 'README.md', '.claude-plugin/marketplace.json', '.claude-plugin/extra.json']) {
      const r = s.store.writeSupport(rel, 'x\n', 1);
      expect(r, rel).toMatchObject({ verdict: 'blocked', revision: 1 });
      expect(r.findings, rel).toHaveLength(1);
      expect(r.findings[0], rel).toMatchObject({ kind: 'outside-closure', severity: 'blocking', file: rel });
      expect(existsSync(join(s.root, 'effective', ...rel.split('/'))), rel).toBe(false);
      expect(() => s.store.resolveSupportFile(rel), rel).toThrow(SkillPathError);
    }
    expect(s.store.revision()).toBe(1);
    const ok = s.store.writeSupport('docs/examples/new.yml', 'a: 1\n', 1);
    expect(ok.verdict).toBe('warnings'); // the usual support-file-edit warning, nothing more
    expect(ok.findings.map((f) => f.kind)).toEqual(['support-file-edit']);
    // The `.claude-plugin` half is an allowlist BY NAME (codex round 7): the five runtime catalogs land, nothing else.
    expect(s.store.writeSupport('.claude-plugin/specialist.json', '{}\n', ok.revision).verdict).toBe('warnings');
    expect(s.store.writeSupport('.claude-plugin/stack-registry.json', '{}\n', ok.revision + 1).verdict).toBe('warnings');
    expect(s.store.writeSupport('uv.lock', 'version = 1\n', ok.revision + 2).verdict).toBe('warnings');
  });

  it('a file found under effective/ outside the closure (a direct filesystem edit) BLOCKS publish and analyze by path — hooks/x and tests/x — and a snapshot never ships it', async () => {
    s.store.seed();
    mkdirSync(join(s.root, 'effective', 'hooks'));
    writeFileSync(join(s.root, 'effective', 'hooks', 'hooks.json'), '{}\n');
    mkdirSync(join(s.root, 'effective', 'tests'));
    writeFileSync(join(s.root, 'effective', 'tests', 'x.py'), 'print(1)\n');
    const analyzed = s.store.analyze();
    expect(analyzed.verdict).toBe('blocked');
    const outside = analyzed.findings.filter((f) => f.kind === 'outside-closure');
    expect(outside.map((f) => [f.severity, f.file])).toEqual([
      ['blocking', 'hooks/hooks.json'],
      ['blocking', 'tests/x.py'],
    ]);
    expect(analyzed.findings.find((f) => f.kind === 'fs-drift')?.evidence).toContain('hooks/hooks.json'); // reported as drift too
    const blocked = await s.store.publish(1);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.snapshot).toBeNull();
    expect(s.store.revision()).toBe(1);
    // Removed: the same catalog publishes clear, and the generation carries neither path.
    rmSync(join(s.root, 'effective', 'hooks'), { recursive: true });
    rmSync(join(s.root, 'effective', 'tests'), { recursive: true });
    const ok = await s.store.publish(1);
    expect(ok.verdict).toBe('clear');
    expect(rels(ok.snapshot?.path ?? '').some((rel) => rel.startsWith('hooks/') || rel.startsWith('tests/'))).toBe(false);
  });

  it('inBundleClosure IS the seed closure as a predicate: every seeded file is a member, the excluded fixture paths are not', () => {
    const seeded = pluginBundleFiles(s.upstream).map((f) => f.rel);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every(inBundleClosure)).toBe(true);
    for (const rel of ['hooks/hooks.json', 'docs/other.md', 'scripts/ci/release.sh', 'scripts/wg/tool.py', 'scripts/wg-dev/x.py', 'tests/x', 'README.md', '.claude-plugin/nested/x.json', '.claude-plugin/marketplace.json', '.claude-plugin/extra.json', 'snapshot.json', 'manifest.json']) {
      expect(inBundleClosure(rel), rel).toBe(false);
    }
    // The five `.claude-plugin` runtime catalogs BY NAME (codex round 7, the live 12.32.0 layout), the trees, the root files.
    for (const rel of ['.claude-plugin/plugin.json', '.claude-plugin/archetypes.json', '.claude-plugin/components.json', '.claude-plugin/specialist.json', '.claude-plugin/stack-registry.json', 'skills/x/SKILL.md', 'scripts/_python.sh', 'scripts/wgx/y.py', 'schemas/evidence.json', 'docs/examples/campaign.yml', 'pyproject.toml', 'uv.lock']) {
      expect(inBundleClosure(rel), rel).toBe(true);
    }
  });
});

describe('baselines are content-addressed: verified before EVERY reuse, locked read-only (codex round 7)', () => {
  it('after the seed every bundle FILE is read-only (directories stay writable: .venv lands in the top dir) — mode bits are a guard, the hash is the boundary; the operator\'s effective copies stay writable', () => {
    s.store.seed();
    const hash = s.store.manifest().baseline;
    const dir = join(s.root, 'baseline', hash);
    const files = walkFiles(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(lstatSync(f.abs).mode & 0o222, f.rel).toBe(0);
    expect(lstatSync(dir).mode & 0o200).not.toBe(0);
    expect(lstatSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md')).mode & 0o200).not.toBe(0);
  });

  it('a MODIFIED baseline file: reset is blocked `baseline-corrupt` naming the file (nothing written); analyze and publish are blocked naming the dir; restored, everything is clear and the reset copy is owner-writable again', async () => {
    s.store.seed();
    const hash = s.store.manifest().baseline;
    const file = join(s.root, 'baseline', hash, 'skills', 'gamma', 'SKILL.md');
    const effectiveFile = join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md');
    const original = readFileSync(file, 'utf8');
    const effectiveBefore = readFileSync(effectiveFile, 'utf8');
    chmodSync(file, 0o644); // the lock is a guard against accidents — defeating it must not defeat the verification
    writeFileSync(file, `${original}tampered\n`);
    const reset = s.store.reset('wicked-garden-gamma', 1);
    expect(reset).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(reset.findings[0]).toMatchObject({ kind: 'baseline-corrupt', severity: 'blocking', skill: 'wicked-garden-gamma', file: 'skills/gamma/SKILL.md' });
    expect(reset.findings[0]?.evidence).toContain('modified');
    expect(readFileSync(effectiveFile, 'utf8')).toBe(effectiveBefore);
    const analyzed = s.store.analyze();
    expect(analyzed.verdict).toBe('blocked');
    expect(analyzed.findings.find((f) => f.kind === 'baseline-corrupt')).toMatchObject({ file: `baseline/${hash}` });
    expect(analyzed.findings.find((f) => f.kind === 'baseline-corrupt')?.evidence).toContain('hashes to');
    const published = await s.store.publish(1);
    expect(published.verdict).toBe('blocked');
    expect(published.snapshot).toBeNull();
    expect(published.findings[0]?.kind).toBe('baseline-corrupt');
    expect(existsSync(join(s.root, 'snapshots'))).toBe(false);
    expect(s.store.revision()).toBe(1);
    writeFileSync(file, original);
    expect(s.store.analyze().verdict).toBe('clear');
    expect(s.store.reset('wicked-garden-gamma', 1).verdict).toBe('clear');
    expect(lstatSync(effectiveFile).mode & 0o200).not.toBe(0);
    expect(readFileSync(effectiveFile, 'utf8')).toBe(original);
  });

  it('a PLANTED baseline file and a REMOVED one block reset by name; a pre-planted baseline/<hash> with wrong content is re-captured by the SEED and refused by a REFRESH (nothing changed)', () => {
    // Pre-planted before the seed: wrong content under the right name — the seed owns the root's first state and re-captures.
    const hash = hashFileSet(pluginBundleFiles(s.upstream));
    mkdirSync(join(s.root, 'baseline', hash), { recursive: true });
    writeFileSync(join(s.root, 'baseline', hash, 'junk.txt'), 'planted before the seed\n');
    expect(s.store.seed().seeded).toBe(true);
    expect(s.warnings.some((w) => w.includes('re-captured from the source'))).toBe(true);
    expect(existsSync(join(s.root, 'baseline', hash, 'junk.txt'))).toBe(false);
    expect(s.store.analyze().verdict).toBe('clear');
    // Planted after the seed (the top dir is writable for .venv; a subdir is unlocked here on purpose): reset names it.
    const gammaDir = join(s.root, 'baseline', hash, 'skills', 'gamma');
    chmodSync(gammaDir, 0o755);
    const planted = join(gammaDir, 'planted.md');
    writeFileSync(planted, 'planted\n');
    const r1 = s.store.reset('wicked-garden-gamma', 1);
    expect(r1).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(r1.findings[0]).toMatchObject({ kind: 'baseline-corrupt', skill: 'wicked-garden-gamma', file: 'skills/gamma/planted.md' });
    expect(r1.findings[0]?.evidence).toContain('planted');
    rmSync(planted);
    // Removed: reset names the record the baseline no longer backs.
    const removedFile = join(gammaDir, 'SKILL.md');
    const bytes = readFileSync(removedFile);
    rmSync(removedFile);
    const r2 = s.store.reset('wicked-garden-gamma', 1);
    expect(r2).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(r2.findings[0]).toMatchObject({ kind: 'baseline-corrupt', file: 'skills/gamma/SKILL.md' });
    expect(r2.findings[0]?.evidence).toContain('removed');
    writeFileSync(removedFile, bytes);
    expect(s.store.analyze().verdict).toBe('clear');
    // A REFRESH never reuses a pre-planted dir under the NEW hash: blocked `baseline-corrupt`, nothing changed.
    writeFileSync(join(s.upstream, 'skills', 'gamma', 'SKILL.md'), '---\nname: wicked-garden-gamma\n---\n\ngamma v2\n');
    const newHash = hashFileSet(pluginBundleFiles(s.upstream));
    mkdirSync(join(s.root, 'baseline', newHash), { recursive: true });
    writeFileSync(join(s.root, 'baseline', newHash, 'junk.txt'), 'planted before the refresh\n');
    const before = JSON.stringify(s.store.manifest());
    const ref = s.store.refreshBaseline(1);
    expect(ref).toMatchObject({ verdict: 'blocked', revision: 1, taken: [], added: [], removed: [] });
    expect(ref.findings[0]).toMatchObject({ kind: 'baseline-corrupt', file: `baseline/${newHash}` });
    expect(ref.findings[0]?.evidence).toContain('hashes to');
    expect(JSON.stringify(s.store.manifest())).toBe(before);
    expect(readFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), 'utf8')).not.toContain('gamma v2');
  });

  it('a provisioner that writes OUTSIDE .venv corrupts the baseline: publish is blocked `baseline-corrupt` after provisioning, no snapshot, nothing persisted', async () => {
    const v = scaffold({
      provisionVenv: async (baselineDir) => {
        mkdirSync(join(baselineDir, '.venv', 'bin'), { recursive: true });
        writeFileSync(join(baselineDir, '.venv', 'bin', 'python'), '#!/bin/sh\n');
        writeFileSync(join(baselineDir, 'stray.lock'), 'written beside the bundle\n'); // the top dir is writable for .venv — nothing else may land there
        return 'synced';
      },
    });
    try {
      v.store.seed();
      const r = await v.store.publish(1);
      expect(r.verdict).toBe('blocked');
      expect(r.snapshot).toBeNull();
      expect(r.findings.find((f) => f.kind === 'baseline-corrupt')?.evidence).toContain('hashes to');
      expect(v.store.revision()).toBe(1);
      expect(existsSync(join(v.root, 'snapshots'))).toBe(false);
    } finally {
      removeTreeForce(v.base);
    }
  });
});

describe('manifest.json is validated by a COMPLETE fail-closed schema (codex round 7)', () => {
  interface LooseManifest {
    revision: unknown;
    baseline: unknown;
    baselines: Record<string, Record<string, unknown>>;
    skills: Record<string, Record<string, unknown>>;
    files: Record<string, Record<string, unknown>>;
    published: unknown;
    [key: string]: unknown;
  }
  const rewrite = (mutate: (m: LooseManifest) => void): void => {
    const path = join(s.root, 'manifest.json');
    const m = JSON.parse(readFileSync(path, 'utf8')) as LooseManifest;
    mutate(m);
    writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  };

  it('`"enabled": "false"` (a string where a boolean belongs) REFUSES to load — manifest-invalid, skills.config at boot — and is never published', async () => {
    const savedEnv = process.env['WICKED_SKILLS_SNAPSHOT'];
    try {
      s.store.seed();
      const pristine = readFileSync(join(s.root, 'manifest.json'), 'utf8');
      rewrite((m) => {
        (m.skills['wicked-garden-alpha'] as Record<string, unknown>)['enabled'] = 'false';
      });
      expect(() => s.store.manifest()).toThrow(SkillsManifestCorruptError);
      expect(() => s.store.manifest()).toThrow(/manifest-invalid: skills\[wicked-garden-alpha\]\.enabled is "false", not a boolean/);
      await expect(s.store.publish(1)).rejects.toThrow(/manifest-invalid/);
      await expect(storeOver(s).ensureReady()).rejects.toThrow(/manifest-invalid/);
      const health = await new SkillsRuntime({ store: storeOver(s), log: () => undefined }).apply();
      expect(health.state).toBe('config-error');
      expect(health.findings[0]).toMatchObject({ kind: 'skills.config', severity: 'error' });
      expect(health.findings[0]?.message).toContain('manifest-invalid');
      expect(existsSync(join(s.root, 'snapshots'))).toBe(false); // nothing published — as enabled OR as disabled
      writeFileSync(join(s.root, 'manifest.json'), pristine);
      expect(s.store.manifest().skills['wicked-garden-alpha']?.enabled).toBe(true);
    } finally {
      if (savedEnv === undefined) delete process.env['WICKED_SKILLS_SNAPSHOT'];
      else process.env['WICKED_SKILLS_SNAPSHOT'] = savedEnv;
    }
  });

  it('every malformed field is refused by name — never a truthiness fallback: revision, hashes, enums, missing and unknown keys, the published record', () => {
    s.store.seed();
    const pristine = readFileSync(join(s.root, 'manifest.json'), 'utf8');
    const hash = s.store.manifest().baseline;
    const cases: Array<[string, (m: LooseManifest) => void, RegExp]> = [
      ['revision -1', (m) => { m.revision = -1; }, /revision is -1, not an integer/],
      ['revision 1.5', (m) => { m.revision = 1.5; }, /revision is 1\.5, not an integer/],
      ['baseline not a hash', (m) => { m.baseline = 'zz'; }, /baseline is "zz", not a sha256 content hash/],
      ['file record hash', (m) => { (m.files['skills/gamma/SKILL.md'] as Record<string, unknown>)['effectiveHash'] = 'nothex'; }, /files\[skills\/gamma\/SKILL\.md\]\.effectiveHash is "nothex"/],
      ['unknown top-level key', (m) => { m['mirror'] = {}; }, /the manifest carries an unknown key "mirror"/],
      ['skill kind', (m) => { (m.skills['wicked-garden-gamma'] as Record<string, unknown>)['kind'] = 'weird'; }, /kind is "weird", not one of router\|fork-worker\|module/],
      ['skill core as a string', (m) => { (m.skills['wicked-garden-gamma'] as Record<string, unknown>)['core'] = 'true'; }, /core is "true", not a boolean/],
      ['provenance', (m) => { (m.skills['wicked-garden-gamma'] as Record<string, unknown>)['provenance'] = 'vendored'; }, /provenance is "vendored", not one of/],
      ['baseline venv', (m) => { (m.baselines[hash] as Record<string, unknown>)['venv'] = 'sync'; }, /venv is "sync", not one of/],
      ['missing skill key', (m) => { delete (m.skills['wicked-garden-gamma'] as Record<string, unknown>)['portable']; }, /skills\[wicked-garden-gamma\] lacks "portable"/],
      ['published without snapshotHash', (m) => { m.published = { gen: 1, contentHash: hash, at: 'now' }; }, /published lacks "snapshotHash"/],
      ['published gen 0', (m) => { m.published = { gen: 0, contentHash: hash, at: 'now', snapshotHash: hash }; }, /published\.gen is 0, not an integer/],
      ['baseline without its record', (m) => { delete m.baselines[hash]; }, /has no record under baselines/],
    ];
    for (const [label, mutate, re] of cases) {
      writeFileSync(join(s.root, 'manifest.json'), pristine);
      rewrite(mutate);
      expect(() => s.store.manifest(), label).toThrow(SkillsManifestCorruptError);
      expect(() => s.store.manifest(), label).toThrow(re);
    }
    writeFileSync(join(s.root, 'manifest.json'), pristine);
    expect(s.store.revision()).toBe(1);
  });
});

describe('a directly registered reference stays core when its content is unreadable (design v3.5 §5, codex round 8)', () => {
  it("delete the core skill's SKILL.md ⇒ core stays true, disable is blocked core-disable, publish reports it; replace its dir with a symlink ⇒ disable is blocked too (core-disable + the path-invalid warning)", async () => {
    s.store.seed();
    expect(s.store.manifest().skills['wicked-garden-beta']?.core).toBe(true); // the ONE registered skill_ref
    rmSync(join(s.root, 'effective', 'skills', 'beta', 'SKILL.md'));
    const off = s.store.disable('wicked-garden-beta', 1);
    expect(off).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(off.findings.find((f) => f.kind === 'core-disable')).toMatchObject({ severity: 'blocking', skill: 'wicked-garden-beta' });
    expect(s.store.manifest().skills['wicked-garden-beta']?.enabled).toBe(true); // nothing committed
    // A mutation on ANOTHER skill recomputes and keeps beta core (the closure alone would have dropped it).
    const other = s.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\n---\n\nedited wicked-garden-beta\n', 1);
    expect(other.verdict).toBe('clear');
    expect(s.store.manifest().skills['wicked-garden-beta']?.core).toBe(true);
    // Publish reports the missing SKILL.md (blocking) — it never silently drops beta from the closure.
    const blocked = await s.store.publish(other.revision);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.findings.find((f) => f.kind === 'missing-skill-md')).toMatchObject({ skill: 'wicked-garden-beta' });
    // Symlink-refused: beta's dir replaced by a link to an outside dir — still core, disable still blocked.
    const outside = join(s.base, 'outside-beta');
    mkdirSync(outside);
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: wicked-garden-beta\n---\n\nOUTSIDE\n');
    rmSync(join(s.root, 'effective', 'skills', 'beta'), { recursive: true });
    symlinkSync(outside, join(s.root, 'effective', 'skills', 'beta'));
    const off2 = s.store.disable('wicked-garden-beta', other.revision);
    expect(off2).toMatchObject({ verdict: 'blocked', revision: other.revision });
    expect(off2.findings.find((f) => f.kind === 'core-disable')).toBeDefined();
    expect(off2.findings.find((f) => f.kind === 'path-invalid')).toMatchObject({ severity: 'warning', skill: 'wicked-garden-beta' });
    expect(s.store.manifest().skills['wicked-garden-beta']).toMatchObject({ core: true, enabled: true });
  });
});

describe('an explicitly EMPTY WICKED_SKILLS_SNAPSHOT is preserved — a configuration error core refuses, never the fallback (design v3.5 §4, codex round 8)', () => {
  const savedEnv = process.env['WICKED_SKILLS_SNAPSHOT'];
  afterEach(() => {
    if (savedEnv === undefined) delete process.env['WICKED_SKILLS_SNAPSHOT'];
    else process.env['WICKED_SKILLS_SNAPSHOT'] = savedEnv;
  });

  it('applySkillsSnapshotEnv restores the boot value EXACTLY: a path, an empty string (kept), or nothing (deleted)', () => {
    applySkillsSnapshotEnv(null, '/boot/path');
    expect(process.env['WICKED_SKILLS_SNAPSHOT']).toBe('/boot/path');
    applySkillsSnapshotEnv(null, '');
    expect(process.env['WICKED_SKILLS_SNAPSHOT']).toBe(''); // set-but-empty stays set-but-empty
    applySkillsSnapshotEnv(null, undefined);
    expect(process.env['WICKED_SKILLS_SNAPSHOT']).toBeUndefined();
    applySkillsSnapshotEnv('/a/snapshot', '');
    expect(process.env['WICKED_SKILLS_SNAPSHOT']).toBe('/a/snapshot');
  });

  it('a daemon that booted with WICKED_SKILLS_SNAPSHOT="" and has no plugin to seed from reports config-error (skills.config), engineInput "", the variable still ""', async () => {
    const runtime = new SkillsRuntime({
      store: new SkillsStore({ root: join(s.base, 'no-plugin-root'), registeredSkillRefs: () => REGISTERED_REFS, provisionVenv: noVenv, source: () => null, now: () => CLOCK, warn: () => undefined }),
      log: () => undefined,
      bootSnapshot: '',
    });
    const health = await runtime.apply();
    expect(health.state).toBe('config-error');
    expect(health.engineInput).toBe('');
    expect(health.findings.map((f) => f.kind)).toEqual(['skills.config']);
    expect(health.findings[0]?.message).toContain('set but EMPTY');
    expect(process.env['WICKED_SKILLS_SNAPSHOT']).toBe('');
    // The ABSENT boot value is the fallback rung — unchanged.
    const fallback = await new SkillsRuntime({
      store: new SkillsStore({ root: join(s.base, 'no-plugin-root-2'), registeredSkillRefs: () => REGISTERED_REFS, provisionVenv: noVenv, source: () => null, now: () => CLOCK, warn: () => undefined }),
      log: () => undefined,
      bootSnapshot: undefined,
    }).apply();
    expect(fallback.state).toBe('fallback');
    expect(fallback.engineInput).toBeNull();
    expect(process.env['WICKED_SKILLS_SNAPSHOT']).toBeUndefined();
  });
});

describe('snapshot.json is AUTHENTICATED by the manifest and RE-DERIVED from the generation (codex round 7)', () => {
  it('publish records the sha256 of the exact snapshot.json bytes; a row with `core` flipped is refused as not the published metadata; restored byte-for-byte, it verifies', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const snap = r.snapshot as NonNullable<typeof r.snapshot>;
    const metadata = join(snap.path, 'snapshot.json');
    expect(s.store.manifest().published?.snapshotHash).toBe(sha256Hex(readFileSync(metadata)));
    const pristine = snapshotManifest(snap.path);
    unlock(metadata);
    const flipped = { ...pristine, skills: pristine.skills.map((row) => (row.name === 'wicked-garden-gamma' ? { ...row, core: !row.core } : row)) };
    writeFileSync(metadata, `${JSON.stringify(flipped, null, 2)}\n`);
    expect(() => s.store.currentSnapshot()).toThrow(SkillsCurrentInvalidError);
    expect(() => s.store.currentSnapshot()).toThrow(/not the metadata this root published/);
    writeFileSync(metadata, `${JSON.stringify(pristine, null, 2)}\n`);
    expect(s.store.currentSnapshot()?.gen).toBe(1);
  });

  it('with the manifest re-stamped (an attacker holding manifest.json), every row claim is still re-derived from the generation — kind, portable, nested — and the copilot view must be EXACTLY the portable set: a missing skill or an extra directory refuses', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const snap = r.snapshot as NonNullable<typeof r.snapshot>;
    const metadata = join(snap.path, 'snapshot.json');
    const pristine = snapshotManifest(snap.path);
    unlock(metadata);
    const stamp = (obj: unknown): void => {
      writeFileSync(metadata, `${JSON.stringify(obj, null, 2)}\n`);
      stampPublished(s.root, metadata);
    };
    const withRow = (name: string, patch: Record<string, unknown>): SnapshotManifest =>
      ({ ...pristine, skills: pristine.skills.map((row) => (row.name === name ? { ...row, ...patch } : row)) }) as SnapshotManifest;
    stamp(withRow('wicked-garden-gamma', { kind: 'router' }));
    expect(() => s.store.currentSnapshot()).toThrow(/claims kind router, but its SKILL\.md derives module/);
    stamp(withRow('wicked-garden-alpha-nested', { nested: false }));
    expect(() => s.store.currentSnapshot()).toThrow(/nested: what the dir spells/);
    // alpha is NOT portable; claiming it is — with the view list made consistent — is caught by its own files.
    const alphaPortable = withRow('wicked-garden-alpha', { portable: true, portability: { portable: true, reasons: [], evidence: [] } });
    stamp({ ...alphaPortable, views: { copilot: { dir: 'views/copilot', skills: [...pristine.views.copilot.skills, 'wicked-garden-alpha'].sort() } } });
    expect(() => s.store.currentSnapshot()).toThrow(/claims portable: true, but its files derive false/);
    // The view block must name EXACTLY the portable rows: one dropped ⇒ refused at parse.
    stamp({ ...pristine, views: { copilot: { dir: 'views/copilot', skills: pristine.views.copilot.skills.filter((n) => n !== 'wicked-garden-gamma') } } });
    expect(() => s.store.currentSnapshot()).toThrow(/EXACTLY the sorted portable names/);
    stamp(pristine);
    expect(s.store.currentSnapshot()?.gen).toBe(1);
    // An EXTRA directory in the on-disk view (content hash forged, manifest re-stamped) ⇒ refused by name.
    const extra = viewPath(snap.path, 'wicked-garden-zzz');
    chmodSync(dirname(extra), 0o755);
    mkdirSync(extra);
    writeFileSync(join(extra, 'SKILL.md'), '---\nname: wicked-garden-zzz\n---\n');
    const tree = walkTree(snap.path);
    stamp({ ...pristine, contentHash: hashTree(tree.files.filter((f) => f.rel !== 'snapshot.json'), tree.links, tree.dirs) });
    expect(() => s.store.currentSnapshot()).toThrow(/unexpected view file views\/copilot\/\.github\/skills\/wicked-garden-zzz\/SKILL\.md/);
    expect(() => s.store.currentSnapshot()).toThrow(/missing or extra/);
  });

  it('the copilot view is verified as a WHOLE tree (codex round 9): an EMPTY extra directory changes the content hash (directories are hashed) and, with the hash forged and the manifest re-stamped, is refused BY NAME; an extra directory elsewhere in the generation is a hash mismatch too; the legitimate view verifies', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const snap = r.snapshot as NonNullable<typeof r.snapshot>;
    const metadata = join(snap.path, 'snapshot.json');
    const pristine = snapshotManifest(snap.path);
    expect(s.store.currentSnapshot()?.gen).toBe(1); // the legitimate view verifies
    unlock(metadata);
    // An EMPTY directory under the view: invisible to a file-only hash — not to this one.
    const extra = viewPath(snap.path, 'wicked-garden-zzz');
    chmodSync(dirname(extra), 0o755);
    mkdirSync(extra);
    expect(() => s.store.currentSnapshot()).toThrow(/content hash mismatch/);
    // Hash forged over the walked tree (directories included) and the manifest re-stamped: the shape check names it.
    const tree = walkTree(snap.path);
    expect(tree.dirs).toContain('views/copilot/.github/skills/wicked-garden-zzz');
    writeFileSync(metadata, `${JSON.stringify({ ...pristine, contentHash: hashTree(tree.files.filter((f) => f.rel !== 'snapshot.json'), tree.links, tree.dirs) }, null, 2)}\n`);
    stampPublished(s.root, metadata);
    expect(() => s.store.currentSnapshot()).toThrow(/unexpected view directory views\/copilot\/\.github\/skills\/wicked-garden-zzz — the copilot view is exactly/);
    expect(() => s.store.currentSnapshot()).toThrow(/missing or extra/);
    rmSync(extra, { recursive: true });
    writeFileSync(metadata, `${JSON.stringify(pristine, null, 2)}\n`);
    stampPublished(s.root, metadata);
    expect(s.store.currentSnapshot()?.gen).toBe(1);
    // An empty directory ANYWHERE else in the generation is a hash mismatch as well.
    chmodSync(join(snap.path, 'skills'), 0o755);
    mkdirSync(join(snap.path, 'skills', 'planted-empty'));
    expect(() => s.store.currentSnapshot()).toThrow(/content hash mismatch/);
    rmSync(join(snap.path, 'skills', 'planted-empty'), { recursive: true });
    expect(s.store.currentSnapshot()?.gen).toBe(1);
  });
});

describe('effective/ is classified WHOLE (codex round 9): a symlink anywhere blocks by name, a special node blocks, empty directories are visible', () => {
  it('an extra symlink inside a registered skill ⇒ analyze and publish are blocked path-invalid naming the link and the skill; removed ⇒ clear', async () => {
    s.store.seed();
    const outside = join(s.base, 'outside.md');
    writeFileSync(outside, 'outside\n');
    const link = join(s.root, 'effective', 'skills', 'gamma', 'link.md');
    symlinkSync(outside, link);
    const analyzed = s.store.analyze();
    expect(analyzed.verdict).toBe('blocked');
    const refusal = analyzed.findings.filter((f) => f.kind === 'path-invalid');
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toMatchObject({ severity: 'blocking', skill: 'wicked-garden-gamma', file: 'skills/gamma/link.md' });
    expect(refusal[0]?.evidence).toBe(`skills/gamma/link.md is a symlink -> ${outside}`);
    const blocked = await s.store.publish(1);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.snapshot).toBeNull();
    expect(existsSync(join(s.root, 'snapshots'))).toBe(false);
    // A link at the support level is refused the same way (no owner).
    rmSync(link);
    symlinkSync(outside, join(s.root, 'effective', 'schemas', 'link.json'));
    const support = s.store.analyze();
    expect(support.findings.find((f) => f.kind === 'path-invalid')).toMatchObject({ skill: null, file: 'schemas/link.json' });
    rmSync(join(s.root, 'effective', 'schemas', 'link.json'));
    expect(s.store.analyze().verdict).toBe('clear');
  });

  it.skipIf(process.platform === 'win32')('a fifo under effective/ ⇒ blocked by name (neither a regular file nor a directory); an empty directory is visible to the walk and blocks nothing', async () => {
    s.store.seed();
    mkdirSync(join(s.root, 'effective', 'skills', 'gamma', 'empty-dir'));
    expect(s.store.analyze().verdict).toBe('clear'); // visible (walkEntries reports it), not carried, not refused
    expect(walkEntries(join(s.root, 'effective')).find((e) => e.rel === 'skills/gamma/empty-dir')?.kind).toBe('dir');
    execFileSync('mkfifo', [join(s.root, 'effective', 'skills', 'gamma', 'pipe')]);
    const analyzed = s.store.analyze();
    expect(analyzed.verdict).toBe('blocked');
    expect(analyzed.findings.find((f) => f.kind === 'path-invalid')).toMatchObject({ severity: 'blocking', skill: 'wicked-garden-gamma', file: 'skills/gamma/pipe' });
    expect(analyzed.findings.find((f) => f.kind === 'path-invalid')?.evidence).toContain('neither a regular file nor a directory');
    const blocked = await s.store.publish(1);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.snapshot).toBeNull();
  });
});

describe('pruned directories are CLASSIFIED under effective/ (review pass 10): a link or special node beneath .venv / node_modules / __pycache__ blocks by name, a regular file there stays outside every view, the baseline .venv stays unclassified, a generation never carries one', () => {
  it('a symlink under effective/node_modules/ ⇒ analyze and publish are blocked path-invalid naming the link and the pruned directory; a regular file there is neither carried nor a finding; removed ⇒ clear', async () => {
    s.store.seed();
    const effective = join(s.root, 'effective');
    const bin = join(effective, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(effective, 'node_modules', 'left-pad.js'), 'module.exports = 1;\n');
    expect(s.store.analyze().verdict).toBe('clear'); // a regular file beneath a pruned directory is outside the scan, exactly as before
    expect(walkFiles(effective).some((f) => f.rel.startsWith('node_modules/'))).toBe(false);
    const outside = join(s.base, 'outside-tool');
    writeFileSync(outside, '#!/bin/sh\n');
    symlinkSync(outside, join(bin, 'tool'));
    const analyzed = s.store.analyze();
    expect(analyzed.verdict).toBe('blocked');
    const refusal = analyzed.findings.filter((f) => f.kind === 'path-invalid');
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toMatchObject({ severity: 'blocking', skill: null, file: 'node_modules/.bin/tool' });
    expect(refusal[0]?.evidence).toBe(`node_modules/.bin/tool is a symlink -> ${outside} inside the pruned directory node_modules`);
    expect(refusal[0]?.explanation).toContain('not bundle content');
    expect(refusal[0]?.explanation).not.toContain('provisioned environments live under baseline/'); // the hint follows the `.venv` NAME
    const blocked = await s.store.publish(1);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.snapshot).toBeNull();
    expect(existsSync(join(s.root, 'snapshots'))).toBe(false);
    // The pruned view surfaced it; every carried view excludes the subtree exactly as before.
    const tree = walkTree(effective);
    expect(tree.links).toEqual([]);
    expect(tree.dirs).toContain('node_modules');
    expect(tree.dirs).not.toContain('node_modules/.bin');
    expect(tree.pruned.map((e) => [e.rel, e.kind, e.pruned])).toEqual([
      ['node_modules/.bin', 'dir', 'node_modules'],
      ['node_modules/.bin/tool', 'symlink', 'node_modules'],
      ['node_modules/left-pad.js', 'file', 'node_modules'],
    ]);
    rmSync(join(bin, 'tool'));
    expect(s.store.analyze().verdict).toBe('clear');
  });

  it.skipIf(process.platform === 'win32')('a fifo under effective/<skill>/__pycache__/ ⇒ blocked by name, the pruned directory and the owning skill named; the .pyc beside it is no finding', async () => {
    s.store.seed();
    const cache = join(s.root, 'effective', 'skills', 'gamma', '__pycache__');
    mkdirSync(cache);
    writeFileSync(join(cache, 'mod.cpython-312.pyc'), '');
    expect(s.store.analyze().verdict).toBe('clear');
    execFileSync('mkfifo', [join(cache, 'pipe')]);
    const analyzed = s.store.analyze();
    expect(analyzed.verdict).toBe('blocked');
    const refusal = analyzed.findings.find((f) => f.kind === 'path-invalid');
    expect(refusal).toMatchObject({ severity: 'blocking', skill: 'wicked-garden-gamma', file: 'skills/gamma/__pycache__/pipe' });
    expect(refusal?.evidence).toBe('skills/gamma/__pycache__/pipe is neither a regular file nor a directory (inside the pruned directory skills/gamma/__pycache__)');
    const blocked = await s.store.publish(1);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.snapshot).toBeNull();
  });

  it('an operator-created effective/.venv with an interpreter link ⇒ blocked path-invalid carrying the baseline hint (provisioned environments live under baseline/, not the editable root); inside a skill the owner is named', async () => {
    s.store.seed();
    const venv = join(s.root, 'effective', '.venv');
    mkdirSync(join(venv, 'bin'), { recursive: true });
    writeFileSync(join(venv, 'bin', 'python3.12'), '');
    symlinkSync('python3.12', join(venv, 'bin', 'python'));
    const analyzed = s.store.analyze();
    expect(analyzed.verdict).toBe('blocked');
    const refusal = analyzed.findings.filter((f) => f.kind === 'path-invalid');
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toMatchObject({ severity: 'blocking', skill: null, file: '.venv/bin/python' });
    expect(refusal[0]?.evidence).toBe('.venv/bin/python is a symlink -> python3.12 inside the pruned directory .venv');
    expect(refusal[0]?.explanation).toContain('provisioned environments live under baseline/, not the editable root');
    expect((await s.store.publish(1)).verdict).toBe('blocked');
    rmSync(venv, { recursive: true });
    // Inside a skill the owner is named; the hint follows the pruned directory's NAME (a `.venv` anywhere).
    const nestedVenv = join(s.root, 'effective', 'skills', 'gamma', '.venv');
    mkdirSync(join(nestedVenv, 'bin'), { recursive: true });
    symlinkSync(join(s.base, 'nowhere', 'python3'), join(nestedVenv, 'bin', 'python'));
    const nested = s.store.analyze().findings.find((f) => f.kind === 'path-invalid');
    expect(nested).toMatchObject({ severity: 'blocking', skill: 'wicked-garden-gamma', file: 'skills/gamma/.venv/bin/python' });
    expect(nested?.explanation).toContain('provisioned environments live under baseline/');
    rmSync(nestedVenv, { recursive: true });
    expect(s.store.analyze().verdict).toBe('clear');
  });

  it('the provisioned baseline/<hash>/.venv keeps its interpreter links — pruned AND unclassified there: publish clear with the links present, the snapshot links the env, current verifies, the baseline re-verifies on reuse', async () => {
    const provisioner: VenvProvisioner = async (baselineDir) => {
      const env = join(baselineDir, '.venv');
      mkdirSync(join(env, 'bin'), { recursive: true });
      mkdirSync(join(env, 'lib'), { recursive: true });
      writeFileSync(join(env, 'bin', 'python3.12'), '#!/bin/sh\n');
      symlinkSync('python3.12', join(env, 'bin', 'python')); // the interpreter link every venv carries
      symlinkSync('lib', join(env, 'lib64'));
      return 'synced';
    };
    const v = scaffold({ provisionVenv: provisioner });
    try {
      v.store.seed();
      const r = await v.store.publish(1); // `validate` re-derives the baseline AFTER the provisioner ran — the links are present
      expect(r.verdict).toBe('clear');
      expect(r.findings.filter((f) => f.kind === 'path-invalid' || f.kind === 'baseline-corrupt')).toEqual([]);
      const snap = r.snapshot as NonNullable<typeof r.snapshot>;
      const hash = v.store.manifest().baseline;
      const baselineDir = join(v.root, 'baseline', hash);
      expect(lstatSync(join(baselineDir, '.venv', 'bin', 'python')).isSymbolicLink()).toBe(true);
      // The walk SEES the links (classified under `pruned`); no carried view — so no hash — covers them.
      const tree = walkTree(baselineDir);
      expect(tree.links).toEqual([]);
      expect(tree.pruned.filter((e) => e.kind === 'symlink').map((e) => [e.rel, e.pruned])).toEqual([
        ['.venv/bin/python', '.venv'],
        ['.venv/lib64', '.venv'],
      ]);
      expect(hashFileSet(tree.files)).toBe(hash); // the bundle identity never covers the env
      expect(readlinkSync(join(snap.path, '.venv'))).toBe(join('..', '..', 'baseline', hash, '.venv'));
      expect(v.store.currentSnapshot()).toMatchObject({ gen: 1, path: snap.path });
      // A later publish REUSES the synced baseline (`baselineProblem` re-derived, the provisioner not re-run): still clear.
      const off = v.store.disable('wicked-garden-delta', r.revision);
      const again = await v.store.publish(off.revision);
      expect(again.verdict).toBe('clear');
      expect(again.snapshot?.gen).toBe(2);
      expect(v.store.currentSnapshot()?.gen).toBe(2);
    } finally {
      removeTreeForce(v.base);
    }
  });

  it('a pruned-name directory inside a generation is refused BY NAME before the hash, whatever it holds: snapshots/<gen>/node_modules/ ⇒ current invalid naming it — a forged hash and a re-stamped manifest change nothing; removed ⇒ verifies', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const snap = r.snapshot as NonNullable<typeof r.snapshot>;
    expect(s.store.currentSnapshot()?.gen).toBe(1);
    chmodSync(snap.path, 0o755);
    mkdirSync(join(snap.path, 'node_modules', '.bin'), { recursive: true });
    symlinkSync(join(s.base, 'outside'), join(snap.path, 'node_modules', '.bin', 'tool'));
    expect(() => s.store.currentSnapshot()).toThrow(SkillsCurrentInvalidError);
    expect(() => s.store.currentSnapshot()).toThrow(/unexpected directory node_modules — a published generation never carries a node_modules directory/);
    // Forge the hash over the walked tree and re-stamp the manifest: the name check runs first, so nothing changes.
    const metadata = join(snap.path, 'snapshot.json');
    const pristine = snapshotManifest(snap.path);
    const tree = walkTree(snap.path);
    expect(tree.dirs).toContain('node_modules');
    unlock(metadata);
    writeFileSync(metadata, `${JSON.stringify({ ...pristine, contentHash: hashTree(tree.files.filter((f) => f.rel !== 'snapshot.json'), tree.links, tree.dirs) }, null, 2)}\n`);
    stampPublished(s.root, metadata);
    expect(() => s.store.currentSnapshot()).toThrow(/unexpected directory node_modules/);
    rmSync(join(snap.path, 'node_modules'), { recursive: true });
    writeFileSync(metadata, `${JSON.stringify(pristine, null, 2)}\n`);
    stampPublished(s.root, metadata);
    expect(s.store.currentSnapshot()?.gen).toBe(1);
  });
});

describe('baseline reaping is a CAS mutation (codex round 9): a record drop rides the mutation that causes it, or commits on its own — the revision always advances, a stale expectedRevision is refused', () => {
  it('a publish that retires a generation drops the baseline it alone referenced in its OWN commit (one bump); a refresh with nothing published drops the previous baseline in its own commit; a standalone reap (a launch pin released) commits through the validated path and advances the revision', async () => {
    s.store.seed();
    const first = await s.store.publish(1); // gen 1 references baseline A
    const a = s.store.manifest().baseline;
    writeFileSync(join(s.upstream, 'skills', 'gamma', 'SKILL.md'), '---\nname: wicked-garden-gamma\n---\n\ngamma v2\n');
    const ref = s.store.refreshBaseline(first.revision); // baseline B; A's record stays while gen 1 references it — ONE bump
    expect(ref.revision).toBe(first.revision + 1);
    expect(Object.keys(s.store.manifest().baselines).sort()).toEqual([a, ref.baseline].sort());
    // A launch is reading gen 1: it stays pinned (and A with it) through the next publishes.
    s.store.live.exported(1);
    s.store.live.launched('run', 'run-a');
    let rev = ref.revision;
    for (let i = 0; i < 4; i += 1) {
      const p = await s.store.publish(rev); // gens 2..5 — every generation is pinned by the open launch, nothing is reaped, ONE bump each
      expect(p.revision).toBe(rev + 1);
      rev = p.revision;
    }
    expect(s.store.generationsOnDisk()).toEqual([1, 2, 3, 4, 5]);
    expect(s.store.baselinesOnDisk()).toEqual([a, ref.baseline].sort());
    // The run ends: the pin releases, the event-driven reap retires gens 1 and 2, and A — referenced by
    // nothing now — leaves the manifest through a validated commit of its own: the revision advances.
    s.store.observeEvent({ type: 'sessionCompleted', session: 'run-a' });
    expect(s.store.revision()).toBe(rev + 1);
    expect(s.store.generationsOnDisk()).toEqual([3, 4, 5]);
    expect(s.store.baselinesOnDisk()).toEqual([ref.baseline]);
    expect(Object.keys(s.store.manifest().baselines)).toEqual([ref.baseline]);
    // A client holding the revision from before the reap is stale — the 409 it should be.
    expect(() => s.store.disable('wicked-garden-alpha', rev)).toThrow(RevisionMismatchError);
    expect(s.store.disable('wicked-garden-alpha', rev + 1).verdict).toBe('clear');
  });

  it('a refresh with no generation on disk drops the previous baseline record in its OWN commit — one bump, directory gone, no second manifest at that revision', () => {
    s.store.seed();
    const a = s.store.manifest().baseline;
    writeFileSync(join(s.upstream, 'skills', 'gamma', 'SKILL.md'), '---\nname: wicked-garden-gamma\n---\n\ngamma v2\n');
    const ref = s.store.refreshBaseline(1);
    expect(ref.revision).toBe(2);
    expect(s.store.revision()).toBe(2);
    expect(Object.keys(s.store.manifest().baselines)).toEqual([ref.baseline]);
    expect(s.store.baselinesOnDisk()).toEqual([ref.baseline]);
    expect(existsSync(join(s.root, 'baseline', a))).toBe(false);
  });
});

describe('portability per reason (F-079, wicked-crew#531)', () => {
  /** A minimal SKILL.md for a user-added skill `name` with `body` under the heading. */
  const skillMd = (name: string, body: string, frontmatterExtra = ''): string => `---\nname: ${name}\ndescription: fixture\n${frontmatterExtra}---\n\n# ${name}\n\n${body}\n`;

  it('one fixture skill per reason: the manifest entry and the snapshot row carry {portable, reasons, evidence}; a write warns ONCE PER REASON with file:line', async () => {
    s.store.seed();
    let rev = 1;
    const add = (name: string, files: Record<string, string>): ReturnType<SkillsStore['add']> => {
      const r = s.store.add(name, files, rev);
      expect(r.verdict, `${name}: ${JSON.stringify(r.findings)}`).not.toBe('blocked');
      rev = r.revision;
      return r;
    };
    // skill-dir-var
    const dirVar = add('wicked-garden-p-dirvar', { 'SKILL.md': skillMd('wicked-garden-p-dirvar', 'ls ${CLAUDE_SKILL_DIR}/refs') });
    expect(dirVar.findings.filter((f) => f.kind === 'non-portable')).toMatchObject([{ portabilityReason: 'skill-dir-var', file: 'SKILL.md', line: 8 }]);
    expect(dirVar.skill?.portability).toEqual({ portable: false, reasons: ['skill-dir-var'], evidence: ['skills/p-dirvar/SKILL.md:8'] });
    // cross-skill-path through the plugin root (gamma's own file exists in the bundle)
    const cross = add('wicked-garden-p-cross', { 'SKILL.md': skillMd('wicked-garden-p-cross', 'Read `${CLAUDE_PLUGIN_ROOT}/skills/gamma/SKILL.md` first.') });
    expect(cross.findings.filter((f) => f.kind === 'non-portable').map((f) => f.portabilityReason)).toEqual(['cross-skill-path', 'plugin-root']);
    expect(cross.skill?.portability).toEqual({ portable: false, reasons: ['cross-skill-path', 'plugin-root'], evidence: ['skills/p-cross/SKILL.md:8'] });
    // requires-harness:claude — declared, not detected
    const harness = add('wicked-garden-p-harness', { 'SKILL.md': skillMd('wicked-garden-p-harness', 'Needs the Skill tool.', 'metadata:\n  requires-harness: claude\n') });
    expect(harness.findings.filter((f) => f.kind === 'non-portable')).toMatchObject([{ portabilityReason: 'requires-harness:claude', line: 5 }]);
    expect(harness.skill?.portability).toEqual({ portable: false, reasons: ['requires-harness:claude'], evidence: ['skills/p-harness/SKILL.md:5'] });
    // the launcher forms + base-dir refs: PORTABLE
    const launcher = add('wicked-garden-p-launcher', {
      'SKILL.md': skillMd('wicked-garden-p-launcher', 'Run `wicked-garden run scripts/alpha/run.py` then `python3 scripts/local.py`; read `refs/plan.md`; dispatch **`wicked-garden-gamma`**.\nWT_LIB="$(wicked-garden path scripts/alpha)"'),
      'refs/plan.md': 'Back to [the skill](../SKILL.md).\n',
      'scripts/local.py': 'print(1)\n',
    });
    expect(launcher.findings.filter((f) => f.kind === 'non-portable')).toEqual([]);
    expect(launcher.skill?.portability).toEqual({ portable: true, reasons: [], evidence: [] });
    // a MIXED skill: three files, four reasons — one finding per reason PER FILE, evidence capped at five anchors in file order
    const mixed = add('wicked-garden-p-mixed', {
      'SKILL.md': skillMd('wicked-garden-p-mixed', 'Run `python3 scripts/alpha/run.py`.\nSee ${CLAUDE_PLUGIN_ROOT}/scripts/_python.sh and ${CLAUDE_PLUGIN_ROOT}/schemas/evidence.json.'),
      'refs/a.md': 'link [gamma](../../gamma/SKILL.md)\n${CLAUDE_PLUGIN_ROOT}\n',
      'refs/b.md': 'ls ${CLAUDE_SKILL_DIR}\n${CLAUDE_PLUGIN_ROOT}/docs/examples/campaign.yml\n',
    });
    expect(mixed.findings.filter((f) => f.kind === 'non-portable').map((f) => [f.file, f.portabilityReason, f.line])).toEqual([
      ['SKILL.md', 'cwd-script', 8],
      ['SKILL.md', 'plugin-root', 9],
      ['refs/a.md', 'cross-skill-path', 1],
      ['refs/a.md', 'plugin-root', 2],
      ['refs/a.md', 'relative-link', 1],
      ['refs/b.md', 'plugin-root', 2],
      ['refs/b.md', 'skill-dir-var', 1],
    ]);
    const pr = mixed.findings.find((f) => f.file === 'SKILL.md' && f.portabilityReason === 'plugin-root');
    expect(pr?.evidence).toBe('skills/p-mixed/SKILL.md:9: plugin-root — ${CLAUDE_PLUGIN_ROOT}/scripts/_python.sh (+1 more)');
    expect(pr?.explanation).toContain('only Claude Code substitutes');
    expect(mixed.skill?.portability).toEqual({
      portable: false,
      reasons: ['cross-skill-path', 'cwd-script', 'plugin-root', 'relative-link', 'skill-dir-var'],
      evidence: ['skills/p-mixed/SKILL.md:8', 'skills/p-mixed/SKILL.md:9', 'skills/p-mixed/refs/a.md:1', 'skills/p-mixed/refs/a.md:2', 'skills/p-mixed/refs/b.md:1'],
    });

    // Published: every row carries the claim; the copilot view is STILL exactly the portable rows; `current` verifies.
    const r = await s.store.publish(rev);
    expect(r.verdict).toBe('clear');
    const snap = snapshotManifest((r.snapshot as NonNullable<typeof r.snapshot>).path);
    const rows = Object.fromEntries(snap.skills.map((x) => [x.name, x.portability]));
    expect(rows['wicked-garden-p-dirvar']).toEqual({ portable: false, reasons: ['skill-dir-var'], evidence: ['skills/p-dirvar/SKILL.md:8'] });
    expect(rows['wicked-garden-p-cross']?.reasons).toEqual(['cross-skill-path', 'plugin-root']);
    expect(rows['wicked-garden-p-harness']?.reasons).toEqual(['requires-harness:claude']);
    expect(rows['wicked-garden-p-launcher']).toEqual({ portable: true, reasons: [], evidence: [] });
    expect(rows['wicked-garden-p-mixed']?.reasons).toEqual(['cross-skill-path', 'cwd-script', 'plugin-root', 'relative-link', 'skill-dir-var']);
    expect(snap.skills.every((x) => x.portability?.portable === x.portable)).toBe(true);
    expect(snap.views.copilot.skills).toEqual(['wicked-garden-beta', 'wicked-garden-gamma', 'wicked-garden-p-launcher']);
    expect(s.store.currentSnapshot()?.gen).toBe(1);
    expect(storeOver(s).currentSnapshot()?.gen).toBe(1);
  });

  it('the row\'s reasons are RE-DERIVED at verify like `portable` is: a re-stamped reason list is refused by name; a malformed `portability` block is refused at parse', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const snap = r.snapshot as NonNullable<typeof r.snapshot>;
    const metadata = join(snap.path, 'snapshot.json');
    const pristine = snapshotManifest(snap.path);
    unlock(metadata);
    const stamp = (obj: unknown): void => {
      writeFileSync(metadata, `${JSON.stringify(obj, null, 2)}\n`);
      stampPublished(s.root, metadata);
    };
    const withRow = (name: string, patch: Record<string, unknown>): SnapshotManifest =>
      ({ ...pristine, skills: pristine.skills.map((row) => (row.name === name ? { ...row, ...patch } : row)) }) as SnapshotManifest;
    // alpha's files derive [plugin-root]; a row claiming [cwd-script] (still non-portable, still consistent) is caught by re-derivation.
    stamp(withRow('wicked-garden-alpha', { portability: { portable: false, reasons: ['cwd-script'], evidence: [] } }));
    expect(() => s.store.currentSnapshot()).toThrow(/claims portability reasons \[cwd-script\], but its files derive \[plugin-root\]/);
    // Shape: reasons not sorted / unknown token / portable disagreeing / too much evidence ⇒ refused at parse.
    for (const bad of [
      { portable: false, reasons: ['relative-link', 'cross-skill-path'], evidence: [] },
      { portable: false, reasons: ['made-up'], evidence: [] },
      { portable: true, reasons: [], evidence: [] },
      { portable: false, reasons: [], evidence: [] },
      { portable: false, reasons: ['plugin-root'], evidence: ['a:1', 'b:2', 'c:3', 'd:4', 'e:5', 'f:6'] },
      { portable: false, reasons: ['plugin-root'], evidence: [], extra: 1 },
    ]) {
      stamp(withRow('wicked-garden-alpha', { portability: bad }));
      expect(() => s.store.currentSnapshot(), JSON.stringify(bad)).toThrow(/portability\?: \{portable: the same boolean/);
    }
    // An OLDER generation's rows (no `portability` at all) still parse and verify on `portable` alone.
    stamp({
      ...pristine,
      skills: pristine.skills.map((row) => {
        const older = { ...row } as Record<string, unknown>;
        delete older['portability'];
        return older;
      }),
    });
    expect(s.store.currentSnapshot()?.gen).toBe(1);
    stamp(pristine);
    expect(s.store.currentSnapshot()?.gen).toBe(1);
  });

  it('the validator judges against the bundle the NEXT publish carries: a `../` link into a DISABLED skill is a broken link (unresolved-ref), not a portability reason — so verify re-derives the same answer from the generation', async () => {
    s.store.seed();
    // delta links `../gamma/SKILL.md`; with gamma enabled that is cross-skill-path + relative-link.
    expect(s.store.manifest().skills['wicked-garden-delta']?.portability?.reasons).toEqual(['cross-skill-path', 'relative-link']);
    // gamma is core (through beta's mandate) — disabling it is blocked; use alpha/nested → alpha instead.
    const off = s.store.disable('wicked-garden-alpha', 1);
    expect(off.verdict).toBe('clear');
    // alpha's files left the bundle view: nested's `../SKILL.md` now names nothing the snapshot carries.
    expect(s.store.manifest().skills['wicked-garden-alpha-nested']?.portability).toEqual({ portable: true, reasons: [], evidence: [] });
    const r = await s.store.publish(off.revision);
    expect(r.verdict).toBe('warnings'); // the broken link is reported as unresolved-ref (design v3.4 §1)
    expect(r.findings.map((f) => f.kind)).toContain('unresolved-ref');
    const snap = snapshotManifest((r.snapshot as NonNullable<typeof r.snapshot>).path);
    expect(snap.skills.find((x) => x.name === 'wicked-garden-alpha-nested')?.portability).toEqual({ portable: true, reasons: [], evidence: [] });
    expect(snap.views.copilot.skills).toContain('wicked-garden-alpha-nested');
    expect(storeOver(s).currentSnapshot()?.gen).toBe(1);
    // Re-enabling alpha brings the reason back — enablement re-derives, no other mutation needed.
    const on = s.store.enable('wicked-garden-alpha', r.revision);
    expect(on.verdict).toBe('clear');
    expect(s.store.manifest().skills['wicked-garden-alpha-nested']?.portability?.reasons).toEqual(['cross-skill-path', 'relative-link']);
  });

  it('recompute and verify judge ONE universe (review of #532, F-1): an owner-less file under skills/ (a `skills/README.md`) is never in the bundle — a `../README.md` link to it derives NO reason at recompute, publish lands, and `current` verifies', async () => {
    // Upstream ships a top-level `skills/README.md` (no skill owns it — validate never ships it) and
    // beta links it. Before the fix recompute saw the file (it is inside the closure) and stamped
    // `relative-link`; verify, judging the generation, derived nothing → `current` was refused
    // and no re-publish could repair it.
    writeFileSync(join(s.upstream, 'skills', 'README.md'), '# skills\n\nAn index nobody owns.\n');
    const beta = join(s.upstream, 'skills', 'beta', 'SKILL.md');
    writeFileSync(beta, `${readFileSync(beta, 'utf8')}\nSee ../README.md for the index.\n`);
    s.store.seed();
    const m = s.store.manifest();
    expect(Object.keys(m.files)).toContain('skills/README.md'); // recorded — it is in the closure…
    expect(m.skills['wicked-garden-beta']?.portability).toEqual({ portable: true, reasons: [], evidence: [] }); // …but not in the validator's universe
    expect(m.skills['wicked-garden-beta']?.portable).toBe(true);
    const r = await s.store.publish(1);
    expect(r.snapshot).not.toBeNull();
    // The link IS broken in the generation — publish says so as unresolved-ref (v3.4 §1) — and the row says portable.
    expect(r.findings.some((f) => f.kind === 'unresolved-ref' && f.skill === 'wicked-garden-beta')).toBe(true);
    const snapPath = (r.snapshot as NonNullable<typeof r.snapshot>).path;
    expect(rels(snapPath)).not.toContain('skills/README.md');
    expect(snapshotManifest(snapPath).skills.find((x) => x.name === 'wicked-garden-beta')?.portability).toEqual({ portable: true, reasons: [], evidence: [] });
    // The whole point: the generation verifies — from this store and from a fresh one.
    expect(s.store.currentSnapshot()?.gen).toBe(1);
    expect(storeOver(s).currentSnapshot()?.gen).toBe(1);
    // And a second publish is a clean no-drama gen 2, not a repair loop.
    const again = await s.store.publish(r.revision);
    expect(again.snapshot?.gen).toBe(2);
    expect(storeOver(s).currentSnapshot()?.gen).toBe(2);
  });

  it('a write warns on every reason it INTRODUCES, not on ones the skill already carries (review of #532, F-7): editing a non-portable skill still names a NEW reason', () => {
    s.store.seed();
    // alpha is non-portable (plugin-root). A file adding skill-dir-var → ONE finding, for the new reason only.
    const w1 = s.store.writeFile('wicked-garden-alpha', 'refs/more.md', 'ls ${CLAUDE_SKILL_DIR}\nand ${CLAUDE_PLUGIN_ROOT}/scripts/_python.sh\n', 1);
    expect(w1.verdict).toBe('warnings');
    expect(w1.findings.filter((f) => f.kind === 'non-portable').map((f) => [f.portabilityReason, f.line])).toEqual([['skill-dir-var', 1]]);
    expect(w1.skill?.portability?.reasons).toEqual(['plugin-root', 'skill-dir-var']);
    // The same reasons again in another file → nothing new to say.
    const w2 = s.store.writeFile('wicked-garden-alpha', 'refs/again.md', '${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_SKILL_DIR}\n', w1.revision);
    expect(w2.verdict).toBe('clear');
    expect(w2.findings.filter((f) => f.kind === 'non-portable')).toEqual([]);
    // A portable skill hears about every reason (nothing is known yet).
    const w3 = s.store.writeFile('wicked-garden-gamma', 'refs/x.md', 'run `python3 scripts/alpha/run.py`\n', w2.revision);
    expect(w3.findings.filter((f) => f.kind === 'non-portable').map((f) => f.portabilityReason)).toEqual(['cwd-script']);
  });

  it('an older `portable`-only manifest (written before 0.7.30) still loads; the next recompute fills `portability` in', () => {
    s.store.seed();
    const manifestPath = join(s.root, 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { skills: Record<string, Record<string, unknown>> };
    for (const e of Object.values(raw.skills)) delete e['portability'];
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
    const older = storeOver(s);
    const m = older.manifest();
    expect(m.skills['wicked-garden-alpha']).toMatchObject({ portable: false });
    expect(Object.hasOwn(m.skills['wicked-garden-alpha'] ?? {}, 'portability')).toBe(false);
    // A malformed block is refused as a corrupt manifest, by name.
    const broken = JSON.parse(readFileSync(manifestPath, 'utf8')) as { skills: Record<string, Record<string, unknown>> };
    (broken.skills['wicked-garden-alpha'] as Record<string, unknown>)['portability'] = { portable: true, reasons: [] };
    writeFileSync(manifestPath, `${JSON.stringify(broken, null, 2)}\n`);
    expect(() => storeOver(s).manifest()).toThrow(SkillsManifestCorruptError);
    expect(() => storeOver(s).manifest()).toThrow(/portability \.portable is true, not the row's false/);
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
    // Any mutation recomputes: the field appears with the reasons the files derive.
    const w = storeOver(s).writeFile('wicked-garden-gamma', 'refs/note.md', 'plain\n', m.revision);
    expect(w.verdict).toBe('clear');
    expect(storeOver(s).manifest().skills['wicked-garden-alpha']?.portability).toEqual({ portable: false, reasons: ['plugin-root'], evidence: ['skills/alpha/SKILL.md:10'] });
  });
});

describe('a generation published under OLDER portability rules is ACCEPTED, never refused (F-083)', () => {
  /**
   * Re-shape the current generation on disk the way an honest OLDER publisher would have written it:
   * `metadata` is the snapshot.json to write (identity stripped or re-stamped, rows as the old
   * detector judged them); gamma's copilot view is dropped when the rows call gamma non-portable (the
   * old publisher laid out exactly ITS portable rows); the walked tree is re-hashed and the manifest
   * re-stamped — every byte authenticated, only the rules that judged the rows are older.
   */
  const asOlderGeneration = (snapPath: string, metadata: Record<string, unknown>, dropGammaView: boolean): void => {
    const file = join(snapPath, 'snapshot.json');
    unlock(file);
    if (dropGammaView) {
      const gammaView = viewPath(snapPath, 'wicked-garden-gamma');
      chmodSync(dirname(gammaView), 0o755);
      removeTreeForce(gammaView);
    }
    const tree = walkTree(snapPath);
    const contentHash = hashTree(tree.files.filter((f) => f.rel !== 'snapshot.json'), tree.links, tree.dirs);
    writeFileSync(file, `${JSON.stringify({ ...metadata, contentHash }, null, 2)}\n`);
    stampPublished(s.root, file);
  };
  const withoutIdentity = (pristine: SnapshotManifest): Record<string, unknown> => {
    const older = { ...pristine } as Record<string, unknown>;
    delete older['rulesVersion'];
    delete older['rulesSha256'];
    return older;
  };
  /** gamma as the OLD first-hit detector judged it — a false positive: non-portable on `plugin-root`; the view excludes it. */
  const gammaFalsePositive = (pristine: SnapshotManifest): Record<string, unknown> => ({
    ...withoutIdentity(pristine),
    skills: pristine.skills.map((row) => (row.name === 'wicked-garden-gamma' ? { ...row, portable: false, portability: { portable: false, reasons: ['plugin-root'], evidence: ['skills/gamma/SKILL.md:1'] } } : row)),
    views: { copilot: { dir: 'views/copilot', skills: pristine.views.copilot.skills.filter((n) => n !== 'wicked-garden-gamma') } },
  });
  const patchRow = (metadata: Record<string, unknown>, name: string, patch: Record<string, unknown>): Record<string, unknown> => ({
    ...metadata,
    skills: (metadata['skills'] as SnapshotSkillRow[]).map((row) => (row.name === name ? { ...row, ...patch } : row)),
  });
  const OTHER_RULES = { version: 1, sha256: 'ab'.repeat(32) };
  const withEnvRestored = async (fn: () => Promise<void>): Promise<void> => {
    const saved = process.env['WICKED_SKILLS_SNAPSHOT'];
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env['WICKED_SKILLS_SNAPSHOT'];
      else process.env['WICKED_SKILLS_SNAPSHOT'] = saved;
    }
  };

  it('publish records the running rules identity in snapshot.json; `current` answers it — recorded = running, not stale, no drift', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const snap = r.snapshot as NonNullable<typeof r.snapshot>;
    const written = snapshotManifest(snap.path);
    expect(written.rulesVersion).toBe(PORTABILITY_RULES_IDENTITY.version);
    expect(written.rulesSha256).toBe(PORTABILITY_RULES_IDENTITY.sha256);
    expect(written.rulesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.store.currentSnapshot()).toEqual({
      gen: 1,
      path: snap.path,
      rules: { recorded: { ...PORTABILITY_RULES_IDENTITY }, running: { ...PORTABILITY_RULES_IDENTITY }, stale: false },
      drift: [],
    });
  });

  it('the 0.7.29 → 0.7.30 shape — NO recorded identity and a row the old detector got wrong (gamma non-portable, the view without it) — is ACCEPTED from this store and a fresh one with the drift named; the runtime stays `published` with the snapshot as the engine input and ONE skills.stale-rules warning; a publish records the identity and clears it', async () =>
    withEnvRestored(async () => {
      s.store.seed();
      const r = await s.store.publish(1);
      const snap = r.snapshot as NonNullable<typeof r.snapshot>;
      asOlderGeneration(snap.path, gammaFalsePositive(snapshotManifest(snap.path)), true);
      for (const store of [s.store, storeOver(s)]) {
        const current = store.currentSnapshot();
        expect(current?.gen).toBe(1);
        expect(current?.path).toBe(snap.path);
        expect(current?.rules).toEqual({ recorded: null, running: { ...PORTABILITY_RULES_IDENTITY }, stale: true });
        expect(current?.drift).toEqual([{ name: 'wicked-garden-gamma', recorded: { portable: false, reasons: ['plugin-root'] }, derived: { portable: true, reasons: [], evidence: [] } }]);
      }
      const logged: string[] = [];
      const runtime = new SkillsRuntime({ store: storeOver(s), log: (m) => logged.push(m), bootSnapshot: undefined });
      const health = await runtime.apply();
      expect(health.state).toBe('published');
      expect(health.current).toEqual({ gen: 1, path: snap.path });
      expect(health.engineInput).toBe(snap.path);
      expect(process.env['WICKED_SKILLS_SNAPSHOT']).toBe(snap.path);
      expect(health.findings.map((f) => f.kind)).toEqual(['skills.stale-rules']);
      expect(health.findings[0]?.severity).toBe('warning');
      expect(health.findings[0]?.message).toContain('generation 1 was published under an unrecorded portability rules version (a publisher before 0.7.31)');
      expect(health.findings[0]?.message).toContain(`the daemon runs v${PORTABILITY_RULES_IDENTITY.version} (${PORTABILITY_RULES_IDENTITY.sha256.slice(0, 12)})`);
      expect(health.findings[0]?.message).toContain('1 row(s) now derive differently: wicked-garden-gamma (portable false → true)');
      expect(health.findings[0]?.message).toContain('re-publish (POST /skills/publish)');
      expect(logged.filter((l) => l.includes('skills.stale-rules'))).toHaveLength(1);
      expect(logged.some((l) => l.includes('skills.config'))).toBe(false);
      // The diagnostics read keeps reporting it until a publish.
      expect(runtime.health().findings.map((f) => f.kind)).toEqual(['skills.stale-rules']);
      // The remedy: a publish writes the running identity into the new generation and the warning is gone.
      const again = await runtime.store.publish(runtime.store.manifest().revision);
      expect(again.verdict).toBe('clear');
      const after = runtime.afterPublish();
      expect(after?.state).toBe('published');
      expect(after?.findings).toEqual([]);
      expect(after?.current?.gen).toBe(2);
      expect(runtime.health().findings).toEqual([]);
      const fresh = runtime.store.currentSnapshot();
      expect(fresh?.rules).toEqual({ recorded: { ...PORTABILITY_RULES_IDENTITY }, running: { ...PORTABILITY_RULES_IDENTITY }, stale: false });
      expect(fresh?.drift).toEqual([]);
      expect(snapshotManifest((again.snapshot as NonNullable<typeof again.snapshot>).path).rulesVersion).toBe(PORTABILITY_RULES_IDENTITY.version);
    }));

  it('a RECORDED but different identity is stale too; a reasons-only difference (epsilon recorded as plugin-root, derives cwd-script) is drift with the derived evidence; the warning names the recorded version', async () =>
    withEnvRestored(async () => {
      s.store.seed();
      const r = await s.store.publish(1);
      const snap = r.snapshot as NonNullable<typeof r.snapshot>;
      const pristine = snapshotManifest(snap.path);
      asOlderGeneration(
        snap.path,
        patchRow({ ...pristine, rulesVersion: OTHER_RULES.version, rulesSha256: OTHER_RULES.sha256 }, 'wicked-garden-epsilon', { portability: { portable: false, reasons: ['plugin-root'], evidence: [] } }),
        false,
      );
      const current = storeOver(s).currentSnapshot();
      expect(current?.rules).toEqual({ recorded: OTHER_RULES, running: { ...PORTABILITY_RULES_IDENTITY }, stale: true });
      const [drifted] = current?.drift ?? [];
      expect(current?.drift).toHaveLength(1);
      expect(drifted).toMatchObject({ name: 'wicked-garden-epsilon', recorded: { portable: false, reasons: ['plugin-root'] }, derived: { portable: false, reasons: ['cwd-script'] } });
      expect(drifted?.derived.evidence).toEqual([expect.stringMatching(/^skills\/epsilon\/SKILL\.md:\d+$/)]);
      const health = await new SkillsRuntime({ store: storeOver(s), log: () => undefined, bootSnapshot: undefined }).apply();
      expect(health.state).toBe('published');
      expect(health.findings.map((f) => f.kind)).toEqual(['skills.stale-rules']);
      expect(health.findings[0]?.message).toContain(`published under portability rules v1 (${OTHER_RULES.sha256.slice(0, 12)})`);
      expect(health.findings[0]?.message).toContain('wicked-garden-epsilon (portable false → false: cwd-script)');
    }));

  it('a pre-0.7.30 generation — no identity, rows without `portability` — whose rows all agree is accepted as stale with NO drift; the warning says every row derives the same', async () =>
    withEnvRestored(async () => {
      s.store.seed();
      const r = await s.store.publish(1);
      const snap = r.snapshot as NonNullable<typeof r.snapshot>;
      const pristine = snapshotManifest(snap.path);
      asOlderGeneration(
        snap.path,
        {
          ...withoutIdentity(pristine),
          skills: pristine.skills.map((row) => {
            const older = { ...row } as Record<string, unknown>;
            delete older['portability'];
            return older;
          }),
        },
        false,
      );
      const current = storeOver(s).currentSnapshot();
      expect(current?.rules).toEqual({ recorded: null, running: { ...PORTABILITY_RULES_IDENTITY }, stale: true });
      expect(current?.drift).toEqual([]);
      const health = await new SkillsRuntime({ store: storeOver(s), log: () => undefined, bootSnapshot: undefined }).apply();
      expect(health.state).toBe('published');
      expect(health.findings).toHaveLength(1);
      expect(health.findings[0]?.kind).toBe('skills.stale-rules');
      expect(health.findings[0]?.message).toContain('every row derives the same under the current rules');
    }));

  it('refusal is reserved for tampering: under the SAME identity the row the old detector got wrong is refused as before; under OLDER rules a modified file (content hash), a kind claim and a missing SKILL.md still refuse; a half-recorded or malformed identity is refused at parse', async () => {
    s.store.seed();
    const r = await s.store.publish(1);
    const snap = r.snapshot as NonNullable<typeof r.snapshot>;
    const pristine = snapshotManifest(snap.path);
    // SAME recorded identity + gamma flipped: this daemon's rules judged the row — deriving differently IS tampering.
    asOlderGeneration(snap.path, { ...gammaFalsePositive(pristine), rulesVersion: pristine.rulesVersion, rulesSha256: pristine.rulesSha256 }, true);
    expect(() => storeOver(s).currentSnapshot()).toThrow(SkillsCurrentInvalidError);
    expect(() => storeOver(s).currentSnapshot()).toThrow(/skill row wicked-garden-gamma claims portable: false, but its files derive true/);
    // Stripped of the identity, the SAME bytes are accepted — the row is drift.
    asOlderGeneration(snap.path, gammaFalsePositive(pristine), false);
    expect(storeOver(s).currentSnapshot()?.drift.map((d) => d.name)).toEqual(['wicked-garden-gamma']);
    // A modified FILE under older rules is still a content-hash mismatch.
    const gammaMd = join(snap.path, 'skills', 'gamma', 'SKILL.md');
    const before = readFileSync(gammaMd, 'utf8');
    unlock(gammaMd);
    writeFileSync(gammaMd, `${before}tampered\n`);
    expect(() => storeOver(s).currentSnapshot()).toThrow(/content hash mismatch/);
    writeFileSync(gammaMd, before);
    expect(storeOver(s).currentSnapshot()?.gen).toBe(1);
    // A kind claim the SKILL.md does not derive is refused under any rules.
    asOlderGeneration(snap.path, patchRow(gammaFalsePositive(pristine), 'wicked-garden-beta', { kind: 'router' }), false);
    expect(() => storeOver(s).currentSnapshot()).toThrow(/skill row wicked-garden-beta claims kind router, but its SKILL\.md derives module/);
    // A row whose SKILL.md the generation does not carry (tree re-hashed, so the hash agrees) is refused by the row check.
    const betaMd = join(snap.path, 'skills', 'beta', 'SKILL.md');
    const betaBefore = readFileSync(betaMd, 'utf8');
    unlock(betaMd);
    rmSync(betaMd);
    asOlderGeneration(snap.path, gammaFalsePositive(pristine), false);
    expect(() => storeOver(s).currentSnapshot()).toThrow(/skill row wicked-garden-beta names skills\/beta, but the generation carries no skills\/beta\/SKILL\.md/);
    writeFileSync(betaMd, betaBefore);
    // A half-recorded or malformed identity pair is not what publish writes — refused at parse.
    for (const [bad, why] of [
      [{ rulesVersion: PORTABILITY_RULES_IDENTITY.version }, /rulesVersion without rulesSha256/],
      [{ rulesSha256: PORTABILITY_RULES_IDENTITY.sha256 }, /rulesSha256 without rulesVersion/],
      [{ rulesVersion: 0, rulesSha256: PORTABILITY_RULES_IDENTITY.sha256 }, /rulesVersion is not an integer/],
      [{ rulesVersion: 1.5, rulesSha256: PORTABILITY_RULES_IDENTITY.sha256 }, /rulesVersion is not an integer/],
      [{ rulesVersion: PORTABILITY_RULES_IDENTITY.version, rulesSha256: 'not-a-digest' }, /rulesSha256 is not a sha256/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      asOlderGeneration(snap.path, { ...gammaFalsePositive(pristine), ...bad }, false);
      expect(() => storeOver(s).currentSnapshot(), JSON.stringify(bad)).toThrow(why);
    }
    // Back to the honest older shape: accepted again.
    asOlderGeneration(snap.path, gammaFalsePositive(pristine), false);
    expect(storeOver(s).currentSnapshot()?.gen).toBe(1);
  });
});
