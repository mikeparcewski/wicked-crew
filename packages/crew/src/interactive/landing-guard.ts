/**
 * THE LANDING GUARD OF A REFINE (DES-CHAT-ARTIFACTS-001 §6.2, §11.2; slices A5, A6).
 *
 * Nothing a refine wrote lands until crew itself has checked the exact file it is about to announce, with its own
 * inputs (never the worker's copies):
 *
 *  1. the draft floor (garden's self-check): the writer's `notes.json` is there and valid, and no process notes (paths,
 *     the run id, check names, `[S]` markers, "I used …") are in the document — the same rules the writer was told to
 *     run, re-derived — and every `data-source="<file>:<line>"` is checked against the folders the document may cite
 *     (crew#1727): crew's own copy of the refine's records, and a snapshot of each repository the document is grounded
 *     on, the same inputs the first draft's floor had. A citation the revision carries over unchanged from the version
 *     it started from is not judged again (the repository may have moved on since it was checked); one it adds or
 *     changes is;
 *  2. the keep check: the person's protected edits, recomputed from the document's lineage at the head the refine
 *     started from (interactive's versions, which no worker can write), minus exactly the entries the person let this
 *     refine change.
 *
 * FAIL CLOSED. A refine changes a document a person has been editing; a check that cannot run here (no wicked-garden,
 * no Python, an unreadable lineage) is not a pass: the guard refuses and nothing lands. The CAS on the head
 * (`expect_head`, interactive's I1 contract) is the third leg: a hand edit made while the refine ran lands nothing.
 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClaimFinding, DraftFloorIo, DraftFloorVerdict } from './draft-skill.js';
import { oneLine } from './draft-events.js';
import { REPO_DEPENDENT_CLAIM_KINDS, runDraftFloor } from './draft-skill.js';
import { keepCheck, lineageSteps, protectedEdits, type GardenIo } from './protected-edits.js';
import { REPO_SNAPSHOT_MAX_BYTES, snapshotRepo, type SnapshotFailureReason, type SnapshotResult } from './repo-snapshot.js';
import { packetDirOf } from './source-packet.js';

/** What the claims scan checks a refine's citations against (crew#1727). */
export interface RefineClaimsInput {
  /** The refine's packet files, as crew recorded them at launch (name, sha256, size). */
  files: ReadonlyArray<{ name: string; sha256: string; bytes: number }>;
  /** A packet file's bytes from crew's canonical copy (the binding store; never the writer's inbox). */
  packetBytes: (name: string) => Buffer;
  /** The repositories the document is grounded on (its binding's), whose files its citations may name. */
  repos: ReadonlyArray<{ name: string; rootPath: string }>;
}

export interface RefineGuardInput {
  /** The revised document crew is about to announce. */
  outPath: string;
  notesPath: string;
  runId: string;
  docsRoot: string;
  doc: string;
  /** The head the refine started from (its `expect_head`). */
  base: number;
  /** The protected-edit ids the person let this refine change. */
  allow: readonly string[];
  /** Earlier runs' accepted `allow` (their steps on the lineage release only those). */
  allowOf: (runId: string) => string[];
  claims: RefineClaimsInput;
}

/** The guard's injectable IO: the floor's and garden's, and the repository snapshot (tests). */
export interface RefineGuardIo {
  floor?: DraftFloorIo;
  garden?: GardenIo;
  snapshot?: (rootPath: string, dest: string) => Promise<SnapshotResult>;
}

/**
 * The floor's `--repo` folders for a refine, made in a fresh crew-owned folder: `records/` holds crew's own copy of the
 * packet's records (each checked against the hash recorded at launch), `repos/<n>` a snapshot of each repository the
 * document is grounded on. Returns the folders and the repositories that could not be snapshotted (and why). The caller
 * removes `root`.
 */
async function claimsFolders(
  root: string,
  claims: RefineClaimsInput,
  snapshot: NonNullable<RefineGuardIo['snapshot']>,
): Promise<{ dirs: string[]; missing: MissingRepo[] }> {
  const records = join(root, 'records');
  mkdirSync(records, { mode: 0o700 });
  for (const f of claims.files) {
    if (packetDirOf(f.name) !== 'records') continue;
    const bytes = claims.packetBytes(f.name);
    if (bytes.length !== f.bytes || createHash('sha256').update(bytes).digest('hex') !== f.sha256) {
      throw new Error(`${f.name} no longer matches the copy recorded when the revision started`);
    }
    writeFileSync(join(records, f.name), bytes, { mode: 0o600, flag: 'wx' });
  }
  const dirs = [records];
  const missing: MissingRepo[] = [];
  for (const [i, repo] of claims.repos.entries()) {
    const dest = join(root, 'repos', String(i));
    const snap = await snapshot(repo.rootPath, dest);
    if (snap.ok) dirs.push(dest);
    else missing.push({ name: repo.name, reason: snap.reason });
  }
  return { dirs, missing };
}

/** A grounded repository the check could not copy, and why. */
interface MissingRepo {
  name: string;
  reason: SnapshotFailureReason;
}

/** The sentences a refused floor adds when a grounded repository could not be copied for the check: why, and what to
 *  do. Citations of it then read as missing files. */
function missingReposNote(missing: readonly MissingRepo[]): string {
  return missing
    .map(({ name, reason }) =>
      reason === 'too-large'
        ? ` The repository ${name} is larger than the ${Math.round(REPO_SNAPSHOT_MAX_BYTES / (1024 * 1024))} MB crew copies ` +
          `to check citations, so citations of it could not be checked: ask for the change without citing it, or ground ` +
          `the document on a smaller repository.`
        : reason === 'root-unreadable'
          ? ` The repository ${name} this document is grounded on is no longer readable at its folder on this host, so ` +
            `citations of it could not be checked: check that it is still there and attached to the project, then ask again.`
          : ` The repository ${name} this document is grounded on could not be copied for the check on this host, so ` +
            `citations of it could not be checked: ask again, and if it keeps failing, check the crew daemon log.`,
    )
    .join('');
}

/** The `data-source` spec a `cite-off` finding is about (its detail starts with it, `claims_scan.py` `_check_cite_off`). Only
 *  a cite-off names both the citation (detail) and the element's text (text): a `dangling-source` or `unsourced-url`
 *  reports the path or URL as its text, so a reworded carrier of one is the same finding and was set aside already. */
function citeOffSpec(f: ClaimFinding): string | null {
  return f.kind === 'cite-off' ? (/^data-source (\S+)/.exec(f.detail)?.[1] ?? null) : null;
}

/**
 * (crew#1857) The sentence a refused revision adds when a citation it was refused for also fails in the version the
 * refine started from, with other element text: that paragraph's citation was checked when it was written, so the
 * repository has most likely changed under it since. The refine writer has no repository folder to correct the line
 * from, so asking again would be refused again: say which citation, the nearest line the scan found, and what to do.
 * Matching is one to one (review r1): the findings carried over unchanged are set aside first, from both sides, and a
 * citation is explained only when its refused carriers match its changed base carriers in number, so a carrier the
 * refine adds beside a reworded one is never blamed on the repository. (A carrier deleted and another added on the same
 * citation is indistinguishable from a reword: the citation itself does fail against the repository as it is now.)
 */
function movedCitationsNote(revision: readonly ClaimFinding[], base: readonly ClaimFinding[]): string {
  const key = (f: ClaimFinding): string => JSON.stringify([f.kind, f.text, f.detail]);
  const baseLeft = new Map<string, number>();
  for (const f of base) if (REPO_DEPENDENT_CLAIM_KINDS.has(f.kind)) baseLeft.set(key(f), (baseLeft.get(key(f)) ?? 0) + 1);
  // 1. Set aside what the revision carried over unchanged (as withoutCarriedClaims does), consuming those base findings.
  const refused: ClaimFinding[] = [];
  for (const f of revision) {
    const n = baseLeft.get(key(f)) ?? 0;
    if (REPO_DEPENDENT_CLAIM_KINDS.has(f.kind) && n > 0) baseLeft.set(key(f), n - 1);
    else refused.push(f);
  }
  // 2. The base's cite-offs left over (their carriers the revision changed), counted per citation.
  const byCite = new Map<string, number>();
  for (const f of base) {
    const n = baseLeft.get(key(f)) ?? 0;
    if (n === 0) continue;
    baseLeft.set(key(f), n - 1);
    const spec = citeOffSpec(f);
    if (spec !== null) byCite.set(spec, (byCite.get(spec) ?? 0) + 1);
  }
  // 3. A refused cite-off is explained only when its citation has exactly as many refused carriers as changed base ones
  //    (review r1 delta): with more, the scan cannot tell the reworded carrier from one the refine added (document order
  //    is no correspondence), so none of them is attributed.
  const refusedByCite = new Map<string, number>();
  for (const f of refused) { const spec = citeOffSpec(f); if (spec !== null) refusedByCite.set(spec, (refusedByCite.get(spec) ?? 0) + 1); }
  const moved: string[] = [];
  for (const f of refused) {
    const spec = citeOffSpec(f);
    if (spec === null || (byCite.get(spec) ?? 0) === 0 || refusedByCite.get(spec) !== byCite.get(spec)) continue;
    const nearest = /nearest match: line (\d+)/.exec(f.detail)?.[1];
    moved.push(`${spec}${nearest !== undefined ? ` (the nearest matching line is now ${nearest})` : ''} in "${oneLine(f.text, 80)}"`);
  }
  if (moved.length === 0) return '';
  return ` The version this refine started from already fails on the same citation, so the cited repository has most ` +
    `likely changed since the draft (or that citation never matched): ${moved.slice(0, 3).join('; ')}` +
    `${moved.length > 3 ? ` and ${moved.length - 3} more` : ''}. A refine cannot re-check the repository's lines, so ` +
    `asking again gives the same answer: keep that paragraph's wording as it was, or make a new draft from the ` +
    `repository as it is now.`;
}

export type RefineGuardResult =
  | { ok: true; floor: DraftFloorVerdict; kept: number }
  | { ok: false; reason: string; floor?: DraftFloorVerdict };

/** The floor on the revision, with its claims folders made and removed around it; `refused` when they cannot be made. */
async function refineFloor(input: RefineGuardInput, io: RefineGuardIo): Promise<{ floor: DraftFloorVerdict; missing: MissingRepo[]; base: ClaimFinding[] | null } | { refused: string }> {
  const root = mkdtempSync(join(tmpdir(), 'crew-refine-floor-'));
  try {
    let folders: { dirs: string[]; missing: MissingRepo[] };
    try {
      folders = await claimsFolders(root, input.claims, io.snapshot ?? ((from, dest) => snapshotRepo(from, dest)));
    } catch (err) {
      return {
        refused:
          `crew could not read the records this document cites, so its citations could not be checked and nothing was ` +
          `applied (${oneLine(err instanceof Error ? err.message : String(err), 300)}); ask again`,
      };
    }
    const budget = { pages: null, exact: false, source: 'unknown' } as const;
    // The citations the revision carries over unchanged were checked when they were written, against the repository
    // as it was then; it may have moved on since (a line inserted above a cited one, a file renamed). Only what the
    // revision adds or changes is judged: the version it started from is scanned against the same folders, and the
    // repository-dependent findings it already had are set aside (coord r2 on crew#1853). Asked only on a failure.
    // Kept for the refusal's reason (crew#1857): a citation the base already fails on says the repository moved.
    let baseFindings: ClaimFinding[] | null = null;
    const carried = async (): Promise<ClaimFinding[] | null> => {
      const base = lineageSteps(input.docsRoot, input.doc, input.base, input.allowOf)?.at(-1)?.html;
      if (base === undefined) return null;
      baseFindings = (await runDraftFloor(base, budget, folders.dirs, {}, io.floor ?? {})).claimFindings ?? null;
      return baseFindings;
    };
    const floor = await runDraftFloor(input.outPath, budget, folders.dirs, { notes: input.notesPath, runId: input.runId, carried }, io.floor ?? {});
    return { floor, missing: folders.missing, base: baseFindings };
  } finally {
    removeFolder(root);
  }
}

/** Remove the check's temp folder, read-only directories a copied snapshot kept included. Never throws: a leftover
 *  temp folder is a disk wart, never a refused revision. */
function removeFolder(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
    return;
  } catch {
    /* a read-only directory: made writable below, then removed */
  }
  try {
    const open = (dir: string): void => {
      chmodSync(dir, 0o700);
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) open(join(dir, e.name));
    };
    open(root);
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* left behind in the OS temp folder */
  }
}

export async function guardRefine(input: RefineGuardInput, io: RefineGuardIo = {}): Promise<RefineGuardResult> {
  // 1. The floor: notes required, no process notes in the document, every citation checked against the records and
  //    repositories it may name (crew#1727). A refine keeps the page count the document has.
  const checked = await refineFloor(input, io);
  if ('refused' in checked) return { ok: false, reason: checked.refused };
  const { floor, missing, base } = checked;
  if (floor.verdict === 'fail') {
    const notes = `${missingReposNote(missing)}${movedCitationsNote(floor.claimFindings ?? [], base ?? [])}`;
    const breaches = oneLine(floor.breaches.join(' '), 400);
    // A note is a sentence of its own: the breach before it ends with a full stop.
    const ended = notes !== '' && !/[.!?…]$/.test(breaches) ? `${breaches}.` : breaches;
    return { ok: false, reason: `the revision did not meet the document floor: ${ended}${notes}`, floor };
  }
  if (floor.verdict === 'unavailable') return { ok: false, reason: `the revision could not be checked on this host, so it was not applied (${oneLine(floor.summary, 300)})`, floor };
  // 2. The keep check, on crew's own map of the head the refine started from.
  const steps = lineageSteps(input.docsRoot, input.doc, input.base, input.allowOf);
  if (steps === null) return { ok: false, reason: `the document's versions up to v${input.base} could not be read, so your edits could not be checked; nothing was applied`, floor };
  const mapped = await protectedEdits(steps, [], io.garden ?? {});
  if (!mapped.ok) return { ok: false, reason: `your edits could not be checked on this host, so nothing was applied (${oneLine(mapped.error, 300)})`, floor };
  const kept = await keepCheck(mapped.map, input.outPath, input.allow, io.garden ?? {});
  if (kept.ok) return { ok: true, floor, kept: kept.kept };
  if ('violations' in kept) {
    return { ok: false, reason: `the revision did not keep your edits, so nothing was applied: ${oneLine(kept.violations.slice(0, 3).join('; '), 400)}`, floor };
  }
  return { ok: false, reason: `your edits could not be checked on this host, so nothing was applied (${oneLine(kept.error, 300)})`, floor };
}
