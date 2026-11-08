/**
 * What a person types into "Add a repository", and what they read when onboarding cannot start.
 *
 * First-run walk-through (2026-11-08, C1 + B2): the folder field suggests `~/code/my-app`, but crew
 * handed `~/code/my-app` to the engine verbatim and the engine answered "~/code/my-app is not a
 * directory" — a `~` path is a shell spelling, and no shell sits between the form and the engine.
 * And a repository added without wicked-estate answered with the engine's planner text
 * ("unresolved tool dependencies: phase 'index' requires tool 'wicked-estate' (not found on PATH
 * …)"), which names no fix. Both are crew's API, so both are fixed here, once, for every caller.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** A folder the person typed: expanded, or refused with a reason they can act on. */
export type RepoPathReading = { ok: true; path: string } | { ok: false; code: 'repo_path_relative' | 'repo_path_missing'; error: string };

/** `path` as a person should read it: the home dir as `~` (never an absolute home path in a message). */
export function tildePath(path: string, home: string = homedir()): string {
  if (home === '' || home === '/') return path;
  if (path === home) return '~';
  for (const sep of ['/', '\\']) {
    if (path.startsWith(home + sep)) return `~${sep}${path.slice(home.length + 1)}`;
  }
  return path;
}

/**
 * Expand a leading `~` (`~`, `~/x`, `~\x`) to the daemon's home; refuse `~other` and relative
 * paths, which have no single meaning for a daemon (its cwd is not the person's). With `mustExist`,
 * a folder that is not there is refused here, in plain words, before the engine is asked.
 */
export function readRepoPath(raw: string, opts: { home?: string; mustExist?: boolean } = {}): RepoPathReading {
  const home = opts.home ?? homedir();
  const typed = raw.trim();
  let path = typed;
  if (typed === '~') path = home;
  else if (typed.startsWith('~/') || typed.startsWith('~\\')) path = join(home, typed.slice(2));
  else if (typed.startsWith('~')) {
    return { ok: false, code: 'repo_path_relative', error: `Use ~/… for your own home folder, or a full path: ${typed} names another user's home.` };
  }
  if (!isAbsolute(path)) {
    return { ok: false, code: 'repo_path_relative', error: `Use a full path, like ~/code/my-app: ${typed} is relative, and the daemon has no current folder of yours to start from.` };
  }
  if (opts.mustExist === true) {
    let dir = false;
    try {
      dir = existsSync(path) && statSync(path).isDirectory();
    } catch {
      dir = false;
    }
    if (!dir) return { ok: false, code: 'repo_path_missing', error: `There is no folder at ${tildePath(path, home)}. Check the path and try again.` };
  }
  return { ok: true, path };
}

/** The install command for a tool the engine's planner names, when the installer ships it. */
const TOOL_INSTALL: Record<string, string> = {
  'wicked-estate': 'npx wicked-installer install wicked-estate',
};

/**
 * An onboarding launch the engine refused, in words a person can act on. The engine's planner says
 * "phase 'index' requires tool 'wicked-estate' (not found on PATH …)" when a phase's tool is not
 * installed; that becomes `tool_missing` with the install command. Anything else keeps the
 * engine's message (home paths shown as `~`).
 */
export function onboardFailure(raw: string, home: string = homedir()): { code?: 'tool_missing'; tool?: string; error: string } {
  const m = /requires tool '([^']+)' \(not found/.exec(raw);
  if (m !== null) {
    const tool = m[1] as string;
    const install = TOOL_INSTALL[tool];
    const what = tool === 'wicked-estate' ? 'Building its code map needs wicked-estate' : `Onboarding needs ${tool}`;
    const fix = install !== undefined ? `Install it: ${install}, then run onboarding again (⋯ → Rebuild the code map).` : `Install ${tool} and put it on PATH, then run onboarding again.`;
    return { code: 'tool_missing', tool, error: `${what}, which isn't installed. ${fix}` };
  }
  return { error: scrubHome(raw, home) };
}

function scrubHome(text: string, home: string): string {
  return home === '' || home === '/' ? text : text.split(home).join('~');
}
