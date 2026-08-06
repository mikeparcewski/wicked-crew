// Guard: every ACP bridge binary `bridge-path.ts` names must actually exist (FINDING-097).
//
// The comment claimed FIVE bridges — the four real ones plus one for the opencode seat. Nothing
// declared a package providing it, no install produced a shim for it, and wicked-council's
// registry never asks for it (opencode's ACP config spawns the CLI's own native `opencode acp`).
// The name lived in that comment and nowhere else, so it is not respelled here either: this file
// sits beside the file under audit, and a future widening of the scan must not find its own bait.
//
// This is a SOURCE AUDIT, not a test of `ensureBridgesOnPath`: the bug was a documented set with
// no artifact behind it, so the check has to compare the document against the artifacts. Two
// independent sources have to agree with the prose, so a stale prose list cannot hide behind
// either one alone:
//
//   1. the DECLARED dependencies of packages/crew — what `npm install wicked-crew` pulls in; and
//   2. the shims a real install actually produced — what a bare-name spawn can find on PATH.
//
// Fails CLOSED. A missing node_modules or an unreadable manifest fails the test rather than
// skipping it: a guard that quietly passes when it cannot look is worth less than no guard.
//
// Every needle is built by CONCATENATION. A literal spelled here would be found by a search over
// this file's own directory tree and the audit would match itself.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBridgeBinDir } from '../src/core/bridge-path.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const SOURCE = join(PKG_ROOT, 'src', 'core', 'bridge-path.ts');

/** The `-acp` suffix, assembled so this file never contains the token it searches for. */
const ACP_SUFFIX = '-' + 'acp';

/**
 * Every `*-acp` name in the file's LEADING doc comment — the prose claim under audit. Scoped to
 * the header block so `PROBE_BINS` (code, and only a probe subset) cannot stand in for the
 * documented set.
 *
 * Deliberately NOT restricted to backticked spans. An earlier cut matched only `` `name` `` and
 * the header could therefore mention a dead bridge inside a multi-token span — the audit would
 * skip it and pass while the phantom sat in the file it was auditing. Any token ending in the
 * suffix counts, whatever punctuation surrounds it.
 */
function bridgeNamesInProse(): Set<string> {
  const src = readFileSync(SOURCE, 'utf8');
  const end = src.indexOf('*/');
  expect(end, 'bridge-path.ts must open with a doc comment').toBeGreaterThan(0);
  const header = src.slice(0, end);
  const names = new Set<string>();
  for (const m of header.matchAll(/[a-z0-9][a-z0-9-]*/g)) {
    const name = m[0];
    if (name.endsWith(ACP_SUFFIX)) names.add(name);
  }
  return names;
}

/** Every `*-acp` bin key provided by a DECLARED dependency of packages/crew. */
function bridgeNamesFromDeclaredDeps(): Set<string> {
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const deps = Object.keys(manifest.dependencies ?? {});
  expect(deps.length, 'packages/crew must declare dependencies').toBeGreaterThan(0);

  // Resolve each dep's manifest from wherever npm hoisted it (package-local or workspace root).
  const roots = [join(PKG_ROOT, 'node_modules'), join(PKG_ROOT, '..', '..', 'node_modules')];
  const names = new Set<string>();
  let resolvedAny = false;
  for (const dep of deps) {
    const found = roots.map((r) => join(r, dep, 'package.json')).find((p) => existsSync(p));
    if (found === undefined) continue;
    resolvedAny = true;
    const bin = (JSON.parse(readFileSync(found, 'utf8')) as { bin?: string | Record<string, string> })
      .bin;
    if (typeof bin === 'string') {
      // A string `bin` is published under the package's own (possibly scoped) name.
      const base = dep.includes('/') ? (dep.split('/').pop() as string) : dep;
      if (base.endsWith(ACP_SUFFIX)) names.add(base);
    } else if (bin !== undefined) {
      for (const key of Object.keys(bin)) if (key.endsWith(ACP_SUFFIX)) names.add(key);
    }
  }
  // Fail closed: no resolvable dependency manifests means the audit could not look, which is not
  // the same as the audit passing.
  expect(resolvedAny, 'no declared dependency resolved — run npm install before the suite').toBe(true);
  return names;
}

/** Every `*-acp` shim a real install produced, in the `.bin` the daemon puts on PATH. */
function bridgeNamesOnDisk(): Set<string> {
  const binDir = findBridgeBinDir(HERE);
  expect(binDir, 'no node_modules/.bin with bridge shims — run npm install before the suite').not.toBeNull();
  const names = new Set<string>();
  for (const entry of readdirSync(binDir as string)) {
    // Windows ships `<name>.cmd`/`.ps1` alongside the POSIX shim; normalise to the bare name.
    const bare = entry.replace(/\.(cmd|ps1)$/i, '');
    if (bare.endsWith(ACP_SUFFIX)) names.add(bare);
  }
  return names;
}

const sorted = (s: Set<string>): string[] => [...s].sort();

describe('bridge-path.ts names only bridges that exist (FINDING-097)', () => {
  it('names exactly the bridges the declared dependencies provide', () => {
    // Set EQUALITY, both directions. A subset check would pass a prose list that invented a name
    // as long as it also mentioned a real one — which is precisely what shipped.
    expect(sorted(bridgeNamesInProse())).toEqual(sorted(bridgeNamesFromDeclaredDeps()));
  });

  it('names exactly the bridge shims a real install puts on PATH', () => {
    // The dependency manifests say what SHOULD be installable; `.bin` says what a bare-name spawn
    // will actually find. Both have to agree with the prose, or the prose is only half-backed.
    expect(sorted(bridgeNamesInProse())).toEqual(sorted(bridgeNamesOnDisk()));
  });

  it('audits a non-empty set (a prose list that named nothing would trivially match)', () => {
    // Two empty sets are equal. Without this, deleting every name from the comment would make the
    // guard above pass — the classic vacuous-audit hole.
    expect(bridgeNamesInProse().size).toBeGreaterThanOrEqual(4);
  });

  it("the module's probe shims are a subset of the documented bridges", () => {
    // `PROBE_BINS` decides whether a `.bin` dir counts as the bridges' one. A probe naming a
    // binary no dependency provides would make `findBridgeBinDir` return null on every real
    // install — silently, since it treats "not found" as an ordinary answer.
    const src = readFileSync(SOURCE, 'utf8');
    const block = /const PROBE_BINS = \[([^\]]*)\]/.exec(src);
    expect(block, 'PROBE_BINS must be a literal array this audit can read').not.toBeNull();
    const inner = (block as RegExpExecArray)[1] as string;
    const probes = [...inner.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    expect(probes.length).toBeGreaterThan(0);
    const real = bridgeNamesFromDeclaredDeps();
    for (const probe of probes) expect(real.has(probe), `${probe} is probed but not provided`).toBe(true);
  });
});
