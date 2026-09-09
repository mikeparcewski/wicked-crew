// The atomic `current` relink never leaves an UNCLASSIFIED child under `skills/` (core#399 round 4,
// design v3.3 §1): core's launch-time fence lists every child of `<stateHome>/skills/` and refuses a
// launch naming any entry `tests/fixtures/state-home-subtrees.json` does not classify. The former
// flip created `skills/current.tmp-<hex>` — unclassified for the width of one `rename()`. Now the
// transient link is created INSIDE `snapshots/` as `.tmp-current-<hex>` (a `snapshots/.tmp-*`
// entry core accepts there) and renamed over `skills/current`.
//
// Observed at the exact moment it matters: `node:fs.renameSync` is wrapped for this file's module
// graph, and when the destination is `skills/current` the children of `skills/` — WITH the
// transient link in existence — are recorded and checked against the registry's names.

import type { PathLike } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flips = vi.hoisted(() => ({
  observed: [] as Array<{ from: string; to: string; skillsChildren: string[]; fromIsLink: boolean }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: PathLike, to: PathLike): void => {
      const dest = String(to);
      if (basename(dest) === 'current') {
        flips.observed.push({
          from: String(from),
          to: dest,
          skillsChildren: actual.readdirSync(dirname(dest)).sort(),
          fromIsLink: actual.lstatSync(String(from)).isSymbolicLink(),
        });
      }
      actual.renameSync(from, to);
    },
  };
});

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

import { CURRENT_TMP_PREFIX } from '../src/skills/store.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

interface Registry {
  entries: Array<{ name?: string; read_slot?: string; denied_children?: string[] }>;
}

/** The names the registry classifies as children of `skills/` (the fence refuses anything else). */
function registeredSkillsChildren(): Set<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const registry = JSON.parse(readFileSync(join(here, 'fixtures', 'state-home-subtrees.json'), 'utf8')) as Registry;
  const skills = registry.entries.find((e) => e.name === 'skills');
  if (skills === undefined) throw new Error('the registry has no skills entry');
  const out = new Set<string>();
  if (skills.read_slot !== undefined) out.add(skills.read_slot);
  for (const child of skills.denied_children ?? []) if (!child.includes('/')) out.add(child);
  return out;
}

let s: Scaffold;

beforeEach(() => {
  flips.observed.length = 0;
  s = scaffold();
  s.store.seed();
});

afterEach(() => {
  removeScratch(s.base);
});

describe('the `current` flip (core#399 round 4)', () => {
  it('creates the transient link INSIDE snapshots/ as .tmp-current-<hex> and renames it over skills/current — the only children of skills/ during a publish are the registered names', async () => {
    const registered = registeredSkillsChildren();
    expect(registered).toEqual(new Set(['snapshots', 'baseline', 'effective', 'manifest.json', 'current', '.uv-cache']));
    // Two publishes: the first creates `current`, the second flips over an existing one.
    expect((await s.store.publish(1)).verdict).toBe('clear');
    expect((await s.store.publish(s.store.revision())).verdict).toBe('clear');
    expect(flips.observed).toHaveLength(2);
    for (const flip of flips.observed) {
      expect(flip.to).toBe(join(s.root, 'current'));
      // The transient link lives in snapshots/ under a name core classifies (`snapshots/.tmp-*`).
      expect(dirname(flip.from)).toBe(join(s.root, 'snapshots'));
      expect(basename(flip.from)).toMatch(new RegExp(`^${CURRENT_TMP_PREFIX.replace(/[.]/g, '\\.')}[0-9a-f]{12}$`));
      expect(flip.fromIsLink).toBe(true);
      // At that very moment, skills/ holds ONLY registered names — no `current.tmp-*`, nothing unclassified.
      for (const child of flip.skillsChildren) expect(registered.has(child), `unclassified child of skills/ during the flip: ${child}`).toBe(true);
      expect(flip.skillsChildren.some((c) => c.startsWith('current.'))).toBe(false);
    }
    // Landed: `current` points at the newest generation; no transient link lingers in snapshots/.
    expect(readlinkSync(join(s.root, 'current'))).toBe(join('snapshots', '000002'));
    expect(readdirSync(join(s.root, 'snapshots')).filter((e) => e.startsWith('.'))).toEqual([]);
    expect(s.store.currentSnapshot()?.gen).toBe(2);
    // And after the publish, skills/ still holds only registered names.
    for (const child of readdirSync(s.root)) expect(registered.has(child), `unclassified child of skills/: ${child}`).toBe(true);
  });
});
