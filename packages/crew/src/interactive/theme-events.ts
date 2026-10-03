/**
 * The interactive-theme seam (DES-artifact-editor-plugins §7.6 "Theme learning", EP-C4) — the
 * sibling of `edit-events.ts`, same subscriber shape, ledger and filter pattern.
 *
 *  1. interactive grabs a page (or the operator points at a local PDF/image) and emits
 *     `wicked.interactive.theme.learned {document_id, render_path, format, url?}` (handlers.js).
 *  2. Crew answers with ONE governed `interactive-theme` run: one creator phase that reads the
 *     render in place (nothing uploads) and writes a token JSON in interactive's `DEFAULT_THEME`
 *     shape to a handoff output path (the handoff-by-file pattern).
 *  3. Crew validates the SHAPE, EVERY value's grammar (interactive's `theme-grammar.js`, ported
 *     field for field) and the CONTRAST (text on background ≥ 4.5:1), and refuses honestly with
 *     `status.posted {state:'error'}` when any check fails. Why the grammar (review S8): the
 *     tokens are interpolated raw into CSS custom properties and applied at every later version,
 *     and the creator phase read a grabbed third-party page — prompt-injection material. A value
 *     like `red;}body{background:url(https://x/?…)` must never ride into a version.
 *  4. Valid tokens are written THROUGH interactive — `PUT /d/:doc/api/theme/learned {tokens,
 *     apply: true}` (EP-I2) — which lands one re-themed version (`version.created {kind:'theme'}`).
 *     Interactive stays the only writer of its files (§9.1); it re-checks the grammar at the reader.
 *
 * Replay dedup and the handoff directory ride the edit seam's ledger and `interactive-edits` root
 * (keys `<doc>:theme:<ts>` beside the edit leg's `<doc>:v<n>`), so no new state-home entry is
 * introduced — the worker fence is unchanged.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { isAbsolute, join } from 'node:path';

import type { CoreAdapter } from '../core/adapter.js';
import { emitOnBus, requireEngineBus, tapBus, type BusEvent } from '../core/bus.js';
import type { CoreEvent, LaunchRunInput, WorkflowDef } from '../core/types.js';
import { resolveProjectGraphBinding, type ProjectGraphBinding } from '../projects/graph.js';
import { crewStateHome } from '../projects/state-home.js';
import type { InteractiveBridgePool } from './bridge-pool.js';
import { busSubscriberErrorReporter } from './bus-subscriber-errors.js';
import { unitDistributedLine } from './council-outcome.js';
import {
  DOC_NAME,
  INTERACTIVE_DOMAIN,
  INTERACTIVE_PRODUCER,
  STATUS_POSTED,
  docScope,
  narrationStamps,
  oneLine,
  recallClause,
  type SeamStatusPayload,
} from './draft-events.js';
import { InteractiveHandoffLedger } from './ledger.js';

// ── Vocabulary (interactive's, verbatim — src/service/events.js is the truth) ───────────────────

export const THEME_LEARNED = 'wicked.interactive.theme.learned';
export const INTERACTIVE_THEME_BUS_FILTER = `${THEME_LEARNED}@${INTERACTIVE_DOMAIN}`;
export const INTERACTIVE_THEME_WORKFLOW = 'interactive-theme';

/** The token groups and keys of interactive's `DEFAULT_THEME` (theme.js) — the shape a run must write. */
export const THEME_SHAPE = {
  colors: ['background', 'surface', 'primary', 'secondary', 'accent', 'text_primary', 'text_secondary', 'text_muted', 'border', 'success', 'warning', 'error'],
  fonts: ['heading', 'body', 'mono'],
  sizes: ['title', 'subtitle', 'heading', 'subheading', 'body', 'caption', 'small'],
  spacing: ['margin', 'gap_large', 'gap_medium', 'gap_small', 'gap_xs'],
  layout: ['viewport_width', 'viewport_height', 'content_width', 'content_start_x', 'content_start_y'],
  card: ['background', 'border_radius', 'padding', 'shadow'],
} as const;

export const INTERACTIVE_THEME_WORKFLOW_DEF: WorkflowDef = {
  id: INTERACTIVE_THEME_WORKFLOW,
  phases: [
    {
      id: 'learn',
      kind: 'build',
      instructions:
        'Read the handoff JSON file named in the task. Open the render at its "render_path" (a PDF or an image already on this machine — read it in place, upload nothing) and learn the design: palette, type, spacing, card treatment. Then SAVE one JSON object of design tokens to the exact absolute "output_path" (create parent directories if needed, overwrite if present) in EXACTLY this shape — {"name":"<theme name>","colors":{"background","surface","primary","secondary","accent","text_primary","text_secondary","text_muted","border","success","warning","error"},"fonts":{"heading","body","mono"},"sizes":{"title","subtitle","heading","subheading","body","caption","small"},"spacing":{"margin","gap_large","gap_medium","gap_small","gap_xs"},"card":{"background","border_radius","padding","shadow"}} — with every key present. Grammar, NON-NEGOTIABLE: a colour is #rgb/#rrggbb/#rrggbbaa or rgb()/rgba()/hsl()/hsla() with numbers; a size or spacing is <number>px|rem|em|pt; a font is a comma-separated list of family names (letters, digits, spaces, hyphens; quotes allowed); the card shadow is at most two comma-separated "<x> <y> [blur] <colour>" entries. No value may contain a semicolon, braces, angle brackets, a backslash, url( or a newline. Text (text_primary) on background must read at 4.5:1 contrast or better. Never fabricate a brand you did not see. Write the file before you finish and end your reply with its absolute path.',
      gate_type: 'execution',
      gate: 'auto',
      executes_code: false,
      verified_evidence: false,
      required_deliverables: [],
      depends_on: [],
      role: 'creator',
      skill_ref: null,
      allowed_skills: [],
      validator_pin: null,
    },
  ],
};

// ── The payload ────────────────────────────────────────────────────────────────────────────────

export interface ThemeLearned {
  documentId: string;
  renderPath: string;
  format: 'pdf' | 'image';
  url?: string;
  projectId?: string;
  /** The event's own timestamp: the dedupe key, so re-learning the same doc later is a new handoff. */
  ts: string;
}

export function parseThemeLearned(eventType: string, payload: unknown): ThemeLearned | null {
  if (eventType !== THEME_LEARNED) return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const documentId = typeof p['document_id'] === 'string' ? p['document_id'] : '';
  if (!DOC_NAME.test(documentId)) return null;
  const renderPath = typeof p['render_path'] === 'string' ? p['render_path'] : '';
  if (renderPath === '' || !isAbsolute(renderPath)) return null;
  const format = p['format'] === 'image' ? 'image' : p['format'] === 'pdf' ? 'pdf' : null;
  if (format === null) return null;
  const ts = typeof p['ts'] === 'string' && p['ts'] !== '' ? p['ts'] : '';
  if (ts === '') return null;
  const url = typeof p['url'] === 'string' && p['url'] !== '' ? p['url'] : undefined;
  const projectId = typeof p['project_id'] === 'string' && p['project_id'] !== '' ? p['project_id'] : undefined;
  return { documentId, renderPath, format, ts, ...(url !== undefined ? { url } : {}), ...(projectId !== undefined ? { projectId } : {}) };
}

export function themeHandoffKey(documentId: string, ts: string): string {
  return `${documentId}:theme:${ts}`;
}

export function themeProblem(learned: ThemeLearned, handoffPath: string): string {
  const from = learned.url !== undefined ? `grabbed from ${oneLine(learned.url, 200)}` : `a local ${learned.format} the operator pointed at`;
  return (
    `Learn the design tokens of the wicked-interactive document "${learned.documentId}" from its render (${from}). ` +
    `Read the handoff file at ${handoffPath} — a JSON file naming render_path (the render to read, in place) and ` +
    `output_path (the exact absolute file the token JSON must be saved to). ` +
    `${recallClause(learned.projectId !== undefined ? { project: learned.projectId } : undefined)}` +
    `Write the tokens in the shape the handoff describes, obey its grammar to the letter, and end with the path you wrote.`
  );
}

// ── The grammar (interactive's src/core/theme-grammar.js, field for field) ─────────────────────

const BANNED = /[;{}<\\\n\r]|url\(/iu;
const NUM = String.raw`(?:\d{1,3}(?:\.\d+)?%?|\.\d+%?)`;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const COLOR_FN = new RegExp(String.raw`^(?:rgba?|hsla?)\(\s*${NUM}(?:\s*,\s*${NUM}){2,3}\s*\)$`, 'iu');
const WI_VAR = /^var\(--wi-[a-z0-9-]{1,40}\)$/u;
const LENGTH = /^\d{1,3}(?:\.\d{1,2})?(?:px|rem|em|pt)$/u;
const SHADOW_OFFSET = /^(?:0|-?\d{1,3}(?:\.\d{1,2})?(?:px|rem|em|pt))$/u;
const SHADOW_BLUR = /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|rem|em|pt))$/u;
const FAMILY = /^(?:[A-Za-z0-9 -]{1,64}|'[A-Za-z0-9 -]{1,64}'|"[A-Za-z0-9 -]{1,64}")$/u;
const NAME = /^[A-Za-z0-9 _-]{1,64}$/u;
const PROSE = /^[^<>{};\\\n\r]{0,200}$/u;

export function isColor(v: unknown): boolean {
  return typeof v === 'string' && (HEX.test(v) || COLOR_FN.test(v) || WI_VAR.test(v));
}
export function isLength(v: unknown): boolean {
  return typeof v === 'string' && LENGTH.test(v);
}
export function isFontList(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 200) return false;
  const parts = v.split(',').map((p) => p.trim());
  return parts.length > 0 && parts.every((p) => p !== '' && FAMILY.test(p));
}
export function isShadow(v: unknown): boolean {
  if (typeof v !== 'string' || BANNED.test(v)) return false;
  if (v.trim() === 'none') return true;
  const shadows = v.split(/,(?![^(]*\))/u).map((s) => s.trim());
  if (shadows.length === 0 || shadows.length > 2) return false;
  return shadows.every((s) => {
    const parts = s.match(/(?:[a-z]+\([^)]*\)|\S+)/giu) ?? [];
    if (parts.length < 3 || parts.length > 4) return false;
    const colour = parts[parts.length - 1]!;
    const lengths = parts.slice(0, -1);
    if (!isColor(colour)) return false;
    if (!SHADOW_OFFSET.test(lengths[0]!) || !SHADOW_OFFSET.test(lengths[1]!)) return false;
    return lengths.length === 2 || SHADOW_BLUR.test(lengths[2]!);
  });
}
const isNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

type Check = (v: unknown) => boolean;
const GROUPS: Record<string, Record<string, Check>> = {
  colors: Object.fromEntries(THEME_SHAPE.colors.map((k) => [k, isColor])),
  fonts: Object.fromEntries(THEME_SHAPE.fonts.map((k) => [k, isFontList])),
  sizes: Object.fromEntries(THEME_SHAPE.sizes.map((k) => [k, isLength])),
  spacing: Object.fromEntries(THEME_SHAPE.spacing.map((k) => [k, isLength])),
  layout: Object.fromEntries(THEME_SHAPE.layout.map((k) => [k, isNumber])),
  card: { background: isColor, border_radius: isLength, padding: isLength, shadow: isShadow },
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export type ThemeCheck = { ok: true } | { ok: false; reason: string };
const reject = (detail: string): ThemeCheck => ({ ok: false, reason: `theme-rejected:${detail}` });

/** Shape + per-field grammar, the first failing field decides (interactive's `checkThemeTokens`). */
export function checkThemeTokens(tokens: unknown): ThemeCheck {
  if (!isPlainObject(tokens)) return reject('not-an-object');
  for (const [key, val] of Object.entries(tokens)) {
    if (key === 'name') {
      if (typeof val !== 'string' || !NAME.test(val)) return reject('value-outside-grammar:name');
      continue;
    }
    if (key === 'display_name' || key === 'description') {
      if (typeof val !== 'string' || !PROSE.test(val) || BANNED.test(val)) return reject(`value-outside-grammar:${key}`);
      continue;
    }
    const group = Object.hasOwn(GROUPS, key) ? GROUPS[key]! : null;
    if (group === null) return reject(`unknown-key:${String(key).slice(0, 40)}`);
    if (!isPlainObject(val)) return reject(`not-an-object:${key}`);
    for (const [sub, v] of Object.entries(val)) {
      const field = `${key}.${String(sub).slice(0, 40)}`;
      const check = Object.hasOwn(group, sub) ? group[sub]! : null;
      if (check === null) return reject(`unknown-key:${field}`);
      if (typeof v === 'string' && BANNED.test(v)) return reject(`value-outside-grammar:${field}`);
      if (!check(v)) return reject(`value-outside-grammar:${field}`);
    }
  }
  // The groups a theme needs to render at all (DEFAULT_THEME): a learned theme that omits them
  // would wear the bundled fallback for those tokens — surprising, so it is refused here.
  for (const group of ['colors', 'fonts', 'sizes', 'spacing', 'card'] as const) {
    const got = tokens[group];
    if (!isPlainObject(got)) return reject(`missing-group:${group}`);
    for (const k of THEME_SHAPE[group]) if (!(k in got)) return reject(`missing-key:${group}.${k}`);
  }
  return { ok: true };
}

// ── Contrast (WCAG 2.x relative luminance) ────────────────────────────────────────────────────

/** `[r, g, b]` in 0..255 for a hex, rgb()/rgba() or hsl()/hsla() colour; `null` when not computable (`var()`). */
export function parseColor(v: string): [number, number, number] | null {
  const s = v.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(s);
  if (hex !== null) {
    const h = hex[1]!;
    if (h.length === 3) return [parseInt(h[0]! + h[0]!, 16), parseInt(h[1]! + h[1]!, 16), parseInt(h[2]! + h[2]!, 16)];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/iu.exec(s);
  if (fn === null) return null;
  const nums = fn[2]!.split(',').map((x) => x.trim());
  if (nums.length < 3) return null;
  const n = (x: string, max: number): number | null => {
    const pct = x.endsWith('%');
    const val = Number(pct ? x.slice(0, -1) : x);
    if (!Number.isFinite(val)) return null;
    return pct ? (val / 100) * max : val;
  };
  if (fn[1]!.toLowerCase().startsWith('rgb')) {
    const rgb = [n(nums[0]!, 255), n(nums[1]!, 255), n(nums[2]!, 255)];
    if (rgb.some((c) => c === null)) return null;
    return rgb.map((c) => Math.max(0, Math.min(255, c!))) as [number, number, number];
  }
  const h = n(nums[0]!, 360);
  const sat = n(nums[1]!, 1);
  const light = n(nums[2]!, 1);
  if (h === null || sat === null || light === null) return null;
  const hue = ((h % 360) + 360) % 360;
  const sN = Math.max(0, Math.min(1, nums[1]!.endsWith('%') ? sat : sat / 100));
  const lN = Math.max(0, Math.min(1, nums[2]!.endsWith('%') ? light : light / 100));
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lN - c / 2;
  const [r1, g1, b1] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The WCAG contrast ratio of two colours (≥ 1), or `null` when either is not computable. */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (ca === null || cb === null) return null;
  const la = luminance(ca);
  const lb = luminance(cb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const MIN_TEXT_CONTRAST = 4.5;

/** Text on background must read: `colors.text_primary` over `colors.background` ≥ 4.5:1. */
export function checkThemeContrast(tokens: Record<string, unknown>): ThemeCheck {
  const colors = tokens['colors'];
  if (!isPlainObject(colors)) return reject('missing-group:colors');
  const text = colors['text_primary'];
  const bg = colors['background'];
  if (typeof text !== 'string' || typeof bg !== 'string') return reject('missing-key:colors.text_primary|background');
  const ratio = contrastRatio(text, bg);
  if (ratio === null) return { ok: false, reason: 'contrast-not-checkable:colors.text_primary on colors.background (use #hex, rgb() or hsl())' };
  if (ratio < MIN_TEXT_CONTRAST) return { ok: false, reason: `contrast-too-low:${ratio.toFixed(2)}:1 for colors.text_primary on colors.background (needs ${MIN_TEXT_CONTRAST}:1)` };
  return { ok: true };
}

/** Shape, grammar, then contrast. The first failure is the honest refusal. */
export function validateThemeTokens(tokens: unknown): ThemeCheck {
  const shape = checkThemeTokens(tokens);
  if (!shape.ok) return shape;
  return checkThemeContrast(tokens as Record<string, unknown>);
}

/** Read the worker's output file. `null` tokens with the reason when it is missing or not JSON. */
export function collectThemeResult(outputPath: string): { tokens: unknown } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(outputPath, 'utf8');
  } catch {
    return { error: `no token file at ${outputPath}` };
  }
  try {
    return { tokens: JSON.parse(raw) as unknown };
  } catch (err) {
    return { error: `the token file is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Writing through interactive (EP-I2) ───────────────────────────────────────────────────────

export interface LearnedThemeWrite {
  version: number | null;
  parent?: number | null;
  unchanged?: boolean;
}

export type PutLearnedTheme = (documentId: string, projectId: string | undefined, tokens: Record<string, unknown>) => Promise<LearnedThemeWrite>;

/**
 * The default writer: the doc's bridge (reuse-or-start, per docs root) ← `PUT /d/:doc/api/theme/learned
 * {tokens, apply: true}`. Interactive validates the grammar again (400), writes `learned.theme.json`
 * and lands one re-themed version of the head inside its FIFO.
 */
export function putLearnedThemeViaBridge(
  pool: Pick<InteractiveBridgePool, 'ensure'>,
  resolveDocsRoot: (projectId: string | undefined) => string,
): PutLearnedTheme {
  return async (documentId, projectId, tokens) => {
    const bridge = await pool.ensure(resolveDocsRoot(projectId));
    const body = JSON.stringify({ tokens, apply: true });
    return new Promise<LearnedThemeWrite>((resolvePromise, rejectPromise) => {
      const req = httpRequest(
        {
          host: bridge.host,
          port: bridge.port,
          method: 'PUT',
          path: `/d/${encodeURIComponent(documentId)}/api/theme/learned`,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(text) as Record<string, unknown>;
            } catch {
              parsed = {};
            }
            if ((res.statusCode ?? 500) >= 300) {
              rejectPromise(new Error(`interactive refused the theme (${res.statusCode}): ${typeof parsed['error'] === 'string' ? parsed['error'] : oneLine(text, 200)}`));
              return;
            }
            resolvePromise({
              version: typeof parsed['version'] === 'number' ? parsed['version'] : null,
              ...(typeof parsed['parent'] === 'number' || parsed['parent'] === null ? { parent: parsed['parent'] as number | null } : {}),
              ...(parsed['unchanged'] === true ? { unchanged: true } : {}),
            });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('interactive did not answer the theme write in 30 s')));
      req.on('error', rejectPromise);
      req.end(body);
    });
  };
}

// ── The subscriber ─────────────────────────────────────────────────────────────────────────────

export interface InteractiveThemeOptions {
  dbPath?: string;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  /** Shared with the edit seam (one file, one instance); default: the edit ledger path. */
  ledger?: InteractiveHandoffLedger;
  ledgerPath?: string;
  /** Handoff root (default `<state home>/interactive-edits`, shared with the edit seam). */
  editDir?: string;
  clisJson?: string;
  roster?: () => unknown[];
  /** Writes the validated tokens through interactive. Required: without it the seam cannot land anything. */
  putLearnedTheme: PutLearnedTheme;
  onRunFiled?: (runId: string, projectId: string) => void;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

export interface InteractiveThemeSubscription {
  stop(): Promise<void> | void;
  ledger: InteractiveHandoffLedger;
  inFlightDocs(): string[];
}

interface InFlight {
  key: string;
  documentId: string;
  projectId?: string | undefined;
  outputPath: string;
  narration: string;
  runId?: string | undefined;
  narrationOrd?: number | undefined;
  heartbeat: ReturnType<typeof setInterval>;
  failureDetail?: string | undefined;
}

function rosterOf(adapter: CoreAdapter, roster?: () => unknown[]): unknown[] {
  if (roster !== undefined) return roster();
  const own = (adapter as unknown as { launchRoster?: () => unknown[] }).launchRoster;
  if (typeof own === 'function') return own.call(adapter);
  return (adapter.constructor as unknown as { roster(): unknown[] }).roster();
}

export async function startInteractiveThemeSubscriber(
  adapter: CoreAdapter,
  opts: InteractiveThemeOptions,
): Promise<InteractiveThemeSubscription | null> {
  const log = opts.log ?? ((m: string) => console.error(m));
  let busDbPath: string;
  try {
    busDbPath = requireEngineBus(opts.dbPath);
  } catch (err) {
    log(`[interactive-theme] has no bus${opts.dbPath !== undefined ? ` at ${opts.dbPath}` : ''} — theme learning disabled: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  try {
    await adapter.registerWorkflow(INTERACTIVE_THEME_WORKFLOW_DEF);
  } catch (err) {
    log(`[interactive-theme] could not register the '${INTERACTIVE_THEME_WORKFLOW}' workflow — theme learning disabled: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const ledger = opts.ledger ?? new InteractiveHandoffLedger(opts.ledgerPath ?? join(crewStateHome(), 'interactive-edit-ledger.json'));
  const editDir = opts.editDir ?? join(crewStateHome(), 'interactive-edits');
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const inFlight = new Map<string, InFlight>();

  async function emitInteractive(type: string, payload: Record<string, unknown>): Promise<boolean> {
    try {
      await emitOnBus(busDbPath, {
        event_type: type,
        domain: INTERACTIVE_DOMAIN,
        subdomain: 'status',
        payload: { ts: new Date().toISOString(), ...payload },
        producer_id: INTERACTIVE_PRODUCER,
      });
      return true;
    } catch (err) {
      log(`[interactive-theme] emit ${type} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  const emitStatus = (payload: SeamStatusPayload): Promise<boolean> => emitInteractive(STATUS_POSTED, { ...payload });
  const narrate = (flight: InFlight, message: string): void => {
    flight.narration = message;
    void emitStatus({ ...docScope(flight.documentId, flight.projectId), state: 'working', message, ...narrationStamps(flight) });
  };
  const endFlight = (runId: string): InFlight | undefined => {
    const flight = inFlight.get(runId);
    if (flight !== undefined) {
      clearInterval(flight.heartbeat);
      inFlight.delete(runId);
    }
    return flight;
  };

  const offCoreEvents = adapter.onEvent((event: CoreEvent) => {
    const runId = typeof event.session === 'string' ? event.session : undefined;
    if (runId === undefined) return;
    const flight = inFlight.get(runId);
    if (flight === undefined) return;
    flight.runId ??= runId;
    if (typeof event.ord === 'number') flight.narrationOrd = event.ord;
    switch (event.type) {
      case 'councilConvened':
        narrate(flight, 'Convening a council to pick who reads the design…');
        return;
      case 'unitDistributed':
        narrate(flight, unitDistributedLine(event, 'to read the design'));
        return;
      case 'unitDispatched':
        narrate(flight, 'Crew is reading the grabbed design and writing its tokens…');
        return;
      case 'unitOutputCaptured':
        narrate(flight, 'Tokens written — checking the shape, the grammar and the contrast…');
        return;
      case 'stepFailed': {
        const detail = typeof event.detail === 'string' ? event.detail.trim() : '';
        if (detail.length > 0) flight.failureDetail = detail;
        return;
      }
      case 'sessionCompleted':
        endFlight(runId);
        finalize(flight, runId).catch((err: unknown) => log(`[interactive-theme] finalizing run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`));
        return;
      case 'sessionFailed':
      case 'runCancelled': {
        endFlight(runId);
        ledger.recordFailure(flight.key);
        const why = flight.failureDetail !== undefined ? ` Reason: ${oneLine(flight.failureDetail, 600)}` : '';
        void emitStatus({
          ...docScope(flight.documentId, flight.projectId),
          state: 'error',
          message: `The crew run learning this theme ${event.type === 'runCancelled' ? 'was cancelled' : 'failed'} (run ${runId}).${why} Nothing was applied.`,
        });
        return;
      }
      default:
        return;
    }
  });

  async function finalize(flight: InFlight, runId: string): Promise<void> {
    const { documentId, projectId, key, outputPath } = flight;
    const result = collectThemeResult(outputPath);
    if ('error' in result) {
      ledger.recordFailure(key);
      await emitStatus({ ...docScope(documentId, projectId), state: 'error', message: `The crew's theme run wrote no usable tokens — ${result.error} (run ${runId}). Nothing was applied.` });
      return;
    }
    const check = validateThemeTokens(result.tokens);
    if (!check.ok) {
      ledger.recordFailure(key);
      await emitStatus({ ...docScope(documentId, projectId), state: 'error', message: `The learned theme was refused — ${check.reason} (run ${runId}). Nothing was applied; the document is unchanged.` });
      log(`[interactive-theme] run ${runId} refused for ${key}: ${check.reason}`);
      return;
    }
    try {
      const written = await opts.putLearnedTheme(documentId, projectId, result.tokens as Record<string, unknown>);
      ledger.recordEmitted(key);
      await emitStatus({
        ...docScope(documentId, projectId),
        state: 'complete',
        ...(written.version !== null ? { version: written.version } : {}),
        message:
          written.version !== null
            ? `Theme learned — version ${written.version} wears it now. Undo = fork from its parent.`
            : 'Theme learned and saved; the head already wore it, so no new version was made.',
      });
      log(`[interactive-theme] theme written for ${key} (run ${runId}, version ${written.version ?? 'unchanged'})`);
    } catch (err) {
      ledger.recordFailure(key);
      const reason = err instanceof Error ? err.message : String(err);
      await emitStatus({ ...docScope(documentId, projectId), state: 'error', message: `Crew learned the theme but interactive did not take it: ${oneLine(reason, 400)} (run ${runId}). The document is unchanged.` });
      log(`[interactive-theme] write for ${key} failed: ${reason}`);
    }
  }

  async function handleThemeLearned(event: BusEvent): Promise<void> {
    const learned = parseThemeLearned(event.event_type, event.payload);
    if (learned === null) return;
    const key = themeHandoffKey(learned.documentId, learned.ts);
    if (ledger.has(key)) {
      log(`[interactive-theme] handoff ${key} already answered (run ${ledger.get(key)?.runId}) — replay ignored`);
      return;
    }
    for (const f of inFlight.values()) if (f.key === key) return;

    const safeKey = key.replace(/[^a-zA-Z0-9_-]/gu, '-');
    const runDir = join(editDir, safeKey);
    mkdirSync(runDir, { recursive: true });
    const outputPath = join(runDir, 'theme.tokens.json');
    const handoffPath = join(runDir, 'handoff.json');
    writeFileSync(
      handoffPath,
      JSON.stringify({ document_id: learned.documentId, render_path: learned.renderPath, format: learned.format, ...(learned.url !== undefined ? { url: learned.url } : {}), output_path: outputPath, shape: THEME_SHAPE }, null, 2),
      'utf8',
    );
    const runId = randomUUID();
    await emitStatus({ ...docScope(learned.documentId, learned.projectId), state: 'processing', message: 'A governed crew is reading the design you grabbed…' });

    let projectGraphBinding: ProjectGraphBinding | null = null;
    if (learned.projectId !== undefined) {
      const decision = await resolveProjectGraphBinding(adapter, learned.projectId, undefined).catch((err: unknown) => ({
        binding: null,
        reason: `the project graph binding could not be resolved (${err instanceof Error ? err.message : String(err)}). This repo-less run gets no code graph.`,
      }));
      projectGraphBinding = decision.binding;
      log(`run ${runId}: ${decision.reason}`);
    }

    try {
      const input: LaunchRunInput = {
        problem: themeProblem(learned, handoffPath),
        sessionId: runId,
        clisJson: opts.clisJson ?? JSON.stringify(rosterOf(adapter, opts.roster)),
        workflow: INTERACTIVE_THEME_WORKFLOW,
        ...(learned.projectId !== undefined ? { projectId: learned.projectId } : {}),
        ...(projectGraphBinding !== null ? { projectGraph: projectGraphBinding } : {}),
        extraWriteRoots: [runDir],
        requireDeliverables: [outputPath],
      };
      await adapter.launchRun(input);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await emitStatus({ ...docScope(learned.documentId, learned.projectId), state: 'error', message: `Crew could not start a run to learn this theme: ${reason}.` });
      log(`[interactive-theme] launch for ${key} failed: ${reason}`);
      return;
    }
    ledger.recordLaunch(key, runId);
    if (learned.projectId !== undefined) opts.onRunFiled?.(runId, learned.projectId);
    const flight: InFlight = {
      key,
      documentId: learned.documentId,
      projectId: learned.projectId,
      outputPath,
      narration: 'Reading the grabbed design…',
      runId,
      heartbeat: setInterval(() => {
        const f = inFlight.get(runId);
        if (f !== undefined) void emitStatus({ ...docScope(f.documentId, f.projectId), state: 'working', message: f.narration, ...narrationStamps(f) });
      }, heartbeatMs),
    };
    inFlight.set(runId, flight);
    log(`[interactive-theme] launched run ${runId} for ${key}`);
  }

  const tap = await tapBus({
    dbPath: busDbPath,
    filter: INTERACTIVE_THEME_BUS_FILTER,
    pollIntervalMs: opts.pollIntervalMs,
    handler: handleThemeLearned,
    onError: busSubscriberErrorReporter({
      describe: (err, event) => `[interactive-theme] handler error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
      log,
      logError: opts.logError,
      pollIntervalMs: opts.pollIntervalMs ?? 2000,
    }),
  });

  return {
    ledger,
    inFlightDocs: () => [...new Set([...inFlight.values()].map((f) => f.documentId))],
    stop: async () => {
      offCoreEvents();
      for (const f of inFlight.values()) clearInterval(f.heartbeat);
      inFlight.clear();
      await tap.stop();
    },
  };
}
