import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolveThreadpoolSize } from '../src/core/threadpool.js';

describe('resolveThreadpoolSize (crew#1495)', () => {
  it.each([
    [1, '16'],
    [4, '16'],
    [16, '16'],
    [32, '32'],
    [1024, '1024'],
    [2048, '1024'],
  ])('defaults to a bounded pool for %i cores', (cores, expected) => {
    expect(resolveThreadpoolSize({}, cores)).toBe(expected);
  });

  it.each(['1', '4', '32', '1024', '0032'])('preserves the operator override %s', (value) => {
    expect(resolveThreadpoolSize({ UV_THREADPOOL_SIZE: value }, 64)).toBe(value);
  });

  it.each(['', ' ', '0', '-1', '1025', 'garbage', '16garbage', '16.5', '16.0', '1e2', '0x20', ' 32 '])(
    'replaces invalid override %j with the default',
    (value) => {
      expect(resolveThreadpoolSize({ UV_THREADPOOL_SIZE: value }, 4)).toBe('16');
      expect(resolveThreadpoolSize({ UV_THREADPOOL_SIZE: value }, 64)).toBe('64');
    },
  );
});

it('loads the pool initializer as the first non-comment CLI import', () => {
  const source = readFileSync(new URL('../src/cli/index.ts', import.meta.url), 'utf8');
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const firstImport = withoutComments.match(/^\s*import\b[^;]*;/m)?.[0]?.trim();
  expect(firstImport).toBe("import '../core/threadpool.js';");
});

it.each([undefined, 'garbage', '3', '0032'])(
  'sets the environment on import in a fresh process (override %j)',
  (override) => {
    const env = { ...process.env };
    delete env.UV_THREADPOOL_SIZE;
    if (override !== undefined) env.UV_THREADPOOL_SIZE = override;
    const moduleUrl = new URL('../src/core/threadpool.ts', import.meta.url).href;
    const output = execFileSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      `await import(${JSON.stringify(moduleUrl)}); process.stdout.write(process.env.UV_THREADPOOL_SIZE);`,
    ], { env, encoding: 'utf8', timeout: 10_000 });
    const expected = override === '3' || override === '0032'
      ? override
      : String(Math.min(1024, Math.max(16, availableParallelism())));
    expect(output).toBe(expected);
  },
);
