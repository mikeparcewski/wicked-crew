/**
 * CHANGE A DEMO VIDEO FROM ITS CHAT (studio#1140 option (a), crew#1814, DES-1140A + DES-B7-VIDEO). A seat asked to drop,
 * move, rename or trim a chapter of the video open in the chat, or to set a chapter's caption words, ends its reply
 * with a `wicked-make` block `{"cut":{"ref":"<mount>/<doc>","ops":[…]}}`. Crew, never the seat, resolves it into a `cut`
 * card ({@link resolveCut}): the ops frozen, crew's words for each, and the video's head the seat read (`target.base`).
 * Only the person's Go reaches {@link CutLauncher}, which posts those ops to the video tool's recut once, with
 * `expect_head = base` and the Go's identity as `request_id`; the video tool folds, checks and renders them (ffmpeg),
 * inside the document's queue. A video that changed since blocks the card: nothing is ever applied to a version the
 * seat did not read.
 */
import { z } from '../zod.js';
import type { ArtifactProposal, CutOp, ProposalCut, ChatContextBinding } from '../core/types.js';
import { LaunchRefusal, type ProposalDispatch, type ProposalDispatcher } from './chat-proposals.js';
import { ARTIFACT_REF, parseArtifactRef } from './chat-context.js';
import { CUT_OLD_TOOL, CUT_OPS_MAX, CUT_SAY_MAX, CUT_TITLE_MAX, headProblem, readCut, unended, type CutBridgeCall, type CutRead, type CutUnavailable } from './cut-read.js';

/** Words longer than this give no card at all (S7): resolve checks the real limits and says why below it. */
const PARSE_TEXT_MAX = 4000;

const ChapterId = z.string().min(1).max(64);
const Seconds = z.number().min(-86_400).max(86_400);
const CutOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('chapter-rename'), chapter: ChapterId, title: z.string().max(PARSE_TEXT_MAX) }),
  z.strictObject({ op: z.literal('chapter-move'), chapter: ChapterId, after: ChapterId.nullable() }),
  z.strictObject({ op: z.literal('chapter-trim'), chapter: ChapterId, inSec: Seconds, outSec: Seconds }),
  z.strictObject({ op: z.literal('chapter-say'), chapter: ChapterId, say: z.string().max(PARSE_TEXT_MAX) }),
  z.strictObject({ op: z.literal('chapter-drop'), chapter: ChapterId }),
]);

export const CutBlock = z.object({
  cut: z.strictObject({
    ref: z.string().regex(ARTIFACT_REF),
    ops: z.array(CutOpSchema).min(1).max(CUT_OPS_MAX),
  }),
  reason: z.string().max(600).optional(),
});
export type CutBlockBody = z.infer<typeof CutBlock>;

// ── the card ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const quote = (s: string): string => `“${s}”`;

/** Crew's words for one op, from the cut the seat read. */
export function changeWords(op: CutOp, cut: CutRead): string {
  const name = (id: string): string => quote(cut.chapters.find((c) => c.id === id)?.title ?? id);
  switch (op.op) {
    case 'chapter-drop': return `Drop ${name(op.chapter)} (Undo brings it back)`;
    case 'chapter-move': return op.after === null ? `Move ${name(op.chapter)} to the start` : `Move ${name(op.chapter)} to after ${name(op.after)}`;
    case 'chapter-rename': return `Rename ${name(op.chapter)} to ${quote(op.title)}`;
    case 'chapter-trim': {
      const c = cut.chapters.find((x) => x.id === op.chapter);
      const was = c === undefined ? '' : ` (was ${c.inSec.toFixed(1)}-${c.outSec.toFixed(1)} s)`;
      return `Trim ${name(op.chapter)} to ${op.inSec.toFixed(1)}-${op.outSec.toFixed(1)} s of its recording${was}`;
    }
    case 'chapter-say': return op.say === '' ? `Caption of ${name(op.chapter)} → no caption` : `Caption of ${name(op.chapter)} → ${quote(op.say)}`;
  }
}

/** Why a card can't offer Go, checked against the cut the seat read (what the video tool would surely refuse); `null`
 *  = nothing crew can tell. Trim bounds and fold order stay the video tool's (it says why at Go). */
export function opsProblem(ops: readonly CutOp[], cut: CutRead): string | null {
  const ids = new Set(cut.chapters.map((c) => c.id));
  for (const op of ops) {
    if (!ids.has(op.chapter)) return `There's no chapter ${quote(op.chapter)} in this video.`;
    if (op.op === 'chapter-move' && op.after !== null && !ids.has(op.after)) return `There's no chapter ${quote(op.after)} in this video.`;
    if (op.op === 'chapter-rename' && (op.title.length > CUT_TITLE_MAX || /[\r\n]/u.test(op.title) || op.title.trim() === '')) {
      return `A chapter name is one line of 1 to ${CUT_TITLE_MAX} characters.`;
    }
    if (op.op === 'chapter-say' && (op.say.length > CUT_SAY_MAX || /[\r\n]/u.test(op.say))) return `A caption is one line of at most ${CUT_SAY_MAX} characters.`;
  }
  return null;
}

export interface CutTurn {
  pid: string;
  chatId: string;
  turnId: string;
  seat: string;
  /** The turn's own context record (`null` when this turn carried none). */
  binding: ChatContextBinding | null;
  projectId: string | null;
  filedInLabel: string;
}

export interface CutResolveDeps {
  /** The project's video tool, or `null` when the project has no docs root here. */
  bridgeFor(projectId: string): Promise<CutBridgeCall | null>;
}

/** The block → a `cut` card. Everything that can't be offered blocks Go with crew's words. */
export async function resolveCut(block: CutBlockBody, turn: CutTurn, deps: CutResolveDeps): Promise<ArtifactProposal> {
  const ref = parseArtifactRef(block.cut.ref)!;
  const open = turn.binding?.artifact;
  const title0 = open !== undefined && open.ref === ref.ref ? open.title : ref.doc;
  let blocked: string | null = null;
  let read: CutRead | null = null;
  if (open === undefined || open.ref !== ref.ref) blocked = `${quote(ref.doc)} isn't the video open here.`;
  else if (open.viewed !== open.head) blocked = `You're looking at version ${open.viewed}. Only the latest (version ${open.head}) can be changed: open it and ask again.`;
  else {
    // The video tool not starting (or too old to adopt) blocks the card with why, never drops it.
    const call = await deps.bridgeFor(ref.projectId).catch((err: unknown) => new Error(err instanceof Error ? err.message : String(err)));
    const got = call instanceof Error ? ({ state: 'unavailable', why: `The video tool isn't running here: ${unended(call.message)}.` } as CutUnavailable)
      : call === null ? ({ state: 'unavailable', why: 'This video is no longer on this daemon.', gone: true } as CutUnavailable) : await readCut(call, ref.doc);
    if ('state' in got) blocked = got.why;
    else if (got.head !== open.head) blocked = `The video changed while I was answering (now version ${got.head}). Ask again to change the new version.`;
    else blocked = headProblem(got) ?? opsProblem(block.cut.ops, got);
    if (!('state' in got)) read = got;
  }
  const title = read !== null && read.title !== '' ? read.title : title0;
  const ops = block.cut.ops as CutOp[];
  const cut: ProposalCut = { ops, changes: read !== null ? ops.map((op) => changeWords(op, read)) : ops.map((op) => `${op.op} ${op.chapter}`) };
  return {
    pid: turn.pid, chatId: turn.chatId, turnId: turn.turnId, kind: 'cut', seat: turn.seat,
    what: { entry: null, title, label: `Change the video · ${title}`, outcome: 'A new version of the video. Earlier versions stay in Versions.' },
    brief: null,
    reason: block.reason ?? null,
    sources: [],
    repos: [],
    helpers: null,
    time: null,
    stops: null,
    filedIn: { projectId: turn.projectId, label: turn.filedInLabel },
    target: { ref: ref.ref, title, base: open?.head ?? 0 },
    cut,
    blocked,
  };
}

// ── Go ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The refusal codes that block a cut card (never re-open it for Go). */
export const CUT_BLOCKING = new Set(['cut_moved', 'cut_refused', 'cut_gone']);

/** Words for the video tool's refusal of op `field` (`ops.<i>.<key>`) with `reason`, from the ops on the card. */
export function refusalWords(field: string, reason: string | undefined, ops: readonly CutOp[], changes: readonly string[]): string {
  const m = /^ops\.(\d+)(?:\.(\w+))?$/u.exec(field);
  const i = m === null ? -1 : Number(m[1]);
  // A change's own words can end in a parenthesis ("Drop “Setup” (Undo brings it back)"): drop it, never "))".
  const which = i >= 0 && i < ops.length ? `Change ${i + 1} (${(changes[i] ?? ops[i]!.op).replace(/\s*\([^()]*\)$/u, '')})` : 'A change';
  const why = ((): string => {
    switch (reason) {
      case 'dropped': return 'it names a chapter an earlier change drops';
      case 'unknown': return "it names a chapter this video doesn't have";
      case 'self': return "a chapter can't move after itself";
      case 'last_chapter': return 'one chapter has to stay in the video';
      case 'out_of_take': return 'a trim has to stay inside the chapter’s recording';
      case 'too_short': return 'a trim has to keep at least 0.5 s';
      case 'format': return 'it isn’t written the way the video tool takes it';
      case 'unsupported': return "the video tool here doesn't know that change";
      default: return 'the video tool refused it';
    }
  })();
  return `${which} can't be made: ${why}. Nothing changed. Ask again.`;
}

export interface CutLauncherDeps {
  bridgeFor(projectId: string): Promise<CutBridgeCall | null>;
}

/**
 * Go on a `cut` card: posts the frozen ops to the video tool's recut once (`request_id` = the Go's identity, so a retry
 * adopts the version the first Go made). `find` answers whether that request already made a version (or is still
 * rendering: 409 `cut_pending`, nothing decided).
 */
export class CutLauncher implements ProposalDispatcher {
  constructor(private readonly deps: CutLauncherDeps) {}

  private async callFor(ref: string): Promise<{ call: CutBridgeCall; doc: string }> {
    const r = parseArtifactRef(ref);
    if (r === null) throw new LaunchRefusal(409, { code: 'cut_gone', error: 'This video is no longer on this daemon.' });
    let call: CutBridgeCall | null;
    try {
      call = await this.deps.bridgeFor(r.projectId);
    } catch (err) {
      if (err instanceof LaunchRefusal) throw err;
      throw new Error(`The video tool isn't running here: ${unended(err instanceof Error ? err.message : String(err))}.`);
    }
    if (call === null) throw new LaunchRefusal(409, { code: 'cut_gone', error: 'This video is no longer on this daemon.' });
    return { call, doc: r.doc };
  }

  async find(identity: { artifactRef: string | null; runId: string }): Promise<false | { version: number }> {
    if (identity.artifactRef === null) return false;
    const { call, doc } = await this.callFor(identity.artifactRef);
    const res = await call('GET', `/d/${encodeURIComponent(doc)}/api/demo/cut?request_id=${encodeURIComponent(identity.runId)}`);
    if (res.status === 404) return false;
    if (res.status === 410) throw new LaunchRefusal(409, { code: 'cut_gone', error: 'This video was deleted.' });
    if (res.status === 202) {
      throw new LaunchRefusal(409, { code: 'cut_pending', error: 'Still making the new version. It shows here when it is done.' });
    }
    // An older video tool ignores the query and answers the whole cut: never read as found (R7, F14).
    if (res.status === 200 && res.body['request_id'] === identity.runId && Number.isInteger(res.body['version'])) return { version: res.body['version'] as number };
    if (res.status === 200) throw new Error(CUT_OLD_TOOL);
    throw new Error(`The video tool couldn't say whether the change was made (it answered ${res.status}).`);
  }

  async launch(d: ProposalDispatch): Promise<{ version: number }> {
    const card = d.resolution.cut;
    const target = d.resolution.target;
    if (d.kind !== 'cut' || card === undefined || target === undefined) throw new Error(`the cut launcher takes only a cut proposal (got ${d.kind})`);
    const { call, doc } = await this.callFor(target.ref);
    let res: { status: number; body: Record<string, unknown> };
    try {
      res = await call('POST', `/d/${encodeURIComponent(doc)}/api/demo/recut`, { expect_head: target.base, ops: card.ops, request_id: d.identity.runId });
    } catch (err) {
      // A timeout or a lost connection: the render may still finish (Go again asks first).
      throw new Error(`I lost track of the new version while it was being made (${err instanceof Error ? err.message : String(err)}). Go again checks whether it finished.`);
    }
    const b = res.body;
    if (res.status === 200 && Number.isInteger(b['version'])) return { version: b['version'] as number };
    if (res.status === 409 && b['error'] === 'head_moved') {
      const now = Number.isInteger(b['head']) ? ` (now version ${b['head'] as number})` : '';
      throw new LaunchRefusal(409, { code: 'cut_moved', error: `The video changed since this was proposed${now}. Ask again to change the new version.` });
    }
    if (res.status === 410) throw new LaunchRefusal(409, { code: 'cut_gone', error: 'This video was deleted.' });
    if (res.status === 400 && b['error'] === 'invalid_body' && typeof b['field'] === 'string' && b['field'].startsWith('ops')) {
      throw new LaunchRefusal(422, { code: 'cut_refused', error: refusalWords(b['field'], typeof b['reason'] === 'string' ? b['reason'] : undefined, card.ops, card.changes) });
    }
    if (res.status === 400 && b['error'] === 'ffmpeg_missing') {
      throw new Error(`The new version couldn't be made: ffmpeg isn't installed. ${typeof b['hint'] === 'string' ? b['hint'] : 'Install ffmpeg.'} Nothing changed.`);
    }
    if (res.status === 400 && b['error'] === 'ffmpeg_failed') {
      // The tool's last stderr line, without its own end mark: the sentence ends once (R2 C1).
      const detail = typeof b['detail'] === 'string' ? unended(b['detail'].trim().split('\n').pop()!.slice(0, 200)) || 'the encoder failed' : 'the encoder failed';
      throw new Error(`The new version couldn't be made: ${detail}. Nothing changed.`);
    }
    if ((res.status === 409 && (b['error'] === 'cut_unverified' || b['error'] === 'cut_document')) || (res.status === 404 && b['error'] === 'no_cut')) {
      throw new LaunchRefusal(409, { code: 'cut_refused', error: typeof b['message'] === 'string' ? b['message'] : "This video can't be changed here." });
    }
    throw new Error(`The new version couldn't be made (the video tool answered ${res.status}${typeof b['error'] === 'string' ? `: ${unended(b['error'])}` : ''}). Nothing changed.`);
  }
}

/**
 * The words a cut Go that didn't finish ends on (crew#1814 R2 C1): crew's own sentence as written, ended, then what Go
 * again does, unless the sentence already says it. Never a run's words ("start it", "the same job") on a video card.
 */
export function cutInterruptedWords(msg: string): string {
  const s = msg.trim();
  const said = /[.!?]$/u.test(s) ? s : `${s}.`;
  return /\b(Go again|try again|Ask again)\b/u.test(said) ? said : `${said} Go again to try once more.`;
}

/** A quoted fragment without its own trailing end marks, so crew's sentence around it ends once. */
