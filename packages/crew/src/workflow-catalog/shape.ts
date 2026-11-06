/**
 * `shape` on every launch route (DES-CATALOG-002 §4.4): one check, so `POST /runs`, the demo, the compose and a
 * document's draft judge a shape the same way, against the CURRENT catalog, before anything launches.
 *
 * - The card and option must exist and launch what the route launches (**400** `shape_mismatch`).
 * - A coming or unavailable card never launches (**409** `card_not_available`, with its nearest card).
 * - A detected shape still at `ask` never launches (**409** `shape_ask`).
 * - A catalog that changed since the shape was judged is **409** `catalog_changed`: the person sees it again first.
 * - A framing option's brief, and an Investigate card's depth line, are crew's: put first in the brief, never sent by
 *   a client. A brief that already starts with them (a retry of the same launch) is left as it is.
 */
import type { CatalogEntry, LaunchShape, Preset, WorkflowDef } from '../core/types.js';
import { z } from '../zod.js';
import { buildWorkflowCatalogV2, resolveOption, servedState, type ResolvedOption, type ServedState } from './build-v2.js';

/** What a launch route launches. */
export type LaunchTarget =
  | { kind: 'run'; workflow: string | undefined }
  | { kind: 'demo' }
  | { kind: 'compose' }
  | { kind: 'document'; style: string };

export type ShapeVerdict =
  | { ok: true; resolved: ResolvedOption; lines: string[]; rev: string }
  | { ok: false; code: number; body: { code: string; error: string; [k: string]: unknown } };

export const DEPTH_LINES: Readonly<Record<'quick' | 'standard' | 'deep', string>> = {
  quick: 'Depth: quick. Find the likeliest cause and stop there, each claim cited.',
  standard: 'Depth: standard. Find the cause and what led to it, each claim cited.',
  deep: 'Depth: deep. Trace every contributing cause and the timeline, each claim cited.',
};

/** What the engine serves, read as a launch in `projectId` reads it. */
export interface ShapeReads {
  defs(): readonly WorkflowDef[];
  presets(projectId: string | undefined): Promise<Preset[]>;
  entries(): Promise<CatalogEntry[]>;
}

/** The catalog could not be read: a shaped launch or proposal fails closed (it could not see a saved shadow the engine
 *  would run). */
export class CatalogUnavailableError extends Error {}

export async function servedFor(reads: ShapeReads, projectId: string | undefined): Promise<ServedState & { rev: string }> {
  let presets: Preset[];
  let entries: CatalogEntry[];
  try {
    [presets, entries] = await Promise.all([reads.presets(projectId), reads.entries()]);
  } catch (err) {
    throw new CatalogUnavailableError(`the catalog could not be read (${err instanceof Error ? err.message : String(err)}); nothing was started`);
  }
  const input = { defs: reads.defs(), presets, entries };
  const rev = buildWorkflowCatalogV2({ ...input, runs: [], actorId: '', projectId: projectId ?? null }).rev;
  return { ...servedState(input), rev };
}

/** The lines crew puts first in the brief for a resolved shape. */
export function briefLines(r: ResolvedOption, depth: LaunchShape['depth']): string[] {
  const lines: string[] = [];
  if (r.resolved.brief !== null && r.resolved.brief.trim() !== '') lines.push(r.resolved.brief.trim());
  if (depth !== null && r.card.depth === true) lines.push(DEPTH_LINES[depth]);
  return lines;
}

/** The words with the shape's lines first (once). */
export function withBriefLines(words: string, lines: readonly string[]): string {
  if (lines.length === 0) return words;
  const head = lines.join('\n');
  return words.startsWith(head) ? words : `${head}\n\n${words}`;
}

/** Judge a launch's shape against the current catalog and the route's own target. */
export function checkLaunchShape(shape: LaunchShape, target: LaunchTarget, served: ServedState & { rev: string }): ShapeVerdict {
  const r = resolveOption(shape.card, shape.option, served);
  const mismatch = (why: string): ShapeVerdict => ({ ok: false, code: 400, body: { code: 'shape_mismatch', error: `shape ${shape.card}${shape.option !== null ? ` · ${shape.option}` : ''}: ${why}` } });
  if (r === null) return mismatch('no such card or option in the catalog');
  if (shape.depth !== null && r.card.depth !== true) return mismatch('this card takes no depth');
  const launch = r.resolved.launch;
  if (launch.kind !== target.kind) return mismatch(`it launches as ${launch.kind}, and this route launches ${target.kind}`);
  if (launch.kind === 'run' && target.kind === 'run' && launch.workflow !== target.workflow) {
    return mismatch(`it runs ${launch.workflow}, and this launch names ${target.workflow ?? 'no workflow'}`);
  }
  if (launch.kind === 'document' && target.kind === 'document' && launch.style !== target.style) {
    return mismatch(`it makes a ${launch.style} document, and this launch makes ${target.style}`);
  }
  if (r.resolved.status !== 'available') {
    return {
      ok: false,
      code: 409,
      body: {
        code: 'card_not_available',
        error: `${r.card.title} can't start here${r.resolved.statusNote !== null ? `: ${r.resolved.statusNote}` : ''}`,
        nearest: r.card.nearest ?? null,
      },
    };
  }
  if (shape.guess?.band === 'ask') {
    return { ok: false, code: 409, body: { code: 'shape_ask', error: 'the detection was unsure: answer its question, then start the job you picked' } };
  }
  if (shape.catalogRev !== served.rev) {
    return { ok: false, code: 409, body: { code: 'catalog_changed', error: 'the catalog changed since this was shown; check the job again before starting it', rev: served.rev } };
  }
  return { ok: true, resolved: r, lines: briefLines(r, shape.depth), rev: served.rev };
}

/** A parsed shape (zod spells an absent optional as `undefined`) as the wire type. */
export function launchShapeOf(s: Omit<LaunchShape, 'guess'> & { guess?: LaunchShape['guess'] | undefined }): LaunchShape {
  const { guess, ...rest } = s;
  return guess === undefined ? rest : { ...rest, guess };
}

/** (api-types 0.192.0) {@link LaunchShape}: optional on every launch route, judged by `workflow-catalog/shape.ts`. */
export const LaunchShapeSchema = z.strictObject({
  card: z.string().trim().min(1).max(80),
  option: z.string().trim().min(1).max(80).nullable(),
  depth: z.enum(['quick', 'standard', 'deep']).nullable(),
  by: z.enum(['person', 'detected']),
  catalogRev: z.string().min(1).max(64),
  guess: z.strictObject({
    confidence: z.number().min(0).max(1),
    band: z.enum(['sure', 'likely', 'ask']),
    source: z.enum(['words', 'classify', 'chat']),
    reason: z.string().max(140),
    detectionRunId: z.string().min(1).max(128).nullable(),
  }).optional(),
});

