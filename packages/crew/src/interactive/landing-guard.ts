/**
 * THE LANDING GUARD OF A REFINE (DES-CHAT-ARTIFACTS-001 §6.2, §11.2; slices A5, A6).
 *
 * Nothing a refine wrote lands until crew itself has checked the exact file it is about to announce, with its own
 * inputs (never the worker's copies):
 *
 *  1. the draft floor (garden's self-check): the writer's `notes.json` is there and valid, and no process notes (paths,
 *     the run id, check names, `[S]` markers, "I used …") are in the document — the same rules the writer was told to
 *     run, re-derived;
 *  2. the keep check: the person's protected edits, recomputed from the document's lineage at the head the refine
 *     started from (interactive's versions, which no worker can write), minus exactly the entries the person let this
 *     refine change.
 *
 * FAIL CLOSED. A refine changes a document a person has been editing; a check that cannot run here (no wicked-garden,
 * no Python, an unreadable lineage) is not a pass: the guard refuses and nothing lands. The CAS on the head
 * (`expect_head`, interactive's I1 contract) is the third leg: a hand edit made while the refine ran lands nothing.
 */

import type { DraftFloorIo, DraftFloorVerdict } from './draft-skill.js';
import { oneLine } from './draft-events.js';
import { runDraftFloor } from './draft-skill.js';
import { keepCheck, lineageSteps, protectedEdits, type GardenIo } from './protected-edits.js';

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
}

export type RefineGuardResult =
  | { ok: true; floor: DraftFloorVerdict; kept: number }
  | { ok: false; reason: string; floor?: DraftFloorVerdict };

export async function guardRefine(input: RefineGuardInput, io: { floor?: DraftFloorIo; garden?: GardenIo } = {}): Promise<RefineGuardResult> {
  // 1. The floor: notes required, no process notes in the document. A refine keeps the page count the document has.
  const floor = await runDraftFloor(input.outPath, { pages: null, exact: false, source: 'unknown' }, [], { notes: input.notesPath, runId: input.runId }, io.floor ?? {});
  if (floor.verdict === 'fail') return { ok: false, reason: `the revision did not meet the document floor: ${oneLine(floor.breaches.join(' '), 400)}`, floor };
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
