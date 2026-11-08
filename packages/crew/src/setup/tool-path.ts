import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Installer tools must be visible to the engine and child processes; the user's PATH wins. */
export function withInstallerBinDirs(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = isDirectory,
): { path: string; added: string[] } {
  const paths = platform === 'win32' ? win32 : posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const path = env['PATH'] ?? (platform === 'win32' ? env['Path'] : undefined) ?? '';
  const key = (entry: string): string => {
    let resolved = paths.resolve(entry);
    // Existing aliases of the same directory should not add a second PATH entry.
    try { resolved = realpathSync(resolved); } catch { /* an absent PATH entry is kept as given */ }
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const seen = new Set(path.split(delimiter).filter(Boolean).map(key));
  const added: string[] = [];
  for (const dir of [env['XDG_BIN_HOME'], paths.join(home, '.local', 'bin'), paths.join(home, '.cargo', 'bin')]) {
    if (!dir || !exists(dir) || seen.has(key(dir))) continue;
    seen.add(key(dir));
    added.push(dir);
  }
  return { path: [path, ...added].filter(Boolean).join(delimiter), added };
}

/** One boot call, before Core construction, exports the same PATH to every daemon consumer. */
export function configureInstallerToolPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  log: (message: string) => void = console.error,
): void {
  const { path, added } = withInstallerBinDirs(env, home);
  env['PATH'] = path;
  if (added.length === 0) return;
  const paths = process.platform === 'win32' ? win32 : posix;
  const display = (dir: string): string => {
    const relative = paths.relative(home, dir);
    return relative === '' ? '~' : !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`)
      ? `~/${relative.split(paths.sep).join('/')}`
      : dir;
  };
  log(`[crew] added installer tool directories to PATH: ${added.map(display).join(', ')}`);
}
