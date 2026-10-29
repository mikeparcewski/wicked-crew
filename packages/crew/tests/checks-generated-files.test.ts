// wicked-core#1173: `.wicked/checks.json` declares the files crew GENERATES and the command that
// regenerates each set. When a deliver lift conflicts only in a changelog and these files (rig run
// 62c4f0ff: CHANGELOG.md + the generated API suite), the engine takes main's copy, runs these commands in
// the floor's sandbox on the lifted tree, and re-verifies, instead of stranding the run.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Generated {
  paths: string[];
  command: string[];
}

const checks = JSON.parse(readFileSync(join(ROOT, '.wicked', 'checks.json'), 'utf8')) as { generated?: Generated[] };
const scripts = (JSON.parse(readFileSync(join(ROOT, 'packages', 'crew', 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

describe('wicked-core#1173 — .wicked/checks.json declares crew\'s generated files', () => {
  it('declares the endpoint manifest, then the generated API suite (it reads the manifest), in that order', () => {
    expect(checks.generated?.map((g) => g.paths)).toEqual([
      ['packages/crew/endpoint-manifest.json'],
      ['packages/crew/tests/generated/api-sample.generated.test.ts'],
    ]);
  });

  it('every declared path is a committed file, named literally (harness.ts beside the suite is hand-written)', () => {
    for (const g of checks.generated ?? []) {
      for (const p of g.paths) {
        expect(p.includes('*'), `${p} is a literal path`).toBe(false);
        expect(existsSync(join(ROOT, p)), `${p} exists`).toBe(true);
      }
    }
  });

  it('every command runs a packages/crew script that writes those paths', () => {
    const want = [
      ['manifest:endpoints', 'scripts/generate-endpoint-manifest.ts'],
      ['generate:api-tests', 'scripts/generate-api-tests.ts'],
    ];
    (checks.generated ?? []).forEach((g, i) => {
      expect(g.command).toEqual(['npm', 'run', '-w', 'packages/crew', want[i]![0]]);
      expect(scripts[want[i]![0]!]).toContain(want[i]![1]);
    });
  });
});
