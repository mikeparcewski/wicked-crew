// POST /open (crew#273): open a file/folder with the OS default application, daemon-side.
//
// The studio is a browser SPA and cannot spawn a process, so the open MUST happen here — which is
// exactly why the path is validated against known roots first (the run's workdir / extra write
// roots, registered repo roots) and the opener is spawned with the path as a single argv element,
// never through a shell string. There is no injection surface: `open`/`xdg-open`/`cmd /c start`
// receive the path verbatim as one argument.

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Is `target` inside `root` (or `root` itself), after normalization? Traversal-safe: the check is
 * on the RESOLVED relative path's first segment, so `/root/../evil` never passes, and a sibling
 * whose name merely starts with dots (`/a/..hidden`) is not wrongly excluded.
 */
export function isInsideRoot(root: string, target: string): boolean {
  // Symlink-safe (Copilot, PR#279): containment is judged on REAL paths, or a
  // `<root>/symlink-to-outside` opens a file the validation never looked at. A missing
  // leaf resolves through its deepest EXISTING ancestor (never a bare lexical fallback:
  // on macOS the tmpdir itself sits under the /var → /private/var symlink, and a lexical
  // fallback on one side of the comparison would break containment for real children).
  // Only ENOENT falls to the ancestor walk; any OTHER filesystem error (EACCES, ELOOP, …)
  // fails CLOSED — an unresolvable-but-existing path must not be judged lexically (Copilot).
  const real = (p: string): string | null => {
    const abs = resolve(p);
    try {
      return realpathSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = dirname(abs);
      if (parent === abs) return abs;
      const rp = real(parent);
      return rp === null ? null : join(rp, basename(abs));
    }
  };
  const realRoot = real(root);
  const realTarget = real(target);
  if (realRoot === null || realTarget === null) return false;
  const rel = relative(realRoot, realTarget);
  if (rel === '') return true; // the root itself
  if (isAbsolute(rel)) return false; // different drive/tree entirely (win32)
  return rel.split(sep)[0] !== '..';
}

/** The session fields the root set is derived from — structural on purpose, so this stays a leaf
 *  module (routes.ts hands it the wire-shape `SessionView.session`; tests hand it a literal). */
export interface RootSourceSession {
  workdir?: string | null;
  extra_write_roots?: string[] | null;
}

/**
 * The ONE root set a caller-supplied path is contained against (DES-FEEDBACK-002 CREW-1):
 * the run's workdir + its `extra_write_roots` (when a run is in play) + every registered repo
 * root. Extracted from the `POST /open` handler so `/open`, `GET /runs/:id/files`, and
 * `GET /runs/:id/diff` cannot drift — three copies of a containment root set is how one of
 * them quietly widens.
 */
export function allowedRootsFor(
  session: RootSourceSession | undefined,
  repos: ReadonlyArray<{ root_path: string }>,
): string[] {
  const roots: string[] = [];
  if (session !== undefined) {
    const workdir = session.workdir;
    if (typeof workdir === 'string' && workdir.length > 0) roots.push(workdir);
    for (const r of session.extra_write_roots ?? []) {
      if (typeof r === 'string' && r.length > 0) roots.push(r);
    }
  }
  for (const repo of repos) roots.push(repo.root_path);
  return roots;
}

/** The platform's opener invocation. Exported for tests; args are always a real argv array. */
export function platformOpenCommand(target: string): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'open', args: [target] };
    case 'win32':
      // `start` is a cmd builtin; the empty string is start's window-title slot so the path is
      // never mistaken for a title. Still an argv array — no shell string is ever composed.
      return { cmd: 'cmd', args: ['/c', 'start', '', target] };
    default:
      return { cmd: 'xdg-open', args: [target] };
  }
}

/**
 * Spawn the platform opener, detached, and resolve on SPAWN success (the OS accepted the process —
 * what the opener then does with the path is the desktop environment's business). Rejects when the
 * opener binary itself cannot be spawned, which the route reports as 502.
 */
export function openWithSystemDefault(target: string): Promise<void> {
  const { cmd, args } = platformOpenCommand(target);
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.once('error', rejectPromise);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
}
