/**
 * Where a PROJECT's co-located code graph lives, and what each member repo is called inside it.
 *
 * # Why a module instead of a `join()` at each call site
 *
 * This is `repoPaths.ts`'s posture applied one level up (see that module's header for the bill:
 * five spellings of the per-repo graph path against a sixth inside wicked-core, and every graph
 * query answering "nothing found" about a repo full of code). One producer, one consumer. Nothing
 * outside this module spells a project-graph path or mints a repo label.
 *
 * # Why NOT inside a repo checkout
 *
 * The per-repo graph lives at `<repo>/.codegraph/estate.db` — inside the working tree — and we have
 * just spent the effort removing that directory from six checkouts it had polluted. A PROJECT graph
 * is worse on that axis, not better: it holds N repos, so there is no one checkout it belongs to,
 * and writing it into the first member's tree would make repo A's working directory grow with repo
 * B's symbols. It goes in the daemon's own state directory.
 *
 * # Why `~/.wicked-crew/project-graphs/<projectId>/`
 *
 * `~/.wicked-crew/` is already where this package keeps crew-side per-project state that the engine
 * does not own — `project-settings.json` (DES-MERGE-001 §7.1) sits there today. The project graph is
 * exactly that kind of thing: crew-owned, per-project, derived, and rebuildable. A directory per
 * project (rather than `<projectId>.db` files in one flat folder) keeps the db and the refresh
 * manifest that describes it together, so removing a project's graph is one `rm -rf` that cannot
 * leave a manifest describing a database that is gone.
 *
 * # Why the root FOLLOWS `--db` (crew#330)
 *
 * `~/.wicked-crew` is the daemon's DEFAULT state home, not its definition. A daemon started with
 * `--db $SCRATCH/core.db --bus-db $SCRATCH/bus.db` reads as fully isolated — and then built its
 * project graph in the developer's real home, 41.7 MB keyed by project ids that only the scratch
 * store ever knew, with nothing to reap them. One `--db` must move everything durable, so the
 * bootstrap threads the RESOLVED state home (the `--db` parent) into this module via
 * {@link setProjectGraphStateHome}, and the resolver here prefers it over the homedir fallback.
 * With no `--db`, the resolved state home IS `~/.wicked-crew`, so the default daemon's paths are
 * byte-identical to what they were before the fix.
 *
 * Overridable with `WICKED_CREW_PROJECT_GRAPH_ROOT` — the same escape hatch
 * `WICKED_CREW_PROJECT_SETTINGS` gives the settings store, and what lets the tests and the proof
 * scripts run without touching a developer's real home. The env override outranks the configured
 * state home: it is the more specific instruction ("graphs go THERE") and the one CI already uses.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * The estate label charset, copied from the rule that enforces it
 * (`wicked-estate/src/repo_scope.rs::validate_label`): 1–64 chars of `[A-Za-z0-9._-]`, and never
 * `.` or `..`.
 *
 * The constraint is not cosmetic and not ours to relax. estate splices the label into `files.path`
 * AND into every SymbolId derived from it, so a `/` or a `..` in a label would forge paths inside
 * another repo's namespace — the exact collision the whole labelling mechanism exists to prevent.
 * A label that fails this test is refused by estate before a single row is written; we mint labels
 * that pass it instead of discovering that at index time.
 */
export function isValidRepoLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= 64 &&
    label !== '.' &&
    label !== '..' &&
    /^[A-Za-z0-9._-]+$/.test(label)
  );
}

/** Sanitized-label budget: 51 + `-` + 12 hex = exactly estate's 64-character ceiling. */
const HASH_LEN = 12;
const STEM_LEN = 64 - 1 - HASH_LEN;

/**
 * The label one registered repo carries inside a project graph — its REGISTRY ID when that id is
 * already a legal estate label, and a deterministic sanitized form when it is not.
 *
 * WHY the registry id. The label becomes a path prefix on every row the repo writes and shows up in
 * every result this surface returns, so it has to be a name an operator can map back to a repo
 * without a lookup table. It also has to be STABLE: estate binds a label to a repo permanently
 * (re-indexing under a second label is refused as a duplicate; re-using a label for a different repo
 * is refused as a collision), so a label derived from anything mutable — the repo's display name,
 * its root path, its position in the member list — would break the next refresh after a rename or a
 * move. The registry id is the one identifier that is both stable and already unique per repo.
 *
 * Every repo id in the live registry today (`wicked-ledger`, `wicked-vault`, `pageindex-proof`, …)
 * satisfies estate's rule as-is, so the common path is the identity function and the label IS the
 * id. That is not guaranteed for ids minted later, so the fallback is real rather than theoretical:
 * illegal characters collapse to `-`, the stem is capped, and a 12-hex digest of the FULL id is
 * appended — the digest is what keeps `a/b` and `a:b` (which sanitize identically) apart, and what
 * keeps a truncated 200-character id distinct from another that shares its first 51 characters.
 *
 * The mapping is a pure function of the id, which is what makes it safe against estate's permanent
 * binding: the same repo resolves to the same label on every refresh, for the life of the graph.
 */
export function repoLabel(repoId: string): string {
  if (isValidRepoLabel(repoId)) return repoId;
  const digest = createHash('sha256').update(repoId).digest('hex').slice(0, HASH_LEN);
  const stem = repoId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, STEM_LEN);
  return `${stem}-${digest}`;
}

/**
 * Project ids are REJECTED, never sanitized.
 *
 * A sanitizing map is what would let two distinct project ids land in one directory and share one
 * database — the same class of silent collision that made a multi-repo graph impossible in the first
 * place, reintroduced at the project level. It is also the traversal guard: the id is a path
 * segment, so `../../x` must never be spelled into a path. Engine-minted ids (`proj_1787…`) and the
 * synthesized `default` both pass; anything that does not is a bug worth hearing about.
 */
export function assertProjectIdIsPathSafe(projectId: string): void {
  if (!isValidRepoLabel(projectId)) {
    // Name the ACTUAL rule that rejected it (Copilot on #326). `.` and `..` match the stated
    // character set, so a message quoting only the charset tells an operator their id is legal
    // and rejected in the same breath — and sends them looking for an illegal character that
    // is not there.
    const why =
      projectId === '.' || projectId === '..'
        ? `${JSON.stringify(projectId)} is a relative path segment, so it cannot name a directory`
        : `expected 1-64 chars of [A-Za-z0-9._-]`;
    throw new Error(
      `project id ${JSON.stringify(projectId)} cannot address a project graph directory: ${why}`,
    );
  }
}

/**
 * The daemon's RESOLVED state home — set once at bootstrap from the `--db` parent (crew#330),
 * `undefined` for library consumers and unit tests that never boot a daemon (they fall through to
 * the homedir default, exactly the pre-fix behaviour).
 */
let configuredStateHome: string | undefined;

/**
 * The state home the daemon was ACTUALLY given, derived from its resolved core-db path — the seam
 * that makes `--db` move the project graphs along with everything else durable (crew#330).
 *
 * Called from the CLI bootstrap (the one place that knows the resolved `--db`), before any route
 * can resolve a graph path. `undefined` clears it (tests). Idempotent; the last call wins, which
 * is harmless because a process boots one daemon.
 */
export function setProjectGraphStateHome(stateHome: string | undefined): void {
  configuredStateHome = stateHome;
}

/**
 * A core-db path → the state home it implies. Pure and exported so the bootstrap and the
 * regression test spell the derivation once: `dirname` of the ABSOLUTE db path, so a relative
 * `--db ./scratch/core.db` still lands its graphs next to the db it named rather than resolving
 * differently on every later `join`.
 */
export function stateHomeOfDb(dbPath: string): string {
  return dirname(resolve(dbPath));
}

/** The root every project graph directory hangs off. Precedence: explicit env override, then the
 *  daemon's configured state home (the `--db` parent — crew#330), then the `~/.wicked-crew`
 *  default (which is also what the configured state home resolves to when `--db` was not given). */
export function projectGraphRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['WICKED_CREW_PROJECT_GRAPH_ROOT'];
  if (override !== undefined) return override;
  if (configuredStateHome !== undefined) return join(configuredStateHome, 'project-graphs');
  return join(homedir(), '.wicked-crew', 'project-graphs');
}

/** One project's graph directory — holds the database and the manifest that describes it. */
export function projectGraphDir(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  assertProjectIdIsPathSafe(projectId);
  return join(projectGraphRoot(env), projectId);
}

/** The ONE database holding every member repo of this project, co-located under their labels. */
export function projectGraphDb(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(projectGraphDir(projectId, env), 'code-graph.db');
}

/**
 * What the last refresh put in that database, per repo — the record incremental refresh reads.
 *
 * Deliberately a SIDECAR rather than a read of estate's own `repo:<label>:commit` meta: estate
 * exposes that only through `stats`, whose output is human text with no `--json`, and deciding
 * whether to re-index a repo by regex-matching a report is the kind of coupling that breaks on a
 * formatting change with no test to catch it.
 */
export function projectGraphManifest(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(projectGraphDir(projectId, env), 'manifest.json');
}
