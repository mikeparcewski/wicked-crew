/**
 * Skill-scoped containment for the `/skills` file manager (design v3 §API).
 *
 * NOT `api/open-path.ts` `isInsideRoot`: that helper FOLLOWS symlinks (a `<root>/link-to-outside`
 * resolves to its real target, which is the right question for "may I open this file the run
 * produced" and the wrong one for "may I write here") and accepts the root itself. Writes into the
 * effective plugin root need the stricter rule:
 *
 *   1. decode the URL path exactly once (a malformed escape is a bad path, not a 500);
 *   2. normalize into segments — refuse empty, `.`, `..`, backslashes, NUL, absolute / drive-prefixed;
 *   3. lstat-walk EVERY existing component and refuse a symlink anywhere on the way (the plugin
 *      tree carries none; one appearing is either an attack or an accident, and either way the
 *      write must not follow it);
 *   4. the root itself is not a file — an empty remainder is refused.
 *
 * Atomic tmp+rename writes are the store's job (`tree.ts` `writeFileAtomic`); this module only
 * decides WHERE.
 */

import { assertNoSymlinkComponents, SymlinkComponentError } from './tree.js';

/** `reserved`: a name the store itself owns at that level (`snapshot.json`, `manifest.json`, `current`, `views/`, `.venv`). */
export type SkillPathReason = 'invalid' | 'symlink' | 'nested-skill' | 'root' | 'reserved';

/** A skill-relative path the store refuses. `reason` names why; the route answers 400 with `message`. */
export class SkillPathError extends Error {
  constructor(readonly reason: SkillPathReason, message: string) {
    super(message);
    this.name = 'SkillPathError';
  }
}

/** Decode a URL wildcard once; a malformed escape (`%E0%A4%A`) is `invalid`. */
export function decodePathParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new SkillPathError('invalid', `invalid path ${JSON.stringify(raw)}: malformed percent-escape`);
  }
}

/**
 * Validate a POSIX-relative path into its segments. Rejects: empty, NUL, backslashes (paths are
 * POSIX; a backslash is never a separator here and never a filename), absolute / drive-prefixed,
 * and `.` / `..` / empty segments.
 */
export function validateRelSegments(rel: string): string[] {
  const bad = (why: string): never => {
    throw new SkillPathError('invalid', `invalid path ${JSON.stringify(rel)}: ${why}`);
  };
  if (rel === '') bad('empty — the root itself is not a file');
  if (rel.includes('\0')) bad('NUL byte');
  if (rel.includes('\\')) bad('backslash — paths are POSIX');
  if (rel.startsWith('/')) bad('absolute');
  if (/^[A-Za-z]:/.test(rel)) bad('drive prefix');
  const segments = rel.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') bad(`segment ${JSON.stringify(seg)}`);
  }
  return segments;
}

/**
 * `join(root, ...segments)` after an lstat walk refusing any symlink component — the walk itself
 * is `tree.ts` `assertNoSymlinkComponents` (the one no-follow rule every store path goes
 * through); this wrapper only speaks the file manager's error type. `root` is the SKILLS root:
 * the store passes `effective/<skill dir>/<path>` (or `baseline/<hash>/…`) as segments, so the
 * skill directory itself is a walked component — replacing it with a link is refused, not
 * followed. A component that does not exist yet ends the walk (a not-yet-written leaf, or its new
 * parent dirs) — the write creates them. Any filesystem error other than ENOENT propagates: an
 * unreadable component is not judged lexically.
 */
export function containedPath(root: string, segments: ReadonlyArray<string>): string {
  if (segments.length === 0) throw new SkillPathError('root', 'the root itself is not a file');
  // Re-check EVERY component lexically, independent of where it came from (codex round 3): a
  // manifest-sourced skill `dir` or file record is not trusted to be a safe segment — a `..`,
  // an absolute/drive-prefixed piece, a separator or a NUL would join OUT of the root before the
  // symlink walk ever ran. The request's own path is validated by `validateRelSegments`; this is
  // the same rule applied to the FINAL joined path so the trusted-`dir` half cannot escape either.
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new SkillPathError('invalid', `unsafe path segment ${JSON.stringify(seg)} — the joined path must stay inside the skills root`);
    }
    if (seg.includes('/') || seg.includes('\\') || seg.includes('\0') || /^[A-Za-z]:/.test(seg)) {
      throw new SkillPathError('invalid', `unsafe path segment ${JSON.stringify(seg)} — a component may not carry a separator, a drive prefix, or a NUL`);
    }
  }
  try {
    return assertNoSymlinkComponents(root, segments);
  } catch (err) {
    if (err instanceof SymlinkComponentError) throw new SkillPathError('symlink', err.message);
    throw err;
  }
}
