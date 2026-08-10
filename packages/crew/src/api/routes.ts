import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listRequirements, getRequirement, patchRequirement } from './requirements.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatUnsupportedError, CoreAdapter, ElicitationUnsupportedError, humanGatePhaseIds } from '../core/adapter.js';
import { codeGraphDb, requirementsGraph } from '../core/repoPaths.js';
import type { GateCache } from './gate-cache.js';
import type { ElicitationCache } from './elicitation-cache.js';
import { buildEvidenceBundle, coreUnitId, evidenceFilename } from './evidence.js';
import { outputUnavailableReason, resolveUnit, unitKeysFor } from './unit-output.js';
import type { LaunchRunInput, SessionStatus, SessionView } from '../core/types.js';
import { execCapped, ExecOutputTooLarge } from '../core/exec.js';
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
const LaunchSchema = z.object({
  problem: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  clisJson: z.string().min(1).optional(),
  entityMode: z.enum(['shared', 'isolated']).optional(),
  humanConfirm: z.string().min(1).optional(),
  repoRef: z.string().min(1).optional(),
  workflow: z.string().min(1).optional(),
}).strict();

const GateSchema = z.object({
  approve: z.boolean(),
  amend: z.string().optional(),
}).strict();

const InjectSchema = z.object({
  message: z.string().min(1),
  /** `"all"` broadcasts to every active worker; any other value is a CLI key. */
  target: z.string().min(1).default('all'),
}).strict();

const OpenTerminalSchema = z.object({
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

/**
 * The daemon REST surface. Every endpoint is a thin wrapper over one adapter /
 * core-ts call (DES-STUDIO-001 §2). `session`/`phase` nouns are now `run`/`unit`.
 */
export function registerRoutes(
  app: FastifyInstance,
  adapter: CoreAdapter,
  gateCache: GateCache,
  elicitationCache: ElicitationCache,
): void {
  // Liveness — also proves the actor + event pump are up.
  app.get(`${V}/health`, async () => {
    const ping = await adapter.ping();
    return { status: 'ok', version: PKG_VERSION, ping };
  });

  // Report the actually-bound port/host (honours --port / CREW_PORT / port 0).
  app.get(`${V}/config`, async () => {
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 7701;
    const host = typeof addr === 'object' && addr ? addr.address : '127.0.0.1';
    return { port, host };
  });

  // The council seats for the launch form (static production roster).
  app.get(`${V}/roster`, async () => ({ roster: CoreAdapter.roster() }));

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
  app.post(`${V}/runs`, async (req, reply) => {
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
    try {
      const runId = await adapter.launchRun(input);
      return reply.code(201).send({ runId });
    } catch (err) {
      const msg = message(err);
      const busy = /busy|in flight|already/i.test(msg);
      return reply.code(busy ? 409 : 400).send({ error: msg });
    }
  });

  // Run list (replaces GET /sessions). Actionable-first; reconciles the gate and elicitation caches
  // so that terminal-run entries are pruned even when their terminal CoreEvent was missed.
  app.get(`${V}/runs`, async () => {
    const views = await adapter.sessionsDetail();
    gateCache.reconcile(views);
    elicitationCache.reconcile(views);
    return { runs: sortActionableFirst(views) };
  });

  // One run's detail.
  app.get(`${V}/runs/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    return { run };
  });

  // ── Chat sessions (crew#165): warm ACP seat pool + group fan-out (core#134) ──
  // A chat is NOT a run: no council, no gates, no units. Seats warm on open;
  // messages fan out to warm seats; replies stream on /ws as chatDelta/chatReply.
  const ChatOpenSchema = z.object({
    chatId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
    clis: z.array(z.string().min(1)).min(1).max(8).optional(),
    repoRef: z.string().optional(),
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
    const clis =
      b.clis ??
      (CoreAdapter.roster() as { key?: string }[])
        .map((s) => s.key)
        .filter((k): k is string => typeof k === 'string');
    try {
      const seats = await adapter.chatOpen(chatId, clis, cwd);
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

  // The steering gate (§11.1). approve+amend = approve-with-steer; approve:false = reject (cancels).
  app.post(`${V}/runs/:id/gate`, async (req, reply) => {
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
    try {
      const status = await adapter.confirmGate(id, parsed.data.approve, parsed.data.amend);
      return reply.send({ status });
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
    try {
      const status =
        run.session.status === 'awaiting_human'
          ? await adapter.confirmGate(id, true)
          : await adapter.resumeRun(id);
      return reply.send({ status });
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

  app.get(`${V}/governance/policies`, async () => {
    const policies = await adapter.listPolicies();
    return { policies };
  });

  app.get(`${V}/governance/rules`, async () => {
    const rules = await adapter.listConformanceRules();
    return { rules };
  });

  app.get(`${V}/governance/claims`, async () => {
    const claims = await adapter.listConformanceClaims();
    return { claims };
  });

  app.get(`${V}/governance/coverage`, async (req, reply) => {
    // FINDING-009: with `?repo=<ref>`, report coverage over THAT repo's own code graph. The bare
    // endpoint reads the daemon store and reports a vacuous `coverage: 1.0` that names no repo — the
    // real gate lives per-repo. An unknown repo is an ERROR in core (never a silent vacuous report),
    // surfaced here as 404 rather than a misleading success.
    // Fastify parses a repeated `?repo=a&repo=b` into a `string[]`; take the first so `.trim()`
    // never throws on an array (Copilot review). A single value stays a string; absent stays undefined.
    const rawRepo = (req.query as { repo?: string | string[] } | undefined)?.repo;
    const repo = Array.isArray(rawRepo) ? rawRepo[0] : rawRepo;
    if (repo && repo.trim()) {
      try {
        const report = await adapter.getCoverageReportForRepo(repo);
        return { report };
      } catch (err) {
        return reply.code(404).send({ error: message(err) });
      }
    }
    const report = await adapter.getCoverageReport();
    return { report };
  });

  app.get(`${V}/governance/graph`, async (req, reply) => {
    // #122: node-count-by-kind summary of a repo's OWN code graph. Repo-scoped ONLY — there is no
    // meaningful daemon-wide graph view (the daemon store holds run/governance nodes, not a repo's
    // code graph), so a missing `?repo=` is a 400 and an unknown repo a 404 (core rejects it, never
    // a silent empty summary). Array-query normalized like the coverage route.
    const rawRepo = (req.query as { repo?: string | string[] } | undefined)?.repo;
    const repo = Array.isArray(rawRepo) ? rawRepo[0] : rawRepo;
    if (!repo || !repo.trim()) {
      return reply.code(400).send({ error: 'governance/graph requires a ?repo=<ref>' });
    }
    try {
      const kinds = await adapter.getGraphKindsForRepo(repo);
      return { kinds };
    } catch (err) {
      return reply.code(404).send({ error: message(err) });
    }
  });

  // ── Governance writes (crew#42) ────────────────────────────────────────────

  app.post(`${V}/governance/policies`, async (req, reply) => {
    try {
      await adapter.upsertPolicy(req.body as import('../core/types.js').GovernancePolicy);
      return { status: 'ok' };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.post(`${V}/governance/rules`, async (req, reply) => {
    try {
      await adapter.upsertConformanceRule(req.body as import('../core/types.js').ConformanceRule);
      return { status: 'ok' };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  // Retire, not delete. The record survives so past decisions citing it stay explicable; it just
  // stops being enforced (FINDING-038 — a mis-authored policy otherwise denied forever).
  app.delete(`${V}/governance/policies/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const existed = await adapter.retirePolicy(id);
      if (!existed) return reply.code(404).send({ error: `policy '${id}' not found` });
      return { status: 'retired', id };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.delete(`${V}/governance/rules/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const existed = await adapter.retireConformanceRule(id);
      if (!existed) return reply.code(404).send({ error: `conformance rule '${id}' not found` });
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
  //    Carries the honesty contract through: dependents PLUS the unresolved-call
  //    count — an empty dependents list must never read as "safe to change".
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
  app.get(`${V}/settings`, async () => ({ settings: await adapter.getSettings() }));

  app.put(`${V}/settings`, async (req, reply) => {
    const patch = req.body as Partial<import('../core/types.js').SystemSettings>;
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return reply.code(400).send({ error: 'body must be a JSON object' });
    }
    if ('graphNodeLimit' in patch) {
      const limit = patch.graphNodeLimit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 20 || limit > 500) {
        return reply.code(400).send({ error: 'graphNodeLimit must be an integer between 20 and 500' });
      }
    }
    // Only allow known keys through.
    const allowed: (keyof import('../core/types.js').SystemSettings)[] = ['graphNodeLimit'];
    const safe: Partial<import('../core/types.js').SystemSettings> = {};
    for (const key of allowed) {
      if (key in patch) (safe as Record<string, unknown>)[key] = patch[key];
    }
    return { settings: await adapter.updateSettings(safe) };
  });
}
