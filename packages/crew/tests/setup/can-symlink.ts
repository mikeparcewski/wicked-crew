// Whether this process may create directory symlinks — probed, not assumed. On Windows that needs
// Developer Mode or an elevated shell; on Unix-like runners a container/sandbox policy or a
// filesystem mount can refuse symlinks too. The symlink-containment cases `skipIf(!canSymlink())`
// instead of failing on a runner that cannot plant the very thing they test.
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
