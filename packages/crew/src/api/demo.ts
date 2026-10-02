/**
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
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
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
} from 'wicked-crew-api-types';
import type { CoreAdapter } from '../core/adapter.js';
import type { SessionView, WorkUnit } from '../core/types.js';
import { API_PREFIX } from './api-prefix.js';
import { coreUnitId } from './evidence.js';

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
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
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
 * Encode one export of a run's stitched MP4. The encoder writes a temporary file beside the target,
 * renamed into place only once it is whole, so a half-written GIF is never served and a failed or
 * killed encode leaves the previous export (or nothing) behind.
 */
async function encodeDemoExport(runId: string, format: DemoExportFormat, atSec: number | undefined): Promise<DemoExportAnswer> {
  const root = demoRootDir(runId);
  const input = await containedPath(root, 'demo-video/demo.mp4');
  const inputSize = input === null ? null : await fsp.stat(input).then((st) => (st.isFile() ? st.size : null), () => null);
  if (input === null || inputSize === null || inputSize === 0) {
    return { status: 409, body: { error: 'this demo has no stitched demo-video/demo.mp4 yet' } };
  }
  const outDir = dirname(input);
  const name = DEMO_EXPORT_FILE[format];
  const ext = extname(name);
  const tmp = join(outDir, `.export-${randomUUID()}${ext}`);
  let args: string[];
  let at: number | undefined;
  if (format === 'gif') {
    args = ['-y', '-i', input, '-vf', DEMO_GIF_FILTER, '-loop', '0', tmp];
  } else {
    // Default: one second into the first chapter (the title card is past), or 1 s with no markers.
    at = atSec ?? (parseMarkers(await readText(root, 'demo-video/chapters.md'))[0]?.sec ?? 0) + 1;
    args = ['-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-q:v', '3', '-update', '1', tmp];
  }
  try {
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
    const bytes = await fsp.stat(tmp).then((st) => (st.isFile() ? st.size : 0), () => 0);
    if (bytes === 0) {
      return {
        status: 422,
        body: { error: at !== undefined ? `no frame at ${at} s: the video is shorter` : `ffmpeg wrote no ${format}` },
      };
    }
    await fsp.rename(tmp, join(outDir, name));
    return { status: 200, body: { format, path: `demo-video/${name}`, bytes } };
  } finally {
    await fsp.rm(tmp, { force: true });
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
  // One encode per run, format and frame at a time: a double click joins the encode in flight.
  const exportsInFlight = new Map<string, Promise<DemoExportAnswer>>();
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
      if ((await demoRun(id)) === null) return reply.code(404).send({ error: 'no demo run with that id' });
      const { format, atSec } = parsed.data;
      const key = `${id}\0${format}\0${atSec ?? ''}`;
      let pending = exportsInFlight.get(key);
      if (pending === undefined) {
        pending = encodeDemoExport(id, format, atSec).finally(() => exportsInFlight.delete(key));
        exportsInFlight.set(key, pending);
      }
      const answer = await pending;
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
