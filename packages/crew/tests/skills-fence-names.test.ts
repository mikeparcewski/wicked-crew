// Design v3.5 §2 (codex round 8 on #480): EVERY name the store can ever create under `skills/` — the
// settled entries AND the transient ones a mutation creates for the width of one rename — is
// registered in the shared fence fixture `tests/fixtures/state-home-subtrees.json` (byte-identical in
// core), because core's worker fence REFUSES a launch naming a child it does not classify: a
// transient name missing from the registry is a live race between a mutation and a worker launch.
//
// Two guards keep the registry true:
//   1. STATIC — `src/skills/root-names.ts` `SKILLS_ROOT_NAMES` is the store's own table; the fixture's
//      `skills` entry must equal it (patterns AND kinds, both directions), and every root join the
//      store's source writes (`join(this.rootDir, …)`, `join(this.snapshotsDir(), …)`,
//      `containedPath(this.rootDir, […])`, the refusal sentinel) must resolve to a row of the table.
//   2. PAUSED OPERATION — `node:fs.renameSync` / `symlinkSync` / `rmSync` are wrapped for this file's
//      module graph, and at every such call under the root the children of `skills/` and of
//      `snapshots/` are recorded WITH the transient entries in existence; every recorded name must
//      classify, and every transient pattern must actually have been observed (the test sees the race
//      window, not only the settled state).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import type { PathLike } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({
  root: null as string | null,
  listings: [] as Array<{ at: string; children: string[]; slot: string[] }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { join: pjoin } = await import('node:path');
  /** Record the children of the root and of its `snapshots/` slot as they are at THIS moment. */
  const snapshot = (at: string): void => {
    const root = observed.root;
    if (root === null) return;
    let children: string[];
    try {
      children = actual.readdirSync(root).sort();
    } catch {
      return; // the root does not exist yet (before the seed)
    }
    let slot: string[] = [];
    try {
      slot = actual.readdirSync(pjoin(root, 'snapshots')).sort();
    } catch {
      slot = [];
    }
    observed.listings.push({ at, children, slot });
  };
  return {
    ...actual,
    renameSync: (from: PathLike, to: PathLike): void => {
      snapshot(`rename ${String(from)} -> ${String(to)}`);
      actual.renameSync(from, to);
    },
    symlinkSync: ((target: PathLike, path: PathLike, type?: Parameters<typeof actual.symlinkSync>[2]) => {
      actual.symlinkSync(target, path, type);
      snapshot(`symlink ${String(path)}`);
    }) as typeof actual.symlinkSync,
    rmSync: ((path: PathLike, options?: Parameters<typeof actual.rmSync>[1]) => {
      snapshot(`rm ${String(path)}`);
      actual.rmSync(path, options);
    }) as typeof actual.rmSync,
  };
});

import { readFileSync, writeFileSync } from 'node:fs';

import { ATOMIC_TMP_INFIX, CURRENT_TMP_PREFIX, REFUSED_DIRNAME, SKILLS_ROOT_NAMES, STAGING_PREFIX } from '../src/skills/root-names.js';
import { BASELINE_DIRNAME, CURRENT_LINKNAME, EFFECTIVE_DIRNAME, MANIFEST_FILENAME, SNAPSHOTS_DIRNAME } from '../src/skills/store.js';
import { UV_CACHE_DIRNAME } from '../src/skills/venv.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface SkillsEntry {
  name: string;
  read_slot: string;
  denied_children: string[];
  denied_children_kinds: Record<string, { kind: string; transient: boolean }>;
}
interface Registry {
  entries: Array<Partial<SkillsEntry> & { name?: string }>;
}

const registry = JSON.parse(readFileSync(join(HERE, 'fixtures', 'state-home-subtrees.json'), 'utf8')) as Registry;
const skillsEntry = registry.entries.find((e) => e.name === 'skills') as SkillsEntry;

/** Whether a `denied_children` pattern (`name`, or `dir/prefix-*`) covers a child path relative to `skills/`. */
const deniedBy = (childRel: string): boolean =>
  skillsEntry.denied_children.some((p) => (p.endsWith('*') ? childRel.startsWith(p.slice(0, -1)) : p === childRel));

/** Whether core's fence would classify a child of `skills/` (the read slot, or a denied child). */
const classifiesRootChild = (child: string): boolean => child === skillsEntry.read_slot || deniedBy(child);
/** Whether core's fence would classify a child of `skills/snapshots/` (a generation, or a denied child). */
const classifiesSlotChild = (child: string): boolean => /^\d{6}$/.test(child) || deniedBy(`${skillsEntry.read_slot}/${child}`);

describe('SKILLS_ROOT_NAMES is the fence fixture (static audit, design v3.5 §2)', () => {
  it("the store's table and the fixture's skills entry are the SAME set — every pattern, every kind, both directions — and the store's constants are the table's", () => {
    expect(skillsEntry).toBeDefined();
    expect(skillsEntry.read_slot).toBe(SNAPSHOTS_DIRNAME);
    const table = new Map(SKILLS_ROOT_NAMES.map((row) => [row.pattern, row]));
    for (const row of SKILLS_ROOT_NAMES) {
      if (row.pattern === skillsEntry.read_slot) {
        expect(row.kind).toBe('dir');
        expect(row.transient).toBe(false);
        continue;
      }
      expect(skillsEntry.denied_children, `${row.pattern} is a name the store creates but the fixture does not deny it`).toContain(row.pattern);
      expect(skillsEntry.denied_children_kinds[row.pattern], `${row.pattern} has no kind in the fixture`).toEqual({ kind: row.kind, transient: row.transient });
    }
    for (const pattern of skillsEntry.denied_children) {
      expect(table.has(pattern), `the fixture denies ${pattern}, which the store's table does not explain`).toBe(true);
    }
    expect(Object.keys(skillsEntry.denied_children_kinds).sort()).toEqual([...skillsEntry.denied_children].sort());
    // The store's constants ARE the table's rows: a renamed constant cannot silently leave the registry behind.
    const patterns = new Set(table.keys());
    for (const settled of [BASELINE_DIRNAME, EFFECTIVE_DIRNAME, MANIFEST_FILENAME, SNAPSHOTS_DIRNAME, CURRENT_LINKNAME, UV_CACHE_DIRNAME, REFUSED_DIRNAME]) {
      expect(patterns.has(settled), settled).toBe(true);
    }
    for (const transient of [`${STAGING_PREFIX}*`, `${MANIFEST_FILENAME}${ATOMIC_TMP_INFIX}*`, `${SNAPSHOTS_DIRNAME}/${STAGING_PREFIX}*`, `${SNAPSHOTS_DIRNAME}/${CURRENT_TMP_PREFIX}*`]) {
      expect(patterns.has(transient), transient).toBe(true);
      expect(table.get(transient)?.transient, transient).toBe(true);
    }
    // Every transient row is a deny — never the read slot.
    for (const row of SKILLS_ROOT_NAMES) if (row.transient) expect(row.pattern).not.toBe(skillsEntry.read_slot);
  });

  it('every root join the store writes in src/skills/store.ts (and the refusal sentinel in runtime.ts) resolves to a row of the table — an unregistered name fails here before it can race a launch', () => {
    const src = readFileSync(join(HERE, '..', 'src', 'skills', 'store.ts'), 'utf8');
    const table = new Set(SKILLS_ROOT_NAMES.map((row) => row.pattern));
    // `join(this.rootDir, X …)`, `join(this.snapshotsDir(), X …)`, `containedPath(this.rootDir, [X …])` —
    // X is a named constant, a template literal starting with a registered prefix, or a generation.
    const RE = /(?:join|containedPath)\(\s*this\.(rootDir|snapshotsDir\(\))\s*,\s*\[?\s*([^,\])]+)/g;
    const KNOWN: Record<string, string> = {
      EFFECTIVE_DIRNAME: EFFECTIVE_DIRNAME,
      BASELINE_DIRNAME: BASELINE_DIRNAME,
      SNAPSHOTS_DIRNAME: SNAPSHOTS_DIRNAME,
      CURRENT_LINKNAME: CURRENT_LINKNAME,
      UV_CACHE_DIRNAME: UV_CACHE_DIRNAME,
      MANIFEST_FILENAME: MANIFEST_FILENAME,
    };
    const resolve = (base: string, arg: string): string | null => {
      const known = KNOWN[arg];
      if (known !== undefined) return `${base}${known}`;
      if (arg.startsWith('`${STAGING_PREFIX}')) return `${base}${STAGING_PREFIX}*`;
      if (arg.startsWith('`${CURRENT_TMP_PREFIX}')) return `${base}${CURRENT_TMP_PREFIX}*`;
      if (base === `${SNAPSHOTS_DIRNAME}/` && (arg.startsWith('generationDirName') || arg === 'e')) return SNAPSHOTS_DIRNAME; // a generation under the slot
      if (arg === 'segments') return 'walked'; // `venvPaths`'s `walked([...])` — audited by the loop below
      return null;
    };
    let count = 0;
    for (const m of src.matchAll(RE)) {
      count += 1;
      const base = m[1] === 'rootDir' ? '' : `${SNAPSHOTS_DIRNAME}/`;
      const arg = (m[2] ?? '').trim();
      const pattern = resolve(base, arg);
      expect(pattern, `unregistered root join in store.ts: ${m[0]} — add the name to root-names.ts (and the fixture) first`).not.toBeNull();
      if (pattern !== null && pattern !== 'walked') expect(table.has(pattern), `${m[0]} resolves to ${pattern}, which is not a table row`).toBe(true);
    }
    expect(count).toBeGreaterThan(12);
    // `venvPaths` joins through `walked([...])`: each literal head must be a table row too.
    const walked = [...src.matchAll(/walked\(\[\s*([A-Z_]+)/g)].map((m) => m[1] ?? '');
    expect(walked.length).toBeGreaterThan(0);
    for (const head of walked) expect(table.has(KNOWN[head] ?? ''), `walked([${head} …]) is not a table row`).toBe(true);
    // The refusal sentinel is named under the root (never created) — and registered.
    const runtime = readFileSync(join(HERE, '..', 'src', 'skills', 'runtime.ts'), 'utf8');
    expect(runtime).toMatch(/join\(root, REFUSED_DIRNAME, kind\)/);
    expect(table.has(REFUSED_DIRNAME)).toBe(true);
    // The manifest commit's temp name is the table's: `<manifest>.tmp-<hex>`.
    const tree = readFileSync(join(HERE, '..', 'src', 'skills', 'tree.ts'), 'utf8');
    expect(tree).toMatch(/\$\{path\}\$\{ATOMIC_TMP_INFIX\}\$\{randomBytes/);
    expect(table.has(`${MANIFEST_FILENAME}${ATOMIC_TMP_INFIX}*`)).toBe(true);
  });
});

describe('paused operations: every child of skills/ and snapshots/ a launch could see mid-mutation classifies (design v3.5 §2)', () => {
  let s: Scaffold;

  beforeEach(() => {
    observed.listings.length = 0;
    s = scaffold();
    observed.root = s.root;
  });

  afterEach(() => {
    observed.root = null;
    removeScratch(s.base);
  });

  it('seed, publish, write, support write, replace, reset, refresh, publish again — at every rename/symlink/rm the transient names are IN EXISTENCE and every observed name is registered', async () => {
    s.store.seed();
    expect((await s.store.publish(1)).verdict).toBe('clear');
    let rev = s.store.revision();
    rev = s.store.writeFile('wicked-garden-alpha', 'SKILL.md', '---\nname: wicked-garden-alpha\n---\n\nedited\n', rev).revision;
    rev = s.store.writeSupport('scripts/_python.sh', '#!/bin/sh\necho edited\n', rev).revision;
    rev = s.store.replace('wicked-garden-gamma', { 'SKILL.md': '---\nname: wicked-garden-gamma\n---\n\nreplaced\n' }, rev).revision;
    rev = s.store.reset('wicked-garden-alpha', rev).revision;
    writeFileSync(join(s.upstream, 'skills', 'beta', 'SKILL.md'), '---\nname: wicked-garden-beta\n---\n\nupstream v2 wicked-garden-gamma\n');
    const refreshed = s.store.refreshBaseline(rev);
    expect(refreshed.verdict).toBe('clear');
    expect((await s.store.publish(refreshed.revision)).verdict).toBe('clear');

    expect(observed.listings.length).toBeGreaterThan(10);
    const rootChildren = new Set<string>();
    const slotChildren = new Set<string>();
    for (const l of observed.listings) {
      for (const child of l.children) {
        rootChildren.add(child);
        expect(classifiesRootChild(child), `unclassified child of skills/ at "${l.at}": ${child}`).toBe(true);
      }
      for (const child of l.slot) {
        slotChildren.add(child);
        expect(classifiesSlotChild(child), `unclassified child of skills/snapshots/ at "${l.at}": ${child}`).toBe(true);
      }
    }
    // The race window WAS observed: each transient pattern showed up at least once.
    const seen = (prefix: string, set: ReadonlySet<string>): boolean => [...set].some((c) => c.startsWith(prefix));
    for (const op of ['write', 'swap', 'reset', 'refresh']) expect(seen(`${STAGING_PREFIX}${op}-`, rootChildren), `${STAGING_PREFIX}${op}-* never observed`).toBe(true);
    expect(seen(`${MANIFEST_FILENAME}${ATOMIC_TMP_INFIX}`, rootChildren), 'manifest.json.tmp-* never observed').toBe(true);
    expect(seen(STAGING_PREFIX, slotChildren), 'snapshots/.staging-* never observed').toBe(true);
    expect(seen(CURRENT_TMP_PREFIX, slotChildren), 'snapshots/.tmp-current-* never observed').toBe(true);
    // And after everything settled, only settled names remain.
    const final = observed.listings[observed.listings.length - 1] as { children: string[]; slot: string[] };
    for (const child of final.children) expect(child.startsWith(STAGING_PREFIX) || child.includes(ATOMIC_TMP_INFIX)).toBe(false);
  });
});
