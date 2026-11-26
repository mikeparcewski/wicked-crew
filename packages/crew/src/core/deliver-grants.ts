/**
 * (crew#1885) WHO MAY READ A RUN'S DELIVERY TEXT WITHOUT AN OPERATOR BEARER: that run's own deliver script.
 *
 * The deliver script asks the daemon for the PR text composed from the run record. It holds no operator bearer, so
 * under `auth: required` the bearer route (`GET /runs/:id/deliver-text`) answered 401 and the script fell back to the
 * launch-time text, which carries none of the run's assurance lines (stand-ins, reduced assurance, the QE decision,
 * floor overrides). The script's credential is the nonce it already carries (`DELIVER_NONCE`, minted per composition,
 * {@link mintDeliverNonce}): it is in the deliver unit's own `tool_cmd`, so only the script the engine runs for that
 * run, or the daemon itself, knows it. `POST /deliver/text {run, nonce}` answers when the nonce is the one an
 * in-flight unit of that run declares, or one a post-hoc delivery the daemon is running right now registered here.
 * Nothing here logs a nonce, and no answer carries one.
 */

import { timingSafeEqual } from 'node:crypto';

import { deliverNonceOf } from './deliver-triage.js';

/** The nonces of the post-hoc deliveries running now, per run (a count, so two overlapping spawns of one nonce hold). */
const postHoc = new Map<string, Map<string, number>>();

/** Equal nonces, compared in constant time (hex digits, either case). */
function sameNonce(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase(), 'utf8');
  const y = Buffer.from(b.toLowerCase(), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Register a post-hoc delivery's nonce for `runId` while its script runs (`api/post-hoc-deliver.ts`: the daemon runs
 * that script itself, so no unit carries it). Returns the release; call it once the script has exited.
 */
export function grantPostHocDeliverText(runId: string, nonce: string): () => void {
  const key = nonce.toLowerCase();
  const held = postHoc.get(runId) ?? new Map<string, number>();
  held.set(key, (held.get(key) ?? 0) + 1);
  postHoc.set(runId, held);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = postHoc.get(runId);
    const n = (now?.get(key) ?? 0) - 1;
    if (now === undefined) return;
    if (n > 0) now.set(key, n);
    else now.delete(key);
    if (now.size === 0) postHoc.delete(runId);
  };
}

/** What {@link deliverTextAllowed} reads of a unit: its command and whether it is still in flight. */
export interface DeliverTextUnit {
  status?: string | null | undefined;
  tool_cmd?: readonly string[] | null | undefined;
}

/**
 * Whether `nonce` is the credential of a deliver script for `runId`: the nonce one of the run's units declares in its
 * `tool_cmd` while that unit is in flight (pending or distributed: the engine-run deliver phase, a gate retry
 * included), or a post-hoc delivery's that is running now. The script prints its nonce in the trusted sentinel when
 * it exits (crew#739, the engine reads it there), so a nonce stops being a credential once its unit is done.
 */
export function deliverTextAllowed(runId: string, units: ReadonlyArray<DeliverTextUnit>, nonce: string): boolean {
  for (const u of units) {
    if (u.status !== 'pending' && u.status !== 'distributed') continue;
    const declared = deliverNonceOf(u.tool_cmd);
    if (declared !== null && sameNonce(declared, nonce)) return true;
  }
  for (const held of postHoc.get(runId)?.keys() ?? []) if (sameNonce(held, nonce)) return true;
  return false;
}
