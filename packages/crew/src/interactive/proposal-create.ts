/**
 * THE `create` LAUNCHER OF A CHAT PROPOSAL (DES-CHAT-ARTIFACTS-001 §4.3 steps 2-3, §5.2; slice A3).
 *
 * Registered on A2's {@link LaunchOnceRegistry}: `launchOnce` holds the run id's lock, asks {@link find}, and calls
 * {@link launch} only when the engine has no such run. `launch` makes exactly one document and one run, whatever was
 * lost before it:
 *
 *  1. the document's binding and this attempt are recorded first (`doc-binding.ts`), so the bus trigger of the
 *     document knows it is a chat's and hands it back to `launchOnce` instead of launching a random-id draft;
 *  2. the document is looked up by its derived name in its mount, and created only if it is missing, by crew itself,
 *     through the proxy's own create path with `chat_id` + `proposal_id` (so the Unfiled-repository exception goes
 *     through the accepted record, §5.2). A 409 from a create that raced is adoption, not failure;
 *  3. the source packet is built from the stored resolution and the chat's records, joins the document's canonical
 *     packet, and the draft is launched with the DERIVED run id as its `sessionId` (never a random one).
 *
 * So a double click, a lost response, two tabs, a crash between launch and record, and a crash between create and
 * draft launch all end with one document and one run. A launch that fails leaves the attempt recorded with no run:
 * the card shows "Interrupted · Go again", which resumes the same identity.
 */

import type { ArtifactProposal, ChatTranscriptRecord, ProposalIdentity, SessionView } from '../core/types.js';
import { parseArtifactRef, UNFILED_MOUNT } from '../api/chat-context.js';
import type { ProposalDispatch, ProposalDispatcher } from '../api/chat-proposals.js';
import { DEFAULT_PROJECT_ID } from '../projects/default-project.js';
import { realpathSync } from 'node:fs';

import { readBeneath } from '../api/beneath.js';
import { readDocHead } from './chat-events.js';
import type { BoundRepo, DocBinding, DocBindingAttempt, DocBindingStore } from './doc-binding.js';
import type { BoundDraft, BoundOutcome } from './draft-events.js';
import { buildSourcePacket, type PacketDeps } from './source-packet.js';

export interface CreateLauncherDeps {
  bindings: DocBindingStore;
  /** Whether the engine knows this run id. */
  runExists(runId: string): Promise<boolean>;
  /** The docs root of a route project (`default` = Unfiled); `null` = no such project. */
  docsRoot(projectId: string): Promise<string | null>;
  /** Crew's in-process create through the proxy's own path (`createDocInProcess`). */
  createDoc(projectId: string, body: Record<string, unknown>, actorId: string): Promise<{ status: number; body: unknown }>;
  /** The draft seam's proposal-bound launch; `null` when the seam is not armed (nothing can draft). */
  launchBound: ((spec: BoundDraft) => Promise<void>) | null;
  /** The chat's records (live transcript or kept history). */
  records(chatId: string): ChatTranscriptRecord[];
  /** The chat's instance now (its history nonce), or `null`. */
  instanceOf(chatId: string): string | null;
  /** The id a chat instance is kept under now: its own id, or the archive id a reuse of the id moved it to; `null` when
   *  it is gone. A binding reads its chat through this, never another person's chat that reused the id. */
  chatIdOf(chatId: string, instance: string | null): string | null;
  /** Registered repositories by id (for their roots). */
  repos(): Promise<Array<{ id: string; name: string; rootPath: string }>>;
  /** The code graph a document in this mount gets: the project's, else the chat's own scope graph. */
  graphFor(projectId: string | null, chatId: string): Promise<string | null>;
  /** The launch roster of two seats, as `clisJson`; `null` when either can no longer work. */
  clisJsonFor(seats: readonly string[]): string | null;
  /** The style of a catalog entry (`launch.style`). */
  styleOf(entry: string | null): string;
  packetDeps: PacketDeps;
  log?: (msg: string) => void;
}

export class CreateLauncher implements ProposalDispatcher {
  constructor(private readonly deps: CreateLauncherDeps) {}

  async find(identity: ProposalIdentity): Promise<boolean> {
    return this.deps.runExists(identity.runId);
  }

  /** Busy until the attempt's outcome is recorded (§6.2), once its run exists. A launch that never produced a run is
   *  not busy: Go again resumes it. */
  async live(runId: string): Promise<boolean> {
    const hit = this.deps.bindings.attemptOf(runId);
    if (hit === null || hit.attempt.outcome !== undefined) return false;
    return hit.attempt.launchedAt !== undefined || (await this.deps.runExists(runId));
  }

  /** A document with an attempt still without an outcome, whose run exists. */
  async docBusy(artifactRef: string): Promise<boolean> {
    const a = this.deps.bindings.busy(artifactRef);
    return a !== null && (a.launchedAt !== undefined || (await this.deps.runExists(a.runId)));
  }

  async launch(d: ProposalDispatch): Promise<void> {
    const launchBound = this.deps.launchBound;
    if (launchBound === null) throw new Error('documents cannot be drafted on this daemon (its draft seam is not armed)');
    const ref = d.identity.artifactRef === null ? null : parseArtifactRef(d.identity.artifactRef);
    if (ref === null) throw new Error('the proposal names no document');
    const res = d.resolution;
    const projectId = ref.mount === UNFILED_MOUNT ? null : ref.mount;
    const root = await this.deps.docsRoot(ref.projectId);
    if (root === null) throw new Error(`${projectId === null ? 'Unfiled' : `project ${projectId}`} is no longer on this daemon`);
    const head = readDocHead(root, ref.doc);

    // 1. Recorded before anything is created or launched. A retry keeps the binding's repositories, graph, cutoff, chat
    //    instance and the project the chat itself was in (which says whether the packet is re-checked).
    const held = this.deps.bindings.get(ref.ref);
    const repos = held?.repos ?? (await this.boundRepos(res));
    const graphDb = held !== null ? held.graphDb : await this.deps.graphFor(projectId, d.chatId);
    const base = head?.head ?? 0;
    const binding = this.deps.bindings.begin(
      {
        ref: ref.ref,
        mount: ref.mount,
        doc: ref.doc,
        projectId,
        owner: d.actor.id,
        chatId: d.chatId,
        chatInstance: this.deps.instanceOf(d.chatId),
        scopeProject: scopeProjectOf(this.deps.records(d.chatId), res),
        proposalId: d.pid,
        cutoffTurnId: res.turnId,
        repos,
        graphDb,
      },
      { pid: d.pid, runId: d.identity.runId, base },
    );
    const attempt = binding.attempts.find((a) => a.runId === d.identity.runId)!;
    const clisJson = res.helpers !== null ? this.deps.clisJsonFor(res.helpers.seats) : null;
    if (clisJson === null) throw new Error('a helper on the card can no longer work; choose two helpers and Go again');

    // 2. The document, created only if it is missing.
    if (head === null) {
      const r = await this.deps.createDoc(
        ref.projectId,
        {
          name: ref.doc,
          kind: 'source',
          brief: res.brief ?? res.what.title,
          style: this.deps.styleOf(res.what.entry),
          chat_id: d.chatId,
          proposal_id: d.pid,
          ...(binding.repos.length > 0 ? { repo_refs: binding.repos.map((r) => r.id) } : {}),
          clisJson,
          channel: 'studio',
          actor: d.actor.id,
        },
        d.actor.id,
      );
      const answered = readDocHead(root, ref.doc);
      if ((r.status < 200 || r.status >= 300) && !(r.status === 409 && answered !== null)) {
        const why = (r.body as { error?: unknown } | null)?.error;
        throw new Error(`the document could not be created (${r.status}${typeof why === 'string' ? `: ${why}` : ''})`);
      }
    } else if (head.kind === 'demo') {
      throw new Error(`${ref.ref} is a demo, not a document`);
    }

    // 3. The packet, then the draft with the derived run id. The chat is read through its own instance: after a reuse of
    //    its id it is the archived chat, and when it is gone only what the canonical packet already holds is used.
    const chatNow = this.deps.chatIdOf(binding.chatId, binding.chatInstance);
    const packet = await buildSourcePacket(
      {
        runId: d.identity.runId,
        chatId: binding.chatId,
        pid: d.pid,
        cutoffTurnId: binding.cutoffTurnId,
        resolution: res,
        records: chatNow === null ? [] : this.deps.records(chatNow),
        held: { tokens: binding.tokens, bytes: (name) => this.deps.bindings.packetBytes(ref.ref, name) },
        ...(binding.scopeProject !== binding.projectId ? { recheckProject: binding.projectId } : {}),
      },
      this.deps.packetDeps,
    );
    this.deps.bindings.addPacket(ref.ref, packet.canonical, packet.tokens);
    this.deps.log?.(
      `[proposals] ${d.pid}: ${ref.ref} run ${d.identity.runId} — packet ${packet.files.length} file(s)` +
        `${packet.struck.length > 0 ? `, ${packet.struck.length} left out` : ''}`,
    );
    await launchBound({
      documentId: ref.doc,
      ...(projectId !== null ? { projectId } : {}),
      brief: res.brief ?? res.what.title,
      style: this.deps.styleOf(res.what.entry),
      runId: d.identity.runId,
      chatId: binding.chatId,
      proposalId: d.pid,
      artifactRef: ref.ref,
      repos: binding.repos.map((r) => ({ repoRef: r.id, name: r.name, rootPath: r.rootPath })),
      graphDb: binding.graphDb,
      clisJson,
      packet,
      base: attempt.base,
      actor: d.actor.id,
    });
  }

  /** The resolution's repositories with their registered roots (a repository unregistered since is left out, said). */
  private async boundRepos(res: ArtifactProposal): Promise<BoundRepo[]> {
    const want = res.repoRefs ?? [];
    if (want.length === 0) return [];
    const all = await this.deps.repos();
    const out: BoundRepo[] = [];
    for (const id of want) {
      const hit = all.find((r) => r.id === id);
      if (hit === undefined) this.deps.log?.(`[proposals] ${res.pid}: repository ${id} is no longer registered — not grounded on it`);
      else out.push({ id: hit.id, name: hit.name, rootPath: hit.rootPath });
    }
    return out;
  }
}

/** The project the chat itself was in when the proposal was made (its first record, before any edit): a resolution
 *  re-filed by an edit differs from it, and then the packet is re-checked against the document's project (§4.2). A
 *  `null` there is a real answer (a chat in no project), never "unknown". */
function scopeProjectOf(records: readonly ChatTranscriptRecord[], res: ArtifactProposal): string | null {
  const first = records.find((r): r is Extract<ChatTranscriptRecord, { kind: 'proposal' }> => r.kind === 'proposal' && r.proposal.pid === res.pid);
  return first !== undefined ? first.proposal.filedIn.projectId : res.filedIn.projectId;
}

/** The route project of a mount (`default` for Unfiled). */
export function routeProjectOf(mount: string): string {
  return mount === UNFILED_MOUNT ? DEFAULT_PROJECT_ID : mount;
}

export interface ReconcileDeps {
  bindings: DocBindingStore;
  sessions(): Promise<SessionView[]>;
  cancelRun(runId: string): Promise<unknown>;
  /** The document's versions now: its head and, per version, the run that made it when interactive records that (the
   *  I1 contract: `run_id` on each new entry). `provenance` = the manifest records runs at all. `null` = not readable. */
  docVersions(projectId: string | null, doc: string): { head: number; byRun: Map<string, number>; provenance: boolean } | null;
  /** The id the binding's chat is kept under now (its own, or an archive id after a reuse), or `null`. */
  chatIdOf(chatId: string, instance: string | null): string | null;
  /** Decide an `accepting` proposal whose run exists (A2's adopt). */
  settleAccepting(chatId: string, pid: string): Promise<boolean>;
  /** The run's `run.launched` facts (chat, proposal, artifact, document), recorded again when a crash lost them. */
  ensureLaunchRecord(binding: DocBinding, attempt: DocBindingAttempt): void;
  /** An outcome this reconcile recorded, or a failure whose publication a crash cut short (release, `landing_failed`,
   *  retry card: each idempotent). */
  onOutcome(ref: string, runId: string, outcome: BoundOutcome): void;
  log(msg: string): void;
  /** How long a cancelled run is waited for, ms (default 30 s). */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'failed']);

/**
 * DES-CHAT-ARTIFACTS-001 §6.2 (A3): at daemon start, BEFORE the generic boot resume (which skips bound runs), every
 * proposal-bound attempt without a recorded outcome is settled. An `accepting` proposal whose run exists is decided, and
 * the run's launch facts are recorded again if a crash lost them. An attempt crew had announced landed when the
 * document's manifest names its run (the I1 contract); before that contract, when the head moved past its base (the
 * best evidence there is, said in the log). Every other attempt with a run lost its seam flight in the restart: its
 * engine run is cancelled to a CONFIRMED terminal state, then "interrupted by a restart" is recorded, and only then are
 * the chat and the document released and Try again offered, so an old attempt never runs beside a new one (a retry
 * also removes the old attempt's folder, so an announce of it still on the bus cannot land). Never a redispatch. An
 * attempt with no run is left alone: its card's "Go again" resumes the same identity. A failure whose publication a
 * crash cut short is published again.
 */
export async function reconcileBoundAttempts(deps: ReconcileDeps): Promise<void> {
  const all = deps.bindings.all();
  for (const b of all) {
    for (const a of b.attempts) {
      if (a.outcome?.kind === 'failed' && a.published !== true) deps.onOutcome(b.ref, a.runId, a.outcome);
    }
  }
  const pending = all.flatMap((b) => b.attempts.filter((a) => a.outcome === undefined).map((a) => ({ b, a })));
  if (pending.length === 0) return;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const views = new Map((await deps.sessions()).map((v) => [v.session.id, v] as const));
  for (const { b, a } of pending) {
    const view = views.get(a.runId);
    if (view === undefined) continue;
    deps.ensureLaunchRecord(b, a);
    const chatNow = deps.chatIdOf(b.chatId, b.chatInstance);
    if (chatNow !== null) await deps.settleAccepting(chatNow, a.pid).catch(() => false);
    if (a.emittedAt !== undefined) {
      const v = deps.docVersions(b.projectId, b.doc);
      const landedAt = v === null ? undefined : v.provenance ? v.byRun.get(a.runId) : v.head > a.base ? v.head : undefined;
      if (landedAt !== undefined) {
        if (v !== null && !v.provenance) deps.log(`[proposals] boot: ${b.ref} run ${a.runId}: v${landedAt} is past the attempt's base; this interactive records no run per version, so that is taken as its landing`);
        const landed: BoundOutcome = { kind: 'landed', version: landedAt };
        if (deps.bindings.setOutcome(b.ref, a.runId, landed)) deps.onOutcome(b.ref, a.runId, landed);
        continue;
      }
    }
    let status = String(view.session.status);
    if (!TERMINAL_STATUSES.has(status)) {
      try {
        await deps.cancelRun(a.runId);
      } catch (err) {
        deps.log(`[proposals] boot: could not stop run ${a.runId} of ${b.ref}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const deadline = Date.now() + (deps.waitMs ?? 30_000);
      for (;;) {
        status = String((await deps.sessions()).find((v) => v.session.id === a.runId)?.session.status ?? status);
        if (TERMINAL_STATUSES.has(status) || Date.now() >= deadline) break;
        await sleep(500);
      }
      if (!TERMINAL_STATUSES.has(status)) {
        // Its terminal frame settles it later (the draft seam records the interruption for a run it holds no flight for).
        deps.log(`[proposals] boot: run ${a.runId} of ${b.ref} is still ${status}; the document stays busy until it ends`);
        continue;
      }
    }
    const outcome: BoundOutcome = { kind: 'failed', reason: 'interrupted by a restart' };
    if (deps.bindings.setOutcome(b.ref, a.runId, outcome)) deps.onOutcome(b.ref, a.runId, outcome);
    deps.log(`[proposals] boot: ${b.ref} run ${a.runId} was interrupted by the restart (engine ${status}); released, Try again offered`);
  }
}

/**
 * A document's head and which run made each version, read from its `versions.json` beneath the docs root (no link
 * followed). `provenance` is whether the manifest records runs at all (interactive's I1 contract writes `run_id` on
 * every new entry; an older interactive writes none). `null` when the manifest cannot be read.
 */
export function docVersionsOf(docsRoot: string, doc: string): { head: number; byRun: Map<string, number>; provenance: boolean } | null {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(doc)) return null;
  try {
    const root = realpathSync(docsRoot);
    const m = JSON.parse(readBeneath(root, `${doc}/versions.json`, 2 * 1024 * 1024).data.toString('utf8')) as { head?: unknown; versions?: unknown };
    if (typeof m.head !== 'number' || !Number.isInteger(m.head) || m.head < 0) return null;
    const byRun = new Map<string, number>();
    let provenance = false;
    for (const e of Array.isArray(m.versions) ? (m.versions as Array<Record<string, unknown>>) : []) {
      if (e === null || typeof e !== 'object' || !('run_id' in e)) continue;
      provenance = true;
      if (typeof e['run_id'] === 'string' && typeof e['version'] === 'number') byRun.set(e['run_id'], e['version']);
    }
    return { head: m.head, byRun, provenance };
  } catch {
    return null;
  }
}
