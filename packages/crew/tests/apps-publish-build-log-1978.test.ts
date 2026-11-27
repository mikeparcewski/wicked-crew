// crew#1978: a failed image step carries the engine's own last words, so the produce step shows WHY it failed.
//
// Before, `run.ts` mapped an ImageBuildError to its code and crew's sentence ("the image build failed (exit 1)") and
// the engine output (ImageBuildError.log) was dropped. The produce step prints the refusal's error sliced to 600
// characters (src/cli/apps-produce.ts), so the excerpt is bounded to fit beside crew's sentence.
//
// The engine is a fake `docker` on disk that fails its build the way BuildKit does (its last lines name the step).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildImage, engineExcerpt, ImageBuildError } from '../src/apps/publish/image.js';

let dir: string;
let ctx: string;
let bin: string;
const fake = (script: string): void => {
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-1978-'));
  ctx = mkdtempSync(join(dir, 'ctx-'));
  writeFileSync(join(ctx, 'Dockerfile'), 'FROM node:24\n');
  bin = join(dir, 'docker');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const refusal = async (): Promise<ImageBuildError> => (await buildImage(ctx, 'wicked-apps/desk:v1', {}, { bin, env: { PATH: process.env['PATH'] } }).catch((e: unknown) => e)) as ImageBuildError;

describe('crew#1978: the engine\'s own words on a failed image step', () => {
  it('a failed build says what the engine said, last lines first-fit, with the build context path hidden', async () => {
    fake(`echo "#5 [2/4] COPY server /srv"
echo "#5 ERROR: failed to calculate checksum: \\"/server\\": not found in ${ctx}" >&2
echo "ERROR: failed to solve: failed to compute cache key" >&2
exit 1`);
    const err = await refusal();
    expect(err.code).toBe('build_failed');
    expect(err.message).toBe('the image build failed (exit 1). The engine said: #5 [2/4] COPY server /srv | #5 ERROR: failed to calculate checksum: "/server": not found in <build context> | ERROR: failed to solve: failed to compute cache key');
    expect(err.message).not.toContain(dir);
  });

  it('an engine that said nothing leaves the sentence bare (no dangling words)', async () => {
    fake('printf "  \\n\\n"; exit 2');
    expect((await refusal()).message).toBe('the image build failed (exit 2)');
  });

  it('an engine that cannot be started keeps its own sentence', async () => {
    bin = join(dir, 'no-such-docker');
    const err = await refusal();
    expect(err.code).toBe('no_engine');
    expect(err.message).toMatch(/^the container engine \(.*\) could not be started: ENOENT$/);
  });

  it('the excerpt is bounded to fit the printed refusal, keeps the newest lines, and hides the home directory', () => {
    const log = [...Array.from({ length: 50 }, (_, i) => `#${i} step ${'.'.repeat(30)}`), `ERROR: read ${join(homedir(), '.docker', 'config.json')}: denied`].join('\n');
    const said = engineExcerpt(log, [[homedir(), '~']]);
    expect(said.length).toBeLessThanOrEqual(400);
    expect(said.endsWith('ERROR: read ~/.docker/config.json: denied')).toBe(true);
    expect(said).not.toContain(homedir());
    expect(`the image build failed (exit 1). The engine said: ${said}`.length + 'apps_produce: refused: build_failed: '.length).toBeLessThanOrEqual(600);
    // One line longer than the bound keeps its end.
    const long = engineExcerpt(`ERROR: ${'x'.repeat(1000)} the end`, []);
    expect(long.length).toBe(400);
    expect(long.startsWith('…') && long.endsWith('the end')).toBe(true);
  });
});
