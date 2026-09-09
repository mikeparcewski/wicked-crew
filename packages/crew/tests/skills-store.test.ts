// The daemon-owned skills store (skills keystone, design v3): seed → content-hash baseline;
// publish → immutable snapshot of ENABLED skills only, `current` flipped, generations reaped;
// the whole-tree validation naming file:line; enablement orthogonal to content (reset); CAS on
// every mutation; skill-scoped containment; the core-by-reference closure; the three-way refresh.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pluginBundleFiles } from '../src/skills/bundle.js';
import { SkillPathError } from '../src/skills/contain.js';
import { RevisionMismatchError, SkillsSourceUnavailableError, type SnapshotManifest } from '../src/skills/store.js';
import { hashFileSet, walkFiles } from '../src/skills/tree.js';
import { removeScratch } from './setup/scratch.js';
import { FIXTURE_PLUGIN, scaffold, type Scaffold } from './support/skills-fixture.js';

let s: Scaffold;

beforeEach(() => {
  s = scaffold();
});

afterEach(async () => {
  await s.store.pendingVenv;
  removeScratch(s.base);
});

const rels = (dir: string): string[] => walkFiles(dir).map((f) => f.rel);
const snapshotManifest = (path: string): SnapshotManifest =>
  JSON.parse(readFileSync(join(path, 'snapshot.json'), 'utf8')) as SnapshotManifest;

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

  it('is idempotent and keys the catalog by frontmatter name with fork-first kinds, portability and the core closure', () => {
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
    // The baseline record carries the source facts.
    expect(m.baselines[m.baseline]).toMatchObject({ plugin_version: '1.0.0', source: { path: s.upstream }, git_sha: null });
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
});

describe('publish (design v3 §1)', () => {
  it('writes an immutable snapshot of ENABLED skills only, with the closure and a valid snapshot.json, and flips current', () => {
    s.store.seed();
    const disabled = s.store.disable('wicked-garden-delta', 1);
    expect(disabled.verdict).toBe('clear');
    const result = s.store.publish(disabled.revision);
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
    // The shared venv link sits beside the tree (dangling until uv sync lands; never followed by the walk).
    expect(lstatSync(join(snap.path, '.venv')).isSymbolicLink()).toBe(true);
    const manifest = snapshotManifest(snap.path);
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
    expect(manifest.skills.find((x) => x.name === 'wicked-garden-alpha-nested')).toEqual({
      name: 'wicked-garden-alpha-nested',
      dir: 'skills/alpha/nested',
      kind: 'fork-worker',
      core: false,
      portable: false,
    });
    // `current` resolves to the generation; the manifest records the publish and lastPublishedHash.
    expect(s.store.currentSnapshot()).toEqual({ gen: 1, path: snap.path });
    const m = s.store.manifest();
    expect(m.published).toMatchObject({ gen: 1, contentHash: snap.contentHash });
    expect(m.files['skills/beta/SKILL.md']?.lastPublishedHash).toBe(m.files['skills/beta/SKILL.md']?.effectiveHash);
    expect(m.files['skills/delta/SKILL.md']?.lastPublishedHash).toBeNull();
  });

  it('is BLOCKED — nothing written — when an enabled skill references a file the snapshot omits, naming file:line', () => {
    s.store.seed();
    // Disabling alpha is legal (not core)… but alpha/nested links `../SKILL.md`, alpha's own file.
    const r1 = s.store.disable('wicked-garden-alpha', 1);
    expect(r1.verdict).toBe('clear');
    const blocked = s.store.publish(r1.revision);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.snapshot).toBeNull();
    expect(s.store.currentSnapshot()).toBeNull();
    expect(existsSync(join(s.root, 'snapshots'))).toBe(false);
    const ref = blocked.findings.find((f) => f.kind === 'unresolved-ref');
    expect(ref).toMatchObject({ severity: 'blocking', skill: 'wicked-garden-alpha-nested', file: 'skills/alpha/nested/SKILL.md', line: 10 });
    expect(ref?.evidence).toContain('DISABLED skill wicked-garden-alpha');
    // A blocked publish does not stale the caller's revision.
    expect(blocked.revision).toBe(r1.revision);

    // A `${CLAUDE_PLUGIN_ROOT}` reference to a file the bundle never carried blocks the same way.
    // The write itself is admitted with a WARNING (beta was portable; a plugin-root ref makes it
    // Claude-only) — resolvability is publish's question, not the file manager's.
    const r2 = s.store.enable('wicked-garden-alpha', blocked.revision);
    const r3 = s.store.writeFile('wicked-garden-beta', 'refs/extra.md', 'see `${CLAUDE_PLUGIN_ROOT}/scripts/missing.py`\n', r2.revision);
    expect(r3.verdict).toBe('warnings');
    expect(r3.findings.map((f) => f.kind)).toEqual(['non-portable']);
    expect(r3.skill?.portable).toBe(false);
    const again = s.store.publish(r3.revision);
    expect(again.verdict).toBe('blocked');
    expect(again.findings.find((f) => f.kind === 'unresolved-ref')).toMatchObject({
      skill: 'wicked-garden-beta',
      file: 'skills/beta/refs/extra.md',
      line: 1,
    });
    expect(again.findings.find((f) => f.kind === 'unresolved-ref')?.evidence).toContain('scripts/missing.py');
  });

  it('keeps the newest three generations and never the one just published', () => {
    s.store.seed();
    let rev = s.store.revision();
    for (let i = 0; i < 5; i += 1) {
      const r = s.store.publish(rev);
      expect(r.verdict).toBe('clear');
      rev = r.revision;
    }
    expect(s.store.generationsOnDisk()).toEqual([3, 4, 5]);
    expect(readlinkSync(join(s.root, 'current'))).toBe(join('snapshots', '000005'));
    expect(s.store.currentSnapshot()?.gen).toBe(5);
    expect(readdirSync(join(s.root, 'snapshots')).filter((e) => e.startsWith('.tmp'))).toEqual([]);
  });

  it('detects and reports direct filesystem edits by hash (fs-drift), never silently trusting them', () => {
    s.store.seed();
    writeFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), '---\nname: wicked-garden-gamma\n---\n\nedited on disk\n');
    const analyzed = s.store.analyze();
    expect(analyzed.findings.find((f) => f.kind === 'fs-drift')?.evidence).toContain('skills/gamma/SKILL.md');
    // Drift is a real state change: the revision moved and provenance reads override.
    expect(analyzed.revision).toBe(2);
    expect(s.store.manifest().skills['wicked-garden-gamma']?.provenance).toBe('override');
  });

  it('an unregistered SKILL.md placed on disk blocks (nested ownership, v3 §6)', () => {
    s.store.seed();
    mkdirSync(join(s.root, 'effective', 'skills', 'beta', 'rogue'), { recursive: true });
    writeFileSync(join(s.root, 'effective', 'skills', 'beta', 'rogue', 'SKILL.md'), '---\nname: wicked-garden-beta-rogue\n---\n');
    const r = s.store.publish(1);
    expect(r.verdict).toBe('blocked');
    expect(r.findings.find((f) => f.kind === 'unregistered-skill')?.evidence).toContain('skills/beta/rogue/SKILL.md');
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

  it('every mutation is CAS-guarded: a stale expectedRevision is refused and writes nothing', () => {
    s.store.seed();
    const ok = s.store.disable('wicked-garden-delta', 1);
    expect(ok.revision).toBe(2);
    expect(() => s.store.enable('wicked-garden-delta', 1)).toThrow(RevisionMismatchError);
    expect(() => s.store.writeFile('wicked-garden-gamma', 'SKILL.md', 'x', 1)).toThrow(RevisionMismatchError);
    expect(() => s.store.publish(1)).toThrow(RevisionMismatchError);
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

describe('skill-scoped containment (design v3 §API)', () => {
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

  it('refuses a nested skill\'s path through the parent\'s endpoint, and skills/ through the support endpoint', () => {
    expect(() => s.store.resolveSkillFile('wicked-garden-alpha', 'nested/SKILL.md')).toThrow(/belongs to the nested skill wicked-garden-alpha-nested/);
    expect(() => s.store.resolveSupportFile('skills/beta/SKILL.md')).toThrow(/addressed through \/skills\/:name\/files/);
    expect(s.store.resolveSupportFile('scripts/_python.sh').rel).toBe('scripts/_python.sh');
  });

  it('typed capped reads flag binary and serve the baseline side on request', async () => {
    writeFileSync(join(s.root, 'effective', 'skills', 'alpha', 'refs', 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    const bin = await s.store.readFile('wicked-garden-alpha', 'refs/blob.bin');
    expect(bin).toEqual({ binary: true, truncated: false, content: null, size: 4, path: 'skills/alpha/refs/blob.bin' });
    s.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\n---\n\nmine\n', 1);
    expect((await s.store.readFile('wicked-garden-gamma', 'SKILL.md')).content).toContain('mine');
    expect((await s.store.readFile('wicked-garden-gamma', 'SKILL.md', 'baseline')).content).toContain('Rank things');
    await expect(s.store.readFile('wicked-garden-gamma', 'nope.md')).rejects.toMatchObject({ code: 'ENOENT' });
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
    // Only the current baseline dir (and record) exists.
    expect(readdirSync(join(s.root, 'baseline'))).toEqual([r1.baseline]);
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

  it('adds upstream-new skills, removes upstream-deleted unmodified ones, keeps an upstream-deleted override as user-added, and flags a name collision', () => {
    s.store.seed();
    // User overrides epsilon; upstream deletes both delta (untouched) and epsilon (overridden),
    // adds zeta, and ships a skill named like a user-added one at a different dir.
    const added = s.store.add('wicked-garden-theta', { 'SKILL.md': '---\nname: wicked-garden-theta\n---\n\nmine\n' }, 1);
    const edited = s.store.writeFile('wicked-garden-epsilon', 'SKILL.md', '---\nname: wicked-garden-epsilon\n---\n\nkept\n', added.revision);
    rmSync(join(s.upstream, 'skills', 'delta'), { recursive: true });
    rmSync(join(s.upstream, 'skills', 'epsilon'), { recursive: true });
    upstreamWrite('skills/zeta/SKILL.md', '---\nname: wicked-garden-zeta\n---\n\nnew upstream\n');
    upstreamWrite('skills/other/theta/SKILL.md', '---\nname: wicked-garden-theta\n---\n\nupstream theta\n');
    const r = s.store.refreshBaseline(edited.revision);
    expect(r.added).toEqual(['wicked-garden-zeta']);
    expect(r.removed).toEqual(['wicked-garden-delta']);
    expect(r.conflicts).toEqual(['wicked-garden-theta']);
    expect(existsSync(join(s.root, 'effective', 'skills', 'delta'))).toBe(false);
    expect(existsSync(join(s.root, 'effective', 'skills', 'other'))).toBe(false); // held back
    const m = s.store.manifest();
    expect(m.skills['wicked-garden-epsilon']).toMatchObject({ provenance: 'user-added', enabled: true });
    expect(m.files['skills/epsilon/SKILL.md']?.baselineHash).toBeNull();
    expect(m.skills['wicked-garden-zeta']).toMatchObject({ provenance: 'shipped', enabled: true, dir: 'skills/zeta' });
    expect(m.skills['wicked-garden-theta']).toMatchObject({ dir: 'skills/theta', provenance: 'user-added', conflict: true });
    expect(r.findings.find((f) => f.kind === 'refresh-conflict' && f.skill === 'wicked-garden-theta')?.evidence).toContain('skills/other/theta');
    expect(readFileSync(join(s.root, 'effective', 'skills', 'theta', 'SKILL.md'), 'utf8')).toContain('mine');
  });

  it('a byte-identical upstream is a no-op that keeps the revision', () => {
    s.store.seed();
    const r = s.store.refreshBaseline(1);
    expect(r).toMatchObject({ verdict: 'clear', taken: [], kept: [], added: [], removed: [], revision: 1 });
    expect(r.baseline).toBe(r.previous_baseline);
  });
});
