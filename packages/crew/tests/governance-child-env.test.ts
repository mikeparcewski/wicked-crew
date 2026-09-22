// The engine-only store variable never leaves the daemon process (crew#495).
//
// `serve` exports the governance store to the in-process engine as WICKED_ESTATE_DB — and an
// explicit `--governance-db postgres://user:password@host/db` puts a credential in that variable.
// Governed workers never see it (core strips it from every spawn — `spawn.rs` hardened(),
// FINDING-067), but crew spawns children of its own: git and the estate CLI through `execCapped`,
// the deliver `bash`, the wicked-interactive bridge, the OS opener, the estate MCP. Every one of
// them must get the process's BOOT value back (`childEnvWithBootEstateDb`) — the operator's own
// instruction, or nothing — never the daemon's export. Two guards:
//
//   1. RUNTIME: a real `execCapped` child, with the daemon's export in `process.env`, does not see
//      it — with the default env AND with a caller-supplied env that spreads `process.env`.
//   2. STATIC: every child-process call site in src/ that is not `execCapped` itself routes its env
//      through the helper (a new spawn site fails here until it does).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { execCapped } from '../src/core/exec.js';
import { childEnvWithBootEstateDb, ESTATE_DB_ENGINE_ENV, GOVERNANCE_DB_ENV } from '../src/core/governance-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const DAEMON_EXPORT = 'postgres://user:s3cret@db.internal/gov';

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('RUNTIME — execCapped children never inherit the daemon\'s exported governance store, nor crew\'s own override', () => {
  const before = process.env[ESTATE_DB_ENGINE_ENV];
  const beforeOverride = process.env[GOVERNANCE_DB_ENV];
  afterEach(() => {
    if (before === undefined) delete process.env[ESTATE_DB_ENGINE_ENV];
    else process.env[ESTATE_DB_ENGINE_ENV] = before;
    if (beforeOverride === undefined) delete process.env[GOVERNANCE_DB_ENV];
    else process.env[GOVERNANCE_DB_ENV] = beforeOverride;
  });

  it('default env and a caller env that spreads process.env both carry the BOOT value, never the export; the override is dropped', async () => {
    process.env[ESTATE_DB_ENGINE_ENV] = DAEMON_EXPORT;
    process.env[GOVERNANCE_DB_ENV] = '/opt/operator/gov.db';
    const script = `process.stdout.write(String(process.env[${JSON.stringify(ESTATE_DB_ENGINE_ENV)}] ?? '<unset>') + '|' + String(process.env['X_CALLER'] ?? '') + '|' + String(process.env[${JSON.stringify(GOVERNANCE_DB_ENV)}] ?? '<unset>'))`;
    // The boot value in this process is whatever the harness started with (unset), so a child must see <unset>.
    const expectedBoot = childEnvWithBootEstateDb({})[ESTATE_DB_ENGINE_ENV] ?? '<unset>';
    const viaDefault = await execCapped(process.execPath, ['-e', script], { timeout: 20_000 });
    expect(viaDefault.stdout).toBe(`${expectedBoot}||<unset>`);
    expect(viaDefault.stdout).not.toContain('s3cret');
    const viaCaller = await execCapped(process.execPath, ['-e', script], {
      timeout: 20_000,
      env: { ...process.env, X_CALLER: 'kept' },
    });
    expect(viaCaller.stdout).toBe(`${expectedBoot}|kept|<unset>`);
    expect(viaCaller.stdout).not.toContain('s3cret');
  });
});

describe('STATIC — every non-execCapped child-process call in src/ routes its env through childEnvWithBootEstateDb', () => {
  it('names every spawn site and each one is covered', () => {
    // `spawn(` / `execFile(` / `nodeSpawn(` / `execFileSync(` — the direct child-process entry points
    // crew uses; `execCapped` itself is the covered wrapper and is excluded.
    const CALLS = ['spawn(', 'nodeSpawn(', 'execFile(', 'execFileSync(', 'spawnSync('];
    const WINDOW = 900;
    const sites: string[] = [];
    const uncovered: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel === join('core', 'exec.ts')) continue; // the wrapper: its ONE call is the covered path
      const src = readFileSync(file, 'utf8');
      for (const call of CALLS) {
        for (let idx = src.indexOf(call); idx !== -1; idx = src.indexOf(call, idx + 1)) {
          const before = idx === 0 ? ' ' : src[idx - 1]!;
          if (/[\w$]/.test(before) && before !== '.') continue; // `respawn(`, `Core.spawn(` are not child spawns…
          if (before === '.' && /Core\.\s*$/.test(src.slice(Math.max(0, idx - 8), idx))) continue; // …nor the napi factory
          const line = src.slice(0, idx).split('\n').length;
          // A METHOD SIGNATURE (`spawn(path: string): CoreHandleFull;` on the napi constructor type)
          // is a declaration, not a child spawn: the line is `name(params): Type;` and nothing else.
          const lineText = src.split('\n')[line - 1] ?? '';
          if (/^\s*\w+\([^)]*\)\s*:\s*[\w<>[\]|.\s]+;\s*$/.test(lineText)) continue;
          const site = `${rel}:${line}`;
          sites.push(site);
          // The env must be built in the same statement — look a bounded window around the call.
          const window = src.slice(Math.max(0, idx - WINDOW), idx + WINDOW);
          if (!window.includes('childEnvWithBootEstateDb(')) uncovered.push(site);
        }
      }
    }
    // The scan is looking at something: the known sites are here.
    for (const expected of ['core/estate-mcp-client.ts', 'api/post-hoc-deliver.ts', 'api/open-path.ts']) {
      expect(sites.some((s) => s.startsWith(expected)), `expected a spawn site in ${expected}; scan saw ${JSON.stringify(sites)}`).toBe(true);
    }
    expect(
      uncovered,
      'these child-process calls do not route their env through childEnvWithBootEstateDb — a daemon-exported ' +
        '`postgres://user:password@…` governance store would reach that child (crew#495)',
    ).toEqual([]);
  });
});
