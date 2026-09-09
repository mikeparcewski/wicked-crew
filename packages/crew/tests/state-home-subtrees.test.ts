// Design v3.1 §1 — the worker Read fence is an EXPLICIT denylist of state-home subtrees, and
// `tests/fixtures/state-home-subtrees.json` is its registry (mirrored by wicked-core's tests). Two
// guards make the registry self-defending:
//
//   1. STATIC: every `join(<state home>, '<entry>')` in src/ — `crewStateHome()`, the interactive
//      seams' `defaultStateDir()`, server.ts's `crewStateDir`, the CLI's `stateHome()` /
//      `stateHomeOfDb(...)` — names a registered entry. A new store that writes under the state
//      home fails this test until it is registered (and therefore fenced by core).
//   2. DYNAMIC: a REAL `createServer` boot over a scratch state home (every per-store env override
//      cleared so each store resolves its default) creates nothing at the top level that the
//      registry does not classify.
//
// The fence itself is core's (one deny rule per entry, `skills/snapshots/<gen>/` the only read
// root); crew's job is that the list is complete and true. The file is byte-identical to the copy
// core embeds (`src/state_home.rs`, `include_str!`): the `skills` entry's `read_slot` /
// `denied_children` are the machine-readable half core enforces — checked here against the store's
// own constants AND against what a booted daemon actually creates under `skills/`.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../src/api/server.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { DEFAULT_SETTINGS, type DiagnosticsResponse } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { CREW_STATE_HOME_ENGINE_ENV, SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { pluginSourceAt } from '../src/skills/plugin-source.js';
import {
  BASELINE_DIRNAME,
  CURRENT_LINKNAME,
  EFFECTIVE_DIRNAME,
  MANIFEST_FILENAME,
  SKILLS_DIRNAME,
  SNAPSHOTS_DIRNAME,
} from '../src/skills/store.js';
import { noVenv, UV_CACHE_DIRNAME } from '../src/skills/venv.js';
import { removeScratch } from './setup/scratch.js';
import { FIXTURE_PLUGIN } from './support/skills-fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const REGISTRY_PATH = join(HERE, 'fixtures', 'state-home-subtrees.json');

interface RegistryEntry {
  name?: string;
  prefix?: string;
  kind: string;
  owner: 'crew' | 'engine' | 'operator';
  source: string;
  worker_read: string;
  /** The ONE child a worker may read beneath (its resolved generation only) — the skills entry. */
  read_slot?: string;
  /** Children core denies by rule; `x/y-*` is a prefix glob for entries under child `x`. */
  denied_children?: string[];
}
interface Registry {
  version: number;
  entries: RegistryEntry[];
}

const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;

/** The registry entry that classifies a top-level name, or `null`. */
function classify(topLevel: string): RegistryEntry | null {
  for (const e of registry.entries) {
    if (e.name !== undefined && e.name === topLevel) return e;
    if (e.prefix !== undefined && topLevel.startsWith(e.prefix)) return e;
  }
  return null;
}

/** Whether a `denied_children` pattern (`name`, or `dir/prefix-*`) covers a child path relative to the entry. */
function deniedBy(patterns: ReadonlyArray<string>, childRel: string): boolean {
  return patterns.some((p) => (p.endsWith('*') ? childRel.startsWith(p.slice(0, -1)) : p === childRel));
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

// `join(<state-home expression>, <first arg>)` — the first arg is a string literal or an identifier.
const STATE_HOME_JOIN_RE =
  /join\(\s*(?:crewStateHome\(\)|defaultStateDir\(\)|crewStateDir|stateHome\(\)|stateHomeOfDb\([^)]*\))\s*,\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g;

/** Identifiers a state-home join may name instead of a literal — resolved here so the audit stays exact. */
const KNOWN_CONSTANTS: Record<string, string> = { SKILLS_DIRNAME };

describe('state-home-subtrees.json — the registry itself', () => {
  it('is well-formed: version 1, every entry has exactly one of name/prefix, an owner, a source and a worker_read verdict; names are unique', () => {
    expect(registry.version).toBe(1);
    expect(registry.entries.length).toBeGreaterThan(0);
    const keys = new Set<string>();
    for (const e of registry.entries) {
      expect((e.name === undefined) !== (e.prefix === undefined), JSON.stringify(e)).toBe(true);
      expect(['crew', 'engine', 'operator']).toContain(e.owner);
      expect(e.source.length).toBeGreaterThan(0);
      expect(e.worker_read.length).toBeGreaterThan(0);
      const key = e.name ?? `${e.prefix}*`;
      expect(keys.has(key), `duplicate registry key ${key}`).toBe(false);
      keys.add(key);
    }
    // The skills root is registered, and its worker_read names the snapshot as the ONLY readable path.
    const skills = classify(SKILLS_DIRNAME);
    expect(skills?.owner).toBe('crew');
    expect(skills?.worker_read).toMatch(/snapshots\/<gen>\/.*only/);
  });

  it("the skills entry's machine-readable half (core's `read_slot` / `denied_children`) names the store's own layout: the snapshots slot is readable, every other child the store creates is denied", () => {
    const skills = classify(SKILLS_DIRNAME) as RegistryEntry;
    expect(skills.read_slot).toBe(SNAPSHOTS_DIRNAME);
    const denied = skills.denied_children ?? [];
    for (const child of [BASELINE_DIRNAME, EFFECTIVE_DIRNAME, MANIFEST_FILENAME, CURRENT_LINKNAME, UV_CACHE_DIRNAME]) {
      expect(deniedBy(denied, child), `${child} must be a denied child of skills/`).toBe(true);
    }
    // Torn staging under the slot is denied too (a half-written generation is never a read root).
    expect(deniedBy(denied, `${SNAPSHOTS_DIRNAME}/.staging-abc123`)).toBe(true);
    expect(deniedBy(denied, `${SNAPSHOTS_DIRNAME}/.tmp-abc123`)).toBe(true);
    // …while a generation directory under the slot is NOT denied — it is what the worker reads.
    expect(deniedBy(denied, `${SNAPSHOTS_DIRNAME}/000001`)).toBe(false);
    // No other entry claims a read slot: the snapshot is the ONLY non-denied path under the state home.
    for (const e of registry.entries) {
      if (e.name === SKILLS_DIRNAME) continue;
      expect(e.read_slot, `${e.name ?? e.prefix} must not open a read slot`).toBeUndefined();
      expect(e.denied_children).toBeUndefined();
    }
  });
});

describe('STATIC — every state-home join in src/ names a registered entry', () => {
  it('finds the joins and classifies each first path segment', () => {
    const seen: Array<{ file: string; entry: string }> = [];
    const unregistered: string[] = [];
    for (const file of tsFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(STATE_HOME_JOIN_RE)) {
        const identifier = m[3];
        let arg: string;
        if (identifier !== undefined) {
          const resolved = KNOWN_CONSTANTS[identifier];
          expect(resolved, `${relative(SRC, file)}: join(<state home>, ${identifier}) — add ${identifier} to KNOWN_CONSTANTS so the audit can resolve it`).toBeDefined();
          arg = resolved as string;
        } else {
          arg = (m[1] ?? m[2]) as string;
        }
        const top = arg.split('/')[0] as string;
        seen.push({ file: relative(SRC, file), entry: top });
        if (classify(top) === null) unregistered.push(`${relative(SRC, file)}: ${top}`);
      }
    }
    // The audit must actually be looking at something — the known stores are all here.
    const entries = new Set(seen.map((s) => s.entry));
    for (const expected of ['skills', 'audit.log', 'evals', 'project-graphs', 'project-settings.json', 'interactive-draft-ledger.json', 'core.db', 'bus.db']) {
      expect(entries.has(expected), `expected the src/ scan to find a state-home join for ${expected}`).toBe(true);
    }
    expect(
      unregistered,
      'these src/ joins write under the state home but are not in tests/fixtures/state-home-subtrees.json — ' +
        'register them (core mirrors the file to fence them from workers)',
    ).toEqual([]);
  });

  it('every crew-owned registry entry is backed by a join the scan found (the list carries no dead weight)', () => {
    const found = new Set<string>();
    for (const file of tsFiles(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(STATE_HOME_JOIN_RE)) {
        const arg = m[3] !== undefined ? (KNOWN_CONSTANTS[m[3]] ?? m[3]) : ((m[1] ?? m[2]) as string);
        found.add(arg.split('/')[0] as string);
      }
    }
    for (const e of registry.entries) {
      if (e.owner !== 'crew') continue;
      const key = e.name ?? (e.prefix as string);
      expect([...found].some((f) => f === key || f.startsWith(key)), `registry entry ${key} (crew) has no join in src/`).toBe(true);
    }
  });
});

describe('DYNAMIC — a booted daemon creates nothing under the state home the registry does not classify', () => {
  // (No skills-root override to clear: the root has none — `<state home>/skills`, codex round 5.)
  const OVERRIDES = ['WICKED_CREW_AUDIT_LOG', 'WICKED_CREW_PROJECT_GRAPH_ROOT', 'WICKED_CREW_PROJECT_SETTINGS'] as const;
  const saved = new Map<string, string | undefined>();
  /** The state home the harness armed — restored after (never unset: an unset window is the disease, crew#396). */
  const armedStateHome = crewStateHome();
  let scratch: string;
  let stateHome: string;
  let adapter: CoreAdapter;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-state-home-'));
    stateHome = join(scratch, 'state-home');
    // Every per-store override is cleared for the duration so each store resolves ITS DEFAULT under
    // the configured state home — which is this scratch dir, never the operator's real one.
    for (const k of OVERRIDES) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    setCrewStateHome(stateHome);
    expect(crewStateHome()).toBe(stateHome);
    adapter = new CoreAdapter({ dbPath: join(stateHome, 'core.db'), stub: true });
    adapter.listWorkflows = () => [];
    adapter.getSettings = async () => ({ ...DEFAULT_SETTINGS });
    app = await createServer(adapter, {
      auth: { mode: 'off' },
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      studioRoot: join(scratch, 'no-studio'),
      skills: { source: () => pluginSourceAt(FIXTURE_PLUGIN), provisionVenv: noVenv },
    });
    await app.ready();
    // Touch the settings + skills surfaces so lazily-created stores land too.
    await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { graphNodeLimit: 120 } });
    await app.inject({ method: 'GET', url: '/api/v1/skills' });
    await app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
  });

  afterAll(async () => {
    await app.close();
    adapter.close();
    setCrewStateHome(armedStateHome);
    for (const k of OVERRIDES) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    removeScratch(scratch);
  });

  it('classifies every top-level entry the boot created, and the skills root is among them', () => {
    const created = readdirSync(stateHome).sort();
    expect(created.length).toBeGreaterThan(0);
    expect(created).toContain(SKILLS_DIRNAME);
    const unclassified = created.filter((e) => classify(e) === null);
    expect(
      unclassified,
      `the daemon created ${JSON.stringify(unclassified)} under the state home — register them in tests/fixtures/state-home-subtrees.json (workers are fenced from the state home by that list)`,
    ).toEqual([]);
    // The skills root's fence is real: the published snapshot exists, and EVERY child the store created
    // under `skills/` is either the read slot or a denied child of core's machine-readable list — a
    // new child the store started writing would fail here until core's rule set names it.
    const skills = classify(SKILLS_DIRNAME) as RegistryEntry;
    const skillsEntries = readdirSync(join(stateHome, SKILLS_DIRNAME)).sort();
    expect(skillsEntries).toEqual(expect.arrayContaining(['baseline', 'current', 'effective', 'manifest.json', 'snapshots']));
    const unfenced = skillsEntries.filter((child) => child !== skills.read_slot && !deniedBy(skills.denied_children ?? [], child));
    expect(unfenced, `children of skills/ that are neither the read slot nor denied: ${JSON.stringify(unfenced)} — register them in the shared registry (core enforces it)`).toEqual([]);
    // Under the slot: only generation dirs (readable when handed out) and denied torn-staging names.
    const slotEntries = readdirSync(join(stateHome, SKILLS_DIRNAME, skills.read_slot as string));
    for (const child of slotEntries) {
      expect(/^\d{6}$/.test(child) || deniedBy(skills.denied_children ?? [], `${skills.read_slot}/${child}`), child).toBe(true);
    }
    expect(process.env['WICKED_SKILLS_SNAPSHOT']?.startsWith(join(stateHome, SKILLS_DIRNAME, 'snapshots')) || process.env['WICKED_SKILLS_SNAPSHOT']?.includes(`/${SKILLS_DIRNAME}/snapshots/`)).toBe(true);
  });

  it('hands the engine the fenced state home beside the snapshot, and the snapshot IS <state home>/skills/snapshots/<gen> — core\'s cross-check passes, no warning (core#399 round 3)', async () => {
    const canonical = realpathSync(stateHome);
    expect(process.env[CREW_STATE_HOME_ENGINE_ENV]).toBe(canonical);
    expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]?.startsWith(join(canonical, SKILLS_DIRNAME, SNAPSHOTS_DIRNAME) + '/')).toBe(true);
    const skills = ((await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse).skills;
    expect(skills).toMatchObject({ state: 'published', stateHome: canonical, engineInput: process.env[SKILLS_SNAPSHOT_ENGINE_ENV], findings: [] });
  });
});
