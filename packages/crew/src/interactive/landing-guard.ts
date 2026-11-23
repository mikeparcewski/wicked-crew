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
 *     on, the same inputs the first draft's floor had;
 *  2. the keep check: the person's protected edits, recomputed from the document's lineage at the head the refine
 *     started from (interactive's versions, which no worker can write), minus exactly the entries the person let this
 *     refine change.
 *
 * FAIL CLOSED. A refine changes a document a person has been editing; a check that cannot run here (no wicked-garden,
 * no Python, an unreadable lineage) is not a pass: the guard refuses and nothing lands. The CAS on the head
 * (`expect_head`, interactive's I1 contract) is the third leg: a hand edit made while the refine ran lands nothing.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DraftFloorIo, DraftFloorVerdict } from './draft-skill.js';
import { oneLine } from './draft-events.js';
import { runDraftFloor } from './draft-skill.js';
import { keepCheck, lineageSteps, protectedEdits, type GardenIo } from './protected-edits.js';
import { snapshotRepo, type SnapshotResult } from './repo-snapshot.js';
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
 * document is grounded on. Returns the folders and the repositories that could not be snapshotted. The caller removes
 * `root`.
 */
async function claimsFolders(
  root: string,
  claims: RefineClaimsInput,
  snapshot: NonNullable<RefineGuardIo['snapshot']>,
): Promise<{ dirs: string[]; missing: string[] }> {
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
  const missing: string[] = [];
  for (const [i, repo] of claims.repos.entries()) {
    const dest = join(root, 'repos', String(i));
    if ((await snapshot(repo.rootPath, dest)).ok) dirs.push(dest);
    else missing.push(repo.name);
  }
  return { dirs, missing };
}

/** The sentence a refused floor adds when a grounded repository could not be read: what happened and what to do. */
function missingReposNote(missing: readonly string[]): string {
  if (missing.length === 0) return '';
  const one = missing.length === 1;
  return (
    ` The ${one ? 'repository' : 'repositories'} ${missing.join(', ')} this document is grounded on could not be read on ` +
    `this host, so citations of ${one ? 'it' : 'them'} could not be found: check that ${one ? 'it is' : 'they are'} still ` +
    `attached to the project at ${one ? 'its' : 'their'} folder, then ask again.`
  );
}

export type RefineGuardResult =
  | { ok: true; floor: DraftFloorVerdict; kept: number }
  | { ok: false; reason: string; floor?: DraftFloorVerdict };

/** The floor on the revision, with its claims folders made and removed around it; `refused` when they cannot be made. */
async function refineFloor(input: RefineGuardInput, io: RefineGuardIo): Promise<{ floor: DraftFloorVerdict; missing: string[] } | { refused: string }> {
  const root = mkdtempSync(join(tmpdir(), 'crew-refine-floor-'));
  try {
    let folders: { dirs: string[]; missing: string[] };
    try {
      folders = await claimsFolders(root, input.claims, io.snapshot ?? ((from, dest) => snapshotRepo(from, dest)));
    } catch (err) {
      return {
        refused:
          `crew could not read the records this document cites, so its citations could not be checked and nothing was ` +
          `applied (${oneLine(err instanceof Error ? err.message : String(err), 300)}); ask again`,
      };
    }
    const floor = await runDraftFloor(input.outPath, { pages: null, exact: false, source: 'unknown' }, folders.dirs, { notes: input.notesPath, runId: input.runId }, io.floor ?? {});
    return { floor, missing: folders.missing };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function guardRefine(input: RefineGuardInput, io: RefineGuardIo = {}): Promise<RefineGuardResult> {
  // 1. The floor: notes required, no process notes in the document, every citation checked against the records and
  //    repositories it may name (crew#1727). A refine keeps the page count the document has.
  const checked = await refineFloor(input, io);
  if ('refused' in checked) return { ok: false, reason: checked.refused };
  const { floor, missing } = checked;
  if (floor.verdict === 'fail') {
    return { ok: false, reason: `the revision did not meet the document floor: ${oneLine(floor.breaches.join(' '), 400)}${missingReposNote(missing)}`, floor };
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
