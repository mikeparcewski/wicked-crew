/**
 * Which bus the daemon hands its engine, and whether exec mediation arms (DES-TEAMING-002 T0) —
 * one pure decision, so every branch is testable without booting a daemon.
 *
 * The rule: an UNAVAILABLE bus dominates every branch. Whichever file the engine would get — the
 * crew bus for an engine with the one-connection rule, or (an engine without it, under
 * `--engine-exec`) the pre-T0 exec bus — if crew's boot probe could not open it, the engine is
 * handed NO bus, exec mediation stays off, and the reason rides `/health.warnings`. Otherwise the
 * engine gets that file, and exec mediation arms exactly when `--engine-exec` asked for it.
 */

export interface BusUnavailable {
  dbPath: string;
  reason: string;
  /** Which failure (see `core/bus-notice.ts`): crew's probe could not open the file, or the engine
   *  could not arm its bus bridge on it. */
  kind: 'probe_open' | 'bridge_not_armed';
}

export interface EngineBusInput {
  /** The linked engine carries the one-connection rule (`Core.busConnectionStats`). */
  engineRule: boolean;
  /** `--engine-exec` / `WICKED_BUS_EXEC` asked for exec mediation. */
  engineExec: boolean;
  /** The crew bus (`resolveCrewBus`) and its boot probe (`undefined` = it opened). */
  busDbPath: string;
  busUnavailable: BusUnavailable | undefined;
  /** The pre-T0 exec bus an engine without the rule gets under `--engine-exec`, and its probe. */
  preRuleExecBusDbPath: string;
  preRuleExecUnavailable: BusUnavailable | undefined;
}

export type EngineBusHandoff =
  | { busDbPath: string; engineExec: boolean }
  | { busUnavailable: BusUnavailable; engineExec: false }
  | { engineExec: false };

export function engineBusHandoff(input: EngineBusInput): EngineBusHandoff {
  // An engine without the rule gets the pre-T0 handoff: a bus only under --engine-exec.
  const target = input.engineRule
    ? { dbPath: input.busDbPath, unavailable: input.busUnavailable }
    : input.engineExec
      ? { dbPath: input.preRuleExecBusDbPath, unavailable: input.preRuleExecUnavailable }
      : undefined;
  if (target === undefined) {
    return input.busUnavailable !== undefined
      ? { busUnavailable: input.busUnavailable, engineExec: false }
      : { engineExec: false };
  }
  if (target.unavailable !== undefined) return { busUnavailable: target.unavailable, engineExec: false };
  return { busDbPath: target.dbPath, engineExec: input.engineExec };
}
