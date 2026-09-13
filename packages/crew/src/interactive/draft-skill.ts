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

import type { WorkflowDef } from '../core/types.js';

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
