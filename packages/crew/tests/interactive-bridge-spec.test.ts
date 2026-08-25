// The wicked-interactive version floor crew starts bridges against.
//
// The spawn was a bare `npx --yes wicked-interactive`, which resolves whatever the public registry
// calls `latest` AT RUNTIME. That means a wicked-interactive release can change crew's behaviour
// with no crew change and nothing in crew's history to point at, and crew has no way to REQUIRE a
// route it depends on — the learned-theme readback (interactive#181) shipped in 0.8.1, and against
// 0.8.0 the brand-learn surface polls forever and degrades silently.
//
// These pin the floor itself and, more importantly, that BOTH places that name the package go
// through the same constant. The operator-facing hint is the command someone pastes into a terminal
// to reproduce a failed start; if it drifts from what the daemon actually spawns, it reproduces a
// DIFFERENT thing — which is worse than no hint, because it looks authoritative.

import { describe, expect, it } from 'vitest';
import { INTERACTIVE_SPEC } from '../src/interactive/bridge-pool.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(import.meta.dirname, '..', 'src', 'interactive', 'bridge-pool.ts'),
  'utf8',
);

describe('the wicked-interactive spec crew resolves', () => {
  it('carries a version range, not a bare package name', () => {
    expect(INTERACTIVE_SPEC).toMatch(/^wicked-interactive@/);
    // A bare name would resolve `latest` at runtime — the hazard this constant exists to close.
    expect(INTERACTIVE_SPEC).not.toBe('wicked-interactive');
  });

  it('floors at 0.8.1 — the release that carries the learned-theme readback crew depends on', () => {
    const range = INTERACTIVE_SPEC.split('@')[1] ?? '';
    const m = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(range);
    expect(m, `unparseable range: ${range}`).not.toBeNull();
    const [maj, min, pat] = [Number(m![1]), Number(m![2]), Number(m![3])];
    // 0.8.0 lacks GET /d/:docId/api/theme/learned (interactive#181/#182).
    expect(maj * 1_000_000 + min * 1_000 + pat).toBeGreaterThanOrEqual(0 * 1_000_000 + 8 * 1_000 + 1);
  });

  it('names the package in CODE exactly once — so the hint cannot drift from the spawn', () => {
    // Comments are prose, not a source of truth: the module header describes what a bridge IS
    // (`wicked-interactive serve`), and that is documentation, not a spawn target. Strip comments
    // first so this measures executable positions — the thing that can actually drift.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const literals = code.match(/['"`]wicked-interactive(?![-a-z])/g) ?? [];
    expect(
      literals.length,
      'wicked-interactive is named as a code literal more than once — route it through INTERACTIVE_SPEC',
    ).toBe(1);
  });

  it('spawns and reproduces with the SAME spec', () => {
    // The spawn argv and the operator hint must both interpolate the constant.
    expect(SOURCE).toMatch(/nodeSpawn\('npx',\s*\['--yes',\s*INTERACTIVE_SPEC,/);
    expect(SOURCE).toMatch(/return `npx \$\{INTERACTIVE_SPEC\} serve --root \$\{root\}`;/);
  });

  it('keeps --yes: a daemon has no tty to answer npx’s install prompt with', () => {
    // Without it npx PROMPTS when the package is absent and the request hangs instead of 503ing.
    expect(SOURCE).toMatch(/'--yes'/);
  });
});
