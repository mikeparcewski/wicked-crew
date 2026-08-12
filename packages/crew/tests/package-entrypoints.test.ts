// FINDING-073 (#195): a declared entrypoint must name something the build actually produces.
//
// `packages/crew/package.json` declared `main: dist/index.js`. There is no `src/index.ts`, so `tsc`
// never emitted it and the field had presumably never been correct. Nothing in the repo imports the
// package by name, so nothing dereferenced the field — `build` succeeded, `npm ci` succeeded, tests
// passed, CI was green, and the wrongness was invisible until someone outside the repo read it.
//
// It cost a daemon restart to find: `node dist/index.js` → MODULE_NOT_FOUND. The real entrypoint is
// `dist/cli/index.js`, reachable only through `bin`.
//
// This checks entrypoints against SOURCE, not against `dist/`. Asserting the emitted file exists
// would make `npm test` depend on a prior `npm run build` — true in CI, where build runs first, and
// false for anyone who just cloned. A declared `dist/x/y.js` with no `src/x/y.ts` behind it is
// already the defect, and that is checkable without compiling anything.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Pkg {
  name?: string;
  main?: string;
  bin?: string | Record<string, string>;
}

/** Every workspace package.json, by directory. */
const PACKAGES = ['packages/crew', 'packages/agent-acp-bridges'].filter((d) =>
  existsSync(join(workspaceRoot, d, 'package.json')),
);

/** The source file a declared `dist/...` entrypoint would be compiled from. */
function sourceFor(declared: string): string | null {
  if (!declared.startsWith('dist/')) return null; // not a compiled artifact — checked as-is
  return declared.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
}

describe('declared entrypoints name something that can exist', () => {
  it('finds the workspace packages at all', () => {
    // Without this the suite passes vacuously if the layout moves.
    expect(PACKAGES.length, `no package.json found under ${workspaceRoot}/packages`).toBeGreaterThan(
      0,
    );
  });

  for (const dir of PACKAGES) {
    const pkgPath = join(workspaceRoot, dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Pkg;

    const declared: [string, string][] = [];
    if (pkg.main) declared.push(['main', pkg.main]);
    if (typeof pkg.bin === 'string') declared.push(['bin', pkg.bin]);
    else if (pkg.bin) for (const [k, v] of Object.entries(pkg.bin)) declared.push([`bin.${k}`, v]);

    for (const [field, target] of declared) {
      it(`${pkg.name ?? dir}: ${field} → ${target}`, () => {
        const src = sourceFor(target);
        if (src === null) {
          // A non-compiled entrypoint (e.g. a checked-in .mjs) must simply be there.
          expect(existsSync(join(workspaceRoot, dir, target)), `${dir}/${target} does not exist`).toBe(
            true,
          );
          return;
        }
        expect(
          existsSync(join(workspaceRoot, dir, src)),
          `${dir}/package.json declares ${field}="${target}", but ${dir}/${src} does not exist — ` +
            `nothing compiles to that path, so anything resolving this field gets MODULE_NOT_FOUND ` +
            `(FINDING-073). Point it at a real entry, or drop the field.`,
        ).toBe(true);
      });
    }
  }
});
