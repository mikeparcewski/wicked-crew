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
import {
  INTERACTIVE_DEFAULT_RANGE,
  INTERACTIVE_SPEC,
  INTERACTIVE_SPEC_ENV,
  interactiveSpec,
  resolveInteractiveSpec,
  validInteractiveRange,
} from '../src/interactive/bridge-pool.js';
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

  it('floors at 0.9.1 — the exporter honours the author\'s page geometry (F-050) and DELETE /api/docs/:doc retire exists (F-081)', () => {
    const range = INTERACTIVE_SPEC.split('@')[1] ?? '';
    expect(range).toBe(INTERACTIVE_DEFAULT_RANGE);
    const m = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(range);
    expect(m, `unparseable range: ${range}`).not.toBeNull();
    const [maj, min, pat] = [Number(m![1]), Number(m![2]), Number(m![3])];
    // 0.8.x never picked up 0.9.0 (F-081: the caret was a compiled constant — a silent freeze).
    expect(maj * 1_000_000 + min * 1_000 + pat).toBeGreaterThanOrEqual(0 * 1_000_000 + 9 * 1_000 + 1);
  });

  it('WICKED_INTERACTIVE_SPEC overrides the RANGE when it is a semver range; anything else is ignored and NAMED (F-081)', () => {
    expect(resolveInteractiveSpec({})).toEqual({ spec: INTERACTIVE_SPEC, range: INTERACTIVE_DEFAULT_RANGE, source: 'default' });
    expect(resolveInteractiveSpec({ [INTERACTIVE_SPEC_ENV]: '  ' })).toEqual({ spec: INTERACTIVE_SPEC, range: INTERACTIVE_DEFAULT_RANGE, source: 'default' });
    for (const range of ['^0.9.1', '0.9.1', '~0.9.1', '>=0.9.1 <1.0.0', '0.10.0-rc.1', ' ^0.9.2 ']) {
      const r = resolveInteractiveSpec({ [INTERACTIVE_SPEC_ENV]: range });
      expect(r.source, range).toBe('env');
      expect(r.spec, range).toBe(`wicked-interactive@${range.trim()}`);
      expect(interactiveSpec({ [INTERACTIVE_SPEC_ENV]: range })).toBe(r.spec);
    }
    // An accepted override BELOW crew's need floor is honoured and FLAGGED (#533 review, F-7): the boot line warns.
    expect(resolveInteractiveSpec({ [INTERACTIVE_SPEC_ENV]: '0.8.1' })).toEqual({ spec: 'wicked-interactive@0.8.1', range: '0.8.1', source: 'env', belowFloor: true });
    expect(resolveInteractiveSpec({ [INTERACTIVE_SPEC_ENV]: '^0.8.1' }).belowFloor).toBe(true);
    expect(resolveInteractiveSpec({ [INTERACTIVE_SPEC_ENV]: '>=0.9.0 <1.0.0' }).belowFloor).toBe(true);
    expect(resolveInteractiveSpec({ [INTERACTIVE_SPEC_ENV]: '^0.9.1' }).belowFloor).toBeUndefined();
    expect(resolveInteractiveSpec({ [INTERACTIVE_SPEC_ENV]: '0.10.0-rc.1' }).belowFloor).toBeUndefined();
    // An upper-bound-only range has no floor to compare — accepted, not flagged.
    expect(resolveInteractiveSpec({ [INTERACTIVE_SPEC_ENV]: '<1.0.0' })).toEqual({ spec: 'wicked-interactive@<1.0.0', range: '<1.0.0', source: 'env' });
    // A tag, an x-range, a union, a path, a different package, a whole spec: not a floor within the package.
    for (const bad of ['latest', 'next', '0.9', '0.9.x', '*', '^0.9.1 || ^1.0.0', '/srv/interactive', 'wicked-interactive@^0.9.1', 'other-pkg']) {
      expect(validInteractiveRange(bad), bad).toBe(false);
      const r = resolveInteractiveSpec({ [INTERACTIVE_SPEC_ENV]: bad });
      expect(r, bad).toEqual({ spec: INTERACTIVE_SPEC, range: INTERACTIVE_DEFAULT_RANGE, source: 'default', rejected: bad });
    }
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

  it('spawns and reproduces with the SAME spec — both resolved from the live env', () => {
    // The spawn argv and the operator hint must both go through the one resolver.
    expect(SOURCE).toMatch(/nodeSpawn\('npx',\s*\['--yes',\s*interactiveSpec\(\),/);
    expect(SOURCE).toMatch(/return `npx \$\{interactiveSpec\(\)\} serve --root \$\{root\}`;/);
  });

  it('keeps --yes: a daemon has no tty to answer npx’s install prompt with', () => {
    // Without it npx PROMPTS when the package is absent and the request hangs instead of 503ing.
    expect(SOURCE).toMatch(/'--yes'/);
  });
});
