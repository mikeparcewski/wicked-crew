// core#581: a pinned seat whose binary no longer reports the build its ACP input-governance
// admission was proven against is visible on `/diagnostics` (`acp.byCli[cli].versionPin`) and on
// the roster (`version_pin`) BETWEEN runs — before, it said so only on a governed turn. Over an
// injected exec and registry: no CLI is spawned, no native addon is asked.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AcpFoldCache,
  SeatVersionPinCache,
  probeSeatVersionPins,
  withVersionPins,
  type SeatVersionPin,
} from '../src/api/diagnostics.js';
import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';

const acp = (binary: string, verified_version?: string, acp_input_governance = true) => ({
  binary,
  acp_input_governance,
  ...(verified_version !== undefined ? { verified_version } : {}),
});

const ROSTER = [
  { key: 'opencode', acp: acp('opencode', '1.17.18') },
  { key: 'current', acp: acp('current-bin', '2.0.0') },
  { key: 'claude', acp: acp('claude-agent-acp') },
  { key: 'plain' },
  { key: 'ungoverned', acp: acp('ungoverned-bin', '1.0.0', false) },
  { key: 'gone', acp: acp('gone-bin', '3.0.0') },
];

const VERSIONS: Record<string, string> = {
  opencode: '1.18.31\n',
  'current-bin': '2.0.0\n',
  'ungoverned-bin': '1.1.0\n',
};

const fakeExec = async (file: string, args: string[]) => {
  expect(args).toEqual(['--version']);
  const out = VERSIONS[file];
  if (out === undefined) throw new Error(`spawn ${file} ENOENT`);
  return { stdout: out, stderr: '' };
};

const scratches: string[] = [];
afterEach(() => {
  while (scratches.length > 0) rmSync(scratches.pop() as string, { recursive: true, force: true });
});

describe('probeSeatVersionPins (core#581)', () => {
  it('reads each PINNED seat the way the engine admits it, and names both builds on a drift', async () => {
    const pins = await probeSeatVersionPins(ROSTER, fakeExec);
    expect(pins.map((p) => p.cli)).toEqual(['opencode', 'current', 'ungoverned', 'gone']);

    const opencode = pins[0]!;
    expect(opencode).toMatchObject({ pinned: '1.17.18', observed: '1.18.31', matched: false, governanceClaimed: true });
    expect(opencode.disclosure).toContain('1.17.18');
    expect(opencode.disclosure).toContain('1.18.31');

    expect(pins[1]).toMatchObject({ matched: true, disclosure: null });
    // The pin gates nothing on a seat that claims no input governance: listed, not disclosed.
    expect(pins[2]).toMatchObject({ matched: false, governanceClaimed: false, disclosure: null });
    // A binary that cannot answer is a failed pin, never a pass.
    expect(pins[3]).toMatchObject({ observed: null, matched: false });
    expect(pins[3]!.disclosure).toContain('did not answer');
  });

  it('matches the FIRST line only, as the engine does, and reports the first non-empty line', async () => {
    const exec = async () => ({ stdout: '\n1.17.18\n', stderr: '' });
    const [pin] = await probeSeatVersionPins([{ key: 'opencode', acp: acp('opencode', '1.17.18') }], exec);
    expect(pin).toMatchObject({ matched: false, observed: '1.17.18' });
  });
});

describe('SeatVersionPinCache', () => {
  it('answers null with no source, and the roster read never waits for a probe', async () => {
    expect(await new SeatVersionPinCache(null).get()).toBeNull();
    let calls = 0;
    const cache = new SeatVersionPinCache(async () => {
      calls += 1;
      return probeSeatVersionPins(ROSTER, fakeExec);
    });
    expect(cache.read('opencode')).toBeUndefined();
    await cache.get();
    expect(cache.read('opencode')?.matched).toBe(false);
    expect(cache.read('plain')).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('keeps the previous answer when a refresh fails', async () => {
    let fail = false;
    const cache = new SeatVersionPinCache(async () => {
      if (fail) throw new Error('probe failed');
      return probeSeatVersionPins(ROSTER, fakeExec);
    }, 0);
    await cache.get();
    fail = true;
    expect((await cache.get())?.length).toBe(4);
  });

  it('backs off for one TTL after a failed refresh instead of re-probing on every read', async () => {
    let calls = 0;
    const cache = new SeatVersionPinCache(async () => {
      calls += 1;
      throw new Error('probe failed');
    }, 60_000);
    expect(await cache.get()).toBeNull();
    for (let i = 0; i < 5; i++) expect(cache.read('opencode')).toBeUndefined();
    expect(await cache.get()).toBeNull();
    expect(calls).toBe(1);
  });
});

describe('/diagnostics acp.byCli carries the pin (core#581)', () => {
  it('attaches each reading, listing a pinned seat that has no ACP events yet', async () => {
    const pins = new SeatVersionPinCache(async () => probeSeatVersionPins(ROSTER, fakeExec));
    const dir = mkdtempSync(join(tmpdir(), 'crew-version-pins-'));
    scratches.push(dir);
    const byCli = await new AcpFoldCache(15_000, pins).get(dir);
    expect(byCli['opencode']).toMatchObject({ sessionsStarted: 0, fallbacks: 0, versionPin: { matched: false } });
    expect(byCli['current']?.versionPin?.matched).toBe(true);
    expect(byCli['claude']).toBeUndefined();
  });

  it('leaves the fold untouched when the pins cannot be read', () => {
    const fold = { claude: { sessionsStarted: 1, fallbacks: 0, fallbackKinds: {}, lastStartedTs: 1, lastFallbackTs: null } };
    expect(withVersionPins(fold, null)).toBe(fold);
    expect(withVersionPins(fold, [] as SeatVersionPin[])).toBe(fold);
  });
});

describe('the roster carries version_pin (core#581)', () => {
  it('on a pinned seat only, once the probe has answered', async () => {
    const pins = new SeatVersionPinCache(async () => probeSeatVersionPins(ROSTER, fakeExec));
    await pins.get();
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => ROSTER.map((s) => ({ display_name: s.key, binary: s.key, enabled_for_council: true, ...s })),
      signedIn: () => true,
      env: {},
      versionPins: pins,
    });
    const seats = roster();
    expect(seats.find((s) => s.key === 'opencode')?.['version_pin']).toMatchObject({
      pinned: '1.17.18',
      observed: '1.18.31',
      matched: false,
    });
    expect(seats.find((s) => s.key === 'plain')?.['version_pin']).toBeUndefined();
  });
});
