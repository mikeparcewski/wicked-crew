/**
 * The staged check (DES-APPS-001 §6.2 "Checks are staged by what changed", §9.2 `check`), and the lock
 * crew writes when a tree passes it.
 *
 *  - files: the tree holds `apps.json`, `apps.lock.json` and `queries/<id>.<ext>` only, regular files,
 *    each query's text present and within its limit (no symlink, submodule or other path);
 *  - spec: the schema and the consistency check (`spec.ts`);
 *  - data: the read policy and the per-kind source check, for the queries and actions that changed
 *    (`level: 'auto'`) or for all of them (`level: 'full'`: an undo, redo or restore, against today's
 *    sources). That stage is the SOURCE STAGE seam ({@link AppSourceStage}): crew calls the sources
 *    slice's check when the daemon has one. Without it, a tree whose data stage must run does not land
 *    (`source_check_unavailable`): a receipt never covers a query or action nobody checked.
 *
 * The lock pins what each query and action uses. crew computes every text and declaration hash itself;
 * the source stage answers only what it alone knows (each source's descriptor, each contract hash).
 */

import { createHash } from 'node:crypto';

import type { AppAction, AppCheckFinding, AppCheckSummary, AppLock, AppQuery, AppQueryKind, AppSpec } from '../core/types.js';
import { canonicalJson } from '../mcp/classify.js';
import type { AppGit, TreeEntry } from './git.js';
import { APP_SPEC_MAX_BYTES, checkSpec, readSpec } from './spec.js';

export const SPEC_PATH = 'apps.json';
export const LOCK_PATH = 'apps.lock.json';
export const QUERIES_DIR = 'queries';
/** A query's text, at most. */
export const QUERY_TEXT_MAX_BYTES = 64 * 1024;
const LOCK_MAX_BYTES = 1024 * 1024;

export const QUERY_EXT: Record<AppQueryKind, string> = { sql: 'sql', graphql: 'graphql', rest: 'json', mcp: 'json', crew: 'json' };

export const EMPTY_LOCK: AppLock = { schema: 'wicked.apps.lock/v1', sources: {}, queries: {}, actions: {}, uploads: {} };

/** What the source stage is asked to check: the whole candidate, and which queries and actions to check. */
export interface AppSourceStageInput {
  app: string;
  spec: AppSpec;
  queryText: Record<string, string>;
  queries: string[];
  actions: string[];
}

/** The source stage's answer: findings, or what the lock needs for every query and action it was asked about. */
export interface AppSourceStageResult {
  findings: AppCheckFinding[];
  /** Every source a checked query or action uses. */
  sources: AppLock['sources'];
  /** Query id → its contract hash (DES §4: the tables, columns and types it uses). */
  queries: Record<string, string>;
  /** Action id → its contract hash (for a row write, with the table's safety fingerprint). */
  actions: Record<string, string>;
  /** Upload snapshots the checked queries read, by source name. */
  uploads: AppLock['uploads'];
}

/**
 * The read policy (§5.3) and the per-kind source check (§9.2 step 3), from the sources slice. Never
 * executes a read or a write.
 */
export interface AppSourceStage {
  check(input: AppSourceStageInput): Promise<AppSourceStageResult>;
}

/** An app tree's content as crew reads it. */
export interface AppFiles {
  spec: AppSpec;
  queryText: Record<string, string>;
  lock: AppLock;
}

export type CheckOutcome =
  | { ok: true; lock: AppLock; summary: AppCheckSummary }
  | { ok: false; code: 'check_failed' | 'source_check_unavailable'; findings: AppCheckFinding[] };

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

export const textHash = (text: string): string => sha256(Buffer.from(text, 'utf8'));
export const actionHash = (action: AppAction): string => sha256(canonicalJson(action));

function fileFinding(code: string, path: string, message: string): AppCheckFinding {
  return { stage: 'files', code, path, message };
}

/** The text-level rules of one query's file: size, UTF-8, and a JSON object for the `.json` kinds. */
function checkQueryText(q: AppQuery, text: string | undefined, path: string): AppCheckFinding[] {
  if (text === undefined) return [fileFinding('missing_query_text', path, `query ${q.id} has no ${path}`)];
  if (Buffer.byteLength(text, 'utf8') > QUERY_TEXT_MAX_BYTES) return [fileFinding('too_large', path, `${path} is over ${QUERY_TEXT_MAX_BYTES} bytes`)];
  if (text.trim() === '') return [fileFinding('empty_query_text', path, `${path} is empty`)];
  if (QUERY_EXT[q.kind] === 'json') {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return [fileFinding('not_json', path, `${path} is not JSON`)];
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return [fileFinding('not_json', path, `${path} is not a JSON object`)];
  }
  return [];
}

export const queryPath = (q: Pick<AppQuery, 'id' | 'kind'>): string => `${QUERIES_DIR}/${q.id}.${QUERY_EXT[q.kind]}`;

/**
 * Read an app tree from the repo's objects, with the files stage. `lock` is `null` for a candidate an
 * agent offers (crew writes its lock); a tree crew landed always holds one.
 */
export async function readAppTree(
  git: AppGit,
  treeish: string,
): Promise<{ ok: true; files: Omit<AppFiles, 'lock'> & { lock: AppLock | null } } | { ok: false; findings: AppCheckFinding[] }> {
  let entries: TreeEntry[];
  try {
    entries = await git.lsTree(treeish);
  } catch (err) {
    return { ok: false, findings: [fileFinding('unreadable', '', err instanceof Error ? err.message : String(err))] };
  }
  const findings: AppCheckFinding[] = [];
  const blobs = new Map<string, TreeEntry>();
  for (const e of entries) {
    if (e.type === 'tree' && e.path === QUERIES_DIR) continue;
    const allowed = e.path === SPEC_PATH || e.path === LOCK_PATH || /^queries\/[a-z][a-z0-9_]{0,63}\.(sql|graphql|json)$/.test(e.path);
    if (!allowed) {
      findings.push(fileFinding('unexpected_path', e.path, `${e.path} is outside apps.json, apps.lock.json and queries/`));
      continue;
    }
    if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) {
      findings.push(fileFinding('not_a_file', e.path, `${e.path} is not a regular file (mode ${e.mode})`));
      continue;
    }
    blobs.set(e.path, e);
  }
  const specEntry = blobs.get(SPEC_PATH);
  if (specEntry === undefined) findings.push(fileFinding('missing_spec', SPEC_PATH, 'the tree has no apps.json'));
  if (findings.length > 0 || specEntry === undefined) return { ok: false, findings };
  if ((specEntry.size ?? 0) > APP_SPEC_MAX_BYTES) return { ok: false, findings: [fileFinding('too_large', SPEC_PATH, `apps.json is over ${APP_SPEC_MAX_BYTES} bytes`)] };
  const read = readSpec(await git.readBlob(specEntry.sha));
  if (read.spec === null) return { ok: false, findings: read.findings };
  const spec = read.spec;
  const queryText: Record<string, string> = {};
  const declared = new Set<string>();
  for (const q of spec.queries) {
    const path = queryPath(q);
    declared.add(path);
    const e = blobs.get(path);
    if (e === undefined) {
      findings.push(...checkQueryText(q, undefined, path));
      continue;
    }
    if ((e.size ?? 0) > QUERY_TEXT_MAX_BYTES) {
      findings.push(fileFinding('too_large', path, `${path} is over ${QUERY_TEXT_MAX_BYTES} bytes`));
      continue;
    }
    const text = (await git.readBlob(e.sha)).toString('utf8');
    const f = checkQueryText(q, text, path);
    if (f.length > 0) findings.push(...f);
    else queryText[q.id] = text;
  }
  for (const path of blobs.keys()) {
    if (path.startsWith(`${QUERIES_DIR}/`) && !declared.has(path)) findings.push(fileFinding('undeclared_query_text', path, `${path} is no declared query's text`));
  }
  let lock: AppLock | null = null;
  const lockEntry = blobs.get(LOCK_PATH);
  if (lockEntry !== undefined && (lockEntry.size ?? 0) <= LOCK_MAX_BYTES) {
    try {
      lock = JSON.parse((await git.readBlob(lockEntry.sha)).toString('utf8')) as AppLock;
    } catch {
      lock = null;
    }
  }
  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, files: { spec, queryText, lock } };
}

/** The candidate's own file findings: every declared query has its text, within its limits. */
export function checkCandidateFiles(spec: AppSpec, queryText: Record<string, string>): AppCheckFinding[] {
  const out: AppCheckFinding[] = [];
  for (const q of spec.queries) out.push(...checkQueryText(q, queryText[q.id], queryPath(q)));
  return out;
}

/** Queries and actions whose data stage must run: new, changed in declaration or text, or not in the base lock. */
export function changedData(spec: AppSpec, queryText: Record<string, string>, base: AppFiles | null): { queries: string[]; actions: string[] } {
  const baseQueries = new Map((base?.spec.queries ?? []).map((q) => [q.id, q] as const));
  const baseActions = new Map((base?.spec.actions ?? []).map((a) => [a.id, a] as const));
  const queries = spec.queries
    .filter((q) => {
      const b = baseQueries.get(q.id);
      const locked = base?.lock.queries[q.id];
      return (
        b === undefined ||
        locked === undefined ||
        canonicalJson(b) !== canonicalJson(q) ||
        locked.source !== q.source ||
        locked.textHash !== textHash(queryText[q.id] ?? '')
      );
    })
    .map((q) => q.id);
  const actions = spec.actions
    .filter((a) => {
      const b = baseActions.get(a.id);
      const locked = base?.lock.actions[a.id];
      return b === undefined || locked === undefined || locked.actionHash !== actionHash(a) || locked.source !== a.source;
    })
    .map((a) => a.id);
  return { queries, actions };
}

/**
 * Run the staged check on a candidate and write its lock. `base` is the version it was made on (its
 * lock is crew's own, from a tree crew landed); `level: 'full'` checks every query and action.
 */
export async function stagedCheck(input: {
  app: string;
  spec: AppSpec;
  queryText: Record<string, string>;
  base: AppFiles | null;
  level: 'auto' | 'full';
  sourceStage: AppSourceStage | null;
}): Promise<CheckOutcome> {
  const { spec, queryText } = input;
  const size = Buffer.byteLength(specBytes(spec), 'utf8');
  if (size > APP_SPEC_MAX_BYTES) return { ok: false, code: 'check_failed', findings: [fileFinding('too_large', SPEC_PATH, `apps.json would be ${size} bytes; the limit is ${APP_SPEC_MAX_BYTES}`)] };
  const findings = [...checkSpec(spec), ...checkCandidateFiles(spec, queryText)];
  if (findings.length > 0) return { ok: false, code: 'check_failed', findings };

  const changed =
    input.level === 'full' || input.base === null
      ? { queries: spec.queries.map((q) => q.id), actions: spec.actions.map((a) => a.id) }
      : changedData(spec, queryText, input.base);
  const level: AppCheckSummary['level'] = input.level === 'full' ? 'full' : changed.queries.length + changed.actions.length > 0 ? 'data' : 'spec';

  let result: AppSourceStageResult | null = null;
  if (changed.queries.length + changed.actions.length > 0) {
    if (input.sourceStage === null) {
      return {
        ok: false,
        code: 'source_check_unavailable',
        findings: [
          {
            stage: 'source',
            code: 'source_check_unavailable',
            path: '$',
            message: `this daemon cannot run the read policy and the source check yet, so a version holding ${[...changed.queries, ...changed.actions].join(', ')} cannot land`,
          },
        ],
      };
    }
    try {
      result = await input.sourceStage.check({ app: input.app, spec, queryText, queries: changed.queries, actions: changed.actions });
    } catch (err) {
      // A check that could not run is a check that did not pass: nothing lands.
      return { ok: false, code: 'check_failed', findings: [{ stage: 'source', code: 'source_check_error', path: '$', message: `the source check could not run: ${err instanceof Error ? err.message : String(err)}` }] };
    }
    if (result.findings.length > 0) return { ok: false, code: 'check_failed', findings: result.findings.slice(0, 50) };
    const sourceOf = new Map<string, string>([...spec.queries.map((q) => [q.id, q.source] as const), ...spec.actions.map((a) => [a.id, a.source] as const)]);
    const missing = [
      ...changed.queries.filter((id) => typeof result!.queries[id] !== 'string'),
      ...changed.actions.filter((id) => typeof result!.actions[id] !== 'string'),
      ...[...changed.queries, ...changed.actions].filter((id) => !Object.hasOwn(result!.sources, sourceOf.get(id)!)),
    ].filter((id, i, all) => all.indexOf(id) === i);
    if (missing.length > 0) {
      return { ok: false, code: 'check_failed', findings: missing.map((id) => ({ stage: 'source', code: 'source_check_incomplete', path: id, message: `the source check answered nothing for ${id}` })) };
    }
  }

  // The lock: checked entries from the stage, the rest carried from the base lock (crew's own).
  const prior = input.base?.lock ?? EMPTY_LOCK;
  const lock: AppLock = { schema: 'wicked.apps.lock/v1', sources: {}, queries: {}, actions: {}, uploads: {} };
  const checkedQ = new Set(changed.queries);
  const checkedA = new Set(changed.actions);
  const usedSources = new Set<string>();
  for (const q of spec.queries) {
    usedSources.add(q.source);
    const contractHash = checkedQ.has(q.id) ? result!.queries[q.id]! : prior.queries[q.id]!.contractHash;
    lock.queries[q.id] = { source: q.source, textHash: textHash(queryText[q.id]!), contractHash };
  }
  for (const a of spec.actions) {
    usedSources.add(a.source);
    const contractHash = checkedA.has(a.id) ? result!.actions[a.id]! : prior.actions[a.id]!.contractHash;
    lock.actions[a.id] = { source: a.source, actionHash: actionHash(a), contractHash };
  }
  for (const name of [...usedSources].sort()) {
    const fresh = result?.sources[name];
    const kept = prior.sources[name];
    if (fresh !== undefined) lock.sources[name] = fresh;
    else if (kept !== undefined) lock.sources[name] = kept;
    const upload = result?.uploads[name] ?? prior.uploads[name];
    if (upload !== undefined) lock.uploads[name] = upload;
  }
  return { ok: true, lock, summary: { level, checked: [...changed.queries, ...changed.actions] } };
}

/** The lock's bytes: keys sorted, so the same lock is the same blob. */
export function lockBytes(lock: AppLock): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(lock)), null, 2)}\n`;
}

/** The spec's bytes as crew writes them. */
export function specBytes(spec: AppSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}
