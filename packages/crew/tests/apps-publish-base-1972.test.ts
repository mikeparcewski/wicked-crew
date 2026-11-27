// crew#1972: publishing never pulls a missing base image on its own.
//
// Train-17 cert: the pinned base (`FROM node:24-bookworm-slim@sha256:…`, packages/apps-server/image/Dockerfile) had
// been pruned from the engine, and `docker build` would have fetched it (about 80 MB) with nothing on the sheet saying
// so. buildImage now checks the engine's own image store first and refuses with the image and the pull command.
//
// The engine here is a fake `docker` on disk. crew hands the engine CLI only a few variables (image.ts KEEP_ENV), so the
// fake reads its switches and writes its call log under DOCKER_CONFIG, one of them.
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baseImagesOf, buildImage, ImageBuildError } from '../src/apps/publish/image.js';

const PRODUCT_DOCKERFILE = join(__dirname, '..', '..', 'apps-server', 'image', 'Dockerfile');
const BASE = 'node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c';
const FAKE = `#!/bin/sh
echo "$*" >> "$DOCKER_CONFIG/calls"
case "$1" in
  image)
    if [ -f "$DOCKER_CONFIG/engine-down" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
    if [ -f "$DOCKER_CONFIG/has-base" ]; then echo "sha256:1111111111111111111111111111111111111111111111111111111111111111"; exit 0; fi
    echo "Error response from daemon: No such image: $5" >&2; exit 1 ;;
  build)
    while [ $# -gt 0 ]; do
      if [ "$1" = "--iidfile" ]; then echo "sha256:2222222222222222222222222222222222222222222222222222222222222222" > "$2"; fi
      shift
    done
    exit 0 ;;
esac
exit 0
`;

let dir: string;
let ctx: string;
let bin: string;
let env: NodeJS.ProcessEnv;
const calls = (): string[] => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-1972-'));
  ctx = mkdtempSync(join(dir, 'ctx-'));
  copyFileSync(PRODUCT_DOCKERFILE, join(ctx, 'Dockerfile'));
  bin = join(dir, 'docker');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  env = { PATH: process.env['PATH'], DOCKER_CONFIG: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('crew#1972: the base image', () => {
  it('reads the product Dockerfile\'s pinned base (and skips scratch and earlier stages)', () => {
    expect(baseImagesOf(readFileSync(PRODUCT_DOCKERFILE, 'utf8'))).toEqual([BASE]);
    expect(baseImagesOf('FROM --platform=linux/amd64 node:24 AS build\nRUN x\nFROM build\nFROM scratch\nfrom alpine:3 as final\n')).toEqual(['node:24', 'alpine:3']);
    // A FROM continued over lines is read whole (codex-check r1).
    expect(baseImagesOf('FROM \\\n  node:24 \\\n  AS build\nFROM build\n')).toEqual(['node:24']);
  });

  it('a base named through a build argument is refused before anything runs (codex-check r1)', async () => {
    writeFileSync(join(ctx, 'Dockerfile'), 'ARG BASE=node:24\nFROM ${BASE}\n');
    const err = await buildImage(ctx, 'wicked-apps/desk:v1', {}, { bin, env }).catch((e: unknown) => e);
    expect((err as ImageBuildError).code).toBe('build_failed');
    expect((err as ImageBuildError).message).toMatch(/build argument/);
    expect(calls()).toEqual([]);
  });

  it('an engine error that merely says "not found" is not read as a missing base (codex-check r1)', async () => {
    writeFileSync(join(dir, 'engine-down'), '');
    writeFileSync(bin, FAKE.replace('Cannot connect to the Docker daemon', 'error: context "rancher" not found'));
    const err = await buildImage(ctx, 'wicked-apps/desk:v1', {}, { bin, env }).catch((e: unknown) => e);
    expect((err as ImageBuildError).code).toBe('no_engine');
  });

  it('a base missing from the engine is refused with its name and the pull command, and nothing is built or pulled', async () => {
    const err = await buildImage(ctx, 'wicked-apps/desk:v1', {}, { bin, env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageBuildError);
    expect((err as ImageBuildError).code).toBe('base_missing');
    expect((err as ImageBuildError).message).toContain(`${bin} pull ${BASE}`);
    expect((err as ImageBuildError).message).toMatch(/never downloads it on its own/);
    expect(calls()).toEqual([`image inspect --format {{.Id}} ${BASE}`]);
  });

  it('with the base present, the build runs and asks for no pull', async () => {
    writeFileSync(join(dir, 'has-base'), '');
    const image = await buildImage(ctx, 'wicked-apps/desk:v1', { 'org.wicked.apps.run': 'r1' }, { bin, env });
    expect(image.id).toBe(`sha256:${'2'.repeat(64)}`);
    const c = calls();
    expect(c[0]).toBe(`image inspect --format {{.Id}} ${BASE}`);
    expect(c[1]).toMatch(/^build --pull=false --tag wicked-apps\/desk:v1 /);
    expect(c.some((l) => l.startsWith('pull'))).toBe(false);
  });

  it('an engine that cannot answer is not read as a missing base', async () => {
    writeFileSync(join(dir, 'engine-down'), '');
    const err = await buildImage(ctx, 'wicked-apps/desk:v1', {}, { bin, env }).catch((e: unknown) => e);
    expect((err as ImageBuildError).code).toBe('no_engine');
    expect(calls()).toHaveLength(1);
  });
});
