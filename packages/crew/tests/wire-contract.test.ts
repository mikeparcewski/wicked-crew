// Drift guard for the published wire contract (task #84).
//
// `wicked-crew-api-types` is the ONE definition of every shape that crosses the daemon's
// HTTP/WS boundary; the studio compiles against it and so must the daemon. This file makes
// that a checked fact rather than a convention: each `respondsWith` / `accepts` call below
// is a COMPILE-TIME assertion, enforced by `tsc --noEmit -p tsconfig.test.json` (part of
// `npm run typecheck`, which CI runs on every PR). If the daemon's produced types stop
// satisfying the contract — or the contract narrows past what the route schemas accept —
// this file stops compiling, and the break is caught where it happened instead of at
// runtime in a browser.
//
// Why assignability and not equality: the daemon is allowed to KNOW MORE than the contract
// (extra fields are forward-additive by design, DES-STUDIO-001 §5.1). What it must never do
// is produce something the contract's consumers cannot read, or reject something the
// contract told them they may send.
//
// The runtime `it` blocks are deliberately thin — vitest (esbuild) does not typecheck, so
// the teeth of this suite are in the typecheck step; the tests exist so the guard is
// visible in the test run and so a human deleting the typecheck wiring still sees this
// file named somewhere.

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type * as Wire from 'wicked-crew-api-types';
import type { CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { GateCacheEntry } from '../src/api/gate-cache.js';
import type { ElicitationEntry } from '../src/api/elicitation-cache.js';
import type { RequirementDetail, RequirementsPage } from '../src/api/requirements.js';
import type { GateSchema, GuidanceSchema, LaunchSchema, OpenPathSchema, OpenTerminalSchema, RetireMemorySchema } from '../src/api/routes.js';
import type { SteeringAuthorSchema, SteeringImportSchema } from '../src/api/governance-steering.js';
import type {
  ImportEvalCorpusSchema,
  RunGovernanceEvalsSchema,
  TestingReconSchema,
} from '../src/api/testing.js';
import type { LaunchCampaignSchema } from '../src/campaigns/routes.js';
import type {
  AddSkillSchema,
  PutSkillFileSchema,
  ReplaceSkillSchema,
  SkillRevisionSchema,
} from '../src/api/skills.js';
import type { SkillsStore, SnapshotManifest } from '../src/skills/store.js';
import type { CappedFileRead, WorktreeDiff } from '../src/api/run-files.js';
import type { DeliveryState } from '../src/api/delivery-index.js';
import type { AcpCliFold, RecentError, StoreFileEntry } from '../src/api/diagnostics.js';
import type { LOCAL_ACTOR } from '../src/api/auth.js';
import type { AuditLog } from '../src/api/audit.js';
import type {
  AttachMemberSchema,
  CreateProjectSchema,
  RefreshProjectGraphSchema,
  UpdateProjectSchema,
} from '../src/projects/routes.js';
import type { DEFAULT_SETTINGS, DEFAULT_SKILLS_MIRROR } from '../src/core/types.js';

/** Compile-time: what the daemon PRODUCES must satisfy what the contract PUBLISHES. */
function respondsWith<Contract, Produced extends Contract>(): Produced | void {
  /* the assertion is the `extends` constraint; nothing to do at runtime */
}

/** Compile-time: every body the contract lets a client SEND must be accepted by the route schema. */
function accepts<SchemaInput, ContractBody extends SchemaInput>(): ContractBody | void {
  /* the assertion is the `extends` constraint; nothing to do at runtime */
}

// ── Response direction: daemon → client ────────────────────────────────────────

// GET /runs and GET /runs/:id — the run list / run detail payloads.
respondsWith<Wire.SessionView[], Awaited<ReturnType<CoreAdapter['sessionsDetail']>>>();

// CREW-UX-2/3 (api-types 0.8.0) — the run-DTO joins the routes decorate at assembly. Both
// directions of each pin so the contract's spelling of the field cannot drift: `project_id`
// is `string | null` when a 0.8.0 server answers (null = genuinely unfiled) and absent only
// on older servers; `retry_of` / `retryOf` are `string` or ABSENT — `null` is not a legal
// spelling of "not a retry" and adding it to the contract must break this file.
respondsWith<Wire.AgentSession['project_id'], string | null | undefined>();
respondsWith<string | null | undefined, Wire.AgentSession['project_id']>();
respondsWith<Wire.AgentSession['retry_of'], string | undefined>();
respondsWith<string | undefined, Wire.AgentSession['retry_of']>();
respondsWith<Wire.LaunchRunBody['retryOf'], string | undefined>();
respondsWith<string | undefined, Wire.LaunchRunBody['retryOf']>();

// CREW-UX-7 (api-types 0.9.0) — durable operator guidance on the run DTO: `string` or ABSENT,
// never `null` (absence spells "no note", covering never-set, cleared, and pre-0.9.0 servers).
respondsWith<Wire.AgentSession['guidance'], string | undefined>();
respondsWith<string | undefined, Wire.AgentSession['guidance']>();

// crew#393 + crew#311 (api-types 0.18.0) — the delivery derivation the routes stamp on every
// served run must produce exactly the contract's union (both directions, so adding or dropping
// a state on either side breaks this file), and the terminal-resume 409 body must satisfy the
// published `ResumeRefusal`.
respondsWith<Wire.AgentSession['delivery'], DeliveryState['delivery']>();
respondsWith<DeliveryState['delivery'] | undefined, Wire.AgentSession['delivery']>();
respondsWith<Wire.ResumeRefusal, { error: string; recovery: 'retry' | 'deliver' }>();

// wicked-studio#27 (api-types 0.19.0) — the ad-hoc grouping surface. Request: `campaignId` /
// `groupLabel` are `string` or ABSENT; response: the run DTO echoes them as `campaign_id` /
// `group_label` (`string` or ABSENT — `null` is not a legal spelling of "ungrouped"), and the
// campaigns rollup fields reuse the run wire's own delivery union (both directions, so a state
// added or dropped on either side breaks this file).
respondsWith<Wire.LaunchRunBody['campaignId'], string | undefined>();
respondsWith<string | undefined, Wire.LaunchRunBody['campaignId']>();
respondsWith<Wire.LaunchRunBody['groupLabel'], string | undefined>();
respondsWith<string | undefined, Wire.LaunchRunBody['groupLabel']>();
respondsWith<Wire.AgentSession['campaign_id'], string | undefined>();
respondsWith<string | undefined, Wire.AgentSession['campaign_id']>();
respondsWith<Wire.AgentSession['group_label'], string | undefined>();
respondsWith<string | undefined, Wire.AgentSession['group_label']>();
respondsWith<Wire.CampaignNodeDelivery['delivery'], DeliveryState['delivery']>();
respondsWith<DeliveryState['delivery'], Wire.CampaignNodeDelivery['delivery']>();
respondsWith<
  Wire.AttachedRunView,
  { runId: string; status: Wire.SessionStatus; delivery: DeliveryState['delivery']; deliverUrl?: string }
>();
respondsWith<Wire.CampaignsListResponse, { campaigns: Wire.Campaign[]; groups: Wire.RunGroup[] }>();
// PUT /runs/:id/guidance — the route echoes what it stored.
respondsWith<Wire.SetGuidanceResult, { runId: string; guidance: string }>();

// GET /runs/:id/events — durable event-log replay (RecordedEvent narrows CoreEvent).
respondsWith<Wire.CoreEvent[] | null, Awaited<ReturnType<CoreAdapter['runEvents']>>>();
respondsWith<Wire.RecordedEvent[] | null, Awaited<ReturnType<CoreAdapter['runEvents']>>>();

// /ws unitOutputDelta (api-types 0.5.1) — the live streamed-output delta frame. The daemon fans
// CoreEvent frames out verbatim, so every field of the discriminated interface must satisfy the
// permissive CoreEvent the relay and the studio's event switches are typed against (its `text`
// chunk rides the named optional field, not just the index signature). The mapped-type spelling
// is LOAD-BEARING, not style: `CoreEvent` carries an explicit `[k: string]: unknown` index
// signature, and TypeScript rejects assigning an interface to an index-signature type
// (`respondsWith<Wire.CoreEvent, Wire.UnitOutputDeltaEvent>()` fails with TS2344 "Type
// 'UnitOutputDeltaEvent' does not satisfy the constraint 'CoreEvent'") because only anonymous
// object types — the mapped copy is one — are treated as having an inferable index signature.
// The mapped copy keeps the exact field set, so the check stays field-by-field. Runtime half:
// tests/ws-relay-passthrough.test.ts proves the frame reaches a WS client unmodified.
respondsWith<Wire.CoreEvent, { [K in keyof Wire.UnitOutputDeltaEvent]: Wire.UnitOutputDeltaEvent[K] }>();

// GET /runs/:id/gate — the route spreads the cache entry over `{ runId }`.
respondsWith<Wire.GateInfo, { runId: string } & GateCacheEntry>();

// GET /runs/:id/elicitation — the cache entry IS the response body.
respondsWith<Wire.ElicitationInfo, ElicitationEntry>();

// GET /repos — registered repositories.
respondsWith<Wire.RepoEntry[], Awaited<ReturnType<CoreAdapter['listRepos']>>>();

// GET /roster — every seat carries its runtime health (crew#274) and its sign-in presence
// (seat sign-in, api-types 0.5.0); the produced entry is the seat verbatim — which is what
// lets the engine's `login_invocation` ride through — plus REQUIRED health and signed_in
// fields, which must satisfy the contract's optional ones.
respondsWith<
  { roster: Wire.RosterSeat[] },
  {
    roster: (Wire.RosterSeat & {
      health: Wire.SeatHealth;
      signed_in: boolean | null;
      login_invocation?: string;
    })[];
  }
>();

// GET /workflows — built-ins (drop-ins are parsed into the same type).
respondsWith<Wire.WorkflowDef[], typeof BUILTIN_WORKFLOWS>();

// Governance reads (crew#40/41/43).
respondsWith<Wire.GovernancePolicy[], Awaited<ReturnType<CoreAdapter['listPolicies']>>>();
respondsWith<Wire.ConformanceRule[], Awaited<ReturnType<CoreAdapter['listConformanceRules']>>>();
respondsWith<Wire.GovernanceClaim[], Awaited<ReturnType<CoreAdapter['listConformanceClaims']>>>();
respondsWith<Wire.CoverageReport | null, Awaited<ReturnType<CoreAdapter['getCoverageReport']>>>();
respondsWith<Wire.GraphKind[], Awaited<ReturnType<CoreAdapter['getGraphKindsForRepo']>>>();

// Steering (STEERING program): the unified steering-rule fields ride the ConformanceRule pin
// above; these pin the import surface's produced results and the boolean presence gate.
respondsWith<Wire.SteeringImportResult[], Awaited<ReturnType<CoreAdapter['importSteeringRules']>>>();
respondsWith<
  Wire.SteeringImportResponse,
  { results: Wire.SteeringImportResult[]; imported: number; rejected: number }
>();
respondsWith<boolean, ReturnType<CoreAdapter['steeringSupported']>>();

// The steering-author landing (crew#388): the `landing` field POST /runs/:id/gate (and a gated
// /resume) produces on approve of a propose gate must satisfy the published shape.
respondsWith<Wire.SteeringLandingResult, Awaited<ReturnType<typeof import('../src/api/steering-landing.js').landSteeringProposal>>>();

// Testing (crew-testing): POST /testing/evals/run + /testing/corpora/import — the report and
// the import receipt are the ENGINE's serde output passed through verbatim (snake_case), so
// what the adapter parses out of the addon must satisfy the published shapes; the boolean is
// the presence gate the 501 posture hangs off (core-ts ≥ 0.7.5).
respondsWith<Wire.GovernanceEvalReport, Awaited<ReturnType<CoreAdapter['runGovernanceEvals']>>>();
respondsWith<
  Wire.ImportEvalCorpusResponse,
  Awaited<ReturnType<CoreAdapter['importGovernanceCorpus']>>
>();
respondsWith<boolean, ReturnType<CoreAdapter['governanceEvalsSupported']>>();

// Eval-run history (api-types 0.27.0, the #394/#395 companion): what the EvalRunStore records and
// GET /testing/evals[/:id] serves must satisfy the published rows — INCLUDING `rule_coverage`
// riding the summary row optionally (an engine predating core #394 emits none, and the row must
// still validate without it), and the report's own optional `rule_coverage`. The `accepts` pins
// below say the OPPOSITE direction holds too: a report WITH coverage and a report WITHOUT it are
// both legal engine outputs the store's record input must take verbatim.
respondsWith<Wire.EvalRunSummary, Awaited<ReturnType<import('../src/api/eval-store.js').EvalRunStore['record']>>>();
respondsWith<Wire.EvalRunDetail, NonNullable<Awaited<ReturnType<import('../src/api/eval-store.js').EvalRunStore['get']>>>>();
respondsWith<Wire.ListEvalRunsResponse, { runs: Wire.EvalRunSummary[] }>();
// An OLDER engine's report — predating core #394, no `rule_coverage` at all — validates.
accepts<
  Wire.GovernanceEvalReport,
  { results: Wire.GovernanceEvalResult[]; summary: Wire.GovernanceEvalSummary; degraded: 'facet-only' | null }
>();
// The engine's COMPLETE report (api-types 0.27.0 — codex round 7 on #475): the fixture is the JSON
// wicked-core's own pinned-shape test asserts `rules eval --json` serializes (evals.rs
// `report_wire_shape_is_the_pinned_snake_case_contract`, branch `feat/evals-effect-and-coverage` @
// a87e461 lines 1520-1585: `sample()` at 1142-1163 spells the description) — every report field,
// all four `rule_coverage` fields, all seven `per_type` keys. `as const` is avoided so the arrays
// stay mutable like the parsed JSON; the literal unions are pinned where the contract narrows them.
const ENGINE_REPORT_WITH_COVERAGE = {
  results: [
    {
      sample: { id: 'dev-force-push', description: 'description of dev-force-push', kind: 'bad' as const, steering_type: 'development' },
      expected: 'deny' as const,
      fired: ['GOV-FORCE-PUSH'],
      verdict: 'caught' as const,
    },
    {
      sample: { id: 'sec-hardcoded', description: 'description of sec-hardcoded', kind: 'bad' as const, steering_type: 'security' },
      expected: 'deny' as const,
      fired: [] as string[],
      verdict: 'gap' as const,
      nearest_rules: [] as Wire.GovernanceEvalNearestRule[],
    },
  ],
  summary: { total: 2, caught: 1, gaps: 1, false_positives: 0 },
  degraded: 'facet-only' as const,
  rule_coverage: {
    exercised: 1,
    unexercised: [] as Wire.GovernanceEvalUnexercisedRule[],
    recall_only: 0,
    per_type: {
      architecture: { exercised: 0, unexercised: 0 },
      compliance: { exercised: 0, unexercised: 0 },
      'design-ux': { exercised: 0, unexercised: 0 },
      development: { exercised: 0, unexercised: 0 },
      operations: { exercised: 0, unexercised: 0 },
      security: { exercised: 1, unexercised: 0 },
      testing: { exercised: 0, unexercised: 0 },
    },
  },
};
accepts<Wire.GovernanceEvalReport, typeof ENGINE_REPORT_WITH_COVERAGE>();
// … and the declaration covers EXACTLY the producer's coverage fields — a field the engine
// serializes that the contract does not declare, or a declared field the engine never emits, stops
// this file compiling (both directions of every key set; `keyof` includes optional keys).
accepts<keyof Wire.GovernanceEvalRuleCoverage, keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage>();
accepts<keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage, keyof Wire.GovernanceEvalRuleCoverage>();
accepts<keyof Wire.GovernanceEvalTypeCoverage, keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage.per_type.security>();
accepts<keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage.per_type.security, keyof Wire.GovernanceEvalTypeCoverage>();
accepts<Wire.SteeringType, keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage.per_type>();
accepts<keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage.per_type, Wire.SteeringType>();
accepts<Wire.GovernanceEvalRuleCoverage['per_type'], Record<Wire.SteeringType, Wire.GovernanceEvalTypeCoverage> | undefined>();
// A stored record whose coverage carries only the two REQUIRED fields still validates: the daemon
// persists `rule_coverage` verbatim and validates none of it, so `recall_only` / `per_type` are
// optional on the contract — a consumer reads their absence as "no per-type coverage", never zeros.
accepts<
  Wire.GovernanceEvalReport,
  {
    results: Wire.GovernanceEvalResult[];
    summary: Wire.GovernanceEvalSummary;
    degraded: null;
    rule_coverage: { exercised: number; unexercised: { rule_id: string; steering_type: Wire.SteeringType }[] };
  }
>();
// Steering `effect` (api-types 0.27.0): the operator-authorable `warn` band is a legal effect on
// the wire alongside the policy-era three; a rule WITHOUT one stays recall-only (still legal).
accepts<Wire.ConformanceRule['effect'], 'deny' | 'warn' | 'allow_with_conditions' | 'allow' | undefined>();

// Multiscope responses (api-types 0.15.0; 0.17.0 grew `campaignRegistered` + the optional
// `projectAttachError`) — the recon trigger's fan receipt and the campaign launch's additive
// `runIds`: what the routes construct must satisfy the published shapes.
respondsWith<
  Wire.TestingReconResponse,
  { runId: string; runIds: string[]; campaign: string; campaignRegistered: boolean }
>();
respondsWith<
  Wire.TestingReconResponse,
  {
    runId: string;
    runIds: string[];
    campaign: string;
    campaignRegistered: boolean;
    projectAttachError: string;
  }
>();
respondsWith<Wire.LaunchCampaignResponse, { campaignId: string; runIds: string[] }>();
respondsWith<Wire.LaunchCampaignResponse, { campaignId: string }>();

// Governance wiki management (wiki-mgmt): GET /governance/wiki/scoreboard + /governance/wiki/meta.
respondsWith<
  Wire.GovernanceScoreboard,
  Awaited<ReturnType<CoreAdapter['governanceScoreboard']>>
>();
respondsWith<Wire.GovernanceWikiMeta['ruleset_count'], Awaited<ReturnType<CoreAdapter['countRuleSets']>>>();
respondsWith<Wire.GovernanceWikiMeta['scoreboard_available'], ReturnType<CoreAdapter['wikiScoreboardSupported']>>();

// GET/PATCH /repos/:id/requirements — server-side search + overrides.
respondsWith<Wire.RequirementsPage, RequirementsPage>();
respondsWith<Wire.RequirementDetail, RequirementDetail>();

// GET/PUT /settings — persisted system settings (defaults applied server-side). Checked twice:
// the compiled-in defaults, and the adapter's read shape (defaults + persisted patch), which
// carries the additive `worker_config_root` (seat sign-in, api-types 0.5.0).
respondsWith<Wire.SystemSettings, typeof DEFAULT_SETTINGS>();
respondsWith<Wire.SystemSettings, Awaited<ReturnType<CoreAdapter['getSettings']>>>();

// Projects (DES-PROJECT-001 §5.2) — the 9-route surface's reads.
respondsWith<Wire.Project, Awaited<ReturnType<CoreAdapter['projectCreate']>>>();
respondsWith<Wire.Project[], Awaited<ReturnType<CoreAdapter['projectList']>>>();
respondsWith<Wire.Project | null, Awaited<ReturnType<CoreAdapter['projectGet']>>>();
respondsWith<Wire.ProjectMember[], Awaited<ReturnType<CoreAdapter['projectMembers']>>>();
respondsWith<
  { member: Wire.ProjectMember; created: boolean },
  Awaited<ReturnType<CoreAdapter['projectMemberAttach']>>
>();
// GET /projects/:id/prompts — the durable prompt inbox rows, verbatim engine shape.
respondsWith<
  Wire.InteractionRequest[] | null,
  Awaited<ReturnType<CoreAdapter['interactionRequests']>>
>();

// GET /runs/:id/files + GET /runs/:id/diff (DES-FEEDBACK-002 CREW-1, api-types 0.7.0) — the
// in-studio viewer's capped file read and worktree diff. The routes produce `{path} + read` /
// the diff shape verbatim, so the machinery types must satisfy the published contract.
respondsWith<Wire.RunFileContent, { path: string } & CappedFileRead>();
respondsWith<Wire.RunDiff, WorktreeDiff>();

// GET /diagnostics (api-types 0.16.0) — the daemon's self-knowledge surface. The route
// assembles exactly this shape from the diagnostics module's machinery types; pinning it here
// (and each machinery type below, BOTH directions) means a null-vs-absent or camelCase drift
// in either the module or the contract stops compiling instead of shipping.
respondsWith<
  Wire.DiagnosticsResponse,
  {
    components: {
      crew: string;
      studioBundle: string | null;
      coreTs: string | null;
      engineBinaries: Record<string, string | null>;
    };
    daemon: { uptimeMs: number; startedAt: number; port: number };
    stores: StoreFileEntry[];
    recentErrors: RecentError[];
    acp: { byCli: Record<string, AcpCliFold> };
  }
>();
respondsWith<Wire.AcpCliDiagnostics, AcpCliFold>();
respondsWith<AcpCliFold, Wire.AcpCliDiagnostics>();
respondsWith<Wire.DiagnosticsRecentError, RecentError>();
respondsWith<RecentError, Wire.DiagnosticsRecentError>();
respondsWith<Wire.DiagnosticsStoreFile, StoreFileEntry>();
respondsWith<StoreFileEntry, Wire.DiagnosticsStoreFile>();

// Identity/actor contract (task #88): the implicit local actor and the audit
// trail's read shape must satisfy what the contract publishes.
respondsWith<Wire.Actor, typeof LOCAL_ACTOR>();
respondsWith<Wire.AuditEntry[], Awaited<ReturnType<AuditLog['read']>>>();

// ── Request direction: client → daemon ─────────────────────────────────────────
//
// The contract tells a client what it may send; the zod schemas decide what the daemon
// accepts. Contract ⊆ schema-input, or a legal client request 400s.

accepts<z.input<typeof LaunchSchema>, Wire.LaunchRunBody>();
accepts<z.input<typeof GateSchema>, Wire.GateDecision>();
accepts<z.input<typeof GuidanceSchema>, Wire.SetGuidanceBody>();
accepts<z.input<typeof OpenTerminalSchema>, Wire.OpenTerminalBody>();
// POST /open (crew#273) — every body the contract lets the studio Files tab send must parse.
accepts<z.input<typeof OpenPathSchema>, Wire.OpenPathBody>();
// Projects (DES-PROJECT-001): every body the contract lets a client send must parse.
accepts<z.input<typeof CreateProjectSchema>, Wire.CreateProjectBody>();
accepts<z.input<typeof UpdateProjectSchema>, Wire.UpdateProjectBody>();
accepts<z.input<typeof AttachMemberSchema>, Wire.AttachMemberBody>();
// Steering (STEERING program) — the import batch and the "add with chat" authoring launch.
accepts<z.input<typeof SteeringImportSchema>, Wire.SteeringImportBody>();
accepts<z.input<typeof SteeringAuthorSchema>, Wire.SteeringAuthorBody>();
// Testing (crew-testing) — the evals-run selector and the corpus-import batch.
accepts<z.input<typeof RunGovernanceEvalsSchema>, Wire.RunGovernanceEvalsBody>();
accepts<z.input<typeof ImportEvalCorpusSchema>, Wire.ImportEvalCorpusBody>();
// Multiscope (api-types 0.15.0) — the recon trigger and the campaign launch: every body the
// contract lets a client send (projectId/repoRefs included) must parse.
accepts<z.input<typeof TestingReconSchema>, Wire.TestingReconBody>();
accepts<z.input<typeof LaunchCampaignSchema>, Wire.LaunchCampaignBody>();
// POST /projects/:id/graph/refresh — the additive `force` body (estate-migration path).
accepts<z.input<typeof RefreshProjectGraphSchema>, Wire.RefreshProjectGraphBody>();

// Memory management (DES-MEM-FACETED-001, api-types 0.22.0) — the shapes the /memory routes build
// from estate must satisfy the contract, and the retire body the contract lets a client send must
// parse against the route schema.
respondsWith<Wire.ListMemoriesResponse, { memories: Wire.MemoryItem[] }>();
respondsWith<
  Wire.MemoryCoverageResponse,
  { total: number; by_tier: Record<string, number>; by_kind: Record<string, number> }
>();
respondsWith<Wire.RetireMemoryResponse, { erased: number }>();
accepts<z.input<typeof RetireMemorySchema>, Wire.RetireMemoryBody>();

// Skills keystone (api-types 0.26.0) — the daemon-owned garden plugin root's file manager.
// Response direction: every store answer the routes hand through must satisfy the contract.
respondsWith<Wire.SkillManifest, ReturnType<SkillsStore['manifest']>>();
respondsWith<Wire.SkillFileTree, ReturnType<SkillsStore['listFiles']>>();
respondsWith<Wire.SkillReadResult, Awaited<ReturnType<SkillsStore['readFile']>>>();
respondsWith<Wire.SkillMutationResult, ReturnType<SkillsStore['enable']>>();
respondsWith<Wire.SkillMutationResult, ReturnType<SkillsStore['writeFile']>>();
respondsWith<Wire.SkillMutationResult, ReturnType<SkillsStore['add']>>();
respondsWith<Wire.SkillPublishResult, ReturnType<SkillsStore['publish']>>();
respondsWith<Wire.SkillRefreshResult, ReturnType<SkillsStore['refreshBaseline']>>();
respondsWith<Wire.SkillAnalyzeResult, ReturnType<SkillsStore['analyze']>>();
respondsWith<Wire.SkillsManifestResponse['current'], ReturnType<SkillsStore['currentSnapshot']>>();
// snapshot.json is what the ENGINE reads — its skill rows reuse the contract's kind vocabulary.
respondsWith<Wire.SkillKind, SnapshotManifest['skills'][number]['kind']>();
// Request direction: every body the contract lets a client send parses.
accepts<z.input<typeof SkillRevisionSchema>, Wire.SkillRevisionBody>();
accepts<z.input<typeof PutSkillFileSchema>, Wire.PutSkillFileBody>();
accepts<z.input<typeof AddSkillSchema>, Wire.AddSkillBody>();
accepts<z.input<typeof ReplaceSkillSchema>, Wire.ReplaceSkillBody>();
// The settings additions: both keys are optional on the wire and validated at the PUT boundary;
// the shipped default the daemon fills in for `skills_mirror` is a boolean the wire admits.
respondsWith<Wire.SystemSettings['skills_root'], string | undefined>();
respondsWith<Wire.SystemSettings['skills_mirror'], boolean | undefined>();
respondsWith<NonNullable<Wire.SystemSettings['skills_mirror']>, typeof DEFAULT_SKILLS_MIRROR>();

describe('wire contract (wicked-crew-api-types) drift guard', () => {
  it('compiles: daemon responses satisfy the contract, contract bodies parse (see typecheck)', () => {
    // The assertions above are compile-time; reaching this line means the module loaded,
    // which in turn means esbuild resolved every import. The real gate is
    // `tsc --noEmit -p tsconfig.test.json` (npm run typecheck), which CI runs per-PR.
    expect(true).toBe(true);
  });

  it("the engine's complete eval report fixture is internally consistent (per_type partitions the totals over the seven steering types)", () => {
    // The compile-time pins above establish the SHAPE; this keeps the copied numbers honest, so a
    // future edit to the fixture cannot silently make it a report no engine would emit.
    const rc = ENGINE_REPORT_WITH_COVERAGE.rule_coverage;
    const rows = Object.values(rc.per_type);
    expect(rows).toHaveLength(7);
    expect(rows.reduce((n, r) => n + r.exercised, 0)).toBe(rc.exercised);
    expect(rows.reduce((n, r) => n + r.unexercised, 0)).toBe(rc.unexercised.length);
    expect(ENGINE_REPORT_WITH_COVERAGE.summary.total).toBe(ENGINE_REPORT_WITH_COVERAGE.results.length);
  });

  it('the shipped built-in workflows are contract-shaped at runtime too', () => {
    // A cheap runtime cross-check on real data (not just types): every built-in workflow
    // the daemon serves from GET /workflows carries the contract's required keys.
    for (const wf of BUILTIN_WORKFLOWS) {
      expect(typeof wf.id).toBe('string');
      expect(Array.isArray(wf.phases)).toBe(true);
      for (const p of wf.phases) {
        expect(typeof p.id).toBe('string');
        expect(['recon', 'build', 'review', 'test']).toContain(p.kind);
        expect(p).toHaveProperty('gate');
        expect(['neutral', 'creator', 'evaluator']).toContain(p.role);
      }
    }
  });
});
