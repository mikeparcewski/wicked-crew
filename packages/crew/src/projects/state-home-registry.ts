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
  // crew#720: each run's final-codebase zip — `src/api/codebase-archive.ts`.
  'artifacts',
  'project-graphs',
  'repo-graphs',
  // Container seats' agentgateway state (WICKED_SEAT_FLOOR=container) — wicked-core `src/seat_gateway.rs`.
  'gateway',
  'project-settings.json',
  // DES-learn-workflow §5: the learn schedules — `src/learn/schedule-store.ts`.
  'learn-schedules.json',
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
  // DES-decision-capture §4.2.1 (DC-S4a): the decision ledger, the operator's words — `src/decisions/ledger.ts`.
  'decisions',
  // DES-MCP-TOOLS-001 S2: the MCP tools registry — `src/mcp/registry-store.ts`.
  'mcp',
  // Placed by an OPERATOR variable, never by a `join(<state home>, …)` in src/ (the `env` field
  // on the fixture entry): registered so a pre-existing placement is fenced rather than refusing
  // every launch; `assertWickedRootsOutsideStateHome` refuses to BOOT with the variable pointed
  // there (state-home-preflight.ts).
  'workflows',
  'steering-inbox',
  'interactive',
];

/** Top-level PREFIXES the registry classifies (a file and its sidecars). */
export const STATE_HOME_ENTRY_PREFIXES: ReadonlyArray<string> = [
  'bus.db',
  'core.db',
  'daemon-',
  // DES-TEAMING-002 §4.1: the engine's team outbox (and its transient `.compact` sidecar).
  'team-outbox.ndjson',
];

/**
 * OS file-manager metadata (Finder, Explorer): never a crew entry and never a configuration error,
 * at the state home AND the skills root. The same list as wicked-core's `OS_METADATA_PATTERNS`
 * (src/state_home.rs, wicked-core#1117; a trailing `*` there is a prefix here):
 * tests/state-home-subtrees.test.ts reads core's source and holds the two equal.
 */
export const OS_METADATA_NAMES: ReadonlyArray<string> = [
  '.DS_Store',
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
  'Thumbs.db',
  'desktop.ini',
  'Icon\r',
];

/** OS metadata PREFIXES (AppleDouble `._<name>` companions). */
export const OS_METADATA_PREFIXES: ReadonlyArray<string> = ['._'];

/** Is `name` OS file-manager metadata (exact name or prefix — `.DS_Store.bak` is NOT)? */
export function isOsMetadataEntry(name: string): boolean {
  return OS_METADATA_NAMES.includes(name) || OS_METADATA_PREFIXES.some((p) => name.startsWith(p));
}

/** Is `topLevel` a name the registry classifies (or OS metadata, which never refuses)? */
export function isRegisteredStateHomeEntry(topLevel: string): boolean {
  return (
    isOsMetadataEntry(topLevel) ||
    STATE_HOME_ENTRY_NAMES.includes(topLevel) ||
    STATE_HOME_ENTRY_PREFIXES.some((p) => topLevel.startsWith(p))
  );
}
