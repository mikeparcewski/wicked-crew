// FINDING-090: the engine `.node` is the platform's second deploy artifact, and it used to be the
// only unverified one. `scripts/use-local-core-ts.mjs` copied the addon and re-signed it, asserting
// nothing about which revision it was built from — so the daemon could run engine behaviour from
// BEFORE a merge while the CLI beside it was from after, both used in the same governed run. That
// happened, by accident, while remediating FINDING-081, and nothing reported the one-merge gap.
//
// The script now verifies before copying: identity (the .node is byte-identical to the cargo
// artifact), freshness (no dep-info-listed input is newer than the artifact), and the coverage
// validator pin (read out of core's `src/domain_extraction.rs`, present in the addon's bytes).
//
// # What this guard proves, and how it avoids proving less
//
// Every case here spawns the REAL script entry — `node scripts/use-local-core-ts.mjs` — against a
// fixture checkout, not a helper extracted from it. A test of an extracted helper proves the helper
// works and says nothing about whether the script calls it; that gap has recurred in this ecosystem
// (~5 times), so the deploy path itself is what runs. The skew cases run WITHOUT `--check`, which
// is exactly the invocation CI and developers use: if verification were ever wired into `--check`
// only, those cases would observe the unguarded copy and fail.
//
// Assertions name the substance (the offending file, both hashes, the pin value) rather than just
// the exit code — on macOS a fixture addon that survives verification dies later at `codesign`,
// which also exits 1, and an exit-code-only assertion would pass with verification deleted.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'use-local-core-ts.mjs');
const CI_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/** What cargo names the cdylib on this platform. The script derives the same three names from
 *  cargo's universal convention; restating a convention is not restating a repo constant. */
const CDYLIB =
  process.platform === 'win32'
    ? 'wicked_core_ts.dll'
    : process.platform === 'darwin'
      ? 'libwicked_core_ts.dylib'
      : 'libwicked_core_ts.so';
const DEP_INFO = CDYLIB.replace(/\.[^.]+$/, '.d');
const ADDON = 'wicked-core-ts.testfixture.node';

const PIN_A = '0123456789abcdef';
const PIN_B = 'fedcba9876543210';

/** Timestamps, in seconds: inputs older than the artifact is the healthy state. */
const T_INPUTS = 1_000_000_000;
const T_BUILT = 1_500_000_000;
const T_AFTER_BUILD = 1_600_000_000;

const sha16 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex').slice(0, 16);

interface Fixture {
  /** crates/wicked-core-ts inside the fake checkout — what WICKED_CORE_TS_DIR points at. */
  pkg: string;
  /** Sandboxed destination — what WICKED_CORE_TS_DEST points at. */
  dest: string;
  addonPath: string;
  artifactPath: string;
  /** A dep-info-listed source input of the build. */
  dep: string;
  /** A second input with a space in its name, exercising the makefile `\ ` escaping — a parser
   *  that mishandles it reports a healthy build as broken. */
  depWithSpace: string;
}

/** A coherent fake wicked-core checkout: addon == artifact bytes, both carrying PIN_A, all
 *  dep-info inputs and manifests older than the artifact, pin source declaring PIN_A. Every test
 *  starts from this healthy state and breaks exactly one thing. */
function makeFixture(pinInAddon: string = PIN_A, pinDeclared: string = PIN_A): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'engine-link-verification-'));
  // Deliberately NOT named after the real sibling checkout: this is a fabricated layout the
  // script is pointed at via WICKED_CORE_TS_DIR, not a resolution of the real one — and the
  // FINDING-094 audit in core-checkout-policy.test.ts rightly fails any test that spells the
  // sibling checkout's path for itself. The script derives the repo root as `../..` of the
  // package dir, so the directory's name carries no meaning to it.
  const core = join(root, 'fake-core');
  const pkg = join(core, 'crates', 'wicked-core-ts');
  const release = join(pkg, 'target', 'release');
  const inputsDir = join(pkg, 'inputs');
  const dest = join(root, 'dest');
  for (const d of [release, inputsDir, join(core, 'src')]) mkdirSync(d, { recursive: true });

  const addonBytes = Buffer.concat([
    Buffer.from('not a real addon, but it carries the pin: '),
    Buffer.from(pinInAddon),
    Buffer.from('\n'),
  ]);
  const addonPath = join(pkg, ADDON);
  const artifactPath = join(release, CDYLIB);
  writeFileSync(addonPath, addonBytes);
  writeFileSync(artifactPath, addonBytes);

  const dep = join(inputsDir, 'lib.rs');
  const depWithSpace = join(inputsDir, 'has space.rs');
  writeFileSync(dep, 'pub fn f() {}\n');
  writeFileSync(depWithSpace, 'pub fn g() {}\n');
  writeFileSync(
    join(release, DEP_INFO),
    `${artifactPath}: ${dep} ${depWithSpace.replace(/ /g, '\\ ')}\n`,
  );

  writeFileSync(join(pkg, 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(pkg, 'index.d.ts'), 'export {};\n');
  writeFileSync(join(pkg, 'Cargo.toml'), '[package]\nname = "wicked-core-ts"\n');
  writeFileSync(join(pkg, 'Cargo.lock'), '# lock\n');
  writeFileSync(
    join(core, 'src', 'domain_extraction.rs'),
    `pub const COVERAGE_VALIDATOR_PIN: &str = "${pinDeclared}";\n`,
  );

  for (const p of [dep, depWithSpace, join(pkg, 'Cargo.toml'), join(pkg, 'Cargo.lock')]) {
    utimesSync(p, T_INPUTS, T_INPUTS);
  }
  for (const p of [artifactPath, addonPath]) utimesSync(p, T_BUILT, T_BUILT);

  return { pkg, dest, addonPath, artifactPath, dep, depWithSpace };
}

function run(fx: Fixture, args: string[] = []): { status: number | null; out: string; err: string } {
  // CARGO_TARGET_DIR would point the identity check away from the fixture's target/; a developer
  // machine setting it globally must not change what this guard observes.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env['CARGO_TARGET_DIR'];
  env['WICKED_CORE_TS_DIR'] = fx.pkg;
  env['WICKED_CORE_TS_DEST'] = fx.dest;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('use-local-core-ts verifies the addon against the source build (FINDING-090)', () => {
  it('passes --check on a coherent build, naming the pin it verified', () => {
    const fx = makeFixture();
    mkdirSync(fx.dest, { recursive: true });
    writeFileSync(join(fx.dest, ADDON), readFileSync(fx.addonPath));
    const r = run(fx, ['--check']);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.out).toContain('verified');
    expect(r.out).toContain(`pin ${PIN_A}`);
    // --check must not write: the fixture never gains index.js at the destination.
    expect(existsSync(join(fx.dest, 'index.js'))).toBe(false);
  });

  it('the DEPLOY path (no flags) refuses a stale build and installs nothing', () => {
    const fx = makeFixture();
    // The FINDING-090 accident: a source changed (merge) after the addon was built.
    utimesSync(fx.dep, T_AFTER_BUILD, T_AFTER_BUILD);
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.err).toContain('STALE ENGINE BUILD');
    expect(r.err).toContain(fx.dep);
    // Verification runs BEFORE the copy — a failed link must leave nothing behind.
    expect(existsSync(join(fx.dest, ADDON))).toBe(false);
  });

  it('a Cargo manifest edited after the build counts as stale', () => {
    const fx = makeFixture();
    // Cargo's dep-info omits the manifests, so the script appends them itself; losing that would
    // let a dependency bump link an engine built before it.
    utimesSync(join(fx.pkg, 'Cargo.lock'), T_AFTER_BUILD, T_AFTER_BUILD);
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.err).toContain('STALE ENGINE BUILD');
    expect(r.err).toContain(join(fx.pkg, 'Cargo.lock'));
  });

  it('refuses an addon that is not byte-identical to any cargo artifact, naming both hashes', () => {
    const fx = makeFixture();
    const tampered = Buffer.concat([readFileSync(fx.addonPath), Buffer.from(' tampered')]);
    writeFileSync(fx.addonPath, tampered);
    utimesSync(fx.addonPath, T_BUILT, T_BUILT);
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.err).toContain('SKEW');
    expect(r.err).toContain(sha16(tampered));
    expect(r.err).toContain(sha16(readFileSync(fx.artifactPath)));
    expect(existsSync(join(fx.dest, ADDON))).toBe(false);
  });

  it('refuses an addon that does not carry the pin the checkout declares', () => {
    // Identity and freshness are coherent — the build is simply from a revision with another pin.
    const fx = makeFixture(PIN_A, PIN_B);
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.err).toContain('PIN SKEW');
    expect(r.err).toContain(PIN_B);
    expect(existsSync(join(fx.dest, ADDON))).toBe(false);
  });

  it('fails closed when there is no cargo artifact to verify against', () => {
    const fx = makeFixture();
    rmSync(join(fx.pkg, 'target'), { recursive: true });
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.err).toContain('cannot verify');
    expect(r.err).toContain('npm run build');
    expect(existsSync(join(fx.dest, ADDON))).toBe(false);
  });

  it('fails closed when a source input of the build no longer exists', () => {
    const fx = makeFixture();
    rmSync(fx.dep);
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.err).toContain('no longer exist');
    expect(r.err).toContain(fx.dep);
  });

  it('--check refuses when nothing is linked at the destination', () => {
    const fx = makeFixture();
    const r = run(fx, ['--check']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('nothing is linked');
  });

  it('--check refuses a linked addon that predates the declared pin', () => {
    const fx = makeFixture();
    mkdirSync(fx.dest, { recursive: true });
    // Linked from an older build: carries some other pin, not the one the checkout declares.
    writeFileSync(join(fx.dest, ADDON), `an older addon carrying ${PIN_B}\n`);
    const r = run(fx, ['--check']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('PIN SKEW');
    expect(r.err).toContain('LINKED');
    expect(r.err).toContain(PIN_A);
  });
});

describe('the verifying link is what CI actually runs', () => {
  // The cases above prove the script verifies; this proves the environment that decides whether
  // to merge still routes through it. A verifying script CI stopped calling — or called with the
  // sandbox override pointed away from the node_modules the tests load — guards nothing.
  const workflow = readFileSync(CI_WORKFLOW, 'utf8');

  it('ci.yml links the engine through scripts/use-local-core-ts.mjs, not a bypass', () => {
    const lines = workflow.split('\n').filter((l) => l.includes('use-local-core-ts.mjs'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain('--check');
  });

  it('ci.yml never sets the test-sandbox destination override', () => {
    expect(workflow).not.toContain('WICKED_CORE_TS_DEST');
  });
});
