// The editor-pack conformance run's overall cap (pack-install.ts) follows garden's per-load bound
// (`$WG_EDITOR_CONFORMANCE_TIMEOUT`, default 120 s — scripts/editor/conformance.py `--timeout`), so a
// correct install on a loaded host is not killed by crew while garden still allows each page load.
// Incident (orchestrator, 2026-10-14): a fixed 240 s cap killed an install at 249 s.
import { describe, expect, it, vi } from 'vitest';
import {
  CONFORMANCE_TIMEOUT_ENV,
  DEFAULT_CONFORMANCE_LOAD_S,
  CONFORMANCE_FIXED_WAITS_S,
  RUN_PLUGIN_FIXED_WAITS_S,
  RUN_PLUGIN_LOADS,
  conformanceCapMs,
  conformanceLoadSeconds,
  engineConformance,
} from '../src/editors/pack-install.js';

const V1 = { id: 'a', protocol: [1] };
const V2 = { id: 'b', protocol: [1, 2] };

describe('the per-load bound, read as garden reads it (Python float, 5-1800 s)', () => {
  it('the env var in seconds when garden would accept it, else 120 s', () => {
    expect(conformanceLoadSeconds({})).toBe(DEFAULT_CONFORMANCE_LOAD_S);
    expect(DEFAULT_CONFORMANCE_LOAD_S).toBe(120);
    expect(conformanceLoadSeconds({ [CONFORMANCE_TIMEOUT_ENV]: '300' })).toBe(300);
    expect(conformanceLoadSeconds({ [CONFORMANCE_TIMEOUT_ENV]: '7.5' })).toBe(7.5);
    // Python's float() spellings garden accepts.
    expect(conformanceLoadSeconds({ [CONFORMANCE_TIMEOUT_ENV]: '1_000' })).toBe(1000);
    expect(conformanceLoadSeconds({ [CONFORMANCE_TIMEOUT_ENV]: ' 240 ' })).toBe(240);
    expect(conformanceLoadSeconds({ [CONFORMANCE_TIMEOUT_ENV]: '1e3' })).toBe(1000);
    // Values garden refuses (its run fails at once): the default stands.
    for (const bad of ['0', '4', '1801', '-5', 'soon', '', '1__0', '_10', 'inf', 'nan', '0x10']) {
      expect(conformanceLoadSeconds({ [CONFORMANCE_TIMEOUT_ENV]: bad }), bad).toBe(120);
    }
  });
});

describe('the overall cap', () => {
  const V2_FULL = {
    id: 'c', protocol: [1, 2],
    surfaces: {
      card: { actions: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }] },
      options: { tabs: [{ id: 't1', render: 'plugin' }, { id: 't2', render: 'plugin' }, { id: 't3', render: 'controls' }, { id: 't4', render: 'controls' }, { id: 't5', render: 'controls' }] },
    },
  };
  const V2_CONTROLS = { id: 'd', protocol: [1, 2], surfaces: { card: { actions: [] }, options: { tabs: [{ id: 'x', render: 'controls' }] } } };

  it('covers every host-page load at the full bound, every sequential answer, the fixed waits and the browser start', () => {
    // The host-contract cases' waits, plus the behaviour cases 7 and 18 (G9b, codex on the diff: 30 s left them out).
    const FIXED = 55;
    expect(CONFORMANCE_FIXED_WAITS_S).toBe(FIXED);
    // Protocol 1: 2 loads, no surface answers.
    expect(conformanceCapMs([V1], 120)).toBe((60 + FIXED + 2 * 120) * 1000);
    // Protocol 2, no surfaces: + the card load; the two full-screen modes answer.
    expect(conformanceCapMs([V2], 120)).toBe((60 + FIXED + 2 * 2 + 3 * 120) * 1000);
    // Two plugin tabs: one options load each; 4 actions + 5 tabs + 2 modes answer.
    expect(conformanceCapMs([V2_FULL], 120)).toBe((60 + FIXED + 2 * 11 + 5 * 120) * 1000);
    // Controls tabs only: one options load.
    expect(conformanceCapMs([V2_CONTROLS], 120)).toBe((60 + FIXED + 2 * 3 + 4 * 120) * 1000);
    // Several editors add up; the browser starts once.
    expect(conformanceCapMs([V1, V2_FULL, V2_FULL], 120)).toBe((60 + (FIXED + 240) + 2 * (FIXED + 22 + 600)) * 1000);
    // Always more than garden's loads alone may take (the 249 s incident was a > 240 s run).
    expect(conformanceCapMs([V2_FULL], 120)).toBeGreaterThan(5 * 120 * 1000);
    // The bound moves the cap with it.
    expect(conformanceCapMs([V2], 300)).toBe((60 + FIXED + 4 + 3 * 300) * 1000);
    // No entries known: sized for one protocol-1 editor.
    expect(conformanceCapMs([], 120)).toBe((60 + FIXED + 2 * 120) * 1000);
  });

  it('CS7 C4: each run plugin counts as 3 host-page loads + 20 s of fixed waits', () => {
    expect(RUN_PLUGIN_LOADS).toBe(3);
    expect(RUN_PLUGIN_FIXED_WAITS_S).toBe(20);
    // A plugin-only pack: no editor list stands in for it; the plugin adds its own slice.
    expect(conformanceCapMs([], 120, [{ id: 'p' }])).toBe((60 + 20 + 3 * 120) * 1000);
    // Two plugins add up; the bound moves the cap with it.
    expect(conformanceCapMs([], 300, [{ id: 'p1' }, { id: 'p2' }])).toBe((60 + 2 * (20 + 3 * 300)) * 1000);
    // An editor and a plugin together: each slice plus one browser start.
    expect(conformanceCapMs([V1], 120, [{ id: 'p' }])).toBe((60 + CONFORMANCE_FIXED_WAITS_S + 2 * 120 + 20 + 3 * 120) * 1000);
  });
});

describe('engineConformance sends the manifest-derived deadline to the jailed binding', () => {
  it.each([
    { editors: [V2], plugins: [], load: '200', timeoutS: 719 },
    { editors: [V1], plugins: [], load: '7.1', timeoutS: 130 },
    { editors: [V1], plugins: [], load: '\uff11\uff10\uff10\uff10', timeoutS: 355 },
    { editors: [V2], plugins: [{ id: 'p' }], load: '120', timeoutS: 859 },
    { editors: [V2, V2], plugins: [{ id: 'p' }], load: '1800', timeoutS: 900 },
  ])('sends packRoot and timeoutS=$timeoutS for $editors / $plugins at load=$load', async ({ editors, plugins, load, timeoutS }) => {
    const run = vi.fn(async () => JSON.stringify({ record: { outcome: 'pass', attempt: 1 }, report: { ok: true, editors: [] } }));
    await engineConformance({ run, env: { [CONFORMANCE_TIMEOUT_ENV]: load } })('/pack', editors, plugins);
    expect(run).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ packRoot: '/pack', timeoutS }));
  });
});
