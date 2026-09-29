/**
 * The document-deliverable quality floor skill — `wicked-garden-draft` (wicked-garden ≥ 12.35.0,
 * garden PR #1127) — as the interactive seams hand it to the engine.
 *
 * The 2026-09 recon's brochure (F-RECON-007/008/009: unreadable meta text, 4 pages for a 2-page
 * brief, an invented claim and a shipped `[PLACEHOLDER]`) was drafted by phases carrying
 * `skill_ref: null`: no skill owned drafting, so no design floor and no self-check ran. The
 * garden fix is a skill whose `## Runtime` block names ONE command the author runs on the SAVED
 * file before "done" (`self_check.py <out.html> --pages N --exact --render --repo <snapshot>`);
 * crew's half is (1) to name that skill on the drafting phases and (2) to name in the TASK what
 * the command needs — the page budget the brief implies and the repository snapshot(s) claims
 * must trace to — exactly as the skill's "In a governed run" section expects.
 *
 * GATED on the snapshot (design call, this module's one rule): the engine resolves `skill_ref`
 * against the published skills snapshot at PLAN time and REFUSES the run when the snapshot does
 * not hold it (wicked-core `SkillsError::Missing`: "the skills snapshot at … does not hold the
 * skills this run requires: …; enable and republish them (or fix the workflow's skill_ref)").
 * An unconditional stamp would therefore refuse EVERY interactive draft/edit/chat on a garden
 * older than 12.35.0 (or a snapshot never republished after upgrading). So the seams ask the
 * daemon's skills runtime whether the published snapshot holds the skill (enabled) when they ARM,
 * stamp the phases only then, and LOG which way it went — a run on an older garden proceeds as
 * before (no floor), and the log line says so and names the fix (upgrade garden, republish).
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { WorkflowDef } from '../core/types.js';
import { childEnvWithBootEstateDb } from '../core/governance-store.js';
import { discoverLivePlugin } from '../skills/plugin-source.js';

/** The skill's name as the snapshot keys it (path-derived: `skills/draft/SKILL.md` → `wicked-garden-draft`). */
export const DRAFT_SKILL = 'wicked-garden-draft';
/** The first wicked-garden release that ships it. */
export const DRAFT_SKILL_GARDEN_VERSION = '12.35.0';

/** Predicate the seams are wired with: does the PUBLISHED snapshot hold (and enable) `name`? */
export type SkillHeld = (name: string) => boolean;

/**
 * `def` with `skill_ref: DRAFT_SKILL` on every AGENT phase (a phase with a tool `executor` is
 * deterministic tooling and takes no skill) when `held`; the SAME def object otherwise — the
 * shared constant is never mutated either way.
 */
export function withDraftSkill(def: WorkflowDef, held: boolean): WorkflowDef {
  if (!held) return def;
  return {
    ...def,
    phases: def.phases.map((p) => (p.executor !== undefined ? p : { ...p, skill_ref: DRAFT_SKILL })),
  };
}

/** The page budget a brief + style imply, per the skill's § 2 defaults. */
export type PageBudget =
  | { pages: number; exact: true; source: 'brief' | 'style-default' }
  | { pages: null; exact: false; source: 'style-default' | 'unknown' };

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
};

/**
 * "two pages" / "2-page" / "a one-pager" in the brief wins (`--exact`, the skill's default reading
 * of a named count). Otherwise the style decides: a brochure/leaflet is 2 pages, a `doc` (memo/
 * prose) and a `web` page have NO page budget, a `ppt` deck's budget is its slide count — which the
 * outline fixes, so the clause tells the worker to pass the count it planned.
 */
export function pageBudgetFor(brief: string, style: string): PageBudget {
  const text = brief.toLowerCase();
  const onePager = /\bone[- ]pager\b/.test(text);
  if (onePager) return { pages: 1, exact: true, source: 'brief' };
  const m = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)[- ](?:printed |a4 |letter )?pages?\b/.exec(text);
  if (m !== null) {
    const raw = m[1]!;
    const n = /^\d+$/.test(raw) ? Number(raw) : WORD_NUMBERS[raw];
    if (n !== undefined && n >= 1 && n <= 60) return { pages: n, exact: true, source: 'brief' };
  }
  switch (style) {
    case 'brochure':
      return { pages: 2, exact: true, source: 'style-default' };
    case 'web':
    case 'doc':
    case 'ppt':
      return { pages: null, exact: false, source: 'style-default' };
    default:
      return { pages: null, exact: false, source: 'unknown' };
  }
}

/** The launcher the skill's `## Runtime` block names for a wicked-crew run. */
export const DRAFT_SELF_CHECK_LAUNCHER = '"$WICKED_GARDEN_ROOT/scripts/wicked-garden" run scripts/draft/self_check.py';

/**
 * The single-line task clause (FINDING-011: no embedded newline) that hands the worker what the
 * skill's self-check needs: the budget, the snapshot(s) to cite against, and the exact command on
 * the SAVED file. `revision: true` is the edit/chat wording — the file already has a page count the
 * user accepted; the revision must not change it, and no repo snapshot rides those legs.
 */
export function draftQualityClause(
  outPath: string,
  budget: PageBudget,
  snapshotDirs: readonly string[],
  opts: { revision?: boolean; style?: string } = {},
): string {
  const pagesFlag =
    budget.pages !== null
      ? `--pages ${budget.pages}${budget.exact ? ' --exact' : ''}`
      : opts.style === 'ppt'
        ? '--pages <the slide count the outline fixed> --exact'
        : '--no-pages';
  const budgetWords =
    budget.pages !== null
      ? `${budget.pages} printed page${budget.pages === 1 ? '' : 's'}, exactly (${budget.source === 'brief' ? 'the brief names it' : 'the style default'}) — cut content to fit, never spill`
      : opts.style === 'ppt'
        ? 'the slide count your outline fixed, exactly'
        : 'none (a web page / prose document has no page budget)';
  const repos =
    snapshotDirs.length > 0
      ? `${snapshotDirs.map((d) => `--repo ${d}`).join(' ')} (the repository snapshot${snapshotDirs.length === 1 ? '' : 's'} every number, URL and product claim must trace to)`
      : opts.revision === true
        ? '(no repository snapshot rides a revision — the claims scan checks placeholders and labels only)'
        : '(no repository snapshot is available — cite the estate tool results in the notes and label every mock visibly)';
  const modeFlag = opts.style === 'web' ? ' --mode screen --min-font-pt 0' : '';
  const when =
    opts.revision === true
      ? 'A revision can re-introduce a defect (a pin that darkens a caption), so before you end the turn run the wicked-garden-draft self-check on the revised file'
      : 'Before you declare the draft done, run the wicked-garden-draft self-check on the SAVED file';
  return (
    `QUALITY FLOOR (skill wicked-garden-draft): page budget = ${budgetWords}. ${when}: ` +
    `${DRAFT_SELF_CHECK_LAUNCHER} ${outPath} ${pagesFlag} --render${modeFlag} ${repos}; ` +
    `fix the document (never the check) and re-run until it prints PASS; paste the verdict line into your reply — ` +
    `a FAIL is yours to fix before the turn ends, and an UNVERIFIED page count must be disclosed in the notes with ` +
    `the structural estimate, never stated as a count. `
  );
}

/** The one log line a seam writes when it arms, saying which way the gate went and why. */
export function draftSkillArmLine(seam: string, held: boolean): string {
  return held
    ? `[${seam}] drafting phases carry skill_ref '${DRAFT_SKILL}' — the published skills snapshot holds it, so the ` +
        `contrast / page-budget / claims floor (and its self-check) governs every run on this seam`
    : `[${seam}] drafting phases carry NO skill_ref: the published skills snapshot does not hold '${DRAFT_SKILL}' ` +
        `(wicked-garden < ${DRAFT_SKILL_GARDEN_VERSION}, or not republished since upgrading) — runs proceed WITHOUT ` +
        `the quality floor, exactly as before; upgrade wicked-garden, republish the snapshot and restart crew to arm it ` +
        `(stamping it anyway would make the engine refuse every run at plan time: "the skills snapshot … does not hold the skills this run requires")`;
}


// ── THE DRAFT FLOOR: crew re-derives the skill's own verdict from the artifact (crew#621/#504) ──
//
// ## The defect
//
// On `interactive-draft` both agent phases ran `ungated: true` — "no deterministic floor: no
// pinned validator … no judge" — so the only thing between a breaching document and the user's
// canvas was the worker's own word. The brief asked for a print-ready two-page A4 brochure and the
// draft that landed was a ~3.4-page web layout with literal placeholder copy ("Demo and contact
// URL to be supplied") and invented "acceptance record" proof rows labelled only in an invisible
// ARIA attribute (crew#504). The worker IS told to run the `wicked-garden-draft` self-check
// ({@link draftQualityClause}) — and a run where it did, and fixed nine dangling citations, is
// exactly the run that proves the instruction is not a floor: nothing re-derived it.
//
// ## What crew can honestly own
//
// A `validator_pin` is a CONTENT ADDRESS into wicked-core's validator vault, and provisioning one
// is not exposed through the napi surface crew drives (`core/deliver.ts` documents this: the only
// pin crew can name is the worktree-diff EVIDENCE floor, which is fail-closed on the repo-less
// runs every interactive seam launches). So crew cannot pin the self-check as the draft phase's
// engine validator. What it CAN do is what the deliverable floor does one level out: re-derive the
// verdict itself, deterministically, from the artifact — by RUNNING the skill's own check, the same
// command with the same inputs, before the draft is published. No second copy of the rules: the
// floor's verdict IS `scripts/draft/self_check.py`'s.
//
// ## The one divergence, and why it is safe
//
// The worker runs the check with `--render` (headless Chrome prints the document and the page count
// is authoritative). Crew does not drive a browser at finalize, so its page count is the structural
// estimate — a LOWER bound, which cannot see a wrapper that overflows its sheet. A breach is
// therefore only reported when the count already EXCEEDS the budget (`> budget`): that direction is
// proven without a render, while "fewer pages than an exact budget" is exactly what only a render
// can judge and is left to the worker's own `--render` run and the page-count disclosure.
//
// A floor that cannot run (no garden plugin root, no Python, a timeout, an answer that is not the
// report's shape) is reported as UNAVAILABLE and the draft is published with that said out loud —
// never rounded to a pass, and never a hard failure of document generation on a machine whose
// Python is missing.

/** The self-check script, relative to the wicked-garden plugin root. */
export const DRAFT_SELF_CHECK_SCRIPT = 'scripts/draft/self_check.py';
/** The garden launcher crew spawns (it resolves the plugin's Python: venv → uv → python3 → python). */
export const DRAFT_LAUNCHER_SCRIPT = join('scripts', 'wicked-garden.mjs');
/** How long the floor gets before it is reported UNAVAILABLE (a claims scan walks the snapshot). */
export const DRAFT_FLOOR_TIMEOUT_MS = 120_000;

/** What crew's re-derivation of the draft floor concluded. */
export interface DraftFloorVerdict {
  /** `pass` — every floor the check could judge is met; `fail` — a floor is breached, with the
   *  rule named in {@link breaches}; `unverified` — no floor failed but the page count could not
   *  be verified (disclosed, published); `unavailable` — the floor could not run at all. */
  verdict: 'pass' | 'fail' | 'unverified' | 'unavailable';
  /** One line per breached floor, each naming the rule — what the thread and the log say. */
  breaches: string[];
  /** One line for the log / the thread: what was re-derived and what it found. */
  summary: string;
}

interface SelfCheckReport {
  verdict?: unknown;
  failed?: unknown;
  unverified?: unknown;
  checks?: {
    claims?: { ok?: unknown; by_kind?: unknown; findings?: unknown; summary?: unknown };
    contrast?: { ok?: unknown; contrast_failures?: unknown; size_failures?: unknown; summary?: unknown };
    pages?: { pages?: unknown; budget?: unknown; exact?: unknown; verified?: unknown; summary?: unknown };
  };
}

/** `wicked-garden run scripts/draft/self_check.py …` as argv for `node <launcher>` — the same
 *  inputs the worker's clause names ({@link draftQualityClause}), minus `--render`: crew does not
 *  drive a browser at finalize (see the module note above). */
export function draftFloorArgv(
  gardenRoot: string,
  outPath: string,
  budget: PageBudget,
  snapshotDirs: readonly string[],
  opts: { style?: string } = {},
): string[] {
  const pages =
    budget.pages !== null
      ? ['--pages', String(budget.pages), ...(budget.exact ? ['--exact'] : [])]
      : ['--no-pages'];
  const mode = opts.style === 'web' ? ['--mode', 'screen', '--min-font-pt', '0'] : [];
  return [
    join(gardenRoot, DRAFT_LAUNCHER_SCRIPT),
    'run',
    DRAFT_SELF_CHECK_SCRIPT,
    outPath,
    ...pages,
    ...mode,
    ...snapshotDirs.flatMap((d) => ['--repo', d]),
    '--json',
  ];
}

/** The count of each finding kind, as a readable list ("6 uncited-number, 1 placeholder"). */
function kindList(byKind: unknown): string {
  if (typeof byKind !== 'object' || byKind === null) return '';
  return Object.entries(byKind as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'number')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${String(v)} ${k}`)
    .join(', ');
}

/** A check record with a boolean `ok` — the shape the floor judges. `null` for anything else. */
function checkRecord(value: unknown): { ok?: unknown; [k: string]: unknown } | null {
  if (typeof value !== 'object' || value === null) return null;
  return typeof (value as { ok?: unknown }).ok === 'boolean' ? (value as { ok?: unknown }) : null;
}

/**
 * The verdict, from the self-check's own `--json` report (pure — this is what the tests pin).
 *
 * `claims` and `contrast` are deterministic over the file alone, so their failure IS a breach.
 * `pages` is only a breach when the count already exceeds the budget (see the module note): a
 * count below an `--exact` budget is unproven without a render and is reported as unverified.
 *
 * The report's SHAPE is judged first (codex review): a report whose `checks.claims` /
 * `checks.contrast` are missing or carry no boolean `ok` is not this floor's report — a schema
 * drift, or another program's output — and answers `unavailable`, never `pass`. And a report that
 * declares itself FAILED for a reason this floor does not recognise is a breach in its own right:
 * the floor reports the check's own `failed` list rather than passing a document the check refused.
 */
export function draftFloorVerdict(report: unknown, budget: PageBudget): DraftFloorVerdict {
  if (typeof report !== 'object' || report === null) {
    return {
      verdict: 'unavailable',
      breaches: [],
      summary: 'the draft floor could not be re-derived: the self-check printed no report',
    };
  }
  const rep = report as SelfCheckReport;
  const checks = rep.checks;
  if (
    typeof checks !== 'object' ||
    checks === null ||
    checkRecord(checks.claims) === null ||
    checkRecord(checks.contrast) === null
  ) {
    return {
      verdict: 'unavailable',
      breaches: [],
      summary:
        `the draft floor could not be re-derived: ${DRAFT_SELF_CHECK_SCRIPT} answered JSON that is not its ` +
        `report (no checks.claims / checks.contrast verdict) — the floor judges nothing it cannot read`,
    };
  }
  const claims = rep.checks?.claims;
  const contrast = rep.checks?.contrast;
  const pages = rep.checks?.pages;
  const breaches: string[] = [];
  if (claims?.ok === false) {
    const kinds = kindList(claims.by_kind);
    breaches.push(
      `claims: ${kinds !== '' ? kinds : 'findings'} — every number, URL and product claim must be cited ` +
        `(data-source path:line), every mock visibly labelled, and no placeholder copy may ship`,
    );
  }
  if (contrast?.ok === false) {
    const fails = typeof contrast.contrast_failures === 'number' ? contrast.contrast_failures : 0;
    const sizes = typeof contrast.size_failures === 'number' ? contrast.size_failures : 0;
    breaches.push(
      `contrast: ${fails} text/background pair(s) below the 4.5:1 floor and ${sizes} below the print size floor — ` +
        `the reader must be able to read it`,
    );
  }
  const count = typeof pages?.pages === 'number' ? pages.pages : null;
  const pagesUnverified = pages !== undefined && pages.verified === false;
  if (budget.pages !== null && count !== null && count > budget.pages) {
    breaches.push(
      `pages: the brief's budget is ${budget.pages} printed page(s)${budget.exact ? ' exactly' : ' at most'} and the ` +
        `document already declares ${count} — a page-size/count breach (the count is a lower bound: it cannot see a ` +
        `wrapper that overflows its sheet)`,
    );
  }
  // The check refused the document for a reason this floor does not know how to name: report the
  // refusal as the check stated it, never a pass (codex review).
  if (breaches.length === 0 && rep.verdict === 'FAIL') {
    const failed = Array.isArray(rep.failed) ? rep.failed.filter((f): f is string => typeof f === 'string') : [];
    breaches.push(
      `the self-check reports FAIL on ${failed.length > 0 ? failed.join(', ') : 'a floor this check names'} — ` +
        `a verdict this floor cannot attribute to one rule, so the document is not published on it`,
    );
  }
  if (breaches.length > 0) {
    return {
      verdict: 'fail',
      breaches,
      summary: `the draft floor FAILED on the saved document: ${breaches.length} breach(es) — ${breaches.join(' | ')}`,
    };
  }
  if (pagesUnverified) {
    return {
      verdict: 'unverified',
      breaches: [],
      summary:
        `the draft floor met every rule it could judge; the page count is UNVERIFIED without a render ` +
        `(${typeof pages?.summary === 'string' ? pages.summary : 'structural estimate only'})`,
    };
  }
  return { verdict: 'pass', breaches: [], summary: 'the draft floor met every rule on the saved document' };
}

/** Where the live wicked-garden plugin is, or null when nothing is installed / discovery refused
 *  (a symlink below a config dir). The same source the daemon's skills runtime publishes from. */
export function gardenPluginRoot(): string | null {
  try {
    return discoverLivePlugin()?.path ?? null;
  } catch {
    return null;
  }
}

/** Injectable IO for {@link runDraftFloor} — tests substitute the spawn and the root. */
export interface DraftFloorIo {
  gardenRoot?: () => string | null;
  /** Runs `node <argv>` and resolves its stdout (the `--json` report). Default: `node:child_process`. */
  run?: (argv: string[], timeoutMs: number) => Promise<{ stdout: string; code: number | null }>;
  timeoutMs?: number;
}

function runNode(argv: string[], timeoutMs: number): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    // The child's env goes through `childEnvWithBootEstateDb` like every other spawn in src/
    // (crew#495, `tests/governance-child-env.test.ts`): a daemon-exported governance store must
    // not reach the self-check's Python.
    const child = spawn(process.execPath, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: childEnvWithBootEstateDb(),
    });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.resume(); // drained, never buffered: the JSON report is on stdout
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ stdout, code }));
  });
}

/**
 * Re-derive the draft floor on the SAVED document: run the skill's own self-check and judge its
 * report ({@link draftFloorVerdict}). Never throws — a floor that cannot run answers
 * `unavailable` with the reason, because a broken check must not read as a pass and must not take
 * document generation down with it.
 */
export async function runDraftFloor(
  outPath: string,
  budget: PageBudget,
  snapshotDirs: readonly string[],
  opts: { style?: string } = {},
  io: DraftFloorIo = {},
): Promise<DraftFloorVerdict> {
  const root = (io.gardenRoot ?? gardenPluginRoot)();
  if (root === null) {
    return {
      verdict: 'unavailable',
      breaches: [],
      summary:
        'the draft floor could not be re-derived: no installed wicked-garden plugin root was found, so ' +
        `${DRAFT_SELF_CHECK_SCRIPT} could not be run (install wicked-garden, or set WICKED_CREW_SKILLS_SOURCE)`,
    };
  }
  const argv = draftFloorArgv(root, outPath, budget, snapshotDirs, opts);
  let answer: { stdout: string; code: number | null };
  try {
    answer = await (io.run ?? runNode)(argv, io.timeoutMs ?? DRAFT_FLOOR_TIMEOUT_MS);
  } catch (err) {
    return {
      verdict: 'unavailable',
      breaches: [],
      summary: `the draft floor could not be re-derived: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let report: unknown;
  try {
    report = JSON.parse(answer.stdout.trim());
  } catch {
    return {
      verdict: 'unavailable',
      breaches: [],
      summary:
        `the draft floor could not be re-derived: ${DRAFT_SELF_CHECK_SCRIPT} exited ${String(answer.code)} without a ` +
        `JSON report (is Python 3 installed for the wicked-garden launcher?)`,
    };
  }
  return draftFloorVerdict(report, budget);
}
