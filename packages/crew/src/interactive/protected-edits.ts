/**
 * A PERSON'S OWN EDITS TO A DOCUMENT, AND WHETHER A REVISION KEPT THEM (DES-CHAT-ARTIFACTS-001 §6.2, slice A5).
 *
 * The map is recomputed from records every time, so it cannot drift: interactive's version lineage (`versions.json`,
 * write-once entries with `parent`, `kind` and, since slice I1, `run_id`), read by crew from the docs root no worker can
 * write, walked from the root to the version asked for along the parent chain:
 *
 *  - a version with `run_id: null` that is not a theme is a person's HAND step (a text write, a deck move, a fork): its
 *    diff from its parent is protected. A generated or structural version is only ever a run's, so one with no run on
 *    record (an older crew did not send it) is not claimed either way;
 *  - a version with a `run_id` is a run's step: it changes nothing, except the entries the person let that run change
 *    (its accepted `allow`, recorded on the document's binding when the run was started);
 *  - a theme version is skipped (a theme is re-applied at every version); a version from before I1 (no `run_id` key) is
 *    never claimed as kept; undo and restore are forks, so the chain follows the restored parent.
 *
 * The DOM work (diff by `data-wid`, the check) is wicked-garden's `scripts/draft/keep_check.py` — ONE implementation,
 * which the writer also runs inside its run. Crew runs it with its own inputs; a check that cannot run is an error the
 * caller treats as "not kept", never as a pass.
 */

import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { ProtectedEdit } from 'wicked-crew-api-types';
import { DOC_NAME } from './draft-events.js';
import { DRAFT_LAUNCHER_SCRIPT, gardenPluginRoot, runNode } from './draft-skill.js';

/** The keep check, relative to the wicked-garden plugin root. */
export const KEEP_CHECK_SCRIPT = 'scripts/draft/keep_check.py';
const KEEP_TIMEOUT_MS = 60_000;
const MAX_CHAIN = 1000;

export type StepKind = 'root' | 'hand' | 'theme' | 'job' | 'unknown';
export interface LineageStep {
  version: number;
  html: string;
  step: StepKind;
  runId?: string;
  allow?: string[];
}

/** The map keep_check.py computes (opaque to crew: it is handed back to the check as is). */
export type KeepMap = Record<string, unknown>;

/** Injectable garden IO (tests substitute the answer). */
export interface GardenIo {
  gardenRoot?: () => string | null;
  run?: (argv: string[], timeoutMs: number) => Promise<{ stdout: string; code: number | null }>;
}

/**
 * The parent chain of `version`, root first, each step classified, with its html file (beneath the docs root; a
 * manifest `html_file` that is not a plain name falls back to `_v<n>.html`). `null` = the manifest or the version is not
 * there, or the chain is broken.
 */
export function lineageSteps(docsRoot: string, doc: string, version: number, allowOf: (runId: string) => string[]): LineageStep[] | null {
  if (!DOC_NAME.test(doc)) return null;
  let root: string;
  let entries: Array<Record<string, unknown>>;
  try {
    // A plain read (`readBeneath` refuses Windows): the name is a validated slug, the manifest is parsed as data, and
    // each version's file name is a plain basename.
    root = realpathSync(docsRoot);
    // Never through a link, never a FIFO or device, bounded (as the checks read).
    const path = join(root, doc, 'versions.json');
    const st = lstatSync(path);
    if (lstatSync(join(root, doc)).isSymbolicLink() || !st.isFile() || st.size > 4 * 1024 * 1024) return null;
    const m = JSON.parse(readFileSync(path, 'utf8')) as { versions?: unknown };
    entries = Array.isArray(m.versions) ? (m.versions as Array<Record<string, unknown>>) : [];
  } catch {
    return null;
  }
  const byVersion = new Map<number, Record<string, unknown>>();
  for (const e of entries) if (e !== null && typeof e === 'object' && typeof e['version'] === 'number') byVersion.set(e['version'], e);
  const chain: LineageStep[] = [];
  const seen = new Set<number>();
  for (let v: number | null = version; v !== null; ) {
    const e = byVersion.get(v);
    if (e === undefined || seen.has(v) || seen.size >= MAX_CHAIN) return null;
    seen.add(v);
    const file = typeof e['html_file'] === 'string' && basename(e['html_file']) === e['html_file'] && !e['html_file'].includes('..') ? e['html_file'] : `_v${v}.html`;
    const parent = typeof e['parent'] === 'number' ? e['parent'] : null;
    let step: StepKind;
    let runId: string | undefined;
    if (parent === null) step = 'root';
    else if (e['kind'] === 'theme') step = 'theme';
    else if (!('run_id' in e)) step = 'unknown';
    else if (typeof e['run_id'] === 'string' && e['run_id'] !== '') {
      step = 'job';
      runId = e['run_id'];
    } else if (e['kind'] === 'generated' || e['kind'] === 'structural') {
      // Only a run makes a generated or structural version: one with no run on record (an older crew did not send it) is
      // a run's output, never a person's edit to protect.
      step = 'unknown';
    } else step = 'hand';
    const allow = runId !== undefined ? allowOf(runId) : [];
    chain.push({ version: v, html: join(root, doc, file), step, ...(runId !== undefined ? { runId } : {}), ...(allow.length > 0 ? { allow } : {}) });
    v = parent;
  }
  return chain.reverse();
}

async function runKeep(args: string[], io: GardenIo): Promise<{ ok: true; report: Record<string, unknown>; code: number | null } | { ok: false; error: string }> {
  const root = (io.gardenRoot ?? gardenPluginRoot)();
  if (root === null) return { ok: false, error: `no installed wicked-garden plugin root was found, so ${KEEP_CHECK_SCRIPT} could not be run` };
  let answer: { stdout: string; code: number | null };
  try {
    answer = await (io.run ?? runNode)([join(root, DRAFT_LAUNCHER_SCRIPT), 'run', KEEP_CHECK_SCRIPT, ...args], KEEP_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, error: `${KEEP_CHECK_SCRIPT} could not be run: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const report = JSON.parse(answer.stdout.trim()) as Record<string, unknown>;
    if (typeof report !== 'object' || report === null) throw new Error('not an object');
    if (typeof report['error'] === 'string') return { ok: false, error: `${KEEP_CHECK_SCRIPT}: ${report['error']}` };
    return { ok: true, report, code: answer.code };
  } catch {
    return { ok: false, error: `${KEEP_CHECK_SCRIPT} exited ${String(answer.code)} without a report (is the wicked-garden release with it installed?)` };
  }
}

function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'crew-keep-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** The protected-edits map of a lineage, and its entries for the card (`touched` = the anchors overlap it by subtree). */
export async function protectedEdits(
  steps: LineageStep[],
  touch: readonly string[],
  io: GardenIo = {},
): Promise<{ ok: true; map: KeepMap; entries: ProtectedEdit[] } | { ok: false; error: string }> {
  return withTemp(async (dir) => {
    const lineage = join(dir, 'lineage.json');
    writeFileSync(lineage, JSON.stringify({ steps: steps.map(({ version, html, step, allow }) => ({ version, html, step, ...(allow !== undefined ? { allow } : {}) })) }), { mode: 0o600 });
    const r = await runKeep(['map', '--lineage', lineage, ...touch.filter((t) => /^[A-Za-z0-9_.:-]{1,200}$/.test(t)).flatMap((t) => ['--touch', t]), '--json'], io);
    if (!r.ok) return r;
    const map = r.report['map'];
    const raw = r.report['entries'];
    if (r.code !== 0 || typeof map !== 'object' || map === null || !Array.isArray(raw)) return { ok: false, error: `${KEEP_CHECK_SCRIPT} map answered without a map` };
    const entries: ProtectedEdit[] = [];
    for (const e of raw as Array<Record<string, unknown>>) {
      if (typeof e?.['id'] !== 'string' || typeof e['label'] !== 'string') continue;
      const kind = e['kind'];
      if (kind !== 'text' && kind !== 'attr' && kind !== 'added' && kind !== 'gone' && kind !== 'order') continue;
      entries.push({ id: e['id'], kind, label: e['label'], wid: typeof e['wid'] === 'string' ? e['wid'] : null, touched: e['touched'] === true });
    }
    return { ok: true, map: map as KeepMap, entries };
  });
}

/** Whether `html` kept every protected edit of `map` except the ones in `allow`. */
export async function keepCheck(
  map: KeepMap,
  html: string,
  allow: readonly string[],
  io: GardenIo = {},
): Promise<{ ok: true; kept: number } | { ok: false; violations: string[] } | { ok: false; error: string }> {
  return withTemp(async (dir) => {
    const mapFile = join(dir, 'map.json');
    writeFileSync(mapFile, JSON.stringify(map), { mode: 0o600 });
    const r = await runKeep(['check', '--map', mapFile, html, ...allow.flatMap((a) => ['--allow', a]), '--json'], io);
    if (!r.ok) return r;
    if (r.report['ok'] === true && r.code === 0) return { ok: true, kept: typeof r.report['kept'] === 'number' ? r.report['kept'] : 0 };
    const violations = Array.isArray(r.report['violations'])
      ? (r.report['violations'] as Array<Record<string, unknown>>).flatMap((v) => (typeof v?.['sentence'] === 'string' ? [v['sentence']] : []))
      : [];
    // A report that is neither a pass nor names a violation is not a verdict: never a pass.
    return violations.length > 0 ? { ok: false, violations } : { ok: false, error: `${KEEP_CHECK_SCRIPT} check answered neither kept nor a violation` };
  });
}
