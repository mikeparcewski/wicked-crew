/**
 * The ONE roster accessor every launch path shares: the registry roster decorated with crew's
 * STANDING (F-2R2-009) — runtime `health`, `signed_in`, `auth`, `council_eligible` + its reason —
 * so `engineRosterJson` (core/engine-roster.ts) can bench a seat the daemon already knows is
 * unusable before the engine convenes it. (R5b: crew keeps no council bench of its own.)
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
import { SeatProbe } from './seat-probe.js';
import { seatStanding, chatSeatAdmission, type StandingSeat } from './seat-standing.js';

/** The accessor: the registry roster WITH crew's standing, freshly read on every call. `ready`
 *  (crew#645), awaited by a launch before it reads the roster, waits — bounded — for every seat's
 *  missing or stale login check, so an expired login reads `signed_out` before work is routed. */
export type RosterWithStanding = (() => RosterSeat[]) & { ready?: () => Promise<void> };

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
  /** The live seat credential probe (crew#630, `seat-probe.ts`). Default: a real one when neither
   *  `signedIn` nor `registry` is injected (the daemon), none otherwise — a test that fixes the
   *  sign-in reading gets exactly that reading. `null` turns it off. */
  probe?: SeatProbe | null;
}

/**
 * Build the accessor. Each seat's registry fields ride through verbatim — the spread is
 * deliberately NOT a field whitelist, which is what lets the engine's `login_invocation` pass
 * untouched — and gains `health`, `signed_in`, and the standing readings (`auth`, `free_tier*`,
 * `council_eligible`, `council_ineligible_reason`, `auth_source/evidence`).
 */
export function rosterWithStandingFactory(deps: RosterStandingDeps): RosterWithStanding {
  const { seatHealth } = deps;
  const signedIn = deps.signedIn ?? signedInHeuristic;
  const registry = deps.registry ?? (() => CoreAdapter.roster());
  const env = deps.env ?? process.env;
  const probe =
    deps.probe !== undefined ? deps.probe : deps.signedIn === undefined && deps.registry === undefined ? new SeatProbe() : null;
  const liveRoot = (): string | undefined => {
    const workerRoot = env['WICKED_WORKER_HOME'];
    return workerRoot === '' ? undefined : workerRoot;
  };
  const accessor: RosterWithStanding = (): RosterSeat[] => {
    const root = liveRoot();
    return (registry() as RosterSeat[]).map((seat) => {
      const key = String(seat.key);
      const health = seatHealth.healthFor(key);
      // crew#630: the seat's own auth-status answer (cached; never awaited here). A probed seat
      // whose probe has not answered yet does not read `signed_in` off its file — a credential
      // file is not a working login (a moved worker home keeps `.claude.json` and loses the
      // keychain token) — it reads `unknown` until the probe answers.
      const probed = probe?.read(key, root);
      const heuristic = signedIn(key, root);
      const signed =
        probed !== undefined && probed.signedIn !== null
          ? probed.signedIn
          : probe?.probes(key) === true && heuristic === true
            ? null
            : heuristic;
      // (R5b, DES-L3 PR-3D) No crew-side council bench any more: the engine's per-run ballot ledger
      // (`session.benched_seats`) is the one bench, so there is no bench reading to pass and no
      // health reading to weigh — the roster's standing is the auth picture alone.
      const standing = seatStanding(
        seat as { key: string; enabled_for_council?: boolean; credential?: string; free_tier?: string },
        signed,
        // F-A45-006: the seat's OWN "no credential" report (a ballot's "No API key found", a
        // worker's 401, an auth ACP fallback) overrides the file probe — `auth` flips, not only
        // `council_eligible`, and the evidence rides on the wire.
        seatHealth.authFailureFor(key),
        probed ?? (probe?.probes(key) === true ? 'pending' : undefined),
      );
      // F-W1-005 (wave-1 P6): the chat admission verdict the daemon itself applies when `POST /chats`
      // picks its default seats — the SAME `chatSeatAdmission` call, for both scope modes — so the
      // studio's picker offers exactly the seats an open would seat, from one source of truth (no
      // client-side copy of the rule). Additive on the wire (`RosterSeat` index signature until
      // api-types 0.39.0 types it).
      const standingSeat = seat as unknown as StandingSeat;
      return {
        ...seat,
        health,
        signed_in: signed,
        ...standing,
        chat_admission: {
          unscoped: chatSeatAdmission(standingSeat, standing.auth, false),
          scoped: chatSeatAdmission(standingSeat, standing.auth, true),
        },
      };
    });
  };
  if (probe !== null) {
    accessor.ready = async () => {
      let keys: string[];
      try {
        keys = (registry() as RosterSeat[]).map((s) => String(s.key));
      } catch {
        return; // no roster: the launch reads (and reports) the same failure itself
      }
      await probe.ensureFresh(keys, liveRoot());
    };
  }
  // Warm the probe at boot, so the first launch after a restart already routes on the seat's own
  // answer (a probe runs in the background; the roster read itself never waits on one).
  if (probe !== null) {
    setImmediate(() => {
      try {
        accessor();
      } catch {
        /* no roster yet: the first real read probes */
      }
    }).unref();
  }
  return accessor;
}
