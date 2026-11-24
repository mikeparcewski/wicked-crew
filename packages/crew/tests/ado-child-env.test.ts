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
import ts from 'typescript';
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

  it('the post-hoc deliver shell keeps the credential for an Azure DevOps origin only, and nothing else comes back', () => {
    const env = deliverShellEnv({ HOME: '/tmp/h' }, true);
    for (const n of ADO_RAW_ENV) expect(env[n] === FAKE, n).toBe(true);
    expect(env['HOME']).toBe('/tmp/h');
    expect(env['WICKED_CREW_GOVERNANCE_DB']).toBeUndefined();
    // A GitHub (or any other) origin has no header to mint (review r1).
    const other = deliverShellEnv({ HOME: '/tmp/h' });
    for (const n of ADO_RAW_ENV) expect(other[n], n).toBeUndefined();
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

/**
 * (review r1) The governance-child-env guard looks for a helper's name within 900 characters of a call, so a spawn beside
 * a covered one passed, and a promisified alias was not seen at all. This one reads each call: every call of a
 * child_process function, or of a `promisify(...)` alias of one, passes an options object whose `env` is built by a crew
 * child-env helper (directly, or through a variable or parameter default in the same file).
 */
describe('crew#1843 STATIC (AST): every crew child-process call passes an env built by a crew child-env helper', () => {
  const CHILD_PROCESS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);
  // Each builds on childEnvWithBootEstateDb (gitChildEnv / childEnvFor in core/exec.ts, deliverShellEnv in
  // api/post-hoc-deliver.ts, runnerEnv in sources/drivers/sqlite.ts).
  const HELPERS = ['childEnvWithBootEstateDb(', 'gitChildEnv(', 'childEnvFor(', 'deliverShellEnv(', 'runnerEnv('];
  it('finds no call without one', () => {
    const uncovered: string[] = [];
    let calls = 0;
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (rel === 'core/exec.ts') continue; // execCapped: it applies childEnvFor itself
      const text = readFileSync(file, 'utf8');
      if (!/child_process/.test(text)) continue;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const names = new Set<string>();
      const inits = new Map<string, ts.Expression>();
      const scan = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /child_process$/.test(n.moduleSpecifier.text)) {
          const b = n.importClause?.namedBindings;
          if (b !== undefined && ts.isNamedImports(b)) for (const el of b.elements) if (CHILD_PROCESS.has((el.propertyName ?? el.name).text)) names.add(el.name.text);
        }
        if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && ts.isIdentifier(n.name) && n.initializer !== undefined) inits.set(n.name.text, n.initializer);
        ts.forEachChild(n, scan);
      };
      scan(sf);
      // `const exec = promisify(execFile)` is a child-process call too.
      for (const [name, init] of inits) {
        if (ts.isCallExpression(init) && init.expression.getText() === 'promisify' && names.has(init.arguments[0]?.getText() ?? '')) names.add(name);
      }
      // A name resolves in the innermost scope that declares it: a parameter (its default) or a const in a block above.
      const resolveName = (at: ts.Node, name: string): ts.Expression | undefined => {
        for (let a: ts.Node | undefined = at.parent; a !== undefined; a = a.parent) {
          if (ts.isFunctionLike(a)) {
            const p = a.parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === name);
            if (p !== undefined) return p.initializer;
          }
          const statements = ts.isBlock(a) || ts.isSourceFile(a) ? a.statements : undefined;
          for (const st of statements ?? []) {
            if (!ts.isVariableStatement(st)) continue;
            const d = st.declarationList.declarations.find((x) => ts.isIdentifier(x.name) && x.name.text === name);
            if (d !== undefined) return d.initializer;
          }
        }
        return inits.get(name);
      };
      const built = (e: ts.Expression | undefined, depth = 0): boolean => {
        if (e === undefined) return false;
        if (HELPERS.some((h) => e.getText().includes(h))) return true;
        return depth < 2 && ts.isIdentifier(e) && built(resolveName(e, e.text), depth + 1);
      };
      const optionsOf = (call: ts.CallExpression): ts.ObjectLiteralExpression | undefined => {
        for (const a of call.arguments.slice(1)) {
          if (ts.isObjectLiteralExpression(a)) return a;
          if (ts.isIdentifier(a)) { const i = resolveName(a, a.text); if (i !== undefined && ts.isObjectLiteralExpression(i)) return i; }
        }
        return undefined;
      };
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) {
          calls += 1;
          const env = optionsOf(n)?.properties.find((p) => p.name !== undefined && p.name.getText() === 'env');
          const expr = env === undefined ? undefined : ts.isShorthandPropertyAssignment(env) ? env.name : ts.isPropertyAssignment(env) ? env.initializer : undefined;
          if (!built(expr)) uncovered.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.expression.text}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(calls, 'the scan saw the child-process calls').toBeGreaterThan(30);
    expect(uncovered, 'these calls hand a child the daemon env (the raw Azure DevOps credential among it)').toEqual([]);
  });
});
