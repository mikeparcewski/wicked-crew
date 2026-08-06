#!/usr/bin/env node
/**
 * Point this workspace's `wicked-core-ts` at a LOCALLY BUILT one — and PROVE the build is current.
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
 * # Why it verifies, not just copies (FINDING-090)
 *
 * The engine `.node` is the platform's SECOND deploy artifact, and it used to be the only unverified
 * one. `install-local.py` in wicked-core proves the CLI on PATH agrees with the checkout it came
 * from; this script used to copy the addon and assert nothing about which revision it was built
 * from. The gap was demonstrated by accident while remediating FINDING-081: rebuild engine, merge
 * core#194, relink — and the daemon runs engine behaviour from BEFORE a merge while the CLI beside
 * it is from after, with both used in the same governed run (the engine plans, the CLI runs the
 * gate hook). Nothing reported the one-merge gap, because nothing had anything to report it with.
 *
 * So before copying anything, this script now derives three facts and dies loudly if any fails:
 *
 *   1. IDENTITY  — the `.node` in the package dir is byte-identical to the cargo artifact
 *                  (`target/<profile>/libwicked_core_ts.*`). `napi build --platform` copies the
 *                  cdylib verbatim, so a hash mismatch means the `.node` is not the newest build.
 *   2. FRESHNESS — no source input of that artifact is newer than the artifact. The input list is
 *                  cargo's own dep-info (`libwicked_core_ts.d`), read rather than restated: it
 *                  names every `.rs` and `include_str!` asset across wicked-core, wicked-council,
 *                  wicked-apps-core, wicked-governance and wicked-estate-core — the cross-repo
 *                  surface a hand-maintained list here would silently drift from.
 *   3. PIN       — the addon's bytes carry the COVERAGE_VALIDATOR_PIN that the checkout's
 *                  `src/domain_extraction.rs` declares, exactly the constant `install-local.py`
 *                  verifies for the CLI. This is the skew that kills governed runs (FINDING-081):
 *                  an engine planning with one pin while the gate resolves another.
 *
 * All three run BEFORE the copy: a failed verification must never leave a bad addon installed.
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
 *   node scripts/use-local-core-ts.mjs --check             # verify ONLY; copies nothing, exit 1 on skew
 *   WICKED_CORE_TS_DIR=/path/to/wicked-core-ts node scripts/use-local-core-ts.mjs
 *
 * Build the source package first (`npm run build` in that directory) — this copies and verifies,
 * it never builds. `WICKED_CORE_TS_DEST` overrides the destination directory; it exists for the
 * guard tests that sandbox this script (tests/engine-link-verification.test.ts) and must not be
 * set in CI — the same test audits ci.yml for that.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = process.env['WICKED_CORE_TS_DIR']
  ? resolve(process.env['WICKED_CORE_TS_DIR'])
  : resolve(repoRoot, '..', 'wicked-core', 'crates', 'wicked-core-ts');
const destDir = process.env['WICKED_CORE_TS_DEST']
  ? resolve(process.env['WICKED_CORE_TS_DEST'])
  : resolve(repoRoot, 'node_modules', 'wicked-core-ts');
const checkOnly = process.argv.includes('--check');

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

// ------------------------------------------------------------------------------------------------
// FINDING-090 verification. Everything below derives from artifacts — the cargo build output, the
// dep-info file cargo wrote beside it, and core's own source constant. Nothing is restated here:
// a second copy of a value that must agree is the defect this exists to catch.
// ------------------------------------------------------------------------------------------------

const addonName = binaries[0];
const addonPath = join(srcDir, addonName);
const addonBytes = readFileSync(addonPath);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// (1) IDENTITY — which cargo artifact is this .node? `napi build --platform` copies the cdylib
// byte-for-byte into the package dir, so byte-equality with target/<profile>/ is the definition of
// "this .node IS the build output". No match against any existing artifact means the .node is not
// the newest build — the exact state FINDING-090 observed (an addon built one merge before the
// sources beside it).
const cdylibName =
  process.platform === 'win32'
    ? 'wicked_core_ts.dll'
    : process.platform === 'darwin'
      ? 'libwicked_core_ts.dylib'
      : 'libwicked_core_ts.so';
const targetRoot = process.env['CARGO_TARGET_DIR']
  ? resolve(process.env['CARGO_TARGET_DIR'])
  : join(srcDir, 'target');
const artifactCandidates = ['release', 'debug']
  .map((p) => join(targetRoot, p, cdylibName))
  .filter((p) => existsSync(p));
if (artifactCandidates.length === 0) {
  die(
    `cannot verify ${addonName}: no ${cdylibName} under ${targetRoot}/{release,debug}.\n` +
      `  An addon whose build cannot be found cannot be proven current, and linking an unverified\n` +
      `  engine is FINDING-090 — the addon can silently predate the sources beside it.\n` +
      `  Fix: cd ${srcDir} && npm run build   (then re-run this script)`,
  );
}
const addonHash = sha256(addonBytes);
const artifact = artifactCandidates.find((p) => sha256(readFileSync(p)) === addonHash);
if (artifact === undefined) {
  const seen = artifactCandidates
    .map((p) => `    ${sha256(readFileSync(p)).slice(0, 16)}  ${p}`)
    .join('\n');
  die(
    `SKEW: ${addonName} is not the output of any build in ${targetRoot}.\n` +
      `    ${addonHash.slice(0, 16)}  ${addonPath}\n${seen}\n` +
      `  The .node in the package dir is not the newest cargo build — it was built from different\n` +
      `  sources than the artifact cargo would link today (FINDING-090).\n` +
      `  Fix: cd ${srcDir} && npm run build   (if this still fails right after a build, the napi\n` +
      `  copy step no longer preserves bytes; update this check rather than deleting it.)`,
  );
}

// (2) FRESHNESS — is that artifact current with respect to its own inputs? Cargo's dep-info file
// (`libwicked_core_ts.d`, makefile syntax) lists every source file the cdylib was compiled from,
// across all five path-dep crates and two repos. Reading it is what keeps this check honest as
// core's dependency graph changes; transcribing the list here would rot the first time core gains
// a crate. The crate manifests are appended explicitly because cargo's dep-info omits them, and a
// dependency edit without a rebuild is exactly a stale build.
const depInfoPath = join(dirname(artifact), cdylibName.replace(/\.[^.]+$/, '.d'));
if (!existsSync(depInfoPath)) {
  die(
    `cannot verify ${addonName}: ${depInfoPath} is missing, so the artifact's input list is\n` +
      `  unknowable and its freshness cannot be proven. A build cargo cannot describe cannot be\n` +
      `  trusted (FINDING-090). Fix: cd ${srcDir} && npm run build`,
  );
}

/** Parse the dependency paths out of a cargo dep-info (.d) file: `target: dep dep ...`, one rule
 *  per line, spaces inside paths escaped as `\ `. A Windows drive colon is followed by a backslash,
 *  never a space, so the first `": "` reliably ends the target. */
function depInfoInputs(text) {
  const inputs = [];
  for (const line of text.split('\n')) {
    const sep = line.indexOf(': ');
    if (sep < 0) continue;
    const rhs = line.slice(sep + 2);
    let current = '';
    for (let i = 0; i < rhs.length; i++) {
      if (rhs[i] === '\\' && rhs[i + 1] === ' ') {
        current += ' ';
        i++;
      } else if (rhs[i] === ' ') {
        if (current.length > 0) inputs.push(current);
        current = '';
      } else {
        current += rhs[i];
      }
    }
    if (current.trim().length > 0) inputs.push(current.trim());
  }
  return inputs;
}

const inputs = depInfoInputs(readFileSync(depInfoPath, 'utf8'));
if (inputs.length === 0) {
  die(
    `cannot verify ${addonName}: ${depInfoPath} lists no inputs — its format changed.\n` +
      `  Update depInfoInputs() rather than deleting the check (FINDING-090).`,
  );
}
for (const manifest of ['Cargo.toml', 'Cargo.lock']) inputs.push(join(srcDir, manifest));

const builtAt = statSync(artifact).mtimeMs;
const missingInputs = [];
const newerInputs = [];
for (const input of inputs) {
  if (!existsSync(input)) {
    missingInputs.push(input);
  } else {
    const mtime = statSync(input).mtimeMs;
    if (mtime > builtAt) newerInputs.push({ input, mtime });
  }
}
if (missingInputs.length > 0 || newerInputs.length > 0) {
  const show = (list, fmt) =>
    list
      .slice(0, 5)
      .map(fmt)
      .concat(list.length > 5 ? [`    … and ${list.length - 5} more`] : [])
      .join('\n');
  const details = [
    ...(newerInputs.length > 0
      ? [
          `  ${newerInputs.length} source input(s) are NEWER than the artifact (built ${new Date(builtAt).toISOString()}):`,
          show(newerInputs, ({ input, mtime }) => `    ${new Date(mtime).toISOString()}  ${input}`),
        ]
      : []),
    ...(missingInputs.length > 0
      ? [
          `  ${missingInputs.length} source input(s) the artifact was built from no longer exist:`,
          show(missingInputs, (p) => `    ${p}`),
        ]
      : []),
  ].join('\n');
  die(
    `STALE ENGINE BUILD: ${addonName} predates the sources it sits beside.\n${details}\n` +
      `  Linking it would deploy engine behaviour from BEFORE those changes while the CLI and the\n` +
      `  JS around it are from after — the two are used in the same governed run (FINDING-090).\n` +
      `  Fix: cd ${srcDir} && npm run build   (then re-run this script)`,
  );
}

// (3) PIN — the semantic cross-artifact contract. The engine seeds the coverage validator pin the
// gate later resolves; `install-local.py` proves the CLI's copy, this proves the addon's. The
// expected value is read out of core's source, never restated here, and the addon is asked
// directly: the &str constant survives into the cdylib's bytes (verified against a release build
// with lto=true, strip="symbols").
const coreRepo = resolve(srcDir, '..', '..');
const pinSource = join(coreRepo, 'src', 'domain_extraction.rs');
if (!existsSync(pinSource)) {
  die(
    `cannot verify ${addonName}: ${pinSource} not found above the package dir.\n` +
      `  The pin constant moved, or WICKED_CORE_TS_DIR points outside a wicked-core checkout.\n` +
      `  Update this check rather than deleting it (FINDING-090; same constant install-local.py reads).`,
  );
}
const pinMatch = /COVERAGE_VALIDATOR_PIN:\s*&str\s*=\s*"([0-9a-f]+)"/.exec(
  readFileSync(pinSource, 'utf8'),
);
if (pinMatch === null) {
  die(
    `no COVERAGE_VALIDATOR_PIN in ${pinSource} — the constant moved or was renamed.\n` +
      `  Update this check rather than deleting it (install-local.py reads the same constant).`,
  );
}
const pin = pinMatch[1];
if (!addonBytes.includes(pin)) {
  die(
    `PIN SKEW: the checkout declares coverage validator pin ${pin} but ${addonName} does not\n` +
      `  carry it — the addon was built from a different revision than this checkout.\n` +
      `  A daemon on this engine plans with a pin the gate hook will refuse to resolve, and every\n` +
      `  domain-extraction run fails closed (FINDING-081/-090).\n` +
      `  Fix: cd ${srcDir} && npm run build   (then re-run this script)`,
  );
}

if (checkOnly) {
  // Verify the LINKED addon too — `--check` answers "is the platform current?", and the linked
  // copy is the artifact that actually loads. Byte-equality with the source is not usable here:
  // the copy is re-signed on macOS, which rewrites its bytes. The pin is the contract that must
  // hold, so the pin is what is checked — same acceptance install-local.py applies to the CLI.
  const linked = join(destDir, addonName);
  if (!existsSync(linked)) {
    die(
      `nothing is linked: ${linked} does not exist, so the workspace engine is whatever npm\n` +
        `  installed — the published build, which is older than this checkout (FINDING-072).\n` +
        `  Fix: node scripts/use-local-core-ts.mjs   (without --check)`,
    );
  }
  if (!readFileSync(linked).includes(pin)) {
    die(
      `PIN SKEW: the LINKED addon at ${linked} does not carry pin ${pin} declared by the\n` +
        `  checkout — it was linked from an older build (FINDING-090).\n` +
        `  Fix: node scripts/use-local-core-ts.mjs   (without --check)`,
    );
  }
  console.log(
    `use-local-core-ts: verified — build current (${artifact}), pin ${pin} carried by source and linked addon.`,
  );
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });

const files = ['index.js', 'index.d.ts', addonName];
for (const f of files) {
  const from = join(srcDir, f);
  if (!existsSync(from)) die(`${srcDir} is missing ${f} — build is incomplete.`);
  copyFileSync(from, join(destDir, f));
}

// See the header: an overwritten .node is SIGKILLed on macOS unless re-signed ad-hoc.
if (process.platform === 'darwin') {
  try {
    execFileSync('codesign', ['-s', '-', '-f', join(destDir, addonName)], { stdio: 'pipe' });
  } catch (err) {
    // codesign puts the actionable part on stderr — which entitlement, which malformed field.
    // `err.message` is only "Command failed", so reporting that alone would replace one silent
    // failure with an uninformative one.
    const detail = (err.stderr?.toString() || err.message || '').trim();
    die(
      `codesign failed on ${addonName}: ${detail}\n` +
        `  Without a valid ad-hoc signature the addon is SIGKILLed at load with no error.`,
    );
  }
}

// The artifact that will actually load, asked directly. The copy and the re-sign both just ran, so
// this can only fail if one of them corrupted the file — in which case exit 1 is the difference
// between a diagnosis here and a SIGKILL three commands later.
if (!readFileSync(join(destDir, addonName)).includes(pin)) {
  die(
    `the copied addon at ${join(destDir, addonName)} lost pin ${pin} between source and\n` +
      `  destination — the copy or the re-sign corrupted it. Do not use this install.`,
  );
}

const size = statSync(join(destDir, addonName)).size;
console.log(
  `use-local-core-ts: ${srcDir}\n` +
    `  -> ${destDir}\n` +
    `  ${files.join(', ')} (${(size / 1024 / 1024).toFixed(1)} MiB addon)` +
    (process.platform === 'darwin' ? ', re-signed ad-hoc' : '') +
    `\n  verified: addon is the current build (${artifact}), carries pin ${pin}`,
);
