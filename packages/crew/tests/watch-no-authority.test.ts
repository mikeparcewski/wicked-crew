// DES-TRIGGER-REGISTRY-001 §7 (G6) — the watch registry has NO authority. It is constructed with no
// gate, reassign or policy dependency, so it has no path to allow, approve, block or rewrite a rule.
// This scan fails the build if any file under src/watch/ names one of those capabilities (in the
// style of tests/team-no-publish.test.ts), or imports the adapter or the routes that hold them.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WATCH = fileURLToPath(new URL('../src/watch', import.meta.url));

/** The capabilities a watcher must never hold (the daemon's gate, reassign and policy writers). */
const AUTHORITY = [
  'decideGate',
  'confirmGate',
  'reassignUnit',
  'upsertPolicy',
  'upsertConformanceRule',
  'retirePolicy',
  'answerElicitation',
  'cancelRun',
];
/** Modules that hand out those capabilities: importing one is the same leak by another door. */
const FORBIDDEN_IMPORTS = [/from '\.\.\/core\/adapter\.js'/, /from '\.\.\/api\/routes\.js'/, /from '\.\.\/standing-orders\//];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|js|mjs)$/.test(name) ? [p] : [];
  });
}

/** Offending identifiers in `text` (word-bounded, so `undecideGateX` would not count). */
function authorityHits(text: string): string[] {
  return AUTHORITY.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
}

describe('the watch registry holds no authority (G6)', () => {
  const files = sources(WATCH).map((p) => ({ rel: relative(WATCH, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));

  it('the scanner catches a planted capability (self-check)', () => {
    expect(authorityHits('await deps.decideGate(runId, ord, true)')).toEqual(['decideGate']);
    expect(authorityHits('adapter.reassignUnit(r, 1)')).toEqual(['reassignUnit']);
    expect(authorityHits('const decided = gate.decision')).toEqual([]);
  });

  it('src/watch exists and is scanned', () => {
    expect(files.map((f) => f.rel)).toContain('registry.ts');
    expect(files.map((f) => f.rel)).toContain('checks/index.ts');
  });

  it('no file under src/watch names a gate, reassign or policy capability', () => {
    const offenders = files.flatMap((f) => authorityHits(f.text).map((h) => `${f.rel}: ${h}`));
    expect(offenders).toEqual([]);
  });

  it('no file under src/watch imports the adapter, the routes or standing orders', () => {
    const offenders = files.flatMap((f) => FORBIDDEN_IMPORTS.filter((re) => re.test(f.text)).map((re) => `${f.rel}: ${re.source}`));
    expect(offenders).toEqual([]);
  });
});
