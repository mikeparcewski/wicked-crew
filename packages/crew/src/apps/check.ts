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
import { AppGitError, type AppGit, type TreeEntry } from './git.js';
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

/** Strict UTF-8: malformed bytes are a finding, never silently replaced. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

const QUERY_FILE_RE = /^[a-z][a-z0-9_]{0,63}\.(sql|graphql|json)$/;

/** An own value of a record (a query id such as `constructor` is a name, never an inherited member). */
export const ownText = (r: Record<string, string>, k: string): string | undefined => (Object.hasOwn(r, k) ? r[k] : undefined);

/**
 * Read an app tree from the repo's objects, with the files stage. Every object is verified against its
 * id (git.ts). `lock` is `null` for a candidate an agent offers (crew writes its lock); a tree crew
 * landed always holds one.
 */
export async function readAppTree(
  git: AppGit,
  tree: string,
): Promise<{ ok: true; files: Omit<AppFiles, 'lock'> & { lock: AppLock | null } } | { ok: false; findings: AppCheckFinding[] }> {
  const findings: AppCheckFinding[] = [];
  const blobs = new Map<string, TreeEntry>();
  try {
    const root = await git.readTree(tree);
    for (const e of root) {
      if (e.name === QUERIES_DIR && e.type === 'tree') {
        for (const q of await git.readTree(e.sha)) {
          const path = `${QUERIES_DIR}/${q.name}`;
          if (!QUERY_FILE_RE.test(q.name)) findings.push(fileFinding('unexpected_path', path, `${path} is not a query text file`));
          else if (q.type !== 'blob' || (q.mode !== '100644' && q.mode !== '100755')) findings.push(fileFinding('not_a_file', path, `${path} is not a regular file (mode ${q.mode})`));
          else blobs.set(path, q);
        }
        continue;
      }
      if (e.name !== SPEC_PATH && e.name !== LOCK_PATH) {
        findings.push(fileFinding('unexpected_path', e.name, `${e.name} is outside apps.json, apps.lock.json and queries/`));
        continue;
      }
      if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) {
        findings.push(fileFinding('not_a_file', e.name, `${e.name} is not a regular file (mode ${e.mode})`));
        continue;
      }
      blobs.set(e.name, e);
    }
  } catch (err) {
    return { ok: false, findings: [fileFinding('unreadable', '', err instanceof Error ? err.message : String(err))] };
  }
  const specEntry = blobs.get(SPEC_PATH);
  if (specEntry === undefined) findings.push(fileFinding('missing_spec', SPEC_PATH, 'the tree has no apps.json'));
  if (findings.length > 0 || specEntry === undefined) return { ok: false, findings };
  /** A blob within `cap` bytes, or a finding. */
  const read = async (path: string, sha: string, cap: number): Promise<Buffer | AppCheckFinding> => {
    try {
      return await git.readBlob(sha, cap);
    } catch (err) {
      if (err instanceof AppGitError && err.code === 'too_large') return fileFinding('too_large', path, `${path} is over ${cap} bytes`);
      return fileFinding('unreadable', path, err instanceof Error ? err.message : String(err));
    }
  };
  const specBlob = await read(SPEC_PATH, specEntry.sha, APP_SPEC_MAX_BYTES);
  if (!Buffer.isBuffer(specBlob)) return { ok: false, findings: [specBlob] };
  const parsed = readSpec(specBlob);
  if (parsed.spec === null) return { ok: false, findings: parsed.findings };
  const spec = parsed.spec;
  const queryText: Record<string, string> = Object.create(null) as Record<string, string>;
  const declared = new Set<string>();
  for (const q of spec.queries) {
    const path = queryPath(q);
    declared.add(path);
    const e = blobs.get(path);
    if (e === undefined) {
      findings.push(...checkQueryText(q, undefined, path));
      continue;
    }
    const bytes = await read(path, e.sha, QUERY_TEXT_MAX_BYTES);
    if (!Buffer.isBuffer(bytes)) {
      findings.push(bytes);
      continue;
    }
    const text = decodeUtf8(bytes);
    if (text === null) {
      findings.push(fileFinding('not_utf8', path, `${path} is not UTF-8`));
      continue;
    }
    const f = checkQueryText(q, text, path);
    if (f.length > 0) findings.push(...f);
    else queryText[q.id] = text;
  }
  for (const path of blobs.keys()) {
    if (path.startsWith(`${QUERIES_DIR}/`) && !declared.has(path)) findings.push(fileFinding('undeclared_query_text', path, `${path} is no declared query's text`));
  }
  let lock: AppLock | null = null;
  const lockEntry = blobs.get(LOCK_PATH);
  if (lockEntry !== undefined) {
    const bytes = await read(LOCK_PATH, lockEntry.sha, LOCK_MAX_BYTES);
    if (Buffer.isBuffer(bytes)) {
      try {
        lock = JSON.parse(bytes.toString('utf8')) as AppLock;
      } catch {
        lock = null;
      }
    }
  }
  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, files: { spec, queryText, lock } };
}

/** The candidate's own file findings: every declared query has its text, within its limits. */
export function checkCandidateFiles(spec: AppSpec, queryText: Record<string, string>): AppCheckFinding[] {
  const out: AppCheckFinding[] = [];
  for (const q of spec.queries) out.push(...checkQueryText(q, ownText(queryText, q.id), queryPath(q)));
  return out;
}

/** Queries and actions whose data stage must run: new, changed in declaration or text, or not in the base lock. */
export function changedData(spec: AppSpec, queryText: Record<string, string>, base: AppFiles | null): { queries: string[]; actions: string[] } {
  const baseQueries = new Map((base?.spec.queries ?? []).map((q) => [q.id, q] as const));
  const baseActions = new Map((base?.spec.actions ?? []).map((a) => [a.id, a] as const));
  const queries = spec.queries
    .filter((q) => {
      const b = baseQueries.get(q.id);
      const locked = base !== null ? own(base.lock.queries, q.id) : undefined;
      return (
        b === undefined ||
        locked === undefined ||
        canonicalJson(b) !== canonicalJson(q) ||
        locked.source !== q.source ||
        locked.textHash !== textHash(ownText(queryText, q.id) ?? '')
      );
    })
    .map((q) => q.id);
  const actions = spec.actions
    .filter((a) => {
      const b = baseActions.get(a.id);
      const locked = base !== null ? own(base.lock.actions, a.id) : undefined;
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

  // The data stage. A source whose pin moved (its descriptor or its upload snapshot) re-checks every
  // query and action on it, not only the changed ones, before the lock takes the new pin (codex r1 on
  // the store): a retained contract is never carried onto a connection it was not checked against.
  const prior = input.base?.lock ?? EMPTY_LOCK;
  const checkQ = new Set(changed.queries);
  const checkA = new Set(changed.actions);
  let result: AppSourceStageResult | null = null;
  for (let pass = 0; pass < 2 && checkQ.size + checkA.size > 0; pass++) {
    if (input.sourceStage === null) {
      return {
        ok: false,
        code: 'source_check_unavailable',
        findings: [
          {
            stage: 'source',
            code: 'source_check_unavailable',
            path: '$',
            message: `this daemon cannot run the read policy and the source check yet, so a version holding ${[...checkQ, ...checkA].join(', ')} cannot land`,
          },
        ],
      };
    }
    try {
      result = await input.sourceStage.check({ app: input.app, spec, queryText, queries: [...checkQ], actions: [...checkA] });
    } catch (err) {
      // A check that could not run is a check that did not pass: nothing lands.
      return { ok: false, code: 'check_failed', findings: [{ stage: 'source', code: 'source_check_error', path: '$', message: `the source check could not run: ${err instanceof Error ? err.message : String(err)}` }] };
    }
    if (result.findings.length > 0) return { ok: false, code: 'check_failed', findings: result.findings.slice(0, 50) };
    // Every checked query and action answered, with its own source's pin (queries and actions are
    // separate namespaces: each is judged by its own declaration).
    const r = result;
    const missing = [
      ...spec.queries.filter((q) => checkQ.has(q.id) && (typeof own(r.queries, q.id) !== 'string' || own(r.sources, q.source) === undefined)).map((q) => `query ${q.id}`),
      ...spec.actions.filter((a) => checkA.has(a.id) && (typeof own(r.actions, a.id) !== 'string' || own(r.sources, a.source) === undefined)).map((a) => `action ${a.id}`),
    ];
    if (missing.length > 0) {
      return { ok: false, code: 'check_failed', findings: missing.map((what) => ({ stage: 'source', code: 'source_check_incomplete', path: what, message: `the source check answered nothing (or no source pin) for ${what}` })) };
    }
    const moved = movedSources(prior, r);
    const extraQ = spec.queries.filter((q) => moved.has(q.source) && !checkQ.has(q.id));
    const extraA = spec.actions.filter((a) => moved.has(a.source) && !checkA.has(a.id));
    if (extraQ.length + extraA.length === 0) break;
    for (const q of extraQ) checkQ.add(q.id);
    for (const a of extraA) checkA.add(a.id);
    result = null;
  }
  if (result === null && checkQ.size + checkA.size > 0) {
    return { ok: false, code: 'check_failed', findings: [{ stage: 'source', code: 'source_changed', path: '$', message: 'a source changed again while its queries were being checked; try again' }] };
  }

  // The lock: checked entries from the stage, the rest carried from the base lock (crew's own).
  const lock: AppLock = { schema: 'wicked.apps.lock/v1', sources: {}, queries: {}, actions: {}, uploads: {} };
  const usedSources = new Set<string>();
  for (const q of spec.queries) {
    usedSources.add(q.source);
    const contractHash = checkQ.has(q.id) ? own(result!.queries, q.id)! : own(prior.queries, q.id)!.contractHash;
    lock.queries[q.id] = { source: q.source, textHash: textHash(ownText(queryText, q.id)!), contractHash };
  }
  for (const a of spec.actions) {
    usedSources.add(a.source);
    const contractHash = checkA.has(a.id) ? own(result!.actions, a.id)! : own(prior.actions, a.id)!.contractHash;
    lock.actions[a.id] = { source: a.source, actionHash: actionHash(a), contractHash };
  }
  for (const name of [...usedSources].sort()) {
    const pin = (result !== null ? own(result.sources, name) : undefined) ?? own(prior.sources, name);
    if (pin !== undefined) lock.sources[name] = pin;
    const upload = (result !== null ? own(result.uploads, name) : undefined) ?? own(prior.uploads, name);
    if (upload !== undefined) lock.uploads[name] = upload;
  }
  return { ok: true, lock, summary: { level, checked: [...checkQ, ...checkA] } };
}

/** An own entry of a record (a name such as `constructor` is never an inherited member). */
function own<T>(r: Record<string, T>, k: string): T | undefined {
  return Object.hasOwn(r, k) ? r[k] : undefined;
}

/** Sources whose pin in `result` differs from the prior lock's (descriptor hash or upload digest). */
function movedSources(prior: AppLock, result: AppSourceStageResult): Set<string> {
  const moved = new Set<string>();
  for (const [name, pin] of Object.entries(result.sources)) {
    const was = own(prior.sources, name);
    if (was !== undefined && was.descriptorHash !== pin.descriptorHash) moved.add(name);
  }
  for (const [name, up] of Object.entries(result.uploads)) {
    const was = own(prior.uploads, name);
    if (was !== undefined && was.digest !== up.digest) moved.add(name);
  }
  return moved;
}

/** The lock's bytes: keys sorted, so the same lock is the same blob. */
export function lockBytes(lock: AppLock): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(lock)), null, 2)}\n`;
}

/** The spec's bytes as crew writes them. */
export function specBytes(spec: AppSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}
