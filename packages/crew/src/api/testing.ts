/**
 * The `/api/v1/testing/*` surface (crew-testing) — the wire behind the studio's Testing page:
 * RUN the governance evals (does the steering corpus actually catch the behaviors it claims
 * to?), IMPORT a named eval corpus for later runs, and TRIGGER a campaign recon
 * (`POST /testing/recon` — governed runs over the operator's brief, fanned per repo by the
 * multiscope wire; the evals routes stay STORE-scoped and take no repo/project fields).
 *
 * Thin by design, like `governance-steering.ts`: validation is zod (strict, unknown keys named —
 * the FINDING-031 doctrine); the evals themselves are the ENGINE's (`governanceEvals` pushes
 * every sample through the same decide path enforcement runs, over a read-only connection to
 * the steering store — the daemon computes no verdict of its own), and the report is the
 * engine's serde output passed through VERBATIM (snake_case field names — the pinned crew/studio
 * wire contract; the steering wave shipped a drift because each side guessed, so neither side
 * reshapes it). Corpus import writes through the engine's knowledge seam under the
 * `evals:<name>` scope — the daemon never opens a store itself.
 *
 * Error posture mirrors the steering surface: a build whose engine addon predates the evals
 * bindings answers 501 (`GovernanceEvalsUnsupportedError` — "upgrade the engine"; wicked-core-ts
 * 0.7.5 carries them, 0.7.4 does not), never 400 ("fix your request") — and never a crash: this
 * daemon must serve both routes honestly against the released 0.7.4 addon.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  GovernanceEvalsUnsupportedError,
  ProjectsUnsupportedError,
  type CoreAdapter,
} from '../core/adapter.js';
import type {
  Actor,
  EvalRunPerTypeCount,
  GovernanceEvalReport,
  GovernanceEvalSample,
  LaunchRunInput,
  SteeringType,
} from '../core/types.js';
import type { AuditLog } from './audit.js';
import { recordRunLaunched, type RunTimingIndex } from './run-timing-index.js';
import type { EvalRunStore } from './eval-store.js';
import { API_PREFIX } from './api-prefix.js';
import { STEERING_TYPE_VALUES, STEERING_TYPES } from './governance-steering.js';
import { resolveScopeRepos } from './multiscope.js';
import { buildReconCampaign, RECON_INTAKE_GATE_TOKEN } from '../campaigns/plan.js';
import { eligibleSeatKeys } from '../core/engine-roster.js';
import { QE_AUTHOR_TESTS_WORKFLOW, qeAuthorPlan } from '../qe/author-workflow.js';
import { qeTestsGroupLabel } from '../qe/test-sets.js';
import type { GroupIndex } from './group-index.js';
import { resolveProjectGraphBinding } from '../projects/graph.js';
import { MEMBERSHIP_ATTACHED, membershipAttachedKey } from '../projects/events.js';
import type { ProjectBus } from '../projects/events.js';
import type { MembershipIndex } from '../projects/membership-index.js';

const V = API_PREFIX;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Same unknown-key-naming 400 body builder as api/routes.ts (restated because that module does
 *  not export it and importing routes.ts here would be a cycle through registerRoutes). */
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

// The sample shape is the PINNED wire contract (snake_case, the engine's serde spelling) and
// lives in `eval-sample.js` — ONE module the route, `eval-compare.ts` AND the internal-corpus
// script (`scripts/evals-internal-corpus.mjs`, plain node) all import, so the script can never
// accept a sample this route rejects. Re-exported here because this is the route's public schema
// surface (the wire-contract test reads it from here). The run body's `type` IS closed here,
// because it selects from the same 7-value facet the steering routes already export — one
// spelling, shared.
import { ImportEvalCorpusSchema } from './eval-sample.js';
export { ImportEvalCorpusSchema };

export const RunGovernanceEvalsSchema = z
  .object({
    type: z.enum(STEERING_TYPE_VALUES).optional(),
    corpus: z.string().min(1).optional(),
  })
  .strict();

// The recon trigger's body (the pinned multiscope wire — see api/multiscope.ts): the operator's
// brief verbatim (`problem` — studio composes its own recon framing, this route never rewrites
// caller text) plus the two optional scope fields, plus `ungated` (crew#391): every launched
// sibling pauses at its intake gate BY DEFAULT — the posture the launch banner promises — and
// an unattended fan is an EXPLICIT request, never a silent default. Strict: a misspelled field
// must 400 by name, never launch a recon the caller believed was different (FINDING-031).
export const TestingReconSchema = z
  .object({
    problem: z.string().min(1),
    projectId: z.string().min(1).optional(),
    repoRefs: z
      .array(z.string().min(1))
      .min(1, 'repoRefs must name at least one registered repo — omit the field to scope by project alone')
      .optional(),
    ungated: z.boolean().optional(),
  })
  .strict();

// The test-authoring launch (wave 6, F-7R2-003/004/014 + F-075): the operator's intent + scope,
// launched as the `qe-author-tests` WORKFLOW (never a free-text plan). Same scope fields and the
// same intake-gate default as the recon body; `deliver` is the run's delivery mode — `pr` (the
// default: the ENGINE's deliver phase opens the PR, never a worker) or `none` (leave the tests on
// the run branch, `delivery: 'stranded'` on the wire, liftable post-hoc). Strict (FINDING-031).
export const TestingAuthorSchema = z
  .object({
    problem: z.string().min(1),
    projectId: z.string().min(1).optional(),
    repoRefs: z
      .array(z.string().min(1))
      .min(1, 'repoRefs must name at least one registered repo — omit the field to scope by project alone')
      .optional(),
    ungated: z.boolean().optional(),
    deliver: z.enum(['pr', 'none']).optional(),
  })
  .strict();

export interface TestingRoutesDeps {
  audit: AuditLog;
  actorOf: (req: FastifyRequest & { actor?: Actor }) => Actor;
  /** The default council roster for the recon/author runs (already parsed) — the steering-author
   *  idiom. `registerRoutes` supplies the roster WITH crew's standing (`council_eligible` …), which
   *  the adapter translates into the engine's per-seat `health` at launch (`core/engine-roster.ts`)
   *  and which the author response's `plan.seats` is derived from. */
  roster: () => unknown[];
  /** The launch-time group index (`RunGroup` on `GET /campaigns`) — an author run is filed under
   *  its repo's `qe-tests-<repo>` label so the Test landing sees it from launch (F-7R2-014).
   *  Optional so route-unit tests can omit it; `registerRoutes` always supplies it. */
  groupIndex?: GroupIndex;
  /** The membership plumbing POST /runs uses for projectId filing (index tag + post-commit event).
   *  Optional so route-level unit tests can omit it; `registerRoutes` always supplies it. */
  projects?: { bus: ProjectBus | null; index: MembershipIndex };
  /** The run→launch-time index (home command-center run metrics) — so a recon fan's `run.launched`
   *  entries stamp `created_at` LIVE, not only after a restart re-hydrates the trail (Copilot #466).
   *  Optional so route-unit tests can omit it; `registerRoutes` always supplies it. */
  runTimingIndex?: RunTimingIndex;
  /** The eval RUN history store — every `POST /testing/evals/run` is recorded here (best-effort)
   *  so `GET /testing/evals[/:id]` can serve a real history. Optional so route-level unit tests
   *  that never touch the eval routes can omit it; `registerRoutes` always supplies it. */
  evalStore?: EvalRunStore;
}

/**
 * Derive the per-steering-type rollup from a report's results — the same four counts as the
 * report summary, grouped by `sample.steering_type`, so the Evals dashboard's "which type carries
 * the gaps" view is a stored field rather than a per-request recompute over the full results.
 */
export function perTypeRollup(
  results: GovernanceEvalReport['results'],
): Partial<Record<SteeringType, EvalRunPerTypeCount>> {
  const out: Partial<Record<SteeringType, EvalRunPerTypeCount>> = {};
  for (const r of results) {
    // `sample.steering_type` is an OPEN string on the wire (the engine validates it against its own
    // vocabulary — see the sample-schema comment). Only bucket the 7 known types so `per_type`'s
    // keys stay strictly within `SteeringType` (the api-types contract, `Partial<Record<...>>`); an
    // off-vocabulary type is skipped, not cast in (Copilot #467). It still counts in the engine's
    // `summary`, so per_type totals are "per KNOWN type", which may sum to ≤ summary.total. Reuses
    // the ONE steering-type set (governance-steering.ts) rather than a second membership set.
    if (!STEERING_TYPES.has(r.sample.steering_type)) continue;
    const type = r.sample.steering_type as SteeringType;
    const bucket = (out[type] ??= { total: 0, caught: 0, gaps: 0, false_positives: 0 });
    bucket.total += 1;
    if (r.verdict === 'caught') bucket.caught += 1;
    else if (r.verdict === 'gap') bucket.gaps += 1;
    else if (r.verdict === 'false_positive') bucket.false_positives += 1;
  }
  return out;
}

export function registerTestingRoutes(
  app: FastifyInstance,
  adapter: CoreAdapter,
  deps: TestingRoutesDeps,
): void {
  const { audit, actorOf } = deps;

  // ── Run the governance evals (the Testing page's Run action) ─────────────────
  // Both fields optional — `{}` (or no body at all) means "the built-in default corpus, every
  // steering type". The 200 body is the engine's serde report passed through verbatim
  // (snake_case; `degraded` is `null`, kept in-band, when the run was full-fidelity).
  app.post(
    `${V}/testing/evals/run`,
    {
      config: {
        manifest: {
          requestType: 'RunGovernanceEvalsBody',
          responseType: 'GovernanceEvalReport',
          // 501: the installed engine addon predates the evals bindings (wicked-core-ts < 0.7.5)
          // — upgrade the engine, the request was already correct.
          statusCodes: [200, 400, 500, 501],
        },
      },
    },
    async (req, reply) => {
      // `?? {}`: a bodyless POST is a legal spelling of the all-defaults run.
      const parsed = RunGovernanceEvalsSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid evals run body'));
      }
      try {
        // Passed through verbatim — no reshaping on our side of the seam: the report IS the
        // pinned contract, snake_case and all (`summary.false_positives`, `nearest_rules`).
        // (Spread-rebuilt args: exactOptionalPropertyTypes — an absent key, never `undefined`.)
        const report = await adapter.runGovernanceEvals({
          ...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
          ...(parsed.data.corpus !== undefined ? { corpus: parsed.data.corpus } : {}),
        });
        // Record the run in the eval history (best-effort, LOUD-NON-FATAL): the report is the
        // contract and must answer even if persistence fails, so a store miss is warned and
        // swallowed, never a 500. `rule_store` is the daemon's own steering store the run judged.
        // `degraded` and `rule_coverage` are the ENGINE's readings persisted verbatim — the
        // daemon recomputes neither; `rule_coverage` is spread conditionally because an engine
        // predating core #394 emits none, and an absent key (never a fabricated one) is how a
        // history row says "this run did not measure rule coverage".
        if (deps.evalStore !== undefined) {
          try {
            await deps.evalStore.record({
              actor: actorOf(req).id,
              corpus: parsed.data.corpus ?? null,
              type_filter: parsed.data.type ?? null,
              rule_store: adapter.dbPath,
              summary: report.summary,
              per_type: perTypeRollup(report.results),
              degraded: report.degraded,
              ...(report.rule_coverage !== undefined ? { rule_coverage: report.rule_coverage } : {}),
              results: report.results,
            });
          } catch (persistErr) {
            req.log.warn(`eval run recorded to the report but NOT to history: ${message(persistErr)}`);
          }
        }
        return report;
      } catch (err) {
        if (err instanceof GovernanceEvalsUnsupportedError) {
          return reply.code(501).send({ error: err.message });
        }
        // An engine/store failure is OURS, not the caller's — the body already parsed, so
        // nothing here maps to 400.
        return reply.code(500).send({ error: message(err) });
      }
    },
  );

  // ── The eval RUN history (the Evals section's list + drilldown) ──────────────
  // Read back what the run route records. GLOBAL per daemon — evals judge a store, not a
  // workspace, so there is no repo/project scope (unlike recon campaign runs). `?type=` / `?corpus=`
  // narrow the list to comparable runs. A daemon with no history (or an addon that never recorded
  // one) answers `{ runs: [] }`, never an error — an empty history is a valid state, not a fault.
  app.get(
    `${V}/testing/evals`,
    { config: { manifest: { responseType: 'ListEvalRunsResponse', statusCodes: [200] } } },
    async (req) => {
      if (deps.evalStore === undefined) return { runs: [] };
      const q = req.query as { type?: string; corpus?: string };
      return {
        runs: await deps.evalStore.list({
          ...(q.type !== undefined ? { type_filter: q.type } : {}),
          ...(q.corpus !== undefined ? { corpus: q.corpus } : {}),
        }),
      };
    },
  );

  // One run WITH its full per-sample results — the drilldown behind a history row (the same report
  // the run's original POST returned). 404 when the id is unknown or its detail file is gone.
  app.get(
    `${V}/testing/evals/:id`,
    { config: { manifest: { responseType: 'EvalRunDetail', statusCodes: [200, 404] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const detail = (await deps.evalStore?.get(id)) ?? null;
      if (detail === null) return reply.code(404).send({ error: `no eval run '${id}'` });
      return detail;
    },
  );

  // ── Import a named eval corpus (the Testing page's Import action) ────────────
  // Samples land in the knowledge store under the `evals:<name>` scope — the string a later
  // evals run names as `corpus`. Audited (a write), unlike the run above (compute over the
  // existing stores — the wiki-scoreboard read posture).
  app.post(
    `${V}/testing/corpora/import`,
    {
      config: {
        manifest: {
          requestType: 'ImportEvalCorpusBody',
          responseType: 'ImportEvalCorpusResponse',
          // 501: same presence gate as the run route — the two bindings ship together, and
          // importing a corpus no engine on this host can run would be a trap, not a feature.
          statusCodes: [200, 400, 500, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = ImportEvalCorpusSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid corpus import body'));
      }
      try {
        const result = await adapter.importGovernanceCorpus(
          parsed.data.name,
          parsed.data.samples as GovernanceEvalSample[],
        );
        audit.record('testing.corpus.imported', actorOf(req), {
          detail: {
            name: parsed.data.name,
            samples: parsed.data.samples.length,
            scope: result.scope,
            embedded: result.embedded,
          },
        });
        return result;
      } catch (err) {
        if (err instanceof GovernanceEvalsUnsupportedError) {
          return reply.code(501).send({ error: err.message });
        }
        return reply.code(500).send({ error: message(err) });
      }
    },
  );

  // ── The recon trigger (the Testing page's "run a campaign recon" action) ─────
  // REUSES crew's run machinery end to end (the steering-author precedent): each launch is a
  // plain governed run over the caller's problem statement — free-text planning, standard gates,
  // standard /ws frames. What THIS route adds is the pinned multiscope wire: `repoRefs` and/or
  // `projectId` resolve (fail-closed, api/multiscope.ts) to registered repos, and because one
  // engine run carries ONE repo (`LaunchOptions.repoRef` — wicked-core#179), a multi-repo recon
  // FANS one run per repo. A real fan (≥ 2 repos) registers an ENGINE campaign and files the
  // siblings under it (crew#390 — `GET /campaigns` serves it with real stats); every sibling
  // pauses at its intake gate unless the caller EXPLICITLY sent `ungated: true` (crew#391 — the
  // launch banner's promise is the default, never silently 'none'). Neither scope field ⇒ one
  // unscoped run — the launch the studio ReconPanel sends today, kept backward compatible.
  app.post(
    `${V}/testing/recon`,
    {
      config: {
        manifest: {
          requestType: 'TestingReconBody',
          responseType: 'TestingReconResponse',
          // 404: unknown projectId; 409: archived project / engine busy; 500: a launch failed
          // AFTER earlier fanned runs started (the body names them — nothing is hidden);
          // 501: projectId on an addon without the project bindings.
          statusCodes: [201, 400, 404, 409, 500, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = TestingReconSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid recon body'));
      }
      const b = parsed.data;
      let scope;
      try {
        scope = await resolveScopeRepos(adapter, {
          projectId: b.projectId,
          repoRefs: b.repoRefs,
        });
      } catch (err) {
        if (err instanceof ProjectsUnsupportedError) {
          return reply.code(501).send({ error: err.message });
        }
        return reply.code(500).send({ error: message(err) });
      }
      if (!scope.ok) {
        return reply.code(scope.status).send({ error: scope.error });
      }
      // The shared campaign label every fanned run files under (audit detail + response) — and,
      // for a real fan (≥ 2 repos), the id of the ENGINE campaign it registers (crew#390).
      const campaign = `recon-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      // The gate posture (crew#391): the intake gate per sibling — the exact promise the launch
      // banner makes ("stops at its intake gate; nothing runs until you approve") — unless the
      // caller EXPLICITLY sent `ungated: true`. Never a silent default the banner contradicts.
      const gate = b.ungated === true ? 'none' : RECON_INTAKE_GATE_TOKEN;
      /** The audit-detail fields every launch spelling shares. */
      const gateDetail = { gate, ...(b.ungated === true ? { ungated: true } : {}) };
      /** The post-commit half of the §2.2 filing (the POST /runs idiom): tag future /ws frames
       *  and emit the membership event with the AUTHENTICATED actor id. */
      const fileIntoProject = (runId: string, attachedAt: number): void => {
        if (b.projectId === undefined || deps.projects === undefined) return;
        deps.projects.index.set(runId, b.projectId);
        deps.projects.bus?.emit(
          MEMBERSHIP_ATTACHED,
          {
            project_id: b.projectId,
            member: { kind: 'crew.run', ref: runId },
            actor: actorOf(req).id,
          },
          membershipAttachedKey(b.projectId, 'crew.run', runId, attachedAt),
        );
      };

      // ── A real fan (≥ 2 repos): register the ENGINE campaign and file the runs under it ────
      // (crew#390, option (a)): the fan converges with the campaign-launch path — one durable
      // `CampaignDef` (one agent node per repo, no edges, fan-width concurrency), scheduled and
      // persisted by the engine, so `GET /campaigns` serves it with real per-node stats instead
      // of a label only the audit trail could see. The per-run loop below stays for the
      // single/unscoped recon (today's shape, unchanged) and as the honest fallback on an
      // engine addon without the campaign bindings.
      //
      // Worktrees are the ENGINE's (crew#415): on the ^0.7.8 floor `create_worktree` sanitizes a
      // campaign-shaped run id into a git- and NTFS-legal name and mints the tree at LAUNCH
      // (core#345/#347), so this route neither pre-provisions nor excludes win32 any more. A git
      // refusal therefore fails that NODE — it is no longer a pre-launch abort.
      if (scope.repos.length >= 2 && adapter.campaignsSupported()) {
        const built = buildReconCampaign({
          id: campaign,
          problem: b.problem,
          repos: scope.repos,
          clis: deps.roster(),
          ungated: b.ungated === true,
        });
        try {
          await adapter.launchCampaign(built.def);
        } catch (err) {
          // Nothing launched (the engine validates-then-persists the def as one unit): answer
          // with the campaign-route posture — 409 for a state conflict, else 500 (the def is
          // DAEMON-built from already-validated inputs, so a reject here is ours, not "fix
          // your request").
          const msg = message(err);
          const busy = /already exists|already launched|busy|in flight/i.test(msg);
          return reply.code(busy ? 409 : 500).send({ error: msg });
        }
        audit.record('campaign.launched', actorOf(req), {
          detail: {
            campaignId: campaign,
            nodes: built.def.nodes.length,
            edges: 0,
            policy: built.def.policy,
            maxConcurrency: built.def.max_concurrency,
            recon: true,
            ...gateDetail,
            ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
            repoRefs: scope.repos.map((r) => r.id),
          },
        });
        // Campaign nodes are UNFILED at the engine seam (`RunSpec::to_launch_spec` pins
        // `project_id: None` — filing rides the daemon, per the engine's own doc), so a
        // projectId recon files each sibling here: the membership row via the projects surface,
        // then the same post-commit index/event half `POST /runs` performs. The node run ids
        // are deterministic (`{campaign}:{node}:a0`), so the rows land before any run finishes.
        let projectAttachError: string | undefined;
        for (const [i, runId] of built.runIds.entries()) {
          if (b.projectId !== undefined) {
            try {
              const { member } = await adapter.projectMemberAttach(
                b.projectId,
                'crew.run',
                runId,
                { campaign, recon: true },
                actorOf(req).id,
              );
              fileIntoProject(runId, member.attached_at);
            } catch (err) {
              // The campaign is LIVE — failing the request now would report a launch that
              // happened as one that did not. Name the filing gap instead (the chats-route
              // idiom): the operator can re-attach via POST /projects/:id/members.
              projectAttachError ??= message(err);
              req.log.warn({ runId, projectId: b.projectId }, `recon run filing failed: ${message(err)}`);
            }
          }
          // The same trail entry POST /runs writes — each node IS a run launch this route
          // caused, findable by the same `?action=run.launched` query, grouped by the label — and
          // the shared helper stamps `created_at` from the SAME durable ts (Copilot #466).
          recordRunLaunched(audit, deps.runTimingIndex, actorOf(req), runId, {
            campaign,
            recon: true,
            ...gateDetail,
            repoRef: scope.repos[i]!.id,
            ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
          });
        }
        return reply.code(201).send({
          runId: built.runIds[0]!,
          runIds: built.runIds,
          campaign,
          campaignRegistered: true,
          ...(projectAttachError !== undefined ? { projectAttachError } : {}),
        });
      }

      // ── The per-run path: single repo / unscoped (today's shape), or no campaign bindings ──
      // No scope fields ⇒ one unscoped run (today's recon), spelled as a single null target.
      const targets = scope.repos.length > 0 ? scope.repos : [null];
      const runIds: string[] = [];
      for (const target of targets) {
        const runId = randomUUID();
        const input: LaunchRunInput = {
          problem: b.problem,
          sessionId: runId,
          clisJson: JSON.stringify(deps.roster()),
          // crew#391: the intake gate rides EVERY spelling of the recon launch — the fallback
          // fan and the single run hold the same posture the banner promises.
          humanConfirm: gate,
        };
        if (target !== null) input.repoRef = target.id;
        if (b.projectId !== undefined) {
          // Same filing semantics as POST /runs (DES-PROJECT-001 §2.2): the engine attaches the
          // crew.run membership atomically with the launch; the project graph binding is resolved
          // — never refreshed — per run, and the decision is logged either way.
          input.projectId = b.projectId;
          const decision = await resolveProjectGraphBinding(adapter, b.projectId, target?.id);
          if (decision.binding !== null) input.projectGraph = decision.binding;
          req.log.info(
            { runId, projectId: b.projectId, repoRef: target?.id ?? null },
            `run ${runId}: ${decision.reason}`,
          );
        }
        try {
          await adapter.launchRun(input);
        } catch (err) {
          const msg = message(err);
          if (runIds.length > 0) {
            // Mid-fan failure: earlier runs are LIVE — answering 4xx would tell the caller
            // nothing happened. Name what launched, what failed, and on which repo.
            return reply.code(500).send({
              error:
                `recon fan-out failed on repo '${target?.id ?? '(unscoped)'}' after ` +
                `${runIds.length} run(s) launched: ${msg}`,
              runIds,
              campaign,
              campaignRegistered: false,
            });
          }
          if (err instanceof ProjectsUnsupportedError) {
            return reply.code(501).send({ error: msg });
          }
          const busy = /busy|in flight|already/i.test(msg);
          return reply.code(busy ? 409 : 400).send({ error: msg });
        }
        // The same trail entry POST /runs writes — this IS a run launch, findable by the same
        // `?action=run.launched` query — plus the shared campaign label the fan is grouped by; the
        // shared helper stamps `created_at` from the SAME durable ts (Copilot #466).
        recordRunLaunched(audit, deps.runTimingIndex, actorOf(req), runId, {
          campaign,
          recon: true,
          ...gateDetail,
          ...(target !== null ? { repoRef: target.id } : {}),
          ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
        });
        fileIntoProject(runId, Date.now());
        runIds.push(runId);
      }
      // `runId` (first) is the single-run spelling the ReconPanel's launch already reads;
      // `runIds` is the source of truth (length ≥ 1 always — one entry per fanned repo, in the
      // caller's resolved order; one entry for an unscoped recon). `campaignRegistered: false`
      // says honestly that THIS launch will not appear on GET /campaigns (a single/unscoped
      // recon, or an engine addon without the campaign bindings).
      return reply
        .code(201)
        .send({ runId: runIds[0]!, runIds, campaign, campaignRegistered: false });
    },
  );

  // ── The test-authoring launch (wave 6 — the Testing page's "New test") ────────────────────
  // Launches the `qe-author-tests` WORKFLOW (recon → author → verify → review, the engine's deliver
  // phase appended) over the operator's intent, one governed run per resolved repo — never the
  // free-text planner (F-7R2-003: seven sentence-units, two of them chat replies). A test-authoring
  // run WRITES into a repository, so the scope must resolve to ≥ 1 repo (an unscoped author is a
  // 400 — there is no worktree to author into). Each run: pauses at its intake gate unless the
  // caller EXPLICITLY sent `ungated: true` (the launch banner's promise); delivers via the ENGINE's
  // deliver phase (`deliver: 'pr'` default — F-7R2-004/012: the worker never opens the PR); is filed
  // under the repo's `qe-tests-<repo>` label group so the Test landing shows it from launch
  // (F-7R2-014); and the 201 carries the PLAN the intake gate shows — the def's phases (kind, role,
  // agent/tool, skill, gate) plus the engine's deliver phase, and the seats the council may pick
  // from (F-7R2-008). Multi-repo scopes fan one run per repo (each repo gets its own PR), grouped
  // per repo — NOT an engine campaign: campaign nodes are engine-launched and would not receive the
  // crew-side deliver composition, so the per-run path is the one that delivers.
  app.post(
    `${V}/testing/author`,
    {
      config: {
        manifest: {
          requestType: 'TestingAuthorBody',
          responseType: 'TestingAuthorResponse',
          // 400: zod reject / no repo in scope; 404: unknown projectId; 409: archived project /
          // engine busy; 500: a launch failed AFTER earlier fanned runs started (named) or the
          // daemon cannot serve its own workflow; 501: projectId on an addon without projects.
          statusCodes: [201, 400, 404, 409, 500, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = TestingAuthorSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid author body'));
      }
      const b = parsed.data;
      // NARROWED project scope (studio #263 review, F-4): with BOTH fields, `repoRefs` is the
      // SCOPE and `projectId` is the FILING — unlike the recon body, where both are unioned. The
      // studio's project-scoped "New test" with repo chips would otherwise have to fan one
      // `POST /runs` per repo itself (one deliver/PR per run); here it names the repos and the
      // project once, and the runs are filed into the project without inheriting its other members.
      const narrowed = b.projectId !== undefined && b.repoRefs !== undefined;
      let scope;
      try {
        scope = await resolveScopeRepos(
          adapter,
          narrowed ? { repoRefs: b.repoRefs } : { projectId: b.projectId, repoRefs: b.repoRefs },
        );
        if (narrowed && scope.ok) {
          // The filing project must be real and active — validated here since the resolver did not
          // walk it (the same refusals the union path gives, by name).
          if (b.projectId === 'default') {
            return reply.code(400).send({
              error: "projectId: 'default' is the synthesized unfiled container — runs cannot be filed into it; omit projectId",
            });
          }
          const project = await adapter.projectGet(b.projectId!);
          if (project === null) return reply.code(404).send({ error: `unknown project: ${b.projectId}` });
          if (project.status === 'archived') {
            return reply.code(409).send({
              error: `project '${b.projectId}' is archived — restore it (PATCH /api/v1/projects/${b.projectId} with status "active") before filing runs into it`,
            });
          }
        }
      } catch (err) {
        if (err instanceof ProjectsUnsupportedError) return reply.code(501).send({ error: err.message });
        return reply.code(500).send({ error: message(err) });
      }
      if (!scope.ok) return reply.code(scope.status).send({ error: scope.error });
      if (scope.repos.length === 0) {
        return reply.code(400).send({
          error:
            'a test-authoring run writes tests into a repository: name at least one registered repo ' +
            '(`repoRefs`) or a project with crew.repo members (`projectId`)',
        });
      }
      const def = adapter.getWorkflow(QE_AUTHOR_TESTS_WORKFLOW);
      if (def === null) {
        // A daemon defect, never the caller's: the def ships in BUILTIN_WORKFLOWS.
        return reply.code(500).send({
          error: `the daemon does not serve the '${QE_AUTHOR_TESTS_WORKFLOW}' workflow — GET /workflows lists what it serves`,
        });
      }
      const gate = b.ungated === true ? 'none' : RECON_INTAKE_GATE_TOKEN;
      const deliver: 'pr' | 'none' = b.deliver ?? 'pr';
      const roster = deps.roster();
      const clisJson = JSON.stringify(roster);
      const plan = qeAuthorPlan(def, eligibleSeatKeys(roster), deliver === 'pr');
      /** The post-commit half of the §2.2 filing (the POST /runs idiom). */
      const fileIntoProject = (runId: string, attachedAt: number): void => {
        if (b.projectId === undefined || deps.projects === undefined) return;
        deps.projects.index.set(runId, b.projectId);
        deps.projects.bus?.emit(
          MEMBERSHIP_ATTACHED,
          { project_id: b.projectId, member: { kind: 'crew.run', ref: runId }, actor: actorOf(req).id },
          membershipAttachedKey(b.projectId, 'crew.run', runId, attachedAt),
        );
      };
      const runs: Array<{ runId: string; repoRef: string; label: string }> = [];
      for (const repo of scope.repos) {
        const runId = randomUUID();
        const label = qeTestsGroupLabel(repo.name);
        const input: LaunchRunInput = {
          problem: b.problem,
          sessionId: runId,
          clisJson,
          humanConfirm: gate,
          repoRef: repo.id,
          workflow: QE_AUTHOR_TESTS_WORKFLOW,
          ...(deliver === 'pr' ? { deliver: 'pr' as const } : {}),
        };
        if (b.projectId !== undefined) {
          input.projectId = b.projectId;
          const decision = await resolveProjectGraphBinding(adapter, b.projectId, repo.id);
          if (decision.binding !== null) input.projectGraph = decision.binding;
          req.log.info({ runId, projectId: b.projectId, repoRef: repo.id }, `run ${runId}: ${decision.reason}`);
        }
        try {
          await adapter.launchRun(input);
        } catch (err) {
          const msg = message(err);
          if (runs.length > 0) {
            return reply.code(500).send({
              error:
                `test-authoring fan-out failed on repo '${repo.id}' after ${runs.length} run(s) launched: ${msg}`,
              runIds: runs.map((r) => r.runId),
              workflow: QE_AUTHOR_TESTS_WORKFLOW,
            });
          }
          if (err instanceof ProjectsUnsupportedError) return reply.code(501).send({ error: msg });
          const busy = /busy|in flight|already/i.test(msg);
          return reply.code(busy ? 409 : 400).send({ error: msg });
        }
        // The same trail entry POST /runs writes — the durable record of the workflow, the RESOLVED
        // delivery decision, and the group attach the index (and a restart's hydrate) reads back.
        recordRunLaunched(audit, deps.runTimingIndex, actorOf(req), runId, {
          workflow: QE_AUTHOR_TESTS_WORKFLOW,
          repoRef: repo.id,
          deliver,
          groupLabel: label,
          author: true,
          gate,
          ...(b.ungated === true ? { ungated: true } : {}),
          ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
        });
        deps.groupIndex?.set(runId, { label });
        fileIntoProject(runId, Date.now());
        runs.push({ runId, repoRef: repo.id, label });
      }
      return reply.code(201).send({
        runId: runs[0]!.runId,
        runIds: runs.map((r) => r.runId),
        workflow: QE_AUTHOR_TESTS_WORKFLOW,
        runs,
        gate: gate === 'none' ? 'none' : 'before:1',
        deliver,
        plan,
        // How the repos were chosen: the named `repoRefs` (a project, when given, is the filing
        // only), else the project's repo members.
        scope: b.repoRefs !== undefined ? 'repoRefs' : 'project',
        campaignRegistered: false,
      });
    },
  );
}
