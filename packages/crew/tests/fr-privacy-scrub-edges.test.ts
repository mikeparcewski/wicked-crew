// Review r1 (codex) on the privacy backstop: escaped separators, path-keyed maps, web addresses left alone, the
// home compiled once, a podman user not told to start Docker. Each case failed on the first cut.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { plainRuntimeCause, registerUiTextScrub, scrubHomePaths } from '../src/api/ui-text.js';
import { expectNoHomePaths } from './fr-privacy-helpers.js';

const HOME = '/Users/alice';

describe('scrubHomePaths edges (review r1)', () => {
  it('folds JSON-escaped separators inside a string value (a serialized fragment in a log line)', () => {
    expect(scrubHomePaths('{"p":"\\/Users\\/alice\\/x"}', HOME)).toBe('{"p":"~\\/x"}');
    expect(scrubHomePaths('{"p":"\\/home\\/bob\\/x"}', '/nowhere')).toBe('{"p":"~\\/x"}');
    expect(scrubHomePaths('C:\\\\Users\\\\Carol\\\\x', '/nowhere')).toBe('~\\\\x');
  });
  it('leaves web addresses alone, but still folds a unix:// socket path', () => {
    expect(scrubHomePaths('https://example.com/Users/alice/docs', HOME)).toBe('https://example.com/Users/alice/docs');
    expect(scrubHomePaths('https://example.com//home/page', HOME)).toBe('https://example.com//home/page');
    expect(scrubHomePaths('unix:///Users/alice/.rd/docker.sock', HOME)).toBe('unix://~/.rd/docker.sock');
    expect(scrubHomePaths('at /Users/alice/x and /home/bob/y', HOME)).toBe('at ~/x and ~/y');
  });
  it('is case-insensitive for another user and keeps a sibling user name intact for the home pass', () => {
    expect(scrubHomePaths('c:\\users\\dave\\x', '/nowhere')).toBe('~\\x');
    expect(scrubHomePaths('/Users/alice2/x', HOME)).toBe('~/x');
  });
});

describe('the backstop scrubs keys too (review r1)', () => {
  it('a path-keyed map loses its home paths, and two keys that fold to one keep both values', async () => {
    const app = Fastify();
    registerUiTextScrub(app, ['/api/v1/diagnostics'], HOME);
    app.get('/api/v1/diagnostics', async () => ({ byPath: { '/Users/alice/x': 1, '~/x': 2, '/home/bob/y': 3 } }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
    expectNoHomePaths(res.body);
    const body = res.json() as { byPath: Record<string, number> };
    expect(Object.values(body.byPath).sort()).toEqual([1, 2, 3]);
    await app.close();
  });
});

describe('plainRuntimeCause names the runtime the user has (review r1)', () => {
  it('podman and nerdctl are not told to start Docker', () => {
    expect(plainRuntimeCause('Cannot connect to Podman. Please verify your connection', 'podman')?.cause).toBe("Podman isn't running");
    expect(plainRuntimeCause('dial unix /run/containerd/containerd.sock: connect: no such file or directory', 'nerdctl')?.cause).toContain('nerdctl');
    expect(plainRuntimeCause('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')?.cause).toBe("Docker isn't running");
  });
});

describe('expectNoHomePaths catches the leaks it is meant to (review r1)', () => {
  it.each(['\\/Users\\/alice\\/x', 'C:\\users\\alice', '/USERS/alice', '/Home/bob'])('fails on %s', (dirty) => {
    expect(() => expectNoHomePaths(JSON.stringify({ m: dirty }))).toThrow();
  });
});
