// crew#986: the unconfigured state-home default, asserted without the operator's live home.
//
// `crewStateHome()` with no configured state home is `~/.wicked-crew`, and under a test runner it
// refuses the REAL user's one (src/projects/state-home.ts). A suite that asserts what the
// unconfigured default resolves to calls this once: every test in it runs with HOME (and
// USERPROFILE, for Windows) pointed at a fresh temp dir and no configured state home. Afterwards
// HOME, USERPROFILE and the state home the harness armed (tests/setup/hermetic-home.ts) are put
// back, so nothing leaks into the next test.
import { afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { crewStateHome, setCrewStateHome } from '../../src/projects/state-home.js';
import { removeScratch } from './scratch.js';

export function useUnconfiguredTempHome(): { home: () => string } {
  const armed = crewStateHome();
  const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
  let dir: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-temp-home-'));
    const home = join(dir, 'home');
    mkdirSync(home);
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    setCrewStateHome(undefined);
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setCrewStateHome(armed);
    if (dir !== undefined) removeScratch(dir);
    dir = undefined;
  });
  return {
    home: () => {
      if (dir === undefined) throw new Error('useUnconfiguredTempHome: no test is running');
      return join(dir, 'home');
    },
  };
}
