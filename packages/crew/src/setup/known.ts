/**
 * WHAT STUDIO ALREADY KNOWS (program DES-LEARN §4, first run): the facts the first-run flow shows
 * before it asks anything — the git identity, the languages of the registered repositories, and the
 * repositories found near them that are not registered yet. Read-only and bounded: every git call
 * has a timeout and an output cap, the folder scan is one level deep under a closed list of roots,
 * and a fact that cannot be read is `null` / empty, never a guess.
 */

import { lstat, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { RepoEntry } from 'wicked-crew-api-types';
import { execCapped } from '../core/exec.js';

export interface KnownLanguage {
  name: string;
  files: number;
  /** Share of the counted source files, 0..1. */
  share: number;
}

export interface NearbyRepo {
  name: string;
  path: string;
}

export interface SetupKnown {
  git: { name: string | null; email: string | null } | null;
  languages: KnownLanguage[];
  /** Files counted across the registered repositories (source files only). */
  filesCounted: number;
  nearby: NearbyRepo[];
}

/** Source extensions → language; anything else (docs, config, data) is not counted. */
const LANG: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.fs': 'F#', '.swift': 'Swift', '.m': 'Objective-C',
  '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.cxx': 'C++', '.hpp': 'C++',
  '.scala': 'Scala', '.clj': 'Clojure', '.ex': 'Elixir', '.exs': 'Elixir', '.erl': 'Erlang',
  '.dart': 'Dart', '.lua': 'Lua', '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.ps1': 'PowerShell',
  '.sql': 'SQL', '.tf': 'Terraform', '.vue': 'Vue', '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'CSS',
  '.html': 'HTML', '.r': 'R', '.jl': 'Julia', '.zig': 'Zig', '.hs': 'Haskell', '.ml': 'OCaml',
};

/** At most this many languages are named; the rest is "other". */
export const MAX_LANGUAGES = 6;
/** At most this many nearby repositories are offered. */
export const MAX_NEARBY = 24;
/** The folders a first run looks in, under the home directory (one level deep). */
export const NEARBY_ROOTS = ['code', 'src', 'Projects', 'projects', 'dev', 'git', 'repos', 'workspace', 'work'] as const;

const GIT_TIMEOUT_MS = 5_000;
const LS_FILES_CAP = 16 * 1024 * 1024;

async function gitGlobal(key: string, home: string): Promise<string | null> {
  try {
    // `--global` only (never a repository's local config, even when the home is a checkout), resolved
    // against this home: git finds ~/.gitconfig through HOME, not the working directory.
    const { stdout } = await execCapped('git', ['config', '--global', '--get', key], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    const v = stdout.trim();
    return v === '' ? null : v;
  } catch {
    return null;
  }
}

/** The global git identity (the user's ~/.gitconfig, or GIT_CONFIG_GLOBAL when the environment names one). */
export async function gitIdentity(home: string = homedir()): Promise<SetupKnown['git']> {
  const [name, email] = await Promise.all([gitGlobal('user.name', home), gitGlobal('user.email', home)]);
  return name === null && email === null ? null : { name, email };
}

/** Count tracked source files by language in each repository (`git ls-files`, bounded). */
export async function languagesOf(repos: readonly Pick<RepoEntry, 'root_path'>[]): Promise<{ languages: KnownLanguage[]; files: number }> {
  const counts = new Map<string, number>();
  let total = 0;
  await Promise.all(repos.map(async (r) => {
    let out: string;
    try {
      out = (await execCapped('git', ['ls-files', '-z'], { cwd: r.root_path, timeout: GIT_TIMEOUT_MS, maxBuffer: LS_FILES_CAP, windowsHide: true })).stdout;
    } catch {
      return; // a missing folder or an overfull listing counts nothing, it is not guessed
    }
    for (const f of out.split('\0')) {
      const lang = LANG[extname(f).toLowerCase()];
      if (lang === undefined) continue;
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
      total += 1;
    }
  }));
  const languages = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_LANGUAGES)
    .map(([name, files]) => ({ name, files, share: total === 0 ? 0 : files / total }));
  return { languages, files: total };
}

/** At most this many folder entries are looked at across every root, and the scan stops after this long:
 *  the response cap alone would not bound the work (codex on #1236). */
export const NEARBY_MAX_ENTRIES = 2000;
export const NEARBY_DEADLINE_MS = 1500;

async function canonical(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** A git checkout: `.git` is a directory, or a file (a linked worktree's `gitdir:` pointer). */
async function isCheckout(p: string): Promise<boolean> {
  try {
    const st = await lstat(join(p, '.git'));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/**
 * Git checkouts one level under the closed roots (the home's usual code folders, and the folders the
 * registered repositories sit in), minus the registered ones. Every path is compared CANONICALLY
 * (`realpath`): a root or a child that resolves outside the home, or to the home itself, is skipped, so a
 * symlink can never widen the scan. Hidden folders are skipped; a root that cannot be listed is skipped.
 * Bounded by {@link NEARBY_MAX_ENTRIES} entries and {@link NEARBY_DEADLINE_MS}; sorted by name, at most
 * {@link MAX_NEARBY}.
 */
export async function nearbyRepos(
  registered: readonly Pick<RepoEntry, 'root_path'>[],
  home: string = homedir(),
  now: () => number = Date.now,
): Promise<NearbyRepo[]> {
  const h = await canonical(home);
  if (h === null) return [];
  const inside = (p: string): boolean => p !== h && p.startsWith(h.endsWith(sep) ? h : h + sep);
  const taken = new Set<string>();
  for (const r of registered) taken.add((await canonical(r.root_path)) ?? resolve(r.root_path));
  const roots = new Set<string>();
  for (const r of [...NEARBY_ROOTS.map((d) => join(home, d)), ...registered.map((x) => dirname(resolve(x.root_path)))]) {
    const c = await canonical(r);
    if (c !== null && inside(c)) roots.add(c);
  }
  const found = new Map<string, NearbyRepo>();
  const until = now() + NEARBY_DEADLINE_MS;
  let budget = NEARBY_MAX_ENTRIES;
  for (const root of roots) {
    if (budget <= 0 || now() > until) break;
    let dir: Awaited<ReturnType<typeof opendir>>;
    try {
      dir = await opendir(root);
    } catch {
      continue;
    }
    try {
      for await (const entry of dir) {
        if (budget-- <= 0 || now() > until) break;
        if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
        const p = await canonical(join(root, entry.name));
        if (p === null || !inside(p) || taken.has(p) || found.has(p)) continue;
        if (await isCheckout(p)) found.set(p, { name: basename(p), path: p });
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)).slice(0, MAX_NEARBY);
}

export async function setupKnown(repos: readonly RepoEntry[], home: string = homedir()): Promise<SetupKnown> {
  const [git, langs, nearby] = await Promise.all([gitIdentity(home), languagesOf(repos), nearbyRepos(repos, home)]);
  return { git, languages: langs.languages, filesCounted: langs.files, nearby };
}
