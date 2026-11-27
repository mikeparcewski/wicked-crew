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
    readonly code: 'no_engine' | 'build_failed' | 'timeout',
    message: string,
    /** The engine's own output (its last characters). Never shown or recorded: only the daemon's local log gets it. */
    readonly log: string,
    /** (crew#1978) Crew's own words for the cause, from a closed set ({@link engineCause}); `null` when none matched. */
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

/**
 * (crew#1978) The cause of a failed engine call, in crew's OWN fixed words, recognised in the engine's output. Nothing
 * the engine printed is carried: its output can hold host paths and credentials (a cert directory, a socket, a
 * registry token), and a deny-list over free text kept leaking (codex-check r1 and r2 on #1980). So the cause comes
 * from a closed set; a failed Dockerfile step is named by its NUMBER only. `null` when no cause is recognised.
 */
export function engineCause(log: string): string | null {
  if (/cannot connect to the docker daemon|error during connect|is the docker daemon running|connection refused/i.test(log)) return 'crew could not reach the container engine';
  if (/no space left on device/i.test(log)) return 'the container engine ran out of disk space';
  if (/permission denied/i.test(log)) return 'the container engine was refused permission';
  if (/\bno such (image|object)\b|pull access denied|manifest unknown/i.test(log)) return 'an image the build needs is not on the container engine';
  if (/\bERROR\b/.test(log)) {
    // BuildKit numbers each Dockerfile step "[<n>/<total>]" (a stage name may come first); the last one before the error.
    const steps = [...log.matchAll(/\[(?:[\w.-]+ )?(\d{1,3})\/(\d{1,3})\]/g)];
    const last = steps.at(-1);
    if (last !== undefined) return `Dockerfile step ${last[1]} of ${last[2]} failed`;
  }
  return null;
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

/**
 * `docker build` over `ctx` with its product Dockerfile, tagged `tag`, labelled with the manifest digest;
 * answers the image id (`sha256:…`). The base image must already be present (`--pull=false` is not set, so
 * the engine pulls the pinned digest when it is missing; it never pushes).
 */
export async function buildImage(ctx: string, tag: string, labels: Record<string, string>, opts: { bin?: string; env?: NodeJS.ProcessEnv; deadlineMs?: number } = {}): Promise<{ id: string; log: string }> {
  const bin = opts.bin ?? 'docker';
  const env = opts.env ?? process.env;
  // THIS build's id, written by the engine itself (never read back through the tag, which another build may move).
  const iidDir = mkdtempSync(join(tmpdir(), 'wicked-apps-iid-'));
  const iidFile = join(iidDir, 'iid');
  try {
    const args = ['build', '--tag', tag, '--iidfile', iidFile, '--file', `${ctx}/Dockerfile`];
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
  } catch (err) {
    // (crew#1978) The refusal names a closed cause when crew recognises one; the engine's text never rides along.
    if (err instanceof ImageBuildError && err.reason === null) {
      const reason = engineCause(err.log);
      throw new ImageBuildError(err.code, reason === null ? err.message : `${err.message}: ${reason}`, err.log, reason);
    }
    throw err;
  } finally {
    rmSync(iidDir, { recursive: true, force: true });
  }
}
