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
// root); crew's job is that the list is complete and true.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../src/api/server.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { DEFAULT_SETTINGS } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { pluginSourceAt } from '../src/skills/plugin-source.js';
import { SKILLS_DIRNAME, SKILLS_ROOT_ENV } from '../src/skills/store.js';
import { noVenv } from '../src/skills/venv.js';
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
  const OVERRIDES = [SKILLS_ROOT_ENV, 'WICKED_CREW_AUDIT_LOG', 'WICKED_CREW_PROJECT_GRAPH_ROOT', 'WICKED_CREW_PROJECT_SETTINGS'] as const;
  const saved = new Map<string, string | undefined>();
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
      skills: { source: () => pluginSourceAt(FIXTURE_PLUGIN), mirrorHome: join(scratch, 'mirror-home'), provisionVenv: noVenv },
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
    setCrewStateHome(undefined);
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
    // The skills root's fence is real: the published snapshot exists and everything else under `skills/` is denied by the registry's verdict.
    const skillsEntries = readdirSync(join(stateHome, SKILLS_DIRNAME)).sort();
    expect(skillsEntries).toEqual(expect.arrayContaining(['baseline', 'current', 'effective', 'manifest.json', 'snapshots']));
    expect(process.env['WICKED_SKILLS_SNAPSHOT']?.startsWith(join(stateHome, SKILLS_DIRNAME, 'snapshots')) || process.env['WICKED_SKILLS_SNAPSHOT']?.includes(`/${SKILLS_DIRNAME}/snapshots/`)).toBe(true);
  });
});
