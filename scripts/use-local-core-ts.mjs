#!/usr/bin/env node
/**
 * Point this workspace's `wicked-core-ts` at a LOCALLY BUILT one.
 *
 * # Why this exists
 *
 * `packages/crew` declares `wicked-core-ts: ^0.3.0`, which resolves from npm. The newest published
 * build is 0.3.0, and the engine this package is developed against — the sibling `wicked-core`
 * checkout — is many merged PRs ahead of it. So `npm ci` alone installs an engine OLDER than the code
 * that uses it, and every path touching a field added since the last publish is untestable. That is
 * not hypothetical: wicked-crew#184 merged with green CI while shipping an onboarding launch path
 * that throws on the pinned engine, because no test reached it (FINDING-072, wicked-crew#187).
 *
 * # Why a script rather than `npm install <path>`
 *
 * `wicked-core-ts`'s `files` list is `index.js` + `index.d.ts` only — the compiled `.node` binary
 * ships as separate per-platform optionalDependencies. A `file:` install honours `files` and packs
 * WITHOUT the binary, producing a package that imports and then fails at load. Copying the three
 * artifacts explicitly is what actually works.
 *
 * # The macOS trap this closes
 *
 * Overwriting a loaded `.node` on macOS invalidates its signature, and the kernel answers with a
 * silent SIGKILL — no error, no stack, the process just dies. Re-signing ad-hoc after the copy is
 * mandatory, and forgetting it costs an afternoon. That is the entire reason this is one command
 * instead of a documented sequence of three: CI and local development run the same hardened path.
 *
 * # Usage
 *
 *   node scripts/use-local-core-ts.mjs                     # ../wicked-core/crates/wicked-core-ts
 *   WICKED_CORE_TS_DIR=/path/to/wicked-core-ts node scripts/use-local-core-ts.mjs
 *
 * Build the source package first (`npm run build` in that directory) — this only copies.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = process.env['WICKED_CORE_TS_DIR']
  ? resolve(process.env['WICKED_CORE_TS_DIR'])
  : resolve(repoRoot, '..', 'wicked-core', 'crates', 'wicked-core-ts');

function die(msg) {
  console.error(`use-local-core-ts: ${msg}`);
  process.exit(1);
}

if (!existsSync(srcDir)) {
  die(
    `no wicked-core-ts at ${srcDir}\n` +
      `  Check out wicked-core as a sibling of this repo, or set WICKED_CORE_TS_DIR.`,
  );
}

// The .node is platform-and-arch specific, and `napi build --platform` names it
// wicked-core-ts.<triple>.node. Match that prefix rather than a bare `.node` suffix: the package
// directory can also hold an `index.node` left by a plain (non-`--platform`) build, and index.js
// never requires that name — every branch of its loader asks for `wicked-core-ts.<triple>.node` or
// the matching optional dependency. Copying `index.node` would install a file nothing loads.
const binaries = readdirSync(srcDir).filter(
  (f) => f.startsWith('wicked-core-ts.') && f.endsWith('.node'),
);
if (binaries.length === 0) {
  die(
    `${srcDir} has no wicked-core-ts.<triple>.node — the package was never built with --platform.\n` +
      `  Run: cd ${srcDir} && npm install && npm run build`,
  );
}
if (binaries.length > 1) {
  // Two triples means a stale binary from another platform or an interrupted build. Picking the
  // wrong one yields a load-time "invalid ELF header"-class error far from here, so refuse instead.
  die(`${srcDir} has ${binaries.length} platform binaries (${binaries.join(', ')}) — clean and rebuild.`);
}

const destDir = resolve(repoRoot, 'node_modules', 'wicked-core-ts');
mkdirSync(destDir, { recursive: true });

const files = ['index.js', 'index.d.ts', binaries[0]];
for (const f of files) {
  const from = join(srcDir, f);
  if (!existsSync(from)) die(`${srcDir} is missing ${f} — build is incomplete.`);
  copyFileSync(from, join(destDir, f));
}

// See the header: an overwritten .node is SIGKILLed on macOS unless re-signed ad-hoc.
if (process.platform === 'darwin') {
  try {
    execFileSync('codesign', ['-s', '-', '-f', join(destDir, binaries[0])], { stdio: 'pipe' });
  } catch (err) {
    // codesign puts the actionable part on stderr — which entitlement, which malformed field.
    // `err.message` is only "Command failed", so reporting that alone would replace one silent
    // failure with an uninformative one.
    const detail = (err.stderr?.toString() || err.message || '').trim();
    die(
      `codesign failed on ${binaries[0]}: ${detail}\n` +
        `  Without a valid ad-hoc signature the addon is SIGKILLed at load with no error.`,
    );
  }
}

const size = statSync(join(destDir, binaries[0])).size;
console.log(
  `use-local-core-ts: ${srcDir}\n` +
    `  -> ${destDir}\n` +
    `  ${files.join(', ')} (${(size / 1024 / 1024).toFixed(1)} MiB addon)` +
    (process.platform === 'darwin' ? ', re-signed ad-hoc' : ''),
);
