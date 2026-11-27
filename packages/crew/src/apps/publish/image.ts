/**
 * (DES-APPS-001 §9.3 step 4) Building the image from a context crew packed (`pack.ts`), in the local
 * container engine. Nothing is pushed: the image's id is what the `published` receipt records, and the
 * deployer runs it. The engine CLI gets a minimal environment (where it is and which engine), never the
 * daemon's own (an exported store URL or token must not reach it, crew#495).
 */

import { spawn } from 'node:child_process';

import { childEnvWithBootEstateDb } from '../../core/governance-store.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class ImageBuildError extends Error {
  constructor(
    readonly code: 'no_engine' | 'base_missing' | 'build_failed' | 'timeout',
    message: string,
    readonly log: string,
  ) {
    super(message);
  }
}

/** The only variables the engine CLI sees (where it is and which engine); never the daemon's own. */
export const KEEP_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'XDG_RUNTIME_DIR', 'TMPDIR', 'SystemRoot'];
const BUILD_DEADLINE_MS = 15 * 60 * 1000;
const LOG_TAIL = 8_000;

function run(bin: string, args: string[], deadlineMs: number, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const picked: NodeJS.ProcessEnv = { DOCKER_BUILDKIT: '1' };
    for (const k of KEEP_ENV) if (env[k] !== undefined) picked[k] = env[k];
    // crew's child-env rule (crew#495): through childEnvWithBootEstateDb, so the daemon's exported store never rides along.
    const child = spawn(bin, args, { env: childEnvWithBootEstateDb(picked), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (b: Buffer): void => {
      out = (out + b.toString('utf8')).slice(-LOG_TAIL);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ImageBuildError('timeout', `the image build ran past ${Math.round(deadlineMs / 60_000)} minutes`, out));
    }, deadlineMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ImageBuildError('no_engine', `the container engine (${bin}) could not be started: ${(err as NodeJS.ErrnoException).code ?? 'error'}`, out));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** Deadline for one local `image inspect` (no network: it reads the engine's own image store). */
const INSPECT_DEADLINE_MS = 60 * 1000;

/**
 * The base images a Dockerfile builds FROM, in order: each `FROM [--platform=…] <ref> [AS <stage>]` (a line continued
 * with `\` read whole), without `scratch` and without a reference to an earlier stage of the same file. The one
 * Dockerfile a publish builds is crew's own product file (`pack.ts` `writeImageContext`), never the app's.
 */
export function baseImagesOf(dockerfile: string): string[] {
  const stages = new Set<string>();
  const bases: string[] = [];
  for (const line of dockerfile.replace(/\\[ \t]*\r?\n/g, ' ').split(/\r?\n/)) {
    const m = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (m === null) continue;
    const ref = m[1]!;
    if (ref.toLowerCase() !== 'scratch' && !stages.has(ref.toLowerCase()) && !bases.includes(ref)) bases.push(ref);
    if (m[2] !== undefined) stages.add(m[2].toLowerCase());
  }
  return bases;
}

/**
 * (crew#1972) Refuse a build whose base image is not on this engine. A build resolves a missing base from its
 * registry on its own (BuildKit pulls it whatever `--pull` says), so it would download it without asking; a host
 * that forbids unasked downloads keeps control only if crew checks first. The check reads the engine's own image
 * store (`image inspect`), never the network. The refusal names the image and the one command that pulls it.
 */
async function requireBases(bin: string, ctx: string, deadlineMs: number, env: NodeJS.ProcessEnv): Promise<void> {
  let dockerfile: string;
  try {
    dockerfile = readFileSync(join(ctx, 'Dockerfile'), 'utf8');
  } catch {
    throw new ImageBuildError('build_failed', 'the build context has no Dockerfile', '');
  }
  for (const ref of baseImagesOf(dockerfile)) {
    // A base named through a build argument cannot be checked before the build resolves it: refused, never pulled.
    if (ref.includes('$')) throw new ImageBuildError('build_failed', `the Dockerfile names its base image through a build argument (${ref}), which crew cannot check is on this engine before building`, '');
    const r = await run(bin, ['image', 'inspect', '--format', '{{.Id}}', ref], Math.min(deadlineMs, INSPECT_DEADLINE_MS), env);
    if (r.code === 0) continue;
    // The engine's own words for an image it does not hold ("Error response from daemon: No such image: …"); any other
    // failure (a missing context, a stopped engine) is the engine's, not a missing base.
    if (/\bno such (image|object)\b/i.test(r.out)) {
      throw new ImageBuildError('base_missing', `the app's base image is not on this container engine, and publishing never downloads it on its own. Pull it, then publish again: ${bin} pull ${ref}`, r.out);
    }
    throw new ImageBuildError('no_engine', `the container engine (${bin}) could not say whether the base image ${ref} is present (exit ${r.code ?? 'signal'})`, r.out);
  }
}

/**
 * `docker build` over `ctx` with its product Dockerfile, tagged `tag`, labelled with the manifest digest;
 * answers the image id (`sha256:…`). Every base image must already be on the engine ({@link requireBases}):
 * a missing one is refused, never pulled. The build itself asks for no pull (`--pull=false`) and never pushes.
 */
export async function buildImage(ctx: string, tag: string, labels: Record<string, string>, opts: { bin?: string; env?: NodeJS.ProcessEnv; deadlineMs?: number } = {}): Promise<{ id: string; log: string }> {
  const bin = opts.bin ?? 'docker';
  const env = opts.env ?? process.env;
  // THIS build's id, written by the engine itself (never read back through the tag, which another build may move).
  const iidDir = mkdtempSync(join(tmpdir(), 'wicked-apps-iid-'));
  const iidFile = join(iidDir, 'iid');
  try {
    await requireBases(bin, ctx, opts.deadlineMs ?? BUILD_DEADLINE_MS, env);
    const args = ['build', '--pull=false', '--tag', tag, '--iidfile', iidFile, '--file', `${ctx}/Dockerfile`];
    for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
    args.push(ctx);
    const b = await run(bin, args, opts.deadlineMs ?? BUILD_DEADLINE_MS, env);
    if (b.code !== 0) throw new ImageBuildError('build_failed', `the image build failed (exit ${b.code ?? 'signal'})`, b.out);
    let id = '';
    try {
      id = readFileSync(iidFile, 'utf8').trim();
    } catch {
      // no id written
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new ImageBuildError('build_failed', 'the build wrote no image id', b.out);
    return { id, log: b.out };
  } finally {
    rmSync(iidDir, { recursive: true, force: true });
  }
}
