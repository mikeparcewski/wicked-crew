#!/usr/bin/env node
// Generates packages/crew/voice-locks/<os>-<arch>-cp3<N>.txt: one hash-locked requirements file per
// (OS, arch, CPython minor) for the piper-tts engine. Names use the values Node's process.platform and
// process.arch report (darwin|linux, arm64|x64), so a runtime lookup needs no mapping.
//
// Per target, pip resolves the exact versions without installing (--dry-run --report fetches metadata only);
// each requirement is then written as name==version with --hash=sha256 for EVERY wheel of that exact release on
// PyPI, so the person's own pip can pick its platform wheel and still be held to a published hash.
//
//   node scripts/generate-voice-locks.mjs [--python <python with pip>] [--only <os-arch-cp3N>] [--sizes-only]
//
// crew#1563: each lock also says what the engine install downloads on its target: one `# wheel: <file> <bytes>` line
// per pinned requirement and `# engine-bytes: <total>`. The wheel is the one pip picks there: the first of pip's own
// compatible tags for the target (`pip debug --verbose`, local, no network) that a wheel of that exact release on
// PyPI carries, with its size and sha256 from the same PyPI JSON (metadata only: no wheel is downloaded). Its
// sha256 must be one of the lock's hashes. `--sizes-only` re-derives those lines over the committed locks, pins
// untouched (no pip resolve).
//
// Needs network access to pypi.org. Re-run it (never hand-edit the locks) when the engine version changes.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = 'piper-tts==1.8.0';
const INDEX = 'https://pypi.org/simple';
const MINORS = [9, 10, 11, 12, 13, 14];
// A target takes several --platform tags: pip does not expand one manylinux tag to the older ones for every CPython
// (with only manylinux_2_28 it answers ResolutionImpossible for cp39 and cp310), so each Linux target names all three.
// UNSUPPORTED: targets with no wheel for the engine's dependencies (onnxruntime has none for Intel Mac on 3.14); they
// get no lock, and src/voice/tts.ts says so plainly.
const TARGETS = [
  { os: 'darwin', arch: 'arm64', tags: ['macosx_14_0_arm64'] },
  { os: 'darwin', arch: 'x64', tags: ['macosx_14_0_x86_64'] },
  { os: 'linux', arch: 'x64', tags: ['manylinux_2_28_x86_64', 'manylinux_2_17_x86_64', 'manylinux2014_x86_64'] },
  { os: 'linux', arch: 'arm64', tags: ['manylinux_2_28_aarch64', 'manylinux_2_17_aarch64', 'manylinux2014_aarch64'] },
];
const UNSUPPORTED = new Set(['darwin-x64-cp314']);

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const python = opt('--python') ?? 'python3';
const only = opt('--only');
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'voice-locks');
mkdirSync(outDir, { recursive: true });

const pypiCache = new Map();
/** Every wheel of one exact release on PyPI: file name, size and sha256 (the release's JSON, metadata only). */
async function releaseWheels(name, version) {
  const key = `${name}==${version}`;
  if (!pypiCache.has(key)) {
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
    if (!res.ok) throw new Error(`PyPI answered ${res.status} for ${key}`);
    const body = await res.json();
    const wheels = body.urls.filter((u) => u.packagetype === 'bdist_wheel').map((u) => ({ file: u.filename, bytes: u.size, sha256: u.digests.sha256 }));
    if (wheels.length === 0) throw new Error(`${key} has no wheel on PyPI`);
    pypiCache.set(key, wheels);
  }
  return pypiCache.get(key);
}
async function wheelHashes(name, version) {
  return [...new Set((await releaseWheels(name, version)).map((w) => w.sha256))].sort();
}

/** pip's compatible tags for a target, best first (`pip debug --verbose`: no network). */
function targetTags(t, minor) {
  const r = spawnSync(python, ['-m', 'pip', 'debug', '--verbose', ...t.tags.flatMap((tag) => ['--platform', tag]), '--python-version', `3.${minor}`, '--implementation', 'cp'], { encoding: 'utf8', env: { ...process.env, PIP_CONFIG_FILE: '/dev/null' } });
  if (r.status !== 0) throw new Error(`pip debug failed for ${t.os}-${t.arch}-cp3${minor}: ${(r.stderr ?? '').trim().split('\n').pop()}`);
  const lines = r.stdout.split('\n');
  const at = lines.findIndex((l) => l.startsWith('Compatible tags:'));
  if (at < 0) throw new Error('pip debug printed no compatible tags');
  const rank = new Map();
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('  ')) break;
    const tag = l.trim();
    if (!rank.has(tag)) rank.set(tag, rank.size);
  }
  return rank;
}

/** The wheel pip picks for `rank`: the one whose best tag ranks first (a file name's tag triple may be compressed). */
function pickWheel(wheels, rank) {
  let best = null;
  for (const w of wheels) {
    const parts = w.file.replace(/\.whl$/, '').split('-');
    const [py, abi, plat] = parts.slice(-3);
    let score = Infinity;
    for (const a of py.split('.')) for (const b of abi.split('.')) for (const c of plat.split('.')) score = Math.min(score, rank.get(`${a}-${b}-${c}`) ?? Infinity);
    if (score < Infinity && (best === null || score < best.score)) best = { ...w, score };
  }
  return best;
}

/** The `# wheel:` and `# engine-bytes:` lines for a lock's pins on its target. */
async function sizeLines(t, minor, pins) {
  const rank = targetTags(t, minor);
  const lines = [];
  let total = 0;
  for (const p of pins) {
    const w = pickWheel(await releaseWheels(p.name, p.version), rank);
    if (w === null) throw new Error(`${p.name}==${p.version} has no wheel for ${t.os}-${t.arch}-cp3${minor}`);
    if (!p.hashes.includes(w.sha256)) throw new Error(`${w.file}: its sha256 is not in the lock`);
    lines.push(`# wheel: ${w.file} ${w.bytes}\n`);
    total += w.bytes;
  }
  return `${lines.join('')}# engine-bytes: ${total}\n`;
}

/** name, version and hashes of each requirement in a committed lock. */
function readPins(text) {
  return text.replace(/\\\n/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')).map((l) => {
    const [req, ...rest] = l.split(/ +/);
    const [name, version] = req.split('==');
    return { name, version, hashes: rest.filter((x) => x.startsWith('--hash=sha256:')).map((x) => x.slice('--hash=sha256:'.length)) };
  });
}

const sizesOnly = argv.includes('--sizes-only');
const HEADER = (id) => `# Generated by scripts/generate-voice-locks.mjs for ${id}; do not edit.\n`;
const work = mkdtempSync(join(tmpdir(), 'voice-locks-'));
let failed = 0;
try {
  for (const t of TARGETS) {
    for (const minor of MINORS) {
      const id = `${t.os}-${t.arch}-cp3${minor}`;
      if (only !== undefined && only !== id) continue;
      if (UNSUPPORTED.has(id)) { console.log(`${id}: unsupported, no lock`); continue; }
      if (sizesOnly) {
        const file = join(outDir, `${id}.txt`);
        const body = readFileSync(file, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
        try {
          const sizes = await sizeLines(t, minor, readPins(body));
          writeFileSync(file, `${HEADER(id)}${sizes}${body.replace(/^\n+/, '')}`);
          console.log(`${id}: ${sizes.trim().split('\n').pop()}`);
        } catch (e) { failed += 1; console.error(`${id}: ${e.message}`); }
        continue;
      }
      const report = join(work, `${id}.json`);
      const r = spawnSync(python, [
        '-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--isolated', '--report', report,
        '--only-binary=:all:', ...t.tags.flatMap((tag) => ['--platform', tag]), '--python-version', `3.${minor}`, '--implementation', 'cp',
        '--index-url', INDEX, '--target', join(work, `${id}-target`), ENGINE,
      ], { encoding: 'utf8', env: { ...process.env, PIP_CONFIG_FILE: '/dev/null' } });
      if (r.status !== 0) { failed += 1; console.error(`${id}: pip failed\n${(r.stderr ?? '').split('\n').slice(-6).join('\n')}`); continue; }
      const items = JSON.parse(readFileSync(report, 'utf8')).install.map((i) => i.metadata);
      const lines = [];
      const pins = [];
      for (const m of items.sort((a, b) => a.name.localeCompare(b.name))) {
        const hashes = await wheelHashes(m.name, m.version);
        pins.push({ name: m.name, version: m.version, hashes });
        lines.push(`${m.name}==${m.version} \\\n${hashes.map((h) => `    --hash=sha256:${h}`).join(' \\\n')}\n`);
      }
      writeFileSync(join(outDir, `${id}.txt`), `${HEADER(id)}${await sizeLines(t, minor, pins)}${lines.join('')}`);
      console.log(`${id}: ${items.map((m) => `${m.name}==${m.version}`).join(' ')}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failed > 0) { console.error(`${failed} target(s) failed`); process.exit(1); }
