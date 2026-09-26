// DES-TEAMING-002 T8 (g), §7 assertion 4: CREW PUBLISHES NOTHING on `wicked.team.*`. It relays,
// reads and POSTs commands; every team fact has exactly one owner inside wicked-core. This scan
// fails the build if crew source emits a team type onto the bus.
//
// Two rules, so a publisher cannot slip past by spelling the type through a constant:
//   1. no `emit(` call in src/ names a `wicked.team.` type in its arguments;
//   2. the `wicked.team.` literal appears only in the relay and the read route, and neither of
//      those files calls `emit(` at all.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** The files that may name the team types: they subscribe to and read the engine's rows. */
const READERS = new Set(['team/ws-relay.ts', 'team/routes.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|js|mjs)$/.test(name) ? [p] : [];
  });
}

/** Every `emit(` call's argument text (to its balanced close paren) that names a team type. */
function teamEmits(text: string): string[] {
  const hits: string[] = [];
  const re = /\bemit\w*\s*\(/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    const args = text.slice(m.index, i);
    if (args.includes('wicked.team.')) hits.push(args);
  }
  return hits;
}

describe('crew publishes no wicked.team.* row (T8 (g))', () => {
  const files = sources(SRC).map((p) => ({ rel: relative(SRC, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));

  it('the scanner catches a team emit (self-check)', () => {
    const planted = `bus.emit(db, config, {\n  event_type: 'wicked.team.plan.proposed',\n  payload: { by: 'human' },\n});`;
    expect(teamEmits(planted)).toHaveLength(1);
    expect(teamEmits(`relay.emitInteractive('wicked.interactive.status.requested', {}, k)`)).toEqual([]);
  });

  it('no emit( call in src/ names a wicked.team. type', () => {
    const offenders = files.flatMap((f) => teamEmits(f.text).map((a) => `${f.rel}: ${a.slice(0, 120)}`));
    expect(offenders).toEqual([]);
  });

  it('only the relay and the read route name wicked.team., and neither emits', () => {
    const naming = files.filter((f) => f.text.includes('wicked.team.')).map((f) => f.rel).sort();
    expect(naming.filter((rel) => !READERS.has(rel))).toEqual([]);
    for (const f of files.filter((x) => READERS.has(x.rel))) {
      expect(/\bemit\w*\s*\(/.test(f.text), `${f.rel} calls emit(`).toBe(false);
    }
    // The readers exist: an empty allowlist would pass rule 2 vacuously.
    expect(naming).toEqual([...READERS].sort());
  });
});
