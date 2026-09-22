/**
 * The TOP-LEVEL names of the daemon state home, as crew's `src/` knows them (wicked-core#411 /
 * crew#497).
 *
 * The registry of record is `tests/fixtures/state-home-subtrees.json` — the file wicked-core
 * embeds to build the worker Read fence (design v3.1 §1) and crew mirrors byte for byte. It lives
 * under `tests/` so `src/` cannot read it, yet the daemon needs the same classification at BOOT
 * to say, before anyone launches, that an entry under its state home is one the fence will refuse
 * every worker launch over (`state-home-preflight.ts`). The engine answers that question itself
 * once the addon carries `Core.preflightStateHome`; on an older addon crew classifies with THIS
 * list. Same doctrine as `skills/root-names.ts` for the skills root's children: `src/` carries the
 * names, `tests/state-home-subtrees.test.ts` asserts they equal the fixture, so the two cannot
 * drift without a red test.
 *
 * `names` are exact top-level names; `prefixes` cover a file and its sidecars (`core.db`,
 * `core.db-wal`, `core.db.events`, …). Nothing here is enumerated at runtime to BUILD a rule —
 * that is core's fail-closed contract; crew only REPORTS what core would refuse.
 */

/** Exact top-level names the registry classifies. */
export const STATE_HOME_ENTRY_NAMES: ReadonlyArray<string> = [
  'skills',
  'audit.log',
  'evals',
  'project-graphs',
  'repo-graphs',
  'project-settings.json',
  'interactive-chat-ledger.json',
  'interactive-chats',
  'interactive-demo-ledger.json',
  'interactive-demos',
  'interactive-draft-ledger.json',
  'interactive-drafts',
  'interactive-edit-ledger.json',
  'interactive-edits',
  // DES-L5 (D-13): the chat transcripts at rest — `src/api/chat-transcripts.ts`.
  'chats',
  // Placed by an OPERATOR variable, never by a `join(<state home>, …)` in src/ (the `env` field
  // on the fixture entry): registered so a pre-existing placement is fenced rather than refusing
  // every launch; `assertWickedRootsOutsideStateHome` refuses to BOOT with the variable pointed
  // there (state-home-preflight.ts).
  'workflows',
  'steering-inbox',
  'interactive',
];

/** Top-level PREFIXES the registry classifies (a file and its sidecars). */
export const STATE_HOME_ENTRY_PREFIXES: ReadonlyArray<string> = ['bus.db', 'core.db', 'daemon-'];

/** Is `topLevel` a name the registry classifies? */
export function isRegisteredStateHomeEntry(topLevel: string): boolean {
  return (
    STATE_HOME_ENTRY_NAMES.includes(topLevel) ||
    STATE_HOME_ENTRY_PREFIXES.some((p) => topLevel.startsWith(p))
  );
}
