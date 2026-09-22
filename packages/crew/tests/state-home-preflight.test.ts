// The state-home PREFLIGHT (wicked-core#411 / crew#497; acceptance findings F-RC1-011, F-RC2-020,
// F-032/F-033): the pure rules `projects/state-home-preflight.ts` states once for the boot, the
// routes and the CLI —
//
//   1. a `WICKED_*` root variable pointed inside the state home is a configuration error the boot
//      refuses (the rig's `WICKED_WORKFLOWS_DIR=<state home>/workflows`);
//   2. the SURVEY names EVERY entry the registry cannot classify — top level and skills root — at
//      once (core's fence stops at the first: removing `interactive` only moved the rig's refusal to
//      `workflows`), through the engine when the addon carries `Core.preflightStateHome` and through
//      crew's registry copy otherwise, never a fabricated clean answer;
//   3. the `POST /runs` 409 body is the typed error — entries and remedy as fields — and the engine's
//      own intake refusal is recognised so it maps onto the same 409.
//
// Every message is in operator terms: the entry, the state home, the variable, what to do — and none
// cites a repository test-fixture path (F-033). The route half is tests/state-home-routes.test.ts.

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertWickedRootsOutsideStateHome,
  isEngineStateHomeRefusal,
  STATE_HOME_BLOCKER_CODE,
  STATE_HOME_FINDING_KIND,
  STATE_HOME_REMEDY,
  STATE_HOME_ROOT_ENVS,
  canonicalize,
  stateHomeBlockerBody,
  stateHomeOfSnapshot,
  StateHomePlacementError,
  StateHomeWatch,
  surveyStateHome,
  type UnregisteredStateHomeEntry,
} from '../src/projects/state-home-preflight.js';
import { removeScratch } from './setup/scratch.js';

const scratches: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-state-home-preflight-'));
  scratches.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratches.splice(0)) removeScratch(dir);
});

/** A state home with a published generation and the stores a booted daemon creates — all registered. */
function cleanStateHome(base: string): { home: string; snapshot: string } {
  const home = join(base, 'crew-state');
  const snapshot = join(home, 'skills', 'snapshots', '000007');
  mkdirSync(snapshot, { recursive: true });
  mkdirSync(join(home, 'skills', 'effective'));
  mkdirSync(join(home, 'skills', 'baseline'));
  writeFileSync(join(home, 'skills', 'manifest.json'), '{}', 'utf8');
  writeFileSync(join(home, 'core.db'), 'db', 'utf8');
  writeFileSync(join(home, 'core.db-wal'), 'wal', 'utf8');
  writeFileSync(join(home, 'bus.db'), 'bus', 'utf8');
  writeFileSync(join(home, 'audit.log'), '', 'utf8');
  writeFileSync(join(home, 'project-settings.json'), '{}', 'utf8');
  mkdirSync(join(home, 'evals'));
  mkdirSync(join(home, 'project-graphs'));
  mkdirSync(join(home, 'repo-graphs'));
  mkdirSync(join(home, 'interactive-drafts'));
  mkdirSync(join(home, 'daemon-12345'));
  // The three env-placed names (registered in both fixtures, wicked-core#411): fenced when present,
  // never a refusal.
  for (const placed of ['workflows', 'steering-inbox', 'interactive']) mkdirSync(join(home, placed));
  return { home, snapshot };
}

const NO_FIXTURE_PATH = /tests\/fixtures|state-home-subtrees\.json/;

describe('assertWickedRootsOutsideStateHome — the boot refusal (F-RC1-011)', () => {
  const home = '/srv/wicked/state';

  it('passes when every root variable is unset, empty, or points OUTSIDE the state home (the defaults)', () => {
    expect(() => assertWickedRootsOutsideStateHome({}, home)).not.toThrow();
    expect(() =>
      assertWickedRootsOutsideStateHome(
        {
          WICKED_WORKFLOWS_DIR: '',
          WICKED_STEERING_INBOX_DIR: '/home/op/.wicked/steering-inbox',
          WICKED_INTERACTIVE_ROOT: '/home/op/wicked-interactive/docs',
        },
        home,
      ),
    ).not.toThrow();
    // A sibling whose name merely STARTS with the state home is outside it.
    expect(() => assertWickedRootsOutsideStateHome({ WICKED_WORKFLOWS_DIR: `${home}-workflows` }, home)).not.toThrow();
  });

  it("refuses each variable pointed inside the state home — naming the variable, its value, the top-level entry it would create, and the remedy; never a fixture path", () => {
    for (const { variable } of STATE_HOME_ROOT_ENVS) {
      let thrown: unknown;
      try {
        assertWickedRootsOutsideStateHome({ [variable]: join(home, 'placed', 'deeper') }, home);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, variable).toBeInstanceOf(StateHomePlacementError);
      const e = thrown as StateHomePlacementError;
      expect(e.variable).toBe(variable);
      expect(e.value).toBe(join(home, 'placed', 'deeper'));
      expect(e.stateHome).toBe(home);
      expect(e.entry).toBe('placed');
      expect(e.message).toContain(`${variable}=${join(home, 'placed', 'deeper')}`);
      expect(e.message).toContain('`placed`');
      expect(e.message).toContain('Refusing to start');
      expect(e.message).toContain(`point ${variable} at a directory OUTSIDE ${home}`);
      expect(e.message).not.toMatch(NO_FIXTURE_PATH);
    }
  });

  it("the rig's shape: WICKED_WORKFLOWS_DIR=<state home>/workflows is refused before anything is seeded there", () => {
    expect(() => assertWickedRootsOutsideStateHome({ WICKED_WORKFLOWS_DIR: join(home, 'workflows') }, home)).toThrow(
      StateHomePlacementError,
    );
  });

  it('WICKED_INTERACTIVE_ROOT is NOT refused inside the state home since 0.7.35 — the interactive default lives there (D-L7-1 / BC-49)', () => {
    expect(STATE_HOME_ROOT_ENVS.map((r) => r.variable)).not.toContain('WICKED_INTERACTIVE_ROOT');
    // The very path the unset default resolves to (an operator spelling it out is not an error) —
    // and any other path inside the state home.
    expect(() => assertWickedRootsOutsideStateHome({ WICKED_INTERACTIVE_ROOT: join(home, 'interactive', 'docs') }, home)).not.toThrow();
    expect(() => assertWickedRootsOutsideStateHome({ WICKED_INTERACTIVE_ROOT: join(home, 'anywhere') }, home)).not.toThrow();
  });

  it('the state home ITSELF as a root is refused too, and says so', () => {
    let thrown: unknown;
    try {
      assertWickedRootsOutsideStateHome({ WICKED_WORKFLOWS_DIR: home }, home);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StateHomePlacementError);
    expect((thrown as StateHomePlacementError).entry).toBe('(the state home itself)');
  });

  it('judges the RESOLVED path, so a relative or dotted spelling inside the state home is still refused', () => {
    expect(() =>
      assertWickedRootsOutsideStateHome({ WICKED_STEERING_INBOX_DIR: join(home, 'x', '..', 'inbox') }, home),
    ).toThrow(StateHomePlacementError);
  });

  it('judges the REAL path (W1 of crew#555): a symlinked state home with WICKED_WORKFLOWS_DIR under its real spelling — a child that does NOT exist yet — is refused', () => {
    // crew creates WICKED_WORKFLOWS_DIR AFTER this preflight (registerWorkflow seeds it at boot), so
    // the target must be judged before it exists; core's fence canonicalises once it does, and a
    // spelled-path comparison here booted green and refused every launch at intake.
    const base = scratch();
    const real = join(base, 'real-state');
    mkdirSync(real);
    const link = join(base, 'state-link');
    symlinkSync(real, link, 'dir');
    const notYet = join(realpathSync.native(real), 'workflows');
    let thrown: unknown;
    try {
      assertWickedRootsOutsideStateHome({ WICKED_WORKFLOWS_DIR: notYet }, link);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StateHomePlacementError);
    expect((thrown as StateHomePlacementError).entry).toBe('workflows');
    // And the other way round: the variable spelled through the link, the state home by its real path.
    expect(() => assertWickedRootsOutsideStateHome({ WICKED_WORKFLOWS_DIR: join(link, 'workflows') }, real)).toThrow(
      StateHomePlacementError,
    );
    // A sibling reached through a DIFFERENT link is still outside.
    const other = join(base, 'other');
    mkdirSync(other);
    symlinkSync(other, join(base, 'other-link'), 'dir');
    expect(() => assertWickedRootsOutsideStateHome({ WICKED_WORKFLOWS_DIR: join(base, 'other-link', 'workflows') }, link)).not.toThrow();
  });

  it('crew#569: WICKED_CREW_SYSTEM_SETTINGS pointed under the state home is refused at BOOT, naming the file (refuse-only — no registry row)', () => {
    const base = scratch();
    const { home: stateHome } = cleanStateHome(base);
    let thrown: unknown;
    try {
      assertWickedRootsOutsideStateHome({ WICKED_CREW_SYSTEM_SETTINGS: join(stateHome, 'settings.json') }, stateHome);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StateHomePlacementError);
    const e = thrown as StateHomePlacementError;
    expect(e.variable).toBe('WICKED_CREW_SYSTEM_SETTINGS');
    expect(e.entry).toBe('settings.json');
    expect(e.message).toContain('`settings.json`');
    expect(e.message).toContain('PUT /settings');
    expect(e.message).not.toMatch(NO_FIXTURE_PATH);
    // The default (outside) and a sibling are fine; the row is refuse-only.
    expect(() => assertWickedRootsOutsideStateHome({ WICKED_CREW_SYSTEM_SETTINGS: join(base, 'settings.json') }, stateHome)).not.toThrow();
    expect(STATE_HOME_ROOT_ENVS.find((r) => r.variable === 'WICKED_CREW_SYSTEM_SETTINGS')?.fenced).toBe(false);
    // Two fenced variables since crew 0.7.35 (D-L7-1 / BC-49): WICKED_INTERACTIVE_ROOT left the list —
    // the interactive default is a registered JOIN entry inside the state home, not an env placement.
    expect(STATE_HOME_ROOT_ENVS.filter((r) => r.fenced).map((r) => r.variable)).toEqual([
      'WICKED_WORKFLOWS_DIR',
      'WICKED_STEERING_INBOX_DIR',
    ]);
  });

  it('canonicalize: realpaths the deepest EXISTING ancestor and re-joins the rest; no existing ancestor ⇒ the resolved spelling', () => {
    const base = scratch();
    const real = join(base, 'real');
    mkdirSync(real);
    const link = join(base, 'link');
    symlinkSync(real, link, 'dir');
    const realBase = realpathSync.native(real);
    expect(canonicalize(join(link, 'a', 'b', 'c.json'))).toBe(join(realBase, 'a', 'b', 'c.json'));
    expect(canonicalize(link)).toBe(realBase);
    expect(canonicalize(join(link, 'x', '..', 'y'))).toBe(join(realBase, 'y'));
    // Nothing of it exists: the resolved spelling, never a throw.
    const nowhere = join(base, 'gone', 'deeper');
    expect(canonicalize(nowhere)).toBe(join(realpathSync.native(base), 'gone', 'deeper'));
  });
});

describe('surveyStateHome — crew’s own classification (the fallback for an addon without Core.preflightStateHome)', () => {
  it('a fully registered state home — sidecars, the env-placed names, a daemon- prefix, the skills root’s own children — surveys clean', () => {
    const { home } = cleanStateHome(scratch());
    expect(surveyStateHome(home)).toEqual([]);
  });

  it('names EVERY unregistered entry at once, sorted as listed, with its level — top level and skills root', () => {
    const { home } = cleanStateHome(scratch());
    // The live daemon's debris shape (F-RC2-020), a stray file, and a scratch dir under skills/.
    mkdirSync(join(home, 'skills.fixture-debris-20260909'));
    writeFileSync(join(home, 'stray.txt'), '', 'utf8');
    mkdirSync(join(home, 'skills', 'scratch'));
    const found = surveyStateHome(home);
    expect(found.map((u) => [u.name, u.level])).toEqual([
      ['skills.fixture-debris-20260909', 'state-home'],
      ['stray.txt', 'state-home'],
      ['scratch', 'skills-root'],
    ]);
    expect(found[2]?.path).toBe(join(home, 'skills', 'scratch'));
    // Debris is deliberately NOT patterned (wicked-core#411): a quarantine-by-rename INSIDE the state
    // home is exactly what the fence must refuse — and a `.bak` of a registered name is unregistered.
    mkdirSync(join(home, 'workflows.bak'));
    expect(surveyStateHome(home).map((u) => u.name)).toContain('workflows.bak');
  });

  it('transient skills-root names a parked crew mutation creates are registered, not findings', () => {
    const { home } = cleanStateHome(scratch());
    mkdirSync(join(home, 'skills', '.staging-swap-abc123'));
    writeFileSync(join(home, 'skills', 'manifest.json.tmp-abc123'), '', 'utf8');
    expect(surveyStateHome(home)).toEqual([]);
  });

  it('with no skills root only the top level is surveyed', () => {
    const base = scratch();
    const home = join(base, 'bare');
    mkdirSync(home);
    writeFileSync(join(home, 'core.db'), 'db', 'utf8');
    writeFileSync(join(home, 'stray.txt'), '', 'utf8');
    expect(surveyStateHome(home).map((u) => u.name)).toEqual(['stray.txt']);
  });

  it('throws when the state home cannot be listed (the watch turns that into an `error`, never a clean answer)', () => {
    expect(() => surveyStateHome(join(scratch(), 'absent'))).toThrow();
  });
});

describe('stateHomeOfSnapshot — the state home a handed snapshot derives, by shape alone', () => {
  it('<state home>/skills/snapshots/<gen> → <state home>; anything else → null', () => {
    expect(stateHomeOfSnapshot('/srv/state/skills/snapshots/000007')).toBe('/srv/state');
    expect(stateHomeOfSnapshot('/srv/state/skills/snapshots/000007/')).toBe('/srv/state');
    expect(stateHomeOfSnapshot('/srv/state/skills/snapshots/42')).toBe('/srv/state');
    expect(stateHomeOfSnapshot('/srv/state/skills/effective')).toBeNull(); // not a generation
    expect(stateHomeOfSnapshot('/srv/state/skills/snapshots/.staging-abc')).toBeNull(); // torn staging
    expect(stateHomeOfSnapshot('/srv/state/other/snapshots/000007')).toBeNull(); // not the skills root
    expect(stateHomeOfSnapshot('/srv/state/skills/current/000007')).toBeNull(); // not the read slot
    expect(stateHomeOfSnapshot('')).toBeNull();
  });
});

/** The JSON `Core.preflightStateHome` resolves to (wicked-core `StateHomePreflight`, camelCase). */
function engineJson(over: Record<string, unknown>): string {
  return JSON.stringify({
    stateHome: '/srv/state',
    derivedFrom: 'snapshot',
    unregistered: [],
    refusesLaunches: false,
    error: null,
    remedy: STATE_HOME_REMEDY,
    ...over,
  });
}

const DEBRIS: UnregisteredStateHomeEntry = {
  name: 'skills.fixture-debris-20260909',
  path: '/srv/state/skills.fixture-debris-20260909',
  level: 'state-home',
};

describe('StateHomeWatch — the live classification the routes report and gate on', () => {
  it('asks the ENGINE when the addon carries the preflight: source engine, the entries, one error finding per entry, refusesLaunches as the engine says', async () => {
    const calls: Array<[string | null, string]> = [];
    const watch = new StateHomeWatch({
      dbPath: '/srv/state/core.db',
      snapshotPath: () => '/srv/state/skills/snapshots/000007',
      engine: async (snapshot, db) => {
        calls.push([snapshot, db]);
        return engineJson({ unregistered: [DEBRIS], refusesLaunches: true });
      },
      now: () => 1_000,
    });
    // Before the first refresh the watch has nothing to say — and says so (unavailable), never clean-by-default.
    expect(watch.last.source).toBe('unavailable');
    const h = await watch.refresh();
    expect(calls).toEqual([['/srv/state/skills/snapshots/000007', '/srv/state/core.db']]);
    expect(h.source).toBe('engine');
    expect(h.stateHome).toBe('/srv/state');
    expect(h.derivedFrom).toBe('snapshot');
    expect(h.unregistered).toEqual([DEBRIS]);
    expect(h.refusesLaunches).toBe(true);
    expect(h.error).toBeNull();
    expect(h.checkedAt).toBe(1_000);
    expect(h.findings).toHaveLength(1);
    expect(h.findings[0]).toMatchObject({ kind: STATE_HOME_FINDING_KIND, severity: 'error' });
    expect(h.findings[0]?.message).toContain('`skills.fixture-debris-20260909`');
    expect(h.findings[0]?.message).toContain('EVERY worker launch from this daemon is refused');
    expect(h.findings[0]?.message).toContain(`Remedy: ${STATE_HOME_REMEDY}`);
    expect(h.findings[0]?.message).not.toMatch(NO_FIXTURE_PATH);
    expect(watch.last).toBe(h);
  });

  it('with NO snapshot handed the db parent is surveyed for information and never said to refuse launches', async () => {
    const watch = new StateHomeWatch({
      dbPath: '/srv/state/core.db',
      snapshotPath: () => null,
      engine: async () => engineJson({ derivedFrom: 'db', unregistered: [DEBRIS], refusesLaunches: false }),
    });
    const h = await watch.refresh();
    expect(h.derivedFrom).toBe('db');
    expect(h.refusesLaunches).toBe(false);
    expect(h.findings[0]?.message).toContain('would refuse every worker launch the moment a skills snapshot is handed');
  });

  it('an engine that cannot answer is reported as an error AND crew classifies instead — never a clean state home nobody checked', async () => {
    const { home, snapshot } = cleanStateHome(scratch());
    mkdirSync(join(home, 'skills.fixture-debris-20260909'));
    const watch = new StateHomeWatch({
      dbPath: join(home, 'core.db'),
      snapshotPath: () => snapshot,
      engine: async () => {
        throw new Error('addon exploded');
      },
    });
    const h = await watch.refresh();
    expect(h.source).toBe('crew');
    expect(h.error).toContain('engine preflight failed (addon exploded)');
    expect(h.unregistered.map((u) => u.name)).toEqual(['skills.fixture-debris-20260909']);
    expect(h.refusesLaunches).toBe(true);
  });

  it('on an addon WITHOUT the preflight crew classifies with its registry copy: source crew, the snapshot’s state home by shape, refusesLaunches only for a handed snapshot', async () => {
    const { home, snapshot } = cleanStateHome(scratch());
    writeFileSync(join(home, 'stray.txt'), '', 'utf8');
    let handed: string | null = snapshot;
    const watch = new StateHomeWatch({ dbPath: join(home, 'core.db'), snapshotPath: () => handed, engine: null });
    const dirty = await watch.refresh();
    expect(dirty.source).toBe('crew');
    expect(dirty.stateHome).toBe(home);
    expect(dirty.derivedFrom).toBe('snapshot');
    expect(dirty.unregistered.map((u) => u.name)).toEqual(['stray.txt']);
    expect(dirty.refusesLaunches).toBe(true);
    // The snapshot is read at EACH refresh: unhand it and the db parent is surveyed for information.
    handed = null;
    const byDb = await watch.refresh();
    expect(byDb.derivedFrom).toBe('db');
    // The db parent is reported by its REAL spelling — core's `of_db_path` canonicalises the same
    // way (W1 of crew#555; the temp dir is a symlink on macOS) — while a snapshot-derived state home
    // is judged by SHAPE and keeps the handed spelling.
    expect(byDb.stateHome).toBe(canonicalize(home));
    expect(byDb.unregistered.map((u) => u.name)).toEqual(['stray.txt']);
    expect(byDb.refusesLaunches).toBe(false);
  });

  it('a handed snapshot without the <state home>/skills/snapshots/<gen> shape is an error, not a survey of the wrong directory', async () => {
    const { home } = cleanStateHome(scratch());
    const watch = new StateHomeWatch({
      dbPath: join(home, 'core.db'),
      snapshotPath: () => join(home, 'skills', 'effective'),
      engine: null,
    });
    const h = await watch.refresh();
    expect(h.stateHome).toBeNull();
    expect(h.refusesLaunches).toBe(false);
    expect(h.unregistered).toEqual([]);
    expect(h.error).toContain('does not have the shape <state home>/skills/snapshots/<gen>');
  });

  it('an unlistable state home is an error, never a clean answer', async () => {
    const base = scratch();
    const watch = new StateHomeWatch({
      dbPath: join(base, 'absent', 'core.db'),
      snapshotPath: () => join(base, 'absent', 'skills', 'snapshots', '000001'),
      engine: null,
    });
    const h = await watch.refresh();
    expect(h.error).toContain(`cannot list ${join(base, 'absent')}`);
    expect(h.refusesLaunches).toBe(false);
  });

  it('a library boot with neither db nor snapshot is `unavailable`', async () => {
    const watch = new StateHomeWatch({ dbPath: null, snapshotPath: () => null, engine: null });
    const h = await watch.refresh();
    expect(h.source).toBe('unavailable');
    expect(h.stateHome).toBeNull();
    expect(h.refusesLaunches).toBe(false);
  });

  it('a `:memory:` db with no snapshot has no state home to survey', async () => {
    const watch = new StateHomeWatch({ dbPath: ':memory:', snapshotPath: () => null, engine: null });
    const h = await watch.refresh();
    expect(h.stateHome).toBeNull();
    expect(h.source).toBe('crew');
  });
});

describe('the POST /runs 409 body and the engine’s intake refusal', () => {
  it('stateHomeBlockerBody: the typed error as fields — code, every entry, the remedy — worded like the engine’s, no fixture path', async () => {
    const watch = new StateHomeWatch({
      dbPath: '/srv/state/core.db',
      snapshotPath: () => '/srv/state/skills/snapshots/000007',
      engine: async () =>
        engineJson({
          unregistered: [DEBRIS, { name: 'scratch', path: '/srv/state/skills/scratch', level: 'skills-root' }],
          refusesLaunches: true,
        }),
    });
    const body = stateHomeBlockerBody(await watch.refresh());
    expect(body.code).toBe(STATE_HOME_BLOCKER_CODE);
    expect(body.code).toBe('state_home_unregistered');
    expect(body.stateHome).toBe('/srv/state');
    expect(body.unregistered.map((u) => u.name)).toEqual(['skills.fixture-debris-20260909', 'scratch']);
    expect(body.remedy).toBe(STATE_HOME_REMEDY);
    expect(body.error).toContain('configuration error: the daemon\'s state home /srv/state holds 2 entries');
    expect(body.error).toContain('`skills.fixture-debris-20260909`, `scratch` (under the skills root)');
    expect(body.error).toContain('the run was not started');
    expect(body.error).toContain(`Remedy: ${STATE_HOME_REMEDY}`);
    expect(body.error).not.toMatch(NO_FIXTURE_PATH);
    expect(body.error).not.toMatch(/triage|judge/);
  });

  it('isEngineStateHomeRefusal recognises core’s StateHomeConfigError text and nothing else', () => {
    // wicked-core `state_home::StateHomeConfigError`'s Display, as the napi rejection carries it.
    const core =
      'configuration error: the daemon\'s state home /srv/state (derived from WICKED_SKILLS_SNAPSHOT=/srv/state/skills/snapshots/000007) ' +
      'holds 1 entry the worker Read fence cannot classify — `skills.fixture-debris-20260909` — so every worker launch from this ' +
      `daemon would be refused; the run was not started. Remedy: ${STATE_HOME_REMEDY}`;
    expect(isEngineStateHomeRefusal(core)).toBe(true);
    expect(isEngineStateHomeRefusal('engine busy: a run is already in flight')).toBe(false);
    expect(isEngineStateHomeRefusal('WICKED_SKILLS_SNAPSHOT=/x is not a usable skills snapshot (…)')).toBe(false);
    expect(isEngineStateHomeRefusal('')).toBe(false);
  });
});
