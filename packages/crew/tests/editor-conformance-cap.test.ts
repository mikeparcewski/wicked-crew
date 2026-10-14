// The editor-pack conformance run's overall cap (pack-install.ts) follows garden's per-load bound
// (`$WG_EDITOR_CONFORMANCE_TIMEOUT`, default 120 s — scripts/editor/conformance.py `--timeout`), so a
// correct install on a loaded host is not killed by crew while garden still allows each page load.
// Incident (orchestrator, 2026-10-14): a fixed 240 s cap killed an install at 249 s.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFORMANCE_TIMEOUT_ENV,
  DEFAULT_CONFORMANCE_LOAD_S,
  conformanceCapMs,
  conformanceLoadSeconds,
  gardenConformance,
} from '../src/editors/pack-install.js';
import { removeScratch } from './setup/scratch.js';

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
    // Protocol 1: 2 loads, no surface answers.
    expect(conformanceCapMs([V1], 120)).toBe((60 + 30 + 2 * 120) * 1000);
    // Protocol 2, no surfaces: + the card load; the two full-screen modes answer.
    expect(conformanceCapMs([V2], 120)).toBe((60 + 30 + 2 * 2 + 3 * 120) * 1000);
    // Two plugin tabs: one options load each; 4 actions + 5 tabs + 2 modes answer.
    expect(conformanceCapMs([V2_FULL], 120)).toBe((60 + 30 + 2 * 11 + 5 * 120) * 1000);
    // Controls tabs only: one options load.
    expect(conformanceCapMs([V2_CONTROLS], 120)).toBe((60 + 30 + 2 * 3 + 4 * 120) * 1000);
    // Several editors add up; the browser starts once.
    expect(conformanceCapMs([V1, V2_FULL, V2_FULL], 120)).toBe((60 + (30 + 240) + 2 * (30 + 22 + 600)) * 1000);
    // Always more than garden's loads alone may take (the 249 s incident was a > 240 s run).
    expect(conformanceCapMs([V2_FULL], 120)).toBeGreaterThan(5 * 120 * 1000);
    // The bound moves the cap with it.
    expect(conformanceCapMs([V2], 300)).toBe((60 + 30 + 4 + 3 * 300) * 1000);
    // No entries known: sized for one protocol-1 editor.
    expect(conformanceCapMs([], 120)).toBe((60 + 30 + 2 * 120) * 1000);
  });
});

describe('gardenConformance hands the derived cap to the runner process', () => {
  let dir: string;
  afterEach(() => removeScratch(dir));

  it('timeout = conformanceCapMs(the pack editors, the env bound), and the env reaches the child', async () => {
    dir = mkdtempSync(join(tmpdir(), 'conformance-cap-'));
    const garden = join(dir, 'garden');
    mkdirSync(join(garden, 'scripts', 'editor'), { recursive: true });
    writeFileSync(join(garden, 'scripts', 'editor', 'conformance.py'), '# stub\n');
    const seen: Array<{ timeout?: number; env?: NodeJS.ProcessEnv }> = [];
    const env = { [CONFORMANCE_TIMEOUT_ENV]: '200' };
    const run = gardenConformance(garden, () => 'http://127.0.0.1:1', {
      env,
      exec: (async (_bin: string, _args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) => {
        seen.push(opts);
        return { stdout: JSON.stringify({ ok: true, editors: [] }), stderr: '' };
      }) as never,
    });
    await run('/pack', [V2]);
    expect(seen[0]?.timeout).toBe(conformanceCapMs([V2], 200));
    expect(seen[0]?.timeout).toBe((60 + 34 + 3 * 200) * 1000);
    // The child reads the very bound the cap was sized from.
    expect(seen[0]?.env?.[CONFORMANCE_TIMEOUT_ENV]).toBe('200');
  });

  it('a spelling crew does not read (non-ASCII digits) still reaches garden as the bound crew sized for', async () => {
    dir = mkdtempSync(join(tmpdir(), 'conformance-cap-'));
    const garden = join(dir, 'garden');
    mkdirSync(join(garden, 'scripts', 'editor'), { recursive: true });
    writeFileSync(join(garden, 'scripts', 'editor', 'conformance.py'), '# stub\n');
    const seen: Array<{ timeout?: number; env?: NodeJS.ProcessEnv }> = [];
    const run = gardenConformance(garden, () => 'http://127.0.0.1:1', {
      env: { [CONFORMANCE_TIMEOUT_ENV]: '\uff11\uff10\uff10\uff10', KEEP: 'x' },
      exec: (async (_b: string, _a: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) => {
        seen.push(opts);
        return { stdout: JSON.stringify({ ok: true, editors: [] }), stderr: '' };
      }) as never,
    });
    await run('/pack', [V1]);
    expect(seen[0]?.env?.[CONFORMANCE_TIMEOUT_ENV]).toBe('120');
    expect(seen[0]?.env?.['KEEP']).toBe('x');
    expect(seen[0]?.timeout).toBe(conformanceCapMs([V1], 120));
  });
});
