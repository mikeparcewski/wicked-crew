/**
 * The recording views (DES-walkthrough-proof §4.10: `api/demo.ts` renamed `api/recording.ts`) — the
 * Demo experience and the walkthrough, which share `parseChapters`, `parseMarkers` and
 * `containedPath`.
 *
 * ## Demo
 *
 * The Demo experience (wicked-studio#373, migration M9b): a demo of a local app, made by a governed
 * run of the built-in `demo` preset — the wicked-garden demo skill's plan → record → review.
 *
 *   POST /projects/:id/demo        mints the run's DEMO ROOT (a per-run directory on the daemon host),
 *                                  writes the brief there, and launches `demo` THROUGH `POST /runs`
 *                                  (one launch path), with the root as the run's only extra write root.
 *   GET  /runs/:id/demo            what studio shows: the stage, the presenter script and chapter list
 *                                  (the plan gate), per-chapter record progress, the contact sheets and
 *                                  the reviewer's verdicts (the review gate), and the chaptered MP4.
 *   GET  /runs/:id/demo/file       one file of the root (a contact sheet, the MP4 — with Range).
 *   PUT  /runs/:id/demo/script     the presenter's edit of `script.md` while the plan gate is open.
 *   POST /runs/:id/demo/export     a GIF (`demo-video/demo.gif`) or a poster frame (`demo-video/poster.jpg`)
 *                                  of the stitched MP4, encoded by ffmpeg with an ASYNC spawn and a
 *                                  timeout (EP-C3): the daemon keeps answering while it encodes.
 *
 * The gates are the run's ordinary gates (`POST /runs/:id/gate`): approve, or `request_changes` with a
 * note — at the plan gate it re-runs `plan`, at the review gate it rewinds to `record` (re-record one
 * chapter). Nothing here decides a gate.
 *
 * Every file is read from the root the daemon minted for THIS run id, never from a path a caller or a
 * worker names: `path` is resolved inside it, symlinks included, and only the deliverable types studio
 * renders are served.
 *
 * ## Walkthrough (WT-W1)
 *
 * Every repo-bound run gets an EVIDENCE ROOT (`walkthroughRootDir`, minted by `CoreAdapter.launchRun`
 * and persisted by the engine as `session.evidence_root`). Under it, `author/<plan step>/` is the
 * walkthrough author's write dir and `<review step>/` is the PROOF ROOT only the jailed
 * `walkthrough_review` Tool writes.
 *
 *   GET  /runs/:id/walkthrough?step=             the `WalkthroughView` of the newest (or the named) pair.
 *   GET  /runs/:id/walkthrough/file?step=&path=  one file of that pair's proof root (Range for the MP4).
 *   GET  /runs/:id/walkthrough/storyline?step=   the author's storyline, for "Edit the check" (#782).
 *
 * What the view reads from a proof root (the recorder's files, DES-walkthrough-proof §4.4):
 *
 *   result.json      `{overall, cause?, reason?, tree?, chapters: [{key, title?, verdict, takes?,
 *                    failed_at_sec?, failed_frame?, proves?, legs?, checks?: [{id, kind, sentence,
 *                    passed, at_sec, evidence?, vault_entry?, detail?}]}]}` — the engine itself writes
 *                    `{overall: INCONCLUSIVE, cause, reason, chapters: []}` when it cannot record.
 *   progress.json    `{state: 'starting_app' | 'recording' | 'judging', chapter?}` while it runs.
 *   chapters.json    the chapter list (the demo shape), before the judge has written verdicts.
 *   demo-video/      `demo.mp4`, `poster.jpg`, `chapters.md` (markers), `segments/<key>/segment.mp4`.
 *
 * The proof root is read only when it is a plain directory directly under the evidence root (a link
 * planted at the step path is never followed — the engine's `check_proof_root` rule), and every file
 * inside it through `containedPath`.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  DemoChapter,
  DemoExportFormat,
  DemoExportResponse,
  DemoFinding,
  DemoMarker,
  DemoStage,
  DemoView,
  WalkthroughChapter,
  WalkthroughCheck,
  WalkthroughLeg,
  WalkthroughState,
  WalkthroughVerdict,
  WalkthroughView,
} from 'wicked-crew-api-types';
import type { CoreAdapter } from '../core/adapter.js';
import type { Actor, PutStorylineResponse, SessionView, WalkthroughStorylineView, WorkUnit } from '../core/types.js';
import { childEnvWithBootEstateDb } from '../core/governance-store.js';
import { API_PREFIX } from './api-prefix.js';
import { coreUnitId } from './evidence.js';
import { stepIdOf, WALKTHROUGH_AUTHOR_SUBDIR, walkthroughProofRoot } from '../core/walkthrough-root.js';
import { LOCAL_ACTOR } from './auth.js';
import type { AuditLog } from './audit.js';
import { pairRemovedByOverride, resolveWalkthroughGate, walkthroughCheckStates, type WalkthroughGate } from '../qe/walkthrough-acceptance.js';
import type { WalkthroughStepState } from 'wicked-crew-api-types';

const V = API_PREFIX;

/** The preset a demo run launches (wicked-core `builtin_presets`). */
export const DEMO_PRESET = 'demo';

/** Studio's Unfiled mount (`/p/default/…`): the daemon's synthesized project, never a launch's `projectId`. */
const UNFILED_PROJECT = 'default';

/** The biggest script studio shows or accepts back: a presenter script is prose. */
export const DEMO_SCRIPT_MAX_BYTES = 256 * 1024;

/** What `/demo/file` serves, by extension — the deliverables studio renders, nothing else. */
const DEMO_FILE_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Where a demo run's files live: one directory per run, outside every sandbox and state home. */
export function demoRootDir(runId: string): string {
  if (process.env.WICKED_DEMO_DIR) return join(process.env.WICKED_DEMO_DIR, runId);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return join(home, '.wicked', 'demos', runId);
}

/**
 * The demo root of each demo launch in flight, keyed by the run id the demo route minted. `POST /runs`
 * takes no write roots from its body; it reads this in-process entry, so the root is never something a
 * caller can ask for (the capture route's pattern).
 */
export const demoLaunchRoots = new Map<string, string>();

export const DemoLaunchSchema = z
  .object({
    url: z.string().trim().url().max(2048).refine((u) => /^https?:\/\//i.test(u), 'url must be http(s)'),
    audience: z.string().trim().min(1).max(2000),
    show: z.string().trim().min(1).max(4000),
    clisJson: z.string().optional(),
  })
  .strict();

export const DemoScriptSchema = z.object({ content: z.string().min(1) }).strict();

export const DemoExportSchema = z
  .object({
    format: z.enum(['gif', 'poster']),
    /** The poster's frame, in seconds from the start. Poster only. */
    atSec: z.number().finite().min(0).max(24 * 60 * 60).optional(),
  })
  .strict()
  .refine((b) => b.format === 'poster' || b.atSec === undefined, { message: '`atSec` applies to a poster only', path: ['atSec'] });

/**
 * How long one encode may run before it is killed (EP-C3). A GIF re-encodes the whole video (the bound
 * interactive's encoder uses); a poster decodes one frame. Mutable only so a test can shorten it.
 */
export const DEMO_EXPORT_TIMEOUT_MS: Record<DemoExportFormat, number> = { gif: 180_000, poster: 30_000 };

/** Interactive's GIF filter (`src/service/demo.js` `ffmpegGifEncoder`): two-pass palette so colours do not band, 10 fps, 720 px. */
export const DEMO_GIF_FILTER =
  'fps=10,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3';

/** The stages an export may run in: no worker of the run is running, so none can write the root. */
const DEMO_EXPORT_STAGES: ReadonlySet<DemoStage> = new Set<DemoStage>(['review_gate', 'done', 'failed']);

/** What each export writes, inside the run's `demo-video/`. */
const DEMO_EXPORT_FILE: Readonly<Record<DemoExportFormat, string>> = { gif: 'demo.gif', poster: 'poster.jpg' };

export const DEMO_FFMPEG_HINT =
  'install ffmpeg (e.g. `brew install ffmpeg` / `apt install ffmpeg`) on the daemon host, or set WICKED_FFMPEG to its path';

type FfmpegOutcome =
  | { kind: 'ok' }
  | { kind: 'missing' }
  | { kind: 'timeout' }
  | { kind: 'failed'; code: number | null; stderr: string };

/**
 * Run ffmpeg without blocking the event loop: an async `spawn`, its stderr tail kept for the error,
 * SIGKILL past `timeoutMs`. Never `spawnSync` (review N6: a 180 s synchronous encode would stall
 * every route the daemon serves, `/health` included).
 */
export function runFfmpeg(args: string[], timeoutMs: number): Promise<FfmpegOutcome> {
  const bin = process.env.WICKED_FFMPEG || 'ffmpeg';
  return new Promise((resolveOutcome) => {
    let settled = false;
    const settle = (o: FfmpegOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(o);
    };
    let stderr = '';
    // crew#495: no child of the daemon inherits a daemon-exported governance store.
    const child = spawn(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: childEnvWithBootEstateDb(process.env),
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ kind: 'timeout' });
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(err.code === 'ENOENT' || err.code === 'EACCES' ? { kind: 'missing' } : { kind: 'failed', code: null, stderr: err.message });
    });
    child.on('close', (code) => {
      settle(code === 0 ? { kind: 'ok' } : { kind: 'failed', code, stderr });
    });
  });
}

/** One export's HTTP answer. */
type DemoExportAnswer = { status: number; body: DemoExportResponse | { error: string; hint?: string } };

/**
 * Encode one export of a run's stitched MP4. The run's workers can write its demo root, so ffmpeg never
 * touches it: the MP4 is copied into a daemon-private staging directory, encoded there, and only the
 * finished file is published back, after `stillExportable` confirms the run has not resumed (a review
 * gate answered with `request_changes` during the encode re-opens `record`) and `demo-video/` still
 * resolves where it did. Publication is an exclusive copy to a fresh name inside `demo-video/` and a
 * rename, so a half-written export is never served and a failed or killed encode leaves nothing behind.
 */
async function encodeDemoExport(
  runId: string,
  format: DemoExportFormat,
  atSec: number | undefined,
  stillExportable: () => Promise<boolean>,
): Promise<DemoExportAnswer> {
  const root = demoRootDir(runId);
  const input = await containedPath(root, 'demo-video/demo.mp4');
  const inputSize = input === null ? null : await fsp.stat(input).then((st) => (st.isFile() ? st.size : null), () => null);
  if (input === null || inputSize === null || inputSize === 0) {
    return { status: 409, body: { error: 'this demo has no stitched demo-video/demo.mp4 yet' } };
  }
  // The output directory is resolved on its own, not from the input: an in-root symlink
  // `demo-video/demo.mp4 -> ../elsewhere/x.mp4` must not move the export away from the path served.
  const outDir = await containedPath(root, 'demo-video');
  if (outDir === null) return { status: 409, body: { error: 'this demo has no demo-video/ directory' } };
  const name = DEMO_EXPORT_FILE[format];
  const ext = extname(name);
  const staging = await fsp.mkdtemp(join(tmpdir(), 'wicked-crew-demo-export-'));
  const source = join(staging, 'source.mp4');
  const encoded = join(staging, `export${ext}`);
  let published: string | null = null;
  try {
    await fsp.copyFile(input, source);
    // The input is read as an MP4 and nothing else, from the local file alone: a worker-written
    // `demo.mp4` that is really a playlist (HLS, concat) naming media outside the root is refused by the
    // demuxer instead of followed with the daemon's permissions.
    const demux = ['-f', 'mov', '-protocol_whitelist', 'file', '-i', source];
    let args: string[];
    let at: number | undefined;
    if (format === 'gif') {
      args = ['-y', ...demux, '-vf', DEMO_GIF_FILTER, '-loop', '0', encoded];
    } else {
      // Default: one second into the first chapter (the title card is past), or 1 s with no markers.
      at = atSec ?? (parseMarkers(await readText(root, 'demo-video/chapters.md'))[0]?.sec ?? 0) + 1;
      args = ['-y', '-ss', String(at), ...demux, '-frames:v', '1', '-q:v', '3', '-update', '1', encoded];
    }
    const outcome = await runFfmpeg(args, DEMO_EXPORT_TIMEOUT_MS[format]);
    if (outcome.kind === 'missing') {
      return { status: 503, body: { error: 'ffmpeg not found on the daemon host', hint: DEMO_FFMPEG_HINT } };
    }
    if (outcome.kind === 'timeout') {
      return { status: 504, body: { error: `the ${format} encode ran past ${DEMO_EXPORT_TIMEOUT_MS[format] / 1000} s and was stopped` } };
    }
    if (outcome.kind === 'failed') {
      return { status: 502, body: { error: `ffmpeg failed (exit ${outcome.code}): ${outcome.stderr.trim().slice(-300)}` } };
    }
    const bytes = await fsp.stat(encoded).then((st) => (st.isFile() ? st.size : 0), () => 0);
    if (bytes === 0) {
      return {
        status: 422,
        body: { error: at !== undefined ? `no frame at ${at} s: the video is shorter` : `ffmpeg wrote no ${format}` },
      };
    }
    if (!(await stillExportable())) {
      return { status: 409, body: { error: 'the run resumed during the encode; the export was discarded' } };
    }
    if ((await containedPath(root, 'demo-video')) !== outDir) {
      return { status: 409, body: { error: 'demo-video/ changed during the encode; nothing was written' } };
    }
    published = join(outDir, `.export-${randomUUID()}${ext}`);
    await fsp.copyFile(encoded, published, fsConstants.COPYFILE_EXCL);
    await fsp.rename(published, join(outDir, name));
    published = null;
    return { status: 200, body: { format, path: `demo-video/${name}`, bytes } };
  } finally {
    if (published !== null) await fsp.rm(published, { force: true });
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

/** The brief the demo run reads (the problem statement stays one short line: worker prompts are capped). */
export function demoBrief(root: string, b: { url: string; audience: string; show: string }): string {
  return [
    '# Demo brief',
    '',
    `- **App:** ${b.url}`,
    `- **Demo root:** ${root} (every file this demo makes goes here, nowhere else)`,
    '',
    '## Who it is for',
    '',
    b.audience,
    '',
    '## What to show',
    '',
    b.show,
    '',
    '## Rules',
    '',
    '- Use the wicked-garden-demo skill: plan, then record, then review.',
    '- Read-only against the app: navigate, hover, scroll, open panels and type, but never submit,',
    '  launch, approve, delete, create, cancel or save. The recorder blocks every write and fails the',
    '  chapter; show a control without pressing it.',
    '- Label synthetic data and simulated systems as such, in the script and on screen.',
    '- Measured numbers are timed on this app; anything else is labelled an estimate.',
    '',
  ].join('\n');
}

/** A demo run: launched from the `demo` preset — read off the engine's plan state, or, before the
 *  launch is scored and `team_plan` exists, off the run's identity (resolved from the launch record). */
export function isDemoRun(view: SessionView): boolean {
  if (view.session.team_plan?.preset === DEMO_PRESET) return true;
  const id = (view.session as { run_identity?: { kind?: unknown; name?: unknown } | null }).run_identity;
  return id?.kind === 'preset' && id.name === DEMO_PRESET;
}

/** The unit for one of the preset's steps (`<run>:plan` …). */
function stepUnit(view: SessionView, step: string): WorkUnit | undefined {
  return view.units.find((u) => u.id === `${view.session.id}:${step}`);
}

/** Where the run stands, in the Demo experience's words. */
export function demoStage(view: SessionView): DemoStage {
  const s = view.session;
  if (s.status === 'completed') return 'done';
  if (s.status === 'failed' || s.status === 'cancelled') return 'failed';
  const cursor = view.units[s.unit_ix];
  const step = cursor?.id.startsWith(`${s.id}:`) ? cursor.id.slice(s.id.length + 1) : undefined;
  const waiting = s.status === 'awaiting_human';
  // A held plan (rev past the accepted one) is the team plan's own approval gate (`plan_approval`),
  // which opens before `plan` has run — never the plan gate, whose script does not exist yet.
  const tp = s.team_plan;
  if (waiting && tp != null && tp.rev > tp.accepted_rev) return 'team_gate';
  if (waiting) {
    // A step's human gate opens once that step is done, with the cursor already on the NEXT unit (the
    // engine's gate reviews unit N from ord N+1): the plan gate sits before `record`, the review gate
    // after `review`. Read which step is done, not where the cursor is.
    const done = (id: string): boolean => stepUnit(view, id)?.status === 'done';
    // After `review`: its own gate when it passed, the engine's escalation gate when it did not.
    if (done('review') || stepUnit(view, 'review')?.status === 'rejected') return 'review_gate';
    // Only while `record` has not started: a record the engine rejected parks at ITS escalation gate,
    // which is no plan gate (the script is not editable once the recorder has run).
    const record = stepUnit(view, 'record')?.status;
    if (done('plan') && (record === 'pending' || record === 'distributed')) return 'plan_gate';
  }
  if (step === 'plan') return 'planning';
  if (step === 'record') return 'recording';
  if (step === 'review') return 'reviewing';
  // The PA's scope step and any phase floor fill added run before `plan` or between the three.
  const ord = cursor?.ord ?? 0;
  const recordOrd = stepUnit(view, 'record')?.ord;
  const planOrd = stepUnit(view, 'plan')?.ord;
  // While the PA scopes, the run's only unit is `pa-scope`: there is no `plan` unit to compare with.
  if (planOrd === undefined || ord < planOrd) return 'preparing';
  if (recordOrd !== undefined && ord > recordOrd) return 'reviewing';
  return 'recording';
}

/** `chapters.json` → the chapter list, or `[]` when it is missing or not the plan's shape. */
export function parseChapters(raw: string | null): Omit<DemoChapter, 'recorded'>[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { chapters?: unknown })?.chapters)
      ? (parsed as { chapters: unknown[] }).chapters
      : [];
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const out: Omit<DemoChapter, 'recorded'>[] = [];
  for (const c of list) {
    if (c === null || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (typeof o.key !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(o.key)) continue;
    out.push({
      key: o.key,
      title: typeof o.title === 'string' ? o.title : o.key,
      blurb: typeof o.blurb === 'string' ? o.blurb : '',
      tags: strs(o.tags),
      resets: strs(o.resets),
    });
  }
  return out;
}

/** `chapters.md` (record.mjs's `| m:ss | Title |` table) → the MP4's chapter markers. */
export function parseMarkers(raw: string | null): DemoMarker[] {
  if (raw === null) return [];
  const out: DemoMarker[] = [];
  for (const line of raw.split('\n')) {
    const m = /^\|\s*(\d+):(\d{2})\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (m === null) continue;
    out.push({ at: `${m[1]}:${m[2]}`, sec: Number(m[1]) * 60 + Number(m[2]), title: m[3] as string });
  }
  return out;
}

const VERDICTS = new Set(['re-encode', 're-record', 'fix-app']);

/** The reviewer's output → its verdict block (the LAST fenced ```json block), or nothing. */
export function parseReview(output: string | null): { verdict: 'accept' | 'changes' | null; findings: DemoFinding[] } {
  const none = { verdict: null, findings: [] };
  if (output === null) return none;
  const blocks = [...output.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return none;
  }
  const o = (parsed ?? {}) as { verdict?: unknown; findings?: unknown };
  const verdict = o.verdict === 'accept' || o.verdict === 'changes' ? o.verdict : null;
  const findings: DemoFinding[] = [];
  for (const f of Array.isArray(o.findings) ? o.findings : []) {
    if (f === null || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    if (typeof r.issue !== 'string' || typeof r.verdict !== 'string' || !VERDICTS.has(r.verdict)) continue;
    findings.push({
      at: typeof r.at === 'string' ? r.at : '',
      chapter: typeof r.chapter === 'string' ? r.chapter : '',
      issue: r.issue,
      verdict: r.verdict as DemoFinding['verdict'],
    });
  }
  return { verdict, findings };
}

/** A root file's text, resolved inside the root first (a worker-made symlink out of it reads as absent). */
async function readText(root: string, rel: string): Promise<string | null> {
  const path = await containedPath(root, rel);
  if (path === null) return null;
  try {
    const st = await fsp.stat(path);
    if (!st.isFile() || st.size > DEMO_SCRIPT_MAX_BYTES) return null;
    return await fsp.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** A root file's size when it is a regular file inside the root, else null. */
async function fileSize(root: string, rel: string): Promise<number | null> {
  const path = await containedPath(root, rel);
  if (path === null) return null;
  try {
    const st = await fsp.stat(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

async function isFile(root: string, rel: string): Promise<boolean> {
  return (await fileSize(root, rel)) !== null;
}

/** The brief's app URL and audience, for the header (the brief is the daemon's own file). */
function briefFields(brief: string | null): { url: string | null; audience: string | null } {
  if (brief === null) return { url: null, audience: null };
  const url = /^- \*\*App:\*\* (\S+)/m.exec(brief)?.[1] ?? null;
  const audience = /## Who it is for\n\n([\s\S]*?)\n\n## /.exec(brief)?.[1]?.trim() ?? null;
  return { url, audience };
}

/** Everything studio renders for a demo run, read from its root and its units. */
export async function demoView(adapter: CoreAdapter, view: SessionView): Promise<DemoView> {
  const runId = view.session.id;
  const root = demoRootDir(runId);
  // Every read is resolved inside the root: the run can write here, so a symlink it made is never followed out.
  const [brief, script, chaptersRaw, markersRaw, recordingRaw] = await Promise.all([
    readText(root, 'BRIEF.md'),
    readText(root, 'script.md'),
    readText(root, 'chapters.json'),
    readText(root, 'demo-video/chapters.md'),
    readText(root, 'demo-video/recording.json'),
  ]);
  const chapters: DemoChapter[] = await Promise.all(
    parseChapters(chaptersRaw).map(async (c) => ({
      ...c,
      recorded: await isFile(root, `demo-video/segments/${c.key}/segment.mp4`),
    })),
  );
  const sheets: DemoView['sheets'] = [];
  for (const name of ['chapters', 'joins', 'end'] as const) {
    if (await isFile(root, `review/${name}.png`)) sheets.push({ name, path: `review/${name}.png` });
  }
  const videoBytes = await fileSize(root, 'demo-video/demo.mp4');
  const video: DemoView['video'] = videoBytes !== null && videoBytes > 0 ? { path: 'demo-video/demo.mp4', bytes: videoBytes } : null;
  let readOnly: boolean | null = null;
  if (recordingRaw !== null) {
    try {
      const r = JSON.parse(recordingRaw) as { readOnly?: unknown };
      readOnly = typeof r.readOnly === 'boolean' ? r.readOnly : null;
    } catch {
      readOnly = null;
    }
  }
  const review = stepUnit(view, 'review');
  const record = stepUnit(view, 'record');
  const reviewed = review !== undefined && (review.status === 'done' || review.status === 'rejected');
  const reviewOutput = reviewed ? await adapter.workOutput(coreUnitId(runId, review)) : null;
  const { verdict, findings } = parseReview(reviewOutput);
  return {
    runId,
    ...briefFields(brief),
    stage: demoStage(view),
    script,
    chapters,
    markers: parseMarkers(markersRaw),
    sheets,
    video,
    recording: { readOnly },
    review: { verdict, findings, text: reviewOutput, rejected: review?.status === 'rejected' },
    seats: { recorder: record?.assigned_cli ?? null, reviewer: review?.assigned_cli ?? null },
    syntheticLabelled: script !== null && /synthetic/i.test(script),
  };
}

/** `path` resolved inside `root` (symlinks included), or `null` when it would leave it. */
async function containedPath(root: string, rel: string): Promise<string | null> {
  if (rel === '' || rel.includes('\0')) return null;
  const target = resolve(root, rel);
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fsp.realpath(root);
    realTarget = await fsp.realpath(target);
  } catch {
    return null;
  }
  const inside = relative(realRoot, realTarget);
  if (inside === '' || inside.startsWith('..') || inside.startsWith(sep) || resolve(realRoot, inside) !== realTarget) {
    return null;
  }
  return realTarget;
}

/** A single `Range: bytes=a-b` → the inclusive span, `null` for no header, `'bad'` for one we cannot serve. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null || (m[1] === '' && m[2] === '')) return 'bad';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'bad';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'bad';
  return { start, end };
}

export function registerDemoRoutes(app: FastifyInstance, adapter: CoreAdapter): void {
  // One encode per run and format at a time, since each format writes one file. An identical request
  // (a double click) joins the encode in flight; a different poster frame is refused until it ends,
  // so two encodes never race to replace the same file.
  const exportsInFlight = new Map<string, { atSec: number | undefined; answer: Promise<DemoExportAnswer> }>();
  const demoRun = async (id: string): Promise<SessionView | null> => {
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    return run !== undefined && isDemoRun(run) ? run : null;
  };
  // A run launched from the demo preset stays one, and the file route needs nothing else from it: the
  // `<video>` asks in many Range requests, so each is not a read of every run.
  const knownDemoRuns = new Set<string>();
  const isKnownDemoRun = async (id: string): Promise<boolean> => {
    if (knownDemoRuns.has(id)) return true;
    const run = await demoRun(id);
    if (run !== null) knownDemoRuns.add(id);
    return run !== null;
  };

  app.post(
    `${V}/projects/:id/demo`,
    {
      config: {
        manifest: {
          requestType: 'DemoLaunchBody',
          responseType: 'DemoLaunchResponse',
          // Every non-201 besides the body 400 is POST /runs' own answer, passed through.
          statusCodes: [201, 400, 404, 409, 422, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = DemoLaunchSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid demo body', details: parsed.error.issues });
      }
      const projectId = (req.params as { id: string }).id;
      const runId = randomUUID();
      const root = demoRootDir(runId);
      await fsp.mkdir(root, { recursive: true });
      const briefPath = join(root, 'BRIEF.md');
      await fsp.writeFile(briefPath, demoBrief(root, parsed.data), 'utf8');
      const auth = req.headers.authorization;
      demoLaunchRoots.set(runId, root);
      const launched = await app
        .inject({
          method: 'POST',
          url: `${V}/runs`,
          headers: { 'content-type': 'application/json', ...(auth !== undefined ? { authorization: auth } : {}) },
          payload: {
            problem: `Make a demo of ${parsed.data.url} with the wicked-garden-demo skill: follow the demo brief at ${briefPath}. Demo root: ${root}`,
            sessionId: runId,
            // Unfiled (studio's `default` mount) is no project to file into: the run launches unfiled.
            ...(projectId !== UNFILED_PROJECT ? { projectId } : {}),
            workflow: DEMO_PRESET,
            deliver: 'none',
            ...(parsed.data.clisJson !== undefined ? { clisJson: parsed.data.clisJson } : {}),
          },
        })
        .finally(() => demoLaunchRoots.delete(runId));
      if (launched.statusCode !== 201) {
        await fsp.rm(root, { recursive: true, force: true });
        return reply.code(launched.statusCode).type('application/json').send(launched.body);
      }
      return reply.code(201).send({ runId });
    },
  );

  app.get(
    `${V}/runs/:id/demo`,
    { config: { manifest: { responseType: 'DemoView', statusCodes: [200, 404] } } },
    async (req, reply) => {
      const run = await demoRun((req.params as { id: string }).id);
      if (run === null) return reply.code(404).send({ error: 'no demo run with that id' });
      return demoView(adapter, run);
    },
  );

  app.get(
    `${V}/runs/:id/demo/file`,
    { config: { manifest: { responseType: 'binary (video/mp4, image/png, text)', statusCodes: [200, 206, 400, 404, 416] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rel = (req.query as { path?: unknown }).path;
      if (typeof rel !== 'string') return reply.code(400).send({ error: '`path` is required, once' });
      const type = DEMO_FILE_TYPES[extname(rel).toLowerCase()];
      if (type === undefined) {
        return reply.code(400).send({ error: `\`path\` must be one of ${Object.keys(DEMO_FILE_TYPES).join(', ')}` });
      }
      if (!(await isKnownDemoRun(id))) return reply.code(404).send({ error: 'no demo run with that id' });
      const target = await containedPath(demoRootDir(id), rel);
      if (target === null) return reply.code(404).send({ error: `no such demo file: ${rel}` });
      const st = await fsp.stat(target);
      if (!st.isFile()) return reply.code(404).send({ error: `no such demo file: ${rel}` });
      reply.header('content-type', type).header('accept-ranges', 'bytes').header('cache-control', 'no-store');
      const range = parseRange(req.headers.range, st.size);
      if (range === 'bad') {
        return reply.code(416).header('content-range', `bytes */${st.size}`).send();
      }
      if (range === null) {
        reply.header('content-length', String(st.size));
        return reply.send(createReadStream(target));
      }
      reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${st.size}`)
        .header('content-length', String(range.end - range.start + 1));
      return reply.send(createReadStream(target, { start: range.start, end: range.end }));
    },
  );

  app.post(
    `${V}/runs/:id/demo/export`,
    {
      config: {
        manifest: {
          requestType: 'DemoExportBody',
          responseType: 'DemoExportResponse',
          statusCodes: [200, 400, 404, 409, 422, 502, 503, 504],
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = DemoExportSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid export body', details: parsed.error.issues });
      const run = await demoRun(id);
      if (run === null) return reply.code(404).send({ error: 'no demo run with that id' });
      // Only while none of the run's workers can write the root: at the review gate, or once the run
      // has ended. The export reads and writes inside that root across a seconds-long encode.
      if (!DEMO_EXPORT_STAGES.has(demoStage(run))) {
        return reply.code(409).send({ error: 'a demo can be exported at the review gate or once the run has ended' });
      }
      const { format, atSec } = parsed.data;
      const key = `${id}\0${format}`;
      let pending = exportsInFlight.get(key);
      if (pending !== undefined && pending.atSec !== atSec) {
        return reply.code(409).send({ error: `a ${format} export of this demo is already running; try again when it ends` });
      }
      if (pending === undefined) {
        // Re-read at publication: a gate answered during the encode may have resumed the recorder.
        const stillExportable = async (): Promise<boolean> => {
          const now = await demoRun(id);
          return now !== null && DEMO_EXPORT_STAGES.has(demoStage(now));
        };
        pending = {
          atSec,
          answer: encodeDemoExport(id, format, atSec, stillExportable).finally(() => exportsInFlight.delete(key)),
        };
        exportsInFlight.set(key, pending);
      }
      const answer = await pending.answer;
      return reply.code(answer.status).send(answer.body);
    },
  );

  app.put(
    `${V}/runs/:id/demo/script`,
    { config: { manifest: { requestType: 'DemoScriptBody', responseType: '{ bytes: number }', statusCodes: [200, 400, 404, 409, 413] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = DemoScriptSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid script body', details: parsed.error.issues });
      const bytes = Buffer.byteLength(parsed.data.content, 'utf8');
      if (bytes > DEMO_SCRIPT_MAX_BYTES) {
        return reply.code(413).send({ error: `the script is ${bytes} bytes, over the ${DEMO_SCRIPT_MAX_BYTES}-byte cap` });
      }
      const run = await demoRun(id);
      if (run === null) return reply.code(404).send({ error: 'no demo run with that id' });
      // Only at the plan gate: before it the planner is still writing the script, after it the recorder
      // has read it — an edit then would change a script nobody records.
      if (demoStage(run) !== 'plan_gate') {
        return reply.code(409).send({ error: 'the script can be edited only while the plan gate is open' });
      }
      // The resolved file, never the joined name: a worker-made symlink is followed only inside the root.
      const target = await containedPath(demoRootDir(id), 'script.md');
      if (target === null) return reply.code(409).send({ error: 'the plan has not written script.md' });
      await fsp.writeFile(target, parsed.data.content, 'utf8');
      return { bytes };
    },
  );
}

// ── Walkthrough (WT-W1, DES-walkthrough-proof §4.2, §4.10) ────────────────────────────────────

/** The catalog id of the walkthrough author (an evaluator agent step). */
export const WALKTHROUGH_PLAN_CATALOG = 'walkthrough_plan';
/** The catalog id of the walkthrough recorder (the jailed, engine-run Tool step). */
export const WALKTHROUGH_REVIEW_CATALOG = 'walkthrough_review';
export { WALKTHROUGH_AUTHOR_SUBDIR, walkthroughRootDir } from '../core/walkthrough-root.js';

/** What `/walkthrough/file` serves, by extension: the demo's deliverable types (the take is a demo). */
const WALKTHROUGH_FILE_TYPES = DEMO_FILE_TYPES;

/** The biggest recorder file the view parses (result, progress, chapter list). */
const WALKTHROUGH_JSON_MAX_BYTES = 4 * 1024 * 1024;

/** One walkthrough pair of a run: the recorder unit and the author unit it records. */
interface WalkthroughPair {
  review: WorkUnit | null;
  plan: WorkUnit | null;
}

/**
 * The run's walkthrough pairs in plan order. A recorder pairs with the author its `depends_on` names,
 * else the nearest author before it (the engine's `author_step_for`); an author with no recorder after
 * it yet is a pair of its own (the walkthrough is still being written).
 */
export function walkthroughPairs(view: SessionView): WalkthroughPair[] {
  const units = [...view.units].sort((a, b) => a.ord - b.ord);
  const plans = units.filter((u) => u.catalog === WALKTHROUGH_PLAN_CATALOG);
  const pairs: WalkthroughPair[] = [];
  const paired = new Set<WorkUnit>();
  for (const review of units.filter((u) => u.catalog === WALKTHROUGH_REVIEW_CATALOG)) {
    const before = plans.filter((p) => p.ord < review.ord);
    const deps = (review as { depends_on?: unknown }).depends_on;
    const named = Array.isArray(deps) ? before.find((p) => deps.includes(stepIdOf(view, p))) : undefined;
    const plan = named ?? before.at(-1) ?? null;
    if (plan !== null) paired.add(plan);
    pairs.push({ review, plan });
  }
  // An author no recorder resolves to is a pair of its own: its walkthrough is still being written.
  for (const plan of plans) {
    if (!paired.has(plan)) pairs.push({ review: null, plan });
  }
  // Newest = the latest AUTHOR (a pair's age is when its storyline was written); a recorder with no
  // author before it sorts by its own position.
  return pairs.sort((a, b) => (a.plan ?? a.review)!.ord - (b.plan ?? b.review)!.ord);
}

/** The pair the view and the file route read: the newest, or the one `step` (its review or plan step id) names. */
function selectPair(view: SessionView, step: string | undefined): WalkthroughPair | undefined {
  const pairs = walkthroughPairs(view);
  if (step === undefined) return pairs.at(-1);
  return pairs.find(
    (p) => (p.review !== null && stepIdOf(view, p.review) === step) || (p.plan !== null && stepIdOf(view, p.plan) === step),
  );
}

/** A proof-root JSON file, parsed, or `undefined` when it is absent, oversized, outside the root or not JSON. */
async function readRootJson(root: string, rel: string): Promise<unknown> {
  const path = await containedPath(root, rel);
  if (path === null) return undefined;
  try {
    const st = await fsp.stat(path);
    if (!st.isFile() || st.size > WALKTHROUGH_JSON_MAX_BYTES) return undefined;
    return JSON.parse(await fsp.readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const OVERALL: Readonly<Record<string, WalkthroughState>> = { PASS: 'passed', FAIL: 'failed', INCONCLUSIVE: 'inconclusive' };
const RUNNING_STATES: ReadonlySet<string> = new Set(['starting_app', 'recording', 'judging']);

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function parseVerdict(v: unknown): WalkthroughVerdict | null {
  return v === 'PASS' || v === 'FAIL' || v === 'INCONCLUSIVE' ? v : null;
}

function parseChecks(v: unknown): WalkthroughCheck[] {
  const out: WalkthroughCheck[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const c = record(raw);
    if (c === null || str(c.id) === null) continue;
    out.push({
      id: c.id as string,
      kind: str(c.kind) ?? 'unknown',
      sentence: str(c.sentence) ?? '',
      passed: typeof c.passed === 'boolean' ? c.passed : null,
      atSec: num(c.at_sec),
      evidence: strs(c.evidence),
      vaultEntry: str(c.vault_entry),
      detail: str(c.detail),
    });
  }
  return out;
}

function parseLegs(v: unknown): WalkthroughLeg[] {
  const out: WalkthroughLeg[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const l = record(raw);
    if (l === null || str(l.leg) === null) continue;
    out.push({ leg: l.leg as string, claim_level: str(l.claim_level) ?? '', reason: str(l.reason) ?? '' });
  }
  return out;
}

/** The chapters: the planned list (`chapters.json`), then any chapter only the judge's result names. */
async function walkthroughChapters(root: string | null, result: Record<string, unknown> | null): Promise<WalkthroughChapter[]> {
  const planned = root === null ? [] : parseChapters(await readText(root, 'chapters.json'));
  const judged = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(result?.chapters) ? (result.chapters as unknown[]) : []) {
    const c = record(raw);
    const key = str(c?.key);
    if (c !== null && key !== null && /^[a-z0-9][a-z0-9-]*$/.test(key) && !judged.has(key)) judged.set(key, c);
  }
  const base = [...planned];
  for (const [key, c] of judged) {
    if (!base.some((p) => p.key === key)) base.push({ key, title: str(c.title) ?? key, blurb: '', tags: [], resets: [] });
  }
  return Promise.all(
    base.map(async (ch, i) => {
      const j = judged.get(ch.key) ?? null;
      const frame = str(j?.failed_frame);
      const verdict = parseVerdict(j?.verdict);
      return {
        ...ch,
        recorded: root !== null && (await isFile(root, `demo-video/segments/${ch.key}/segment.mp4`)),
        index: i + 1,
        total: base.length,
        verdict,
        takes: Math.max(1, Math.trunc(num(j?.takes) ?? 1)),
        failedAtSec: verdict === 'FAIL' ? num(j?.failed_at_sec) : null,
        failedFrame: root !== null && frame !== null && (await isFile(root, frame)) ? frame : null,
        proves: strs(j?.proves),
        legs: parseLegs(j?.legs),
        checks: parseChecks(j?.checks),
      };
    }),
  );
}

/** One recorder step's gate: its proof root and the seal in its persisted output (WT-W2). */
async function recorderGate(adapter: Pick<CoreAdapter, 'workOutput'>, view: SessionView, review: WorkUnit): Promise<WalkthroughGate> {
  const output = await adapter.workOutput(coreUnitId(view.session.id, review)).catch(() => null);
  return resolveWalkthroughGate({
    runId: view.session.id,
    stepId: stepIdOf(view, review),
    proofRoot: await walkthroughProofRoot(view, review),
    output,
  });
}

/**
 * The walkthrough half of `GET /runs/:id/acceptance` (WT-W2): one gate per `walkthrough_review` step
 * the requirement names (`phases`, step ids), and the per-creator-step check states from the NEWEST
 * walkthrough (only a sealed one proves anything).
 */
export async function walkthroughAcceptance(
  adapter: Pick<CoreAdapter, 'workOutput'>,
  view: SessionView,
  phases: string[],
): Promise<{ gates: WalkthroughGate[]; steps: WalkthroughStepState[]; newest: WalkthroughGate | null; ownedByYou: boolean }> {
  const wanted = new Set(phases);
  const reviews = view.units.filter((u) => u.catalog === WALKTHROUGH_REVIEW_CATALOG && wanted.has(stepIdOf(view, u)));
  // #791: the override removed the pair, so there is no review to resolve — the creator steps are
  // still reported, each `owned_by_you` (§4.9), instead of the block vanishing.
  const ownedByYou = pairRemovedByOverride(view);
  if (reviews.length === 0) return { gates: [], steps: ownedByYou ? walkthroughCheckStates(view, null) : [], newest: null, ownedByYou };
  const gates = await Promise.all(reviews.map((u) => recorderGate(adapter, view, u)));
  const newestReview = walkthroughPairs(view).filter((p) => p.review !== null).at(-1)?.review ?? null;
  const newest = newestReview !== null ? (gates.find((g) => g.stepId === stepIdOf(view, newestReview)) ?? null) : null;
  return { gates, steps: walkthroughCheckStates(view, newest), newest, ownedByYou };
}

/** Everything studio renders for one walkthrough pair (the newest, or the one `step` names). */
export async function walkthroughView(
  view: SessionView,
  step?: string,
  adapter?: Pick<CoreAdapter, 'workOutput'>,
): Promise<WalkthroughView | null> {
  const runId = view.session.id;
  const pair = selectPair(view, step);
  if (step !== undefined && pair === undefined) return null;
  const evidenceRoot = (view.session as { evidence_root?: unknown }).evidence_root;
  const hasEvidenceRoot = typeof evidenceRoot === 'string' && evidenceRoot !== '';
  const review = pair?.review ?? null;
  const plan = pair?.plan ?? null;
  const root = review !== null ? await walkthroughProofRoot(view, review) : null;
  const resultRaw = root !== null ? await readRootJson(root, 'result.json') : undefined;
  const result = record(resultRaw);
  const bound = review ?? plan;
  const builders: string[] = [];
  for (const u of [...view.units].sort((a, b) => a.ord - b.ord)) {
    if (bound !== null && u.ord >= bound.ord) break;
    if (u.role === 'creator' && u.assigned_cli !== null && u.assigned_cli !== undefined && !builders.includes(u.assigned_cli)) {
      builders.push(u.assigned_cli);
    }
  }

  let state: WalkthroughState;
  let cause: string | null = null;
  if (pair === undefined) {
    state = 'authoring';
    cause = 'no_walkthrough';
  } else if (plan !== null && (plan.status === 'pending' || plan.status === 'distributed')) {
    state = 'authoring';
  } else if (plan !== null && plan.status === 'rejected') {
    state = 'linting';
    cause = plan.denial_reason ?? 'storyline_refused';
  } else if (review === null || review.status === 'pending') {
    state = 'starting_app';
  } else if (review.status === 'distributed') {
    const progress = root !== null ? record(await readRootJson(root, 'progress.json')) : null;
    const s = str(progress?.state);
    state = s !== null && RUNNING_STATES.has(s) ? (s as WalkthroughState) : 'starting_app';
  } else {
    const overall = str(result?.overall);
    // Own keys only (Copilot on #758): `constructor` / `__proto__` must never read as a verdict.
    if (overall !== null && Object.hasOwn(OVERALL, overall)) {
      state = OVERALL[overall] as WalkthroughState;
      cause = str(result?.cause);
    } else {
      state = 'inconclusive';
      cause = hasEvidenceRoot ? 'no_result' : 'no_evidence_root';
    }
  }

  const mp4 = root !== null && ((await fileSize(root, 'demo-video/demo.mp4')) ?? 0) > 0 ? 'demo-video/demo.mp4' : null;
  const poster = root !== null && (await isFile(root, 'demo-video/poster.jpg')) ? 'demo-video/poster.jpg' : null;
  const markers = root !== null ? parseMarkers(await readText(root, 'demo-video/chapters.md')) : [];
  // WT-W2: the take is trusted only through its seal, re-verified at this read.
  const gate = review !== null && adapter !== undefined ? await recorderGate(adapter, view, review) : null;
  return {
    runId,
    stepId: review !== null ? stepIdOf(view, review) : null,
    planStepId: plan !== null ? stepIdOf(view, plan) : null,
    state,
    cause,
    seat: { evaluator: plan?.assigned_cli ?? null, builders },
    tree: str(result?.tree),
    stale: false,
    sealed: gate?.sealed ?? false,
    video: { mp4, poster, markers },
    chapters: await walkthroughChapters(root, result),
    steps: gate !== null ? walkthroughCheckStates(view, gate) : pairRemovedByOverride(view) ? walkthroughCheckStates(view, null) : [],
  };
}

/** The biggest storyline the operator may PUT (the demo module shape is a few KB). */
export const STORYLINE_MAX_BYTES = 256 * 1024;
/** The storyline file the author writes, and crew's edit marker beside it (WT-W3). */
export const STORYLINE_FILE = 'storyline.mjs';
export const STORYLINE_EDIT_FILE = 'storyline.edit.json';

/** What crew writes beside an operator-edited storyline: who edited it, when, and what. */
export interface StorylineEditMarker {
  edited_by: 'human';
  actor: string;
  at: string;
  sha256: string;
  /** The escalated unit the edit answers (its `ord`). */
  ord: number;
}

const PLAIN_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** A refusal whose message is safe to return (relative names only, never an absolute path). */
export class StorylineWriteError extends Error {}

/**
 * WT-W3 (DES-walkthrough-proof §4.8 "Edit the check"): write the operator's storyline for the pair's
 * author step — `<evidence_root>/author/<plan step>/storyline.mjs` plus `storyline.edit.json`
 * (`edited_by: "human"`) — atomically (temp file + rename), refusing any path that does not resolve
 * to a plain directory under the evidence root's `author/` (a planted link cannot redirect the write).
 */
export async function writeStoryline(
  evidenceRoot: string,
  planStepId: string,
  text: string,
  marker: Omit<StorylineEditMarker, 'sha256' | 'edited_by'>,
): Promise<StorylineEditMarker> {
  if (!PLAIN_SEGMENT.test(planStepId) || planStepId.startsWith('.')) {
    throw new StorylineWriteError(`step id ${JSON.stringify(planStepId)} is not a plain path segment`);
  }
  const authorRoot = join(evidenceRoot, WALKTHROUGH_AUTHOR_SUBDIR);
  const dir = join(authorRoot, planStepId);
  // One level at a time, each checked with lstat BEFORE anything is created under it: a planted link
  // at `author/` or `author/<step>` is refused, never followed (codex on WT-W3).
  for (const p of [authorRoot, dir]) {
    const st = await fsp.lstat(p).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (st === null) await fsp.mkdir(p, { mode: 0o755 });
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new StorylineWriteError(`${relative(evidenceRoot, p)} is not a plain directory`);
  }
  const expected = join(await fsp.realpath(evidenceRoot), WALKTHROUGH_AUTHOR_SUBDIR, planStepId);
  const realDir = await fsp.realpath(dir);
  if (realDir !== expected) throw new StorylineWriteError('the author directory resolves outside the evidence root');
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const full: StorylineEditMarker = { edited_by: 'human', sha256, ...marker };
  const put = async (name: string, body: string): Promise<void> => {
    const target = join(realDir, name);
    const existing = await fsp.lstat(target).catch(() => null);
    if (existing !== null && !existing.isFile()) throw new StorylineWriteError(`${name} exists and is not a plain file`);
    const tmp = join(realDir, `.${name}.${randomUUID()}.tmp`);
    await fsp.writeFile(tmp, body, { mode: 0o644, flag: 'wx' });
    // No unit runs while the run is parked on the escalation (one cursor), so nothing should swap the
    // directory under us; re-check anyway before the rename publishes the file.
    if ((await fsp.realpath(dir)) !== expected) {
      await fsp.rm(tmp, { force: true });
      throw new StorylineWriteError('the author directory changed while the storyline was written');
    }
    await fsp.rename(tmp, target);
  };
  // The marker first, then the storyline: a crash between them leaves a marker whose sha names no
  // storyline on disk, which the recorder treats as "not edited" — never a stale `human` on agent text.
  await put(STORYLINE_EDIT_FILE, `${JSON.stringify(full, null, 2)}\n`);
  await put(STORYLINE_FILE, text);
  return full;
}

/** A read refusal whose message is safe to return (relative names only, never an absolute path). */
export class StorylineReadError extends Error {
  constructor(
    message: string,
    readonly code: 'read_refused' | 'too_large',
  ) {
    super(message);
  }
}

/**
 * #782: the storyline the operator is asked to edit — `<evidence_root>/author/<plan step>/storyline.mjs`
 * — read the way {@link writeStoryline} writes it: every level lstat-checked (a planted link at
 * `author/`, `author/<step>` or the file is refused, never followed), the directory's real path pinned
 * under the evidence root, the file at most {@link STORYLINE_MAX_BYTES}. `null` when the author has not
 * written one. `edited_by` / `at` come from the edit marker only when its `sha256` names this text (the
 * recorder's rule: a marker that names another text is not an edit).
 */
export async function readStoryline(
  evidenceRoot: string,
  planStepId: string,
): Promise<{ text: string; sha256: string; edited_by: 'human' | null; at: string | null } | null> {
  if (!PLAIN_SEGMENT.test(planStepId) || planStepId.startsWith('.')) {
    throw new StorylineReadError(`step id ${JSON.stringify(planStepId)} is not a plain path segment`, 'read_refused');
  }
  const authorRoot = join(evidenceRoot, WALKTHROUGH_AUTHOR_SUBDIR);
  const dir = join(authorRoot, planStepId);
  const file = join(dir, STORYLINE_FILE);
  for (const [p, wantDir] of [
    [authorRoot, true],
    [dir, true],
    [file, false],
  ] as const) {
    const st = await fsp.lstat(p).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw err;
    });
    if (st === null) return null;
    if (st.isSymbolicLink() || (wantDir ? !st.isDirectory() : !st.isFile())) {
      throw new StorylineReadError(`${relative(evidenceRoot, p)} is not a plain ${wantDir ? 'directory' : 'file'}`, 'read_refused');
    }
    if (!wantDir && st.size > STORYLINE_MAX_BYTES) {
      throw new StorylineReadError(`the storyline is over ${STORYLINE_MAX_BYTES} bytes`, 'too_large');
    }
  }
  const expected = join(await fsp.realpath(evidenceRoot), WALKTHROUGH_AUTHOR_SUBDIR, planStepId);
  if ((await fsp.realpath(dir)) !== expected) throw new StorylineReadError('the author directory resolves outside the evidence root', 'read_refused');
  // O_NOFOLLOW: a link swapped in after the lstat is refused by the open itself, not followed.
  const fh = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') throw new StorylineReadError(`${relative(evidenceRoot, file)} is not a plain file`, 'read_refused');
    throw err;
  });
  if (fh === null) return null;
  let text: string;
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new StorylineReadError(`${relative(evidenceRoot, file)} is not a plain file`, 'read_refused');
    if (st.size > STORYLINE_MAX_BYTES) throw new StorylineReadError(`the storyline is over ${STORYLINE_MAX_BYTES} bytes`, 'too_large');
    text = await fh.readFile({ encoding: 'utf8' });
  } finally {
    await fh.close();
  }
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  let edited_by: 'human' | null = null;
  let at: string | null = null;
  const markerPath = join(dir, STORYLINE_EDIT_FILE);
  const mst = await fsp.lstat(markerPath).catch(() => null);
  if (mst !== null && mst.isFile() && mst.size <= 64 * 1024) {
    try {
      const m = JSON.parse(await fsp.readFile(markerPath, 'utf8')) as Partial<StorylineEditMarker>;
      if (m.edited_by === 'human' && m.sha256 === sha256) {
        edited_by = 'human';
        at = typeof m.at === 'string' ? m.at : null;
      }
    } catch {
      // An unreadable marker is no marker: the text reads as the author's.
    }
  }
  return { text, sha256, edited_by, at };
}

export interface WalkthroughRouteDeps {
  /** The run's open gate (the routes' shared resolution); `'no-log'` = this build cannot say. */
  resolveOpenGate?: (runId: string) => Promise<{ ord: number } | null | 'no-log'>;
  audit?: AuditLog;
}

export function registerWalkthroughRoutes(app: FastifyInstance, adapter: CoreAdapter, deps: WalkthroughRouteDeps = {}): void {
  const runById = async (id: string): Promise<SessionView | null> =>
    (await adapter.sessionsDetail()).find((v) => v.session.id === id) ?? null;

  // WT-W3: the operator edits the checks while the pair's escalation is open, then approves.
  app.put(
    `${V}/runs/:id/walkthrough/storyline`,
    {
      config: {
        manifest: { requestType: 'PutStorylineBody', responseType: 'PutStorylineResponse', statusCodes: [200, 400, 403, 404, 409, 413, 503] },
      },
      bodyLimit: STORYLINE_MAX_BYTES + 4096,
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const step = (req.query as { step?: unknown }).step;
      if (step !== undefined && typeof step !== 'string') return reply.code(400).send({ error: '`step` names one step, once' });
      const body = req.body as { storyline?: unknown } | undefined;
      const text = body?.storyline;
      if (typeof text !== 'string' || text.trim() === '') return reply.code(400).send({ error: '`storyline` (the storyline module text) is required' });
      if (Buffer.byteLength(text, 'utf8') > STORYLINE_MAX_BYTES) {
        return reply.code(413).send({ error: `the storyline is over ${STORYLINE_MAX_BYTES} bytes` });
      }
      const actor = (req as { actor?: Actor }).actor ?? LOCAL_ACTOR;
      // The checks are the test plan a walkthrough proves the work against: only a person edits them.
      if (actor.kind !== 'human') return reply.code(403).send({ error: 'only a human operator edits the walkthrough checks' });
      const run = await runById(id);
      if (run === null) return reply.code(404).send({ error: 'no run with that id' });
      // Every pair the selector names (an author recorded by two reviews names both), or the newest.
      const named =
        step === undefined
          ? [selectPair(run, undefined)].filter((p): p is WalkthroughPair => p !== undefined)
          : walkthroughPairs(run).filter(
              (p) => (p.review !== null && stepIdOf(run, p.review) === step) || (p.plan !== null && stepIdOf(run, p.plan) === step),
            );
      if (named.length === 0) return reply.code(404).send({ error: `run ${id} has no walkthrough step named ${String(step)}` });
      // Accepted ONLY while that pair's escalation gate is open: the run is parked on a denied unit of
      // the pair (the cursor stays on it, §4.8), and the open gate is that unit's.
      const noEscalation = (why: string) => reply.code(409).send({ error: `the storyline can be edited only while this walkthrough's escalation is open: ${why}`, code: 'no_open_escalation' });
      if (run.session.status !== 'awaiting_human') return noEscalation(`the run is ${run.session.status}`);
      if (deps.resolveOpenGate === undefined) return reply.code(503).send({ error: 'this daemon cannot resolve the open gate' });
      const open = await deps.resolveOpenGate(id);
      if (open === 'no-log') return reply.code(503).send({ error: 'gate history is unavailable: this wicked-core build has no event-log read binding' });
      if (open === null) return noEscalation('no gate is open');
      const isEscalated = (u: WorkUnit | null): u is WorkUnit => u !== null && u.ord === open.ord && u.denial_reason !== null;
      const pair = named.find((p) => isEscalated(p.review) || isEscalated(p.plan));
      if (pair === undefined) return noEscalation(`the open gate is before unit ${open.ord}, not a denied step of this walkthrough`);
      if (pair.plan === null) return reply.code(409).send({ error: 'this walkthrough has no author step whose storyline could be edited', code: 'no_author' });
      const escalated = isEscalated(pair.review) ? pair.review : pair.plan;
      const evidenceRoot = (run.session as { evidence_root?: unknown }).evidence_root;
      if (typeof evidenceRoot !== 'string' || evidenceRoot === '') return reply.code(409).send({ error: 'this run has no evidence root', code: 'no_evidence_root' });
      const planStepId = stepIdOf(run, pair.plan);
      let marker: StorylineEditMarker;
      try {
        marker = await writeStoryline(evidenceRoot, planStepId, text, { actor: actor.id, at: new Date().toISOString(), ord: escalated.ord });
      } catch (err) {
        // A refusal says what was wrong in relative names; any other failure says only that it failed.
        const why = err instanceof StorylineWriteError ? err.message : 'the author directory could not be written';
        return reply.code(409).send({ error: `the storyline was not written: ${why}`, code: 'write_refused' });
      }
      // The escalation could have been answered while the file was written: say so, rather than a
      // 200 that implies the next recording uses it (codex on WT-W3).
      const after = await deps.resolveOpenGate(id);
      const still = (await runById(id))?.session.status === 'awaiting_human' && after !== null && after !== 'no-log' && after.ord === open.ord;
      if (!still) {
        return reply.code(409).send({
          error: 'the storyline was written, but the escalation was answered meanwhile; open the walkthrough again before relying on it',
          code: 'escalation_closed',
        });
      }
      deps.audit?.record('walkthrough.storyline.edited', actor, {
        runId: id,
        detail: { planStepId, ord: escalated.ord, sha256: marker.sha256, bytes: Buffer.byteLength(text, 'utf8') },
      });
      const out: PutStorylineResponse = { runId: id, planStepId, sha256: marker.sha256, edited_by: 'human', at: marker.at };
      return out;
    },
  );

  // #782: the read side of "Edit the check" — the author's storyline, so a client can prefill the edit.
  app.get(
    `${V}/runs/:id/walkthrough/storyline`,
    { config: { manifest: { responseType: 'WalkthroughStorylineView', statusCodes: [200, 400, 404, 409, 413] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const step = (req.query as { step?: unknown }).step;
      if (step !== undefined && typeof step !== 'string') return reply.code(400).send({ error: '`step` names one step, once' });
      const run = await runById(id);
      if (run === null) return reply.code(404).send({ error: 'no run with that id' });
      const pair = selectPair(run, step);
      if (pair === undefined) return reply.code(404).send({ error: `run ${id} has no walkthrough step named ${String(step)}` });
      if (pair.plan === null) return reply.code(409).send({ error: 'this walkthrough has no author step whose storyline could be read', code: 'no_author' });
      const evidenceRoot = (run.session as { evidence_root?: unknown }).evidence_root;
      if (typeof evidenceRoot !== 'string' || evidenceRoot === '') return reply.code(409).send({ error: 'this run has no evidence root', code: 'no_evidence_root' });
      const planStepId = stepIdOf(run, pair.plan);
      let read: Awaited<ReturnType<typeof readStoryline>>;
      try {
        read = await readStoryline(evidenceRoot, planStepId);
      } catch (err) {
        if (err instanceof StorylineReadError) {
          return err.code === 'too_large'
            ? reply.code(413).send({ error: err.message, code: 'too_large' })
            : reply.code(409).send({ error: `the storyline was not read: ${err.message}`, code: 'read_refused' });
        }
        return reply.code(409).send({ error: 'the storyline was not read: the author directory could not be read', code: 'read_refused' });
      }
      if (read === null) return reply.code(404).send({ error: `the author step ${planStepId} has not written a storyline yet`, code: 'no_storyline' });
      const out: WalkthroughStorylineView = { runId: id, planStepId, storyline: read.text, sha256: read.sha256, edited_by: read.edited_by, at: read.at };
      return out;
    },
  );

  app.get(
    `${V}/runs/:id/walkthrough`,
    { config: { manifest: { responseType: 'WalkthroughView', statusCodes: [200, 400, 404] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const step = (req.query as { step?: unknown }).step;
      if (step !== undefined && typeof step !== 'string') return reply.code(400).send({ error: '`step` names one step, once' });
      const run = await runById(id);
      if (run === null) return reply.code(404).send({ error: 'no run with that id' });
      const view = await walkthroughView(run, step, adapter);
      if (view === null) return reply.code(404).send({ error: `run ${id} has no walkthrough step named ${String(step)}` });
      return view;
    },
  );

  app.get(
    `${V}/runs/:id/walkthrough/file`,
    { config: { manifest: { responseType: 'binary (video/mp4, image/png, text)', statusCodes: [200, 206, 400, 404, 416] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as { path?: unknown; step?: unknown };
      if (typeof q.path !== 'string') return reply.code(400).send({ error: '`path` is required, once' });
      if (q.step !== undefined && typeof q.step !== 'string') return reply.code(400).send({ error: '`step` names one step, once' });
      const type = WALKTHROUGH_FILE_TYPES[extname(q.path).toLowerCase()];
      if (type === undefined) {
        return reply.code(400).send({ error: `\`path\` must be one of ${Object.keys(WALKTHROUGH_FILE_TYPES).join(', ')}` });
      }
      const run = await runById(id);
      if (run === null) return reply.code(404).send({ error: 'no run with that id' });
      // The same pair the view shows: with no step, a newer walkthrough still being written has no
      // files yet, and an older take is never served in its place.
      const pair = selectPair(run, q.step);
      const root = pair?.review != null ? await walkthroughProofRoot(run, pair.review) : null;
      if (root === null) return reply.code(404).send({ error: 'this run has no recorded walkthrough there' });
      const target = await containedPath(root, q.path);
      const st = target === null ? null : await fsp.stat(target).catch(() => null);
      if (target === null || st === null || !st.isFile()) return reply.code(404).send({ error: `no such walkthrough file: ${q.path}` });
      reply.header('content-type', type).header('accept-ranges', 'bytes').header('cache-control', 'no-store');
      const range = parseRange(req.headers.range, st.size);
      if (range === 'bad') return reply.code(416).header('content-range', `bytes */${st.size}`).send();
      if (range === null) {
        reply.header('content-length', String(st.size));
        return reply.send(createReadStream(target));
      }
      reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${st.size}`)
        .header('content-length', String(range.end - range.start + 1));
      return reply.send(createReadStream(target, { start: range.start, end: range.end }));
    },
  );
}
