import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// crew#352: `wicked-crew serve --help` must print usage and exit 0 WITHOUT booting a daemon on
// default state. Runs the built CLI (dist) when present; the fix short-circuits before
// parseBootstrap so no store/port is touched.
const CLI = join(__dirname, '..', 'dist', 'cli', 'index.js');

describe.runIf(existsSync(CLI))('serve --help (crew#352)', () => {
  for (const flag of ['--help', '-h']) {
    it(`prints usage and exits 0 for ${flag} without starting anything`, () => {
      const out = execFileSync('node', [CLI, 'serve', flag], { encoding: 'utf8', timeout: 20000 });
      expect(out).toContain('Usage: wicked-crew serve');
      expect(out).toContain('--port');
      expect(out).not.toContain('WICKED_CREW_READY');
    });
  }
});
