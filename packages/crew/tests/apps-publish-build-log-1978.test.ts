// crew#1978: a failed image step says WHY, in crew's own closed words; the engine's text never leaves the machine.
//
// Before, `run.ts` mapped an ImageBuildError to crew's bare sentence ("the image build failed (exit 1)") and the engine
// output was dropped. Carrying a redacted excerpt leaked (codex-check r1 and r2 on #1980: cert paths, socket URLs,
// quoted tokens, JSON passwords), so coord ruled the cut: the refusal names a cause from a fixed set, else it points at
// the daemon log, where the engine's output goes (keyed by run), never into the run record or a PR.
//
// The engine is a fake `docker` on disk that fails its build the way BuildKit does.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildImage, engineCause, ImageBuildError } from '../src/apps/publish/image.js';
import { imageRefusalWords } from '../src/apps/publish/run.js';

// Synthetic leak probes from codex-check r1 and r2 on #1980 (made-up values, no real credential).
const PROBES = [
  'open /var/folders/review-sentinel/T/client-certs/ca.pem',
  'unix:///opt/review-sentinel/private/docker.sock',
  '/Volumes/My Disk/review sentinel/certs',
  'token="synthetic-review-secret"', // ggignore: a made-up probe value
  '{"password": "synthetic-review-password"}', // ggignore: a made-up probe value
  'authorization: bearer synthetic-review-bearer', // ggignore: a made-up probe value
];
const SECRETS = ['review-sentinel', 'review sentinel', 'synthetic-review-secret', 'synthetic-review-password', 'synthetic-review-bearer', '/var/folders', '/opt/', '/Volumes'];

let dir: string;
let ctx: string;
let bin: string;
const fake = (lines: string[], exit = 1): void => {
  writeFileSync(join(dir, 'out.txt'), lines.join('\n') + '\n');
  // The base is on the engine (crew#1972's inspect answers); the build fails with `lines`.
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = image ]; then echo sha256:1; exit 0; fi\ncat "${join(dir, 'out.txt')}" >&2\nexit ${exit}\n`);
  chmodSync(bin, 0o755);
};
const refusal = async (): Promise<ImageBuildError> => (await buildImage(ctx, 'wicked-apps/desk:v1', {}, { bin, env: { PATH: process.env['PATH'] } }).catch((e: unknown) => e)) as ImageBuildError;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-1978-'));
  ctx = mkdtempSync(join(dir, 'ctx-'));
  writeFileSync(join(ctx, 'Dockerfile'), 'FROM node:24\n');
  bin = join(dir, 'docker');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('crew#1978: a failed image step names its cause in crew\'s words only', () => {
  it('a failed Dockerfile step is named by its number, and nothing the engine printed is carried', async () => {
    fake(['#5 [2/4] COPY server /srv', `#5 ERROR: failed to calculate checksum: "/server": not found in ${ctx}`, ...PROBES, 'ERROR: failed to solve: failed to compute cache key']);
    const err = await refusal();
    expect(err.code).toBe('build_failed');
    expect(err.message).toBe('the image build failed (exit 1): Dockerfile step 2 of 4 failed');
    expect(err.reason).toBe('Dockerfile step 2 of 4 failed');
    for (const s of [...SECRETS, ctx, 'COPY', '/srv', 'checksum']) expect(err.message).not.toContain(s);
  });

  it.each([
    ['Cannot connect to the Docker daemon at unix:///opt/review-sentinel/docker.sock. Is the docker daemon running?', 'crew could not reach the container engine'],
    ['ERROR: failed to copy: write /var/lib/docker/tmp/x: no space left on device', 'the container engine ran out of disk space'],
    ['open /var/folders/review-sentinel/T/client-certs/ca.pem: permission denied', 'the container engine was refused permission'],
    ['ERROR: failed to solve: node:24: pull access denied, repository does not exist', 'an image the build needs is not on the container engine'],
  ])('a recognised cause is said in crew\'s fixed words (%s)', (line, words) => {
    expect(engineCause(`#1 [internal] load build definition\n${line}\n`)).toBe(words);
  });

  it('an unrecognised failure carries no engine text and points at the daemon log, keyed by run', async () => {
    fake(PROBES);
    const err = await refusal();
    expect(err.reason).toBeNull();
    expect(err.message).toBe('the image build failed (exit 1)');
    const words = imageRefusalWords(err, 'run-1');
    expect(words).toBe("the image build failed (exit 1); the engine's reason is in the daemon log (run run-1)");
    for (const s of SECRETS) expect(words).not.toContain(s);
    // The engine's output stays on the error, for the daemon's local log only.
    expect(err.log).toContain('synthetic-review-secret');
  });

  it('an engine that said nothing leaves the sentence bare (no pointer to an empty log)', async () => {
    fake([''], 2);
    const err = await refusal();
    expect(imageRefusalWords(err, 'run-1')).toBe('the image build failed (exit 2)');
  });

  it('a missing base keeps its own sentence (crew#1972): no cause appended, no log pointer', async () => {
    writeFileSync(bin, '#!/bin/sh\nif [ "$1" = image ]; then echo "Error response from daemon: No such image: node:24" >&2; exit 1; fi\nexit 0\n');
    chmodSync(bin, 0o755);
    const err = await refusal();
    expect(err.code).toBe('base_missing');
    expect(err.message).toMatch(/Pull it, then publish again: .* pull node:24$/);
    expect(imageRefusalWords(err, 'run-1')).toBe(err.message);
  });

  it('an engine that cannot be started keeps its own sentence', async () => {
    bin = join(dir, 'no-such-docker');
    const err = await refusal();
    expect(err.code).toBe('no_engine');
    expect(imageRefusalWords(err, 'run-1')).toMatch(/^the container engine \(.*\) could not be started: ENOENT$/);
  });
});
