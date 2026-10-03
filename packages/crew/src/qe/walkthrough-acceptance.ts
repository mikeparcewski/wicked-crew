/**
 * WT-W2 (DES-walkthrough-proof §4.6, §4.9): the walkthrough half of the acceptance gate.
 *
 * A walkthrough's evidence lives in its PROOF ROOT (`<evidence root>/<review step>/`), written only
 * by the jailed `walkthrough_review` Tool. Crew trusts a proof root only through its SEAL: the last
 * `WALKTHROUGH-SEAL {...}` line of that unit's persisted output, which the engine captured and no
 * seat can reach. At every read:
 *
 *   1. the seal is parsed (`bundle_sha`, `overall`, `chapters: [{key, verdict}]`; a seal that does
 *      not agree with itself — `overall: PASS` over a chapter it lists as not passing — is refused);
 *   2. `bundle_sha` is recomputed from disk: the sha256 of the UTF-8 text made of one line
 *      `<sha256 hex of the file>  <relative posix path>\n` per regular file under the proof root,
 *      except the top-level `app/` and `data/` subtrees, sorted by path (byte order). A symbolic
 *      link anywhere outside those two subtrees is refused. Reproducible with the shell:
 *      `find . -path ./app -prune -o -path ./data -prune -o -type f -print | sed 's|^\./||' |
 *       LC_ALL=C sort | while read -r f; do shasum -a 256 "$f"; done | shasum -a 256`;
 *   3. the proof root's own ledger (`<proof root>/.wicked-qe/`) must hold a verdict stamped with this
 *      crew run and step, and the newest stamped verdict per chapter (by take, then time) must equal
 *      the sealed chapter verdict.
 *
 * Any mismatch denies "walkthrough evidence changed after it was sealed" (deny-dominates). A sealed
 * walkthrough that did not PASS denies, naming its chapters. Nothing here writes.
 */

import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { WalkthroughStepState } from 'wicked-crew-api-types';
import type { SessionView } from '../core/types.js';
import { stepIdOf } from '../core/walkthrough-root.js';
import { readStampedVerdicts } from './ledger.js';

export const SEAL_PREFIX = 'WALKTHROUGH-SEAL ';

/** The fields of a seal acceptance reads. */
export interface WalkthroughSeal {
  tree: string;
  storyline_sha: string | null;
  bundle_sha: string;
  overall: string;
  chapters: Array<{ key: string; verdict: string }>;
  edited_by: string | null;
}

/** The LAST seal line of a recorder's output, parsed; `null` when there is none or it is malformed. */
export function parseSeal(output: string | null): WalkthroughSeal | null {
  if (output === null) return null;
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith(SEAL_PREFIX)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(SEAL_PREFIX.length));
    } catch {
      return null;
    }
    const o = raw as Record<string, unknown> | null;
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
    if (typeof o.bundle_sha !== 'string' || !/^[0-9a-f]{64}$/.test(o.bundle_sha)) return null;
    if (typeof o.overall !== 'string' || !Array.isArray(o.chapters)) return null;
    // The tree binds the seal to the recorded take; without it ledger rows of any tree could match.
    if (typeof o.tree !== 'string' || o.tree === '') return null;
    const chapters: WalkthroughSeal['chapters'] = [];
    for (const c of o.chapters as unknown[]) {
      const ch = c as Record<string, unknown> | null;
      if (ch === null || typeof ch !== 'object' || typeof ch.key !== 'string' || typeof ch.verdict !== 'string') return null;
      chapters.push({ key: ch.key, verdict: ch.verdict });
    }
    const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
    return { tree: o.tree, storyline_sha: s(o.storyline_sha), bundle_sha: o.bundle_sha, overall: o.overall, chapters, edited_by: s(o.edited_by) };
  }
  return null;
}

/** The subtrees of a proof root the seal does not cover: the app copy and its data dir. */
const UNSEALED_TOP = new Set(['app', 'data']);

/** Recompute a proof root's `bundle_sha` (see the module header for the exact form). */
export async function computeBundleSha(
  proofRoot: string,
): Promise<{ ok: true; sha: string; files: number } | { ok: false; error: string }> {
  const files: string[] = [];
  const walk = async (dir: string, rel: string): Promise<string | null> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (rel === '' && UNSEALED_TOP.has(e.name)) continue;
      if (e.isSymbolicLink()) return `the proof root holds a link at ${r}`;
      if (e.isDirectory()) {
        const err = await walk(join(dir, e.name), r);
        if (err !== null) return err;
      } else if (e.isFile()) {
        files.push(r);
      } else {
        return `the proof root holds a non-regular entry at ${r}`;
      }
    }
    return null;
  };
  try {
    const err = await walk(proofRoot, '');
    if (err !== null) return { ok: false, error: err };
    // UTF-8 byte order, as `LC_ALL=C sort` orders the lines (a JS string compare is UTF-16 order).
    files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    const outer = createHash('sha256');
    for (const rel of files) {
      const inner = await fileSha256(join(proofRoot, rel));
      outer.update(`${inner}  ${rel}\n`, 'utf8');
    }
    return { ok: true, sha: outer.digest('hex'), files: files.length };
  } catch (e) {
    return { ok: false, error: `the proof root could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * One file's sha256, STREAMED (a stitched take is a video; the walkthrough view is polled). Never
 * memoized: a stat key cannot prove the bytes are unchanged (a shared writable mapping can change a
 * page without another mtime/ctime update), and the gate must read what is on disk now (codex on #759).
 */
async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** One walkthrough step's acceptance. */
export interface WalkthroughGate {
  stepId: string;
  /** The seal was found AND every check against the files on disk held. */
  sealed: boolean;
  /** Sealed, PASS overall, every chapter PASS, and the ledger agrees. */
  satisfied: boolean;
  reason: string;
  /** The sealed overall verdict; `null` when there is no usable seal. */
  overall: string | null;
  /** (WT-W3) The tree the seal binds, for the deliver card's "checked at <tree>"; `null` when there is no seal. */
  tree: string | null;
  /** The sealed chapters with what each proves (from the bundle-verified `result.json`). */
  chapters: Array<{ key: string; verdict: string; proves: string[] }>;
}

/** Resolve one walkthrough step's gate from its proof root and its recorder's persisted output. */
export async function resolveWalkthroughGate(opts: {
  runId: string;
  stepId: string;
  proofRoot: string | null;
  output: string | null;
}): Promise<WalkthroughGate> {
  const { runId, stepId, proofRoot } = opts;
  let tree: string | null = null;
  const deny = (reason: string, sealed = false, overall: string | null = null, chapters: WalkthroughGate['chapters'] = []): WalkthroughGate => ({
    stepId,
    sealed,
    satisfied: false,
    reason: `walkthrough \`${stepId}\`: ${reason}`,
    overall,
    tree,
    chapters,
  });
  if (proofRoot === null) return deny('no proof root on this run — nothing was recorded there (missing ⇒ deny)');
  const seal = parseSeal(opts.output);
  if (seal === null) return deny('not sealed — its recorder\'s output carries no well-formed WALKTHROUGH-SEAL line (missing ⇒ deny)');
  tree = seal.tree;
  const changed = (why: string): WalkthroughGate => deny(`walkthrough evidence changed after it was sealed (${why}) (tampered ⇒ deny)`);
  const bundle = await computeBundleSha(proofRoot);
  if (!bundle.ok) return changed(bundle.error);
  if (bundle.sha !== seal.bundle_sha) return changed('bundle_sha recomputed from disk does not match the sealed value');

  // The bundle covers result.json, so what it says each chapter proves is sealed too.
  let result: { overall?: unknown; chapters?: unknown } = {};
  try {
    result = JSON.parse(await fsp.readFile(join(proofRoot, 'result.json'), 'utf8')) as typeof result;
  } catch {
    return changed('the sealed take has no readable result.json');
  }
  const proves = new Map<string, string[]>();
  for (const c of Array.isArray(result.chapters) ? result.chapters : []) {
    const ch = c as { key?: unknown; proves?: unknown };
    if (typeof ch.key === 'string') {
      proves.set(ch.key, Array.isArray(ch.proves) ? ch.proves.filter((x): x is string => typeof x === 'string') : []);
    }
  }
  const chapters = seal.chapters.map((c) => ({ key: c.key, verdict: c.verdict, proves: proves.get(c.key) ?? [] }));

  // The ledger: rows stamped with this run and step must exist, and the newest per chapter must agree.
  const ledger = readStampedVerdicts(proofRoot, runId, stepId);
  if (ledger.error !== undefined) return changed(`the proof root's ledger could not be read: ${ledger.error}`);
  if (ledger.rows.length === 0) {
    return deny(`its ledger holds no verdict stamped with run ${runId} and step ${stepId} (missing ⇒ deny)`, false, seal.overall, chapters);
  }
  const newest = new Map<string, (typeof ledger.rows)[number]>();
  for (const row of ledger.rows) {
    if (row.chapter === null) continue;
    if (row.tree !== seal.tree) continue;
    const prev = newest.get(row.chapter);
    const later =
      prev === undefined ||
      (row.take ?? 0) > (prev.take ?? 0) ||
      ((row.take ?? 0) === (prev.take ?? 0) && (row.verdict.created_at ?? '') > (prev.verdict.created_at ?? ''));
    if (later) newest.set(row.chapter, row);
  }
  // Exact chapter-set agreement (codex on #759): every sealed chapter has its own stamped verdict on
  // the sealed tree, equal to the sealed one, and the ledger holds no chapter the seal omits.
  const sealedKeys = new Set(seal.chapters.map((c) => c.key));
  for (const c of seal.chapters) {
    const row = newest.get(c.key);
    if (row === undefined) {
      return deny(`chapter ${c.key} has no stamped ledger verdict on tree ${seal.tree} (missing ⇒ deny)`, false, seal.overall, chapters);
    }
    if (row.verdict.verdict !== c.verdict) {
      return changed(`chapter ${c.key}: the ledger's newest stamped verdict is ${row.verdict.verdict}, the seal ${c.verdict}`);
    }
  }
  for (const key of newest.keys()) {
    if (!sealedKeys.has(key)) return changed(`the ledger holds a stamped verdict for chapter ${key}, which the seal does not list`);
  }

  if (result.overall !== seal.overall) return changed(`result.json says ${String(result.overall)}, the seal ${seal.overall}`);

  const notPassing = seal.chapters.filter((c) => c.verdict !== 'PASS');
  if (seal.overall === 'PASS' && notPassing.length > 0) {
    return deny(`the seal says PASS over chapters it lists as ${notPassing.map((c) => `${c.key} ${c.verdict}`).join(', ')} (inconsistent ⇒ deny)`);
  }
  if (seal.overall !== 'PASS' || seal.chapters.length === 0) {
    const named = notPassing.length > 0 ? `: ${notPassing.map((c) => `${c.key} ${c.verdict}`).join(', ')}` : seal.chapters.length === 0 ? ': no chapters' : '';
    return deny(`sealed ${seal.overall}${named} (not a pass)`, true, seal.overall, chapters);
  }
  return {
    stepId,
    sealed: true,
    satisfied: true,
    reason: `walkthrough \`${stepId}\`: PASS — ${seal.chapters.length} chapter${seal.chapters.length === 1 ? '' : 's'} sealed at tree ${seal.tree}, bundle and ledger re-verified`,
    overall: seal.overall,
    tree,
    chapters,
  };
}

/** The catalog ids whose removal by the accepted plan's floor override makes the pair the operator's. */
const PAIR_CATALOGS = new Set(['walkthrough_plan', 'walkthrough_review']);

/**
 * `checkState` per creator step (§4.9), computed, never stored. `newest` is the newest walkthrough's
 * gate (only a SEALED one proves anything); `atSec` per chapter is not sealed, so it is `null` here.
 * One row per creator step that is proved by a sealed chapter or passed its own gate.
 */
export function walkthroughCheckStates(
  view: SessionView,
  newest: WalkthroughGate | null,
): WalkthroughStepState[] {
  const accepted = (view.session as { team_plan?: { accepted?: { floor_override?: { remove?: unknown } | null } | null } | null }).team_plan
    ?.accepted;
  const removed = accepted?.floor_override?.remove;
  const ownedByYou = Array.isArray(removed) && removed.some((r) => typeof r === 'string' && PAIR_CATALOGS.has(r));
  const out: WalkthroughStepState[] = [];
  for (const u of [...view.units].sort((a, b) => a.ord - b.ord)) {
    if (u.role !== 'creator') continue;
    const stepId = stepIdOf(view, u);
    const proving = newest?.sealed === true ? newest.chapters.filter((c) => c.proves.includes(stepId)) : [];
    const provedBy = proving.map((c) => ({ chapter: c.key, atSec: null }));
    if (proving.some((c) => c.verdict === 'FAIL')) out.push({ stepId, checkState: 'failed', provedBy });
    else if (proving.length > 0 && proving.every((c) => c.verdict === 'PASS')) out.push({ stepId, checkState: 'checked', provedBy });
    else if (u.status === 'done' || proving.length > 0) out.push({ stepId, checkState: ownedByYou ? 'owned_by_you' : 'claimed', provedBy });
  }
  return out;
}
