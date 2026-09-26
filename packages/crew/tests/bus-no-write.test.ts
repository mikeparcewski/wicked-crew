// wicked-core#631: IN-DAEMON CREW LOADS NO SQLITE LIBRARY AT ALL.
//
// The daemon's bus file is the engine's (DES-TEAMING-002 T0): the engine opens it once, through its
// bundled SQLite, and never closes it. A second SQLite library in the same process cannot share that
// file: POSIX locks belong to the process, so two libraries do not exclude each other's writes
// (sqlite.org/howtocorrupt.html §2.2.1, crew#676/#679), and a close in either drops the other's
// locks (F-E2E-021). crew#680 kept crew's reads on one long-lived better-sqlite3 handle and its
// writes in a child process; since wicked-core#631 crew writes and reads through the engine
// (`Core.busEmit` / `Core.busRead`, src/core/bus.ts) and holds no SQLite at all. So:
//
//   1. LOADED: importing every in-daemon module loads no SQLite library — no better-sqlite3 (by
//      any route: wicked-bus, the wicked-ledger root, a direct import) and no `node:sqlite`. This
//      is the runtime truth, checked in a child process so nothing a test loaded counts.
//   2. NAMED: no in-daemon source names a SQLite library or wicked-bus as a module in any form that
//      loads it (value import, re-export, dynamic import, require, resolve) — so the rule does not
//      depend on which modules the child happened to import. A type-only import is erased at
//      compile time and loads nothing, so it is not counted.
//   3. NO SQL: no in-daemon source prepares SQL, sets a PRAGMA or runs `.exec('…')`.
//   4. DECLARED: wicked-bus and better-sqlite3 are not runtime dependencies of the crew package.
//   5. THE ONE WAY: the bus module reaches the bus through the engine's two calls.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(PKG, 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts') ? [p] : [];
  });
}

/** Strip comments so prose ("the engine's SQLite") never counts. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Module specifiers that are, or load, a SQLite library: better-sqlite3, `node:sqlite`, sqlite3,
 *  wicked-bus (any subpath), and wicked-ledger — which is an ALLOWLIST: only its SQLite-free
 *  `manifest` subpath may be loaded; its root, its store subpaths and any subpath added later
 *  count. */
const SQLITE_MODULE =
  /['"`](better-sqlite3|node:sqlite|sqlite3|wicked-bus(\/[^'"`]*)?|wicked-ledger(?!\/manifest['"`])(\/[^'"`]*)?)['"`]/g;

/** Type-only imports/re-exports (`import type … from '…'`, `export type … from '…'`): erased. */
const TYPE_ONLY = /\b(import|export)\s+type\b[^;]*?\bfrom\s+['"][^'"]+['"]/g;

function sqliteModules(text: string): string[] {
  return text.replace(TYPE_ONLY, '').match(SQLITE_MODULE) ?? [];
}

/** SQL on a connection: `.prepare(`, `.pragma(`, `.exec('…')` (a RegExp `.exec(x)` takes no literal). */
function sqlCalls(text: string): string[] {
  return text.match(/\.(prepare|pragma)\s*\(|\.exec\s*\(\s*['"`]/g) ?? [];
}

/** Import every in-daemon module in a child process (the CLI entry runs `main()` on import, and
 *  imports nothing the rest does not); answer which SQLite libraries that loaded. */
function loadedInChild(): { files: number; betterSqlite3: string[]; native: string[] } {
  const script = `
    import { readdirSync, statSync } from 'node:fs';
    import { join } from 'node:path';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const walk = (d) => readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : /\\.ts$/.test(n) && !n.endsWith('.d.ts') ? [p] : [];
    });
    const files = walk(${JSON.stringify(SRC)}).filter((f) => f !== ${JSON.stringify(join(SRC, 'cli', 'index.ts'))});
    for (const f of files) await import(pathToFileURL(f).href);
    const cache = createRequire(import.meta.url).cache;
    process.stdout.write(JSON.stringify({
      files: files.length,
      betterSqlite3: Object.keys(cache).filter((k) => /better-sqlite3/.test(k)),
      native: process.moduleLoadList.filter((m) => /sqlite/i.test(m)),
    }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: PKG,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(r.status, `the module-load probe failed: ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout) as { files: number; betterSqlite3: string[]; native: string[] };
}

describe('in-daemon crew loads no SQLite library (wicked-core#631)', () => {
  const files = sources(SRC).map((p) => {
    const text = readFileSync(p, 'utf8');
    return { rel: relative(SRC, p).split('\\').join('/'), code: code(text) };
  });

  it('the scanners catch every shape (self-check)', () => {
    for (const planted of [
      `import Database from 'better-sqlite3';`,
      `const { DatabaseSync } = await import('node:sqlite');`,
      `import { emit } from 'wicked-bus';`,
      `const bus = createRequire(import.meta.url)('wicked-bus');`,
      `createRequire(import.meta.url).resolve('wicked-bus/package.json');`,
      `import { VERDICT_VALUES } from 'wicked-ledger';`,
      `import { DomainStore } from 'wicked-ledger/domain-store';`,
      `import { x } from 'wicked-ledger/some-later-subpath';`,
    ]) {
      expect(sqliteModules(planted), planted).toHaveLength(1);
    }
    expect(sqliteModules(`import { VERDICT_VALUES } from 'wicked-ledger/manifest';`)).toEqual([]);
    expect(sqliteModules(`import type { RunRecord } from 'wicked-ledger';`)).toEqual([]); // erased
    expect(sqliteModules(`import type { A } from 'x';\nimport { emit } from 'wicked-bus';`)).toHaveLength(1);
    expect(sqlCalls(`db.prepare('SELECT 1').all()`)).toHaveLength(1);
    expect(sqlCalls(`db.pragma('journal_mode = WAL')`)).toHaveLength(1);
    expect(sqlCalls(`db.exec('INSERT INTO events VALUES (1)')`)).toHaveLength(1);
    expect(sqlCalls(`const m = /a/.exec(text);`)).toEqual([]);
    expect(code(`// import Database from 'better-sqlite3'\nx();`)).not.toMatch(/sqlite/);
  });

  it('importing every in-daemon module loads no SQLite library', () => {
    const loaded = loadedInChild();
    expect(loaded.files).toBeGreaterThan(100); // the walk really imported the daemon
    expect(loaded.betterSqlite3).toEqual([]);
    expect(loaded.native).toEqual([]);
  }, 90_000);

  it('no in-daemon source names a SQLite library or wicked-bus as a module', () => {
    expect(files.flatMap((f) => sqliteModules(f.code).map((hit) => `${f.rel}: ${hit}`))).toEqual([]);
  });

  it('no in-daemon source prepares SQL, sets a PRAGMA or runs .exec(…)', () => {
    expect(files.flatMap((f) => sqlCalls(f.code).map((hit) => `${f.rel}: ${hit}`))).toEqual([]);
  });

  it('wicked-bus and better-sqlite3 are not runtime dependencies of the crew package', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const runtime = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
    expect(runtime.filter((d) => ['wicked-bus', 'better-sqlite3', 'sqlite3'].includes(d))).toEqual([]);
  });

  it('the bus module reaches the bus only through the engine: Core.busEmit and Core.busRead', () => {
    const busModule = files.find((f) => f.rel === 'core/bus.ts')!;
    expect(busModule.code).toMatch(/\.busEmit\(/);
    expect(busModule.code).toMatch(/\.busRead\(/);
    for (const gone of ['core/bus-writer.ts', 'core/bus-handle.ts', 'core/bus-tap.ts']) {
      expect(files.some((f) => f.rel === gone), gone).toBe(false);
    }
  });
});
