/**
 * (crew#1885) WHO MAY READ A RUN'S DELIVERY TEXT WITHOUT AN OPERATOR BEARER: that run's own deliver script.
 *
 * The deliver script asks the daemon for the PR text composed from the run record. It holds no operator bearer, so
 * under `auth: required` the bearer route (`GET /runs/:id/deliver-text`) answered 401 and the script fell back to the
 * launch-time text, which carries none of the run's assurance lines (stand-ins, reduced assurance, the QE decision,
 * floor overrides). The script's credential is its READ KEY (`core/deliver-key.ts`): a value in a 0600 file under the
 * crew state home, minted per composition. The script text names only the file, so the key is on no command line
 * (codex-check on crew#1946: the script text is `bash -lc`'s argv, readable with `ps`). `POST /deliver/text {run, key}`
 * answers:
 *
 *  - for the engine-run deliver phase: the key in the file that run's DELIVER unit's script names, read only from the
 *    script crew composes (`bash -lc` of a script opening `set -euo pipefail` with a `DELIVER_KEY_FILE='<path>'` line
 *    naming a file of crew's key dir), and only while that script can be running: the unit dispatched
 *    (`distributed`), or refused (`rejected`) while its run has not ended, since approving the deliver-refusal gate
 *    re-runs the same script with the unit still marked `rejected` (seen in
 *    `tests/integration/deliver-revision-e2e.test.ts`). A path named in any other command never counts; nor does a
 *    deliver unit not yet dispatched (`pending`), one that is done, or any unit of a run that has ended. The key is
 *    always the file's, never a value read off a command line;
 *  - for a post-hoc delivery: the text the daemon composed for it, registered here with its key file while its script
 *    runs, so the PR says what that delivery was approved on (its own QE check).
 *
 * Nothing here logs a key, and no answer carries one.
 */

import { DELIVER_PHASE_ID } from './deliver.js';
import { DELIVER_KEY_FILE_VAR, deliverKeyMatches } from './deliver-key.js';

/** The post-hoc deliveries running now, per run: each key file with its composed text and a hold count. */
const postHoc = new Map<string, Map<string, { text: string; holds: number }>>();

/**
 * Register a post-hoc delivery's key file for `runId` while its script runs (`api/post-hoc-deliver.ts`: the daemon runs
 * that script itself, so no unit carries it), with the framed text composed for that delivery. Returns the release;
 * call it once the script has exited.
 */
export function grantPostHocDeliverText(runId: string, keyFile: string, text: string): () => void {
  const held = postHoc.get(runId) ?? new Map<string, { text: string; holds: number }>();
  const prior = held.get(keyFile);
  held.set(keyFile, { text, holds: (prior?.holds ?? 0) + 1 });
  postHoc.set(runId, held);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = postHoc.get(runId);
    const entry = now?.get(keyFile);
    if (now === undefined || entry === undefined) return;
    if (entry.holds > 1) now.set(keyFile, { ...entry, holds: entry.holds - 1 });
    else now.delete(keyFile);
    if (now.size === 0) postHoc.delete(runId);
  };
}

/** The text a post-hoc delivery of `runId` running now registered, when `key` is the one in its key file; or null. */
export function postHocDeliverText(runId: string, key: string): string | null {
  for (const [keyFile, entry] of postHoc.get(runId) ?? []) if (deliverKeyMatches(keyFile, key)) return entry.text;
  return null;
}

/** What {@link deliverTextAllowed} reads of a unit. */
export interface DeliverTextUnit {
  id?: string | null | undefined;
  catalog?: string | null | undefined;
  status?: string | null | undefined;
  tool_cmd?: readonly string[] | null | undefined;
}

/** The key file line crew's deliver script carries (`deliverPrScript`), on a line of its own. */
const SCRIPT_KEY_FILE_LINE = new RegExp(`^${DELIVER_KEY_FILE_VAR}='([^'\\n]+)'$`, 'm');

/**
 * The key file of a deliver unit's script that can be running now, or null: the run's deliver unit (by id or catalog
 * entry, as `deliverUnitOf` finds it), running crew's script exactly as composed (`['bash', '-lc', <script>]`), either
 * dispatched or (the gate retry) refused while its run has not ended. Only a path: the key is read from the file.
 */
function liveDeliverKeyFile(u: DeliverTextUnit, runEnded: boolean): string | null {
  if (runEnded) return null;
  if (u.status !== 'distributed' && u.status !== 'rejected') return null;
  if (!((u.id ?? '').endsWith(`:${DELIVER_PHASE_ID}`) || u.catalog === DELIVER_PHASE_ID)) return null;
  const cmd = u.tool_cmd;
  if (cmd == null || cmd.length !== 3 || cmd[0] !== 'bash' || cmd[1] !== '-lc') return null;
  const script = cmd[2]!;
  if (!script.startsWith('set -euo pipefail\n')) return null;
  return SCRIPT_KEY_FILE_LINE.exec(script)?.[1] ?? null;
}

/**
 * Whether `key` is the one in the key file a deliver unit among `units` (one run's) names in its script, while that
 * script can be running. `runEnded`: the run is completed, failed or cancelled (then nothing counts).
 */
export function deliverTextAllowed(units: ReadonlyArray<DeliverTextUnit>, key: string, runEnded: boolean): boolean {
  for (const u of units) {
    const keyFile = liveDeliverKeyFile(u, runEnded);
    if (keyFile !== null && deliverKeyMatches(keyFile, key)) return true;
  }
  return false;
}
