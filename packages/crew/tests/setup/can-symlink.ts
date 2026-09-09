// Whether this process may create directory symlinks. On Windows that needs Developer Mode or an
// elevated shell, so the symlink-containment cases `skipIf(!canSymlink())` instead of failing on
// a runner that cannot plant the very thing they test. Everywhere else this is simply true.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function canSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'wi-symlink-probe-'));
  try {
    symlinkSync(dir, join(dir, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
