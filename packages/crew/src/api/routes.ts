import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { listRequirements, getRequirement, patchRequirement } from './requirements.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampaignsUnsupportedError, ChatUnsupportedError, CoreAdapter, ElicitationUnsupportedError, SteeringUnsupportedError, humanGatePhaseIds } from '../core/adapter.js';
import { codeGraphDb, requirementsGraph } from '../core/repoPaths.js';
import { detectRefusal, type GateCache } from './gate-cache.js';
import type { ElicitationCache } from './elicitation-cache.js';
import { QeGateCache } from '../qe/gate-events.js';
import { buildAcceptanceView, resolveRunWorkflow } from '../qe/acceptance.js';
import { buildEvidenceBundle, coreUnitId, evidenceFilename } from './evidence.js';
import { outputUnavailableReason, resolveUnit, unitKeysFor } from './unit-output.js';
import type { LaunchRunInput, RosterSeat, SessionStatus, SessionView } from '../core/types.js';
import { execCapped, ExecOutputTooLarge } from '../core/exec.js';
import { SeatHealthTracker } from './seat-health.js';
import { applyWorkerConfigRoot, signedInHeuristic } from './seat-signin.js';
import { allowedRootsFor, isInsideRoot, openWithSystemDefault } from './open-path.js';
import {
  InvalidDiffBaseError,
  NotARegularFileError,
  UnresolvableDiffBaseError,
  readFileCapped,
  worktreeDiff,
} from './run-files.js';
import { resolveProjectGraphBinding } from '../projects/graph.js';
import { registerProjectRoutes, type ProjectRoutesDeps } from '../projects/routes.js';
import { registerCampaignRoutes } from '../campaigns/routes.js';
import { registerGovernanceWikiRoutes } from './governance-wiki.js';
import {
  DEFAULT_STEERING_TYPE,
  STEERING_TYPE_VALUES,
  STEERING_TYPES,
  registerGovernanceSteeringRoutes,
} from './governance-steering.js';
import { isSteeringAuthorRun, landSteeringProposal } from './steering-landing.js';
import { registerTestingRoutes } from './testing.js';
import { ProjectSettingsStore } from '../projects/settings.js';
import { boundOrigin, InteractiveBridgePool } from '../interactive/bridge-pool.js';
import { registerInteractiveProxy } from '../interactive/proxy-routes.js';
import { registerInteractiveDocDelete } from '../interactive/doc-delete-routes.js';
import type { DocLedgerSweep } from '../interactive/doc-ledger-sweep.js';
import { MembershipIndex } from '../projects/membership-index.js';
import { MEMBERSHIP_ATTACHED, membershipAttachedKey } from '../projects/events.js';
import { AuditLog } from './audit.js';
import {
  AcpFoldCache,
  EngineVersionCache,
  eventsDirOf,
  installedPackageVersion,
  listStoreFiles,
  readStudioBundleVersion,
  type ErrorRing,
} from './diagnostics.js';
import { RetryIndex } from './retry-index.js';
import { GroupIndex } from './group-index.js';
import { GuidanceIndex } from './guidance-index.js';
import {
  DeliveryIndex,
  gitRunBranchIsEmpty,
  gitWorktreeIsClean,
  isDeliverConflictStranded,
  prUrlFrom,
  type DeliveryState,
  type VacuityProbes,
} from './delivery-index.js';
import { DeliveryDerivationCache } from './delivery-cache.js';
import {
  gitReprovisionWorktree,
  runDeliverScript,
  type DeliverExec,
  type DeliverScriptResult,
  type WorktreeReprovisioner,
} from './post-hoc-deliver.js';
import { LOCAL_ACTOR, type AuthMode } from './auth.js';
// Re-exported so existing `import { API_PREFIX } from './routes.js'` callers keep working; the
// value lives in the leaf module api-prefix.ts to keep unit-output.ts out of this file's cycle.
export { API_PREFIX } from './api-prefix.js';
import { API_PREFIX } from './api-prefix.js';

const V = API_PREFIX;

// Daemon version reported by /health — read from package.json so it never drifts
// from the shipped version across releases. Resolves the package root from the
// compiled module location (dist/api/routes.js → ../../package.json) and works the
// same under the src layout (src/api/routes.ts → ../../package.json).
const PKG_VERSION = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  ) as { version: string }
).version;

// Actionable-first ordering for the run list (DES-STUDIO-001 §11.6): a run
// awaiting a human sorts to the top; terminal runs sink.
const STATUS_ORDER: Record<SessionStatus, number> = {
  awaiting_human: 0,
  executing: 1,
  distributing: 2,
  planning: 3,
  failed: 4,
  completed: 5,
  cancelled: 6,
};

function sortActionableFirst(views: SessionView[]): SessionView[] {
  return [...views].sort(
    (a, b) => (STATUS_ORDER[a.session.status] ?? 9) - (STATUS_ORDER[b.session.status] ?? 9),
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turns a failed parse into a 400 body, naming any field the schema does not know.
 *
 * Every schema here is `.strict()`, because zod's default is to STRIP unknown keys — which made a
 * misspelled optional field a silent behaviour change (FINDING-031). `POST /runs {"clis":[...],
 * "workflowId":"feature"}` — core's field names, not the HTTP layer's — answered `201` and ran the
 * full roster with no workflow. Rejecting is only half the fix: a bare "Invalid request body" leaves
 * the caller comparing their JSON against the source, so the unknown keys are named in `error`
 * itself, where a human and a `curl | jq .error` both see it without reading `details`.
 */
function invalidBody(err: z.ZodError, what: string): { error: string; details: z.ZodIssue[] } {
  const unknown = err.issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []));
  const error =
    unknown.length > 0
      ? `${what}: unknown field${unknown.length > 1 ? 's' : ''} ${unknown
          .map((k) => `\`${k}\``)
          .join(', ')} — this endpoint does not accept ${
          unknown.length > 1 ? 'them' : 'it'
        }, and ignoring ${unknown.length > 1 ? 'them' : 'it'} would run a different request than you sent`
      : what;
  return { error, details: err.issues };
}

// Closed facet vocabularies for the `GET /governance/rules` browse filters (wiki-mgmt) — the
// wire contract's `RuleBrowseQuery`. Sets, not zod: the query is otherwise free-form and only
// these three facets have a vocabulary to enforce.
const RULE_SEVERITIES: ReadonlySet<string> = new Set(['info', 'warn', 'error', 'critical']);
const RULE_TYPES: ReadonlySet<string> = new Set(['pattern', 'policy']);
const RULE_STATUSES: ReadonlySet<string> = new Set(['active', 'retired', 'all']);

// Repo names become directory components under ~/.wicked/repos/ — reject anything
// that would allow path traversal (slashes, dots-only segments, control chars).
const SAFE_REPO_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const RegisterRepoSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_REPO_NAME, 'Repository name must start with a letter/digit and contain only letters, digits, dots, hyphens, and underscores'),
    // For local registration: path to an existing git repo on disk.
    // For remote clone: optional clone destination (absolute path); if omitted,
    // defaults to ~/.wicked/repos/<name>.
    rootPath: z.string().optional(),
    gitUrl: z.string().optional(),
  })
  .strict()
  .refine(
    (d) => {
      const hasRemote = typeof d.gitUrl === 'string' && d.gitUrl.length > 0;
      const hasLocal = typeof d.rootPath === 'string' && d.rootPath.length > 0;
      // gitUrl alone (clone to default path), gitUrl + rootPath (clone to custom path),
      // or rootPath alone (register existing local repo) — all valid.
      return hasRemote || hasLocal;
    },
    { message: 'Provide gitUrl (remote clone) or rootPath (local registration), or both.' },
  );

/**
 * The launch body. Every field but `problem` is optional, which is what made stripping dangerous:
 * omitting one is a legitimate request that gets an engine default, so a MISSPELLED one was
 * indistinguishable from an omitted one and the run went ahead on a configuration the caller never
 * asked for (FINDING-031).
 *
 * The names differ from core's on purpose and this is the trap worth knowing about: core's
 * `LaunchSpec` takes `clis` (an array) and `workflow`, this takes `clisJson` (a JSON *string*) and
 * `workflow`, and the `/ws` `sessionStarted` frame reports the chosen workflow as `workflowId`. A
 * caller who reads the event stream to learn the field names arrives at `workflowId`, which this
 * schema does not accept — so `.strict()` is what turns that trip into a 400 instead of an
 * unworkflowed run reported as `201`.
 */
// The request-body schemas below are exported so `tests/wire-contract.test.ts` can prove, at
// compile time, that every body the published contract (`wicked-crew-api-types`) lets a client
// send is a body these schemas accept — the request-direction half of the drift guard (task #84).
export const LaunchSchema = z.object({
  problem: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  clisJson: z.string().min(1).optional(),
  entityMode: z.enum(['shared', 'isolated']).optional(),
  humanConfirm: z.string().min(1).optional(),
  repoRef: z.string().min(1).optional(),
  workflow: z.string().min(1).optional(),
  /** DES-PROJECT-001 §2.2 — file the run into a project; membership attaches atomically with
   *  the launch record. Unknown/archived ⇒ the launch fails (never a silent unfiled run). */
  projectId: z.string().min(1).optional(),
  /** crew#293 — `"pr"` appends the hardened deliver Tool phase (push run branch + `gh pr create`)
   *  to a PER-RUN copy of the selected workflow; requires `workflow` (enforced by the refine
   *  below, so the 400 happens at parse time, not after the adapter is consulted). crew#393 —
   *  `"none"` explicitly declines delivery (legal with or without a workflow); OMITTED means the
   *  daemon decides: repo-scoped + a CODE-WORK workflow (a def with an `executes_code` phase)
   *  defaults to `"pr"` (flippable via the `deliverDefault` setting), everything else to
   *  `"none"` — see the resolution below. */
  deliver: z.enum(['pr', 'none']).optional(),
  /** DES-UX-001 §8.3 (CREW-UX-3) — the run this launch retries. Must name an EXISTING run id
   *  (the route checks the store and 400s with a named error otherwise); persisted via the
   *  `run.launched` audit entry + retry index and echoed as `AgentSession.retry_of`. */
  retryOf: z.string().min(1).optional(),
  /** wicked-studio#27 (api-types 0.19.0) — attach this AD-HOC run to an EXISTING campaign's
   *  surface. Validated against the campaign store before anything launches (unknown ⇒ 404,
   *  engine without campaign bindings ⇒ 501 — never a silently dropped attach); persisted via
   *  the `run.launched` audit entry + group index, echoed as `AgentSession.campaign_id`, and
   *  served under `Campaign.attached_runs`. Provenance only: the run is NOT a DAG node. */
  campaignId: z.string().min(1).optional(),
  /** wicked-studio#27 (api-types 0.19.0) — ad-hoc label group, created on first use: runs
   *  sharing a label form one `RunGroup` on `GET /campaigns`. Persisted/echoed like
   *  `campaignId` (as `AgentSession.group_label`). */
  groupLabel: z.string().min(1).max(200).optional(),
}).strict().refine((b) => b.deliver !== 'pr' || b.workflow !== undefined, {
  message: 'deliver: "pr" requires a workflow — a free-text run has no def to append the deliver phase to',
  path: ['deliver'],
}).refine((b) => b.campaignId === undefined || b.groupLabel === undefined, {
  message:
    'campaignId and groupLabel are mutually exclusive — a run files onto ONE grouping surface (an existing campaign, or a label group)',
  path: ['groupLabel'],
});

export const GateSchema = z.object({
  approve: z.boolean(),
  amend: z.string().optional(),
}).strict();

/** `PUT /runs/:id/guidance` (DES-UX-002 §7.2, CREW-UX-7) — the durable pre-gate note body.
 *  The empty string is a legal body: it CLEARS the note. The byte cap is checked in the route
 *  (not zod's char-counting `max`) so the 400 names the actual limit. */
export const GuidanceSchema = z.object({
  text: z.string(),
}).strict();
/** ~8KB — a guidance note is operator prose, not a document store. */
const GUIDANCE_MAX_BYTES = 8192;

const InjectSchema = z.object({
  message: z.string().min(1),
  /** `"all"` broadcasts to every active worker; any other value is a CLI key. */
  target: z.string().min(1).default('all'),
}).strict();

export const OpenTerminalSchema = z.object({
  cwd: z.string().min(1),
  cmd: z.array(z.string().min(1)).min(1).optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  // Optional so omission is the SAFE governed default (§7 — `false` is never a
  // default; the ungoverned operator shell must opt in explicitly).
  governed: z.boolean().optional(),
}).strict();

const ResizeTerminalSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
}).strict();

/** `POST /open` (crew#273) — the studio Files tab's "open with the OS default app" body. */
export const OpenPathSchema = z.object({
  path: z.string().min(1),
  runId: z.string().min(1).optional(),
}).strict();

/**
 * A SKIN-OWNED settings key (crew#323): one lowercase segment under the `studio.` namespace,
 * e.g. `studio.appearance`, `studio.notifications`. The daemon never interprets these values —
 * the settings store is shared with the skin, and the namespace is what makes that legible.
 */
const STUDIO_SETTINGS_KEY = /^studio\.[a-z][a-z0-9-]*$/;

/**
 * Per-key ceiling on a `studio.*` value, as the UTF-8 byte length of its JSON form.
 *
 * 512KB, not "a few KB": `studio.appearance` carries the operator's logo as a data URI, and
 * base64 costs ~33%, so this admits a ~380KB image — a real logo, not a favicon — while a
 * preferences blob like `studio.notifications` spends a few dozen bytes of it. One generous
 * cap covers both because the daemon cannot tell them apart; what it stops is settings.json
 * quietly becoming an asset store. It sits at half of Fastify's 1MiB default body limit, so a
 * realistic multi-key patch (one blob near the cap plus small preference blobs) is still parsed
 * before it is judged — but note the two limits COMPOSE: a body whose keys total more than 1MiB
 * is refused by Fastify with a 413 that this route never sees, so the per-key 400 below is the
 * ceiling on ONE key, not on the patch.
 */
const STUDIO_SETTINGS_MAX_BYTES = 512 * 1024;

/** The actor/audit deps (task #88) — threaded from `createServer`. */
export interface SecurityDeps {
  audit: AuditLog;
  authMode: AuthMode;
}

/**
 * Daemon-runtime deps the routes read but `createServer` owns: the seat-health fold (crew#274,
 * fed by the daemon's single CoreEvent subscription) and the OS opener for `/open` (crew#273,
 * injectable so tests never actually open anything).
 */
export interface RuntimeDeps {
  seatHealth?: SeatHealthTracker;
  /** Run→retry-lineage index (CREW-UX-3) — `createServer` hydrates one from the audit trail so
   *  a restarted daemon still echoes `retry_of`; a directly-driven route set gets a fresh one. */
  retryIndex?: RetryIndex;
  /** Run→ad-hoc-group index (wicked-studio#27) — `createServer` hydrates one from the audit
   *  trail (the SAME `run.launched` scan as `retryIndex`) so attaches survive a restart; a
   *  directly-driven route set gets a fresh one. */
  groupIndex?: GroupIndex;
  /** Run→operator-guidance index (CREW-UX-7) — `createServer` hydrates one from the audit trail
   *  so a restarted daemon still echoes `guidance`; a directly-driven route set gets a fresh one. */
  guidanceIndex?: GuidanceIndex;
  /** Run→delivered-PR index (CREW-UX-8, crew#321) — `createServer` hydrates one from the audit
   *  trail so a restarted daemon still echoes `delivery`; a directly-driven route set gets a
   *  fresh one. */
  deliveryIndex?: DeliveryIndex;
  /** The worktree-presence probe behind the `'stranded'` derivation (crew#393) — one stat per
   *  served repo-scoped completed run. Injectable so route tests pin the derivation without
   *  staging directories; defaults to `fs.existsSync`. */
  worktreeExists?: (path: string) => boolean;
  /** The worktree-cleanliness probe behind the `'vacuous'` split of `'stranded'` (crew#311) —
   *  runs only on runs that would otherwise read stranded. Injectable so route tests pin the
   *  derivation without staging real repos; defaults to the TTL-memoized `gitWorktreeIsClean`. */
  worktreeIsClean?: (path: string) => Promise<boolean>;
  /** The run-branch-emptiness probe behind the reaped-worktree half of `'vacuous'` (crew#311) —
   *  runs only on completed repo-scoped runs that would otherwise read `'none'`. Injectable for
   *  the same reason; defaults to the TTL-memoized `gitRunBranchIsEmpty` over the adapter's
   *  repo registry. */
  runBranchIsEmpty?: (repoRef: string, runId: string) => Promise<boolean>;
  /** The background delivery-derivation cache (GET /runs p99): the run DTOs READ this instead
   *  of running the two git probes above at assembly — `createServer` builds one over the
   *  production probes, arms its sweep, and warms it at each run's terminal frame. A
   *  directly-driven route set gets a COLD, unstarted one over the same injectable probes:
   *  reads then answer the stat-only tri-state until a test sweeps or warms it explicitly. */
  deliveryCache?: DeliveryDerivationCache;
  /** The post-hoc deliver exec (crew#393, `POST /runs/:id/deliver`) — spawns the hardened
   *  deliver script in a run's worktree. Injectable so route tests aim the spawn's HOME/PATH at
   *  a fixture (stub `gh`, local bare origin); defaults to the real `bash -lc` spawn. */
  deliverExec?: DeliverExec;
  /** Stand a lift-conflict-stranded run's worktree back up from its `wicked/<id>` branch when the
   *  engine has reaped it (crew#418) — the post-hoc deliver path uses it before the exec above.
   *  Injectable so route tests never shell out to git; defaults to {@link gitReprovisionWorktree}. */
  reprovisionWorktree?: WorktreeReprovisioner;
  openWithOs?: (target: string) => Promise<void>;
  /** Seat sign-in presence probe (seat sign-in) — injectable so route tests never read the
   *  developer's real dotfiles. Defaults to the file/env heuristic in seat-signin.ts. */
  signedIn?: (seatKey: string, workerConfigRoot?: string) => boolean | null;
  /** The wicked-interactive bridge pool behind `/projects/:id/interactive/*` (DES-MERGE-001
   *  slice 1). Injectable so the integration suite proxies to a FAKE bridge instead of
   *  spawning a real `npx wicked-interactive serve`. */
  interactiveBridges?: InteractiveBridgePool;
  /** The governed doc-delete's handoff-ledger sweep (crew#338) — `createServer` wires the real
   *  four-ledger sweep (live seam instances first, ledger files as fallback); a directly-driven
   *  route set gets an INERT one so unit tests never touch ~/.wicked-crew. */
  dropDocLedgerRows?: (documentId: string) => DocLedgerSweep;
  /** The daemon's in-process error-level log ring (diagnostics) — `createServer` tees the pino
   *  stream into one; a directly-driven route set (tests) gets an honestly-empty tail. */
  errorRing?: ErrorRing;
  /** The studio asset root `createServer` resolved (bundled or overridden) — diagnostics reads
   *  the bundle's shipped version manifest from it. Absent = headless = `studioBundle: null`. */
  studioRoot?: string;
}

/**
 * The daemon REST surface. Every endpoint is a thin wrapper over one adapter /
 * core-ts call (DES-STUDIO-001 §2). `session`/`phase` nouns are now `run`/`unit`.
 */
export function registerRoutes(
  app: FastifyInstance,
  adapter: CoreAdapter,
  gateCache: GateCache,
  elicitationCache: ElicitationCache,
  // Defaulted so a caller that never arms the bus seam (tests drive this
  // function directly) gets the same behavior as an unarmed daemon: an empty
  // cache, `busEvent: null`, and the lazy ledger read doing all the work.
  qeGateEvents: QeGateCache = new QeGateCache(),
  // Defaulted for the same reason: tests that drive this function directly get
  // the projects surface with no bus (events skipped) and a fresh index.
  projects: ProjectRoutesDeps = { bus: null, index: new MembershipIndex(), log: () => undefined },
  // Defaulted likewise — to a NOOP trail, deliberately: a directly-driven
  // route set (unit tests) must never write the operator's real
  // ~/.wicked-crew/audit.log or leave appends pending after close. The real
  // trail always arrives from `createServer`.
  security: SecurityDeps = { audit: AuditLog.noop(), authMode: 'off' },
  // Defaulted likewise: a directly-driven route set gets a fresh (all-active) health map and the
  // real OS opener — tests inject both through this seam.
  runtime: RuntimeDeps = {},
): void {
  const { audit } = security;
  const seatHealth = runtime.seatHealth ?? new SeatHealthTracker();
  const openWithOs = runtime.openWithOs ?? openWithSystemDefault;
  const signedIn = runtime.signedIn ?? signedInHeuristic;
  const retryIndex = runtime.retryIndex ?? new RetryIndex();
  const groupIndex = runtime.groupIndex ?? new GroupIndex();
  const guidanceIndex = runtime.guidanceIndex ?? new GuidanceIndex();
  const deliveryIndex = runtime.deliveryIndex ?? new DeliveryIndex();
  const worktreeExists = runtime.worktreeExists ?? ((p: string) => existsSync(p));
  const vacuityProbes: VacuityProbes = {
    worktreeExists,
    worktreeIsClean: runtime.worktreeIsClean ?? gitWorktreeIsClean(),
    runBranchIsEmpty:
      runtime.runBranchIsEmpty ??
      gitRunBranchIsEmpty(async (repoRef) => {
        const repos = await adapter.listRepos();
        return repos.find((r) => r.id === repoRef)?.root_path;
      }),
  };
  // The background layer that owns the git probes above (GET /runs p99): the run DTOs read it,
  // the daemon's sweep/warm feed it. The default (a directly-driven route set) is COLD and
  // unstarted — no background timer under a unit test, reads degrade to the stat-only
  // tri-state — while `createServer` injects a started one over the production probes.
  const deliveryCache =
    runtime.deliveryCache ??
    new DeliveryDerivationCache({
      listViews: () => adapter.sessionsDetail(),
      probes: vacuityProbes,
      isDelivered: (runId) => deliveryIndex.urlFor(runId) !== undefined,
    });
  const deliverExec = runtime.deliverExec ?? runDeliverScript;
  const reprovisionWorktree = runtime.reprovisionWorktree ?? gitReprovisionWorktree;
  /** Repo root for a repo ref, from the registry — shared by the reprovision path below. */
  const repoRootOf = async (repoRef: string): Promise<string | undefined> =>
    (await adapter.listRepos()).find((r) => r.id === repoRef)?.root_path;
  // The run-DTO joins (DES-UX-001 §8.2/§8.3, DES-UX-002 §7.2): `project_id` from the membership
  // record — `null` = genuinely unfiled, so the field is ALWAYS present on served runs —
  // `retry_of` from the lineage index and `guidance` from the guidance index, each set only
  // when known (absent, never null, spells "not a retry" / "no note"). `delivery` (crew#393,
  // api-types 0.18.0) is DERIVED on every served run — delivered from the index (CREW-UX-8's
  // durable record), stranded from the run record + a worktree stat, none otherwise — so a
  // completed code run whose work is sitting unlifted in its worktree is VISIBLE on the wire,
  // legacy records included. The would-be-stranded runs are further split (crew#311): a
  // completed run whose worktree carries NO contribution at all reads `'vacuous'` — units all
  // "done" with nothing produced must be LOUD on the wire, never silently green. The vacuity
  // split's git probes run in the BACKGROUND (delivery-cache.ts — GET /runs p99): DTO assembly
  // reads the cache and degrades to the stat-only stranded/none label for at most one sweep
  // tick on a miss, so the list fan-out never spawns git.
  // Applied at DTO assembly on exactly the two endpoints that serve the run DTO
  // (GET /runs + GET /runs/:id); the internal sessionsDetail() consumers are untouched.
  // crew#418 A: a `failed` run whose ONLY failure was the deliver phase's LIFT collision (a
  // rebase conflict the changelog union merge could not clear, or a non-fast-forward push) is
  // reinterpreted on the wire as `completed` + `delivery: 'stranded'` — recoverable, not a hard
  // failure. The engine's durable record stays `failed` (audit trail); this is a wire derivation,
  // exactly like `delivery` itself, applied at the SAME three terminal-status decision points so
  // the run reads consistently across GET /runs(/:id), resume, and POST /runs/:id/deliver. The
  // deliver unit stays `rejected` with its marker-bearing `denial_reason`, so WHY it stranded is
  // still on the wire.
  //
  // Returns whether this run IS such a strand — the caller uses it for a BRANCH-based `'stranded'`
  // read: the engine reaps a failed-deliver run's worktree once the deliver phase has committed
  // the work (a clean tree), so the work lives on the `wicked/<id>` branch, not the worktree — the
  // worktree-stat derivation would read `'none'` (and flicker as the async reap lands). The
  // lift-conflict marker is proof the branch carries the work (the deliver script verified it was
  // ahead of the default branch before it ever attempted the rebase), so the read is a STABLE
  // `'stranded'` regardless of whether the worktree survived. Idempotent: a second call sees the
  // already-flipped `completed` and returns false, so the flip never re-fires.
  const normalizeStranded = (view: SessionView): boolean => {
    const conflictStrand = isDeliverConflictStranded(view); // true only while status === 'failed'
    if (conflictStrand) view.session.status = 'completed';
    return conflictStrand;
  };
  /** The run's delivery state, honest by construction (crew#393/#311/#418): a recorded PR wins
   *  (`'delivered'`); else a lift-conflict strand reads `'stranded'` from the branch; else the
   *  delivery-derivation CACHE (a background-derived stranded / vacuous / none — GET /runs p99).
   *  A cache miss answers the stat-only tri-state (one existsSync, the pre-crew#311 label) for
   *  at most one sweep tick; the request path never spawns git and never awaits a derivation. */
  const resolveDelivery = (view: SessionView, conflictStrand: boolean): DeliveryState => {
    const url = deliveryIndex.urlFor(view.session.id);
    if (url !== undefined) return { delivery: 'delivered', deliverUrl: url };
    if (conflictStrand) return { delivery: 'stranded' };
    return deliveryCache.read(view.session);
  };
  const decorateRun = (view: SessionView): SessionView => {
    const conflictStrand = normalizeStranded(view);
    view.session.project_id = projects.index.projectOf(view.session.id) ?? null;
    const retryOf = retryIndex.retryOfFor(view.session.id);
    if (retryOf !== undefined) view.session.retry_of = retryOf;
    // wicked-studio#27 (api-types 0.19.0): the launch-time group attach, from the same durable
    // trail record as lineage. ABSENT when ungrouped — never null.
    const attach = groupIndex.attachOf(view.session.id);
    if (attach !== undefined) {
      if ('campaignId' in attach) view.session.campaign_id = attach.campaignId;
      else view.session.group_label = attach.label;
    }
    const guidance = guidanceIndex.guidanceFor(view.session.id);
    if (guidance !== undefined) view.session.guidance = guidance;
    const state = resolveDelivery(view, conflictStrand);
    view.session.delivery = state.delivery;
    if (state.deliverUrl !== undefined) view.session.deliverUrl = state.deliverUrl;
    return view;
  };
  // Resolved ONCE and shared by the project routes (which read/write `interactiveRoot`) and the
  // interactive proxy (which resolves a root from it) — two stores would let a PATCH land in one
  // and the proxy keep reading the other.
  const projectSettings = projects.settings ?? new ProjectSettingsStore();
  // `req.actor` is pinned by the auth hooks `createServer` installs; a caller
  // driving this function directly (tests) has no hooks, so downstream code
  // still gets the ONE actor shape via this accessor.
  const actorOf = (req: { actor?: import('../core/types.js').Actor }) => req.actor ?? LOCAL_ACTOR;
  // Liveness — also proves the actor + event pump are up.
  // `config.manifest` on the routes below (TH-11): the declaration channel the endpoint manifest
  // reads — type names bind to `wicked-crew-api-types` exports where one exists, structural
  // spellings where the contract has no name, statusCodes list every code the route answers on
  // purpose. Declared on the highest-traffic run-lifecycle routes first; the manifest records
  // null / [] for the rest ("where declared", never invented). See src/api/endpoint-manifest.ts.
  app.get(`${V}/health`, { config: { manifest: { statusCodes: [200] } } }, async () => {
    const ping = await adapter.ping();
    return { status: 'ok', version: PKG_VERSION, ping };
  });

  // The daemon's self-knowledge surface (diagnostics): what is deployed, what it stores, what
  // has gone wrong recently, and whether ACP is really working across the CLIs — the answer
  // that previously lived only in raw NDJSON under the state home. READ-ONLY throughout, and
  // honest throughout: a field the daemon cannot answer is null/empty, never fabricated.
  // The ACP fold and the binary probes are cached (briefly / per-process) so a polling skin
  // can never turn this GET into an event-log re-reader or a `--version` spawner per request.
  const acpFoldCache = new AcpFoldCache();
  const engineVersionCache = new EngineVersionCache();
  app.get(
    `${V}/diagnostics`,
    { config: { manifest: { responseType: 'DiagnosticsResponse', statusCodes: [200] } } },
    async () => {
      // `dbPath` is a readonly field of the real adapter; a stub-driven route set may lack it,
      // and diagnostics over an unknown store honestly reports no stores and no ACP record.
      const dbPath = typeof adapter.dbPath === 'string' && adapter.dbPath !== '' ? adapter.dbPath : null;
      const [stores, byCli, engineBinaries] = await Promise.all([
        dbPath !== null ? listStoreFiles(dbPath) : Promise.resolve([]),
        dbPath !== null
          ? acpFoldCache.get(eventsDirOf(dbPath))
          : Promise.resolve<Awaited<ReturnType<AcpFoldCache['get']>>>({}),
        engineVersionCache.get(),
      ]);
      const uptimeMs = Math.round(process.uptime() * 1000);
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 7701;
      return {
        components: {
          crew: PKG_VERSION,
          studioBundle:
            runtime.studioRoot !== undefined ? readStudioBundleVersion(runtime.studioRoot) : null,
          coreTs: installedPackageVersion('wicked-core-ts'),
          engineBinaries,
        },
        daemon: { uptimeMs, startedAt: Date.now() - uptimeMs, port },
        stores,
        recentErrors: runtime.errorRing?.list() ?? [],
        acp: { byCli },
      };
    },
  );

  // Who am I talking to the daemon as? (task #88). In local mode this is
  // always the implicit full-trust local actor; in required mode it names the
  // token's actor — the cheap probe a skin uses to decide what to render.
  app.get(`${V}/whoami`, async (req) => ({
    actor: actorOf(req),
    authMode: security.authMode,
  }));

  // The actor audit trail (task #88): who launched/steered/governed what.
  // Read-only (observer trust); newest first; `?runId=` / `?action=` / `?limit=`.
  app.get(`${V}/audit`, async (req, reply) => {
    const q = req.query as { runId?: string | string[]; action?: string | string[]; limit?: string | string[] };
    const first = (v: string | string[] | undefined): string | undefined =>
      (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
    const runId = first(q.runId);
    const action = first(q.action);
    const limitRaw = first(q.limit);
    // Reject partial-numeric strings like "10abc" — parseInt accepts those,
    // Number() is strict and returns NaN for them (Copilot, #250).
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || (limit as number) < 1 || !Number.isInteger(limit))) {
      return reply.code(400).send({ error: '`limit` must be a positive integer' });
    }
    try {
      const entries = await audit.read({
        ...(runId !== undefined ? { runId } : {}),
        ...(action !== undefined ? { action } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { entries };
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
  });

  // Report the actually-bound port/host (honours --port / CREW_PORT / port 0).
  app.get(`${V}/config`, async () => {
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 7701;
    const host = typeof addr === 'object' && addr ? addr.address : '127.0.0.1';
    return { port, host };
  });

  // The council seats for the launch form (static production roster), each carrying its RUNTIME
  // health (crew#274). The roster is declarative — every configured seat is listed — and `health`
  // is what the platform has observed: default active with no message; inactive + the error
  // excerpt after a seat-level failure, until an ok output or the recovery probe flips it back.
  // Existing fields ride through verbatim (the seat still round-trips into `clisJson` on launch)
  // — the spread is deliberately NOT a field whitelist, which is what lets the engine's
  // `login_invocation` (seat sign-in, wicked-core PR#278) pass through untouched. Each seat also
  // gains `signed_in`: the cheap file/env presence heuristic, computed against the LIVE
  // `WICKED_WORKER_HOME` env — the same value the engine reads at the next worker spawn, kept
  // current by `applyWorkerConfigRoot` at boot and on every settings change.
  app.get(`${V}/roster`, async () => {
    const workerRoot = process.env['WICKED_WORKER_HOME'];
    return {
      roster: (CoreAdapter.roster() as RosterSeat[]).map((seat) => ({
        ...seat,
        health: seatHealth.healthFor(String(seat.key)),
        signed_in: signedIn(String(seat.key), workerRoot === '' ? undefined : workerRoot),
      })),
    };
  });

  // Open a file/folder with the OS default application (crew#273) — the studio Files tab's
  // click-to-open. The open MUST happen daemon-side (the SPA cannot spawn a process), which is
  // why the path is validated first: absolute, and inside one of the caller-visible roots — the
  // run's workdir + extra write roots (when `runId` is given) or a registered repo root. The
  // run's QE evidence/decisions dirs (`.wicked-qe`/`.wicked-testing`) live under the repo root,
  // so the repo-root rule covers them. Never an arbitrary path.
  app.post(`${V}/open`, async (req, reply) => {
    const parsed = OpenPathSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid open request'));
    }
    const { path: rawPath, runId } = parsed.data;
    if (!isAbsolute(rawPath)) {
      return reply.code(400).send({ error: '`path` must be an absolute path' });
    }
    const target = resolve(rawPath);
    let roots: string[];
    try {
      let session: SessionView['session'] | undefined;
      if (runId !== undefined) {
        const views = await adapter.sessionsDetail();
        const view = views.find((v) => v.session.id === runId);
        if (view === undefined) {
          return reply.code(404).send({ error: `unknown run: ${runId}` });
        }
        session = view.session;
      }
      roots = allowedRootsFor(session, await adapter.listRepos());
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
    if (!roots.some((root) => isInsideRoot(root, target))) {
      return reply.code(403).send({
        error:
          "path is outside every allowed root (the run's workdir/write roots and the registered repos)",
      });
    }
    try {
      await openWithOs(target);
    } catch (err) {
      return reply.code(502).send({ error: `could not open ${target}: ${message(err)}` });
    }
    return { status: 'opened' };
  });

  // ── Run file & diff reads (DES-FEEDBACK-002 CREW-1) ────────────────────────
  // The studio's in-app viewer (P0-3). Both routes are GET-only assembly of reviewed machinery:
  // the SAME containment `POST /open` runs (`allowedRootsFor` + fail-closed `isInsideRoot`) over
  // the SAME root set (run workdir + extra write roots + registered repo roots), capped payloads,
  // and `execCapped` git with argv arrays. Threat delta over /open is strictly smaller: these only
  // return bytes the daemon can already read inside the same containment — no OS opener, no write.

  /** Resolve `:id` → the run's session, and the contained target from `?path=` when present.
   *  Shared by both routes so their validation ladders (404 unknown run → 400 non-absolute →
   *  403 outside every root) cannot drift. Returns `null` after replying. */
  const resolveRunPath = async (
    reply: FastifyReply,
    id: string,
    rawPath: string | undefined,
  ): Promise<{ session: SessionView['session']; target?: string } | null> => {
    let session: SessionView['session'];
    let roots: string[];
    try {
      const views = await adapter.sessionsDetail();
      const view = views.find((v) => v.session.id === id);
      if (view === undefined) {
        await reply.code(404).send({ error: `unknown run: ${id}` });
        return null;
      }
      session = view.session;
      if (rawPath === undefined) return { session };
      roots = allowedRootsFor(session, await adapter.listRepos());
    } catch (err) {
      await reply.code(500).send({ error: message(err) });
      return null;
    }
    if (!isAbsolute(rawPath)) {
      await reply.code(400).send({ error: '`path` must be an absolute path' });
      return null;
    }
    const target = resolve(rawPath);
    if (!roots.some((root) => isInsideRoot(root, target))) {
      await reply.code(403).send({
        error:
          "path is outside every allowed root (the run's workdir/write roots and the registered repos)",
      });
      return null;
    }
    return { session, target };
  };

  // Fastify parses a repeated param as string[] (Copilot, #250/#266). These are FILE-READ
  // routes: `?path=a&path=b` is rejected outright (400) rather than silently reading as
  // either (Copilot, #305).
  const REPEATED_PATH = Symbol('repeated path param');
  const singlePathQ = (
    v: string | string[] | undefined,
  ): string | undefined | typeof REPEATED_PATH =>
    Array.isArray(v) ? REPEATED_PATH : v?.trim() || undefined;

  // File content from the run's contained roots: 512 KB cap (`truncated: true` past it, first
  // 512 KB served), NUL-in-first-8KB binary sniff (`binary: true`, `content: ""`). Read-only by
  // construction (`fs` read); no directory listing — the studio already has the file list.
  app.get(`${V}/runs/:id/files`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rawPath = singlePathQ((req.query as { path?: string | string[] }).path);
    if (rawPath === REPEATED_PATH) {
      return reply.code(400).send({ error: '`path` may be given at most once' });
    }
    if (rawPath === undefined) {
      return reply.code(400).send({ error: '`path` query parameter is required' });
    }
    const resolved = await resolveRunPath(reply, id, rawPath);
    if (resolved === null) return reply;
    const target = resolved.target as string;
    try {
      const read = await readFileCapped(target);
      return { path: target, ...read };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(404).send({ error: `no such file: ${target}` });
      }
      if (err instanceof NotARegularFileError) {
        return reply.code(400).send({ error: `\`path\` is not a regular file: ${target}` });
      }
      return reply.code(500).send({ error: message(err) });
    }
  });

  // The run's worktree diff against HEAD — or, with `?base=` (CREW-UX-1, DES-UX-001 §8.1),
  // against the run branch's fork point (`base=merge-base`) or a plain in-repo ref, so committed
  // run work is visible. Staged + unstaged; untracked appended as all-addition `--no-index`
  // hunks; whole-tree or `?path=` narrowed. 1 MB output cap. `diff: ""` is a real answer (clean
  // tree), not an error. 409 — not 404 — when the run has no workdir or the workdir has been
  // reaped: the RUN exists; what is gone is the thing to diff against. `base` is a baseline,
  // NEVER a command surface: anything that is not the merge-base literal or a plain resolvable
  // ref (flags, paths, ranges, separators) is a named 400 before any git process sees it.
  app.get(`${V}/runs/:id/diff`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string | string[]; base?: string | string[] };
    const rawPath = singlePathQ(q.path);
    if (rawPath === REPEATED_PATH) {
      return reply.code(400).send({ error: '`path` may be given at most once' });
    }
    const rawBase = singlePathQ(q.base);
    if (rawBase === REPEATED_PATH) {
      return reply.code(400).send({ error: '`base` may be given at most once' });
    }
    const resolved = await resolveRunPath(reply, id, rawPath);
    if (resolved === null) return reply;
    const workdir = resolved.session.workdir;
    if (typeof workdir !== 'string' || workdir.length === 0) {
      return reply.code(409).send({ error: `run ${id} has no workdir — nothing to diff` });
    }
    if (!existsSync(workdir)) {
      return reply.code(409).send({ error: `run ${id}'s workdir no longer exists: ${workdir}` });
    }
    // Narrowing is WORKTREE-scoped: a contained-but-outside-the-worktree path (extra write
    // root / repo root) is a valid FILE read but has no meaning as a diff pathspec — rejected
    // explicitly here rather than handing git a `../`-prefixed pathspec and surfacing its
    // "outside repository" error as a 500 (Copilot, #305).
    if (resolved.target !== undefined && !isInsideRoot(workdir, resolved.target)) {
      return reply.code(400).send({
        error: `\`path\` must be inside the run's worktree to diff: ${workdir}`,
      });
    }
    const rel = resolved.target === undefined ? undefined : relative(workdir, resolved.target);
    try {
      return await worktreeDiff(workdir, rel, rawBase);
    } catch (err) {
      // Named 400s (§8.1): malformed base (not a plain ref) and well-formed-but-unresolvable
      // base are both client errors, each with its error name in the body — never a git 500.
      if (err instanceof InvalidDiffBaseError || err instanceof UnresolvableDiffBaseError) {
        return reply.code(400).send({ error: `${err.name}: ${message(err)}` });
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(500).send({ error: 'git executable not found on server' });
      }
      // execCapped throws (no partial output attached) past its 64 MiB daemon-wide buffer —
      // beyond graceful truncation, so the answer is an explicit, actionable refusal
      // rather than a generic 500 (Copilot, #305).
      if (err instanceof ExecOutputTooLarge) {
        return reply.code(507).send({
          error: "diff output exceeds the server's execution buffer — narrow the request with ?path=",
        });
      }
      return reply.code(500).send({ error: message(err) });
    }
  });

  // Registered repos → target-repo picker.
  app.get(`${V}/repos`, async () => ({ repos: await adapter.listRepos() }));

  app.post(`${V}/repos`, async (req, reply) => {
    const parsed = RegisterRepoSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const { name, rootPath, gitUrl } = parsed.data;
    try {
      if (gitUrl) {
        // Remote: clone to rootPath (if provided) or default ~/.wicked/repos/<name>,
        // register, and launch onboarding run.
        const { repoId, runId } = await adapter.cloneAndRegisterRepo(name, gitUrl, rootPath);
        const repos = await adapter.listRepos();
        const repo = repos.find((r) => r.id === repoId);
        if (!repo) return reply.code(500).send({ error: 'Repo registered but could not be retrieved' });
        return reply.code(201).send({ repo, onboardRunId: runId });
      } else {
        // Local: register then launch onboarding run.
        const repo = await adapter.registerRepo(name, rootPath!);
        const runId = await adapter.launchOnboardingRun(repo.id, name);
        return reply.code(201).send({ repo, onboardRunId: runId });
      }
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  // Return the onboarding run id for a repo (so the UI can navigate to it).
  app.get(`${V}/repos/:id/onboard`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = adapter.getOnboardRunId(id) ?? null;
    return reply.code(200).send({ runId });
  });

  // Re-run (or run for the first time) the onboarding workflow for a registered repo.
  app.post(`${V}/repos/:id/onboard`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });
    try {
      const runId = await adapter.launchOnboardingRun(repo.id, repo.name);
      return reply.code(201).send({ runId });
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  // Launch a run (replaces POST /sessions). `clisJson` defaults to the roster;
  // `sessionId` is minted if the client omits it.
  app.post(
    `${V}/runs`,
    {
      config: {
        manifest: {
          requestType: 'LaunchRunBody',
          responseType: '{ runId: string }',
          // 404/409: unknown project / unknown campaignId (wicked-studio#27) /
          // archived-or-synthesized project + busy engine (see the catch below); 400: zod
          // reject or a retryOf naming no existing run; 501: campaignId attach on an engine
          // addon without the campaign bindings ("upgrade the engine").
          statusCodes: [201, 400, 404, 409, 501],
        },
      },
    },
    async (req, reply) => {
    const parsed = LaunchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const b = parsed.data;
    const input: LaunchRunInput = {
      problem: b.problem,
      sessionId: b.sessionId ?? randomUUID(),
      clisJson: b.clisJson ?? JSON.stringify(CoreAdapter.roster()),
    };
    if (b.entityMode !== undefined) input.entityMode = b.entityMode;
    if (b.humanConfirm !== undefined) input.humanConfirm = b.humanConfirm;
    if (b.repoRef !== undefined) input.repoRef = b.repoRef;
    if (b.workflow !== undefined) input.workflow = b.workflow;
    if (b.projectId !== undefined) {
      input.projectId = b.projectId;
      // A project is a CONTEXT (crew#326): a run filed into one should see the project's whole
      // co-located graph, not just its own repo's. Resolved — never REFRESHED — at launch: a
      // launch that silently indexed N repos would block this response for as long as the slowest
      // of them takes, so a missing or stale graph degrades to the repo graph and says why.
      //
      // The decision is recorded either way. "This run sees the project" and "this run sees one
      // repo, because X" are both facts about what the run could observe, and the second is the one
      // an operator needs when a worker reports that a sibling repo does not exist.
      const decision = await resolveProjectGraphBinding(adapter, b.projectId, b.repoRef);
      if (decision.binding !== null) input.projectGraph = decision.binding;
      req.log.info(
        { runId: input.sessionId, projectId: b.projectId, repoRef: b.repoRef ?? null },
        `run ${input.sessionId}: ${decision.reason}`,
      );
    }
    // The delivery contract (crew#393): a completed code run must end with a reviewable
    // deliverable, or an explicit, recorded decision not to. So the deliver option is resolved
    // HERE, at the boundary, for every launch:
    //   - explicit 'pr' / 'none' wins (the operator decided);
    //   - omitted + repo-scoped + a CODE-WORK workflow (the def carries at least one
    //     `executes_code` phase — feature/bug/migration, not chat/onboarding/recon) ⇒ the
    //     daemon's `deliverDefault` setting ('pr' unless the operator flipped it) — the default
    //     that keeps run 83052f0b's work from stranding invisibly again. The code-work guard is
    //     the issue's own scope ("default deliver:'pr' for CODE-WORK launches"): a read-only
    //     workflow leaves a clean worktree, and the deliver script FAILS a clean worktree loudly
    //     ("nothing to deliver", crew#317) — defaulting it on would flip every repo-scoped chat
    //     from completed to failed;
    //   - omitted otherwise ⇒ 'none': a repo-less run has no worktree to lift, and a free-text
    //     run has no def to append the deliver phase to (the adapter REFUSES deliver:'pr'
    //     without a workflow rather than silently dropping it, so defaulting it on would turn
    //     a legal launch into a 400).
    // The adapter input spells 'none' as an omitted field; the audit entry below records the
    // RESOLVED value either way, plus whether it was defaulted.
    let deliver: 'pr' | 'none';
    let deliverDefaulted = false;
    if (b.deliver !== undefined) {
      deliver = b.deliver;
    } else if (b.repoRef !== undefined && b.workflow !== undefined) {
      // Unknown def ⇒ no default (the launch fails at workflow resolution with its own error —
      // defaulting 'pr' onto it would swap that for a misleading deliver-flavored one).
      const def = adapter.getWorkflow(b.workflow);
      const codeWork = def !== null && def.phases.some((p) => p.executes_code === true);
      deliver =
        codeWork && (await adapter.getSettings()).deliverDefault !== 'none' ? 'pr' : 'none';
      deliverDefaulted = true;
    } else {
      deliver = 'none';
      deliverDefaulted = true;
    }
    if (deliver === 'pr') input.deliver = 'pr';
    // Retry lineage (DES-UX-001 §8.3): `retryOf` must name an EXISTING run — recording lineage
    // to a run that never existed would be provenance pointing at nothing, so the launch fails
    // loudly (400, before anything is committed) rather than filing a dangling edge.
    if (b.retryOf !== undefined) {
      const known = await adapter.sessions();
      if (!known.includes(b.retryOf)) {
        return reply.code(400).send({
          error: `retryOf names an unknown run: ${b.retryOf} — lineage must point at an existing run id`,
        });
      }
    }
    // Ad-hoc campaign attach (wicked-studio#27): `campaignId` must name an EXISTING campaign,
    // checked BEFORE anything launches — an unknown id is a 404 with nothing committed, never a
    // run silently filed onto a surface that does not exist. An engine addon without the
    // campaign bindings is a 501 ("upgrade the engine"), the campaigns-surface doctrine. A
    // `groupLabel` needs no check: a label group is created by its first use.
    if (b.campaignId !== undefined) {
      try {
        if ((await adapter.campaignDetail(b.campaignId)) === null) {
          return reply.code(404).send({
            error: `campaignId names an unknown campaign: ${b.campaignId} — an ad-hoc run can only attach to an existing campaign (launch one via POST /campaigns, or use groupLabel for a create-on-first-use group)`,
          });
        }
      } catch (err) {
        if (err instanceof CampaignsUnsupportedError) {
          return reply.code(501).send({ error: message(err) });
        }
        throw err;
      }
    }
    try {
      const runId = await adapter.launchRun(input);
      // Who launched it — the engine's LaunchOptions carries no actor field
      // (checked, wicked-core-ts 0.6.0), so the crew-side trail is the system
      // of record for run provenance (task #88).
      audit.record('run.launched', actorOf(req), {
        runId,
        detail: {
          ...(b.workflow !== undefined ? { workflow: b.workflow } : {}),
          ...(b.repoRef !== undefined ? { repoRef: b.repoRef } : {}),
          ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
          // crew#393: the RESOLVED delivery decision, not just the caller's field — so the
          // trail says what the run will actually do, and whether the daemon decided it.
          deliver,
          ...(deliverDefaulted ? { deliverDefaulted: true } : {}),
          // CREW-UX-3: the trail is the durable record of lineage — the retry index (and a
          // restarted daemon's hydrate) reads it back from exactly this entry.
          ...(b.retryOf !== undefined ? { retryOf: b.retryOf } : {}),
          // wicked-studio#27: the trail is likewise the durable record of the group attach —
          // the group index (and a restarted daemon's hydrate) reads it back from here.
          ...(b.campaignId !== undefined ? { campaignId: b.campaignId } : {}),
          ...(b.groupLabel !== undefined ? { groupLabel: b.groupLabel } : {}),
        },
      });
      if (b.retryOf !== undefined) retryIndex.set(runId, b.retryOf);
      if (b.campaignId !== undefined) groupIndex.set(runId, { campaignId: b.campaignId });
      else if (b.groupLabel !== undefined) groupIndex.set(runId, { label: b.groupLabel });
      if (b.projectId !== undefined) {
        // The engine attached the crew.run membership ATOMICALLY with the launch record
        // (DES-PROJECT-001 §2.2) — this is the post-commit half: tag future /ws frames and
        // emit the membership event (auto-attach at launch is an attach, §4).
        projects.index.set(runId, b.projectId);
        projects.bus?.emit(
          MEMBERSHIP_ATTACHED,
          // The AUTHENTICATED actor id, not a caller-supplied string — locked
          // decision #6 replaces spoofable actor strings on the event surface.
          { project_id: b.projectId, member: { kind: 'crew.run', ref: runId }, actor: actorOf(req).id },
          membershipAttachedKey(b.projectId, 'crew.run', runId, Date.now()),
        );
      }
      return reply.code(201).send({ runId });
    } catch (err) {
      const msg = message(err);
      // An unknown/archived project is a state conflict on a real resource, not a malformed
      // request: 404/409 per the projects error mapping; anything else keeps the launch 400/409.
      if (b.projectId !== undefined && /project.*not registered/i.test(msg)) {
        return reply.code(404).send({ error: msg });
      }
      if (b.projectId !== undefined && /archived|'default'|synthesized/i.test(msg)) {
        return reply.code(409).send({ error: msg });
      }
      const busy = /busy|in flight|already/i.test(msg);
      return reply.code(busy ? 409 : 400).send({ error: msg });
    }
  });

  // Run list (replaces GET /sessions). Actionable-first; reconciles the gate and elicitation caches
  // so that terminal-run entries are pruned even when their terminal CoreEvent was missed.
  app.get(
    `${V}/runs`,
    { config: { manifest: { responseType: '{ runs: SessionView[] }', statusCodes: [200, 400] } } },
    async (req, reply) => {
    const views = await adapter.sessionsDetail();
    gateCache.reconcile(views);
    elicitationCache.reconcile(views);
    // Archived runs are WRITTEN OFF (crew#265): excluded from the default view so finished
    // history doesn't drown live signal, returned in full with `?include=archived`. The caches
    // above reconcile over the COMPLETE set either way — a gate on an archived run must still
    // resolve, not leak.
    // Fastify parses a REPEATED query param as string[] — normalize so `?include=archived`
    // and `?include=archived&include=archived` behave identically (Copilot).
    const { include, limit } = req.query as { include?: string | string[]; limit?: string | string[] };
    const includeArchived = (Array.isArray(include) ? include : [include]).includes('archived');
    // `?limit=N` — the top N AFTER the actionable-first sort below, so a capped poll still sees
    // the runs that need a human before the terminal sediment. The default stays UNBOUNDED: the
    // param used to be read by nobody (silently ignored — the full payload regardless), so an
    // implicit cap would silently change results for un-migrated callers. A malformed value is
    // refused loudly instead of ignored (the FINDING-031 posture: ignoring a field runs a
    // different request than the caller sent) — and a repeated `?limit` is malformed too, since
    // two caps are an ambiguity, not an idempotent repetition like `include`.
    let cap: number | undefined;
    if (limit !== undefined) {
      // STRICT canonical decimal only (Copilot on #435): `Number(...)` also admits hex
      // (`0x10`), exponent (`2e3`), signed (`+1`), and whitespace-padded spellings — surprising
      // aliases a 400-on-malformed contract must refuse, not quietly honor. `0` is deliberately
      // VALID and answers the empty list — a real non-negative integer, not a malformation —
      // while non-canonical zeros (`00`, `01`) are refused with the rest.
      const canonical = !Array.isArray(limit) && /^(0|[1-9][0-9]*)$/.test(limit);
      if (!canonical) {
        return reply.code(400).send({
          error: `Invalid ?limit — expected one non-negative decimal integer, got ${JSON.stringify(limit)}`,
        });
      }
      cap = Number(limit);
    }
    const visible = includeArchived
      ? views
      : views.filter((v) => v.session.archived_at == null);
    const ordered = sortActionableFirst(visible);
    return { runs: (cap !== undefined ? ordered.slice(0, cap) : ordered).map(decorateRun) };
  });

  // ── Run archival (crew#265) — write-off, not delete ────────────────────────
  const ArchiveSchema = z.object({
    archived: z.boolean(),
    note: z.string().max(500).optional(),
  }).strict();
  app.post(`${V}/runs/:id/archive`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ArchiveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    try {
      const found = await adapter.archiveRun(id, parsed.data.archived, parsed.data.note);
      if (!found) return reply.code(404).send({ error: 'Run not found' });
      return { runId: id, archived: parsed.data.archived };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // The engine names a NON-terminal status ("run X is Executing — only a terminal run…"):
      // a state conflict on a real resource, not a bad request (write-off must never hide
      // live work). Anything else — including the old-addon guard — is a real 500.
      if (/only a terminal run/i.test(msg)) return reply.code(409).send({ error: msg });
      return reply.code(500).send({ error: msg });
    }
  });
  // Bulk write-off for campaign backlogs — explicit ids only, never implicit age selection.
  const BulkArchiveSchema = z.object({
    ids: z.array(z.string().min(1)).min(1).max(200),
    note: z.string().max(500).optional(),
  }).strict();
  app.post(`${V}/runs/archive`, async (req, reply) => {
    const parsed = BulkArchiveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    // Per-id outcomes rather than all-or-nothing: a batch of 45 with one live run in it
    // should archive 44 and NAME the refusal, not roll back the write-off.
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of parsed.data.ids) {
      try {
        const found = await adapter.archiveRun(id, true, parsed.data.note);
        results.push(found ? { id, ok: true } : { id, ok: false, error: 'not found' });
      } catch (e: unknown) {
        results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { results, archived: results.filter((r) => r.ok).length };
  });

  // One run's detail.
  app.get(
    `${V}/runs/:id`,
    { config: { manifest: { responseType: '{ run: SessionView }', statusCodes: [200, 404] } } },
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    return { run: decorateRun(run) };
  });

  // ── Post-hoc delivery (crew#393) — lift a stranded run's worktree into a PR ──
  // The recovery path for the run 83052f0b class: a COMPLETED repo-scoped run whose reviewable
  // work was never lifted (`delivery: 'stranded'` on the wire — including runs recorded long
  // before this route existed). Runs the SAME hardened script as the deliver phase (#293/#317:
  // commit, refuse the default branch, rebase — a conflict aborts LOUDLY with nothing pushed —
  // never force, push, `gh pr create`, success re-derived from a real PR URL) against the run's
  // existing worktree. Idempotent: a delivered run answers its recorded URL, never a second PR.
  // Failure is a loud 4xx/5xx carrying the script's own words — never a silent 200.
  const deliverInFlight = new Set<string>();
  // Per-REPO serialization for the worktree-admin-sensitive region (reprovision → deliver →
  // cleanup). deliverInFlight is per-RUN and stops the same run double-delivering, but two
  // DIFFERENT stranded runs in the same repo would both run `git worktree prune/add/remove`
  // against one `.git/worktrees` admin state and race. Chaining a promise per repo ref serializes
  // them; different repos still run in parallel. The tail entry is pruned so the map cannot grow.
  const repoDeliverChain = new Map<string, Promise<void>>();
  const withRepoDeliverLock = async <T>(repoRef: string, fn: () => Promise<T>): Promise<T> => {
    const prior = repoDeliverChain.get(repoRef) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    repoDeliverChain.set(repoRef, mine); // WE are now the tail
    await prior.catch(() => undefined); // wait our turn; a prior failure never blocks ours
    try {
      return await fn();
    } finally {
      release(); // unblock whoever chained after us
      // If nothing chained after us, drop the entry so idle repos leave no trace.
      if (repoDeliverChain.get(repoRef) === mine) repoDeliverChain.delete(repoRef);
    }
  };
  /** The last words of a failed deliver script — enough to name the refusal, bounded so a full
   *  git transcript never becomes an error body. */
  const deliverErrorTail = (output: string): string => {
    const trimmed = output.trim();
    return trimmed.length <= 2000 ? trimmed : `…${trimmed.slice(-2000)}`;
  };
  app.post(
    `${V}/runs/:id/deliver`,
    {
      config: {
        manifest: {
          responseType: 'DeliverRunResult',
          // 404: unknown run. 409: not completed / repo-less / worktree gone / already in
          // flight / the script's own loud refusal (conflict, nothing to deliver, gh failure).
          // 500: exit 0 with no verifiable PR URL, or the spawn itself failed.
          statusCodes: [200, 404, 409, 500],
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      // Idempotency first: a recorded delivery answers the SAME URL — `gh pr create` is never
      // re-run on a delivered run, so a double-click (or a retry after a slow response) cannot
      // double-open. The index only ever holds real runs, so this needs no store round-trip.
      const existing = deliveryIndex.urlFor(id);
      if (existing !== undefined) return { prUrl: existing };
      const views = await adapter.sessionsDetail();
      const run = views.find((v) => v.session.id === id);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      // crew#418 A: a run stranded by a deliver-phase lift collision reads `failed` from the
      // engine but IS liftable post-hoc — normalize its status to `completed` so this route
      // accepts it, exactly as the run wire and the resume route see it.
      const conflictStrand = normalizeStranded(run);
      const s = run.session;
      if (s.status !== 'completed') {
        return reply.code(409).send({
          error: `run ${id} is ${s.status} — only a completed run can be delivered post-hoc`,
        });
      }
      if (s.repo_ref == null || typeof s.workdir !== 'string' || s.workdir === '') {
        return reply.code(409).send({
          error: `run ${id} is not repo-scoped — there is no worktree to lift into a PR`,
        });
      }
      // Capture the ref + workdir while the null-check narrowing is fresh — an intervening await
      // below invalidates property narrowing, so re-reading `s.repo_ref`/`s.workdir` later widens
      // back to `| null`.
      const repoRef: string = s.repo_ref;
      const initialWorkdir: string = s.workdir;
      // One delivery per run at a time: the script pushes and opens a PR, so two concurrent
      // spawns could race gh into two PRs — the exact double-open idempotency forbids. The guard
      // wraps the reprovision too, so a reaped run's `wicked/<id>` branch is only ever checked out
      // by one throwaway worktree at a time.
      if (deliverInFlight.has(id)) {
        return reply.code(409).send({
          error: `a delivery for run ${id} is already in progress — wait for it to finish`,
        });
      }
      deliverInFlight.add(id);
      // The worktree the script runs in. Usually the run's own; but the engine REAPS a
      // failed-deliver run's worktree once its work is committed (crew#418) — the work then lives
      // on the `wicked/<id>` branch. For such a strand, stand a throwaway worktree back up from
      // that branch and lift THAT; the branch (the record) is untouched. `cleanupWorktree` tears
      // the throwaway down after the lift.
      let result: DeliverScriptResult | undefined;
      let worktreeGone = false;
      try {
        // The worktree admin (reprovision), the deliver spawn, AND the throwaway teardown all run
        // under the per-repo lock, so a second stranded run in this repo cannot touch
        // `.git/worktrees` until this one has stood its worktree up, lifted, and torn it back
        // down. `cw` is a LOCAL torn down in the lock body's own finally — nothing captured-mutated
        // crosses the closure boundary.
        await withRepoDeliverLock(repoRef, async () => {
          let workdir = initialWorkdir;
          let cw: (() => Promise<void>) | null = null;
          try {
            if (!worktreeExists(workdir)) {
              const root = conflictStrand ? await repoRootOf(repoRef) : undefined;
              const reprov = root !== undefined ? await reprovisionWorktree(root, id) : null;
              if (reprov === null) {
                worktreeGone = true;
                return;
              }
              workdir = reprov.workdir;
              cw = reprov.cleanup;
            }
            result = await deliverExec(workdir, s.problem ?? undefined);
          } finally {
            if (cw !== null) await cw(); // tear the throwaway down whether the lift succeeded or threw
          }
        });
      } catch (err) {
        return reply.code(500).send({ error: `deliver script could not run: ${message(err)}` });
      } finally {
        deliverInFlight.delete(id);
      }
      if (worktreeGone) {
        return reply.code(409).send({
          error: `run ${id}'s worktree is gone (${s.workdir}) — nothing left to deliver`,
        });
      }
      if (result === undefined) {
        // Unreachable: the lock body assigns `result` on every path that is not `worktreeGone`.
        return reply.code(500).send({ error: `deliver for run ${id} produced no result` });
      }
      if (result.spawnFailure === true) {
        // The script never reached its own verdict (spawn failure, timeout kill) — an infra
        // fault, not a refusal: 500 so the caller knows a retry is reasonable.
        return reply.code(500).send({
          error: `deliver script could not run to completion: ${deliverErrorTail(result.output)}`,
        });
      }
      if (result.status !== 0) {
        // The script's own words (crew#317's rule: never silent, never masked) — it names
        // exactly what it refused (rebase conflict, nothing to deliver, gh's error) and
        // guarantees nothing was pushed on the refusing paths.
        return reply.code(409).send({
          error: `deliver failed (exit ${result.status}): ${deliverErrorTail(result.output)}`,
        });
      }
      const url = prUrlFrom(result.output);
      if (url === null) {
        // Exit 0 with no URL should be unreachable (the script re-derives its own success),
        // but a delivery nothing can be pointed at is never recorded (crew#317).
        return reply.code(500).send({
          error: 'deliver script exited 0 but produced no PR URL — refusing to record a delivery nothing can be pointed at',
        });
      }
      // The durable record first, then the read-side index — the same write order as the
      // deliver-phase resolution in server.ts, so the index can only LAG a crash, never lead it.
      audit.record('run.delivered', actorOf(req), { runId: id, detail: { url, via: 'post-hoc' } });
      deliveryIndex.set(id, url);
      return { prUrl: url };
    },
  );

  // Durable pre-gate guidance (DES-UX-002 §7.2 — spec'd there as CREW-UX-4, implemented as
  // CREW-UX-7 because crew#308 already spent that id; see guidance-index.ts). Upserts the ONE
  // operator note on the run; the empty string clears it. The durable record is the
  // `guidance.set` audit entry (actor + full text); the index is the read-side layer the run
  // DTOs echo it from.
  //
  // GOVERNANCE ISOLATION (deliberate): the governance gate does NOT read this field — the
  // engine's `LaunchOptions` never sees it, and no gate evaluation consults it. It is
  // operator-visible context only; the amend text at gate decision (`POST /runs/:id/gate`)
  // stays the ONE injection point. The studio pre-populates its steer textarea from this note,
  // and injection still happens only through the governed amend.
  app.put(
    `${V}/runs/:id/guidance`,
    {
      config: {
        manifest: {
          requestType: 'SetGuidanceBody',
          responseType: 'SetGuidanceResult',
          statusCodes: [200, 400, 404],
        },
      },
    },
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = GuidanceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const { text } = parsed.data;
    if (Buffer.byteLength(text, 'utf8') > GUIDANCE_MAX_BYTES) {
      return reply.code(400).send({
        error: `guidance exceeds the ${GUIDANCE_MAX_BYTES}-byte cap — a note this size belongs in the problem statement or a linked doc`,
      });
    }
    const known = await adapter.sessions();
    if (!known.includes(id)) return reply.code(404).send({ error: 'Run not found' });
    // The trail is the durable record (CREW-UX-3 posture): a restarted daemon's
    // GuidanceIndex.hydrate reads the note back from exactly this entry.
    audit.record('guidance.set', actorOf(req), { runId: id, detail: { text } });
    guidanceIndex.set(id, text);
    return { runId: id, guidance: text };
  });

  // ── Chat sessions (crew#165): warm ACP seat pool + group fan-out (core#134) ──
  // A chat is NOT a run: no council, no gates, no units. Seats warm on open;
  // messages fan out to warm seats; replies stream on /ws as chatDelta/chatReply.
  const ChatOpenSchema = z.object({
    chatId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
    clis: z.array(z.string().min(1)).min(1).max(8).optional(),
    repoRef: z.string().optional(),
    /** DES-PROJECT-001 §2.2 — file the chat into a project (`crew.chat` membership). */
    projectId: z.string().min(1).optional(),
  }).strict();
  app.post(`${V}/chats`, async (req, reply) => {
    const parsed = ChatOpenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const b = parsed.data;
    const chatId = b.chatId ?? randomUUID();
    let cwd: string | undefined;
    if (b.repoRef !== undefined) {
      const repos = await adapter.listRepos();
      const repo = repos.find((r) => r.id === b.repoRef);
      if (!repo) return reply.code(404).send({ error: `Repo ${b.repoRef} not found` });
      cwd = repo.root_path;
    }
    // Validate the project BEFORE opening seats: a chat has no launch record for the engine to
    // attach against atomically (chats are an in-memory seat pool), so the route validates
    // up-front and attaches right after open — the one non-atomic attach, documented in the ADR
    // changelog. Fail here and no seats were warmed for a filing that could never happen.
    if (b.projectId !== undefined) {
      try {
        const project = await adapter.projectGet(b.projectId);
        if (project === null) {
          return reply.code(404).send({ error: `Project ${b.projectId} not found` });
        }
        if (project.status === 'archived') {
          return reply
            .code(409)
            .send({ error: `project ${b.projectId} is archived and blocks new attachments` });
        }
      } catch (err) {
        return reply.code(501).send({ error: message(err) });
      }
    }
    const clis =
      b.clis ??
      (CoreAdapter.roster() as { key?: string }[])
        .map((s) => s.key)
        .filter((k): k is string => typeof k === 'string');
    try {
      const seats = await adapter.chatOpen(chatId, clis, cwd);
      if (b.projectId !== undefined) {
        try {
          const { member, created } = await adapter.projectMemberAttach(
            b.projectId,
            'crew.chat',
            chatId,
          );
          if (created) {
            projects.index.set(chatId, b.projectId);
            projects.bus?.emit(
              MEMBERSHIP_ATTACHED,
              { project_id: b.projectId, member: { kind: 'crew.chat', ref: chatId }, actor: actorOf(req).id },
              membershipAttachedKey(b.projectId, 'crew.chat', chatId, member.attached_at),
            );
          }
        } catch (err) {
          // The chat is open and usable; the filing failed. Say so instead of failing the open —
          // the caller can re-attach via POST /projects/:id/members.
          return reply
            .code(201)
            .send({ chatId, seats, projectAttachError: message(err) });
        }
      }
      return reply.code(201).send({ chatId, seats });
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  const ChatMessageSchema = z.object({
    text: z.string().min(1).max(65536),
    targets: z.array(z.string().min(1)).min(1).max(8).optional(),
  }).strict();
  app.post(`${V}/chats/:id/messages`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ChatMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    try {
      const seats = await adapter.chatSend(id, parsed.data.text, parsed.data.targets);
      return reply.code(202).send({ seats });
    } catch (err) {
      const msg = message(err);
      return reply.code(/no warm seats/.test(msg) ? 409 : 400).send({ error: msg });
    }
  });

  // Enumerate live chats (FINDING-027 gap 4). Chat sessions deliberately outlive the page, and
  // their ids are minted client-side — so before this route the only record of an orphaned seat
  // lived in the tab that abandoned it, and an operator could not reclaim one without restarting
  // the daemon. Registered BEFORE `/chats/:id` is irrelevant to fastify (it routes on the literal
  // segment first), but the order reads the way the routes nest.
  app.get(`${V}/chats`, async (_req, reply) => {
    try {
      return { chats: await adapter.chatList() };
    } catch (err) {
      // A build that cannot do chat is a capability gap, not a bad request: 501 tells an operator to
      // upgrade rather than to fix a call that was already correct. Branching on the type, not on
      // the message — regexing the text here caught the missing-binding phrasing and missed the
      // engine's own ("chat unsupported: engine spawned without the ACP runner"), so half of one
      // condition answered 400.
      return reply
        .code(err instanceof ChatUnsupportedError ? 501 : 400)
        .send({ error: message(err) });
    }
  });

  app.get(`${V}/chats/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { chatId: id, seats: await adapter.chatSeats(id) };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.delete(`${V}/chats/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await adapter.chatClose(id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  // A unit's captured transcript. `unitKey` accepts the fully-qualified id (`run-1:survey`),
  // the id suffix (`survey`, `u3`), or the ordinal (`u3`, `3`) — see `resolveUnit`.
  //
  // A `null` body is never bare here. An unknown run or an unknown key is a 404 that names the
  // keys this run does have; a unit that exists but has no stored transcript answers 200 with
  // `outputUnavailable` saying WHICH cause applies — denied, not finished, or a store that
  // disagrees with itself. It previously answered `200 {"output": null}` to all four, so the
  // failed unit an operator opens during triage was the one that told them nothing (FINDING-006).
  app.get(`${V}/runs/:id/units/:unitKey/output`, async (req, reply) => {
    const { id, unitKey } = req.params as { id: string; unitKey: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const unit = resolveUnit(run, unitKey);
    if (!unit) {
      return reply.code(404).send({
        error: `Unit '${unitKey}' not found in run ${id}`,
        units: unitKeysFor(run),
      });
    }
    // Keyed off the unit RECORD (the same derivation the evidence bundle uses), not off the
    // caller's path segment — the two disagreeing is what made a resolvable unit unreadable.
    const output = await adapter.workOutput(coreUnitId(id, unit));
    if (output !== null) return reply.send({ output });
    return reply.send({ output: null, outputUnavailable: outputUnavailableReason(unit) });
  });

  // The whole run as one auditable JSON attachment: the run, its units (each with
  // the captured transcript), and the decision trail read back from core's durable
  // per-run event log — what actually happened, not a re-derivation of it.
  app.get(`${V}/runs/:id/evidence`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const bundle = await buildEvidenceBundle(
      run,
      (unitId) => adapter.workOutput(unitId),
      (runId) => adapter.runEvents(runId),
    );
    return reply
      .header('Content-Disposition', `attachment; filename="${evidenceFilename(id)}"`)
      .send(bundle);
  });

  // ── Acceptance gate read (Phase 6a) ─────────────────────────────────────────
  // The QE evidence ledger's verdict + manifest for THIS run's repo, plus the
  // gate's deny-dominates resolution of the workflow's acceptance requirement.
  // Sits beside `/runs/:id/evidence` deliberately: evidence is what the RUN
  // recorded about itself; acceptance is what the QE pipeline recorded about
  // the repo the run worked on — two different systems of record, two routes.
  //
  // Always a 200 for a known run: "no ledger", "no verdict" and "FAIL" are
  // real answers about the gate (each a deny with its own reason), not errors
  // in the request. Only an unknown run 404s. `?qeRun=<id>` pins the read to
  // one QE run's newest verdict instead of the repo's newest overall.
  app.get(`${V}/runs/:id/acceptance`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { qeRun?: string | string[] };
    const qeRunRaw = Array.isArray(q.qeRun) ? q.qeRun[0] : q.qeRun;
    const qeRunId = qeRunRaw?.trim();
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });

    // `sessionsDetail()` patches workflow_id back to the definition name for
    // BUILT-INS; runs of user-registered workflows still carry the instance id,
    // so resolve by phase sequence over the full registry. A free-text run
    // resolves to no workflow, which reads as "declares no requirement".
    const workflow = resolveRunWorkflow(run, adapter.listWorkflows());

    let repo = null;
    if (run.session.repo_ref !== null) {
      const repos = await adapter.listRepos();
      repo = repos.find((r) => r.id === run.session.repo_ref) ?? null;
    }

    return buildAcceptanceView({
      runId: id,
      repo,
      workflow,
      gateEvents: qeGateEvents,
      ...(qeRunId !== undefined && qeRunId !== '' ? { qeRunId } : {}),
      // AW-14 (arch-R13a + R16): the conformance section reads the same wires the standalone
      // `/governance/claims` and `/runs/:id/events` routes serve, but run-scoped and resolved
      // deny-dominates BESIDE the QE gate — so a wiki-rule violation and an unenforced governed
      // unit both appear on the page humans actually look at.
      claims: () => adapter.listConformanceClaims(),
      events: (rid) => adapter.runEvents(rid),
    });
  });

  // The steering gate (§11.1). approve+amend = approve-with-steer; approve:false = reject (cancels).
  app.post(
    `${V}/runs/:id/gate`,
    {
      config: {
        manifest: {
          requestType: 'GateDecision',
          responseType: '{ status: SessionStatus; landing?: SteeringLandingResult }',
          // 409 twice over: a run not awaiting a human gate, and an engine refusal at confirm.
          statusCodes: [200, 400, 404, 409],
        },
      },
    },
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = GateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (run.session.status !== 'awaiting_human') {
      return reply
        .code(409)
        .send({ error: `Run is not awaiting a human gate (status: ${run.session.status})` });
    }
    // The steering-author landing (crew#388): decided — and the gate prompt captured — BEFORE
    // the confirm, because a terminal-phase approve prunes the gate cache and moves the run out
    // of `awaiting_human`. The landing itself runs AFTER a successful approve only.
    // (`listWorkflows` is presence-guarded for partial-stub adapters — a registry-less adapter
    // cannot be hosting a steering-author run, and the legacy gate path must not 500 over it.)
    const steeringPropose =
      parsed.data.approve &&
      typeof adapter.listWorkflows === 'function' &&
      isSteeringAuthorRun(run, adapter.listWorkflows());
    const gatePrompt = steeringPropose ? gateCache.get(id)?.prompt : undefined;
    try {
      const status = await adapter.confirmGate(id, parsed.data.approve, parsed.data.amend);
      // WHO approved/rejected — the gate-decision audit (task #88). The engine
      // records THAT the gate resolved (interaction_requests / gateDecided);
      // only this HTTP layer knows the authenticated principal behind it.
      audit.record('gate.decided', actorOf(req), {
        runId: id,
        detail: {
          approve: parsed.data.approve,
          ...(parsed.data.amend !== undefined ? { amend: parsed.data.amend } : {}),
          status,
        },
      });
      // APPROVE of the steering-author propose gate = the doctrine's landing moment: the
      // approved proposal is written to the governance store with `provenance.source: "chat"`,
      // audited per rule, idempotent on replay, and LOUD on failure — the response carries the
      // outcome either way, so the studio can show "landed PAT-101" or the explicit error
      // instead of the silent no-op crew#388 recorded. An approve WITH an amend note still
      // lands the proposal UNCHANGED: the amend steers the RUN's continuation, not the rule
      // text (an operator who wants different rules rejects and re-authors). A reject lands
      // nothing — the run cancels and the proposal stays an artifact.
      const landing = steeringPropose
        ? await landSteeringProposal({ adapter, audit, actor: actorOf(req) }, run, gatePrompt)
        : undefined;
      return reply.send({ status, ...(landing !== undefined ? { landing } : {}) });
    } catch (err) {
      return reply.code(409).send({ error: message(err) });
    }
  });

  // Cancel a running or paused run (distinct third action, §11.1).
  app.post(`${V}/runs/:id/cancel`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    try {
      const status = await adapter.cancelRun(id);
      audit.record('run.cancelled', actorOf(req), { runId: id, detail: { status } });
      return reply.send({ status });
    } catch (err) {
      return reply.code(409).send({ error: message(err) });
    }
  });

  // Advance semantics (§11.8): a gated run advances via confirmGate; otherwise
  // resumeRun re-enters the cursor. Never resumeRun a gated run (it would re-pause).
  app.post(`${V}/runs/:id/resume`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    // crew#418 A: a run stranded by a deliver-phase lift collision reads `failed` from the engine
    // but its work is complete and liftable — normalize to `completed` so the terminal branch
    // below refuses resume with the DELIVER recovery (POST /runs/:id/deliver), not a re-entry.
    const conflictStrand = normalizeStranded(run);
    // A TERMINAL run is refused LOUDLY, with the actual recovery named (crew#311 defect 2).
    // The engine's `resume_run` no-ops on completed/cancelled and answers the status token, so
    // this route used to reply 200 {"status":"cancelled"} — on the exact runs an operator was
    // trying to rescue, the recovery affordance read as "resume destroyed my run". A cancelled
    // run has NO in-run recovery (the path is a retry launch, `POST /runs {retryOf}`); a
    // completed run has nothing to resume — but a stranded one's work IS liftable post-hoc.
    // The 409 body carries the machine-readable pointer (`ResumeRefusal` in api-types).
    const terminal = run.session.status;
    if (terminal === 'completed' || terminal === 'cancelled') {
      const state = resolveDelivery(run, conflictStrand);
      const recovery = terminal === 'completed' && state.delivery === 'stranded'
        ? ('deliver' as const)
        : ('retry' as const);
      const why =
        terminal === 'cancelled'
          ? `run ${id} is cancelled — a terminal run cannot be resumed; relaunch the work as a new run with POST /runs {"retryOf":"${id}"}`
          : state.delivery === 'stranded'
            ? `run ${id} is already completed — nothing to resume; its unlifted work is on the wicked/${id} branch: deliver it with POST /runs/${id}/deliver`
            : state.delivery === 'vacuous'
              ? `run ${id} is already completed, but VACUOUSLY — its units produced no work to resume or deliver; relaunch with POST /runs {"retryOf":"${id}"}`
              : `run ${id} is already completed — nothing to resume; relaunch the work as a new run with POST /runs {"retryOf":"${id}"}`;
      return reply.code(409).send({ error: why, recovery });
    }
    try {
      const gated = run.session.status === 'awaiting_human';
      // A gated resume IS a gate approval, so it lands a steering-author proposal exactly like
      // POST /runs/:id/gate would — the "no side door" rule (task #88) holds for the landing
      // write too (crew#388). Prompt captured pre-confirm; see the gate route.
      const steeringPropose =
        gated &&
        typeof adapter.listWorkflows === 'function' &&
        isSteeringAuthorRun(run, adapter.listWorkflows());
      const gatePrompt = steeringPropose ? gateCache.get(id)?.prompt : undefined;
      const status = gated ? await adapter.confirmGate(id, true) : await adapter.resumeRun(id);
      // A resume of a gated run IS a gate approval — audit it as one, so the
      // "who approved" trail has no side door (task #88).
      audit.record(gated ? 'gate.decided' : 'run.resumed', actorOf(req), {
        runId: id,
        detail: gated ? { approve: true, via: 'resume', status } : { status },
      });
      const landing = steeringPropose
        ? await landSteeringProposal({ adapter, audit, actor: actorOf(req) }, run, gatePrompt)
        : undefined;
      return reply.send({ status, ...(landing !== undefined ? { landing } : {}) });
    } catch (err) {
      return reply.code(409).send({ error: message(err) });
    }
  });

  // Inject an operator message into a run's active worker(s) (§11.7).
  // target="all" broadcasts; any other value targets a specific CLI key.
  // Use sessions() (IDs only) for existence check — cheaper than sessionsDetail() on a hot path.
  app.post(`${V}/runs/:id/inject`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = InjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const ids = await adapter.sessions();
    if (!ids.includes(id)) return reply.code(404).send({ error: 'Run not found' });
    try {
      await adapter.injectWorkerMessage(id, parsed.data.message, parsed.data.target);
      audit.record('run.injected', actorOf(req), { runId: id, detail: { target: parsed.data.target } });
      return reply.send({ status: 'ok' });
    } catch (err) {
      return reply.code(409).send({ error: message(err) });
    }
  });

  // The gate prompt for a paused run, so a fresh browser can render the gate after a late join.
  //
  // Cache first, durable event log second (FINDING-051). The cache is process-lifetime, so before
  // the fallback existed a daemon restart left every parked run unable to say what it was asking —
  // not because the prompt was gone (core records `awaitingHuman` to the log) but because nothing
  // read it. A restart is routine: deploy, crash, laptop sleep.
  app.get(`${V}/runs/:id/gate`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cached = gateCache.get(id);
    if (cached) return { runId: id, ...cached };

    // A miss is not evidence of anything on its own, so ask the run what it is doing before paying
    // to replay it. Only `awaiting_human` can have an open gate, and that answer is definitive:
    // every other status is a 404 that needs no log at all — which is also the overwhelmingly
    // common case here, since studio polls this route for runs that are merely finished.
    //
    // Reading status first is therefore CHEAPER than not reading it, the opposite of what the first
    // cut of this assumed: it trades one `sessionsDetail()` for replaying an entire event history,
    // and it was that skipped check which made a completed run answer 503 on any build without the
    // binding (CI caught it) — an error where the honest, knowable answer was "no gate".
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (run.session.status !== 'awaiting_human') {
      return reply.code(404).send({ error: 'No open gate for this run' });
    }

    // DURABLE TRUTH FIRST (DES-PROJECT-001 §5.3): the engine persists the open prompt in
    // `interaction_requests`, written in the same transaction as the `awaiting_human` pause —
    // so a daemon restart reads it back directly instead of replaying the event log. The cache
    // adopts the row (latency layer over durable truth — its comments finally true). The replay
    // below stays as the FALLBACK, not just for engines predating the binding: a run parked
    // BEFORE the engine grew the table is awaiting_human with no row, and answering 404 there
    // would re-open FINDING-051 for exactly the runs mid-upgrade. Row → serve it; no row →
    // fall through and let the log speak.
    const durableRows =
      typeof adapter.interactionRequests === 'function'
        ? await adapter.interactionRequests(id, 'open')
        : null;
    const durableGate = durableRows?.find((r) => r.kind === 'gate');
    if (durableGate !== undefined) {
      // This path builds the entry inline (not through `fold`), so it must run the SAME refusal
      // detection (issue #419) — otherwise a gate served from the durable row after a restart would
      // silently drop the warning that the live/replay paths carry.
      const refusal = detectRefusal(durableGate.prompt);
      const entry = {
        ord: durableGate.ord ?? 0,
        prompt: durableGate.prompt,
        lifecycle: 'open' as const,
        receivedAt: new Date(durableGate.created_at).toISOString(),
        ...(refusal !== undefined ? { refusal } : {}),
      };
      gateCache.adopt(id, entry);
      return { runId: id, ...entry };
    }

    const events = await adapter.runEvents(id);
    if (events === null) {
      // Now — and only now — 503 is the honest answer: this run really is holding for a human, and
      // this build cannot say what it is asking. Distinct cause, distinct message; answering "no
      // gate" here would report a capability gap as a fact about the run (the FINDING-050 shape).
      return reply.code(503).send({
        error: 'Gate history is unavailable: this wicked-core build has no event-log read binding',
      });
    }
    const replayed = gateCache.rebuild(id, events);
    if (!replayed) {
      // Parked, with a history that records no open gate. Pre-log runs land here (their prompt is
      // genuinely lost), as does a gate whose `awaitingHuman` predates the log's retention.
      return reply.code(404).send({ error: 'No open gate for this run' });
    }
    return { runId: id, ...replayed };
  });

  // ── Elicitation (DES-002) ────────────────────────────────────────────────────
  //
  // GET returns the current pending elicitation prompt for a run (display-store read).
  // POST resolves it: the body carries the elicitationId to guard against stale tabs,
  // the action (accept|decline|cancel), and — for accept — the operator's response.

  app.get(`${V}/runs/:id/elicitation`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = elicitationCache.get(id);
    // `entry` already carries `runId`; return it directly to avoid TS2783
    // ("runId is specified more than once") from a redundant spread.
    if (entry) return entry;
    // Cache miss: check existence before returning 404.
    // Use sessions() (IDs only) — cheaper than sessionsDetail() on this read path.
    const ids = await adapter.sessions();
    if (!ids.includes(id)) return reply.code(404).send({ error: 'Run not found' });
    // Durable probe (DES-PROJECT-001 §5.3): `interaction_requests` reserves kind `elicitation`.
    // The engine writes no elicitation rows yet — the LIVE elicitation wire is complete
    // (create → cache → resolve, crew#357/#358), but the durable half of the PROMPT is still
    // engine-side future work (wicked-core interaction.rs: "gate today; elicitation reserved") —
    // so this read is empty today; it exists so the cache is STRUCTURALLY a latency layer, and
    // the day the engine writes the rows, restart survival holds here exactly as it does for
    // gates, with no route change. Guarded like `runEvents`: a partial-stub adapter (tests) or
    // a pre-0.6.0 addon simply has no durable half.
    const durable =
      typeof adapter.interactionRequests === 'function'
        ? await adapter.interactionRequests(id, 'open')
        : null;
    const pending = durable?.find((r) => r.kind === 'elicitation');
    if (pending !== undefined) {
      return {
        runId: id,
        elicitationId: pending.id,
        message: pending.prompt,
        options: null,
        receivedAt: new Date(pending.created_at).toISOString(),
      };
    }
    return reply.code(404).send({ error: 'No pending elicitation for this run' });
  });

  const ElicitationRespondSchema = z
    .object({
      /** Guards against stale-tab submissions: must match the current elicitation's id. */
      elicitationId: z.string().min(1),
      action: z.enum(['accept', 'decline', 'cancel']),
      /** Required when action is "accept" (response must be non-empty); must be absent for decline/cancel. */
      content: z.object({ response: z.string().min(1) }).optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
      if (val.action !== 'accept' && val.content !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['content'],
          message: 'content must only be provided when action is "accept"',
        });
      }
    });

  app.post(`${V}/runs/:id/elicitation`, async (req, reply) => {
    const { id } = req.params as { id: string };

    // 1. Validate body.
    const parsed = ElicitationRespondSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const body = parsed.data;

    // 1b. Accept requires content.response — validated here, before any state query, so
    //     the 400 is deterministic regardless of run-existence / cache state (P2).
    if (body.action === 'accept' && !body.content?.response) {
      return reply.code(400).send({ error: 'action:accept requires content.response' });
    }

    // 2. Existence check (IDs only — cheaper than sessionsDetail).
    const ids = await adapter.sessions();
    if (!ids.includes(id)) return reply.code(404).send({ error: 'Run not found' });

    // 3. Atomically take the pending elicitation.
    const taken = elicitationCache.take(id);
    if (!taken) return reply.code(409).send({ error: 'No pending elicitation for this run' });

    // 4. Stale-tab check: submitted elicitationId must match the one we just took.
    if (body.elicitationId !== taken.entry.elicitationId) {
      elicitationCache.restoreIfUnchanged(id, taken.entry, taken.gen);
      return reply
        .code(409)
        .send({ error: 'Elicitation superseded; fetch the current prompt and resubmit' });
    }

    // 5. Accept-specific validation.
    if (body.action === 'accept') {
      // 5a. content.response must be present.
      if (typeof body.content?.response !== 'string') {
        elicitationCache.restoreIfUnchanged(id, taken.entry, taken.gen);
        return reply.code(400).send({ error: 'action:accept requires content.response' });
      }
      // 5b. Enum check: if the schema constrained the response, honour it.
      if (
        taken.entry.options !== null &&
        !taken.entry.options.includes(body.content.response)
      ) {
        elicitationCache.restoreIfUnchanged(id, taken.entry, taken.gen);
        return reply.code(400).send({ error: 'response must be one of the allowed options' });
      }
    }

    const response = body.action === 'accept' ? body.content!.response : null;

    // 6. Forward to the actor.
    try {
      await adapter.resolveElicitation(id, taken.entry.elicitationId, body.action, response);
    } catch (err) {
      elicitationCache.restoreIfUnchanged(id, taken.entry, taken.gen);
      const code = err instanceof ElicitationUnsupportedError ? 501 : 500;
      return reply.code(code).send({ error: message(err) });
    }

    // 7. Done.
    audit.record('elicitation.resolved', actorOf(req), {
      runId: id,
      detail: { elicitationId: taken.entry.elicitationId, action: body.action },
    });
    return { status: 'resolved' };
  });

  // The durable history of one run (FINDING-057).
  //
  // `/ws` is a live tap and explicitly replays nothing on late join, so until this route existed
  // the event log had exactly one reader — the gate route above, which reads it for a single
  // `awaitingHuman` frame and discards the rest. Everything else a run recorded (routing councils,
  // gate verdicts, per-unit cost) was write-only: observable if you happened to be attached while
  // it streamed, and unrecoverable afterwards. That makes an incident un-investigable and a run's
  // audit trail unciteable, which is the opposite of what a durable log is for.
  //
  // `type` filters server-side because the alternative is shipping an entire run's history to
  // answer "what did the gates decide" — the log already excludes high-volume frames
  // (`is_high_volume` drops CLI/chat deltas and terminal output), so what remains is the
  // lifecycle, but a long run is still thousands of frames.
  app.get(`${V}/runs/:id/events`, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Fastify's default querystring parser yields a string for `?type=a` and an ARRAY for a
    // repeated `?type=a&type=b`. Typing it as `string` and calling `.split` would have thrown a
    // 500 on the repeated form — a caller asking for two types the obvious way.
    const { type } = req.query as { type?: string | string[] };

    // IDs only: this is an existence check, and `sessionsDetail()` would load and parse every
    // run's full unit detail to answer it — the same reason `/runs/:id/inject` uses `sessions()`.
    const ids = await adapter.sessions();
    if (!ids.includes(id)) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    const events = await adapter.runEvents(id);
    if (events === null) {
      // Same shape as the gate route's 503, and for the same reason: "no events" would report a
      // missing binding as a fact about the run. The run may well have a rich history.
      return reply.code(503).send({
        error: 'Run history is unavailable: this wicked-core build has no event-log read binding',
      });
    }

    // An empty array here is a real answer, not a failure: runs that predate the log have no
    // history, and saying so is the honest response.
    // Both spellings of "several types" mean the same thing: `?type=a,b` and `?type=a&type=b`.
    // An empty filter (`?type=`, or only separators) is treated as NO filter rather than as a
    // filter matching nothing — "show me events of no type" is not a question anyone asks, and
    // answering it with an empty list looks identical to a run that recorded nothing.
    const names = (Array.isArray(type) ? type : type === undefined ? [] : [type])
      .flatMap((t) => t.split(','))
      .map((t) => t.trim())
      .filter(Boolean);
    const wanted = names.length > 0 ? new Set(names) : null;
    const filtered = wanted ? events.filter((e) => wanted.has(e.type)) : events;
    return { runId: id, total: events.length, returned: filtered.length, events: filtered };
  });

  // ── Governance reads (crew#40) ──────────────────────────────────────────────

  // STEERING fold: the READ half of the old policy surface stays — retired-not-deleted means a
  // past gate decision citing a policy id must stay resolvable, and the engine keeps serving the
  // listing (as a thin shim over the unified store once the model merges). The WRITE half
  // (POST/DELETE below) answers 410 on a steering engine — see the fold comment there.
  app.get(
    `${V}/governance/policies`,
    { config: { manifest: { responseType: '{ policies: GovernancePolicy[] }', statusCodes: [200] } } },
    async () => {
      const policies = await adapter.listPolicies();
      return { policies };
    },
  );

  // The wiki BROWSE surface (wiki-mgmt): facet filters over the listed rows. EXACT matches by
  // design — unlike `/governance/rules/preview`, whose recall semantics treat an absent rule
  // facet as a wildcard (enforcement's question: "which rules apply HERE"), browse answers
  // "show me the rules TAGGED `layer=api`", and a wildcard rule flooding every layer filter
  // would bury the tagged ones. `?status=` keeps the AW-24 kill switch visible: every row keeps
  // its `retired` flag, and `retired`/`active` narrow to one side. Default is `all` — the
  // route's historical behavior, though pre-0.7.4 addons funnel the listing through recall and
  // return active rows only (the engine's fact to fix, not this filter's to mask).
  app.get(
    `${V}/governance/rules`,
    {
      config: {
        manifest: {
          responseType: '{ rules: ConformanceRule[] }',
          // 501: `?type=` on a pre-steering engine (wicked-core-ts < 0.7.5) — see the facet below.
          statusCodes: [200, 400, 501],
        },
      },
    },
    async (req, reply) => {
      const q = req.query as Record<string, string | string[] | undefined>;
      // Same normalization as `repoParam` below: first value of a repeated param, trimmed, and
      // an empty/whitespace value means "facet not given" rather than a filter matching nothing.
      const facet = (k: string): string | undefined => {
        const raw = q[k];
        const first = Array.isArray(raw) ? raw[0] : raw;
        const trimmed = first?.trim();
        return trimmed ? trimmed : undefined;
      };
      // Closed vocabularies reject loudly (400 names the valid set): `?severity=hihg` silently
      // matching nothing would read as "no critical rules" — an empty answer to a question the
      // caller didn't ask.
      const invalid = (name: string, got: string, valid: string) =>
        reply.code(400).send({ error: `${name} must be one of ${valid} (got \`${got}\`)` });
      const severity = facet('severity');
      if (severity !== undefined && !RULE_SEVERITIES.has(severity)) {
        return invalid('severity', severity, 'info|warn|error|critical');
      }
      const ruleType = facet('rule_type');
      if (ruleType !== undefined && !RULE_TYPES.has(ruleType)) {
        return invalid('rule_type', ruleType, 'pattern|policy');
      }
      // `?type=` — the STEERING facet (one Steering sub-page per type). Closed vocabulary, and
      // presence-gated on the steering engine: rows served by a pre-0.7.5 addon carry no
      // `steering_type`, so filtering them would answer "no <type> rules" to a question this
      // engine cannot answer — 501 ("upgrade the engine"), never an empty non-answer.
      const steeringType = facet('type');
      if (steeringType !== undefined && !STEERING_TYPES.has(steeringType)) {
        return invalid('type', steeringType, STEERING_TYPE_VALUES.join('|'));
      }
      if (steeringType !== undefined && !adapter.steeringSupported()) {
        return reply
          .code(501)
          .send({ error: new SteeringUnsupportedError('Filtering rules by steering type').message });
      }
      // `?include_retired=` — the boolean spelling of the retire filter (`true` ⇒ `all`,
      // `false` ⇒ `active`). Mutually exclusive with `?status=`: the two are one filter in two
      // spellings, and silently picking a winner when they contradict would answer a question
      // the caller didn't ask.
      const includeRetired = facet('include_retired');
      if (includeRetired !== undefined && includeRetired !== 'true' && includeRetired !== 'false') {
        return invalid('include_retired', includeRetired, 'true|false');
      }
      const statusGiven = facet('status');
      if (includeRetired !== undefined && statusGiven !== undefined) {
        return reply.code(400).send({
          error:
            'send `status` or `include_retired`, not both — they are two spellings of the same retire filter and can contradict',
        });
      }
      const status =
        statusGiven ?? (includeRetired === undefined ? 'all' : includeRetired === 'true' ? 'all' : 'active');
      if (!RULE_STATUSES.has(status)) {
        return invalid('status', status, 'active|retired|all');
      }
      const layer = facet('layer');
      const rules = (await adapter.listConformanceRules()).filter(
        (r) =>
          (severity === undefined || r.severity === severity) &&
          (ruleType === undefined || r.rule_type === ruleType) &&
          (layer === undefined || r.targets.layer === layer) &&
          // Absent `steering_type` reads as the engine's serde default (architecture) — a
          // steering engine always stamps it, but filter defensively over mixed-era rows.
          (steeringType === undefined || (r.steering_type ?? DEFAULT_STEERING_TYPE) === steeringType) &&
          // `retired` is absent on rows written before the field existed, which read as active.
          (status === 'all' || (status === 'retired') === (r.retired === true)),
      );
      return { rules };
    },
  );

  app.get(`${V}/governance/claims`, async () => {
    const claims = await adapter.listConformanceClaims();
    return { claims };
  });

  // Normalize a `?repo=` query: Fastify parses a repeated `?repo=a&repo=b` into a `string[]` (take
  // the first), and the value is TRIMMED so it's both validated and PASSED trimmed — a `?repo=%20x%20`
  // must not pass the guard then miss the registry lookup on whitespace (Copilot #227).
  const repoParam = (req: { query?: unknown }): string | undefined => {
    const raw = (req.query as { repo?: string | string[] } | undefined)?.repo;
    const first = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = first?.trim();
    return trimmed ? trimmed : undefined;
  };
  // An unknown repo is the CALLER's error (404); a binding/parse failure is OURS (500). Don't collapse
  // them (Copilot #227). Core spells the not-found case `no registered repo '<ref>'`.
  const repoReadStatus = (msg: string): number => (/no registered repo/i.test(msg) ? 404 : 500);

  app.get(`${V}/governance/coverage`, async (req, reply) => {
    // FINDING-009: with `?repo=<ref>`, report coverage over THAT repo's own code graph. The bare
    // endpoint reads the daemon store and reports a vacuous `coverage: 1.0` that names no repo — the
    // real gate lives per-repo. An unknown repo is an ERROR in core (never a silent vacuous report).
    const repo = repoParam(req);
    if (repo) {
      try {
        const report = await adapter.getCoverageReportForRepo(repo);
        return { report };
      } catch (err) {
        const msg = message(err);
        return reply.code(repoReadStatus(msg)).send({ error: msg });
      }
    }
    const report = await adapter.getCoverageReport();
    return { report };
  });

  app.get(`${V}/governance/graph`, async (req, reply) => {
    // #122: node-count-by-kind summary of a repo's OWN code graph. Repo-scoped ONLY — there is no
    // meaningful daemon-wide graph view (the daemon store holds run/governance nodes, not a repo's
    // code graph), so a missing `?repo=` is a 400, an unknown repo a 404, and an engine/binding
    // failure a 500 (not masked as 404).
    const repo = repoParam(req);
    if (!repo) {
      return reply.code(400).send({ error: 'governance/graph requires a ?repo=<ref>' });
    }
    try {
      const kinds = await adapter.getGraphKindsForRepo(repo);
      return { kinds };
    } catch (err) {
      const msg = message(err);
      return reply.code(repoReadStatus(msg)).send({ error: msg });
    }
  });

  // ── Governance writes (crew#42; STEERING fold) ─────────────────────────────

  // The OLD policy WRITE surface, folded into the unified rules routes (STEERING program): on a
  // steering engine (wicked-core-ts ≥ 0.7.5, where policy rows have MIGRATED into steering
  // rules) these answer 410 Gone with a pointer at the rules CRUD — the wire contract's honest
  // spelling of "this resource model no longer exists" (a silent alias would accept a write into
  // a store decide()/select() no longer read). On a PRE-steering engine the legacy behavior
  // stands untouched: folding before the model merges would strand policy writes with no unified
  // store to land in.
  //
  // The READ (`GET /governance/policies` above) deliberately stays: retired-not-deleted means
  // past decisions citing a policy id must stay resolvable, the engine keeps a read shim for
  // exactly that, and the released studio 0.4.2 still renders the listing.
  const policyWriteGone = (reply: FastifyReply, pointer: string) =>
    reply.code(410).send({
      error:
        'the policy model merged into steering rules (STEERING program): policies are now ' +
        `steering rules with effect/trigger/obligations/criteria as first-class fields — use ${pointer}`,
      see: pointer,
    });

  app.post(
    `${V}/governance/policies`,
    { config: { manifest: { statusCodes: [200, 400, 410] } } },
    async (req, reply) => {
      if (adapter.steeringSupported()) {
        return policyWriteGone(reply, `POST ${V}/governance/rules`);
      }
      try {
        const policy = req.body as import('../core/types.js').GovernancePolicy;
        await adapter.upsertPolicy(policy);
        audit.record('governance.policy.upserted', actorOf(req), { detail: { id: policy?.id } });
        return { status: 'ok' };
      } catch (err) {
        return reply.code(400).send({ error: message(err) });
      }
    },
  );

  // The steering fields a rule write may carry — the merged model's additions (STEERING). On an
  // engine that predates the model, `upsertConformanceRule` would ACCEPT the write and silently
  // drop every one of them (ConformanceRule has no `deny_unknown_fields`), persisting a rule
  // that recalls and enforces differently than the caller wrote — so their presence is gated
  // loudly (the extraWriteRoots doctrine): 501, upgrade the engine. A write WITHOUT them is the
  // legacy request and passes through on any engine.
  const STEERING_RULE_FIELDS = [
    'steering_type',
    'applies_to',
    'excludes',
    'weight',
    'effect',
    'trigger',
    'obligations',
    'criteria',
  ] as const;

  app.post(
    `${V}/governance/rules`,
    {
      config: {
        manifest: {
          requestType: 'ConformanceRule',
          // 501: the body carries steering fields but the installed engine predates the
          // steering model (wicked-core-ts < 0.7.5) and would silently drop them.
          statusCodes: [200, 400, 501],
        },
      },
    },
    async (req, reply) => {
      try {
        const rule = req.body as import('../core/types.js').ConformanceRule;
        if (!adapter.steeringSupported() && rule !== null && typeof rule === 'object') {
          const carried = STEERING_RULE_FIELDS.filter(
            (f) => (rule as unknown as Record<string, unknown>)[f] !== undefined,
          );
          if (carried.length > 0) {
            return reply.code(501).send({
              error:
                `${new SteeringUnsupportedError('Writing steering rule fields').message} — ` +
                `the installed engine would silently drop ${carried.map((f) => `\`${f}\``).join(', ')} ` +
                'and persist a rule that enforces differently than you wrote',
            });
          }
        }
        await adapter.upsertConformanceRule(rule);
        audit.record('governance.rule.upserted', actorOf(req), { detail: { id: rule?.id } });
        return { status: 'ok' };
      } catch (err) {
        return reply.code(400).send({ error: message(err) });
      }
    },
  );

  // Retire, not delete. The record survives so past decisions citing it stay explicable; it just
  // stops being enforced (FINDING-038 — a mis-authored policy otherwise denied forever).
  app.delete(
    `${V}/governance/policies/:id`,
    { config: { manifest: { statusCodes: [200, 400, 404, 410] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      // Folded like the POST above: on a steering engine the migrated row retires through the
      // rules kill switch (same id — migration keeps ids stable so decision audits resolve).
      if (adapter.steeringSupported()) {
        return policyWriteGone(reply, `DELETE ${V}/governance/rules/${id}`);
      }
      try {
        const existed = await adapter.retirePolicy(id);
        if (!existed) return reply.code(404).send({ error: `policy '${id}' not found` });
        audit.record('governance.policy.retired', actorOf(req), { detail: { id } });
        return { status: 'retired', id };
      } catch (err) {
        return reply.code(400).send({ error: message(err) });
      }
    },
  );

  app.delete(`${V}/governance/rules/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const existed = await adapter.retireConformanceRule(id);
      if (!existed) return reply.code(404).send({ error: `conformance rule '${id}' not found` });
      audit.record('governance.rule.retired', actorOf(req), { detail: { id } });
      return { status: 'retired', id };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.get(`${V}/governance/rules/preview`, async (req, reply) => {
    const q = req.query as Record<string, string | string[] | undefined>;
    try {
      const rules = await adapter.recallRulesPreview(q);
      return { rules };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  // ── Workflow viewer + builder (crew#44) ───────────────────────────────────

  app.get(`${V}/workflows`, async () => {
    const workflows = adapter.listWorkflows();
    return { workflows };
  });

  app.get(`${V}/workflows/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const workflow = adapter.getWorkflow(id);
    if (!workflow) return reply.code(404).send({ error: `workflow '${id}' not found` });
    // humanGates: the phases that will PAUSE for a person even under humanConfirm:none (core#208).
    // Surfaced so an operator can see a workflow's gates BEFORE launching it (FINDING-023).
    return { workflow, humanGates: humanGatePhaseIds(workflow) };
  });

  // Register (or replace) a user-authored workflow definition.
  // Validates, persists to ~/.wicked/workflows/<id>.json, hot-registers in the
  // Rust actor when registerWorkflow NAPI is available.
  app.post(`${V}/workflows`, async (req, reply) => {
    const body = req.body as { id?: unknown };
    if (!body || typeof body.id !== 'string' || !body.id) {
      return reply.code(400).send({ error: 'workflow must have a string `id` field' });
    }
    if (!SAFE_REPO_NAME.test(body.id) || body.id.length > 128) {
      return reply.code(400).send({ error: 'workflow id must start with a letter/digit and contain only letters, digits, dots, hyphens, and underscores' });
    }
    try {
      const id = await adapter.registerWorkflow(body as import('../core/types.js').WorkflowDef);
      audit.record('workflow.registered', actorOf(req), { detail: { id } });
      return reply.code(201).send({ id, status: 'registered' });
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  // Save an inline script to ~/.wicked/scripts/ and return its path.
  // Tool-executor phases use the returned path as their command.
  app.post(`${V}/scripts`, async (req, reply) => {
    const body = req.body as { name?: unknown; content?: unknown; lang?: unknown };
    if (typeof body.name !== 'string' || typeof body.content !== 'string') {
      return reply.code(400).send({ error: '`name` and `content` are required strings' });
    }
    if (!SAFE_REPO_NAME.test(body.name) || body.name.length > 128) {
      return reply.code(400).send({ error: 'Script name must start with a letter/digit and contain only letters, digits, dots, hyphens, and underscores' });
    }
    const lang = (body.lang as string | undefined) ?? 'bash';
    if (!['bash', 'python', 'sh'].includes(lang)) {
      return reply.code(400).send({ error: '`lang` must be bash | python | sh' });
    }
    try {
      const path = await adapter.saveScript(body.name, body.content, lang as 'bash' | 'python' | 'sh');
      return reply.code(201).send({ path });
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
  });

  // ── Domain-model browser (crew#44) ────────────────────────────────────────
  // Reads the `requirements_graph.json` artifact produced by `wicked-core domain-graph`.
  // Path: `.wicked-estate/requirements/requirements_graph.json` relative to cwd.

  app.get(`${V}/domain-graph`, async (_req, reply) => {
    const path = join(process.cwd(), '.wicked-estate', 'requirements', 'requirements_graph.json');
    try {
      const content = await fsp.readFile(path, 'utf8');
      return { graph: JSON.parse(content) as unknown };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { graph: null };
      return reply.code(500).send({ error: message(err) });
    }
  });

  // ── Per-repo domain graph ─────────────────────────────────────────────────
  // Reads requirements_graph.json from the repo root. Coverage stats come from
  // the live estate store via `wicked-core coverage --json` (not a cached file).

  app.get(`${V}/repos/:id/domain-graph`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    const graphPath = requirementsGraph(repo);
    const dbPath = codeGraphDb(repo);

    // Coverage from the live estate store — computed by wicked-core governance layer.
    let coverage: unknown = null;
    if (existsSync(dbPath)) {
      try {
        const { stdout } = await execCapped(
          process.env['WICKED_CORE_EXE'] ?? 'wicked-core',
          ['coverage', '--db', dbPath, '--json'],
          { timeout: 20_000, cwd: repo.root_path },
        );
        coverage = JSON.parse(stdout) as unknown;
      } catch (err) {
        // The bare `catch {}` here claimed "store not yet indexed" for EVERY failure — a comment
        // asserting a diagnosis the code never checked. An output overflow, a timeout and a missing
        // binary all became a silent null, so the panel showed "no coverage" for reasons that are
        // not the same problem and do not have the same fix (FINDING-016, and FINDING-050's shape:
        // distinct causes collapsed into one outcome).
        //
        // Coverage stays optional — this endpoint must not 500 because the store is not indexed yet,
        // which is a legitimate and common state. But a cause that is NOT that gets said out loud.
        if (err instanceof ExecOutputTooLarge) {
          req.log.warn({ err: err.message }, 'coverage output exceeded the buffer cap');
        } else if (!(err instanceof SyntaxError)) {
          req.log.debug({ err: message(err) }, 'coverage unavailable');
        }
      }
    }

    try {
      const content = await fsp.readFile(graphPath, 'utf8');
      return { graph: JSON.parse(content) as unknown, coverage };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { graph: null, coverage };
      return reply.code(500).send({ error: message(err) });
    }
  });

  // ── Repo code graph (via wicked-estate graph-view) ──────────────────────────
  // Delegates to the estate CLI so the query goes through the proper service
  // layer (store-seam aware, overlay edges included). Postgres-safe.

  // ── Requirements management (server-side search over requirements_graph.json +
  //    operator overrides sidecar; see api/requirements.ts) ─────────────────────
  const ReqQuerySchema = z.object({
    q: z.string().optional(),
    risk: z.enum(['risk', 'no-risk']).optional(),
    category: z.enum(['functional', 'config-data']).optional(),
    domain: z.string().optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).strict();
  app.get(`${V}/repos/:id/requirements`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });
    const parsed = ReqQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid query'));
    }
    const page = await listRequirements(repo, parsed.data);
    if (page === null) {
      return reply.code(404).send({ error: 'requirements_graph.json not generated for this repo yet' });
    }
    // Overrides keyed by ids the corpus no longer mints (an estate id-scheme migration re-keys
    // method/field SymbolIds) would otherwise vanish without a trace — the count is on the page
    // AND in the log, because the operator who edited them is not the one reading the response.
    if ((page.orphanedOverrides ?? 0) > 0) {
      req.log.warn(
        { repo: id, orphanedOverrides: page.orphanedOverrides },
        'requirements_overrides.json holds keys matching no requirement — stale after a re-index/migration; re-run the annotation workflow, then re-apply or delete them',
      );
    }
    return page;
  });

  app.get(`${V}/repos/:id/requirements/:key`, async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });
    let decoded: string;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      return reply.code(400).send({ error: 'Malformed requirement key encoding' });
    }
    const detail = await getRequirement(repo, decoded);
    if (detail === null) return reply.code(404).send({ error: 'Requirement not found' });
    return { requirement: detail };
  });

  const ReqPatchSchema = z
    .object({
      title: z.string().min(1).max(500).optional(),
      notes: z.string().max(5000).optional(),
      status: z.enum(['active', 'deprecated', 'review']).optional(),
      risk: z.boolean().optional(),
    })
    .strict()
    // `.strict()` BEFORE `.refine()`: the refine runs on the parsed object, so with stripping still
    // in effect `{"title":"x","note":"y"}` would pass the non-empty check having silently discarded
    // the edit the caller cared about. Every field here is optional, which is exactly the shape
    // FINDING-031 makes dangerous.
    .refine((b) => Object.keys(b).length > 0, { message: 'empty patch' });
  app.patch(`${V}/repos/:id/requirements/:key`, async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });
    const parsed = ReqPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid patch'));
    }
    let decodedKey: string;
    try {
      decodedKey = decodeURIComponent(key);
    } catch {
      return reply.code(400).send({ error: 'Malformed requirement key encoding' });
    }
    const detail = await patchRequirement(repo, decodedKey, parsed.data);
    if (detail === null) return reply.code(404).send({ error: 'Requirement not found' });
    return { requirement: detail };
  });

  app.get(`${V}/repos/:id/graph`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    const dbPath = codeGraphDb(repo);
    if (!existsSync(dbPath)) {
      return reply.send({ graph: null });
    }

    try {
      const settings = await adapter.getSettings();
      const q = req.query as { focus?: string; limit?: string };
      const parsedLimit = q.limit !== undefined ? Number.parseInt(q.limit, 10) : NaN;
      const nodeLimit = String(
        Number.isFinite(parsedLimit) && parsedLimit > 0 && parsedLimit <= 1000
          ? parsedLimit
          : settings.graphNodeLimit,
      );
      const args = ['graph-view', '--limit', nodeLimit, '--db', dbPath];
      // FOCUS (ego-graph) mode: seed the slice from one symbol and expand its
      // neighbourhood — the navigation primitive (estate graph-view --focus).
      if (q.focus !== undefined && q.focus.trim() !== '') {
        args.push('--focus', q.focus.trim());
      }
      const { stdout } = await execCapped('wicked-estate', args, {
        timeout: 30_000,
        cwd: repo.root_path,
      });
      const raw = JSON.parse(stdout) as {
        nodes: Array<{ id: string; name: string; kind: string; file: string; lang: string; score: number; inDeg: number; outDeg: number }>;
        edges: Array<{ src: string; tgt: string }>;
      };
      const fileCount = new Set(raw.nodes.map((n) => n.file)).size;
      return reply.send({
        graph: {
          nodes: raw.nodes,
          edges: raw.edges,
          stats: { nodeCount: raw.nodes.length, edgeCount: raw.edges.length, fileCount },
        },
      });
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
  });

  // ── Git history (last 20 commits via git log) ─────────────────────────────

  // ── Blast radius for a symbol (via wicked-estate blast-radius --json).
  //    Carries the honesty contract through: dependents PLUS the count of references
  //    no resolver bound (ENGINE-CONTRACT §2.1 — repeat sites of an already-bound
  //    relationship are not counted, so 0 is legitimate for a fully-resolved symbol).
  //    When non-zero, an empty dependents list must never read as "safe to change".
  app.get(`${V}/repos/:id/graph/blast-radius`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { name?: string };
    if (q.name === undefined || q.name.trim() === '') {
      return reply.code(400).send({ error: 'name query parameter required' });
    }
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });
    const dbPath = codeGraphDb(repo);
    if (!existsSync(dbPath)) {
      return reply.code(404).send({ error: 'Code graph not built for this repo yet' });
    }
    try {
      const { stdout } = await execCapped(
        'wicked-estate',
        ['blast-radius', q.name.trim(), '--db', dbPath, '--json'],
        { timeout: 30_000, cwd: repo.root_path },
      );
      return reply.send(JSON.parse(stdout) as unknown);
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
  });

  app.get(`${V}/repos/:id/git-history`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    try {
      const { stdout } = await execCapped(
        'git',
        ['log', '--pretty=format:%H\x1f%h\x1f%s\x1f%an\x1f%ar', '-n', '20'],
        { timeout: 10_000, cwd: repo.root_path },
      );
      const commits = stdout.trim().split('\n').filter(Boolean).map((line) => {
        const parts = line.split('\x1f');
        return {
          sha:      parts[0] ?? '',
          shortSha: parts[1] ?? '',
          message:  parts[2] ?? '',
          author:   parts[3] ?? '',
          date:     parts[4] ?? '',
        };
      });
      return reply.send({ commits });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(500).send({ error: 'git executable not found on server' });
      }
      const msg = message(err);
      if (msg.includes('not a git repository') || msg.includes('does not have any commits')) {
        return reply.send({ commits: [] });
      }
      return reply.code(500).send({ error: msg });
    }
  });

  // ── Git contributors (top 10 by commit count via git shortlog) ─────────────

  app.get(`${V}/repos/:id/contributors`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    try {
      const { stdout } = await execCapped(
        'git',
        ['shortlog', '-sne', '-n', '--no-merges', 'HEAD'],
        { timeout: 10_000, cwd: repo.root_path },
      );
      // Output: "  42\tFull Name <email@example.com>"
      const contributors = stdout.trim().split('\n').filter(Boolean).slice(0, 10).map((line) => {
        const m = line.match(/^\s*(\d+)\s+(.+?)\s+<([^>]+)>/);
        if (!m) return null;
        return { commits: parseInt(m[1] ?? '0', 10), name: m[2] ?? '', email: m[3] ?? '' };
      }).filter((c): c is { commits: number; name: string; email: string } => c !== null);
      return reply.send({ contributors });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(500).send({ error: 'git executable not found on server' });
      }
      const msg = message(err);
      // "ambiguous argument 'HEAD'" means no commits yet; treat as empty list
      if (
        msg.includes('not a git repository') ||
        msg.includes('does not have any commits') ||
        msg.includes("ambiguous argument 'HEAD'") ||
        msg.includes('unknown revision')
      ) {
        return reply.send({ contributors: [] });
      }
      return reply.code(500).send({ error: msg });
    }
  });

  // ── PTY terminal sessions (DES-TERMINAL-001 §6) ────────────────────────────
  // Open a PTY → its id. Drive it over the per-terminal WS `/ws/terminals/:id`;
  // raw output arrives there. `governed` defaults to `true` (the gate-hook-routed
  // default, §7) — an ungoverned operator shell must pass `governed:false` EXPLICITLY.
  app.post(`${V}/terminals`, async (req, reply) => {
    const parsed = OpenTerminalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const b = parsed.data;
    try {
      const id = await adapter.openTerminal(b.cwd, b.cmd, b.cols, b.rows, b.governed ?? true);
      return reply.code(201).send({ id });
    } catch (err) {
      // Core rejects a bad cwd / spawn failure — a client error, not a 500.
      return reply.code(400).send({ error: message(err) });
    }
  });

  // Resize a live terminal's PTY.
  app.post(`${V}/terminals/:id/resize`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ResizeTerminalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    try {
      const status = await adapter.resizeTerminal(id, parsed.data.cols, parsed.data.rows);
      return reply.send({ status });
    } catch (err) {
      // Unknown / already-closed terminal id → 404, not 500.
      return reply.code(404).send({ error: message(err) });
    }
  });

  // Close a live terminal (kill child, join reader). A second close of an
  // already-gone terminal 404s rather than 500s.
  app.post(`${V}/terminals/:id/close`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const status = await adapter.closeTerminal(id);
      return reply.send({ status });
    } catch (err) {
      return reply.code(404).send({ error: message(err) });
    }
  });

  // ── System settings ──────────────────────────────────────────────────────────
  // The store is SHARED with the skin (crew#323): beside the engine's own keys it round-trips
  // the studio's `studio.*` preference blobs verbatim — see `CrewSystemSettings`'s index
  // signature in core/types.ts, which states that rather than leaving it to a client comment.
  app.get(`${V}/settings`, async () => ({ settings: await adapter.getSettings() }));

  app.put(`${V}/settings`, async (req, reply) => {
    const patch = req.body as Partial<import('../core/types.js').CrewSystemSettings>;
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return reply.code(400).send({ error: 'body must be a JSON object' });
    }
    if (Object.hasOwn(patch, 'graphNodeLimit')) {
      const limit = patch.graphNodeLimit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 20 || limit > 500) {
        return reply.code(400).send({ error: 'graphNodeLimit must be an integer between 20 and 500' });
      }
    }
    if (Object.hasOwn(patch, 'worker_config_root')) {
      const root = patch.worker_config_root;
      if (typeof root !== 'string' || (root !== '' && !isAbsolute(root))) {
        return reply.code(400).send({
          error: 'worker_config_root must be an absolute path, or "" for the default (~/.wicked-worker)',
        });
      }
    }
    // workerStallMinutes (crew#287): the stall watchdog's silence threshold. Bounded to a day —
    // a huge value is "off in practice", which should be a deliberate choice, not a typo.
    if (Object.hasOwn(patch, 'workerStallMinutes')) {
      const mins = patch.workerStallMinutes;
      if (typeof mins !== 'number' || !Number.isInteger(mins) || mins < 1 || mins > 1440) {
        return reply
          .code(400)
          .send({ error: 'workerStallMinutes must be an integer between 1 and 1440' });
      }
    }
    // The escalation ladder's knobs (crew#341). This trio lets the PLATFORM touch runs, so a
    // typo must be a 400, never a silently-dropped key that leaves the operator believing they
    // armed (or disarmed) automatic recovery. `workerStallEscalateMinutes: 0` is the explicit
    // OFF spelling — and the shipped default is off (absent).
    if (Object.hasOwn(patch, 'workerStallEscalateMinutes')) {
      const mins = patch.workerStallEscalateMinutes;
      if (typeof mins !== 'number' || !Number.isInteger(mins) || mins < 0 || mins > 1440) {
        return reply.code(400).send({
          error: 'workerStallEscalateMinutes must be an integer between 0 (escalation off) and 1440',
        });
      }
    }
    if (Object.hasOwn(patch, 'workerStallEscalateAction')) {
      const a = patch.workerStallEscalateAction;
      if (a !== 'reassign' && a !== 'notify') {
        return reply
          .code(400)
          .send({ error: "workerStallEscalateAction must be 'reassign' or 'notify'" });
      }
    }
    if (Object.hasOwn(patch, 'workerStallMaxEscalations')) {
      const n = patch.workerStallMaxEscalations;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 10) {
        return reply
          .code(400)
          .send({ error: 'workerStallMaxEscalations must be an integer between 1 and 10' });
      }
    }
    // deliverDefault (crew#393): the repo-scoped launch delivery default. Two values only —
    // this knob decides whether completed code runs open PRs, so a typo must be a 400, never
    // a silently-dropped key that leaves the operator believing they flipped it.
    if (Object.hasOwn(patch, 'deliverDefault')) {
      const d = patch.deliverDefault;
      if (d !== 'pr' && d !== 'none') {
        return reply
          .code(400)
          .send({ error: "deliverDefault must be 'pr' or 'none'" });
      }
    }
    // Skin-owned keys (crew#323): allowed through, but VALIDATED rather than trusted. The
    // daemon does not read these values, so the only two things it can check are the two that
    // can hurt it — a value it cannot persist, and a value big enough to bloat settings.json.
    // Both answer 400 naming the key: silence is exactly what made #323 invisible for a whole
    // campaign of appearance work.
    const studioKeys = Object.keys(patch).filter((k) => STUDIO_SETTINGS_KEY.test(k));
    for (const key of studioKeys) {
      const value = (patch as Record<string, unknown>)[key];
      // `undefined` from a throwing/circular value AND from a value JSON.stringify simply
      // drops (a function, a symbol) — both are unpersistable, both are refused.
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(value);
      } catch {
        encoded = undefined;
      }
      if (encoded === undefined) {
        return reply.code(400).send({ error: `${key} must be a JSON-serializable value` });
      }
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > STUDIO_SETTINGS_MAX_BYTES) {
        return reply.code(400).send({
          error: `${key} is ${bytes} bytes of JSON, over the ${STUDIO_SETTINGS_MAX_BYTES}-byte per-key cap on studio.* settings`,
        });
      }
    }
    // Only known engine keys and validated `studio.*` keys are persisted. A key that is
    // NEITHER is dropped, not refused: request bodies are forward-additive too (DES-STUDIO-001
    // §5.1), so an older daemon meeting a newer client's engine key must not fail the whole
    // patch and take the caller's other keys down with it. The cost is that a typo goes
    // unnoticed on the wire — so the dropped keys are NAMED in the audit entry below.
    const allowed: (keyof import('../core/types.js').CrewSystemSettings)[] = [
      'graphNodeLimit',
      'worker_config_root',
      'workerStallMinutes',
      'workerStallEscalateMinutes',
      'workerStallEscalateAction',
      'workerStallMaxEscalations',
      'deliverDefault',
    ];
    const safe: Partial<import('../core/types.js').CrewSystemSettings> = {};
    for (const key of allowed) {
      // `Object.hasOwn`, NOT `key in patch` (Copilot on #324): `in` walks the prototype chain, so
      // a body whose prototype carries an engine key would be persisted from a value the caller
      // never sent. Not reachable through the default JSON parser — `JSON.parse` yields a plain
      // object and Fastify refuses `__proto__` — but this route already accepts custom
      // content-type parsers, which can produce non-plain objects. Own properties only, and the
      // same spelling the `ignored` filter below uses, so the two can never disagree about what
      // "present" means.
      if (Object.hasOwn(patch, key)) (safe as Record<string, unknown>)[key] = patch[key];
    }
    for (const key of studioKeys) {
      (safe as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
    }
    // `Object.hasOwn`, NOT `k in safe`: `in` walks the prototype chain, so a dropped key named
    // `toString` / `valueOf` / `constructor` would test as "kept" and vanish from `ignored` —
    // the exact silent drop this route exists to end.
    const ignored = Object.keys(patch).filter((k) => !Object.hasOwn(safe, k));
    const settings = await adapter.updateSettings(safe);
    // Re-apply the worker-config root to this process's env (seat sign-in). The engine reads
    // WICKED_WORKER_HOME per worker spawn — never cached — so this alone makes the change live
    // at the next spawn: no daemon restart, no engine restart.
    applyWorkerConfigRoot(settings.worker_config_root);
    // `changed` names every persisted key, engine and `studio.*` alike; `ignored` (present only
    // when there is one) is where a dropped unknown key stops being invisible.
    audit.record('settings.updated', actorOf(req), {
      detail: { changed: Object.keys(safe), ...(ignored.length > 0 ? { ignored } : {}) },
    });
    return { settings };
  });

  // ── Projects (DES-PROJECT-001) — the 9-route experience-plane surface ────────
  registerProjectRoutes(app, adapter, { ...projects, settings: projectSettings }, security);

  // ── Campaigns (crew#342 + TH-9) — the engine's durable Run-DAG scheduler over REST ──────────
  // Progress streams as campaign* CoreEvents on the existing allowlist-free /ws relay; these
  // routes are launch/resume/cancel + the reads a scoreboard builds from. The GET routes join
  // per-member delivery (wicked-studio#27) with the SAME machinery the run DTOs use — one
  // sessionsDetail() per request, the shared TTL-memoized vacuity probes, never a per-node fetch.
  registerCampaignRoutes(app, adapter, {
    audit,
    actorOf,
    roster: () => CoreAdapter.roster(),
    groupIndex,
    deliveryUrlFor: (runId) => deliveryIndex.urlFor(runId),
    vacuity: vacuityProbes,
    // A non-probe derivation throw in the rollup is a defect — error level, loud in diagnostics.
    logDefect: (m) => app.log.error(m),
  });

  // ── Governance wiki management (wiki-mgmt) — scoreboard + honest empty-state meta ──────────
  // Browse (`GET /governance/rules` + facets) and retire (`DELETE /governance/rules/:id`) stay
  // ABOVE with the other governance routes; this registers only the wiki-specific reads.
  // Both wiki reads feed the Steering page header too — they stay, unchanged (STEERING).
  registerGovernanceWikiRoutes(app, adapter);

  // ── Steering management (STEERING program) — batch import + "add with chat" authoring ──────
  // Per-rule CRUD stays ABOVE with the other governance routes (a steering rule IS a
  // conformance rule); this registers only the import batch and the governed authoring launch.
  registerGovernanceSteeringRoutes(app, adapter, {
    audit,
    actorOf,
    roster: () => CoreAdapter.roster(),
  });

  // ── Testing (crew-testing) — governance evals + eval corpora + the recon trigger ────────────
  // Run the evals (does the steering corpus catch what it claims to?) and import a named eval
  // corpus — both presence-gated on the engine's evals bindings (501 on wicked-core-ts < 0.7.5).
  // POST /testing/recon launches governed recon runs (the multiscope fan-out), so it gets the
  // roster and the SAME membership plumbing POST /runs files projectId launches through.
  registerTestingRoutes(app, adapter, {
    audit,
    actorOf,
    roster: () => CoreAdapter.roster(),
    projects: { bus: projects.bus, index: projects.index },
  });

  // ── The wicked-interactive bridge, reverse-proxied (DES-MERGE-001 §5.3/§7.2) ──
  // Mounted BESIDE the routes above and under the same `${V}` prefix, so it inherits one
  // origin, one auth hook, and one CORS posture — the whole point of slice 1.
  // ONE pool, shared with the governed doc-delete route below: two pools over one root would
  // race each other into starting duplicate bridges.
  const interactiveBridges =
    runtime.interactiveBridges ??
    new InteractiveBridgePool({
      log: (m) => app.log.warn(m),
      debug: (m) => app.log.debug(m),
      // #298: the daemon's own origin, read LAZILY off the bound server — the pool is built
      // before `listen`, but only consulted while serving a request, i.e. once bound. The
      // pool POSTs it to the bridge's /api/studio-origin on start/adopt so the bridge's
      // `GET /` redirects into studio.
      studioOrigin: () => boundOrigin(app.server.address()),
    });
  registerInteractiveProxy(app, adapter, {
    settings: projectSettings,
    pool: interactiveBridges,
    log: (m) => app.log.warn(m),
  });

  // ── Governed doc delete (crew#338) — the one door that changes BOTH stores ──
  // `DELETE /projects/:id/interactive/docs/:doc` retires the doc on the bridge AND drops crew's
  // handoff-ledger rows for it (the draft leg keys by document id, so a stale row claims the
  // name forever — studio#119's ghost). One static segment more specific than the proxy's
  // wildcard, so the proxy stays pure transport for everything else.
  registerInteractiveDocDelete(app, adapter, {
    settings: projectSettings,
    pool: interactiveBridges,
    audit,
    actorOf,
    // The inert default mirrors AuditLog.noop(): a directly-driven route set must never sweep
    // the operator's real ~/.wicked-crew ledgers. The real sweep always arrives from
    // `createServer`.
    dropDocLedgerRows: runtime.dropDocLedgerRows ?? (() => ({ ok: true, removed_keys: [] })),
    log: (m) => app.log.warn(m),
  });
}
