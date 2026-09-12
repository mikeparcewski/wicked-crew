/**
 * The ONE roster accessor every launch path shares: the registry roster decorated with crew's
 * STANDING (F-2R2-009) — runtime `health`, `signed_in`, `auth`, `council_eligible` + its reason,
 * the council bench — so `engineRosterJson` (core/engine-roster.ts) can bench a seat the daemon
 * already knows is unusable before the engine convenes it.
 *
 * F-RECON-002 / F-RECON-003: this used to be a closure inside `registerRoutes`, so ONLY the routes
 * (`POST /runs`, `/testing/*`, campaigns, steering) launched with standing. The interactive seams
 * (draft/edit/chat/demo subscribers), the adapter's onboarding launch (`seatsForWorkflow`) and
 * `wicked-crew start` handed the engine `CoreAdapter.roster()` RAW — every interactive council
 * convened codex/pi/copilot although the roster reported them `signed_out` (9–19 councilSeatFailed,
 * 57–112 s of dead ballots per run), and one council ELECTED signed-out pi, which then failed its
 * unit and fell over to claude. The factory below is what all of those now call; `createServer`
 * builds exactly one over its `SeatHealthTracker` and hands the same function everywhere.
 *
 * Standing is read at CALL time (the tracker's live state, the LIVE `WICKED_WORKER_HOME`), never
 * captured — a seat signed in from the System page is eligible on the very next launch.
 */

import { CoreAdapter } from '../core/adapter.js';
import type { RosterSeat } from '../core/types.js';
import type { SeatHealthTracker } from './seat-health.js';
import { signedInHeuristic } from './seat-signin.js';
import { seatStanding } from './seat-standing.js';

/** The accessor: the registry roster WITH crew's standing, freshly read on every call. */
export type RosterWithStanding = () => RosterSeat[];

export interface RosterStandingDeps {
  /** The daemon's per-seat runtime health + council evidence (councilSeatFailed, auth refusals). */
  seatHealth: SeatHealthTracker;
  /** Seat sign-in presence probe — injectable so tests never read the developer's dotfiles.
   *  Defaults to the file/env heuristic in seat-signin.ts. */
  signedIn?: (seatKey: string, workerConfigRoot?: string) => boolean | null;
  /** The registry roster (default: the engine's production roster via `CoreAdapter.roster()`).
   *  Injectable so a test decorates its own seats without the native addon. */
  registry?: () => unknown[];
  /** Where `WICKED_WORKER_HOME` is read from at call time (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the accessor. Each seat's registry fields ride through verbatim — the spread is
 * deliberately NOT a field whitelist, which is what lets the engine's `login_invocation` pass
 * untouched — and gains `health`, `signed_in`, and the standing readings (`auth`, `free_tier*`,
 * `council_eligible`, `council_ineligible_reason`, `council_bench`, `auth_source/evidence`).
 */
export function rosterWithStandingFactory(deps: RosterStandingDeps): RosterWithStanding {
  const { seatHealth } = deps;
  const signedIn = deps.signedIn ?? signedInHeuristic;
  const registry = deps.registry ?? (() => CoreAdapter.roster());
  const env = deps.env ?? process.env;
  return (): RosterSeat[] => {
    const workerRoot = env['WICKED_WORKER_HOME'];
    return (registry() as RosterSeat[]).map((seat) => {
      const key = String(seat.key);
      const health = seatHealth.healthFor(key);
      const signed = signedIn(key, workerRoot === '' ? undefined : workerRoot);
      return {
        ...seat,
        health,
        signed_in: signed,
        // The bench is THIS daemon's council evidence (councilSeatFailed, bounded window) — the
        // prediction learns from what the engine actually did with the seat (#533 review, F-1).
        ...seatStanding(
          seat as { key: string; enabled_for_council?: boolean; credential?: string; free_tier?: string },
          signed,
          health,
          seatHealth.councilBenchFor(key),
          // F-A45-006: the seat's OWN "no credential" report (a ballot's "No API key found", a
          // worker's 401, an auth ACP fallback) overrides the file probe — `auth` flips, not only
          // `council_eligible`, and the evidence rides on the wire.
          seatHealth.authFailureFor(key),
        ),
      };
    });
  };
}
