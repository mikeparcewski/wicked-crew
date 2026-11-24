// crew#1843 — the daemon's raw Azure DevOps credential reaches only the two children that use it.
//
// The live check of crew#1841 found `AZURE_DEVOPS_EXT_PAT` in the environment of children that never use it. The gits
// were fixed by `gitChildEnv` (crew#1860) and the deliver scripts' own gits by crew#1866; every other child crew starts
// (the estate CLI and MCP, the toolbox, version probes, the OS opener, the voice and recording tools, …) still got the
// daemon's whole environment. Every one of them builds its env with `childEnvWithBootEstateDb` (the STATIC guard in
// governance-child-env.test.ts), so that one helper drops the credential, and the two children that mint a header from
// it ask for it back by name (`withAdoCredential`):
//
//   1. UNIT: the helper drops every raw name, and `withAdoCredential` puts back only those names, from the given env.
//   2. RUNTIME: a real child through `execCapped` (not a git) sees none of the names; the ADO header helper, run the way
//      every Azure DevOps clone, work-item read and PR view runs it, still mints a header from the PAT.
//   3. STATIC: only the header helper and the post-hoc deliver script ask for the credential.
//
// Names only: every probe prints whether a variable is set, never its value; the value is made up.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADO_RAW_ENV, execCapped, withAdoCredential } from '../src/core/exec.js';
import { childEnvWithBootEstateDb } from '../src/core/governance-store.js';
import { defaultAdoHelperExec } from '../src/core/deliver.js';
import { deliverShellEnv } from '../src/api/post-hoc-deliver.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const FAKE = 'made-up-ado-value-1843'; // ggignore: a made-up test value, never a real token

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

/** A node program that prints `NAME=set|unset` for each raw name. */
const PROBE = `for (const n of ${JSON.stringify(ADO_RAW_ENV)}) console.log(n + '=' + (process.env[n] === undefined ? 'unset' : 'set'));`;

describe('crew#1843 every crew child but the header minters runs without the raw Azure DevOps credential', () => {
  const before = Object.fromEntries(ADO_RAW_ENV.map((n) => [n, process.env[n]]));
  beforeEach(() => {
    for (const n of ADO_RAW_ENV) process.env[n] = FAKE;
  });
  afterEach(() => {
    for (const n of ADO_RAW_ENV) {
      if (before[n] === undefined) delete process.env[n];
      else process.env[n] = before[n];
    }
  });

  it('the crew child env drops every raw name; the opt-in puts back exactly those names', () => {
    const env = childEnvWithBootEstateDb({ PATH: '/bin', ...Object.fromEntries(ADO_RAW_ENV.map((n) => [n, FAKE])) });
    for (const n of ADO_RAW_ENV) expect(env[n], n).toBeUndefined();
    expect(env['PATH']).toBe('/bin');
    const back = withAdoCredential({ PATH: '/bin' }, { PATH: '/other', OTHER: 'x', AZURE_DEVOPS_EXT_PAT: FAKE });
    expect(Object.keys(back).sort()).toEqual(['AZURE_DEVOPS_EXT_PAT', 'PATH']);
    expect(back['PATH']).toBe('/bin');
  });

  it('a real non-git child through execCapped sees none of the names', async () => {
    const seen = await execCapped(process.execPath, ['-e', PROBE], { timeout: 20_000 });
    expect(seen.stdout.trim().split('\n')).toEqual(ADO_RAW_ENV.map((n) => `${n}=unset`));
    // A caller env that spreads process.env is scrubbed the same way.
    const viaCaller = await execCapped(process.execPath, ['-e', PROBE], { timeout: 20_000, env: { ...process.env } });
    expect(viaCaller.stdout.trim().split('\n')).toEqual(ADO_RAW_ENV.map((n) => `${n}=unset`));
    expect(seen.stdout + viaCaller.stdout).not.toContain(FAKE);
  }, 30_000);

  it('the post-hoc deliver shell keeps the credential its header helper mints from, and nothing else comes back', () => {
    const env = deliverShellEnv({ HOME: '/tmp/h' });
    for (const n of ADO_RAW_ENV) expect(env[n] === FAKE, n).toBe(true);
    expect(env['HOME']).toBe('/tmp/h');
    expect(env['WICKED_CREW_GOVERNANCE_DB']).toBeUndefined();
  });

  it('the Azure DevOps header helper still gets the PAT it mints from', async () => {
    // The PAT path (the service principal would call Entra): the helper answers `Basic <base64>` from the PAT alone.
    for (const n of ADO_RAW_ENV) if (n !== 'AZURE_DEVOPS_EXT_PAT') delete process.env[n];
    const minted = await defaultAdoHelperExec(['header', 'https://login.example.invalid'], { timeoutMs: 20_000 });
    expect(minted.code).toBe(0);
    expect(/^Basic \S+$/.test(minted.stdout.trim()), 'the helper minted a Basic header').toBe(true);
  }, 30_000);
});

describe('crew#1843 STATIC: only the header helper and the post-hoc deliver script ask for the credential back', () => {
  it('names every opt-in site', () => {
    const sites: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?<![\w$.])withAdoCredential\(/g)) {
        const before = src.slice(0, m.index);
        // The definition is not a use.
        if (/export function\s*$/.test(before)) continue;
        // The enclosing top-level declaration: the nearest `export function name` / `export const name` above the call.
        const fn = [...before.matchAll(/^export (?:async )?(?:function|const)\s+([A-Za-z_$][\w$]*)/gm)].at(-1);
        sites.push(`${rel} ${fn?.[1] ?? '?'}`);
      }
    }
    expect(sites.sort()).toEqual(['api/post-hoc-deliver.ts deliverShellEnv', 'core/deliver.ts defaultAdoHelperExec']);
  });
});
