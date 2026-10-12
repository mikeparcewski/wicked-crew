// crew#986: crew's tests wrote into the LIVE state home. A live daemon's decision ledger held 21 gate
// decisions on crew test-run ids (2026-10-05). The suite's setup arms a temp state home, but only
// when vitest loads packages/crew/vitest.config.ts: a run from the repo root loaded no config and
// resolved the real `~/.wicked-crew`, and a test that unset the state home in `afterEach` left the
// rest of its file on the real one.
//
// Two fixes, pinned here:
//   - under a test runner, `crewStateHome()` / `isDefaultStateHome()` refuse the real user's
//     `~/.wicked-crew` (src/projects/state-home.ts);
//   - the repo root's vitest.config.ts runs every package under its own config, so a root run is
//     armed like a package run.
//
// Pure path resolution: nothing here creates, reads or writes anything under a real home.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crewStateHome, defaultStateHome, isDefaultStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { useUnconfiguredTempHome } from './setup/temp-home.js';

const armed = crewStateHome();
const realHome = userInfo().homedir;

describe('the live state home is refused under a test runner (crew#986)', () => {
  const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
  beforeEach(() => {
    // The real account home, as an un-armed run would see it.
    process.env['HOME'] = realHome;
    process.env['USERPROFILE'] = realHome;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setCrewStateHome(armed);
  });

  it('the harness-armed state home is not the live one', () => {
    expect(resolve(armed)).not.toBe(resolve(defaultStateHome(realHome)));
    expect(crewStateHome()).toBe(armed);
    expect(isDefaultStateHome()).toBe(false);
  });

  it('no configured state home on the real HOME: crewStateHome() and isDefaultStateHome() throw', () => {
    setCrewStateHome(undefined);
    expect(() => crewStateHome()).toThrow(/crew#986: refusing the live state home/);
    expect(() => isDefaultStateHome()).toThrow(/crew#986/);
  });

  it('a state home configured AS the live one (any spelling) is refused too', () => {
    setCrewStateHome(defaultStateHome(realHome));
    expect(() => crewStateHome()).toThrow(/crew#986/);
    setCrewStateHome(join(realHome, '.wicked-crew', '.', ''));
    expect(() => crewStateHome()).toThrow(/crew#986/);
  });

  it('outside a test runner the default daemon resolves ~/.wicked-crew exactly as before', () => {
    const env = { VITEST: process.env['VITEST'], NODE_ENV: process.env['NODE_ENV'] };
    delete process.env['VITEST'];
    delete process.env['NODE_ENV'];
    try {
      setCrewStateHome(undefined);
      expect(crewStateHome()).toBe(defaultStateHome(homedir()));
      expect(isDefaultStateHome()).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
    }
  });
});

describe('a temp HOME may still exercise the unconfigured default', () => {
  const temp = useUnconfiguredTempHome();
  it('resolves <temp HOME>/.wicked-crew and calls it the default', () => {
    expect(crewStateHome()).toBe(defaultStateHome(temp.home()));
    expect(isDefaultStateHome()).toBe(true);
  });
});

describe('a vitest run from the repo root is armed like a package run', () => {
  it('the root vitest.config.ts runs packages/crew under its own config', () => {
    const root = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'vitest.config.ts'), 'utf8');
    expect(root).toMatch(/projects:\s*\[[^\]]*'packages\/crew'/);
  });
});
