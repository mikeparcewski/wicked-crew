/**
 * (J6 K1) The scope card of a `domain-extraction` launch preview: garden's `scripts/domain/scope.py` over the
 * repository's checkout and its estate store (no model call), mapped to the {@link DomainScopeCard} the launch form
 * shows. The run's own `domain-run` step re-derives the same scope from the same script and refuses when its hash no
 * longer matches the one Start carried, so the card and the run never disagree silently.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DomainScopeCard } from 'wicked-crew-api-types';

import { childEnvWithBootEstateDb } from '../core/governance-store.js';
import { gardenLauncher, unmarkedEnv } from '../learn/scheduler.js';

/** How the scope's process ended: its exit code, killed at the time limit, or never started. */
export type ScopeExit =
  | { outcome: 'exit'; code: number; stderr: string }
  | { outcome: 'timeout'; stderr: string }
  | { outcome: 'spawn'; error: string };

/** Runs `cmd args` to its end (tests inject it). */
export type ScopeExec = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ScopeExit>;

const STDERR_CAP = 64 * 1024;

/**
 * Runs the launcher in its own process group, so the time limit ends the whole tree (the launcher runs Python, maybe
 * through uv, as children of its own); resolves once every process holding its output has closed.
 */
export const execScope: ScopeExec = (cmd, args, opts) =>
  new Promise((resolve) => {
    const group = process.platform !== 'win32';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (r: ScopeExit): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // childEnvWithBootEstateDb: no daemon governance store and no raw credential reach garden (crew#495, crew#1843).
    const child = spawn(cmd, args, { env: childEnvWithBootEstateDb(opts.env), stdio: ['ignore', 'ignore', 'pipe'], detached: group });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else if (child.pid !== undefined) {
          // Windows has no process groups: taskkill ends the tree, and the limit answers when it is done, whether or
          // not a descendant still holds stderr.
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { env: childEnvWithBootEstateDb(process.env), stdio: 'ignore' }).on('close', () => done({ outcome: 'timeout', stderr }));
        }
      } catch {
        // already gone
      }
    }, opts.timeoutMs);
    // The last 64 KiB: the failure line a script prints last is the one the preview shows.
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
    });
    child.on('error', (err) => done({ outcome: 'spawn', error: err.message }));
    child.on('close', (code) => done(timedOut ? { outcome: 'timeout', stderr } : { outcome: 'exit', code: code ?? 1, stderr }));
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
  // Object.fromEntries defines each phrase as an own key (a phrase "__proto__" included).
  const phrases: Record<string, string[]> = Object.fromEntries(
    isObj(raw['phrases']) ? Object.entries(raw['phrases']).map(([p, v]) => [p, matchedOf(v)]) : [],
  );
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

/** The largest scope file the preview reads (it holds every target; the card needs a summary). */
export const SCOPE_FILE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The card for `scope` over the checkout at `root` and the estate store `db`, or why there is none: never throws.
 * Runs garden through its launcher under `gardenRoot` (`$WICKED_GARDEN_ROOT`, else the live plugin), in a scratch
 * directory it removes after the whole process tree has ended.
 */
export async function scopeCardFor(opts: {
  root: string;
  db: string;
  gardenRoot: string | null;
  scope: { intent: string; phrases?: string[] | undefined };
  exec?: ScopeExec;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxCardBytes?: number;
}): Promise<{ card: DomainScopeCard } | { error: string }> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), 'wicked-domain-scope-'));
  } catch (err) {
    return { error: `the scope could not start: ${(err as Error).message}` };
  }
  try {
    return await runScope(dir, opts);
  } catch (err) {
    return { error: `the scope could not be read: ${(err as Error).message}` };
  } finally {
    // A scratch directory left behind does not unmake the card the person asked for; the OS temp dir clears it.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runScope(dir: string, opts: Parameters<typeof scopeCardFor>[0]): Promise<{ card: DomainScopeCard } | { error: string }> {
  const input = join(dir, 'scope-in.json');
  const out = join(dir, 'scope.json');
  await writeFile(input, JSON.stringify({ intent: opts.scope.intent, ...(opts.scope.phrases !== undefined ? { phrases: opts.scope.phrases } : {}) }));
  const timeoutMs = opts.timeoutMs ?? SCOPE_TIMEOUT_MS;
  const r = await (opts.exec ?? execScope)(
    gardenLauncher(opts.gardenRoot),
    ['run', 'scripts/domain/scope.py', '--root', opts.root, '--db', opts.db, '--scope', input, '--out', out],
    { env: unmarkedEnv(opts.env ?? process.env, opts.gardenRoot), timeoutMs },
  );
  if (r.outcome === 'spawn') return { error: `the scope could not start garden: ${r.error}` };
  const why = lastLine(r.stderr);
  if (r.outcome === 'timeout') return { error: `the scope did not finish in ${Math.round(timeoutMs / 1000)} s${why !== '' ? ` (${why})` : ''}` };
  if (r.code !== 0) return { error: `the scope failed${why !== '' ? `: ${why}` : ''}` };
  let size: number;
  try {
    size = (await stat(out)).size;
  } catch {
    return { error: 'the scope wrote no card' };
  }
  if (size > (opts.maxCardBytes ?? SCOPE_FILE_MAX_BYTES)) {
    return { error: `the scope is too large to show (${Math.round(size / 2 ** 20)} MB); narrow it to fewer files or phrases` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(out, 'utf8'));
  } catch {
    return { error: 'the scope wrote a card that is not JSON' };
  }
  const card = scopeCardOf(raw);
  return card !== null ? { card } : { error: 'the scope wrote a card this daemon cannot read' };
}
