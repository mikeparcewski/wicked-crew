/**
 * `describes` candidates for a profiled relation (DES-KNOWLEDGE-DATA-001 §10.1): a code entity in a repo's code
 * graph named EXACTLY like the relation (its singular or plural PascalCase name), of a class-like kind. Deterministic
 * and bounded; anything that needs judgment (which rule governs a table, an entity named otherwise) is the garden
 * `data` skill's shapes pass, which proposes through the same queue.
 *
 * Reads each repo's own code graph with the `wicked-estate` CLI (`query <name> --json`), the posture the repo graph
 * routes use. At most {@link CODE_SEARCH_REPOS} repos, {@link CODE_SEARCH_CONCURRENCY} at once, each read bounded,
 * and the whole search bounded: what was not searched in time is named, never silently dropped.
 */

import { existsSync } from 'node:fs';

import { execCapped } from '../../core/exec.js';
import { estateExe } from '../../projects/graph.js';
import type { CodeMatch } from './shapes.js';

export const CODE_SEARCH_REPOS = 8;
export const CODE_SEARCH_CONCURRENCY = 3;
export const CODE_SEARCH_READ_MS = 15_000;
export const CODE_SEARCH_TOTAL_MS = 45_000;
/** The kinds a table's entity can be, spelled without case or separators (the CLI writes `TypeAlias`, the graph `type_alias`). */
export const ENTITY_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface', 'typealias', 'type', 'trait', 'enum', 'record', 'model']);
export const kindWord = (k: string): string => k.toLowerCase().replace(/[^a-z]/g, '');

export interface CodeSearchRepo {
  id: string;
  db: string;
}

export interface CodeSearchResult {
  /** relation key -> matches. */
  matches: Map<string, CodeMatch[]>;
  searched: string[];
  notSearched: string[];
}

/** One exact-name lookup in one repo's graph, within `timeoutMs`: `[{symbol_id, name, kind, file}]`. */
export type NameLookup = (repo: CodeSearchRepo, name: string, timeoutMs: number) => Promise<Array<{ symbol_id: string; name: string; kind: string; file: string }>>;

/** The JSON array in the CLI's stdout: it may print a `STALENESS:` line before it (a graph indexed before new commits). */
export function cliRows(stdout: string): unknown {
  const at = stdout.search(/^\s*\[/m);
  return at < 0 ? [] : JSON.parse(stdout.slice(at));
}

export const cliLookup: NameLookup = async (repo, name, timeoutMs) => {
  const { stdout } = await execCapped(estateExe(), ['query', name, '--json', '--db', repo.db], { timeout: Math.max(1, Math.min(CODE_SEARCH_READ_MS, timeoutMs)), maxBuffer: 4 * 1024 * 1024 });
  const rows = cliRows(stdout);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const x = r as Record<string, unknown>;
    return typeof x['symbol_id'] === 'string' && typeof x['name'] === 'string'
      ? [{ symbol_id: x['symbol_id'], name: x['name'], kind: typeof x['kind'] === 'string' ? x['kind'] : '', file: typeof x['file'] === 'string' ? x['file'] : '' }]
      : [];
  });
};

/** The repos to search: those with a built code graph, by id, at most {@link CODE_SEARCH_REPOS}; the rest are `capped`. */
export function searchableRepos(repos: ReadonlyArray<{ id: string; code_graph_db?: string | null }>, exists: (p: string) => boolean = existsSync): { repos: CodeSearchRepo[]; capped: string[] } {
  const built = repos
    .filter((r) => typeof r.code_graph_db === 'string' && r.code_graph_db !== '' && exists(r.code_graph_db))
    .map((r) => ({ id: r.id, db: r.code_graph_db as string }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { repos: built.slice(0, CODE_SEARCH_REPOS), capped: built.slice(CODE_SEARCH_REPOS).map((r) => r.id) };
}

/**
 * Search every repo for each relation's entity names (module doc). Never throws: a failed read, or one the deadline
 * stopped part-way, is a repo not searched (its matches so far are kept); `capped` repos are reported not searched too.
 */
export async function searchEntities(
  names: ReadonlyMap<string, readonly string[]>,
  target: { repos: readonly CodeSearchRepo[]; capped?: readonly string[] },
  lookup: NameLookup = cliLookup,
  totalMs: number = CODE_SEARCH_TOTAL_MS,
  now: () => number = Date.now,
): Promise<CodeSearchResult> {
  const matches = new Map<string, CodeMatch[]>();
  const searched: string[] = [];
  const notSearched: string[] = [...(target.capped ?? [])];
  const deadline = now() + totalMs;
  const queue = [...target.repos];
  const worker = async (): Promise<void> => {
    for (let repo = queue.shift(); repo !== undefined; repo = queue.shift()) {
      try {
        for (const [key, ns] of names) {
          for (const n of ns) {
            const left = deadline - now();
            if (left <= 0) throw new Error('code search deadline');
            const hits = await lookup(repo, n, left);
            for (const h of hits) {
              if (h.name !== n || !ENTITY_KINDS.has(kindWord(h.kind))) continue;
              const list = matches.get(key) ?? [];
              if (!list.some((m) => m.repo === repo.id && m.symbolId === h.symbol_id)) list.push({ repo: repo.id, symbolId: h.symbol_id, name: h.name, kind: h.kind, file: h.file });
              matches.set(key, list);
            }
          }
        }
        searched.push(repo.id);
      } catch {
        notSearched.push(repo.id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CODE_SEARCH_CONCURRENCY, target.repos.length) }, worker));
  // At most 3 entities per relation, in repo order: a shape names a few, never a crowd.
  for (const [k, v] of matches) matches.set(k, v.sort((a, b) => a.repo.localeCompare(b.repo) || a.symbolId.localeCompare(b.symbolId)).slice(0, 3));
  return { matches, searched: searched.sort(), notSearched: notSearched.sort() };
}
