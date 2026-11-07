/**
 * THE `refine` LAUNCHER OF A CHAT PROPOSAL (DES-CHAT-ARTIFACTS-001 §6.1-6.2, §4.3; slice A5).
 *
 * Registered on A2's {@link LaunchOnceRegistry} beside A3's `create`: `launchOnce` holds the run id's lock, asks
 * {@link RefineLauncher.find}, and calls {@link RefineLauncher.launch} only when the engine has no such run.
 *
 *  1. The document is still on the head the card was accepted on (the accept route checked it right before recording;
 *     a moved head here throws, and Go again re-resolves the card on the new head).
 *  2. The attempt is recorded on the document's binding BEFORE the launch (created now for a document made outside a
 *     chat), with the derived run id, the head it revises, the person's accepted `allow` and the chat it was accepted
 *     in. So the chat and the document stay busy until its outcome is recorded, the boot reconcile sees it, and a later
 *     refine's protected-edits walk releases only what the person let THIS run change, and only once it landed.
 *  3. The chat seam launches it with the card's two helpers and the derived run id; crew's landing guard and the head's
 *     CAS decide whether anything lands.
 *
 * Not carried yet: the document's canonical source packet and the refine's authorized `sources` (DES §6.1 "grounding
 * carries forward"); a refine revises from the current document and the person's ask.
 */

import type { ChatTranscriptRecord, ProposalIdentity } from '../core/types.js';
import { parseArtifactRef, UNFILED_MOUNT } from '../api/chat-context.js';
import { foldProposals, type ProposalDispatch, type ProposalDispatcher } from '../api/chat-proposals.js';
import { readDocHead, type BoundRefine } from './chat-events.js';
import type { DocBindingStore } from './doc-binding.js';

export interface RefineLauncherDeps {
  bindings: DocBindingStore;
  runExists(runId: string): Promise<boolean>;
  /** The docs root of a route project (`default` = Unfiled); `null` = no such project. */
  docsRoot(projectId: string): Promise<string | null>;
  /** The chat seam's proposal-bound refine; `null` when the seam is not armed (nothing can revise). */
  launchBound: ((spec: BoundRefine) => Promise<void>) | null;
  records(chatId: string): ChatTranscriptRecord[];
  instanceOf(chatId: string): string | null;
  /** The launch roster of two seats, as `clisJson`; `null` when either can no longer work. */
  clisJsonFor(seats: readonly string[]): string | null;
  /** The draft seam's fence: earlier attempts' draft folders go before this one starts, so an announce of an earlier
   *  create still on the bus can no longer land over the refine (codex A5 r2). */
  fence?: (documentId: string, runIds: readonly string[]) => void;
  log?: (msg: string) => void;
}

export class RefineLauncher implements ProposalDispatcher {
  constructor(private readonly deps: RefineLauncherDeps) {}

  async find(identity: ProposalIdentity): Promise<boolean> {
    return this.deps.runExists(identity.runId);
  }

  /** Busy until the attempt's outcome is recorded (§6.2), once its run exists. */
  async live(runId: string): Promise<boolean> {
    const hit = this.deps.bindings.attemptOf(runId);
    if (hit === null || hit.attempt.outcome !== undefined) return false;
    return hit.attempt.launchedAt !== undefined || (await this.deps.runExists(runId));
  }

  async docBusy(artifactRef: string): Promise<boolean> {
    const a = this.deps.bindings.busy(artifactRef);
    return a !== null && (a.launchedAt !== undefined || (await this.deps.runExists(a.runId)));
  }

  async launch(d: ProposalDispatch): Promise<void> {
    const launchBound = this.deps.launchBound;
    if (launchBound === null) throw new Error('documents cannot be revised on this daemon (its chat seam is not armed)');
    const ref = d.identity.artifactRef === null ? null : parseArtifactRef(d.identity.artifactRef);
    const target = d.resolution.target;
    if (ref === null || target === undefined || target.ref !== ref.ref) throw new Error('the proposal names no document');
    const root = await this.deps.docsRoot(ref.projectId);
    if (root === null) throw new Error(`${ref.mount === UNFILED_MOUNT ? 'Unfiled' : `project ${ref.mount}`} is no longer on this daemon`);
    const head = readDocHead(root, ref.doc);
    if (head === null) throw new Error(`${target.title} is gone`);
    if (head.head !== target.base) throw new Error(`${target.title} changed since you pressed Go (now v${head.head}); check the card again`);
    // The person's choice, from the accepted record only (never the block's `touches`, never words in the ask).
    const accepted = foldProposals(this.deps.records(d.chatId)).get(d.pid)?.accepting?.edits ?? null;
    const shown = new Set((d.resolution.protected ?? []).map((e) => e.id));
    const allow = [...new Set((accepted?.allow ?? []).filter((id) => shown.has(id)))];
    const helpers = d.resolution.helpers;
    const clisJson = helpers !== null ? this.deps.clisJsonFor(helpers.seats) : null;
    if (clisJson === null) throw new Error('a helper on the card can no longer work; choose two helpers and Go again');
    const projectId = ref.mount === UNFILED_MOUNT ? null : ref.mount;
    const instance = this.deps.instanceOf(d.chatId);
    const held = this.deps.bindings.get(ref.ref);
    this.deps.bindings.begin(
      held ?? {
        ref: ref.ref,
        mount: ref.mount,
        doc: ref.doc,
        projectId,
        owner: d.actor.id,
        chatId: d.chatId,
        chatInstance: instance,
        scopeProject: d.resolution.filedIn.projectId,
        proposalId: d.pid,
        cutoffTurnId: d.resolution.turnId,
        repos: [],
        graphDb: null,
      },
      { pid: d.pid, runId: d.identity.runId, base: target.base, allow, op: 'refine', chatId: d.chatId, chatInstance: instance },
    );
    this.deps.fence?.(ref.doc, (this.deps.bindings.get(ref.ref)?.attempts ?? []).map((a) => a.runId).filter((id) => id !== d.identity.runId));
    this.deps.log?.(`[proposals] ${d.pid}: refine ${ref.ref} v${target.base} run ${d.identity.runId} — ${allow.length} edit(s) let change`);
    await launchBound({
      documentId: ref.doc,
      ...(projectId !== null ? { projectId } : {}),
      runId: d.identity.runId,
      chatId: d.chatId,
      proposalId: d.pid,
      artifactRef: ref.ref,
      ask: d.resolution.brief ?? d.resolution.what.title,
      base: target.base,
      allow,
      clisJson,
      actor: d.actor.id,
    });
  }
}
