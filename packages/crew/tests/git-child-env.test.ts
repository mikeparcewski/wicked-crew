// crew#1843 — every git crew starts runs without the daemon's raw Azure DevOps credential and with fsmonitor off.
//
// The live check of crew#1841 found `AZURE_DEVOPS_EXT_PAT` in the environment of children that never use it, among them
// `git fsmonitor--daemon` processes a host's global `core.fsmonitor=true` starts on each checkout a git reads, which
// then outlived the daemon. `gitChildEnv` (core/exec.ts) is the one environment every crew git gets:
//
//   1. UNIT: it drops the credential and appends `core.fsmonitor=false` after the caller's own GIT_CONFIG_* entries.
//   2. RUNTIME: a real git run through `execCapped` reads fsmonitor off over a global config that turns it on, and a
//      command git starts (an alias, as a hook or filter is) sees no credential.
//   3. STATIC: every git crew starts outside `execCapped` builds its environment with `gitChildEnv`/`childEnvFor`, so
//      a new git call site fails here until it does.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { ADO_PAT_ENV, ADO_SP_ENV } from '../src/core/deliver-credentials.js';
import { ADO_RAW_ENV, childEnvFor, execCapped, gitChildEnv, isGitProgram, withoutAdoCredential } from '../src/core/exec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const FAKE = 'made-up-ado-value-0123'; // ggignore: a made-up test value, never a real token

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('crew#1843 gitChildEnv', () => {
  it('names the same variables the credential check reads', () => {
    expect([...ADO_RAW_ENV].sort()).toEqual([ADO_PAT_ENV, ...ADO_SP_ENV].sort());
  });

  it('drops the raw Azure DevOps credential and appends fsmonitor off after the caller\'s own -c entries', () => {
    const env = gitChildEnv({
      PATH: '/bin',
      ...Object.fromEntries(ADO_RAW_ENV.map((n) => [n, FAKE])),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.followRedirects', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=true'",
    });
    for (const n of ADO_RAW_ENV) expect(env[n], n).toBeUndefined();
    expect(env['PATH']).toBe('/bin');
    // The caller's numbered entries are untouched; the -c channel, read after them, ends with fsmonitor off.
    expect([env['GIT_CONFIG_COUNT'], env['GIT_CONFIG_KEY_0'], env['GIT_CONFIG_VALUE_0']]).toEqual(['1', 'http.followRedirects', 'false']);
    expect(env['GIT_CONFIG_PARAMETERS']).toBe("'core.fsmonitor=true' 'core.fsmonitor=false'");
    // Applied twice (a caller's env built by gitChildEnv, then execCapped's), it is still the last entry.
    expect(gitChildEnv(env)['GIT_CONFIG_PARAMETERS']).toBe("'core.fsmonitor=true' 'core.fsmonitor=false' 'core.fsmonitor=false'");
    // A quoted VALUE that ends like the entry is not the entry (review r1): it is appended all the same.
    expect(gitChildEnv({ GIT_CONFIG_PARAMETERS: "'review.note'='core.fsmonitor=false'" })['GIT_CONFIG_PARAMETERS'])
      .toBe("'review.note'='core.fsmonitor=false' 'core.fsmonitor=false'");
    // A caller that cleared the channel (the Azure DevOps clone does) gets the entry alone.
    expect(gitChildEnv({ PATH: '/bin', GIT_CONFIG_PARAMETERS: '' })['GIT_CONFIG_PARAMETERS']).toBe("'core.fsmonitor=false'");
  });

  it('on Windows, drops the credential under any spelling of its name (names are case-insensitive there)', () => {
    const env = withoutAdoCredential({ PATH: 'C:\\Windows', Azure_Devops_Ext_Pat: FAKE, crew_ado_client_secret: FAKE }, 'win32');
    expect(Object.keys(env)).toEqual(['PATH']);
    // Elsewhere a differently spelled name is another variable, which nothing reads.
    expect(Object.keys(withoutAdoCredential({ Azure_Devops_Ext_Pat: FAKE }, 'linux'))).toEqual(['Azure_Devops_Ext_Pat']);
  });

  it('fsmonitor off applies to git only; another program loses the raw credential too (crew#1843 residual)', () => {
    for (const git of ['git', '/usr/bin/git', 'C:\\Program Files\\Git\\cmd\\git.exe']) expect(isGitProgram(git), git).toBe(true);
    for (const other of ['bash', 'gh', 'node', '/usr/bin/gitk', 'git-lfs']) expect(isGitProgram(other), other).toBe(false);
    const env = childEnvFor('bash', { PATH: '/bin', [ADO_PAT_ENV]: FAKE });
    // Every crew child runs without it; the deliver script and the minting helper ask for it back (ado-child-env.test.ts).
    expect(env[ADO_PAT_ENV]).toBeUndefined();
    expect(env['PATH']).toBe('/bin');
    expect(env['GIT_CONFIG_PARAMETERS']).toBeUndefined();
  });
});

describe('crew#1843 RUNTIME: a real git through execCapped', () => {
  const saved = Object.fromEntries(ADO_RAW_ENV.map((n) => [n, process.env[n]]));
  const roots: string[] = [];
  afterEach(() => {
    for (const n of ADO_RAW_ENV) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('reads fsmonitor off over a global config that turns it on, and starts nothing that sees the credential', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-1843-'));
    roots.push(root);
    const global = join(root, 'gitconfig');
    writeFileSync(global, '[core]\n\tfsmonitor = true\n');
    for (const n of ADO_RAW_ENV) process.env[n] = FAKE;
    // The daemon's own env (the default) and a caller env that spreads it are both covered.
    // Over a numbered entry and an inherited -c that both turn it on, too.
    const env: NodeJS.ProcessEnv = {
      ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_PARAMETERS: "'core.fsmonitor=true'",
    };
    const fsmonitor = await execCapped('git', ['config', '--get', 'core.fsmonitor'], { cwd: root, env, timeout: 20_000 });
    expect(fsmonitor.stdout.trim()).toBe('false');
    // Names only: the probe prints whether each variable is set, never its value.
    const probe = `!f() { for n in ${ADO_RAW_ENV.join(' ')}; do eval "v=\\\${$n+set}"; echo "$n=\${v:-unset}"; done; }; f`;
    const seen = await execCapped('git', ['-c', `alias.probe=${probe}`, 'probe'], { cwd: root, env, timeout: 20_000 });
    expect(seen.stdout.trim().split('\n')).toEqual(ADO_RAW_ENV.map((n) => `${n}=unset`));
    expect(seen.stdout).not.toContain(FAKE);
  }, 30_000);
});

describe('crew#1843 STATIC: every git crew starts outside execCapped builds its env with gitChildEnv', () => {
  it('names every git call site and each one is covered', () => {
    const WINDOW = 900;
    const sites: string[] = [];
    const uncovered: string[] = [];
    const covered = (text: string): boolean => text.includes('gitChildEnv(') || text.includes('childEnvFor(');
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (rel === 'core/exec.ts') continue; // the wrapper: execCapped applies childEnvFor itself
      const src = readFileSync(file, 'utf8');
      for (const lit of src.matchAll(/['"]git['"]\s*,/g)) {
        // The literal is a call's first argument: `callee(` right before it.
        const m = /(?<![\w$.])([A-Za-z_$][\w$]*)\(\s*$/.exec(src.slice(Math.max(0, lit.index! - 80), lit.index));
        if (m === null) continue;
        const callee = m[1]!;
        if (callee === 'execCapped') continue;
        const at = lit.index!;
        const site = `${rel}:${src.slice(0, at).split('\n').length} ${callee}`;
        sites.push(site);
        // A direct child-process call builds its env in the same statement; an injected runner (`exec`, a
        // promisified `git`) is covered where its default is defined, in the same file.
        const direct = ['spawn', 'nodeSpawn', 'execFile', 'execFileSync', 'spawnSync'].includes(callee);
        const ok = direct
          ? covered(src.slice(Math.max(0, at - WINDOW), at + WINDOW))
          : covered(src) || /=\s*execCapped\b/.test(src);
        if (!ok) uncovered.push(site);
      }
    }
    for (const expected of ['apps/git.ts', 'core/repo-clone.ts', 'api/worktree-sweep.ts', 'learn/scheduler.ts']) {
      expect(sites.some((s) => s.startsWith(expected)), `expected a git call site in ${expected}; scan saw ${JSON.stringify(sites)}`).toBe(true);
    }
    expect(uncovered, 'these git calls do not build their env with gitChildEnv: the daemon\'s Azure DevOps token reaches them, and fsmonitor may start').toEqual([]);
  });
});
