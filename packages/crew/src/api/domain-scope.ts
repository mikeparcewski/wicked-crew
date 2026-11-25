/**
 * (J6 K1) The scope card of a `domain-extraction` launch preview: garden's `scripts/domain/scope.py` over the
 * repository's checkout and its estate store (no model call), mapped to the {@link DomainScopeCard} the launch form
 * shows. The run's own `domain-run` step re-derives the same scope from the same script and refuses when its hash no
 * longer matches the one Start carried, so the card and the run never disagree silently.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DomainScopeCard } from 'wicked-crew-api-types';

import { gardenLauncher, unmarkedEnv } from '../learn/scheduler.js';

/** Runs `cmd args` and answers its exit code and stderr (tests inject it). */
export type ScopeExec = (
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number | null; stderr: string }>;

const execScope: ScopeExec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null;
      resolve({ code, stderr: String(stderr ?? '') + (err !== null && code === null ? String(err.message) : '') });
    });
  });

/** CardDemo's card takes under 5 s and crew's about 31 s (DES-j6-build S2); past this the preview says so. */
export const SCOPE_TIMEOUT_MS = 75_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** What a phrase matched: the code names (TS defs, or the COBOL program), else its files. */
function matchedOf(v: unknown): string[] {
  if (Array.isArray(v)) return strs(v);
  if (!isObj(v)) return [];
  const defs = strs(v['defs']);
  return defs.length > 0 ? defs : strs(v['files']);
}

/** scope.py's output (`build_scope`) as the card, or `null` when it is not one (no 64-hex `scope_hash`). */
export function scopeCardOf(raw: unknown): DomainScopeCard | null {
  if (!isObj(raw)) return null;
  const scopeHash = raw['scope_hash'];
  if (typeof scopeHash !== 'string' || !/^[0-9a-f]{64}$/u.test(scopeHash)) return null;
  const phrases: Record<string, string[]> = {};
  if (isObj(raw['phrases'])) for (const [p, v] of Object.entries(raw['phrases'])) phrases[p] = matchedOf(v);
  const n = raw['n_targets'];
  const more = raw['reached_more'];
  return {
    scopeHash,
    phrases,
    unmatchedPhrases: strs(raw['unmatched_phrases']),
    files: strs(raw['target_files']),
    targets: typeof n === 'number' && Number.isSafeInteger(n) ? n : 0,
    reachedFrom: strs(raw['reached_shown']),
    reachedMore: typeof more === 'number' && Number.isSafeInteger(more) ? more : 0,
    questions: strs(raw['questions']),
  };
}

/** The tail of a script's stderr worth showing a person: its last non-empty line, bounded. */
function lastLine(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const last = lines[lines.length - 1] ?? '';
  return last.length > 300 ? `${last.slice(0, 300)}…` : last;
}

/**
 * The card for `scope` over the checkout at `root` and the estate store `db`, or why there is none. Runs garden
 * through its launcher under `gardenRoot` (`$WICKED_GARDEN_ROOT`, else the live plugin), in a scratch directory it
 * removes after.
 */
export async function scopeCardFor(opts: {
  root: string;
  db: string;
  gardenRoot: string | null;
  scope: { intent: string; phrases?: string[] | undefined };
  exec?: ScopeExec;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ card: DomainScopeCard } | { error: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'wicked-domain-scope-'));
  try {
    const input = join(dir, 'scope-in.json');
    const out = join(dir, 'scope.json');
    await writeFile(input, JSON.stringify({ intent: opts.scope.intent, ...(opts.scope.phrases !== undefined ? { phrases: opts.scope.phrases } : {}) }));
    const timeoutMs = opts.timeoutMs ?? SCOPE_TIMEOUT_MS;
    const r = await (opts.exec ?? execScope)(
      gardenLauncher(opts.gardenRoot),
      ['run', 'scripts/domain/scope.py', '--root', opts.root, '--db', opts.db, '--scope', input, '--out', out],
      { env: unmarkedEnv(opts.env ?? process.env, opts.gardenRoot), timeoutMs },
    );
    if (r.code !== 0) {
      const why = lastLine(r.stderr);
      return { error: r.code === null ? `the scope did not finish in ${Math.round(timeoutMs / 1000)} s${why !== '' ? ` (${why})` : ''}` : `the scope failed${why !== '' ? `: ${why}` : ''}` };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(out, 'utf8'));
    } catch {
      return { error: 'the scope wrote no card' };
    }
    const card = scopeCardOf(raw);
    return card !== null ? { card } : { error: 'the scope wrote a card this daemon cannot read' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
