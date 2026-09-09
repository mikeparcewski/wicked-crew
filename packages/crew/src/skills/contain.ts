/**
 * Skill-scoped containment for the `/skills` file manager (design v3 §API).
 *
 * NOT `api/open-path.ts` `isInsideRoot`: that helper FOLLOWS symlinks (a `<root>/link-to-outside`
 * resolves to its real target, which is the right question for "may I open this file the run
 * produced" and the wrong one for "may I write here") and accepts the root itself. Writes into the
 * effective plugin root need the stricter rule:
 *
 *   1. the URL wildcard arrives DECODED EXACTLY ONCE — by Fastify (find-my-way decodes every `%xx`,
 *      `%2F` included, before routing; a malformed escape is Fastify's own 400) — and the store
 *      never decodes again (codex round 5 on #480: a second decode turned `100%25.txt` into a
 *      refused `100%.txt` and the literal filename `a%252Fb.txt` into the path `a/b.txt`);
 *   2. normalize into segments — refuse empty, `.`, `..`, backslashes, NUL, absolute / drive-prefixed;
 *   3. lstat-walk EVERY existing component and refuse a symlink anywhere on the way (the plugin
 *      tree carries none; one appearing is either an attack or an accident, and either way the
 *      write must not follow it);
 *   4. the root itself is not a file — an empty remainder is refused.
 *
 * Atomic tmp+rename writes are the store's job (`tree.ts` `writeFileAtomic`); this module only
 * decides WHERE.
 */

import { assertNoSymlinkComponents, assertSafeRelSegments, SymlinkComponentError, unsafeSegmentReason, UnsafePathSegmentError } from './tree.js';

/** `reserved`: a name the store itself owns at that level (`snapshot.json`, `manifest.json`, `current`, `views/`, `.venv`). */
export type SkillPathReason = 'invalid' | 'symlink' | 'nested-skill' | 'root' | 'reserved';

/** A skill-relative path the store refuses. `reason` names why; the route answers 400 with `message`. */
export class SkillPathError extends Error {
  constructor(readonly reason: SkillPathReason, message: string) {
    super(message);
    this.name = 'SkillPathError';
  }
}

/**
 * Validate a POSIX-relative path into its segments. Rejects: empty, NUL, backslashes (paths are
 * POSIX; a backslash is never a separator here and never a filename), absolute / drive-prefixed,
 * and `.` / `..` / empty segments.
 */
export function validateRelSegments(rel: string): string[] {
  // The ONE segment rule (tree.ts `assertSafeRelSegments`), spoken in the file manager's error type.
  try {
    return assertSafeRelSegments(rel);
  } catch (err) {
    if (err instanceof UnsafePathSegmentError) throw new SkillPathError('invalid', `invalid path ${JSON.stringify(rel)}: ${err.reason}`);
    throw err;
  }
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
    const why = unsafeSegmentReason(seg);
    if (why !== null) {
      throw new SkillPathError('invalid', `unsafe path segment ${JSON.stringify(seg)} (${why}) — the joined path must stay inside the skills root`);
    }
  }
  try {
    return assertNoSymlinkComponents(root, segments);
  } catch (err) {
    if (err instanceof SymlinkComponentError) throw new SkillPathError('symlink', err.message);
    if (err instanceof UnsafePathSegmentError) throw new SkillPathError('invalid', err.message);
    throw err;
  }
}
