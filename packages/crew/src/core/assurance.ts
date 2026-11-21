/**
 * Full assurance refuses self-evaluation and holds a gate with no judge. Crew asks the engine's
 * `Core.judgeCoverage` for the launch roster and binding; it never predicts the judge pool itself.
 * `single_cli_roster` means every work seat is one CLI identity; other uncovered pools receive
 * `no_independent_judge`. A person can sign in another CLI or explicitly choose reduced assurance.
 */

/** The engine's judge pool, read for the exact roster and repository binding of a launch. */
export interface JudgeCoverage {
  covered: boolean;
  singleIdentity: boolean;
  authors: Array<{
    seat: string;
    judges: Array<{ seat: string; seenSharing?: string }>;
    notJudges: Array<{ seat: string; reason: string; detail?: string }>;
  }>;
  benched: Array<{ seat: string; reason: string; detail?: string }>;
}

/** Unknown coverage stays unknown: crew never predicts the engine's judge pool itself. */
export function readJudgeCoverage(
  engineClisJson: string,
  bound: boolean,
  predicate: (clisJson: string, bound: boolean) => string | null,
): JudgeCoverage | null {
  try {
    const raw = predicate(engineClisJson, bound);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
    const seat = (v: unknown): v is Record<string, unknown> => object(v) && typeof v['seat'] === 'string' && v['seat'] !== '';
    const reason = (v: unknown): boolean => seat(v) && typeof v['reason'] === 'string' && (v['detail'] === undefined || typeof v['detail'] === 'string');
    if (!object(value) || typeof value['covered'] !== 'boolean' || typeof value['singleIdentity'] !== 'boolean' ||
      !Array.isArray(value['authors']) || !Array.isArray(value['benched']) || !value['benched'].every(reason)) return null;
    for (const author of value['authors']) {
      if (!seat(author) || !Array.isArray(author['judges']) || !Array.isArray(author['notJudges']) ||
        !author['notJudges'].every(reason) || !author['judges'].every((j: unknown) => seat(j) && (j['seenSharing'] === undefined || typeof j['seenSharing'] === 'string'))) return null;
    }
    return value as unknown as JudgeCoverage;
  } catch {
    return null;
  }
}

export const SINGLE_CLI_ROSTER_CODE = 'single_cli_roster' as const;

/** An uncovered launch's disclosure and explicit way to relaunch with fewer checks. */
export interface LaunchAssuranceNotice {
  /** One CLI identity across work seats, or another lack of independent judges. */
  code: typeof SINGLE_CLI_ROSTER_CODE | 'no_independent_judge';
  /** What full assurance will hold and how the person can proceed. */
  message: string;
  /** Keys of seats that can author work on this run. */
  seats: string[];
  /** Merge into a new launch only when the person chooses reduced assurance. */
  retryWith: { retryOf: string; reducedAssurance: true };
}

/** One sentence for a chat card, using the engine's reasons rather than promising a judge. */
export function coverageNote(coverage: JudgeCoverage | null, nameOf: (key: string) => string = (key) => key): string | null {
  if (coverage === null || coverage.covered || coverage.authors.length === 0) return null;
  const reasons = new Set<string>();
  for (const author of coverage.authors) {
    for (const other of author.notJudges) {
      if (other.reason === 'same_identity') reasons.add(`${nameOf(other.seat)} runs the same CLI as ${nameOf(author.seat)}`);
      else if (other.reason === 'benched') reasons.add(`${nameOf(other.seat)} cannot check it: ${other.detail ?? 'it cannot work on this run'}`);
      else reasons.add(`${nameOf(other.seat)} cannot check work on this run`);
    }
    for (const judge of author.judges) {
      if (judge.seenSharing !== undefined) reasons.add(`${nameOf(judge.seat)} was seen calling ${judge.seenSharing}, as was ${nameOf(author.seat)}`);
    }
  }
  return `These seats cannot independently check one another's work${reasons.size > 0 ? `: ${[...reasons].join('; ')}` : ''}; the run may wait for a person at a gate.`;
}

export function launchAssuranceNotice(opts: {
  runId: string;
  reducedAssurance: boolean | undefined;
  coverage: JudgeCoverage | null;
}): LaunchAssuranceNotice | null {
  if (opts.reducedAssurance === true) return null;
  const note = coverageNote(opts.coverage);
  if (note === null || opts.coverage === null) return null;
  const seats = opts.coverage.authors.map((s) => s.seat);
  return {
    code: opts.coverage.singleIdentity ? SINGLE_CLI_ROSTER_CODE : 'no_independent_judge',
    message: opts.coverage.singleIdentity
      ? `Every seat that can work (${seats.join(', ')}) runs the same CLI, so no other CLI can evaluate or judge this run's ` +
        `work. Under full assurance the engine refuses a review on its builder's seat and holds a gate that needs a ` +
        `judge, so if this run reviews or changes code it will wait at a gate for a distinct seat. Sign a second CLI ` +
        `in, or relaunch with "reducedAssurance": true to let it evaluate its own work, disclosed on every receipt.`
      : `${note} Sign in a seat of another CLI, or relaunch with "reducedAssurance": true.`,
    seats,
    retryWith: { retryOf: opts.runId, reducedAssurance: true },
  };
}
