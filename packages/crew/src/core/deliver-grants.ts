/**
 * (crew#1885) WHO MAY READ A RUN'S DELIVERY TEXT WITHOUT AN OPERATOR BEARER: that run's own deliver script.
 *
 * The deliver script asks the daemon for the PR text composed from the run record. It holds no operator bearer, so
 * under `auth: required` the bearer route (`GET /runs/:id/deliver-text`) answered 401 and the script fell back to the
 * launch-time text, which carries none of the run's assurance lines (stand-ins, reduced assurance, the QE decision,
 * floor overrides). The script's credential is the nonce it already carries (`DELIVER_NONCE`, minted per composition,
 * {@link mintDeliverNonce}). `POST /deliver/text {run, nonce}` answers:
 *
 *  - for the engine-run deliver phase: the nonce that run's DELIVER unit declares, read only from the script crew
 *    composes (`bash -lc` of a script opening `set -euo pipefail` with a `DELIVER_NONCE='<hex>'` line), and only while
 *    that script can be running: the unit dispatched (`distributed`), or refused (`rejected`) while its run has not
 *    ended, since approving the deliver-refusal gate re-runs the same script with the unit still marked `rejected`
 *    (seen in `tests/integration/deliver-revision-e2e.test.ts`). A nonce named in any other command, a declared
 *    deliverable path for instance, never counts; nor does a deliver unit not yet dispatched (`pending`), one that is
 *    done (its script printed the nonce in its exit sentinel, crew#739), or any unit of a run that has ended;
 *  - for a post-hoc delivery: the text the daemon composed for it, registered here with its nonce while its script
 *    runs, so the PR says what that delivery was approved on (its own QE check).
 *
 * Nothing here logs a nonce, and no answer carries one.
 */

import { timingSafeEqual } from 'node:crypto';

import { DELIVER_NONCE_VAR, DELIVER_PHASE_ID } from './deliver.js';

/** The post-hoc deliveries running now, per run: each nonce with its composed text and a hold count. */
const postHoc = new Map<string, Map<string, { text: string; holds: number }>>();

/** Equal nonces, compared in constant time (hex digits, either case). */
function sameNonce(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase(), 'utf8');
  const y = Buffer.from(b.toLowerCase(), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Register a post-hoc delivery's nonce for `runId` while its script runs (`api/post-hoc-deliver.ts`: the daemon runs
 * that script itself, so no unit carries it), with the framed text composed for that delivery. Returns the release;
 * call it once the script has exited.
 */
export function grantPostHocDeliverText(runId: string, nonce: string, text: string): () => void {
  const key = nonce.toLowerCase();
  const held = postHoc.get(runId) ?? new Map<string, { text: string; holds: number }>();
  const prior = held.get(key);
  held.set(key, { text, holds: (prior?.holds ?? 0) + 1 });
  postHoc.set(runId, held);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = postHoc.get(runId);
    const entry = now?.get(key);
    if (now === undefined || entry === undefined) return;
    if (entry.holds > 1) now.set(key, { ...entry, holds: entry.holds - 1 });
    else now.delete(key);
    if (now.size === 0) postHoc.delete(runId);
  };
}

/** The text a post-hoc delivery of `runId` running now registered under `nonce`, or null. */
export function postHocDeliverText(runId: string, nonce: string): string | null {
  for (const [held, entry] of postHoc.get(runId) ?? []) if (sameNonce(held, nonce)) return entry.text;
  return null;
}

/** What {@link deliverTextAllowed} reads of a unit. */
export interface DeliverTextUnit {
  id?: string | null | undefined;
  catalog?: string | null | undefined;
  status?: string | null | undefined;
  tool_cmd?: readonly string[] | null | undefined;
}

/** The nonce line crew's deliver script carries (`deliverPrScript`), on a line of its own. */
const SCRIPT_NONCE_LINE = new RegExp(`^${DELIVER_NONCE_VAR}='([0-9a-fA-F]{16,64})'$`, 'm');

/**
 * The nonce of a deliver unit's script that can be running now, or null: the run's deliver unit (by id or catalog
 * entry, as `deliverUnitOf` finds it), running crew's script exactly as composed (`['bash', '-lc', <script>]`), either
 * dispatched or (the gate retry) refused while its run has not ended.
 */
function liveDeliverNonce(u: DeliverTextUnit, runEnded: boolean): string | null {
  if (runEnded) return null;
  if (u.status !== 'distributed' && u.status !== 'rejected') return null;
  if (!((u.id ?? '').endsWith(`:${DELIVER_PHASE_ID}`) || u.catalog === DELIVER_PHASE_ID)) return null;
  const cmd = u.tool_cmd;
  if (cmd == null || cmd.length !== 3 || cmd[0] !== 'bash' || cmd[1] !== '-lc') return null;
  const script = cmd[2]!;
  if (!script.startsWith('set -euo pipefail\n')) return null;
  return SCRIPT_NONCE_LINE.exec(script)?.[1] ?? null;
}

/**
 * Whether `nonce` is the one a deliver unit among `units` (one run's) declares in its script, while that script can be
 * running. `runEnded`: the run is completed, failed or cancelled (then nothing counts).
 */
export function deliverTextAllowed(units: ReadonlyArray<DeliverTextUnit>, nonce: string, runEnded: boolean): boolean {
  for (const u of units) {
    const declared = liveDeliverNonce(u, runEnded);
    if (declared !== null && sameNonce(declared, nonce)) return true;
  }
  return false;
}
