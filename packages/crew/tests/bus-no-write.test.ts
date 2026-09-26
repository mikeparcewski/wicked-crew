// crew#679: IN-DAEMON CREW NEVER WRITES THE BUS THROUGH ITS OWN SQLITE.
//
// The daemon's bus file is the engine's too (DES-TEAMING-002 T0), written through the engine's
// bundled SQLite. Two SQLite copies in one process do not see each other's POSIX locks
// (sqlite.org/howtocorrupt.html §2.2.1), so a crew write concurrent with an engine write corrupts
// the file. wicked-bus `subscribe` (register + ack + delivery rows), `ack`, `register`, `emit` and
// `openDb` (migrations) all write. So in crew source:
//
//   1. wicked-bus is loaded as a VALUE only by the tap, and only for its read-only helpers; no
//      dynamic import and no require of it anywhere else (bus-handle resolves better-sqlite3 through
//      it, bus-writer resolves its path for the child). Without the module, no seam can call
//      subscribe/ack/register/emit/openDb.
//   2. no `<x>.subscribe(` / `.ack(` / `.register(` / `.emit(` / `.openDb(` / `.poll(` call on a
//      wicked-bus binding, outside the writer's child script;
//   3. every SQL string prepared on crew's bus handle is a SELECT, and only the handle sets PRAGMAs;
//   4. the one writer runs its emits in a CHILD process (its own locks), not in the daemon.
//
// A seam that needs to write goes through `emitOnBus` (core/bus-writer.ts); one that reads uses
// `tapBus` (core/bus-tap.ts) or `crewBusHandle`.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** The only file that value-imports wicked-bus, and the only names it may take. */
const TAP = 'core/bus-tap.ts';
const TAP_NAMES = ['loadConfig', 'matchesFilter', 'resolveDbPath'];
/** Files that may resolve wicked-bus by path (never load it for its API). */
const RESOLVERS = new Set(['core/bus-handle.ts', 'core/bus-writer.ts']);
const WRITER = 'core/bus-writer.ts';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts') ? [p] : [];
  });
}

/** Strip comments so prose ("a subscribe writes") never counts as a call. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Value imports of wicked-bus: `import { a, b } from 'wicked-bus'` (not `import type`). */
function valueImports(text: string): string[][] {
  const out: string[][] = [];
  const re = /\bimport\s+(?!type\b)([^;]*?)\s+from\s+['"]wicked-bus['"]/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const names = (m[1]!.match(/\{([\s\S]*)\}/)?.[1] ?? m[1]!)
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '' && !n.startsWith('type '));
    out.push(names);
  }
  return out;
}

/** Dynamic loads of wicked-bus: `import('wicked-bus')`, `require('wicked-bus')`, `.resolve('wicked-bus')`. */
function dynamicLoads(text: string): string[] {
  return text.match(/\b(import|require|resolve)\s*\(\s*['"]wicked-bus(\/[^'"]*)?['"]\s*\)/g) ?? [];
}

/** Calls of a wicked-bus write (or its read-and-ack poll) on a binding: `bus.emit(`, `wb.subscribe(`. */
function busWriteCalls(text: string): string[] {
  return text.match(/\b(bus|wb|wickedBus)\s*\.\s*(subscribe|subscribePushOrPoll|ack|register|emit|openDb|poll)\s*\(/g) ?? [];
}

/** Every `.prepare(` argument text (to its balanced close paren). */
function prepared(text: string): string[] {
  const hits: string[] = [];
  const re = /\.prepare\s*\(/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    hits.push(text.slice(m.index + m[0].length, i - 1));
  }
  return hits;
}

const SQL_WRITE = /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|VACUUM|ATTACH)\b/i;

describe('in-daemon crew never writes the bus through its own SQLite (crew#679)', () => {
  const files = sources(SRC).map((p) => {
    const text = readFileSync(p, 'utf8');
    return { rel: relative(SRC, p).split('\\').join('/'), text, code: code(text) };
  });
  // The writer's child script is the one sanctioned emit; it runs in another process.
  const withoutChild = (f: { rel: string; code: string }): string =>
    f.rel === WRITER ? f.code.replace(/const CHILD = `[\s\S]*?`;/, '') : f.code;

  it('the scanners catch every write shape (self-check)', () => {
    const planted = [
      `const bus = await import('wicked-bus');`,
      `bus.subscribe({ db, plugin: 'p', filter: 'f', handler });`,
      `bus.emit(db, config, { event_type: 't' });`,
      `bus.ack(db, c, 1); bus.register(db, {}); bus.openDb({});`,
    ].join('\n');
    expect(dynamicLoads(planted)).toHaveLength(1);
    expect(busWriteCalls(planted)).toHaveLength(5);
    expect(valueImports(`import { emit, subscribe } from 'wicked-bus';`)).toEqual([['emit', 'subscribe']]);
    expect(valueImports(`import type { BusEvent } from 'wicked-bus';`)).toEqual([]);
    expect(valueImports(`import { x } from './y';\nimport type { BusEvent } from 'wicked-bus';`)).toEqual([]);
    expect(prepared(`db.prepare('INSERT INTO events VALUES (1)').run()`).some((s) => SQL_WRITE.test(s))).toBe(true);
    expect(code(`// bus.emit(db)\nx();`)).not.toMatch(/emit/);
  });

  it('only the tap value-imports wicked-bus, and only its read-only helpers', () => {
    const importers = files.filter((f) => valueImports(f.code).length > 0);
    expect(importers.map((f) => f.rel)).toEqual([TAP]);
    const names = valueImports(importers[0]!.code).flat().sort();
    expect(names.filter((n) => !TAP_NAMES.includes(n))).toEqual([]);
  });

  it('nothing else loads wicked-bus: no dynamic import, and a path resolve only where sanctioned', () => {
    const offenders = files.flatMap((f) =>
      dynamicLoads(f.code)
        .filter((hit) => !(RESOLVERS.has(f.rel) && /^resolve/.test(hit)))
        .map((hit) => `${f.rel}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no subscribe/ack/register/emit/openDb/poll call on a wicked-bus binding', () => {
    const offenders = files.flatMap((f) => busWriteCalls(withoutChild(f)).map((hit) => `${f.rel}: ${hit}`));
    expect(offenders).toEqual([]);
  });

  it("every SQL string prepared in src is a read, and only the bus handle sets PRAGMAs", () => {
    const writes = files.flatMap((f) =>
      prepared(f.code)
        .filter((sql) => SQL_WRITE.test(sql))
        .map((sql) => `${f.rel}: ${sql.slice(0, 100)}`),
    );
    // Crew's own stores (not the bus) are outside this rule: none prepares SQL in src today, so
    // any write that appears here is new and must say which file it writes.
    expect(writes).toEqual([]);
    const pragmas = files.filter((f) => /\.pragma\s*\(/.test(f.code)).map((f) => f.rel);
    expect(pragmas).toEqual(['core/bus-handle.ts']);
  });

  it('the one writer emits from a child process, never in the daemon', () => {
    const writer = files.find((f) => f.rel === WRITER)!;
    expect(writer.code).toMatch(/\bspawn\(process\.execPath/);
    expect(writer.code).toMatch(/const CHILD = `[\s\S]*bus\.emit\(db, config/);
    expect(busWriteCalls(withoutChild(writer))).toEqual([]);
  });
});
