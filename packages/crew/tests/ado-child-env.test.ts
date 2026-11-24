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
import { defaultAdoHelperExec, deliverAdoTarget } from '../src/core/deliver.js';
import { adoRepoOf } from '../src/core/deliver-credentials.js';
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

  it('the post-hoc shell decides from the same target the script pushes to (review r1 delta)', () => {
    // runDeliverScript passes `deliverAdoTarget(opts) !== null` to deliverShellEnv, and deliverPrScript composes its
    // push from `deliverAdoTarget(opts)`: one answer, so an explicit target (the test seam) or an Azure DevOps origin
    // gets the credential, and a fresh origin probe can no longer disagree with the script.
    const ado = adoRepoOf('https://dev.azure.com/org/proj/_git/repo');
    expect(ado).not.toBeNull();
    expect(deliverAdoTarget({ originUrl: 'https://dev.azure.com/org/proj/_git/repo' })).toEqual(ado);
    expect(deliverAdoTarget({ adoTarget: ado, originUrl: 'https://github.com/o/r.git' })).toEqual(ado);
    expect(deliverAdoTarget({ adoTarget: null, originUrl: 'https://dev.azure.com/org/proj/_git/repo' })).toBeNull();
    expect(deliverAdoTarget({ originUrl: 'https://github.com/o/r.git' })).toBeNull();
    expect(deliverAdoTarget({})).toBeNull();
  });

  it('the Azure DevOps header helper still gets the PAT it mints from', async () => {
    // The PAT path (the service principal would call Entra): the helper answers `Basic <base64>` from the PAT alone.
    for (const n of ADO_RAW_ENV) if (n !== 'AZURE_DEVOPS_EXT_PAT') delete process.env[n];
    const minted = await defaultAdoHelperExec(['header', 'https://login.example.invalid'], { timeoutMs: 20_000 });
    expect(minted.code).toBe(0);
    expect(/^Basic \S+$/.test(minted.stdout.trim()), 'the helper minted a Basic header').toBe(true);
  }, 30_000);
});

type Src = { rel: string; text: string };

const srcFiles = (): Src[] => tsFiles(SRC).map((file) => ({ rel: relative(SRC, file).split('\\').join('/'), text: readFileSync(file, 'utf8') }));

const strip = (e: ts.Expression | undefined): ts.Expression | undefined => {
  while (e !== undefined && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e))) e = e.expression;
  return e;
};

/** The name of the top-level declaration `n` sits in (`?` for a bare statement). */
function topLevelName(n: ts.Node): string {
  let a: ts.Node = n;
  while (a.parent !== undefined && !ts.isSourceFile(a.parent)) a = a.parent;
  if ((ts.isFunctionDeclaration(a) || ts.isClassDeclaration(a)) && a.name !== undefined) return a.name.text;
  if (ts.isVariableStatement(a)) { const d = a.declarationList.declarations[0]; if (d !== undefined && ts.isIdentifier(d.name)) return d.name.text; }
  return '?';
}

/**
 * (review r1 delta) Every use of `withAdoCredential`, by binding rather than by text: the bare name, an import alias
 * (`{ withAdoCredential as w }`) and a namespace member (`m.withAdoCredential`), called or passed as a value. Its
 * definition and the import/export specifiers that move it are not uses.
 */
function adoOptInSites(files: Src[]): string[] {
  const sites: string[] = [];
  for (const { rel, text } of files) {
    if (!text.includes('withAdoCredential')) continue;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const local = new Set(['withAdoCredential']);
    const collect = (n: ts.Node): void => {
      if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === 'withAdoCredential') local.add(n.name.text);
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const visit = (n: ts.Node): void => {
      const p = n.parent;
      const moved = p !== undefined && (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || (ts.isFunctionDeclaration(p) && p.name === n));
      const member = p !== undefined && ts.isPropertyAccessExpression(p) && p.name === n;
      if (ts.isIdentifier(n) && !moved && (member ? n.text === 'withAdoCredential' : local.has(n.text))) sites.push(`${rel} ${topLevelName(n)}`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return sites.sort();
}

const CHILD_PROCESS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);
/** The crew child-env helpers: each builds on childEnvWithBootEstateDb (gitChildEnv / childEnvFor in core/exec.ts,
 *  deliverShellEnv in api/post-hoc-deliver.ts, runnerEnv in sources/drivers/sqlite.ts). */
const HELPERS = new Set(['childEnvWithBootEstateDb', 'gitChildEnv', 'childEnvFor', 'deliverShellEnv', 'runnerEnv']);
/** Wrappers that add to (or take from) the env they are given, and the argument that env is: built iff that one is.
 *  The guard below checks none of them reads `process.env` in its body. */
const WRAPPERS = new Map([['withAdoCredential', 0], ['withoutAdoCredential', 0], ['nonInteractiveGitEnv', 0], ['ghChildEnv', 0], ['learningSubmitEnv', 2], ['estateRelayEnv', 1]]);

const isCpModule = (n: ts.Node): boolean => ts.isStringLiteral(n) && /^(node:)?child_process$/.test(n.text);
const calleeName = (e: ts.Expression): string | undefined => {
  const s = strip(e);
  return s === undefined ? undefined : ts.isIdentifier(s) ? s.text : ts.isPropertyAccessExpression(s) ? s.name.text : undefined;
};
const isOr = (e: ts.Expression): e is ts.BinaryExpression => ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken);
const isProcessEnv = (e: ts.Expression | undefined): boolean => { const s = strip(e); return s !== undefined && s.getText() === 'process.env'; };

/**
 * (review r1, hardened in the r1 delta) Every crew child-process call and the env it passes. A child-process function is
 * reached through a named import (aliased or not), a namespace or default import (`cp.spawn`), a `require` of the
 * module, a `promisify(...)` of one, a plain alias (`const launch = spawn`, `deps.spawn ?? spawn`), or an injected
 * seam (a class property or parameter that holds one: `this.spawnImpl`, `spawnImpl: VoiceSpawn`). The env must be
 * BUILT: a helper call, a wrapper of a built env, both branches of a `?:` / `??` built, an object whose first spread
 * is built and no later spread is `process.env`, or a name whose every value (initializer and reassignments) is built.
 */
function uncoveredChildCalls(files: Src[]): { calls: number; uncovered: string[] } {
  const parsed = files.filter((f) => f.rel !== 'core/exec.ts').map((f) => ({ ...f, sf: ts.createSourceFile(f.rel, f.text, ts.ScriptTarget.Latest, true) }));
  const spawnTypes = new Set<string>();
  const spawnProps = new Set<string>();
  const state = new Map(parsed.map((f) => [f.rel, { names: new Set<string>(), ns: new Set<string>() }]));
  // Pass 1, to a fixpoint across files: the names, namespaces, properties and types that hold a child-process function.
  for (let round = 0; round < 4; round += 1) {
    for (const f of parsed) {
      const st = state.get(f.rel)!;
      const holds = (e0: ts.Expression | undefined): boolean => {
        const e = strip(e0);
        if (e === undefined) return false;
        if (ts.isIdentifier(e)) return st.names.has(e.text);
        if (ts.isPropertyAccessExpression(e)) {
          return (ts.isIdentifier(e.expression) && st.ns.has(e.expression.text) && CHILD_PROCESS.has(e.name.text)) ||
            (e.expression.kind === ts.SyntaxKind.ThisKeyword && spawnProps.has(e.name.text));
        }
        if (isOr(e)) return holds(e.left) || holds(e.right);
        if (ts.isConditionalExpression(e)) return holds(e.whenTrue) || holds(e.whenFalse);
        if (ts.isCallExpression(e) && calleeName(e.expression) === 'promisify') return holds(e.arguments[0]);
        return false;
      };
      const scan = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n) && isCpModule(n.moduleSpecifier)) {
          const c = n.importClause;
          if (c?.name !== undefined) st.ns.add(c.name.text);
          const b = c?.namedBindings;
          if (b !== undefined && ts.isNamespaceImport(b)) st.ns.add(b.name.text);
          if (b !== undefined && ts.isNamedImports(b)) for (const el of b.elements) if (CHILD_PROCESS.has((el.propertyName ?? el.name).text)) st.names.add(el.name.text);
        }
        if (ts.isVariableDeclaration(n) && n.initializer !== undefined) {
          const init = strip(n.initializer);
          const req = init !== undefined && ts.isCallExpression(init) && calleeName(init.expression) === 'require' && init.arguments[0] !== undefined && isCpModule(init.arguments[0]);
          if (req && ts.isIdentifier(n.name)) st.ns.add(n.name.text);
          else if (req && ts.isObjectBindingPattern(n.name)) {
            for (const el of n.name.elements) if (CHILD_PROCESS.has((el.propertyName ?? el.name).getText()) && ts.isIdentifier(el.name)) st.names.add(el.name.text);
          } else if (ts.isIdentifier(n.name) && holds(n.initializer)) st.names.add(n.name.text);
        }
        if ((ts.isParameter(n) || ts.isPropertyDeclaration(n) || ts.isPropertySignature(n)) && ts.isIdentifier(n.name)) {
          const typed = n.type !== undefined && ts.isTypeReferenceNode(n.type) && spawnTypes.has(n.type.typeName.getText());
          const init = ts.isPropertySignature(n) ? undefined : n.initializer;
          if (typed || (init !== undefined && holds(init))) (ts.isParameter(n) ? st.names : spawnProps).add(n.name.text);
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && holds(n.right)) {
          if (ts.isIdentifier(n.left)) st.names.add(n.left.text);
          else if (ts.isPropertyAccessExpression(n.left)) spawnProps.add(n.left.name.text);
        }
        // A property that holds one: its declared type is a spawn type (so a parameter of that type holds one too).
        if (ts.isPropertyDeclaration(n) && ts.isIdentifier(n.name) && spawnProps.has(n.name.text) && n.type !== undefined && ts.isTypeReferenceNode(n.type)) spawnTypes.add(n.type.typeName.getText());
        ts.forEachChild(n, scan);
      };
      scan(f.sf);
    }
  }
  let calls = 0;
  const uncovered: string[] = [];
  for (const f of parsed) {
    const st = state.get(f.rel)!;
    const isChildCall = (n: ts.CallExpression): boolean => {
      const e = strip(n.expression)!;
      if (ts.isIdentifier(e)) return st.names.has(e.text);
      if (ts.isPropertyAccessExpression(e)) {
        return (ts.isIdentifier(e.expression) && st.ns.has(e.expression.text) && CHILD_PROCESS.has(e.name.text)) ||
          (e.expression.kind === ts.SyntaxKind.ThisKeyword && spawnProps.has(e.name.text));
      }
      return false;
    };
    // A name resolves in the innermost scope that declares it: a parameter (its default) or a variable in a block above.
    const resolveName = (at: ts.Node, name: string): { init: ts.Expression | undefined; scope: ts.Node } | undefined => {
      for (let a: ts.Node | undefined = at.parent; a !== undefined; a = a.parent) {
        if (ts.isFunctionLike(a)) {
          const p = a.parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === name);
          if (p !== undefined) return { init: p.initializer, scope: a };
        }
        const statements = ts.isBlock(a) || ts.isSourceFile(a) ? a.statements : undefined;
        for (const stmt of statements ?? []) {
          if (!ts.isVariableStatement(stmt)) continue;
          const d = stmt.declarationList.declarations.find((x) => ts.isIdentifier(x.name) && x.name.text === name);
          if (d !== undefined) return { init: d.initializer, scope: a };
        }
      }
      return undefined;
    };
    const reassigned = (scope: ts.Node, name: string): ts.Expression[] => {
      const out: ts.Expression[] = [];
      const v = (n: ts.Node): void => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === name) out.push(n.right);
        ts.forEachChild(n, v);
      };
      v(scope);
      return out;
    };
    const built = (e0: ts.Expression | undefined, depth = 0): boolean => {
      const e = strip(e0);
      if (e === undefined || depth > 4) return false;
      if (ts.isCallExpression(e)) {
        const c = calleeName(e.expression);
        if (c !== undefined && HELPERS.has(c)) return true;
        const at = c === undefined ? undefined : WRAPPERS.get(c);
        return at !== undefined && built(e.arguments[at], depth + 1);
      }
      if (ts.isConditionalExpression(e)) return built(e.whenTrue, depth + 1) && built(e.whenFalse, depth + 1);
      if (isOr(e)) return built(e.left, depth + 1) && built(e.right, depth + 1);
      if (ts.isObjectLiteralExpression(e)) {
        const spreads = e.properties.filter(ts.isSpreadAssignment);
        return spreads[0] !== undefined && e.properties[0] === spreads[0] && built(spreads[0].expression, depth + 1) &&
          spreads.slice(1).every((s) => !isProcessEnv(s.expression) && !(ts.isIdentifier(s.expression) && isProcessEnv(resolveName(s.expression, s.expression.text)?.init))) &&
          !e.properties.some((p) => p.name !== undefined && (ADO_RAW_ENV as readonly string[]).includes(p.name.getText().replace(/^['"]|['"]$/g, '')));
      }
      if (ts.isIdentifier(e)) {
        const r = resolveName(e, e.text);
        return r !== undefined && built(r.init, depth + 1) && reassigned(r.scope, e.text).every((x) => built(x, depth + 1));
      }
      return false;
    };
    const optionsOf = (call: ts.CallExpression): ts.ObjectLiteralExpression | undefined => {
      for (const a0 of call.arguments.slice(1)) {
        const a = strip(a0)!;
        if (ts.isObjectLiteralExpression(a)) return a;
        if (ts.isIdentifier(a)) { const i = strip(resolveName(a, a.text)?.init); if (i !== undefined && ts.isObjectLiteralExpression(i)) return i; }
      }
      return undefined;
    };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && isChildCall(n)) {
        calls += 1;
        const env = optionsOf(n)?.properties.find((p) => p.name !== undefined && p.name.getText() === 'env');
        const expr = env === undefined ? undefined : ts.isShorthandPropertyAssignment(env) ? env.name : ts.isPropertyAssignment(env) ? env.initializer : undefined;
        if (!built(expr)) uncovered.push(`${f.rel}:${f.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.expression.getText()}`);
      }
      // A wrapper must not put the daemon env back itself.
      if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.body !== undefined) {
        const name = ts.isFunctionDeclaration(n) ? n.name?.text : ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : undefined;
        if (name !== undefined && WRAPPERS.has(name) && n.body.getText().includes('process.env')) uncovered.push(`${f.rel} ${name} (a wrapper that reads process.env)`);
      }
      ts.forEachChild(n, visit);
    };
    visit(f.sf);
  }
  return { calls, uncovered };
}

describe('crew#1843 STATIC: only the header helper and the post-hoc deliver script ask for the credential back', () => {
  it('names every opt-in site', () => {
    expect(adoOptInSites(srcFiles())).toEqual(['api/post-hoc-deliver.ts deliverShellEnv', 'core/deliver.ts defaultAdoHelperExec']);
  });

  it('sees an aliased import, a namespace member and a use as a value (review r1 delta)', () => {
    const sites = adoOptInSites([
      { rel: 'a.ts', text: "import { withAdoCredential as w } from './core/exec.js';\nexport function a(e) { return w(e, process.env); }" },
      { rel: 'b.ts', text: "import * as x from './core/exec.js';\nexport const b = (e) => x.withAdoCredential(e, process.env);" },
      { rel: 'c.ts', text: "import { withAdoCredential } from './core/ado-env.js';\nexport const c = [withAdoCredential];" },
      { rel: 'd.ts', text: "export { withAdoCredential } from './ado-env.js';\nexport function withAdoCredential() {}" },
    ]);
    expect(sites).toEqual(['a.ts a', 'b.ts b', 'c.ts c']);
  });
});

describe('crew#1843 STATIC (AST): every crew child-process call passes an env built by a crew child-env helper', () => {
  it('finds no call without one', () => {
    const { calls, uncovered } = uncoveredChildCalls(srcFiles());
    expect(calls, 'the scan saw the child-process calls').toBeGreaterThan(40);
    expect(uncovered, 'these calls hand a child the daemon env (the raw Azure DevOps credential among it)').toEqual([]);
  });

  it('sees aliases, namespaces, requires and injected seams, and an env that is only partly built (review r1 delta)', () => {
    const H = 'childEnvWithBootEstateDb(process.env)';
    const { calls, uncovered } = uncoveredChildCalls([{ rel: 'x.ts', text: [
      "import * as cp from 'node:child_process';",
      "import { spawn } from 'node:child_process';",
      "const { execFile: runGh } = require('child_process');",
      'const launch = spawn;',
      "type Sp = typeof spawn;",
      'class S { private readonly spawnImpl: Sp; constructor(d) { this.spawnImpl = d.spawn ?? spawn; } go() { this.spawnImpl(\'a\', [], { env: process.env }); } }',
      'function run(spawnImpl: Sp) { spawnImpl(\'a\', [], {}); }',
      "cp.spawn('a', [], { env: { ...process.env } });",
      "runGh('a', [], { env: process.env });",
      "launch('a', [], { env: { ..." + H + ', ...process.env } });',
      "spawn('a', [], { env: x ? " + H + ' : process.env });',
      "spawn('a', [], { env: { AZURE_DEVOPS_EXT_PAT: 'v', ..." + H + ' } });',
      'function late() { let env = ' + H + "; env = process.env; spawn('a', [], { env }); }",
      "spawn('ok', [], { env: { ..." + H + ", EXTRA: '1' } });",
      "launch('ok', [], { env: x ? " + H + ' : gitChildEnv(process.env) });',
    ].join('\n') }]);
    expect(calls).toBe(10);
    expect(uncovered).toEqual([6, 7, 8, 9, 10, 11, 12, 13].map((l) => `x.ts:${l} ${['this.spawnImpl', 'spawnImpl', 'cp.spawn', 'runGh', 'launch', 'spawn', 'spawn', 'spawn'][l - 6]}`));
  });
});
