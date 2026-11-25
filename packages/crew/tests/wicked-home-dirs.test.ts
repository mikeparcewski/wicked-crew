// crew#1802 (after crew#1800): every default dir crew keeps outside its state home derives from
// `${WICKED_HOME:-~/.wicked}` through one helper (`src/core/wicked-home.ts`), so a daemon on a scratch WICKED_HOME (a
// proof or test daemon) never writes into the person's live home. The dir's own variable still wins; an empty value is
// unset. The boot refuses a WICKED_HOME that would put one of those dirs inside the daemon's state home, by name.

import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureInboxDir } from '../src/api/capture.js';
import { defaultAppsRoot } from '../src/apps/store.js';
import { steeringInboxDir } from '../src/api/governance-steering.js';
import { walkthroughRootDir } from '../src/core/walkthrough-root.js';
import { wickedHome, wickedHomeDir } from '../src/core/wicked-home.js';
import { defaultEvalRunsDir } from '../src/evals/workflow.js';
import { defaultReviewsDir } from '../src/insights/workflow.js';
import { defaultInspectionsDir } from '../src/inspect/service.js';
import { defaultLearningsDir } from '../src/learnings/service.js';
import { assertWickedRootsOutsideStateHome, StateHomePlacementError, STATE_HOME_ROOT_ENVS } from '../src/projects/state-home-preflight.js';
import { defaultStateHome } from '../src/projects/state-home.js';
import { removeScratch } from './setup/scratch.js';

/** Every dir under the wicked home, with the variable that overrides it and how to read it. */
const DIRS: Array<{ variable: string; name: string; read: (env: NodeJS.ProcessEnv) => string }> = [
  { variable: 'WICKED_CREW_REVIEWS_DIR', name: 'reviews', read: (env) => defaultReviewsDir(env) },
  { variable: 'WICKED_CREW_EVAL_RUNS_DIR', name: 'evals', read: (env) => defaultEvalRunsDir(env) },
  { variable: 'WICKED_CREW_INSPECTIONS_DIR', name: 'inspections', read: (env) => defaultInspectionsDir(env) },
  { variable: 'WICKED_CREW_LEARNINGS_DIR', name: 'learnings', read: (env) => defaultLearningsDir(env) },
  // crew#1823: the apps root follows the same resolver.
  { variable: 'WICKED_CREW_APPS_ROOT', name: 'apps', read: (env) => defaultAppsRoot(env) },
  // These three read process.env (their callers pass a run id only): the test sets it for the call.
  { variable: 'WICKED_WALKTHROUGH_DIR', name: 'walkthroughs', read: (env) => withEnv(env, () => walkthroughRootDir('run-1')).replace(/[\\/]run-1$/u, '') },
  { variable: 'WICKED_CAPTURE_INBOX_DIR', name: 'capture-inbox', read: (env) => withEnv(env, () => captureInboxDir('run-1')).replace(/[\\/]run-1$/u, '') },
  { variable: 'WICKED_STEERING_INBOX_DIR', name: 'steering-inbox', read: (env) => withEnv(env, () => steeringInboxDir('run-1')).replace(/[\\/]run-1$/u, '') },
];

const TOUCHED = ['WICKED_HOME', ...DIRS.map((d) => d.variable)];

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  try {
    for (const k of TOUCHED) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

let base = '';
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'crew-wicked-home-'));
});
afterEach(() => removeScratch(base));

describe('default dirs follow WICKED_HOME (crew#1802)', () => {
  it('with WICKED_HOME set and the explicit variables unset, every dir lands under $WICKED_HOME/<name>', () => {
    const home = join(base, 'scratch-wicked-home');
    for (const d of DIRS) expect(d.read({ WICKED_HOME: home }), d.variable).toBe(join(home, d.name));
  });

  it('the explicit variable still wins; an empty one (or an empty WICKED_HOME) is unset', () => {
    const home = join(base, 'wh');
    for (const d of DIRS) {
      expect(d.read({ WICKED_HOME: home, [d.variable]: join(base, 'own') }), d.variable).toBe(join(base, 'own'));
      expect(d.read({ WICKED_HOME: home, [d.variable]: '' }), d.variable).toBe(join(home, d.name));
      expect(d.read({ WICKED_HOME: '' }), d.variable).toBe(join(homedir(), '.wicked', d.name));
    }
  });

  it('a relative value resolves to an absolute dir', () => {
    for (const d of DIRS) expect(d.read({ WICKED_HOME: 'rel-home' }), d.variable).toBe(resolve('rel-home', d.name));
  });

  it('the wicked home is WICKED_HOME, else ~/.wicked', () => {
    expect(wickedHome({ WICKED_HOME: join(base, 'wh') })).toBe(join(base, 'wh'));
    expect(wickedHome({})).toBe(join(homedir(), '.wicked'));
    expect(wickedHomeDir('UNSET_VAR_X', 'x', { WICKED_HOME: join(base, 'wh') })).toBe(join(base, 'wh', 'x'));
  });
});

describe('the boot refuses a WICKED_HOME that puts one of those dirs inside the state home (crew#1802)', () => {
  it('every dir with a WICKED_HOME default is in the boot refusal', () => {
    const homes = STATE_HOME_ROOT_ENVS.filter((r) => r.home !== undefined).map((r) => [r.variable, r.home]);
    expect(homes).toEqual(expect.arrayContaining(DIRS.map((d) => [d.variable, d.name])));
    expect(homes).toHaveLength(DIRS.length);
  });

  it('WICKED_HOME at the state home is refused naming WICKED_HOME and the entry; a sibling is not', () => {
    const stateHome = join(base, 'crew-state');
    let thrown: unknown;
    try {
      assertWickedRootsOutsideStateHome({ WICKED_HOME: stateHome }, stateHome);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StateHomePlacementError);
    const e = thrown as StateHomePlacementError;
    expect(e.variable).toBe('WICKED_HOME');
    expect(e.value).toBe(stateHome);
    expect(DIRS.map((d) => d.name)).toContain(e.entry);
    expect(e.message).toContain(`point WICKED_HOME at a directory OUTSIDE ${stateHome}`);
    expect(() => assertWickedRootsOutsideStateHome({ WICKED_HOME: join(base, 'wicked-home') }, stateHome)).not.toThrow();
  });

  it('an unset or empty WICKED_HOME is not checked, like every unset default: a HOME under the state home still boots', () => {
    const stateHome = join(base, 'crew-state');
    const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
    try {
      process.env['HOME'] = join(stateHome, 'home');
      process.env['USERPROFILE'] = join(stateHome, 'home');
      for (const env of [{}, { WICKED_HOME: '' }]) expect(() => assertWickedRootsOutsideStateHome(env, stateHome)).not.toThrow();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('on the default state home the work roots are checked too: they follow WICKED_HOME with no variable of their own (crew#1823)', () => {
    const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
    try {
      process.env['HOME'] = join(base, 'home');
      process.env['USERPROFILE'] = join(base, 'home');
      const stateHome = defaultStateHome(homedir());
      const inside = join(stateHome, 'work');
      // Every dir with a variable points outside, so only the work roots (repos, scripts) land inside.
      const elsewhere = Object.fromEntries(DIRS.map((d) => [d.variable, join(base, 'out', d.name)]));
      let thrown: unknown;
      try {
        assertWickedRootsOutsideStateHome({ ...elsewhere, WICKED_HOME: inside }, stateHome);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(StateHomePlacementError);
      expect((thrown as StateHomePlacementError).variable).toBe('WICKED_HOME');
      expect((thrown as StateHomePlacementError).entry).toBe('work');
      expect((thrown as StateHomePlacementError).message).toContain('under WICKED_HOME/repos');
      // Any other state home keeps its work roots as `<state home>-<name>` siblings: nothing lands inside it.
      const other = join(base, 'crew-state');
      expect(() => assertWickedRootsOutsideStateHome({ ...elsewhere, WICKED_HOME: join(other, 'work') }, other)).not.toThrow();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('a relative WICKED_HOME is checked where the dirs resolve (the same helper)', () => {
    const rel = join('rel-wicked-home-check');
    expect(() => assertWickedRootsOutsideStateHome({ WICKED_HOME: rel }, resolve(rel))).toThrow(/^WICKED_HOME=rel-wicked-home-check /u);
  });

  it('each dir is refused under a WICKED_HOME inside the state home unless its own variable points elsewhere', () => {
    const stateHome = join(base, 'crew-state');
    const inside = join(stateHome, 'wh');
    const elsewhere = Object.fromEntries(DIRS.map((d) => [d.variable, join(base, 'out', d.name)]));
    expect(() => assertWickedRootsOutsideStateHome({ WICKED_HOME: inside, ...elsewhere }, stateHome)).not.toThrow();
    for (const d of DIRS) {
      const env: NodeJS.ProcessEnv = { ...elsewhere, WICKED_HOME: inside };
      delete env[d.variable];
      expect(() => assertWickedRootsOutsideStateHome(env, stateHome), d.variable).toThrow(StateHomePlacementError);
      expect(() => assertWickedRootsOutsideStateHome({ ...env, [d.variable]: join(stateHome, d.name) }, stateHome), d.variable).toThrow(new RegExp(`^${d.variable}=`, 'u'));
    }
  });
});
