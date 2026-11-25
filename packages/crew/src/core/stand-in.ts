/**
 * THE STAND-IN CHOICE at launch (DES-STANDIN-001 §4, crew stage K2a; wicked-core#1843).
 *
 * A job needs checks by helpers that did not build the work (a reviewer, a judge, a QE reviewer, a council).
 * When too few helpers are signed in, the engine can seat a STAND-IN: a fresh session of a signed-in helper
 * that sees the work but none of the builder's reasoning, labelled everywhere and never counted as an
 * independent review. It does so only on a launch that carries `standInAware`, and only with a person's
 * consent. This module is the pure half: who consented (`consentFor`), and the refusal bodies a launch
 * answers when the engine's preflight (`Core.independencePreflight`, §3.9) finds the roster short.
 *
 * Consent is a person's. `by` and `at` are the server's, never a request body's: a human's `standIns: true`
 * on the launch (scope `job`), or the `standInReview: 'always'` setting a person saved (scope `always`).
 */
import type {
  IndependencePreflight,
  NoUsableHelperRefusal,
  StandInChoiceRefusal,
  StandInConsent,
} from 'wicked-crew-api-types';

/** The `standInReview` setting's values (`SystemSettings.standInReview`); absent reads as `'ask'`. */
export const STAND_IN_REVIEW_VALUES = ['ask', 'always'] as const;
export type StandInReview = (typeof STAND_IN_REVIEW_VALUES)[number];

export function isStandInReview(v: unknown): v is StandInReview {
  return v === 'ask' || v === 'always';
}

/** The gate answer that grants stand-ins at a `stand_in_needed` gate (`GateDecision.action`). */
export const USE_STAND_INS_ACTION = 'use_stand_ins' as const;
/** The gate class (`gate_kind`) a run holds on for want of a stand-in consent. */
export const STAND_IN_NEEDED_GATE = 'stand_in_needed' as const;
export const STAND_IN_SCOPES = ['job', 'always'] as const;
export type StandInScope = (typeof STAND_IN_SCOPES)[number];

/** `by` on a launch under the `always` setting when the setting carries no author (wicked-core#1930 F6): it was saved
 *  before crew recorded one, turned on by hand, or its record is out of shape. */
export const STAND_IN_SETTING_UNRECORDED = 'the standInReview setting (author not recorded)';

/** The consent the `always` setting stores (`SystemSettings.standInConsent`): the person who saved it, and when. */
export function settingConsent(who: string, now: number = Date.now()): StandInConsent {
  return { scope: 'always', by: who, at: now, via: 'setting' };
}

/** Whether a stored `standInConsent` has the shape `settingConsent` writes (a hand edit may not). */
export function isSettingConsent(v: unknown): v is StandInConsent {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  // The engine refuses a blank author and reads `at` as an i64 (ms), so a record it would refuse is no record.
  return c['scope'] === 'always' && c['via'] === 'setting' && typeof c['by'] === 'string' && c['by'].trim() !== ''
    && Number.isSafeInteger(c['at']) && (c['at'] as number) >= 0;
}

/**
 * The consent a launch carries, or `null` (DES §4 `consentFor`). `humanFlag` is the launch body's
 * `standIns: true`, already checked to come from a person (a worker's bearer gets 403 before this).
 * `who` is the server's name for the launcher (`<id> (<kind>)`). Under the `always` setting the consent is the
 * person's who saved it (`saved`, wicked-core#1930 F6), never the launcher's: a workload token only inherits it.
 */
export function consentFor(
  humanFlag: boolean,
  setting: StandInReview | undefined,
  who: string,
  now: number = Date.now(),
  saved?: StandInConsent,
): StandInConsent | null {
  if (humanFlag) return { scope: 'job', by: who, at: now, via: 'launch' };
  if (setting === 'always') return isSettingConsent(saved) ? { ...saved } : settingConsent(STAND_IN_SETTING_UNRECORDED, now);
  return null;
}

/** The preflight's answer, read defensively: `null` when the engine's JSON is not one (the launch then goes
 *  on unaware, as before). */
export function readPreflight(raw: string): IndependencePreflight | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['short'] !== 'boolean' || !Array.isArray(o['roles'])) return null;
  for (const r of o['roles']) {
    if (typeof r !== 'object' || r === null) return null;
    const role = r as Record<string, unknown>;
    if (typeof role['role'] !== 'string' || typeof role['canStandIn'] !== 'boolean' || typeof role['shortBy'] !== 'number') return null;
  }
  return v as IndependencePreflight;
}

/** The roles a stand-in could fill (split into the ones every run needs and the ones a run needs only if it calls
 *  for them, DES §2.2), and those no helper on the job can fill (DES §2.5). */
function shortRoles(p: IndependencePreflight): { canFill: string[]; needed: string[]; conditional: string[]; cannot: string[] } {
  const short = p.roles.filter((r) => r.shortBy > 0);
  const fill = short.filter((r) => r.canStandIn);
  return {
    canFill: fill.map((r) => r.role),
    needed: fill.filter((r) => !r.conditional).map((r) => r.role),
    conditional: fill.filter((r) => r.conditional).map((r) => r.role),
    cannot: short.filter((r) => !r.canStandIn).map((r) => r.role),
  };
}

/** What the job needs, as this launch has it: the roles every run needs, then the ones only a run that calls for
 *  them needs. The helpers are "this job's": the person may have picked them, so nothing here says "signed in". */
function needsSentence(needed: readonly string[], conditional: readonly string[]): string {
  if (needed.length === 0) {
    return `If the job calls for them, it needs ${words(conditional)} that did not build the work, and this job's helpers can't be those.`;
  }
  const tail = conditional.length > 0 ? `, and, if the job calls for them, ${words(conditional)}` : '';
  return `This job's helpers can't check it independently: it needs ${words(needed)} that did not build the work${tail}.`;
}

const ROLE_WORDS: Readonly<Record<string, string>> = {
  evaluator: 'a reviewer',
  party_excluded: 'a reviewer',
  judge: 'a judge',
  qe_reviewer: 'a QE reviewer',
  rule_judge: 'a rules checker',
  rule_council: 'a rules council',
  council: 'a council',
  monitor: 'a monitor',
};

function words(roles: readonly string[]): string {
  const named = [...new Set(roles.map((r) => ROLE_WORDS[r] ?? 'another check'))];
  if (named.length <= 1) return named[0] ?? 'a check';
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`;
}

/**
 * What the launch answers for this preflight with no consent: `null` = launch (not short), else the
 * `409` body. Short and no role a stand-in could fill → `no_usable_helper` (§2.5: a stand-in never makes
 * up for a CLI that cannot run); short otherwise → `stand_in_choice` (§2.1).
 */
export function preflightRefusal(p: IndependencePreflight): StandInChoiceRefusal | NoUsableHelperRefusal | null {
  if (!p.short) return null;
  const { canFill, needed, conditional, cannot } = shortRoles(p);
  if (cannot.length > 0 || canFill.length === 0) {
    return {
      code: 'no_usable_helper',
      error: `No helper on this job can be ${words(cannot.length > 0 ? cannot : p.roles.map((r) => r.role))} for it, even as a stand-in, so it can't start. Add another helper to the job, or sign one in, and start it again.`,
      preflight: p,
    };
  }
  // (coord round 2 F4) The words a CLI or MCP reader sees: the needs this launch has, and the ways through in words
  // (the request field is `retryWith`, never the sentence's end).
  return {
    code: 'stand_in_choice',
    error:
      `${needsSentence(needed, conditional)} `
      + 'wicked can fill those roles with stand-ins (a fresh session that sees the work but none of the builder\'s reasoning), '
      + 'labelled on the job, every gate, the delivery and the pull request. They are not independent reviews. '
      + 'Use stand-ins for this job or for every job, or add another helper to the job.',
    preflight: p,
    choices: [
      { id: 'job', label: 'Use stand-ins for this job' },
      { id: 'always', label: 'Use stand-ins for every job' },
      { id: 'sign_in', label: 'Add or sign in another helper' },
      { id: 'cancel', label: 'Cancel' },
    ],
    retryWith: { standIns: true },
  };
}
