// The installed crew package carries the server and studio's standalone runtime. A checkout may
// use the sibling builds instead; an absent or incomplete build leaves Publish unavailable.

import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { childEnvWithBootEstateDb } from '../../core/governance-store.js';
import { KEEP_ENV } from './image.js';

const crew = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function hasFiles(dir: string, files: string[]): boolean {
  try {
    return files.every((file) => statSync(join(dir, file)).isFile());
  } catch {
    return false;
  }
}

/** The product Dockerfile, bundled server and SQLite runner, pinned by crew's build. */
export function appsServerArtifact(): string | null {
  for (const dir of [join(crew, 'dist/apps-server'), resolve(crew, '../apps-server/dist')]) {
    if (hasFiles(dir, ['Dockerfile', 'server/lib/bundle/server.mjs', 'server/shim/host.js', 'server/shim/host.css', 'runners/sqlite-runner.mjs'])) return dir;
  }
  return null;
}

const RUNTIME_DIRS = (): string[] => [join(crew, 'dist/studio/apps-standalone'), resolve(crew, '../../../wicked-studio/dist/apps-standalone')];
const RUNTIME_FILES = ['runtime.js', 'runtime.css', 'fixture.html', 'fixture.js'];

/** Where the runtime is, by existence only (the capability reads this on every health poll: no file is read). */
export function appsRuntimeDir(): string | null {
  return RUNTIME_DIRS().find((dir) => hasFiles(dir, RUNTIME_FILES)) ?? null;
}

/** `js` and `css` are the texts writeImageContext packs; `dir` also holds the render fixture. */
export function appsRuntime(): { dir: string; js: string; css: string } | null {
  for (const dir of RUNTIME_DIRS()) {
    if (!hasFiles(dir, RUNTIME_FILES)) continue;
    try {
      return { dir, js: readFileSync(join(dir, 'runtime.js'), 'utf8'), css: readFileSync(join(dir, 'runtime.css'), 'utf8') };
    } catch {
      // Unreadable or removed during resolution: try the checkout, then answer unavailable.
    }
  }
  return null;
}

let held: { answers: boolean; until: number } | null = null;
let pending: Promise<boolean> | null = null;

/** One bounded probe per minute, including failures; concurrent health polls share the probe. */
export async function containerEngineAnswers(): Promise<boolean> {
  if (held !== null && Date.now() < held.until) return held.answers;
  if (pending !== null) return pending;
  pending = new Promise<boolean>((done) => {
    // The engine CLI gets where it is and which engine, never the daemon's environment (review r1; image.ts's rule).
    const picked: NodeJS.ProcessEnv = {};
    for (const k of KEEP_ENV) if (process.env[k] !== undefined) picked[k] = process.env[k];
    execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 8_000, env: childEnvWithBootEstateDb(picked) }, (error, stdout) => {
      done(error === null && stdout.trim().length > 0);
    });
  });
  try {
    const answers = await pending;
    held = { answers, until: Date.now() + 60_000 };
    return answers;
  } catch {
    held = { answers: false, until: Date.now() + 60_000 };
    return false;
  } finally {
    pending = null;
  }
}

/**
 * The capability's answer without waiting: the last probe's answer while it is fresh, else `false` until a probe
 * (started here, in the background) answers. A health poll never waits on the engine.
 */
export function containerEngineKnown(): boolean {
  if (held !== null && Date.now() < held.until) return held.answers;
  void containerEngineAnswers();
  return held?.answers ?? false;
}
