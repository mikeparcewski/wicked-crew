/**
 * The skills root is `<state home>/skills` — full stop. Not a setting, not an env override.
 *
 * Design v3.1 §1 (ONE storage root: every crew store hangs off `crewStateHome()`) and v3.2 §1 (wicked
 * never writes into the user's own CLI directories) leave no room for a configurable root: codex
 * round 5 on #480 showed that a `skills_root` setting (or `WICKED_CREW_SKILLS_ROOT`) accepting any
 * absolute path let `PUT /settings {skills_root: "~/.codex/skills"}` make the SEED write into the
 * user's codex skills before the runtime got around to reporting the location as incompatible. Both
 * are retired (coordinator decision). What remains is this BOOT ASSERTION, evaluated by
 * `createServer` before the store is constructed: the root's CANONICAL path must lie inside the
 * daemon state home and outside every known user-level CLI directory, and the root entry itself
 * must not be a symlink. A violation is `SkillsRootUnfencedError` — a daemon start error, never a
 * warning after the first write.
 *
 * This is the one skills module beside plugin-source.ts that reads `homedir()` — to REFUSE roots,
 * never to write: it imports nothing that writes (tests/skills-no-user-cli-writes.test.ts pins
 * both facts).
 */

import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { claudeConfigDirs } from './plugin-source.js';

/** The skills root would lie outside the state home or inside a user CLI directory — the daemon does not start. */
export class SkillsRootUnfencedError extends Error {
  constructor(
    readonly root: string,
    detail: string,
  ) {
    super(
      `skills root ${root} refused: ${detail} — the skills root is <state home>/skills (not a setting) and must never lie inside a user CLI directory; ` +
        'move the daemon state home (--db) out of the user CLI directory and restart',
    );
    this.name = 'SkillsRootUnfencedError';
  }
}

/**
 * The user-level CLI configuration directories wicked must never write (design v3.2 §1), for `home`:
 * codex, pi, copilot, opencode, Claude Code — the literal `~/.claude` AND every dir the daemon's own
 * `CLAUDE_CONFIG_DIR` lists when it points elsewhere (those are the config dirs the user's Claude reads).
 */
export function userCliDirs(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [
    join(home, '.codex'),
    join(home, '.pi'),
    join(home, '.copilot'),
    join(home, '.config', 'opencode'),
    join(home, '.claude'),
    ...claudeConfigDirs(env, home),
  ];
  return [...new Set(dirs.map((d) => resolve(d)))];
}

/**
 * The canonical spelling of `p`: the realpath of its deepest EXISTING ancestor with the missing tail
 * re-joined — so a root that does not exist yet is judged by where it WOULD land, links in its
 * ancestry resolved. Errors other than "does not exist" propagate (an unreadable ancestor is not
 * judged lexically).
 */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.push(basename(cur));
    cur = parent;
  }
}

/** Whether `path` is `dir` or lies beneath it (both already canonical). */
function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

export interface RootFenceOptions {
  /** The daemon state home (`crewStateHome()`) the root must lie inside. */
  stateHome: string;
  /** The user's home (tests inject a fake one). */
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Refuse a skills root that (1) is a symlink itself, (2) canonically lies outside the state home, or
 * (3) canonically lies inside a user CLI directory. Answers the canonical root. Throws
 * `SkillsRootUnfencedError`. A root that does not exist yet is judged by its would-be canonical path.
 */
export function assertSkillsRootFenced(root: string, opts: RootFenceOptions): { root: string; canonical: string } {
  let st;
  try {
    st = lstatSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') throw err;
  }
  if (st?.isSymbolicLink() === true) {
    throw new SkillsRootUnfencedError(root, 'a symlink stands in for the skills root (the store never follows links, the root included)');
  }
  const canonical = canonicalPath(root);
  const stateHome = canonicalPath(opts.stateHome);
  if (!isInside(canonical, stateHome) || canonical === stateHome) {
    throw new SkillsRootUnfencedError(root, `its canonical path ${canonical} is not inside the daemon state home ${stateHome}`);
  }
  for (const dir of userCliDirs(opts.home, opts.env)) {
    const canonicalDir = canonicalPath(dir);
    if (isInside(canonical, canonicalDir)) {
      throw new SkillsRootUnfencedError(root, `its canonical path ${canonical} lies inside the user CLI directory ${canonicalDir}`);
    }
  }
  return { root, canonical };
}
