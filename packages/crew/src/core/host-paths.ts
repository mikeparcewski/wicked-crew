/**
 * Host-path rewriting (crew#618, crew#634 R5) — moved here from `api/chat-transcripts.ts` so the
 * deliver composer (`core/deliver-text.ts`, crew#886) uses the SAME rewrite on what leaves the
 * machine as the chat store applies to seat replies. Pure string work plus `realpath` lookups; no
 * crew imports (a core module importing the chat store closed an import cycle back into deliver).
 */

import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

/** One repo root → name mapping entry used for path rewriting (crew#618). */
export interface ChatRepoRoot {
  /** Resolved absolute path of the repo root (from `EngineChatScope.readRoots`). */
  absRoot: string;
  /** The repo's display name, used as the path prefix in rewritten citations. */
  name: string;
}

/**
 * Rewrite absolute host paths in seat reply text to repo-relative form (crew#618).
 *
 * `/srv/repos/alpha/src/foo.ts` → `alpha/src/foo.ts` when `alpha`'s root is `/srv/repos/alpha`.
 * Longest roots are matched first so a path under a more-specific root (a NESTED root,
 * `/r/alpha/sub` under `/r/alpha`) is never truncated by a parent root. crew#634 R5: a BARE root
 * reference — the root itself, with no trailing separator, ending the text or followed by
 * whitespace / closing punctuation — becomes the repo name too (`/srv/repos/alpha.` → `alpha.`);
 * a longer sibling (`/srv/repos/alpha-extra`) is never touched. Pure string work.
 */
export function rewriteHostPaths(text: string, roots: ReadonlyArray<ChatRepoRoot>): string {
  if (roots.length === 0) return text;
  const sorted = [...roots].sort((a, b) => b.absRoot.length - a.absRoot.length);
  let result = text;
  for (const { absRoot, name } of sorted) {
    // The NATIVE separator: on Windows `C:\\Users\\a` + `/` matched neither `C:\\Users\\a\\x` nor
    // (after the swap below) anything new; `sep` keeps POSIX byte-identical (codex on crew#887).
    const prefix = absRoot.endsWith(sep) || absRoot.endsWith('/') ? absRoot : `${absRoot}${sep}`;
    // Replace all occurrences of the absolute prefix with the repo-name prefix.
    result = result.split(prefix).join(`${name}/`);
    // Also handle the path spelling with the other separator (LLMs on Windows may use '/').
    if (sep === '\\') {
      const fwdPrefix = prefix.replace(/\\/g, '/');
      result = result.split(fwdPrefix).join(`${name}/`);
    }
    result = rewriteBareRoot(result, prefix.slice(0, -1), name);
    if (sep === '\\') result = rewriteBareRoot(result, prefix.slice(0, -1).replace(/\\/g, '/'), name);
  }
  return result;
}

/** crew#634 R5: `root` alone (no separator after it) at a boundary → `name`. */
function rewriteBareRoot(text: string, root: string, name: string): string {
  if (root === '' || !text.includes(root)) return text;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Not preceded by a path character (so `/x/srv/repos/alpha` is not a match for `/srv/repos/alpha`);
  // followed by the end or whitespace, optionally after a run of closing punctuation. Punctuation is
  // legal in a path, so it only ends the root when the path ends right after it — `alpha:beta/x`
  // and `alpha,backup` are other paths and stay untouched (codex on this PR).
  const bare = new RegExp(`(?<![\\w./\\\\-])${escaped}(?=[)\\]}>'"\`,;:!?.]*(?:$|\\s))`, 'g');
  return text.replace(bare, name);
}

/**
 * crew#634 R5: every spelling a seat may cite a root by — the resolved path, its `realpath` (a
 * symlinked checkout), and the macOS `/private` twin of `/var`, `/tmp`, `/etc` either way round.
 * A twin is registered only when it RESOLVES to the same real directory (so a Linux `/private/tmp`
 * that is some other path is never rewritten — codex on this PR). Each alias maps to the same repo
 * name; an unreadable root keeps the one spelling it was given.
 */
export function withRootAliases(roots: ReadonlyArray<ChatRepoRoot>): ChatRepoRoot[] {
  const out: ChatRepoRoot[] = [];
  const seen = new Set<string>();
  const add = (absRoot: string, name: string): void => {
    if (absRoot === '' || seen.has(absRoot)) return;
    seen.add(absRoot);
    out.push({ absRoot, name });
  };
  const realOf = (p: string): string | null => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  for (const { absRoot, name } of roots) {
    add(absRoot, name);
    const real = realOf(absRoot);
    if (real === null) continue;
    add(real, name);
    for (const p of [absRoot, real]) {
      const twin = /^\/private\/(?:var|tmp|etc)(?:\/|$)/.test(p)
        ? p.slice('/private'.length)
        : /^\/(?:var|tmp|etc)(?:\/|$)/.test(p)
          ? `/private${p}`
          : null;
      if (twin !== null && realOf(twin) === real) add(twin, name);
    }
  }
  return out;
}

