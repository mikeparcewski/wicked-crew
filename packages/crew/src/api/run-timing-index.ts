/**
 * The run→launch-time index (home command-center run metrics; api-types 0.24.0).
 *
 * The engine's `AgentSession` (wicked-core `domain.rs`) records no launch timestamp — checked, it
 * carries only `archived_at` — so WHEN a run was launched is, exactly like its actor (task #88)
 * and its retry lineage (CREW-UX-3), knowledge only the daemon's HTTP layer ever holds. The
 * durable record is the `run.launched` audit entry's `ts` (unix MILLIS); this map is the read-side
 * latency layer that lets `GET /runs` / `GET /runs/:id` echo `AgentSession.created_at` (unix
 * SECONDS) without a trail scan per request.
 *
 * Mirrors `RetryIndex`'s posture exactly: hydrated once at server start from the SAME
 * `run.launched` scan `RetryIndex` + `GroupIndex` already share (the crew#321 consolidation note),
 * best-effort — a missing/unreadable trail leaves PRIOR runs undated, the pre-field behaviour, not
 * an error — and updated at the same post-commit point that writes the audit entry, so the map can
 * only lag by a failed hydrate, never diverge silently.
 */

import type { AuditLog } from './audit.js';
import type { Actor, AuditEntry, LaunchEnvelope, LaunchShape, RecordedEvent, SessionView } from '../core/types.js';
import type { RunAddress } from '../knowledge/trackers/addresses.js';
import { MCP_SERVER_NAME_RE } from '../mcp/classify.js';

/** The run statuses that are terminal (`SessionStatus`): the only runs `ended_at` may date. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'failed']);
/** The engine frames that end a run: the same three the daemon records `run.ended` on. */
const TERMINAL_EVENTS: ReadonlySet<string> = new Set(['sessionCompleted', 'sessionFailed', 'runCancelled']);
/** How many run event logs one backfill reads at once. */
const BACKFILL_CONCURRENCY = 4;

/**
 * Millis → whole unix SECONDS. The DTO field (`AgentSession.created_at`) and every other
 * `created_at` in this wire contract (`ConformanceRule`, memory items) are unix SECONDS; the audit
 * trail stamps millis (`AuditEntry.ts`), so the conversion happens here, once, at the seam.
 */
function toSeconds(millis: number): number {
  return Math.floor(millis / 1000);
}

/** crew#1742: a `run.launched` entry crew re-recorded at boot from a document binding (`recoveredLaunchDetail`). */
function isRecoveredLaunch(entry: Pick<AuditEntry, 'detail'>): boolean {
  return (entry.detail as Record<string, unknown> | undefined)?.['recoveredAtBoot'] === true;
}

export class RunTimingIndex {
  private readonly runToCreatedAt = new Map<string, number>();
  /** runId → terminal instant, unix SECONDS (`AgentSession.ended_at`; api-types 0.38.0, crew#496). */
  private readonly runToEndedAt = new Map<string, number>();
  /** crew#985: runId → terminal instant DERIVED from the engine event log (unix SECONDS), for runs
   *  with no `run.ended` entry. Kept apart from {@link runToEndedAt} so it never stands in for the
   *  durable record: the daemon still writes `run.ended` when it sees the frame. */
  private readonly runToDerivedEndedAt = new Map<string, number>();
  /** crew#985: runId → the read of its engine event log (settled = read; in flight = awaited by an
   *  overlapping request, so no request serves a run undated while another is still reading it). */
  private readonly endedBackfill = new Map<string, Promise<void>>();
  /** runId → launch channel (`AgentSession.channel`; crew#632). */
  private readonly runToChannel = new Map<string, 'studio' | 'cli' | 'api'>();
  /** runId → launch actor string (`AgentSession.launch_actor`; crew#632). */
  private readonly runToLaunchActor = new Map<string, string>();
  /** runId → warm seat count at chat-promotion time (`AgentSession.chat_seat_count`; crew#641/#642). */
  private readonly runToChatSeatCount = new Map<string, number>();
  /** runId → whether the promoted chat was graph-grounded (`AgentSession.chat_grounded`; crew#641/#642). */
  private readonly runToChatGrounded = new Map<string, boolean>();
  /**
   * runId → the chat it was launched from (`AgentSession.chat_id`; C1, api-types 0.71.0), for EVERY
   * run, terminal ones included. crew#619's `runToChat` in `server.ts` is the transcript-retention
   * hold and releases a run at its terminal frame; this is the permanent read-side index, fed by
   * the same `run.launched` entries.
   */
  private readonly runToChatId = new Map<string, string>();
  /** crew#854: runs an ask launched (the `run.launched` entry's `askPath`). */
  private readonly askPathRuns = new Set<string>();
  /** wf-catalog: run → the NON-system principal its `run.launched` entry names (`Actor.id`), for per-operator usage. */
  private readonly runToPrincipal = new Map<string, string>();
  /** crew#1157: runs an ANALYSIS chat launched → its workflow (the entry's `chatWorkflow`). */
  private readonly runToChatWorkflow = new Map<string, string>();
  /** crew#552: chained run → the onboarding run it was launched from (`detail.chainedFrom`). */
  private readonly runToChainedFrom = new Map<string, string>();
  /** crew#552: onboarding run → the capture run chained from it (the idempotence key). */
  private readonly chainedRun = new Map<string, string>();
  /** crew#1365: the capture-learnings runs the onboarding chain launched (its own `run.launched` entry, as the
   *  `onboarding` system actor, with `chainedFrom`): crew's to end when one stops at a gate, across a restart. */
  private readonly onboardingCaptures = new Set<string>();
  /** crew#552: onboarding runs launched with `autoCapture: false`. */
  private readonly autoCaptureOffRuns = new Set<string>();
  /** crew#762: the RESOLVED delivery decision the launch recorded (`detail.deliver`). */
  private readonly runToLaunchDeliver = new Map<string, 'pr' | 'none'>();
  /** DES-CHAT-ARTIFACTS-001 (A3): the proposal a run answers and the artifact it makes (`detail.proposalId`/`artifactRef`). */
  private readonly runToProposal = new Map<string, { proposalId: string; artifactRef: string }>();
  /** A3 (§6.2): a proposal-bound attempt that ended without landing (`run.landing_failed`). */
  private readonly runToLandingFailed = new Map<string, { reason: string; at: number }>();
  /** (DES-CATALOG-002 §4.4) The launch's shape, its envelope and the chat proposal whose Go launched it (`detail.shape`,
   *  `detail.envelope`, `detail.fromProposal`): usage by shape, the reshape's relaunch, and the plan-gate binding. */
  private readonly runToLaunchFacts = new Map<string, { shape?: LaunchShape; envelope?: LaunchEnvelope; fromProposal?: string }>();
  /** crew#1352: the issues a run addresses, as its launch recorded them (`detail.trackerAddresses`), with its scope. */
  private readonly runToAddresses = new Map<string, LaunchedAddresses>();
  /** crew#1442: the source pick a run was launched with (`detail.sourcePick`). */
  private readonly runToSourcePick = new Map<string, string[]>();
  /** crew#1442: every run whose `run.launched` entry this index read (live or hydrated). */
  private readonly launchedRuns = new Set<string>();
  /** crew#1442: the boot read of the trail failed, so a run not launched since is of unknown pick. */
  private launchHistoryUnreadable = false;
  /** crew#1742: runs known only through a boot re-record (`recoveredAtBoot`), which carries no pick: of unknown pick. */
  private readonly unknownPickRuns = new Set<string>();

  /**
   * Consume pre-read `run.launched` entries — the seam that lets `createServer` feed this index
   * from the ONE `readAll({ action: 'run.launched' })` it already runs for `RetryIndex` +
   * `GroupIndex`, so boot stays at the same full-file trail scans, not one more.
   */
  hydrateFromLaunchEntries(entries: AuditEntry[]): void {
    // crew#1742: the trail is read newest first. A run whose newest entry is a boot re-record reads its source pick from
    // its newest real launch, applied first (the re-record then keeps it); with none, its pick stays unknown.
    const launched = new Map<string, AuditEntry>();
    for (const entry of entries) {
      if (typeof entry.runId === 'string' && !isRecoveredLaunch(entry) && !launched.has(entry.runId)) launched.set(entry.runId, entry);
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (typeof entry.runId !== 'string' || seen.has(entry.runId)) continue;
      seen.add(entry.runId);
      const real = isRecoveredLaunch(entry) ? launched.get(entry.runId) : undefined;
      if (real !== undefined) this.applyLaunchEntry(real);
      this.applyLaunchEntry(entry);
    }
  }

  /**
   * A launch replaces all launch facts, including facts absent from this entry. crew#1742: except the source pick of an
   * entry crew re-recorded at boot (`recoveredAtBoot`, from the document binding, which never holds a pick): it keeps
   * the pick already read, and a run not read before stays of unknown pick (never a known launch with none).
   */
  applyLaunchEntry(entry: Pick<AuditEntry, 'runId' | 'ts' | 'actor' | 'detail'>): void {
    const runId = entry.runId;
    if (typeof runId !== 'string') return;
    const recovered = isRecoveredLaunch(entry);
    const heldPick = recovered ? this.runToSourcePick.get(runId) : undefined;
    const knownBefore = this.launchedRuns.has(runId) && !this.unknownPickRuns.has(runId);
    const previousFrom = this.runToChainedFrom.get(runId);
    if (previousFrom !== undefined && this.chainedRun.get(previousFrom) === runId) this.chainedRun.delete(previousFrom);
    this.runToCreatedAt.delete(runId);
    this.runToChannel.delete(runId);
    this.runToLaunchActor.delete(runId);
    this.runToChatSeatCount.delete(runId);
    this.runToChatGrounded.delete(runId);
    this.runToChatId.delete(runId);
    this.askPathRuns.delete(runId);
    this.runToPrincipal.delete(runId);
    this.runToChatWorkflow.delete(runId);
    this.runToChainedFrom.delete(runId);
    this.onboardingCaptures.delete(runId);
    this.autoCaptureOffRuns.delete(runId);
    this.runToLaunchDeliver.delete(runId);
    this.runToProposal.delete(runId);
    this.runToLaunchFacts.delete(runId);
    this.runToAddresses.delete(runId);
    this.runToSourcePick.delete(runId);
    if (heldPick !== undefined) this.runToSourcePick.set(runId, heldPick);
    this.launchedRuns.add(runId);
    // A boot re-record of a run no real launch entry names: its pick is unknown, whatever the boot read did.
    if (recovered && !knownBefore) this.unknownPickRuns.add(runId);
    else this.unknownPickRuns.delete(runId);
    if (typeof entry.ts === 'number' && entry.ts > 0) this.set(runId, entry.ts);
    const launcher = entry.actor;
    if (typeof launcher?.id === 'string' && launcher.kind !== 'system') this.setPrincipal(runId, launcher.id);
    const detail = entry.detail as Record<string, unknown> | undefined;
    const ch = detail?.['channel'];
    if (ch === 'studio' || ch === 'cli' || ch === 'api') this.runToChannel.set(runId, ch);
    const la = detail?.['actor'];
    if (typeof la === 'string' && la.length > 0) this.runToLaunchActor.set(runId, la);
    // crew#641/#642 (item 5): chat promotion provenance.
    const sc = detail?.['chatSeatCount'];
    if (typeof sc === 'number') this.runToChatSeatCount.set(runId, sc);
    const cg = detail?.['chatGrounded'];
    if (typeof cg === 'boolean') this.runToChatGrounded.set(runId, cg);
    // C1: the chat↔run link crew#619 already makes durable, read back for every run.
    const chatId = detail?.['chatId'];
    if (typeof chatId === 'string' && chatId.length > 0) this.runToChatId.set(runId, chatId);
    if (detail?.['askPath'] === true) this.askPathRuns.add(runId);
    const cw = detail?.['chatWorkflow'];
    if (typeof cw === 'string' && cw.length > 0) this.runToChatWorkflow.set(runId, cw);
    const deliver = detail?.['deliver'];
    if (deliver === 'pr' || deliver === 'none') this.runToLaunchDeliver.set(runId, deliver);
    this.noteProposal(runId, detail);
    this.noteChain(runId, detail);
    // (crew#1365) The literals are onboarding-capture.ts's ONBOARDING_CHAIN_ACTOR and CAPTURE_LEARNINGS_WORKFLOW (that
    // module imports this one).
    if (launcher?.kind === 'system' && launcher.id === 'onboarding' && detail?.['workflow'] === 'capture-learnings' && typeof detail['chainedFrom'] === 'string') {
      this.onboardingCaptures.add(runId);
    }
    this.noteLaunchFacts(runId, detail);
    this.noteTrackerFacts(runId, typeof entry.ts === 'number' ? entry.ts : 0, detail);
  }

  /** crew#1352, crew#1442: a launch entry's tracker addresses and source pick, each kept only when it is well formed. */
  noteTrackerFacts(runId: string, ts: number, detail: Record<string, unknown> | undefined): void {
    const addresses = launchedAddressList(detail?.['trackerAddresses']);
    if (addresses !== null && addresses.length > 0) {
      const projectId = detail?.['projectId'];
      const repoId = detail?.['repoRef'];
      this.runToAddresses.set(runId, { runId, at: ts, projectId: typeof projectId === 'string' ? projectId : null, repoId: typeof repoId === 'string' ? repoId : null, addresses });
    }
    const pick = detail?.['sourcePick'];
    if (Array.isArray(pick) && pick.length <= SOURCE_PICK_MAX && pick.every((id) => typeof id === 'string' && MCP_SERVER_NAME_RE.test(id))) {
      this.runToSourcePick.set(runId, [...new Set(pick as string[])]);
    }
  }

  /** crew#1352: what a run addresses as its launch recorded it, or `undefined` (none recorded). A copy. */
  addressesOf(runId: string): LaunchedAddresses | undefined {
    const a = this.runToAddresses.get(runId);
    return a === undefined ? undefined : { ...a, addresses: a.addresses.map((x) => ({ ...x })) };
  }

  /** crew#1352: every run whose launch recorded tracker addresses, oldest launch first. Copies. */
  allAddresses(): LaunchedAddresses[] {
    return [...this.runToAddresses.keys()].map((id) => this.addressesOf(id)!).sort((a, b) => a.at - b.at);
  }

  /** crew#1442: the source pick a run's launch recorded, or `null` (none recorded). A copy: a caller cannot widen it. */
  sourcePickOf(runId: string): string[] | null {
    const p = this.runToSourcePick.get(runId);
    return p === undefined ? null : [...p];
  }

  /** crew#1442: the boot read of `run.launched` failed (the daemon logged it). */
  markLaunchHistoryUnreadable(): void {
    this.launchHistoryUnreadable = true;
  }

  /**
   * crew#1442: the pick store's fallback. A run whose launch this index read answers its recorded pick (`null` = it had
   * none). A run it never read, after a boot read that failed, THROWS: its pick is unknown, and a pick store that
   * throws refuses the run's source calls (fail closed) rather than read the run as unpicked.
   */
  recordedPickOf(runId: string): string[] | null {
    if (!this.launchedRuns.has(runId) && this.launchHistoryUnreadable) throw new Error(`run ${runId}'s source pick is unknown: the launch history could not be read at boot`);
    if (this.unknownPickRuns.has(runId)) throw new Error(`run ${runId}'s source pick is unknown: only its recovery at boot is recorded`);
    return this.sourcePickOf(runId);
  }

  /** (DES-CATALOG-002 §4.4) A launch entry's shape, envelope and proposal, as recorded. */
  noteLaunchFacts(runId: string, detail: Record<string, unknown> | undefined): void {
    const shape = detail?.['shape'];
    const envelope = detail?.['envelope'];
    const from = detail?.['fromProposal'];
    const facts: { shape?: LaunchShape; envelope?: LaunchEnvelope; fromProposal?: string } = {};
    if (shape !== null && typeof shape === 'object' && typeof (shape as { card?: unknown }).card === 'string') facts.shape = shape as LaunchShape;
    if (envelope !== null && typeof envelope === 'object') facts.envelope = envelope as LaunchEnvelope;
    if (typeof from === 'string' && from !== '') facts.fromProposal = from;
    if (Object.keys(facts).length > 0) this.runToLaunchFacts.set(runId, facts);
  }

  /** The shape a run was launched as, or `undefined`. */
  shapeOf(runId: string): LaunchShape | undefined {
    return this.runToLaunchFacts.get(runId)?.shape;
  }

  /** What a run was launched with (a reshape relaunches from it), or `undefined` for a run from before it was recorded. */
  envelopeOf(runId: string): LaunchEnvelope | undefined {
    return this.runToLaunchFacts.get(runId)?.envelope;
  }

  /** The chat proposal whose Go launched a run, or `undefined`. */
  fromProposalOf(runId: string): string | undefined {
    return this.runToLaunchFacts.get(runId)?.fromProposal;
  }

  /** A3: a launch entry's proposal facts (`proposalId`, `artifactRef`), both or neither. */
  noteProposal(runId: string, detail: Record<string, unknown> | undefined): void {
    const pid = detail?.['proposalId'];
    const ref = detail?.['artifactRef'];
    if (typeof pid === 'string' && pid !== '' && typeof ref === 'string' && ref !== '') this.runToProposal.set(runId, { proposalId: pid, artifactRef: ref });
  }

  /** A3: the proposal a run answers and the artifact it makes, or `undefined`. */
  proposalOf(runId: string): { proposalId: string; artifactRef: string } | undefined {
    return this.runToProposal.get(runId);
  }

  /** A3: the `run.landing_failed` entries (newest first: the oldest, i.e. the first recorded, wins). */
  hydrateLandingFailed(entries: AuditEntry[]): void {
    for (const entry of entries) {
      const reason = (entry.detail as Record<string, unknown> | undefined)?.['reason'];
      if (typeof entry.runId !== 'string' || typeof reason !== 'string' || typeof entry.ts !== 'number') continue;
      this.runToLandingFailed.set(entry.runId, { reason, at: entry.ts });
    }
  }

  setLandingFailed(runId: string, reason: string, at: number): void {
    if (!this.runToLandingFailed.has(runId)) this.runToLandingFailed.set(runId, { reason, at });
  }

  landingFailedOf(runId: string): { reason: string; at: number } | undefined {
    return this.runToLandingFailed.get(runId);
  }

  /**
   * Load launch times from EVERY `run.launched` entry in the trail — exhaustively, not capped, for
   * the same reason `RetryIndex.hydrate` is (BRIEF-UX-002 C5): a launch fact thousands of runs deep
   * must survive a restart, or a time-bucketed KPI silently drops the oldest runs. Still
   * best-effort: a missing/unreadable trail leaves runs undated, the pre-field answer. Cost is one
   * full-file scan at boot — the shared scan already parses the whole file.
   */
  async hydrate(audit: AuditLog, log?: (msg: string) => void): Promise<void> {
    try {
      this.hydrateFromLaunchEntries(await audit.readAll({ action: 'run.launched' }));
    } catch (err) {
      log?.(
        `[runs] run-timing-index hydrate failed (prior runs read as undated and lose their chat_id link until restart): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Record a run's launch instant (unix MILLIS — the caller passes `Date.now()`, the same clock the
   * `run.launched` audit entry stamps, so the in-session answer and the post-restart rehydrate
   * agree to the second). Stored as whole unix seconds.
   */
  set(runId: string, launchedAtMillis: number): void {
    this.runToCreatedAt.set(runId, toSeconds(launchedAtMillis));
  }

  /** The run's launch time in unix SECONDS, or `undefined` (the DTO spells that as an ABSENT field). */
  createdAtFor(runId: string): number | undefined {
    return this.runToCreatedAt.get(runId);
  }

  /** Record the launch channel for a run (crew#632). */
  setChannel(runId: string, channel: 'studio' | 'cli' | 'api'): void {
    this.runToChannel.set(runId, channel);
  }

  /** The launch channel, or `undefined` (ABSENT when the launch did not name one). */
  channelFor(runId: string): 'studio' | 'cli' | 'api' | undefined {
    return this.runToChannel.get(runId);
  }

  /** Record the launch actor string for a run (crew#632). */
  setLaunchActor(runId: string, actor: string): void {
    this.runToLaunchActor.set(runId, actor);
  }

  /** wf-catalog: record the principal that launched a run (the live half of the hydrate above). Callers pass
   *  only a NON-system launcher: a schedule's or the daemon's launch is nobody's use, whatever its id. */
  setPrincipal(runId: string, actorId: string): void {
    if (actorId.length > 0) this.runToPrincipal.set(runId, actorId);
  }

  /** wf-catalog: a system relaunch of a reused run id is nobody's use. */
  clearPrincipal(runId: string): void {
    this.runToPrincipal.delete(runId);
  }

  /** The principal (`Actor.id`) the run's `run.launched` entry names, or `undefined` when there is none. */
  principalFor(runId: string): string | undefined {
    return this.runToPrincipal.get(runId);
  }

  /** The launch actor string, or `undefined` (ABSENT when the launch did not name one). */
  launchActorFor(runId: string): string | undefined {
    return this.runToLaunchActor.get(runId);
  }

  /** Record the warm seat count and grounding state at chat-promotion time (crew#641/#642). */
  setChatPromotion(runId: string, seatCount: number, grounded: boolean): void {
    this.runToChatSeatCount.set(runId, seatCount);
    this.runToChatGrounded.set(runId, grounded);
  }

  /** Record the chat a run was launched from (C1). */
  setChatId(runId: string, chatId: string): void {
    this.runToChatId.set(runId, chatId);
  }

  /** Record that an ask launched the run (crew#854). */
  setAskPath(runId: string): void {
    this.askPathRuns.add(runId);
  }

  /** Did an ask launch the run (crew#854)? */
  isAskPath(runId: string): boolean {
    return this.askPathRuns.has(runId);
  }

  /** crew#1157: record the read-only workflow an analysis chat's run runs. */
  setChatWorkflow(runId: string, workflow: string): void {
    this.runToChatWorkflow.set(runId, workflow);
  }

  /** crew#1157: the read-only workflow the run's chat runs (`analyze`), or `undefined` for any other run. */
  chatWorkflowOf(runId: string): string | undefined {
    return this.runToChatWorkflow.get(runId);
  }

  /** crew#552: a launch entry's chain facts (`chainedFrom`, `autoCapture: false`). */
  noteChain(runId: string, detail: Record<string, unknown> | undefined): void {
    const from = detail?.['chainedFrom'];
    if (typeof from === 'string' && from.length > 0) {
      this.runToChainedFrom.set(runId, from);
      this.chainedRun.set(from, runId);
    }
    if (detail?.['autoCapture'] === false) this.autoCaptureOffRuns.add(runId);
  }

  /** crew#552: the onboarding run a chained run was launched from (`AgentSession.chained_from`). */
  chainedFromOf(runId: string): string | undefined {
    return this.runToChainedFrom.get(runId);
  }

  /** crew#1365: whether the onboarding chain launched this capture-learnings run (its launch entry says so). */
  isOnboardingCapture(runId: string): boolean {
    return this.onboardingCaptures.has(runId);
  }

  /** crew#552: the capture run chained from an onboarding run, if one was launched. */
  chainedRunOf(onboardRunId: string): string | undefined {
    return this.chainedRun.get(onboardRunId);
  }

  /** crew#552: was the onboarding run launched with `autoCapture: false`? */
  autoCaptureOff(onboardRunId: string): boolean {
    return this.autoCaptureOffRuns.has(onboardRunId);
  }

  /** Record the launch's resolved delivery decision (crew#762). */
  setLaunchDeliver(runId: string, deliver: 'pr' | 'none'): void {
    this.runToLaunchDeliver.set(runId, deliver);
  }

  /** What the launch decided about delivery (`'pr'` / `'none'`), or `undefined` when there is no launch record. */
  launchDeliverFor(runId: string): 'pr' | 'none' | undefined {
    return this.runToLaunchDeliver.get(runId);
  }

  /** The chat the run was launched from, or `undefined` (ABSENT when it was not launched from one). */
  chatIdFor(runId: string): string | undefined {
    return this.runToChatId.get(runId);
  }

  /** The warm seat count at chat-promotion, or `undefined` (ABSENT when not a chat-promoted run). */
  chatSeatCountFor(runId: string): number | undefined {
    return this.runToChatSeatCount.get(runId);
  }

  /** Whether the chat was graph-grounded at launch, or `undefined` (ABSENT when not chat-promoted). */
  chatGroundedFor(runId: string): boolean | undefined {
    return this.runToChatGrounded.get(runId);
  }

  /**
   * Consume pre-read `run.ended` entries (crew#496 / studio#230) — the daemon records one when it
   * sees a run's terminal frame (`sessionCompleted` | `sessionFailed` | `runCancelled`). The run's
   * FIRST terminal instant wins, the same rule the live {@link setEnded} applies: the trail answers
   * newest first, so the OLDEST entry per run (the last one seen) is kept — a resume/retry
   * re-terminal recorded after a hydrate failure never moves an already-dated run either way.
   * `ts <= 0` stamps nothing. One more filtered scan at boot, in the same try as the `run.launched`
   * scan (DES-L8 §5 PR-8B).
   */
  hydrateFromEndedEntries(entries: AuditEntry[]): void {
    for (const entry of entries) {
      if (typeof entry.runId !== 'string' || typeof entry.ts !== 'number' || entry.ts <= 0) continue;
      this.runToEndedAt.set(entry.runId, toSeconds(entry.ts)); // newest-first trail ⇒ the oldest wins
    }
  }

  /**
   * Record a run's terminal instant (unix MILLIS — the `run.ended` audit entry's own `ts`, so the
   * live answer and the post-restart rehydrate agree to the second). Idempotent per run: the first
   * stamp wins — a second terminal frame (resume, retry) re-stamps nothing.
   */
  setEnded(runId: string, endedAtMillis: number): void {
    if (this.runToEndedAt.has(runId)) return;
    this.runToEndedAt.set(runId, toSeconds(endedAtMillis));
  }

  /** The run's terminal time in unix SECONDS, or `undefined` (ABSENT on the wire — never null,
   *  never fabricated: a live run, a pre-field run, a run that terminalled before THIS daemon
   *  booted, a lost trail). */
  endedAtFor(runId: string): number | undefined {
    return this.runToEndedAt.get(runId) ?? this.runToDerivedEndedAt.get(runId);
  }

  /** Whether the run has a RECORDED terminal instant (a `run.ended` entry, live or hydrated). The
   *  daemon writes the entry only when this is false, so an event-log derivation never skips it. */
  hasRecordedEnd(runId: string): boolean {
    return this.runToEndedAt.has(runId);
  }

  /**
   * crew#985: date the terminal runs that have no `run.ended` entry (runs that ended before
   * crew#496 shipped the entry, or while no daemon was watching) from the engine's own event log:
   * the FIRST terminal frame's capture `ts`, the same first-wins rule as {@link setEnded}. Read-only
   * and in memory: nothing is written to the trail, so the next boot derives it again, and a
   * recorded `run.ended` (live or hydrated) always wins over the derivation.
   *
   * Each run's log is read at most once per process (a terminal run's log does not grow). A run
   * whose log has no terminal frame (it predates the log) stays ABSENT. A failed read is not
   * remembered, so a later request tries again.
   */
  async backfillEndedFromEvents(
    views: readonly SessionView[],
    runEvents: (runId: string) => Promise<RecordedEvent[] | null>,
  ): Promise<void> {
    const inFlight: Promise<void>[] = [];
    const pending: Array<{ id: string; settle: () => void }> = [];
    for (const { session: s } of views) {
      if (!TERMINAL_STATUSES.has(s.status) || this.runToEndedAt.has(s.id)) continue;
      const read = this.endedBackfill.get(s.id);
      if (read !== undefined) {
        inFlight.push(read);
        continue;
      }
      let settle!: () => void;
      this.endedBackfill.set(s.id, new Promise<void>((resolve) => (settle = resolve)));
      pending.push({ id: s.id, settle });
    }
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const { id, settle } = pending[next++]!;
        try {
          const events = await runEvents(id);
          const terminal = events?.find((e) => TERMINAL_EVENTS.has(e.type) && typeof e.ts === 'number' && e.ts > 0);
          if (terminal !== undefined) this.runToDerivedEndedAt.set(id, toSeconds(terminal.ts));
        } catch {
          this.endedBackfill.delete(id);
        } finally {
          settle();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BACKFILL_CONCURRENCY, pending.length) }, worker));
    await Promise.all(inFlight);
  }
}

/**
 * Record a `run.launched` audit entry AND stamp the run-timing index with the SAME durable `ts`, so
 * `created_at` is answered LIVE (not only after a restart re-hydrates the trail) for EVERY route
 * that launches a run — `POST /runs` and the recon/steering-author launchers alike. Centralized
 * here (Copilot #466) so a new launch site can never again record the trail without stamping the
 * index. `ts === 0` (audit disabled — the `noop` trail route-unit tests build) stamps nothing,
 * keeping `created_at` derived ONLY from a durable entry, never fabricated. Returns the millis `ts`
 * for a caller that needs it (0 when audit is disabled).
 */
export function recordRunLaunched(
  audit: AuditLog,
  runTimingIndex: RunTimingIndex | undefined,
  actor: Actor,
  runId: string,
  detail: Record<string, unknown>,
): number {
  const ts = audit.record('run.launched', actor, { runId, detail });
  runTimingIndex?.applyLaunchEntry({ runId, ts, actor, detail });
  return ts;
}

/** crew#1352: a run's tracker addresses as its `run.launched` entry recorded them. */
export interface LaunchedAddresses {
  runId: string;
  /** The launch entry's `ts` (ms). */
  at: number;
  projectId: string | null;
  repoId: string | null;
  addresses: RunAddress[];
}

/** The most names a recorded pick may hold (RUN_SOURCES_MAX). */
const SOURCE_PICK_MAX = 20;
const PM_SYSTEMS_KNOWN = new Set(['github', 'jira', 'gitlab', 'ado']);

/** A recorded `trackerAddresses` list, or `null` when any element is not an address crew wrote. */
function launchedAddressList(v: unknown): RunAddress[] | null {
  if (!Array.isArray(v)) return null;
  const out: RunAddress[] = [];
  for (const a of v as unknown[]) {
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return null;
    const r = a as Record<string, unknown>;
    const trackerId = r['trackerId'];
    const source = r['source'];
    const ref = r['ref'];
    const system = r['system'];
    const asked = r['asked'];
    const closing = r['closing'];
    if (typeof trackerId !== 'string' || typeof source !== 'string' || typeof ref !== 'string' || typeof system !== 'string' || !PM_SYSTEMS_KNOWN.has(system)) return null;
    if (asked !== undefined && typeof asked !== 'string') return null;
    if (closing !== undefined && typeof closing !== 'boolean') return null;
    out.push({
      trackerId,
      source,
      system: system as RunAddress['system'],
      ref,
      ...(typeof asked === 'string' ? { asked } : {}),
      ...(typeof closing === 'boolean' ? { closing } : {}),
    });
  }
  return out;
}
