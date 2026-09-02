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
import type { GateSchema, GuidanceSchema, LaunchSchema, OpenPathSchema, OpenTerminalSchema } from '../src/api/routes.js';
import type { SteeringAuthorSchema, SteeringImportSchema } from '../src/api/governance-steering.js';
import type {
  ImportEvalCorpusSchema,
  RunGovernanceEvalsSchema,
  TestingReconSchema,
} from '../src/api/testing.js';
import type { LaunchCampaignSchema } from '../src/campaigns/routes.js';
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
import type { DEFAULT_SETTINGS } from '../src/core/types.js';

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

describe('wire contract (wicked-crew-api-types) drift guard', () => {
  it('compiles: daemon responses satisfy the contract, contract bodies parse (see typecheck)', () => {
    // The assertions above are compile-time; reaching this line means the module loaded,
    // which in turn means esbuild resolved every import. The real gate is
    // `tsc --noEmit -p tsconfig.test.json` (npm run typecheck), which CI runs per-PR.
    expect(true).toBe(true);
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
