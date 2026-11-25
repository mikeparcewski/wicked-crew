/**
 * A demo video's cut as the chat reads it (studio#1140 option (a), crew#1814): `GET /d/<doc>/api/demo/cut` through the
 * project's video tool, the chapter lines of the turn's data section, and crew's note on what the chat can change. No
 * caption words: they reach a seat only with the person's consent (a later slice).
 */
/** The limits the video tool keeps (interactive demo-cut.js `text` and `MAX_SAY`). */
export const CUT_TITLE_MAX = 80;
export const CUT_SAY_MAX = 2000;
export const CUT_OPS_MAX = 20;


// ── reading a cut through the video tool ─────────────────────────────────────────────────────────────────────────────

/** A call to the project's video tool (interactive's bridge): the path is `/d/<doc>/api/...`. */
export type CutBridgeCall = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;

/** A chapter as the seat and the card see it: no caption words (they are shared only with the person's consent). */
export interface CutChapter {
  id: string;
  title: string;
  startSec: number;
  durationSec: number;
  inSec: number;
  outSec: number;
  /** The length of the chapter's recording (its take), when the cut lists it. */
  takeSec: number | null;
}

export interface CutRead {
  head: number;
  version: number;
  title: string;
  chapters: CutChapter[];
}

/** Why a cut can't be changed from chat now, in words for the seat and the card. */
export type CutUnavailable = { state: 'unavailable'; why: string; gone?: true };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Words for a video tool too old for the chat's changes (an adopted `wicked-interactive serve` nobody recorded). */
export const CUT_OLD_TOOL = "This computer's video tool is older than this studio needs. Stop the `wicked-interactive serve` you started, then try again.";

/** `s` without its closing full stop (or !, ? or …), so a sentence that quotes it ends once. */
export const unended = (s: string): string => s.trim().replace(/[.!?…]+$/u, '').trimEnd();

/** The sentence for a video tool that didn't answer, from its error: on one line, one full stop, and no ": ." when it
 *  said nothing (or only punctuation). */
export function toolNotRunning(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).replace(/\s+/gu, ' ').replace(/[\s.!?…:;,]+$/u, '').trim();
  const why = /[\p{L}\p{N}]/u.test(raw) ? raw : '';
  return why === '' ? "The video tool isn't running here." : `The video tool isn't running here: ${why}.`;
}

/** `GET /d/<doc>/api/demo/cut`, as the seat and the card read it. */
export async function readCut(call: CutBridgeCall, doc: string): Promise<CutRead | CutUnavailable> {
  let res: { status: number; body: Record<string, unknown> };
  try {
    res = await call('GET', `/d/${encodeURIComponent(doc)}/api/demo/cut`);
  } catch (err) {
    return { state: 'unavailable', why: toolNotRunning(err) };
  }
  const b = res.body;
  if (res.status === 410) return { state: 'unavailable', why: 'This video was deleted.', gone: true };
  if (res.status === 409 && b['error'] === 'cut_unverified') {
    return { state: 'unavailable', why: "This video's history predates kept cuts, so it can't be changed here. Record it again to edit it." };
  }
  if (res.status === 404) return { state: 'unavailable', why: "This document isn't a video cut any more." };
  if (res.status !== 200) return { state: 'unavailable', why: `The video tool couldn't read this video (${res.status}${typeof b['error'] === 'string' ? `: ${b['error']}` : ''}).` };
  // An older video tool answers without the document's head (S6): it can't take the chat's changes.
  if (!Number.isInteger(b['head']) || !Number.isInteger(b['version']) || !Array.isArray(b['chapters'])) return { state: 'unavailable', why: CUT_OLD_TOOL };
  const takes = (b['takes'] ?? {}) as Record<string, unknown>;
  const chapters: CutChapter[] = [];
  for (const raw of b['chapters'] as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (typeof c['id'] !== 'string' || typeof c['title'] !== 'string') continue;
    const list = Array.isArray(takes[c['id']]) ? (takes[c['id']] as Array<Record<string, unknown>>) : [];
    const take = list.find((t) => t !== null && typeof t === 'object' && t['file'] === c['take']);
    chapters.push({
      id: c['id'],
      title: c['title'],
      startSec: num(c['startSec']) ? c['startSec'] : 0,
      durationSec: num(c['durationSec']) ? c['durationSec'] : 0,
      inSec: num(c['inSec']) ? c['inSec'] : 0,
      outSec: num(c['outSec']) ? c['outSec'] : 0,
      takeSec: take !== undefined && num(take['durationSec']) ? take['durationSec'] : null,
    });
  }
  const style = b['style'] as { theme?: { titleCard?: { title?: unknown } } } | undefined;
  const title = typeof style?.theme?.titleCard?.title === 'string' && style.theme.titleCard.title.trim() !== '' ? style.theme.titleCard.title : '';
  return { head: b['head'] as number, version: b['version'] as number, title, chapters };
}

/** Why the head the person sees can't be changed from chat, or `null` when it can. */
export function headProblem(cut: CutRead): string | null {
  if (cut.version !== cut.head) return "The latest version of this video isn't a cut, so it can't be changed here. Restore a cut version from Versions first.";
  return null;
}

// ── what the seat is told ────────────────────────────────────────────────────────────────────────────────────────────

const tenths = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);
const secs = (n: number): string => `${tenths(n)} s`;

/** The chapter lines of the turn's data section (ids, titles, where each sits, its In and Out, its recording). */
export function cutDataLines(cut: CutRead): string[] {
  return cut.chapters.map((c, i) =>
    `${i + 1}. id \`${c.id}\` · “${c.title}” · at ${secs(c.startSec)} for ${secs(c.durationSec)} · uses ${tenths(c.inSec)}-${secs(c.outSec)} of its recording` +
      (c.takeSec !== null ? ` (${secs(c.takeSec)} long)` : ''));
}

/**
 * Crew's note on an open video the chat can change, outside the data section (it is crew's instruction, not data). It
 * states the block, the five changes and their limits, how new words should sound, and that the card changes nothing
 * until the person presses Go.
 */
export function cutChangeNote(ref: string, state: { viewed: number; head: number } | { why: string }): string[] {
  const out = ["## Crew's note on the video they have open", '', 'Written by crew, not by the person or studio.', ''];
  if ('why' in state) {
    out.push(`- \`${ref}\` is a demo video, and this chat can't change it now: ${state.why} Say so plainly if they ask for a change, and never say it changed.`, '');
    return out;
  }
  if (state.viewed !== state.head) {
    out.push(
      `- \`${ref}\` is a demo video. They are looking at version ${state.viewed}; only the latest (version ${state.head}) can be changed. ` +
        'If they ask for a change, tell them to open the latest and ask again. Propose no change to this video.',
      '',
    );
    return out;
  }
  out.push(
    `- \`${ref}\` is a demo video at version ${state.head}. This chat can change it, but only through a card the person approves: end your reply with one block`,
    '',
    '```wicked-make',
    `{"cut":{"ref":"${ref}","ops":[{"op":"chapter-drop","chapter":"<id>"}]},"reason":"<one line>"}`,
    '```',
    '',
    '- The ops (1 to 20, applied in order; chapter ids are in the chapter list below):',
    '  - `{"op":"chapter-drop","chapter":id}` takes a chapter out of the video (its recording is kept, so Undo brings it back; one chapter must stay).',
    '  - `{"op":"chapter-move","chapter":id,"after":id or null}` moves it after another chapter (`null` = to the start).',
    `  - \`{"op":"chapter-rename","chapter":id,"title":text}\` renames it (one line, at most ${CUT_TITLE_MAX} characters).`,
    '  - `{"op":"chapter-trim","chapter":id,"inSec":n,"outSec":n}` keeps that part of its own recording (inside the recording, at least 0.5 s).',
    `  - \`{"op":"chapter-say","chapter":id,"say":text}\` sets its caption words (one line, at most ${CUT_SAY_MAX} characters; "" = no caption).`,
    '- Propose only what they asked for. Never propose a `refine` of a video. The card changes nothing until they press Go: never say the video changed.',
    "- You can't see the current caption words. For new words they give you, use `chapter-say`. To edit the existing words (shorten them, fix a typo), ask them for the exact new words.",
    "- New captions and chapter names are heard or read by the viewer, so write them the way a person talks while showing a screen: talk to the viewer (you, we), use contractions, say why before what, and keep it short. No slogans (\"X, not Y\"), no colon headlines, no product-as-subject lines, no filler like seamless or robust. Read it aloud: if you wouldn't say it to someone beside you, rewrite it. (The same rules as the demo skill's Captions and voice.)",
    '',
  );
  return out;
}
