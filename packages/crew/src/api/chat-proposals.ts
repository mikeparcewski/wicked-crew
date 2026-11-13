/**
 * CHAT PROPOSES; NOTHING LAUNCHES YET (DES-CHAT-ARTIFACTS-001 §4, slice A2).
 *
 * A chat seat that is asked to make or change an artifact ends its reply with a fenced `wicked-make` block
 * (`chat-scope.ts` tells it how, for the operations crew advertises). The block never reaches a reader: the transcript
 * store cuts it out of the reply and the stream (`chat-transcripts.ts`, on the `wicked-decisions` mechanism). This
 * module is everything after that:
 *
 *  1. **Resolve** ({@link ChatProposals.onReply}): the last block that parses becomes an {@link ArtifactProposal}
 *     whose every line is crew's — the catalog entry and its outcome, each source authorized (a run or document must
 *     have been named by the person in this chat or be the artifact they had open, and be in the chat's scope; a
 *     struck chip says why), the repositories (the chat's scope, else Go is blocked), two distinct helpers (the
 *     chat's lead seat, then another of its seats, else the next eligible seat on the roster: studio's `docSeats`
 *     rule, moved here so the card and the launch agree), time and cost from the catalog and from completed runs on
 *     this daemon (a dollar figure only from at least 3 runs whose every agent step reported a cost), the stops and
 *     where it is filed. It is appended as a `proposal` transcript record and sent as a `chatProposal` frame. A newer
 *     proposal supersedes the chat's open one; an answer-only turn leaves it open.
 *  2. **Answer** ({@link ChatProposals.decide}, `POST /chats/:id/proposals/:pid`): the route has already checked the
 *     capability, that the caller is a person, and that the chat is theirs — on every call. Then, under one
 *     in-process lock per proposal, crew looks for what already happened first (a decided proposal returns its
 *     result; an `accepting` one whose run exists is adopted and decided), and only a fresh Go runs the state checks
 *     (edits, that every source and the target still exist, that the chat and the document are not busy, that a
 *     refine's document is still on the head it was proposed on) BEFORE anything is recorded. Then `proposal_accepting`
 *     (the effective proposal and the identity derived from the pid), then the one launcher per run id
 *     ({@link LaunchOnceRegistry}), then `proposal_decided`. Not now runs no other check.
 *
 * Each operation's launcher is registered by its own slice: A3's real `create` (`interactive/proposal-create.ts`)
 * whenever the draft seam is armed, so production advertises `proposals` and `create`; refine (A5), theme (A7) and demo
 * (A8) stay off there until their slices land. The TEST configuration (`WICKED_CHAT_ARTIFACTS_STUB=1`, DES §13 A2)
 * turns every operation's resolution on and registers a {@link RecordingStubDispatcher} for the kinds that have no real
 * launcher yet (`capabilities.chatArtifacts.stubOps`): those record a dispatch and start nothing.
 *
 * Records go to the chat's live transcript, or to its kept history copy once the chat has ended, so an open proposal
 * stays answerable after a restart (§4.3).
 */

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from '../zod.js';

import type {
  Actor,
  ArtifactProposal,
  ArtifactProposalKind,
  CatalogGateId,
  ChatArtifactsCapabilities,
  ChatContextBinding,
  ChatPlanOffer,
  ChatProposalFrame,
  ChatProposalView,
  ChatTranscriptRecord,
  CoreEvent,
  ProposalAccepting,
  PersonProposalBody,
  PersonRevisionBody,
  ProposalEdits,
  ProposalHelpers,
  ProtectedEdit,
  ProposalRevision,
  ProposalRevisionEdits,
  ProposalShape,
  ProposalIdentity,
  ProposalNeed,
  ProposalQuestion,
  ProposalResult,
  ProposalSource,
  ProposalToken,
  ProposalTime,
  SessionView,
} from '../core/types.js';
import type { CatalogSeed } from '../workflow-catalog/catalog-data.js';
import type { ServedState } from '../workflow-catalog/build-v2.js';
import { parseCommand, resolveOption } from '../workflow-catalog/build-v2.js';
import { CATALOG_V2_CARDS } from '../workflow-catalog/catalog-data-v2.js';
import { REVIEW_CHANGE_WORKFLOW } from './review-change.js';
import {
  checksLabel,
  ownWords,
  factsOf,
  JobRefusal,
  mergeRevision,
  nounOf,
  optionFor,
  personAskedSkip,
  personPid,
  proposalKindOf,
  qeSkipBound,
  requestDigest,
  repoOf,
  resolveJob,
  SEAT_WORDS,
  seatProtections,
  briefOf,
  inputLines,
  SELF_SEATED,
  type JobChat,
  type JobContext,
  type JobFacts,
} from './chat-jobs.js';
import { artifactExists, artifactHead, chatMount, parseArtifactRef, UNFILED_MOUNT } from './chat-context.js';
import { ATTACHMENT_MAX_FILE_BYTES } from './chat-attachments.js';
import { documentPathPlan, type PacketDeps } from '../interactive/source-packet.js';
import { tornTailPrefix } from './chat-transcripts.js';
import type { JobTurnContext, MakeDigest } from './chat-scope.js';
import { catalogDigest, detect, detectable } from '../workflow-catalog/detect.js';
import { OnboardBlock, resolveOnboard, type OnboardBlockBody, type OnboardResolveDeps } from './proposal-onboard.js';

// ── the block ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Sources a block may name. */
export const PROPOSAL_SOURCES_MAX = 12;

const TOKEN = z.string().trim().min(1).max(300);
const SOURCES = z.array(TOKEN).max(PROPOSAL_SOURCES_MAX).default([]);
const REPOS = z.array(z.string().trim().min(1).max(200)).max(8).default([]);
const REASON = z.string().max(600).optional();

/** studio's appearance scalars (`theming/appearance.ts`), as a partial patch: only the keys that change. */
export const ThemePatchSchema = z.strictObject({
  theme: z.enum(['wicked-dark', 'wicked-light']).optional(),
  accent_h: z.number().min(0).max(360).optional(),
  accent_s: z.number().min(0).max(100).optional(),
  accent_l: z.number().min(0).max(100).optional(),
  ambient: z.boolean().optional(),
  ambient_still: z.boolean().optional(),
})
  .refine((p) => Object.keys(p).length > 0, 'a theme patch changes at least one key');

const EntryBlock = z.object({
  entry: z.string().trim().min(1).max(80),
  // DES-CATALOG-002 §2.3: a job routing block names the card's option, an Investigate card's depth, and how sure the
  // seat is (garden classify's catalog mode). Validated, cross-checked and banded by crew (`workflow-catalog/detect.ts`).
  option: z.string().trim().max(80).nullable().optional(),
  depth: z.enum(['quick', 'standard', 'deep']).nullable().optional(),
  confidence: z.number().optional(),
  title: z.string().trim().max(200).optional(),
  brief: z.string().max(8000).optional(),
  url: z.string().trim().max(2048).optional(),
  audience: z.string().max(400).optional(),
  show: z.string().max(2000).optional(),
  sources: SOURCES,
  repos: REPOS,
  reason: REASON,
});
const RefineBlock = z.object({
  refine: z.string().trim().min(1).max(200),
  ask: z.string().trim().min(1).max(4000),
  touches: z.array(z.string().trim().min(1).max(128)).max(32).default([]),
  sources: SOURCES,
  reason: REASON,
});
const ThemeBlock = z.object({
  theme: z.object({ name: z.string().trim().min(1).max(60), patch: ThemePatchSchema }),
  reason: REASON,
});

export type ParsedMake =
  | ({ op: 'entry' } & z.infer<typeof EntryBlock>)
  | ({ op: 'refine' } & z.infer<typeof RefineBlock>)
  | ({ op: 'theme' } & z.infer<typeof ThemeBlock>)
  | ({ op: 'onboard' } & OnboardBlockBody);

/** One block body → its operation, or `null` (not JSON, not exactly one of `entry` / `refine` / `theme`, or a bad shape). */
export function parseMakeBlock(body: string): ParsedMake | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const ops = (['entry', 'refine', 'theme', 'onboard'] as const).filter((k) => o[k] !== undefined && o[k] !== null);
  if (ops.length !== 1) return null;
  if (ops[0] === 'entry') {
    const r = EntryBlock.safeParse(o);
    return r.success ? { op: 'entry', ...r.data } : null;
  }
  if (ops[0] === 'refine') {
    const r = RefineBlock.safeParse(o);
    return r.success ? { op: 'refine', ...r.data } : null;
  }
  if (ops[0] === 'onboard') {
    // crew-0182: add a git repository to a project (resolved by `proposal-onboard.ts`).
    const r = OnboardBlock.safeParse(o);
    return r.success ? { op: 'onboard', ...r.data } : null;
  }
  const r = ThemeBlock.safeParse(o);
  return r.success ? { op: 'theme', ...r.data } : null;
}

const InputValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), value: z.string().max(8000) }),
  z.strictObject({ kind: z.literal('url'), value: z.string().max(2048) }),
  z.strictObject({ kind: z.literal('requirements'), refs: z.array(z.strictObject({ repoId: z.string().min(1).max(200), key: z.string().min(1).max(200) })).min(1).max(50) }),
  z.strictObject({ kind: z.literal('documents'), tokens: z.array(z.string().min(1).max(300)).min(1).max(20) }),
  z.strictObject({ kind: z.literal('sources'), ids: z.array(z.string().min(1).max(100)).max(20) }),
]);

/** (DES-CATALOG-002 §4.6) The edits of a {@link ProposalRevision}, as a block or a request carries them. Unknown keys
 *  pass through to the merge, which drops each with a note (a refused edit leaves the rest standing). */
export const RevisionEditsSchema = z.looseObject({
  card: z.string().trim().min(1).max(80).optional(),
  option: z.string().trim().min(1).max(80).nullable().optional(),
  depth: z.enum(['quick', 'standard', 'deep']).nullable().optional(),
  repoRef: z.string().trim().min(1).max(200).optional(),
  project: z.string().trim().max(128).nullable().optional(),
  lead: z.string().trim().min(1).max(64).optional(),
  addSeats: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
  removeSeats: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
  inputs: z.record(z.string().min(1).max(64), InputValueSchema).optional(),
  detail: z.strictObject({ add: z.array(z.string().max(200)).max(8).optional(), remove: z.array(z.string().max(200)).max(8).optional() }).optional(),
  skipQe: z.strictObject({ reason: z.string().trim().min(1).max(600) }).optional(),
  restoreQe: z.literal(true).optional(),
  confirmLoss: z.union([z.literal(true), z.array(z.string().min(1).max(40)).min(1).max(12)]).optional(),
});

/** A seat's typed revision block: `{"revises":"<pid>","edits":{…}}`. `null` for anything else. */
export function parseRevisionBlock(body: string): ProposalRevision | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['revises'] !== 'string' || o['revises'] === '' || o['edits'] === null || typeof o['edits'] !== 'object') return null;
  const edits = RevisionEditsSchema.safeParse(o['edits']);
  if (!edits.success) return null;
  return { revises: o['revises'], edits: edits.data as ProposalRevisionEdits };
}

/** (DES-CATALOG-002 §2.4) A seat's plan-edit block at a held plan: `{"planEdit":"<run id>"}`. `null` for anything else. */
export function parsePlanEditBlock(body: string): string | null {
  try {
    const o = JSON.parse(body) as unknown;
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
    const v = (o as Record<string, unknown>)['planEdit'];
    return typeof v === 'string' && v.trim() !== '' && v.length <= 128 ? v.trim() : null;
  } catch {
    return null;
  }
}

/** (DES-CATALOG-002 §2.3) The FIRST block of a reply that parses: one request yields at most one actionable card. */
export function firstValidBlock(bodies: readonly string[]): ParsedMake | null {
  for (const b of bodies) {
    const parsed = parseMakeBlock(b);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** The last block of a reply that parses (DES §4.1: the last valid block wins), or `null`. */
export function lastValidBlock(bodies: readonly string[]): ParsedMake | null {
  for (let i = bodies.length - 1; i >= 0; i -= 1) {
    const parsed = parseMakeBlock(bodies[i]!);
    if (parsed !== null) return parsed;
  }
  return null;
}

// ── identity ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The namespace of proposal run ids (a fixed random UUID; RFC 4122 §4.3 name-based ids under it). */
const PROPOSAL_NAMESPACE = '6f0b8a52-6d2e-4c4a-9a57-3f1f0c2b7e41';

/** RFC 4122 version-5 UUID of `name` under {@link PROPOSAL_NAMESPACE}: the run id a proposal's Go launches with. */
export function proposalRunId(pid: string): string {
  const ns = Buffer.from(PROPOSAL_NAMESPACE.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(pid, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** A create's document name, derived from the pid (stable across retries) with the title as a readable prefix. */
export function proposalDocName(pid: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  const tag = createHash('sha256').update(pid, 'utf8').digest('hex').slice(0, 8);
  return `${slug === '' ? 'doc' : slug}-${tag}`;
}

// ── the fold ───────────────────────────────────────────────────────────────────────────────────────────────────────

type ProposalRecord = Extract<ChatTranscriptRecord, { kind: 'proposal' | 'proposal_accepting' | 'proposal_decided' | 'proposal_revising' | 'proposal_released' | 'plan_offer' }>;

/** A folded proposal plus what the accept path needs that the wire view does not carry. */
export interface FoldedProposal extends ChatProposalView {
  turnId: string;
  /** (DES-CATALOG-002 §4.6) The message turn holding it while `revising`. */
  hold?: string;
  /** The `proposal_accepting` record, kept after the decision: what was actually accepted (edits applied). */
  accepting?: ProposalAccepting;
}

/**
 * Fold a chat's records into its proposals, by pid. A `proposal` record opens one (a newer pid supersedes the chat's
 * open one; the same pid again replaces it, re-opening an interrupted `accepting` one whose run never launched); a
 * `proposal_accepting` record marks it accepting; a `proposal_decided` record decides it.
 */
export function foldProposals(records: readonly ChatTranscriptRecord[]): Map<string, FoldedProposal> {
  const out = new Map<string, FoldedProposal>();
  for (const r of records) {
    if (r.kind === 'proposal') {
      const pid = r.proposal.pid;
      const held = out.get(pid);
      if (held !== undefined && (held.state === 'decided' || held.state === 'superseded')) continue;
      // A re-resolution of an older proposal while a newer one exists never takes the chat back: it is superseded.
      if (held !== undefined && [...out.keys()].indexOf(pid) < out.size - 1) {
        held.state = 'superseded';
        continue;
      }
      // The newest proposal is the chat's one open proposal: a new pid, or a re-resolution of the newest (which replaces
      // its frozen choices: the next Go uses the fresh card).
      for (const [other, v] of out) {
        if (other !== pid && (v.state === 'open' || v.state === 'revising')) {
          v.state = 'superseded';
          delete v.hold;
        }
      }
      out.set(pid, { proposal: r.proposal, state: 'open', turnId: r.turnId });
    } else if (r.kind === 'proposal_revising') {
      // DES-CATALOG-002 §4.6: the person's message holds an open proposal while its seat turn may revise it.
      const v = out.get(r.pid);
      if (v === undefined || v.state !== 'open') continue;
      v.state = 'revising';
      v.hold = r.turnId;
      delete v.note;
    } else if (r.kind === 'proposal_released') {
      const v = out.get(r.pid);
      if (v === undefined || v.state !== 'revising' || v.hold !== r.turnId) continue;
      v.state = 'open';
      delete v.hold;
      if (r.note !== null) v.note = r.note;
    } else if (r.kind === 'proposal_accepting') {
      const v = out.get(r.pid);
      if (v === undefined || v.state === 'decided') continue;
      v.state = 'accepting';
      delete v.hold;
      v.accepting = { pid: r.pid, actor: r.actor, edits: r.edits, resolution: r.resolution, identity: r.identity };
    } else if (r.kind === 'proposal_decided') {
      const v = out.get(r.pid);
      if (v === undefined || v.state === 'decided') continue;
      v.state = 'decided';
      v.decision = r.decision;
      v.result = r.result;
      v.decidedAt = r.at;
    }
  }
  return out;
}

/** The wire view of a folded proposal (no internal fields): once accepted, the card shows what was accepted. */
export function viewOf(f: FoldedProposal): ChatProposalView {
  return {
    proposal: f.accepting !== undefined && (f.state === 'accepting' || (f.state === 'decided' && f.decision === 'go')) ? f.accepting.resolution : f.proposal,
    state: f.state,
    ...(f.hold !== undefined ? { revisingTurn: f.hold } : {}),
    ...(f.note !== undefined ? { note: f.note } : {}),
    ...(f.decision !== undefined ? { decision: f.decision } : {}),
    ...(f.result !== undefined ? { result: f.result } : {}),
    ...(f.decidedAt !== undefined ? { decidedAt: f.decidedAt } : {}),
  };
}

// ── launching once ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What one Go hands its operation's launcher. */
export interface ProposalDispatch {
  kind: ArtifactProposalKind;
  pid: string;
  chatId: string;
  actor: Actor;
  identity: ProposalIdentity;
  resolution: ArtifactProposal;
  /** (api-types 0.196.0) A job's Start chose a power run (checked against the daemon before accepting). Absent = it
   *  stops at its plan. */
  power?: boolean;
}

/** One operation's launcher (A3 create, A5 refine, A7 theme, A8 demo register theirs). */
export interface ProposalDispatcher {
  /** The create path's actual readers, so proposal authorization never guesses from attachment metadata. */
  documentPacketDeps?(): PacketDeps;
  /** Whether the run this identity names already exists (it is then adopted, never started again). */
  find(identity: ProposalIdentity): Promise<boolean>;
  /** Start it, with `identity.runId` as the launch's `sessionId`. Called only when {@link find} said no, under the
   *  run id's lock. */
  launch(dispatch: ProposalDispatch): Promise<void>;
  /** Whether a run it started is still live (the one-live-job-per-chat rule). */
  live?(runId: string): Promise<boolean>;
  /** Whether a document has an attempt of this launcher still without an outcome (A3: one live job per document). */
  docBusy?(artifactRef: string): Promise<boolean>;
  /** The test configuration's recording stub: nothing is started. */
  readonly stub?: boolean;
}

/** Serialize work per key: a second caller waits for the first, then runs. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/**
 * DES §4.3 step 3: ONE launcher per run id. `launchOnce` takes the run id's lock, asks the operation's launcher whether
 * that run exists (adopt), and starts it only if not — so a retry, a second tab and a late bus trigger (A3 calls this
 * from the `doc.created` path too) can never both launch.
 */
export class LaunchOnceRegistry {
  private readonly dispatchers = new Map<ArtifactProposalKind, ProposalDispatcher>();
  private readonly lock = new KeyedLock();
  /** Runs this daemon started per artifact (`<mount>/<doc>`): a document is busy while one is live, whichever chat
   *  started it, even before the engine's run list names its document. */
  private readonly byArtifact = new Map<string, Array<{ kind: ArtifactProposalKind; runId: string }>>();

  register(kind: ArtifactProposalKind, dispatcher: ProposalDispatcher): void {
    this.dispatchers.set(kind, dispatcher);
  }

  /** Share the registered create launcher's readers with its proposal's document plan. */
  documentPacketDeps(): PacketDeps | null {
    return this.dispatchers.get('create')?.documentPacketDeps?.() ?? null;
  }

  has(kind: ArtifactProposalKind): boolean {
    return this.dispatchers.has(kind);
  }

  /** The run this identity names, when it exists (adopted, never started again), with whether a stub took it. */
  async find(kind: ArtifactProposalKind, identity: ProposalIdentity): Promise<{ stub: boolean } | null> {
    const d = this.dispatchers.get(kind);
    if (d === undefined || !(await d.find(identity))) return null;
    return { stub: d.stub === true };
  }

  async live(kind: ArtifactProposalKind, runId: string): Promise<boolean> {
    const d = this.dispatchers.get(kind);
    return d?.live === undefined ? false : d.live(runId);
  }

  /** Whether a run this daemon started for the artifact is still live, or a launcher's durable record says an attempt at
   *  it has no outcome yet (A3: across a restart too). */
  async liveForArtifact(artifactRef: string): Promise<boolean> {
    for (const r of this.byArtifact.get(artifactRef) ?? []) if (await this.live(r.kind, r.runId)) return true;
    for (const d of new Set(this.dispatchers.values())) if (d.docBusy !== undefined && (await d.docBusy(artifactRef))) return true;
    return false;
  }

  launchOnce(dispatch: ProposalDispatch): Promise<ProposalResult> {
    const d = this.dispatchers.get(dispatch.kind);
    if (d === undefined) return Promise.reject(new Error(`nothing can start a ${dispatch.kind} on this daemon yet`));
    return this.lock.run(dispatch.identity.runId, async () => {
      const base = { runId: dispatch.identity.runId, artifactRef: dispatch.identity.artifactRef, stub: d.stub === true };
      if (await d.find(dispatch.identity)) return { ...base, adopted: true };
      await d.launch(dispatch);
      const ref = dispatch.identity.artifactRef;
      if (ref !== null) this.byArtifact.set(ref, [...(this.byArtifact.get(ref) ?? []).slice(-15), { kind: dispatch.kind, runId: dispatch.identity.runId }]);
      return { ...base, adopted: false };
    });
  }
}

/**
 * The TEST configuration's launcher (DES §13 A2): records each dispatch as one JSON line and starts nothing. Its own
 * record is what `find` reads, so a retry adopts the recorded dispatch exactly as a real launcher adopts an engine run.
 */
export class RecordingStubDispatcher implements ProposalDispatcher {
  readonly stub = true;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every recorded dispatch, in order. */
  rows(): Array<{ at: number; kind: string; pid: string; chatId: string; runId: string; artifactRef: string | null; actor: string; title: string }> {
    if (!existsSync(this.file)) return [];
    const out = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a torn last line */
      }
    }
    return out;
  }

  async find(identity: ProposalIdentity): Promise<boolean> {
    return this.rows().some((r) => r.runId === identity.runId);
  }

  async launch(d: ProposalDispatch): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(this.file);
    appendFileSync(
      this.file,
      `${fresh ? '' : tornTailPrefix(this.file)}${JSON.stringify({ at: this.now(), kind: d.kind, pid: d.pid, chatId: d.chatId, runId: d.identity.runId, artifactRef: d.identity.artifactRef, actor: d.actor.id, title: d.resolution.what.title })}\n`,
      { mode: 0o600 },
    );
    if (fresh && process.platform !== 'win32') chmodSync(this.file, 0o600);
  }

  async live(): Promise<boolean> {
    return false;
  }
}

// ── cost ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A completed run's cost in dollars when it is wholly known, else `null` (DES §4.2: "a dollar figure only counts runs
 * whose every step reported a cost"). Every attempt the engine dispatched for an agent step (a tool step is no agent's)
 * must have reported a finite, priced usage frame; an unpriced frame, or a dispatched attempt with none (a retry on a
 * seat that reports nothing), makes the run's cost unknown.
 */
export function runCostFromEvents(view: SessionView, events: ReadonlyArray<Record<string, unknown>>): number | null {
  const agentOrds = view.units
    .filter((u) => (u as unknown as { routing?: { method?: string } | null }).routing?.method !== 'tool' && u.assigned_cli !== null)
    .map((u) => u.ord);
  if (agentOrds.length === 0) return null;
  const dispatched = new Set<string>();
  const priced = new Set<string>();
  const byOrd = new Map<number, number>();
  for (const e of events) {
    const ord = e['ord'] ?? e['unitOrd'];
    if (typeof ord !== 'number' || !agentOrds.includes(ord)) continue;
    const attempt = typeof e['attempt'] === 'number' ? e['attempt'] : 0;
    if (e['type'] === 'unitDispatched') dispatched.add(`${ord}:${attempt}`);
    if (e['type'] !== 'cliUsage') continue;
    const cost = e['costUsd'];
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
    priced.add(`${ord}:${attempt}`);
    byOrd.set(ord, (byOrd.get(ord) ?? 0) + cost);
  }
  if (agentOrds.some((o) => !byOrd.has(o))) return null;
  if ([...dispatched].some((k) => !priced.has(k))) return null;
  // The unit's durable attempt counter outranks a log that may have lost an attempt (a crash): EVERY attempt up to it
  // must be priced.
  for (const u of view.units) {
    const last = (u as unknown as { last_attempt?: unknown }).last_attempt;
    if (!agentOrds.includes(u.ord) || typeof last !== 'number' || !Number.isInteger(last) || last < 0) continue;
    for (let a = 0; a <= last; a += 1) if (!priced.has(`${u.ord}:${a}`)) return null;
  }
  return agentOrds.reduce((sum, o) => sum + (byOrd.get(o) ?? 0), 0);
}

// ── resolution ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The workflow each operation's run is. */
export const PROPOSAL_WORKFLOWS: Readonly<Record<Exclude<ArtifactProposalKind, 'theme' | 'job' | 'onboard'>, string>> = {
  create: 'interactive-draft',
  refine: 'interactive-chat',
  demo: 'demo',
};

const STOPS: Readonly<Record<Exclude<ArtifactProposalKind, 'theme' | 'job' | 'onboard'>, string>> = {
  create: 'Stops for you if the check fails. The plan or an escalation may also ask.',
  refine: 'Stops for you if the check fails. The plan or an escalation may also ask.',
  demo: 'Stops for you after the script and after the review.',
};

const STYLE_LABEL: Readonly<Record<string, string>> = { ppt: 'Slides', web: 'Web page', doc: 'Document', brochure: 'Brochure' };
const NOUN: Readonly<Record<Exclude<ArtifactProposalKind, 'theme' | 'job' | 'onboard'>, [string, string]>> = {
  create: ['document', 'documents'],
  refine: ['revision', 'revisions'],
  demo: ['demo video', 'demo videos'],
};
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'cancelled', 'failed']);
const STATUS_WORDS: Readonly<Record<string, string>> = {
  completed: 'finished',
  cancelled: 'stopped',
  failed: 'failed',
  awaiting_human: 'waiting for you',
};
/** Completed runs read for a time median, newest first. */
const MEDIAN_RUNS = 20;
/** Of those, the newest whose costs are read (each needs the run's event log). */
const COST_RUNS = 10;
/** Runs a dollar median needs (DES §4.2). */
const COST_MIN_RUNS = 3;

/** The chat as the resolver sees it. */
export interface ProposalChat {
  /** The project the chat is filed in; `null` = none. */
  projectId: string | null;
  /** Its repositories (names and ids). */
  repos: ReadonlyArray<{ id: string; name: string }>;
  /** The lead seat (the path's PA, once known) and the chat's eligible seats. */
  lead: string | null;
  seats: readonly string[];
  /** An analysis chat (`POST /chats {workflow}`) proposes nothing (DES §3), whatever its seat writes. */
  analysis: boolean;
}

/** A chat job's run, as typed plan edits read it (DES-CATALOG-002 §2.4). */
export type HeldPlan =
  | { state: 'held'; ord: number; planRev: number; reshapeable: boolean; lead: string | null }
  | { state: 'running' | 'ended' };

export interface ChatProposalDeps {
  /** The operations crew advertises (and `proposals`). */
  flags(): ChatArtifactsCapabilities;
  /**
   * A5 (DES §6.1-6.2): the person's protected edits of a document at a version (`interactive/protected-edits.ts`), with
   * `touched` for the anchors given. An error = they cannot be read or checked on this host: a refine card is blocked
   * (it could never land). Absent = refine is not built on this daemon (the card shows none).
   */
  protectedEdits?: (artifactRef: string, version: number, touch: readonly string[]) => Promise<{ ok: true; entries: ProtectedEdit[] } | { ok: false; error: string }>;
  /** The catalog entries (`workflow-catalog/catalog-data.ts`). */
  catalog: readonly CatalogSeed[];
  /** The chat's records: the live transcript, or the kept history copy once it has ended. */
  records(chatId: string): ChatTranscriptRecord[];
  /** Append one proposal record to the live transcript, or the kept copy once ended; `false` when neither exists. */
  append(chatId: string, record: ProposalRecord): boolean;
  /** The chat's instance (its history entry's own nonce): a reused id is a different chat. `null` = unknown. */
  instanceOf(chatId: string): string | null;
  /** The chat's project (live, or as its history recorded it once it has ended); `null` = none. */
  projectOf(chatId: string): string | null;
  /** The live chat, or `null` once it has ended. */
  chat(chatId: string): ProposalChat | null;
  /** Seats that can work now, in roster order (enabled for council, work-eligible, not signed out), under the default
   *  launch rule: no opt-in seat unless it is the only one left (`proposalRoster` in routes.ts, F43). */
  rosterEligible(): ReadonlyArray<{ key: string; name: string }>;
  /** Every run, decorated as `GET /runs` serves it (`project_id`, `document_id`, `run_identity`, times). */
  runs(): Promise<SessionView[]>;
  /** The chat a run was filed under, and whether it is a chat's own ask path. */
  chatOfRun(runId: string): string | undefined;
  isAskPath(runId: string): boolean;
  /** The docs root of a project (`default` = Unfiled); `null` = no such project. */
  docsRoot(projectId: string): Promise<string | null>;
  projectName(projectId: string): Promise<string | null>;
  /** A3: a project's repository members (registry ids and names); `null` = no such project. Absent = unknown (a
   *  project edit keeps no repository). */
  projectRepos?(projectId: string): Promise<Array<{ id: string; name: string }> | null>;
  /** This chat's attachments. */
  attachments(chatId: string): ReadonlyArray<{ id: string; name: string; bytes?: number; mediaType?: string }>;
  /** A3: the registry ids of the repositories registered now (a selected one unregistered since refuses Go). Absent =
   *  not checked. */
  repoIds?(): Promise<ReadonlySet<string>>;
  /** Steps of a workflow as a launch in this project resolves it, when known. */
  workflowSteps(name: string, projectId: string | null): Promise<number | null>;
  /** A completed run's cost when every agent step reported one, else `null`. */
  runCostUsd(view: SessionView): Promise<number | null>;
  registry: LaunchOnceRegistry;
  /** (DES-CATALOG-002 §4.6) Job proposals are on (`capabilities.chatJobProposals`). Absent = off. */
  jobs?(): boolean;
  /** CS4: the sources a job in this project can read, the web included when installed, in display order. */
  jobSources?(projectId: string | null): Promise<Array<{ id: string; label: string; reason?: string; web?: true }>>;
  /** (e2e-1105 CJ3) Why the web can't be read in this project when it is set up for other projects only. */
  webReason?(projectId: string | null): Promise<string | undefined>;
  /** (§2.5) Answer a reshape's held plan Reject (`reshaped`), checked eligible and bound to its ord and plan revision
   *  inside the engine's decision. `null` when it was answered; else the refusal. */
  reshapeReject?(heldRunId: string, actor: Actor, pid: string, expect?: { ord: number; planRev: number }): Promise<DecideResult | null>;
  /** What a launch of this proposal would refuse that can be checked before anything changes; `null` = nothing. */
  preflight?(p: ArtifactProposal): Promise<string | null>;
  /** The daemon's QE acceptance setting is off (the launch skips QE by setting, labelled). Absent = on. */
  qeOff?(): Promise<boolean>;
  /** (api-types 0.196.0) Why this job can't run as a power run on this daemon now; `null` = it can. Absent = no job can. */
  powerRefusal?(p: ArtifactProposal): Promise<string | null>;
  /** (api-types 0.196.0) Where this daemon has power mode and Power mode for new jobs is on, the presets a power launch
   *  in `projectId` accepts (a job's Start then chooses how it runs); else `null`. Absent = none. */
  powerPresets?(projectId: string | null): Promise<ReadonlySet<string> | null>;
  /** (CJ13) The seats that wrote the change a review-change job's words name, in `repoRef` (the launch's own
   *  exclusion); `null` when it cannot be read (the launch then decides). Absent = none excluded. */
  reviewAuthors?(repoRef: string, words: string): Promise<readonly string[] | null>;
  /** Whether the chat's client renders job proposals (`accepts: ['job']`, its newest declaration). Absent = no. */
  acceptsJobs?(chatId: string): boolean;
  /** (crew-0182) Whether the chat's client draws onboard cards (`accepts: ['onboard']`, its newest declaration). */
  acceptsOnboard?(chatId: string): boolean;
  /** (crew-0182) What an onboard block is resolved against. Absent = onboard cards are not made here. */
  onboard?: OnboardResolveDeps;
  /** What the v2 catalog resolves against now, as a launch filed in `projectId` reads it. */
  served?(projectId: string | null): Promise<ServedState & { rev: string }>;
  /**
   * (DES-CATALOG-002 §2.4, §2.5) The state of a chat job's run: `held` at a plan gate (its ord and plan revision, and
   * whether it is still its FIRST work-plan approval, where a reshape is possible), `running` past it, `ended`. `null` =
   * no such run. Absent = plan offers are off.
   */
  heldPlan?(runId: string): Promise<HeldPlan | null>;
  /** Whether a chat turn is still live (a seat of it has not answered, and it has not gone stale). Absent = unknown
   *  (treated as live). */
  turnLive?(chatId: string, turnId: string): boolean;
  broadcast(frame: CoreEvent): void;
  audit(event: string, actor: Actor, detail: Record<string, unknown>): void;
  now?: () => number;
  log?: (msg: string) => void;
}

/** The project a mount names (`null` for Unfiled). */
const projectOfMount = (mount: string): string | null => (mount === UNFILED_MOUNT ? null : mount);
/** The mount a run is filed in. */
function runMount(view: SessionView): string {
  const p = (view.session as { project_id?: string | null }).project_id;
  return p === undefined || p === null || p === '' || p === 'default' ? UNFILED_MOUNT : p;
}
const isLive = (v: SessionView): boolean => !TERMINAL.has(String(v.session.status));
const workflowOf = (v: SessionView): string | null => {
  const s = v.session as { run_identity?: { name?: string | null } | null; workflow_id?: string | null };
  return s.run_identity?.name ?? s.workflow_id ?? null;
};
const secondsOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const humanDoc = (doc: string): string => doc.replace(/-/g, ' ');

/** What the turn's seats were given (the turn's `context` record), else the latest one before the turn — never a
 *  later turn's. */
function bindingOf(records: readonly ChatTranscriptRecord[], turnId: string): { binding: ChatContextBinding | null; turnHas: boolean } {
  const own = records.find((r): r is Extract<ChatTranscriptRecord, { kind: 'context' }> => r.kind === 'context' && r.turnId === turnId);
  if (own !== undefined) return { binding: own, turnHas: true };
  let latest: ChatContextBinding | null = null;
  for (const r of records) {
    if (r.turnId === turnId) break;
    if (r.kind === 'context') latest = r;
  }
  return { binding: latest, turnHas: false };
}

/** Hosts the demo recorder can reach (DES §10: a loopback-only jail). The seat's instructions name the same three
 *  (`chat-scope.ts`; a test keeps them equal). */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Every http(s) address in the person's words, whole (trailing sentence punctuation dropped). */
function personUrls(words: string): Set<string> {
  const out = new Set<string>();
  for (const m of words.matchAll(/https?:\/\/[^\s"'<>`]+/gu)) {
    // Sentence punctuation after an address is not part of it; a bracketed IPv6 host's own ']' is.
    let url = m[0].replace(/[.,;:!?)}]+$/u, '');
    if (url.endsWith(']') && !/^https?:\/\/\[[^\]]*\]$/u.test(url)) url = url.replace(/\]+$/u, '');
    out.add(url);
  }
  return out;
}

/**
 * The ONE app address a person's words name, exactly as typed, or `null` = ask the person (review r1/r2 on the seed
 * fill). When in doubt it asks rather than guess, because the question's own field answers it (studio#1134): not exactly
 * one complete http(s) address in any letter case; one wrapped in or running into anything but whitespace (a quote,
 * bracket or code span); one ending in a character a sentence could have added (`.`, `)`, …: trimming it could change
 * the page); one with a `#`; one that does not parse or is over the launch's 2048 characters.
 */
export function onePersonUrl(words: string): string | null {
  const all = [...words.matchAll(/https?:\/\/[^\s"'<>`]+/giu)];
  if (all.length !== 1) return null;
  const m = all[0]!;
  const url = m[0];
  const before = m.index === 0 ? '' : words.charAt(m.index - 1);
  const after = words.charAt(m.index + url.length);
  if ((before !== '' && !/\s/u.test(before)) || (after !== '' && !/\s/u.test(after))) return null;
  if (/[.,;:!?)}\]]$/u.test(url) && !/^https?:\/\/\[[^\]]*\]$/iu.test(url)) return null;
  if (url.includes('#') || url.length > 2048) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return url;
}

/**
 * The person's own words in this chat, up to and including the turn: only `user` records the message route marked as
 * sent by the chat's owner, a person (`owner: true`). A message from an agent's or another actor's token never counts
 * as the person's (a demo address, a document they named).
 */
function personWords(records: readonly ChatTranscriptRecord[], turnId: string): string {
  const out: string[] = [];
  for (const r of records) {
    if (r.kind === 'user') {
      if (r.owner === true) out.push(r.text);
      if (r.turnId === turnId) break;
    }
  }
  return out.join('\n');
}

/** (DES-CATALOG-002 §2.3) A proposal whose detection is still unsure (`ask`) holds no Start: its question is the guess's. */
export function withAskOverlay(p: ArtifactProposal): ArtifactProposal {
  const q = p.shape?.guess?.band === 'ask' ? p.shape.guess.question : null;
  if (q === null || q === undefined) return p;
  return { ...p, blocked: q.text, question: null, suggestions: [], ...(p.sentence !== undefined ? { sentence: { ...p.sentence, ask: q.text } } : {}) };
}

/** (DES-CATALOG-002 §2.3) Whether an entry block routes a job card of the v2 catalog (its id is a detectable card's,
 *  or it carries the routing fields a job block has). */
export function isJobCardEntry(block: { entry: string; option?: string | null | undefined; confidence?: number | undefined }): boolean {
  const card = CATALOG_V2_CARDS.find((c) => c.id === block.entry);
  return (card !== undefined && detectable(card)) || block.option !== undefined || block.confidence !== undefined;
}

/** The person's own words of ONE turn (the message the seat's block answers). */
function turnWords(records: readonly ChatTranscriptRecord[], turnId: string): string {
  const r = records.find((x): x is Extract<ChatTranscriptRecord, { kind: 'user' }> => x.kind === 'user' && x.turnId === turnId && x.owner === true);
  return r?.text ?? '';
}

/**
 * Whether the person's own words name a document by its whole ref (`mount/doc`, or `doc:mount/doc`; studio's `default`
 * mount alias for an Unfiled one): a longer name or path (`mount/doc-2`, `mount/doc_x`, `mount/doc/notes`,
 * `mount/doc.html`) is not it. Sentence punctuation after it is.
 */
function wordsNameRef(words: string, ref: string): boolean {
  const spellings = ref.startsWith(`${UNFILED_MOUNT}/`) ? [ref, `default/${ref.slice(UNFILED_MOUNT.length + 1)}`] : [ref];
  return spellings.some((r) => {
    const esc = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9._/-])(?:doc:)?${esc}(?![A-Za-z0-9_-]|[./][A-Za-z0-9_-])`, 'u').test(words);
  });
}

/** The title an earlier turn's `context` record gave the document, when one did (the chat had it open). */
function titleSeen(records: readonly ChatTranscriptRecord[], ref: string, turnId: string): string | null {
  let title: string | null = null;
  for (const r of records) {
    if (r.kind === 'context' && r.artifact?.ref === ref) title = r.artifact.title;
    if (r.kind === 'user' && r.turnId === turnId) break;
  }
  return title;
}

/** Why an edit was refused, as the 400 says it. */
class EditRefusal extends Error {}

/** The one block a person can lift from the card (Change something → two helpers); every other block is the record's. */
const NEEDS_HELPER = 'Needs a second helper to check it';

export interface DecideResult {
  code: number;
  body: Record<string, unknown>;
}

/** A reshape's immutable context (the held run it replaces, its envelope, inherited reduced assurance) survives every
 *  re-resolution of its proposal: a revision, a catalog refresh (codex r1). */
function keepReshape(next: ArtifactProposal, from: ArtifactProposal): ArtifactProposal {
  return {
    ...next,
    ...(from.reshapes !== undefined ? { reshapes: from.reshapes } : {}),
    ...(from.relaunch !== undefined ? { relaunch: from.relaunch } : {}),
    ...(from.reducedAssurance === true ? { reducedAssurance: true as const } : {}),
    ...(from.heldRejected === true ? { heldRejected: true as const } : {}),
    // The plan version the reshape was offered on stays with every descendant (codex r2 on Lane D).
    ...(from.heldPlan !== undefined ? { heldPlan: from.heldPlan } : {}),
  };
}

export class ChatProposals {
  private readonly lock = new KeyedLock();
  /** Per chat: resolutions publish in the order their replies were folded (a slow one never lands after a newer one). */
  private readonly order = new KeyedLock();
  private readonly pending = new Set<Promise<void>>();
  private readonly costs = new Map<string, number | null>();
  /** Holds being written (`<chat>\0<turn>`): a reply to that turn waits for its hold first (codex r2). */
  private readonly holding = new Map<string, Promise<void>>();
  /** Turns whose reply is being settled (`<chat>\0<turn>` → replies in flight): their holds are not gone. */
  private readonly settling = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: ChatProposalDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  /** What a seat may be told it can make now (`chat-scope.ts`'s per-message digest). With a chat id, how the chat routes
   *  new work too (DES-CATALOG-002 §2.3: job cards for a client that renders them, a command line for an older one).
   *  `o.appearance` (A7): whether the message carried the tab's appearance. A client that sends none cannot preview or
   *  apply a theme, so its seat is not told it can propose one (absent = not known here: the flag alone decides). */
  digest(chatId?: string, accepts?: boolean, o: { appearance?: boolean; onboard?: boolean } = {}): MakeDigest {
    const f = this.deps.flags();
    const on = f.proposals;
    const entries = on
      ? this.deps.catalog.flatMap((c): Array<MakeDigest['entries'][number]> => {
          if (c.status === 'coming_soon') return [];
          if (c.launch.kind === 'document' && f.create) return [{ id: c.id, title: c.title ?? c.id, kind: 'document' as const, outcome: c.outcome }];
          if (c.launch.kind === 'demo' && f.demo) return [{ id: c.id, title: c.title ?? c.id, kind: 'demo' as const, outcome: c.outcome }];
          return [];
        })
      : [];
    // A create or demo with no catalog entry to name is not on (the seat is told nothing it could propose).
    const jobs: MakeDigest['jobs'] = chatId === undefined || !this.jobsOn() ? undefined : (accepts ?? this.acceptsJobs(chatId)) ? 'cards' : 'prose';
    return {
      create: on && f.create && entries.some((e) => e.kind === 'document'),
      refine: on && f.refine,
      theme: on && f.theme && o.appearance !== false,
      demo: on && f.demo && entries.some((e) => e.kind === 'demo'),
      // crew-0182: the onboard block, for a client that draws the card (its seat is told only then).
      // `o.onboard`: this message's own declaration (the chat's stored one changes only once the message is accepted).
      ...(on && f.onboard === true && chatId !== undefined && this.deps.onboard !== undefined && (o.onboard ?? this.deps.acceptsOnboard?.(chatId)) === true ? { onboard: true } : {}),
      entries,
      ...(jobs !== undefined ? { jobs } : {}),
    };
  }

  /** Resolutions still in flight (tests wait on them). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /**
   * A seat's reply was folded with the `wicked-make` bodies cut from it. Resolution reads crew's records (it awaits),
   * so it runs off the fold; the record is appended only if the chat is still the same instance.
   */
  onReply(frame: { chat: string; cliKey: string; turnId?: string; ok: boolean; blocks: readonly string[] }): void {
    // DES-CATALOG-002 §2.3: for a client that draws job cards, one request yields at most one actionable block: the
    // FIRST valid one of any kind (a job, a revision, a plan edit, a refine, a theme), and only it is read (codex r1).
    if (frame.blocks.length > 1 && this.jobsOn() && this.acceptsTurn(frame.chat, frame.turnId)) {
      const first = frame.blocks.find((b) => parseMakeBlock(b) !== null || parseRevisionBlock(b) !== null || parsePlanEditBlock(b) !== null);
      frame = { ...frame, blocks: first === undefined ? [] : [first] };
    }
    // DES-CATALOG-002 §4.6: the turn's revision of a held job proposal (or the hold's release), first.
    this.onTurnReply(frame);
    if (frame.blocks.length === 0 || frame.turnId === undefined || !frame.ok) return;
    if (!this.deps.flags().proposals) return;
    // DES-CATALOG-002 §2.3: with job routing on, one routing protocol: the FIRST valid block is the one actionable card,
    // and at a job's held plan a plan edit or a change of job becomes wicked's offer instead.
    // An older client (no job cards) keeps today's reading: the last valid block, no plan offers it could not draw.
    const jobs = this.jobsOn() && this.acceptsTurn(frame.chat, frame.turnId);
    if (jobs && this.onPlanReply(frame)) return;
    const block = jobs ? firstValidBlock(frame.blocks) : lastValidBlock(frame.blocks);
    if (block === null) {
      this.log(`[proposals] chat ${frame.chat}: ${frame.blocks.length} wicked-make block(s) from ${frame.cliKey}, none valid — no card`);
      return;
    }
    const instance = this.deps.instanceOf(frame.chat);
    const turnId = frame.turnId;
    // Chained per chat: a proposal resolves after every earlier reply's, so a slow resolution can never be appended
    // after (and so supersede) a newer turn's card.
    const job = this.order.run(`chat\u0000${frame.chat}`, async () => {
      // Nothing of a chat that ended and reused its id is read for this (older) reply.
      if (this.deps.instanceOf(frame.chat) !== instance) return;
      const pid = `${frame.chat}:${turnId}`;
      const has = (): boolean => {
        const rs = this.deps.records(frame.chat);
        // One proposal per turn (a second seat answering the same turn never replaces it), and none for a turn once a
        // later turn has its own card (a slow seat's late reply never takes the chat back).
        const order = rs.filter((r) => r.kind === 'user').map((r) => r.turnId);
        const mine = order.indexOf(turnId);
        // A reply can fold before its own turn's record is written (the route records it after the engine accepted the
        // message): such a turn is the newest, and only its own card suppresses it.
        return rs.some((r) => r.kind === 'proposal' && (r.proposal.pid === pid || (mine !== -1 && r.proposal.turnId !== null && order.indexOf(r.proposal.turnId) > mine)));
      };
      if (has()) return;
      // Give the route a moment to record the turn's own words and context (they authorize what the block names).
      for (let i = 0; i < 25 && !this.deps.records(frame.chat).some((r) => r.kind === 'user' && r.turnId === turnId); i += 1) {
        await new Promise((res) => setTimeout(res, 200));
      }
      if (this.deps.instanceOf(frame.chat) !== instance || has()) return;
      // An older client draws no job card: its statement asks for the command in prose, and its artifact entries (the
      // documents and the demo) keep today's path.
      const jobBlock = jobs && block.op === 'entry' && isJobCardEntry(block);
      const proposal = jobBlock
        ? await this.resolveDetected({ chatId: frame.chat, turnId, seat: frame.cliKey, block: block as Extract<ParsedMake, { op: 'entry' }>, records: this.deps.records(frame.chat) })
        : await this.resolve({ chatId: frame.chat, turnId, seat: frame.cliKey, block, records: this.deps.records(frame.chat) });
      if (proposal === null) return;
      // A job card never appears after the person has written again (codex r4): a newer message ("never mind") supersedes a
      // slow reply's detection.
      if (jobBlock && this.newerMessage(frame.chat, turnId)) {
        this.log(`[proposals] chat ${frame.chat}: turn ${turnId}'s job card came after a newer message — dropped`);
        return;
      }
      // Published under the chat's lock, so it never lands between an accept's checks and its record.
      await this.lock.run(`chat\u0000${instance ?? frame.chat}`, async () => {
        // DES-CATALOG-002 §4.6 (codex r1): a chat whose job lineage is open is changed only through a revision (merged,
        // loss-checked); a seat's root block never replaces it.
        const jobOpen = [...foldProposals(this.deps.records(frame.chat)).values()].some((f) => f.proposal.shape !== undefined && (f.state === 'open' || f.state === 'revising'));
        if (jobOpen) this.log(`[proposals] chat ${frame.chat}: turn ${turnId}'s block would replace the open job; a change to it is a revision — dropped`);
        else if (!has() && !(jobBlock && this.newerMessage(frame.chat, turnId))) this.write(frame.chat, { at: this.now(), turnId, kind: 'proposal', proposal }, instance);
      });
    })
      .catch((err: unknown) => this.log(`[proposals] chat ${frame.chat}: turn ${turnId}'s proposal could not be resolved: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  /** Whether the person has written again since `turnId` (its reply is then an older one). */
  private newerMessage(chatId: string, turnId: string): boolean {
    const order = this.deps.records(chatId).filter((r) => r.kind === 'user').map((r) => r.turnId);
    const mine = order.indexOf(turnId);
    return mine !== -1 && mine < order.length - 1;
  }

  /** Append a record and send it on `/ws` — only while the chat is still the instance the caller acted on. */
  private write(chatId: string, record: ProposalRecord, instance: string | null): boolean {
    if (this.deps.instanceOf(chatId) !== instance) {
      this.log(`[proposals] chat ${chatId} ended and its id was reused — ${record.kind} not recorded on the new chat`);
      return false;
    }
    if (!this.deps.append(chatId, record)) {
      this.log(`[proposals] chat ${chatId}: no transcript to record ${record.kind} on`);
      return false;
    }
    const projectId = this.deps.projectOf(chatId);
    const frame: ChatProposalFrame = { type: 'chatProposal', chat: chatId, turn_id: record.turnId, record, ...(projectId !== null ? { project_id: projectId } : {}) };
    this.deps.broadcast(frame);
    return true;
  }

  /**
   * The block → a card's facts. `null` when the operation is not advertised (the seat was never told about it) or the
   * chat has ended: no card. Everything else resolves, with what cannot be resolved struck or blocking Go.
   */
  async resolve(input: { chatId: string; turnId: string; seat: string; block: ParsedMake; records: readonly ChatTranscriptRecord[] }): Promise<ArtifactProposal | null> {
    const { chatId, turnId, seat, block, records } = input;
    const flags = this.deps.flags();
    const chat = this.deps.chat(chatId);
    if (chat === null) return null;
    if (chat.analysis) {
      this.log(`[proposals] chat ${chatId} is an analysis: it proposes nothing — no card`);
      return null;
    }
    const pid = `${chatId}:${turnId}`;
    const words = personWords(records, turnId);
    const { binding, turnHas } = bindingOf(records, turnId);
    const blocked: string[] = [];
    const filedIn = async (projectId: string | null): Promise<ArtifactProposal['filedIn']> => ({
      projectId,
      label: projectId === null ? 'Not in a project · this chat' : ((await this.deps.projectName(projectId)) ?? projectId),
    });

    if (block.op === 'onboard') {
      // Only for a client that draws the card (its seat was told the block exists only then).
      if (flags.onboard !== true || this.deps.onboard === undefined || this.deps.acceptsOnboard?.(chatId) !== true) return this.refused(chatId, 'onboard');
      return resolveOnboard(block, { pid, chatId, turnId, seat, chatProjectId: chat.projectId === null || chat.projectId === 'default' ? null : chat.projectId }, this.deps.onboard);
    }

    if (block.op === 'theme') {
      if (!flags.theme) return this.refused(chatId, 'theme');
      const patch = block.theme.patch as Record<string, string | number | boolean>;
      return {
        pid, chatId, turnId, kind: 'theme', seat,
        what: { entry: null, title: block.theme.name, label: `Theme · ${block.theme.name}`, outcome: 'A studio appearance you preview, then apply. Nothing else changes.' },
        brief: null,
        reason: block.reason ?? null,
        sources: [],
        repos: [],
        helpers: null,
        time: null,
        stops: null,
        filedIn: { projectId: null, label: 'Your studio settings' },
        theme: { name: block.theme.name, patch, changes: Object.keys(patch) },
        blocked: null,
      };
    }

    if (block.op === 'refine') {
      if (!flags.refine) return this.refused(chatId, 'refine');
      const ref = parseArtifactRef(block.refine);
      let target: ArtifactProposal['target'];
      let protectedList: ProtectedEdit[] | undefined;
      let projectId = chat.projectId;
      if (ref === null) {
        blocked.push(`“${block.refine}” is not a document studio knows`);
      } else {
        const open = binding?.artifact?.ref === ref.ref;
        const named = open || (binding?.named.docs ?? []).includes(ref.ref) || wordsNameRef(words, ref.ref);
        const mine = chatMount(chat.projectId);
        const title = open && binding?.artifact !== undefined ? binding.artifact.title : titleSeen(records, ref.ref, turnId) ?? humanDoc(ref.doc);
        // Authorized before anything of it is read: an unnamed or out-of-scope document is never resolved.
        if (!named) blocked.push(`${title} · not open or named in this chat`);
        else if (mine !== null && ref.mount !== mine) blocked.push(`${title} · not in this chat's project`);
        else {
          const root = await this.deps.docsRoot(ref.projectId);
          const head = root === null ? null : artifactHead(root, ref.doc);
          if (head === null) blocked.push(`${title} · no such document`);
          else {
            target = { ref: ref.ref, title, base: head };
            projectId = projectOfMount(ref.mount);
            // A5: the person's own edits this revision keeps (Keep it is the default; only they can let one change).
            const touch = [...block.touches, ...(open ? binding?.artifact?.anchors ?? [] : [])];
            const kept = await this.protectedOf(ref.ref, head, touch);
            if ('error' in kept) blocked.push(kept.error);
            else protectedList = kept.entries;
          }
        }
      }
      // A5: a change works from the document and the person's words; extra sources do not reach its run yet, so the
      // card says so instead of showing them as used (codex A5 r1).
      const sources = (await this.resolveSources(block.sources, { chatId, turnId, records, binding, turnHas, chat, words, personNamed: false })).map((src) =>
        src.status === 'ok' ? { ...src, status: 'struck' as const, reason: 'a change works from the document and your words; make a new document to use this source' } : src);
      const helpers = this.helpers(chat);
      if (helpers === null) blocked.push(NEEDS_HELPER);
      const title = target?.title ?? (ref !== null ? humanDoc(ref.doc) : block.refine);
      return {
        pid, chatId, turnId, kind: 'refine', seat,
        what: { entry: null, title, label: `Change · ${title}`, outcome: 'A new version of the document. Your own edits are kept.' },
        brief: block.ask,
        reason: block.reason ?? null,
        sources,
        repos: [],
        helpers,
        time: await this.timeOf('refine', null, projectId),
        stops: STOPS.refine,
        filedIn: await filedIn(projectId),
        ...(target !== undefined ? { target } : {}),
        ...(block.touches.length > 0 ? { touches: block.touches } : {}),
        ...(protectedList !== undefined ? { protected: protectedList } : {}),
        blocked: blocked[0] ?? null,
      };
    }

    // An entry: a document or a demo from the catalog.
    const seed = this.deps.catalog.find((c) => c.id === block.entry && (c.launch.kind === 'document' || c.launch.kind === 'demo'));
    const kind: ArtifactProposalKind = seed?.launch.kind === 'demo' || block.entry === 'demo-video' ? 'demo' : 'create';
    if (!flags[kind]) return this.refused(chatId, kind);
    if (seed === undefined || seed.status === 'coming_soon') blocked.push(`studio has no job called “${block.entry}”`);
    const style = seed !== undefined && seed.launch.kind === 'document' ? seed.launch.style : null;
    const title = block.title !== undefined && block.title !== '' ? block.title : seed?.title ?? block.entry;
    const repos: string[] = [];
    const repoRefs: string[] = [];
    for (const want of block.repos) {
      const hits = chat.repos.filter((r) => r.name === want || r.id === want);
      if (hits.length === 0) blocked.push(`${want} isn't in this chat's scope`);
      else if (hits.length > 1) blocked.push(`${want} names ${hits.length} repositories in this chat's scope (name it by id)`);
      else if (!repoRefs.includes(hits[0]!.id)) {
        repos.push(hits[0]!.name);
        repoRefs.push(hits[0]!.id);
      }
    }
    // A3 (§5.2): a chat-made document is grounded on the chat's scope. A block that names none, in a chat scoped to ONE
    // repository, is about that one; with several, nothing is guessed (the card says what it is about).
    if (kind === 'create' && block.repos.length === 0 && chat.repos.length === 1) {
      repos.push(chat.repos[0]!.name);
      repoRefs.push(chat.repos[0]!.id);
    }
    let demo: ArtifactProposal['demo'];
    if (kind === 'demo') {
      const url = block.url ?? '';
      let ok = false;
      try {
        const u = new URL(url);
        ok = u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        ok = false;
      }
      // DES §4.3 / §10: the address must come from the person, never from the model.
      if (url === '' || !ok) blocked.push('Needs the address of the running app');
      // Whole addresses only: a prefix, a substring or an address inside a query string is not one they gave.
      else if (!personUrls(words).has(url)) blocked.push('The app address must come from you: say it in the chat');
      // DES §10 (A8's build note): the recorder reaches only an app on this machine.
      else if (!LOCAL_HOSTS.has(new URL(url).hostname)) blocked.push('The recorder reaches only an app running on this machine (localhost)');
      demo = { url, audience: block.audience ?? null, show: block.show ?? null };
    }
    const sources = kind === 'create' ? await this.resolveSources(block.sources, { chatId, turnId, records, binding, turnHas, chat, words, personNamed: false }) : [];
    const helpers = this.helpers(chat);
    if (helpers === null) blocked.push(NEEDS_HELPER);
    return {
      pid, chatId, turnId, kind, seat,
      what: {
        entry: seed?.id ?? block.entry,
        title,
        label: `${kind === 'demo' ? 'Demo video' : (style !== null ? STYLE_LABEL[style] : undefined) ?? seed?.title ?? 'Document'} · ${title}`,
        outcome: seed?.outcome ?? null,
      },
      brief: kind === 'demo' ? (block.show ?? null) : (block.brief ?? null),
      reason: block.reason ?? null,
      sources,
      repos,
      ...(repoRefs.length > 0 ? { repoRefs } : {}),
      helpers,
      time: await this.timeOf(kind, seed ?? null, chat.projectId),
      stops: STOPS[kind],
      filedIn: await filedIn(chat.projectId),
      ...(demo !== undefined ? { demo } : {}),
      blocked: blocked[0] ?? null,
    };
  }

  private refused(chatId: string, kind: ArtifactProposalKind): null {
    this.log(`[proposals] chat ${chatId}: a ${kind} block, but ${kind} is not advertised on this daemon — no card`);
    return null;
  }

  /** The two helpers (DES §4.2): the lead seat, then another of the chat's seats, else the roster's next. */
  helpers(chat: ProposalChat, chosen?: readonly string[]): ProposalHelpers | null {
    const roster = this.deps.rosterEligible();
    const can = new Set(roster.map((s) => s.key));
    const name = (k: string): string => roster.find((s) => s.key === k)?.name ?? k;
    let seats: string[];
    if (chosen !== undefined) {
      seats = [...new Set(chosen)];
      if (seats.length !== 2 || seats.some((k) => !can.has(k))) return null;
    } else {
      const order = [chat.lead, ...chat.seats, ...roster.map((s) => s.key)].filter((k): k is string => k !== null && can.has(k));
      seats = [...new Set(order)].slice(0, 2);
      if (seats.length < 2) return null;
    }
    return { seats, label: `${name(seats[0]!)} and ${name(seats[1]!)}: one writes, the other checks` };
  }

  /** Time and cost: the catalog's band, the workflow's steps, and medians over completed runs here. */
  private async timeOf(kind: Exclude<ArtifactProposalKind, 'theme' | 'job' | 'onboard'>, seed: CatalogSeed | null, projectId: string | null): Promise<ProposalTime> {
    const workflow = PROPOSAL_WORKFLOWS[kind];
    const minutes = seed?.typicalMinutes ?? null;
    const cost = seed?.cost ?? null;
    const steps = await this.deps.workflowSteps(workflow, projectId).catch(() => null);
    const done = (await this.deps.runs())
      .filter((v) => String(v.session.status) === 'completed' && workflowOf(v) === workflow)
      .map((v) => ({ v, start: secondsOf((v.session as { created_at?: unknown }).created_at), end: secondsOf((v.session as { ended_at?: unknown }).ended_at) }))
      .filter((r): r is { v: SessionView; start: number; end: number } => r.start !== null && r.end !== null && r.end >= r.start)
      .sort((a, b) => b.start - a.start)
      .slice(0, MEDIAN_RUNS);
    let med: ProposalTime['median'] = null;
    if (done.length > 0) {
      const mins = median(done.map((r) => (r.end - r.start) / 60))!;
      const costs: number[] = [];
      for (const r of done.slice(0, COST_RUNS)) {
        const id = r.v.session.id;
        // A completed run's cost does not change: cached. A failed read is not (it is retried next time).
        let c = this.costs.get(id);
        if (c === undefined) {
          try {
            c = await this.deps.runCostUsd(r.v);
            this.costs.set(id, c);
          } catch {
            c = null;
          }
        }
        if (typeof c === 'number' && Number.isFinite(c)) costs.push(c);
      }
      med = {
        runs: done.length,
        minutes: Math.round(mins),
        costUsd: costs.length >= COST_MIN_RUNS ? Math.round(median(costs)! * 100) / 100 : null,
        costRuns: costs.length,
      };
    }
    const parts: string[] = [];
    if (minutes !== null) parts.push(`About ${minutes[0]}–${minutes[1]} min`);
    if (steps !== null) parts.push(`${steps} step${steps === 1 ? '' : 's'}`);
    if (med !== null) {
      const [one, many] = NOUN[kind];
      parts.push(`median of ${med.runs} past ${med.runs === 1 ? one : many} here: ${med.minutes} min${med.costUsd !== null ? `, $${med.costUsd.toFixed(2)}` : ''}`);
    }
    if (parts.length === 0 && cost !== null) parts.push(`${cost[0]!.toUpperCase()}${cost.slice(1)} cost`);
    return { minutes, cost, steps, median: med, label: parts.join(' · ') };
  }

  /**
   * Each source token, authorized (DES §4.2 "From"). A run or document must be named by the person in this chat (A1's
   * `named`, or the artifact open on this turn) — or, for an edit, added by the person now (`personNamed`) — and be in
   * the chat's scope and exist. What fails is struck with the reason; the draft never sees it.
   */
  private async resolveSources(
    tokens: readonly string[],
    ctx: {
      chatId: string;
      turnId: string;
      records: readonly ChatTranscriptRecord[];
      binding: ChatContextBinding | null;
      turnHas: boolean;
      chat: Pick<ProposalChat, 'projectId'>;
      /** The person's own words (owner-sent messages) up to the turn. */
      words: string;
      personNamed: boolean;
      /** Jobs admit whole attachments up to the upload cap and read only files and documents. */
      jobDocuments?: boolean;
      /** Draft documents are sized by their shared packet plan after scope authorization. */
      packetDocuments?: boolean;
    },
  ): Promise<ProposalSource[]> {
    const out: ProposalSource[] = [];
    const seen = new Set<string>();
    const mine = chatMount(ctx.chat.projectId);
    let runs: SessionView[] | null = null;
    const allRuns = async (): Promise<SessionView[]> => (runs ??= await this.deps.runs());
    const canonical = new Set<string>();
    const push = (src: ProposalSource): void => {
      // Two spellings of one source (a prefix and the full id) are one chip.
      if (canonical.has(src.token)) return;
      canonical.add(src.token);
      out.push(src);
    };
    const strike = (token: string, label: string, reason: string, projectId?: string | null): void => {
      push({ token, label, status: 'struck', reason, ...(projectId !== undefined ? { projectId } : {}) });
    };
    for (const raw of ctx.jobDocuments === true ? tokens : tokens.slice(0, PROPOSAL_SOURCES_MAX)) {
      const token = raw.trim();
      if (seen.has(token)) continue;
      seen.add(token);
      if (ctx.jobDocuments === true && !token.startsWith('attachment:') && !token.startsWith('doc:')) {
        strike(token, token.slice(0, 40), 'a job reads files and documents only');
        continue;
      }
      if (token === 'chat') {
        push({ token, label: 'this conversation', status: 'ok' });
        continue;
      }
      if (token === 'page') {
        // A3: studio's page summary rides with its message and is not kept after it, so a document cannot be made from
        // it later: struck with the reason, never promised on the card and then dropped at launch.
        strike(token, 'the page you were on', ctx.turnHas && ctx.binding?.page === true ? "studio's page summary is not kept after the message" : 'no page was shared with this message');
        continue;
      }
      const colon = token.indexOf(':');
      const kind = colon === -1 ? '' : token.slice(0, colon);
      const id = colon === -1 ? '' : token.slice(colon + 1).trim();
      if (kind === 'message') {
        // The turn's answer when it has one (the token is "one earlier answer"), else the person's own message.
        const answer = ctx.records.find((r) => r.kind === 'seat' && r.turnId === id && r.ok);
        const asked = ctx.records.find((r) => r.kind === 'user' && r.turnId === id);
        const rec = answer ?? asked;
        if (rec === undefined) strike(token, `message ${id.slice(0, 8)}`, 'not a message in this chat');
        else {
          const who = rec.kind === 'seat' ? `${rec.cliKey}'s answer` : 'your message';
          push({ token: `message:${id}`, label: `${who} at ${clock(rec.at)}`, status: 'ok', projectId: ctx.chat.projectId });
        }
        continue;
      }
      if (kind === 'attachment') {
        const a = this.deps.attachments(ctx.chatId).find((x) => x.id === id);
        if (a === undefined) strike(`attachment:${id}`, `attachment ${id.slice(0, 12)}`, 'not a file attached to this chat');
        // The document packet keeps its 512 KB cap; a job stages whole files up to the upload cap.
        else if (ctx.packetDocuments !== true && typeof a.bytes === 'number' && a.bytes > (ctx.jobDocuments === true ? ATTACHMENT_MAX_FILE_BYTES : 512 * 1024)) strike(`attachment:${a.id}`, a.name, ctx.jobDocuments === true ? 'too large for a job document (over 10 MB)' : 'too large for a document\'s sources (over 512 KB)');
        else push({ token: `attachment:${a.id}`, label: a.name, status: 'ok' });
        continue;
      }
      if (kind === 'run') {
        // A1's run-id grammar; an id matches exactly (custom ids keep their case), and a hex id or prefix also matches
        // case-insensitively (a uuid typed in capitals is the same run).
        const want = id;
        const short = want.slice(0, 8);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(want)) {
          strike(token, `run ${short}`, 'not a run id');
          continue;
        }
        // A1's rules: a custom id only by its exact spelling; a hex id exactly in any case; a hex prefix of 8+ digits.
        const hex = /^[0-9a-fA-F][0-9a-fA-F-]*$/.test(want);
        const low = want.toLowerCase();
        const pick = (ids: readonly string[]): string[] => {
          const exact = ids.filter((id) => id === want);
          if (exact.length > 0) return exact;
          if (!hex) return [];
          const ci = ids.filter((id) => id.toLowerCase() === low);
          if (ci.length > 0) return ci;
          // A complete uuid is exact-only (never a prefix of a longer id); a shorter hex id of 8+ digits is a prefix.
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(low)) return [];
          return low.replace(/-/g, '').length >= 8 ? ids.filter((id) => id.toLowerCase().startsWith(low)) : [];
        };
        // Authorized before anything of it is read: a seat's token is matched against the runs the person named in
        // this chat (full ids), never against every run on the daemon — an unnamed id learns nothing of what exists.
        // A source the person adds is theirs to name, and is looked up.
        let candidates: string[];
        if (ctx.personNamed) {
          candidates = pick((await allRuns()).map((v) => v.session.id));
        } else {
          candidates = pick(ctx.binding?.named.runs ?? []);
          if (candidates.length === 0) {
            strike(`run:${want}`, `run ${short}`, 'not named in this chat');
            continue;
          }
        }
        const hit = candidates.length === 1 ? candidates[0]! : null;
        if (candidates.length > 1) {
          strike(`run:${want}`, `run ${short}`, 'matches more than one run');
          continue;
        }
        const v = hit === null ? undefined : (await allRuns()).find((x) => x.session.id === hit);
        if (v === undefined) {
          strike(`run:${want}`, `run ${short}`, candidates.length > 1 ? 'matches more than one run' : 'no such run on this daemon');
          continue;
        }
        const label = `run ${v.session.id.slice(0, 8)} · ${STATUS_WORDS[String(v.session.status)] ?? 'running'}`;
        const projectId = projectOfMount(runMount(v));
        if (mine !== null && runMount(v) !== mine) strike(`run:${v.session.id}`, `run ${v.session.id.slice(0, 8)}`, "not in this chat's project", projectId);
        else push({ token: `run:${v.session.id}`, label, status: 'ok', projectId });
        continue;
      }
      if (kind === 'doc') {
        const ref = parseArtifactRef(id);
        if (ref === null) {
          strike(token, id.slice(0, 40), 'not a document reference');
          continue;
        }
        const projectId = projectOfMount(ref.mount);
        const open = ctx.binding?.artifact?.ref === ref.ref ? ctx.binding.artifact : undefined;
        const named = ctx.personNamed || open !== undefined || (ctx.binding?.named.docs ?? []).includes(ref.ref) || wordsNameRef(ctx.words, ref.ref);
        const title = open?.title ?? titleSeen(ctx.records, ref.ref, ctx.turnId) ?? humanDoc(ref.doc);
        if (!named) {
          strike(`doc:${ref.ref}`, title, 'not open or named in this chat', projectId);
          continue;
        }
        if (mine !== null && ref.mount !== mine) {
          strike(`doc:${ref.ref}`, title, "not in this chat's project", projectId);
          continue;
        }
        const root = await this.deps.docsRoot(ref.projectId);
        const head = root === null ? null : artifactHead(root, ref.doc);
        if (head === null) strike(`doc:${ref.ref}`, title, 'no such document', projectId);
        else push({ token: `doc:${ref.ref}`, label: `${title} v${head}`, status: 'ok', projectId });
        continue;
      }
      strike(token, token.slice(0, 40), 'not a source studio knows');
    }
    return out;
  }

  /** Authorise the files a job reads against this chat, its named documents and its current project scope. */
  async authorizeDocuments(chatId: string, tokens: readonly string[]): Promise<ProposalSource[]> {
    // Launch-time callers use the latest binding; proposal resolution uses its own turn's snapshot below.
    return this.authorizeDocumentsAt(chatId, tokens, this.deps.records(chatId), '\u0000');
  }

  private async authorizeDocumentsAt(chatId: string, tokens: readonly string[], records: readonly ChatTranscriptRecord[], turnId: string, packetDocuments = false, cache = false): Promise<ProposalSource[]> {
    tokens = tokens.slice(0, 20);
    const chat = this.deps.chat(chatId);
    if (chat === null) return [...new Set(tokens.map((t) => t.trim()))].map((token) => ({ token, label: token.slice(0, 40), status: 'struck', reason: 'the chat has ended' }));
    const scoped = await this.resolveSources(tokens, { chatId, turnId, records, ...bindingOf(records, turnId), chat, words: personWords(records, turnId), personNamed: false, jobDocuments: true, packetDocuments });
    if (!packetDocuments) return scoped;
    const deps = this.deps.registry.documentPacketDeps();
    const planned = deps === null ? [] : await documentPathPlan(scoped.filter((s) => s.status === 'ok').map((s) => s.token), chatId, deps, { cache });
    return scoped.map((s) => {
      if (s.status !== 'ok') return s;
      const plan = planned.find((p) => p.token === s.token);
      return plan?.status === 'ok' ? s : { ...s, status: 'struck', reason: plan?.reason ?? 'document packet readers are unavailable' };
    });
  }

  // ── the answer ───────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `POST /chats/:id/proposals/:pid` after the route's capability, person and owner checks. `instance` is the chat
   * instance those checks passed against: nothing is read for, or written to, a chat that reused the id since. One
   * lock per proposal: a second tab or a double click waits for the first and gets its result.
   */
  decide(chatId: string, pid: string, body: { decision: 'go' | 'not_now'; edits?: ProposalEdits | undefined; power?: boolean | undefined }, actor: Actor, instance: string | null): Promise<DecideResult> {
    // Keyed by the pid alone (it is unique: `<chat>:<turn uuid>`), so the same proposal answered through an ended chat's
    // archived alias still waits for an in-flight answer through its first name.
    return this.lock.run(`pid\u0000${pid}`, () => this.decideLocked(chatId, pid, body, actor, instance));
  }

  private gone(chatId: string): DecideResult {
    return { code: 409, body: { code: 'chat_gone', error: `chat ${chatId} ended and its id was reused; this proposal can no longer be answered here` } };
  }

  private async decideLocked(chatId: string, pid: string, body: { decision: 'go' | 'not_now'; edits?: ProposalEdits | undefined; power?: boolean | undefined }, actor: Actor, instance: string | null): Promise<DecideResult> {
    if (this.deps.instanceOf(chatId) !== instance) return this.gone(chatId);
    const records = this.deps.records(chatId);
    const folded = foldProposals(records).get(pid);
    if (folded === undefined) return { code: 404, body: { error: `no proposal ${pid} in chat ${chatId}` } };
    const kind = folded.proposal.kind;
    // (api-types 0.196.0) How it runs is a job's Start's choice, and nothing else's.
    if (body.power !== undefined && (kind !== 'job' || body.decision !== 'go')) {
      return { code: 400, body: { code: 'power_not_applicable', error: kind !== 'job' ? 'only a job runs as a power run' : 'how a job runs is chosen with Start, not Not now' } };
    }
    const reread = (): FoldedProposal => foldProposals(this.deps.records(chatId)).get(pid) ?? folded;
    const ok = (f: FoldedProposal): DecideResult => ({ code: 200, body: { view: viewOf(f) } });

    // 1. What already happened, before any state check.
    if (folded.state === 'decided') {
      if (folded.decision === body.decision) return ok(folded);
      return { code: 409, body: { code: 'proposal_decided', error: `this proposal was already answered (${folded.decision === 'go' ? 'started' : 'not now'})`, view: viewOf(folded) } };
    }
    if (folded.state === 'accepting' && folded.accepting !== undefined) {
      const acc = folded.accepting;
      const found = await this.deps.registry.find(kind, acc.identity);
      if (found !== null) {
        // Its run exists: adopt it and decide (a crash after the launch, or a lost response).
        const result: ProposalResult = { runId: acc.identity.runId, artifactRef: acc.identity.artifactRef, adopted: true, stub: found.stub };
        if (!this.decided(chatId, folded.turnId, pid, actor, 'go', result, acc.resolution, acc.edits, instance)) return this.gone(chatId);
        const after = reread();
        if (body.decision === 'go') return ok(after);
        return { code: 409, body: { code: 'proposal_decided', error: 'this proposal had already started', view: viewOf(after) } };
      }
      if (body.decision === 'not_now') {
        if (!this.decided(chatId, folded.turnId, pid, actor, 'not_now', null, acc.resolution, acc.edits, instance)) return this.gone(chatId);
        return ok(reread());
      }
      // DES-CATALOG-002 §4.6 (codex r1): a v2 proposal whose run never started is re-checked against the catalog first;
      // a changed one is refreshed (the person starts the refreshed proposal), never retried on a stale revision.
      if (acc.resolution.shape !== undefined) {
        const stale = await this.lock.run(`chat\u0000${instance ?? chatId}`, () => this.jobStale(chatId, folded, instance));
        if (stale !== null) return stale;
      }
      // Go again: the frozen choices and identity, re-checked. Only the helpers may change (one may have signed out
      // since); everything else stays as accepted.
      let again = acc.resolution;
      if (body.edits !== undefined) {
        if (Object.keys(body.edits).some((k) => k !== 'helpers')) {
          return { code: 400, body: { code: 'edits_invalid', error: 'an interrupted proposal resumes with the choices it was accepted with; only its helpers can change' } };
        }
        try {
          again = await this.applyEdits(chatId, { ...folded, proposal: acc.resolution }, body.edits);
        } catch (err) {
          if (err instanceof EditRefusal || err instanceof JobRefusal) return this.refusalOf(err)!;
          throw err;
        }
      }
      return this.go(chatId, folded, again, again === acc.resolution ? acc.edits : { ...(acc.edits ?? {}), ...body.edits }, acc.identity, actor, instance, body.power);
    }
    if (folded.state === 'superseded') {
      return { code: 409, body: { code: 'proposal_superseded', error: 'a newer proposal in this chat replaced this one', view: viewOf(folded) } };
    }
    // DES-CATALOG-002 §4.6: a typed correction in flight holds Start. A hold whose turn is gone is released with its note
    // first (the person sees the proposal as it stands, and presses again).
    if (folded.state === 'revising' && body.decision === 'go') {
      if (await this.reopenStale(chatId, instance)) {
        return { code: 409, body: { code: 'proposal_reopened', error: "your typed change wasn't applied: check the job and press Start again", view: viewOf(reread()) } };
      }
      return { code: 409, body: { code: 'proposal_revising', error: 'your typed change is still being applied; Start waits for it', view: viewOf(folded) } };
    }
    // 2. Not now: nothing else is checked.
    if (body.decision === 'not_now') {
      if (!this.decided(chatId, folded.turnId, pid, actor, 'not_now', null, folded.proposal, null, instance)) return this.gone(chatId);
      return ok(reread());
    }
    // DES-CATALOG-002 §4.6: a job's Go launches only what is on screen, against the catalog it was proposed on.
    if (kind === 'job') {
      if (!this.jobsOn()) return { code: 409, body: { code: 'operation_unavailable', error: 'this daemon does not start jobs from a chat', view: viewOf(folded) } };
      if (folded.proposal.coming !== undefined) {
        return { code: 409, body: { code: 'card_not_available', error: folded.proposal.blocked ?? `${folded.proposal.what.label} is coming later`, nearest: folded.proposal.coming.nearest, view: viewOf(folded) } };
      }
      if (folded.proposal.question !== undefined && folded.proposal.question !== null) {
        return { code: 409, body: { code: 'proposal_blocked', error: folded.proposal.question.text, view: viewOf(folded) } };
      }
    }
    // Every v2 proposal (a job, or a document's create) starts only on the catalog it was proposed on (codex r1).
    if (folded.proposal.shape !== undefined) {
      const stale = await this.lock.run(`chat\u0000${instance ?? chatId}`, () => this.jobStale(chatId, folded, instance));
      if (stale !== null) return stale;
    }
    if (kind === 'job') {
      // A reshape starts only through its own transition (the held plan answered Reject first; codex r3).
      // The seats the proposal names can still work, before any edit re-resolves them (codex r3).
      const can = new Set(this.deps.rosterEligible().map((x) => x.key));
      const gone = (folded.proposal.seats?.keys ?? []).filter((k) => !can.has(k));
      if (gone.length > 0 && body.edits?.seats === undefined) {
        return { code: 409, body: { code: 'helper_unavailable', error: `${gone.join(' and ')} can't work now; change who works on it`, view: viewOf(folded) } };
      }
    }
    // 3. A fresh Go: the edits first (the one block a person can lift is a missing second helper), then the block.
    let effective: ArtifactProposal;
    try {
      effective = await this.applyEdits(chatId, folded, body.edits);
    } catch (err) {
      if (err instanceof EditRefusal || err instanceof JobRefusal) return this.refusalOf(err)!;
      throw err;
    }
    if (effective.blocked !== null) {
      return { code: 409, body: { code: 'proposal_blocked', error: effective.blocked, view: viewOf(folded) } };
    }
    return this.go(chatId, folded, effective, body.edits ?? null, this.identityOf(effective), actor, instance, body.power);
  }

  /**
   * The state checks, then `accepting`, the launch, and `decided` — under the chat's lock and the document's, so two
   * proposals of one chat (or two chats changing one document) can never both pass the busy check.
   */
  private go(chatId: string, folded: FoldedProposal, resolution: ArtifactProposal, edits: ProposalEdits | null, identity: ProposalIdentity, actor: Actor, instance: string | null, power?: boolean): Promise<DecideResult> {
    const docKey = (resolution.kind === 'refine' || (resolution.kind === 'create' && resolution.artifactRef !== undefined)) && identity.artifactRef !== null ? identity.artifactRef : null;
    // Keyed by the chat's instance (shared by its original id and an ended chat's archived alias), else its id.
    return this.lock.run(`chat\u0000${instance ?? chatId}`, () =>
      docKey === null
        ? this.goLocked(chatId, folded, resolution, edits, identity, actor, instance, power)
        : this.lock.run(`doc\u0000${docKey}`, () => this.goLocked(chatId, folded, resolution, edits, identity, actor, instance, power)));
  }

  private async goLocked(chatId: string, folded: FoldedProposal, resolution: ArtifactProposal, edits: ProposalEdits | null, identity: ProposalIdentity, actor: Actor, instance: string | null, power?: boolean): Promise<DecideResult> {
    const kind = resolution.kind;
    const pid = resolution.pid;
    // Under the chat's lock: a newer proposal published while this one was being checked supersedes it.
    if (this.deps.instanceOf(chatId) !== instance) return this.gone(chatId);
    const now = foldProposals(this.deps.records(chatId)).get(pid);
    if (now?.state === 'revising') {
      return { code: 409, body: { code: 'proposal_revising', error: 'your typed change is still being applied; Start waits for it', view: viewOf(now) } };
    }
    if (now === undefined || now.state === 'superseded' || now.state === 'decided' || now.state !== folded.state) {
      return { code: 409, body: { code: now?.state === 'decided' ? 'proposal_decided' : 'proposal_superseded', error: 'this proposal changed while it was being answered; check the card again', ...(now !== undefined ? { view: viewOf(now) } : {}) } };
    }
    const flags = this.deps.flags();
    if (!flags.proposals || !(kind === 'job' ? this.jobsOn() : flags[kind]) || !this.deps.registry.has(kind)) {
      return { code: 409, body: { code: 'operation_unavailable', error: `studio cannot start a ${kind === 'create' ? 'document' : kind} from a chat on this daemon yet`, view: viewOf(folded) } };
    }
    // The helpers can still work (one may have signed out since the card was drawn).
    if (resolution.helpers !== null) {
      const can = new Set(this.deps.rosterEligible().map((s) => s.key));
      const lost = resolution.helpers.seats.filter((k) => !can.has(k));
      if (lost.length > 0) {
        return { code: 409, body: { code: 'helper_unavailable', error: `${lost.join(' and ')} can't work now; pick another helper`, view: viewOf(folded) } };
      }
    }
    // A job's seats can still work: Go never launches with fewer of them than the proposal names (codex r2).
    if (kind === 'job' && resolution.seats !== undefined && resolution.seats.keys.length > 0) {
      const can = new Set(this.deps.rosterEligible().map((s) => s.key));
      const lost = resolution.seats.keys.filter((k) => !can.has(k));
      if (lost.length > 0) {
        return { code: 409, body: { code: 'helper_unavailable', error: `${lost.join(' and ')} can't work now; change who works on it`, view: viewOf(folded) } };
      }
    }
    // Only the newest proposal of a lineage starts (a refreshed or revised one supersedes an interrupted one; codex r2).
    if (resolution.lineage !== undefined) {
      const newest = [...foldProposals(this.deps.records(chatId)).values()].filter((f) => f.proposal.lineage === resolution.lineage).pop();
      if (newest !== undefined && newest.proposal.pid !== pid) {
        return { code: 409, body: { code: 'proposal_superseded', error: 'a newer version of this job replaced this one', view: viewOf(newest) } };
      }
    }
    // Where it is filed still exists (a create or demo files into the chat's project).
    if ((kind === 'create' || kind === 'demo') && (await this.deps.docsRoot(resolution.filedIn.projectId ?? 'default')) === null) {
      return { code: 409, body: { code: 'source_gone', error: `${resolution.filedIn.label} is no longer on this daemon`, view: viewOf(folded) } };
    }
    // Every source and the target still exist, and are still where they were authorized.
    const gone = await this.firstGone(chatId, resolution);
    if (gone !== null) return { code: 409, body: { code: 'source_gone', error: gone, view: viewOf(folded) } };
    // A theme is no job (§15.2): applying colours never waits for a run of this chat.
    // An onboard card starts no job of this chat either (crew-0182): it registers a repository.
    const busy = kind === 'theme' || kind === 'onboard' ? null : await this.busy(chatId, identity.artifactRef, resolution);
    if (busy !== null) return { code: 409, body: { code: busy.code, error: busy.reason, view: viewOf(folded) } };
    // A refine is on the head it was proposed on; else the card re-resolves (same pid, the new base). Read last, right
    // before the record: the landing itself is checked against this base (`expect_head`, slices I1 and A5).
    if (resolution.target !== undefined) {
      const ref = parseArtifactRef(resolution.target.ref)!;
      const root = await this.deps.docsRoot(ref.projectId);
      const head = root === null ? null : artifactHead(root, ref.doc);
      if (head === null) return { code: 409, body: { code: 'source_gone', error: `${resolution.target.title} is gone`, view: viewOf(folded) } };
      if (head !== resolution.target.base) {
        // A newer proposal exists: this one is not re-opened over it (the chat moved on). The re-resolution is still
        // recorded, so the fold settles it as superseded for every reader (and its frame says so).
        const pids = [...foldProposals(this.deps.records(chatId)).keys()];
        if (pids.indexOf(pid) < pids.length - 1) {
          const recordedOld = folded.proposal;
          const freshOld: ArtifactProposal = await this.onNewHead({ ...recordedOld, target: { ...(recordedOld.target ?? resolution.target), base: head } });
          if (!this.write(chatId, { at: this.now(), turnId: folded.turnId, kind: 'proposal', proposal: freshOld }, instance)) return this.gone(chatId);
          const settled = foldProposals(this.deps.records(chatId)).get(pid);
          return { code: 409, body: { code: 'proposal_superseded', error: `${resolution.target.title} changed since this was proposed, and a newer proposal replaced it`, ...(settled !== undefined ? { view: viewOf(settled) } : {}) } };
        }
        // From the proposal as crew recorded it (never the refused request's edits): the person chooses again.
        const recorded = folded.proposal;
        const fresh: ArtifactProposal = await this.onNewHead({ ...recorded, target: { ...(recorded.target ?? resolution.target), base: head } });
        if (!this.write(chatId, { at: this.now(), turnId: folded.turnId, kind: 'proposal', proposal: fresh }, instance)) return this.gone(chatId);
        const after = foldProposals(this.deps.records(chatId)).get(pid);
        return {
          code: 409,
          body: { code: 'proposal_reresolved', error: `${resolution.target.title} changed since this was proposed (now v${head}); check the card again`, ...(after !== undefined ? { view: viewOf(after) } : {}) },
        };
      }
    }

    // DES-CATALOG-002 §4.6/§2.5 (codex r4): what can be checked before anything changes is checked first (a Backlog's
    // requirements, its project's members), so a reshape never answers its held plan for a launch that would refuse.
    if (kind === 'job' && this.deps.preflight !== undefined) {
      const why = await this.deps.preflight(resolution);
      if (why !== null) return { code: 409, body: { code: 'proposal_blocked', error: why, view: viewOf(folded) } };
    }
    // (api-types 0.196.0, operator ruling 2026-11-06) A power Start runs as one, or is refused before anything is
    // recorded: never started phased behind the person's back.
    if (power === true) {
      const why = this.deps.powerRefusal === undefined ? "this daemon can't start a chat job as a power run; press Start with Review plan on" : await this.deps.powerRefusal(resolution);
      if (why !== null) return { code: 409, body: { code: 'power_unavailable', error: why, view: viewOf(folded) } };
    }
    // §2.5: a reshape (or its corrected descendant) answers the held plan Reject first, in this one transition; the
    // proposal then records that it did, so a retry launches without asking again.
    if (resolution.reshapes !== undefined && resolution.heldRejected !== true) {
      if (this.deps.reshapeReject === undefined) return { code: 409, body: { code: 'operation_unavailable', error: 'this daemon cannot answer the held plan for a reshape', view: viewOf(folded) } };
      const refused = await this.deps.reshapeReject(resolution.reshapes, actor, pid, resolution.heldPlan);
      if (refused !== null) return refused;
      resolution = { ...resolution, heldRejected: true };
      if (!this.write(chatId, { at: this.now(), turnId: folded.turnId, kind: 'proposal', proposal: { ...(now.accepting?.resolution ?? now.proposal), heldRejected: true } }, instance)) return this.gone(chatId);
    }
    // Recorded before anything starts.
    const accepting: ProposalRecord = { at: this.now(), turnId: folded.turnId, kind: 'proposal_accepting', pid, actor: actor.id, edits, resolution, identity };
    if (!this.write(chatId, accepting, instance)) return this.gone(chatId);
    let result: ProposalResult;
    try {
      result = await this.deps.registry.launchOnce({ kind, pid, chatId, actor, identity, resolution, ...(power !== undefined ? { power } : {}) });
    } catch (err) {
      // Accepting stays recorded: the card shows "Interrupted · Go again", which resumes the same identity.
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.audit('chat.proposal.launch_failed', actor, { chatId, pid, error: msg, ...(power !== undefined ? { power } : {}) });
      const after = foldProposals(this.deps.records(chatId)).get(pid);
      return { code: 502, body: { code: 'launch_failed', error: `could not start it: ${msg}. Go again resumes the same job.`, ...(after !== undefined ? { view: viewOf(after) } : {}) } };
    }
    if (!this.decided(chatId, folded.turnId, pid, actor, 'go', result, resolution, edits, instance, power)) return this.gone(chatId);
    const after = foldProposals(this.deps.records(chatId)).get(pid) ?? folded;
    return { code: 200, body: { view: viewOf(after) } };
  }

  /** Record the answer (and audit exactly what was answered); `false` when the chat is no longer this instance. */
  private decided(chatId: string, turnId: string, pid: string, actor: Actor, decision: 'go' | 'not_now', result: ProposalResult | null, resolution: ArtifactProposal, edits: ProposalEdits | null, instance: string | null, power?: boolean): boolean {
    if (!this.write(chatId, { at: this.now(), turnId, kind: 'proposal_decided', pid, actor: actor.id, decision, result }, instance)) return false;
    this.deps.audit(decision === 'go' ? 'chat.proposal.accepted' : 'chat.proposal.declined', actor, { chatId, pid, kind: resolution.kind, resolution, edits, result, ...(power !== undefined ? { power } : {}) });
    return true;
  }

  /** A5: the protected edits of a document at a version, or the reason a refine card is blocked. */
  private async protectedOf(ref: string, version: number, touch: readonly string[]): Promise<{ entries: ProtectedEdit[] } | { error: string }> {
    if (this.deps.protectedEdits === undefined) return { entries: [] };
    const r = await this.deps.protectedEdits(ref, version, touch).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    return r.ok ? { entries: r.entries } : { error: `Your own edits can't be checked on this host, so it can't be changed from chat (${r.error.slice(0, 200)})` };
  }

  /** A5: a refine at the document's current head (and that head's protected edits); unchanged when it is gone. */
  private async refreshTarget(p: ArtifactProposal): Promise<ArtifactProposal> {
    const ref = p.target === undefined ? null : parseArtifactRef(p.target.ref);
    const root = ref === null ? null : await this.deps.docsRoot(ref.projectId);
    const head = root === null || ref === null ? null : artifactHead(root, ref.doc);
    if (head === null || p.target === undefined) return p;
    return this.onNewHead({ ...p, target: { ...p.target, base: head } });
  }

  /** A5: a refine card re-resolved on a newer head: its protected edits are those of the new head (Keep preselected). */
  private async onNewHead(p: ArtifactProposal): Promise<ArtifactProposal> {
    if (p.kind !== 'refine' || p.target === undefined) return p;
    const kept = await this.protectedOf(p.target.ref, p.target.base, p.touches ?? []);
    return 'error' in kept ? { ...p, protected: [], blocked: kept.error } : { ...p, protected: kept.entries, blocked: p.blocked };
  }

  /** The identity a Go is named by (DES §4.3 step 2). */
  identityOf(p: ArtifactProposal): ProposalIdentity {
    const runId = proposalRunId(p.pid);
    if (p.kind === 'refine') return { artifactRef: p.target?.ref ?? null, runId };
    if (p.kind === 'create') {
      // A retry fills the same document again (§4.3: artifact identity and attempt identity are separate).
      if (p.artifactRef !== undefined) return { artifactRef: p.artifactRef, runId };
      const mount = chatMount(p.filedIn.projectId) ?? UNFILED_MOUNT;
      return { artifactRef: `${mount}/${proposalDocName(p.pid, p.what.title)}`, runId };
    }
    return { artifactRef: null, runId };
  }

  /**
   * The first source (or the target) that no longer exists, or is no longer where it was authorized, as words; `null`
   * = all there. The stored authorization (named in this chat) is never re-derived; where it lives is re-checked.
   */
  private async firstGone(chatId: string, p: ArtifactProposal): Promise<string | null> {
    let runs: SessionView[] | null = null;
    const documents = p.sentence?.tokens.flatMap((t) => t.kind === 'documents' ? t.documents ?? [] : []) ?? [];
    const checked = documents.length === 0 ? [] : await this.authorizeDocumentsAt(chatId, documents.filter((s) => s.status === 'ok').map((s) => s.token), this.deps.records(chatId), '\u0000', p.kind === 'create');
    const struck = checked.find((s) => s.status === 'struck');
    if (struck !== undefined) return `${struck.label} cannot be used (${struck.reason})`;
    // A3: a repository the card names must still be registered (never silently dropped from the launch).
    if ((p.repoRefs ?? []).length > 0 && this.deps.repoIds !== undefined) {
      const have = await this.deps.repoIds();
      const lost = (p.repoRefs ?? []).findIndex((id) => !have.has(id));
      if (lost !== -1) return `${p.repos[lost] ?? p.repoRefs![lost]} is no longer registered on this daemon; ask again in the chat`;
    }
    for (const s of [...p.sources, ...documents]) {
      if (s.status !== 'ok') continue;
      if (s.token.startsWith('run:')) {
        runs ??= await this.deps.runs();
        const id = s.token.slice(4);
        const v = runs.find((x) => x.session.id === id);
        if (v === undefined) return `${s.label} is no longer on this daemon`;
        if (s.projectId !== undefined && projectOfMount(runMount(v)) !== s.projectId) return `${s.label} moved to another project since this was proposed`;
      } else if (s.token.startsWith('doc:')) {
        const ref = parseArtifactRef(s.token.slice(4));
        const root = ref === null ? null : await this.deps.docsRoot(ref.projectId);
        if (ref === null || root === null || !artifactExists(root, ref.doc)) return `${s.label} is gone`;
      } else if (s.token.startsWith('attachment:')) {
        if (!this.deps.attachments(chatId).some((a) => a.id === s.token.slice(11))) return `${s.label} is no longer attached`;
      }
    }
    return null;
  }

  /**
   * One live job per chat (work and artifact runs together) and one per document, whoever started it (DES §4.3).
   * `null` = free.
   */
  private async busy(chatId: string, artifactRef: string | null, p: ArtifactProposal): Promise<{ code: 'chat_busy' | 'document_busy'; reason: string } | null> {
    const runs = await this.deps.runs();
    // A reshape's held run is the one it replaces: answered Reject inside this Go, so it does not make the chat busy.
    const held = p.reshapes !== undefined && p.heldRejected !== true ? p.reshapes : null;
    for (const f of foldProposals(this.deps.records(chatId)).values()) {
      if (f.proposal.pid === p.pid) continue;
      // Another proposal of this chat started a job (decided go, or accepting with its run launched) still live.
      const runId = f.state === 'decided' && f.decision === 'go' ? f.result?.runId ?? null
        : f.state === 'accepting' ? f.accepting?.identity.runId ?? null : null;
      if (runId !== null && runId !== held && (await this.deps.registry.live(f.proposal.kind, runId))) {
        return { code: 'chat_busy', reason: `This chat already has a job running (${f.proposal.what.label}). Wait, or stop that run.` };
      }
    }
    for (const v of runs) {
      if (!isLive(v) || v.session.id === held || this.deps.chatOfRun(v.session.id) !== chatId || this.deps.isAskPath(v.session.id)) continue;
      return { code: 'chat_busy', reason: `This chat already has a job running (run ${v.session.id.slice(0, 8)}). Wait, or stop that run.` };
    }
    if (artifactRef !== null && (p.kind === 'refine' || (p.kind === 'create' && p.artifactRef !== undefined))) {
      if (await this.deps.registry.liveForArtifact(artifactRef)) {
        return { code: 'document_busy', reason: `“${p.target?.title ?? p.what.title}” is being ${p.kind === 'create' ? 'drafted' : 'revised'}. Wait, or stop that run.` };
      }
      const ref = parseArtifactRef(artifactRef);
      if (ref !== null) {
        for (const v of runs) {
          const doc = (v.session as { document_id?: string | null }).document_id;
          if (isLive(v) && doc === ref.doc && runMount(v) === ref.mount) {
            return { code: 'document_busy', reason: `“${p.target?.title ?? p.what.title}” is being ${p.kind === 'create' ? 'drafted' : 'revised'}. Wait, or stop that run.` };
          }
        }
      }
    }
    return null;
  }

  /**
   * The person's edits, re-checked with §4.2's rules (no edit can lower assurance: helpers stay two distinct eligible
   * seats). This slice takes the fields its own card can change; a project, repositories, a demo address and a
   * refine's `allow` are refused here until the slice whose form edits them (A3, A5, A8). `chatId` is the chat the
   * route answered (the history entry: after an id reuse, the archived one), never re-derived from the proposal.
   */
  private async applyEdits(chatId: string, f: FoldedProposal, edits: ProposalEdits | undefined): Promise<ArtifactProposal> {
    const p = f.proposal;
    if (edits === undefined) return p;
    if (p.kind === 'job') return this.applyJobEdits(chatId, f, edits);
    const allowed: Record<Exclude<ArtifactProposalKind, 'job'>, ReadonlyArray<keyof ProposalEdits>> = {
      create: p.artifactRef !== undefined ? ['title', 'brief', 'sources', 'helpers'] : ['title', 'brief', 'sources', 'helpers', 'repos', 'project'],
      refine: ['ask', 'helpers', 'allow'],
      theme: ['name', 'patch'],
      demo: ['audience', 'show', 'helpers'],
      // An onboard card is changed by saying so in the chat (a new proposal replaces it); Go takes no edits.
      onboard: [],
    };
    const kindAllowed = allowed[p.kind];
    for (const k of Object.keys(edits) as Array<keyof ProposalEdits>) {
      if (!kindAllowed.includes(k)) throw new EditRefusal(`${k} can't be changed on a ${p.kind} proposal here yet`);
    }
    let next: ArtifactProposal = { ...p };
    if (edits.title !== undefined) {
      const t = edits.title.trim();
      if (t === '' || t.length > 200) throw new EditRefusal('the title must be 1 to 200 characters');
      const kindWord = next.what.label.split(' · ')[0] ?? 'Document';
      next = { ...next, what: { ...next.what, title: t, label: `${kindWord} · ${t}` } };
    }
    if (edits.brief !== undefined) {
      if (edits.brief.length > 8000) throw new EditRefusal('the brief is over 8000 characters');
      next = { ...next, brief: edits.brief };
    }
    if (edits.ask !== undefined) {
      const a = edits.ask.trim();
      if (a === '' || a.length > 4000) throw new EditRefusal('the ask must be 1 to 4000 characters');
      next = { ...next, brief: a };
    }
    if (edits.allow !== undefined) {
      // A5 (§6.2): only the person releases a protected edit, and only one the card shows them (an id names one exact
      // value; an edit made since the card was drawn has a new id and is kept).
      const shown = new Set((p.protected ?? []).map((e) => e.id));
      if (!Array.isArray(edits.allow) || edits.allow.length > 500 || edits.allow.some((id) => typeof id !== 'string' || !shown.has(id))) {
        throw new EditRefusal('only edits shown on this card can be let change; check the card again');
      }
    }
    if (edits.audience !== undefined || edits.show !== undefined) {
      if ((edits.audience?.length ?? 0) > 400 || (edits.show?.length ?? 0) > 2000) throw new EditRefusal('the audience or what to show is too long');
      const show = edits.show ?? p.demo?.show ?? null;
      // A demo's brief IS what to show: both say the same thing.
      next = { ...next, brief: show, demo: { url: p.demo?.url ?? '', audience: edits.audience ?? p.demo?.audience ?? null, show } };
    }
    if (edits.name !== undefined || edits.patch !== undefined) {
      const name = (edits.name ?? p.theme?.name ?? '').trim();
      if (name === '' || name.length > 60) throw new EditRefusal('the theme name must be 1 to 60 characters');
      const patch = edits.patch ?? p.theme?.patch ?? {};
      const parsed = ThemePatchSchema.safeParse(patch);
      if (!parsed.success) throw new EditRefusal('the theme patch is not one studio can apply');
      const clean = parsed.data as Record<string, string | number | boolean>;
      next = { ...next, what: { ...next.what, title: name, label: `Theme · ${name}` }, theme: { name, patch: clean, changes: Object.keys(clean) } };
    }
    if (edits.helpers !== undefined) {
      const chat = this.deps.chat(chatId) ?? { projectId: p.filedIn.projectId, repos: [], lead: null, seats: [], analysis: false };
      const helpers = this.helpers(chat, edits.helpers);
      if (helpers === null) throw new EditRefusal('pick two different helpers that can work now');
      // Two helpers lift the one block a person can lift.
      next = { ...next, helpers, blocked: next.blocked === NEEDS_HELPER ? null : next.blocked };
    }
    // A3 (§4.2 Change something, create): the project — only in a chat filed in no project. Every source, repository
    // and turn is re-checked against the target below; what is outside it is struck (a `message:` whole).
    let recheck = false;
    if (edits.project !== undefined) {
      const chatProject = this.deps.chat(chatId)?.projectId ?? this.deps.projectOf(chatId);
      if (chatProject !== null) throw new EditRefusal("this chat is filed in a project: its documents stay there");
      const target = edits.project === null || edits.project === '' || edits.project === 'default' ? null : edits.project;
      if (target !== null && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target) || (await this.deps.docsRoot(target)) === null)) {
        throw new EditRefusal(`there is no project ${target.slice(0, 80)} on this daemon`);
      }
      if (target !== p.filedIn.projectId) {
        recheck = true;
        next = { ...next, filedIn: { projectId: target, label: target === null ? 'Not in a project · this chat' : ((await this.deps.projectName(target)) ?? target) } };
      }
    }
    if (edits.repos !== undefined) {
      if (edits.repos.length > 8) throw new EditRefusal('at most 8 repositories');
      // In the chat's scope: the live chat's, else (an ended chat) the repositories the proposal was resolved with.
      const scope = this.deps.chat(chatId)?.repos ?? (p.repoRefs ?? []).map((id, i) => ({ id, name: p.repos[i] ?? id }));
      const repos: string[] = [];
      const repoRefs: string[] = [];
      for (const want of edits.repos) {
        const hits = scope.filter((r) => r.id === want || r.name === want);
        if (hits.length !== 1) throw new EditRefusal(`${want.slice(0, 120)} ${hits.length === 0 ? "isn't in this chat's scope" : 'names several repositories (name it by id)'}`);
        if (!repoRefs.includes(hits[0]!.id)) {
          repos.push(hits[0]!.name);
          repoRefs.push(hits[0]!.id);
        }
      }
      next = { ...next, repos, ...(repoRefs.length > 0 ? { repoRefs } : {}) };
      if (repoRefs.length === 0) delete (next as { repoRefs?: string[] }).repoRefs;
    }
    if (recheck) next = await this.recheckProject(next, edits.repos !== undefined);
    if (edits.sources !== undefined) {
      if (edits.sources.length > PROPOSAL_SOURCES_MAX) throw new EditRefusal(`at most ${PROPOSAL_SOURCES_MAX} sources`);
      const records = this.deps.records(chatId);
      const { binding, turnHas } = bindingOf(records, f.turnId);
      // A source the person adds counts as named by them, and is checked against the chat's own scope first; then the
      // project re-check (when the document moves) strikes what is outside the target.
      const resolved = await this.resolveSources(edits.sources, {
        chatId,
        turnId: f.turnId,
        records,
        binding,
        turnHas,
        chat: { projectId: p.filedIn.projectId },
        words: personWords(records, f.turnId),
        personNamed: true,
      });
      next = { ...next, sources: resolved };
      // Re-checked whenever the document is filed outside the chat's own scope (a moved document, or a retry of one).
      const chatScope = this.deps.chat(chatId)?.projectId ?? this.deps.projectOf(chatId);
      if (recheck || next.filedIn.projectId !== chatScope) next = await this.recheckProject(next, edits.repos !== undefined);
      // A source the person ADDED (not one the proposal already held) that cannot be used is said back, never silently
      // dropped from a launch; one it already held is struck with the reason, as the project change promises.
      const had = new Set(p.sources.map((s) => s.token));
      const added = next.sources.find((src) => src.status === 'struck' && !had.has(src.token));
      if (added !== undefined) throw new EditRefusal(`${added.label}: ${added.reason ?? 'it cannot be used'}`);
      // The attachments together must fit the packet (1 MB with room for the rest), or one would be left out at launch.
      const files = this.deps.attachments(chatId);
      const attached = next.sources
        .filter((s) => s.status === 'ok' && s.token.startsWith('attachment:'))
        .reduce((n, s) => n + (files.find((a) => `attachment:${a.id}` === s.token)?.bytes ?? 0), 0);
      if (attached > 768 * 1024) throw new EditRefusal(`the attached files together are ${Math.round(attached / 1024)} KB: a document's sources take at most 768 KB of attachments; leave one out`);
    }
    return next;
  }

  /**
   * A3 (§4.2): re-check a create against the project it is now filed in. A run or document source from elsewhere is
   * struck; a `message:` source is struck whole when any record its answer was given is elsewhere (the conversation
   * keeps only what is in the project, at packet time); repositories outside the project's members are cut (or, when
   * the person chose them, refused).
   */
  private async recheckProject(p: ArtifactProposal, personRepos: boolean): Promise<ArtifactProposal> {
    const target = p.filedIn.projectId;
    const label = target === null ? 'Unfiled' : p.filedIn.label;
    const records = this.deps.records(p.chatId);
    let runs: SessionView[] | null = null;
    const runProject = async (id: string): Promise<string | null | undefined> => {
      runs ??= await this.deps.runs();
      const v = runs.find((x) => x.session.id === id);
      return v === undefined ? undefined : projectOfMount(runMount(v));
    };
    const sources: ProposalSource[] = [];
    for (const s of p.sources) {
      if (s.status !== 'ok') {
        sources.push(s);
        continue;
      }
      if (s.token.startsWith('run:') || s.token.startsWith('doc:')) {
        const proj = s.projectId !== undefined ? s.projectId : s.token.startsWith('run:') ? await runProject(s.token.slice(4)) : projectOfMount(parseArtifactRef(s.token.slice(4))?.mount ?? '');
        sources.push(proj === target ? s : { ...s, status: 'struck', reason: `not in ${label}` });
        continue;
      }
      if (s.token.startsWith('message:')) {
        const turn = s.token.slice('message:'.length);
        const ctx = records.find((r): r is Extract<ChatTranscriptRecord, { kind: 'context' }> => r.kind === 'context' && r.turnId === turn);
        let inside = true;
        for (const r of ctx?.runs ?? []) if ((await runProject(r.id)) !== target) inside = false;
        if (ctx?.artifact !== undefined && projectOfMount(parseArtifactRef(ctx.artifact.ref)?.mount ?? '') !== target) inside = false;
        sources.push(inside ? s : { ...s, status: 'struck', reason: `it was answered from records outside ${label}` });
        continue;
      }
      sources.push(s);
    }
    let repos = p.repos;
    let repoRefs = p.repoRefs ?? [];
    if (target !== null && repoRefs.length > 0) {
      const members = (await this.deps.projectRepos?.(target)) ?? [];
      const outside = repoRefs.filter((id) => !members.some((m) => m.id === id));
      if (outside.length > 0 && personRepos) {
        throw new EditRefusal(`${outside.map((id) => p.repos[repoRefs.indexOf(id)] ?? id).join(', ')} ${outside.length === 1 ? 'is' : 'are'} not in ${label}`);
      }
      repos = repos.filter((_, i) => !outside.includes(repoRefs[i]!));
      repoRefs = repoRefs.filter((id) => !outside.includes(id));
    }
    const out: ArtifactProposal = { ...p, sources, repos, ...(repoRefs.length > 0 ? { repoRefs } : {}) };
    if (repoRefs.length === 0) delete (out as { repoRefs?: string[] }).repoRefs;
    return out;
  }

  // ── DES-CATALOG-002 §4.6: job proposals ──────────────────────────────────────────────────────────────────────────

  /** (DES-CATALOG-002 §4.6) Whether a seat's job block may become a job proposal in this chat (its client draws them);
   *  an older client gets the prose command line instead (Lane D's chat statement). */
  acceptsJobs(chatId: string): boolean {
    return this.jobsOn() && this.deps.acceptsJobs?.(chatId) === true;
  }

  /** Holds whose release waits for the held-plan path's outcome (`<chat>\0<turn>`). */
  private readonly deferredRelease = new Set<string>();
  /** Turns whose held-plan work is queued (set before the turn's own release runs; pi r8: a deferral only ever waits on
   *  work that exists). */
  private readonly planScheduled = new Set<string>();

  /** Per accepted turn: whether its client draws job cards, as the turn's instructions were written (codex r3). */
  private readonly turnAccepts = new Map<string, boolean>();

  /** The route records the declaration a turn's instructions were written for, before the seat can answer it. */
  noteTurnAccepts(chatId: string, turnId: string, accepts: boolean): void {
    this.turnAccepts.set(`${chatId}\u0000${turnId}`, accepts);
    while (this.turnAccepts.size > 2000) this.turnAccepts.delete(this.turnAccepts.keys().next().value as string);
  }

  /** How a reply to `turnId` is read: as its instructions were written, else the chat's declaration now. */
  private acceptsTurn(chatId: string, turnId: string | undefined): boolean {
    const noted = turnId === undefined ? undefined : this.turnAccepts.get(`${chatId}\u0000${turnId}`);
    return this.jobsOn() && (noted ?? this.deps.acceptsJobs?.(chatId) === true);
  }

  /**
   * (DES-CATALOG-002 §2.3) A seat's job routing block → a DETECTED job proposal: the block is a guess like any other,
   * validated against the catalog, cross-checked with the words layer over the person's own message of that turn and
   * banded (the chat door is capped at likely unless the words agree). An unsure reading is ONE question: the proposal
   * holds no Start, and its `shape.guess.question` lists the shapes to pick from (a pick is a person-made proposal).
   * `null` when nothing can be proposed (the chat ended, an analysis, a refusal).
   */
  async resolveDetected(input: { chatId: string; turnId: string; seat: string; block: Extract<ParsedMake, { op: 'entry' }>; records: readonly ChatTranscriptRecord[] }): Promise<ArtifactProposal | null> {
    const { chatId, turnId, seat, block, records } = input;
    const chat = this.deps.chat(chatId);
    if (chat === null) return null;
    if (chat.analysis) {
      this.log(`[proposals] chat ${chatId} is an analysis: it proposes nothing — no card`);
      return null;
    }
    const jc = this.jobChat(chatId);
    if (jc === null) return null;
    const pid = `${chatId}:${turnId}`;
    // The whole message: the job's words are what the person said, never silently clipped (codex r2).
    const words = turnWords(records, turnId);
    try {
      const ctx = await this.jobContext(chatId, pid, turnId, seat, jc, { revises: null, lineage: null, notes: [] });
      const available = (card: string, option: string | null): boolean => resolveOption(card, option, ctx.served)?.resolved.status === 'available';
      const d = detect({
        text: words,
        seat: { entry: block.entry, option: block.option ?? null, depth: block.depth ?? null, confidence: block.confidence, reason: block.reason },
        source: 'chat',
        catalogRev: ctx.served.rev,
        available,
      });
      const g = d.guess;
      // The repository the block names, when it is one of this chat's (else the chat's own rule picks it).
      const named = block.repos.map((want) => jc.repos.filter((r) => r.name === want || r.id === want)).find((hits) => hits.length === 1)?.[0];
      // A demo's address only from the person's own words (DES-CHAT-ARTIFACTS-001 §4.3), never the model's.
      const inputs: JobFacts['inputs'] = {};
      if (block.url !== undefined && block.url !== '' && personUrls(words).has(block.url)) inputs['url'] = { kind: 'url', value: block.url };
      const facts: JobFacts = {
        card: g.card,
        option: g.option,
        depth: g.depth,
        words,
        details: [],
        repoRef: named?.id ?? null,
        projectId: jc.projectId,
        lead: null,
        seats: null,
        inputs,
        skipQe: null,
        by: 'detected',
        source: 'chat',
        guess: g,
      };
      // ONE question, never a Start, while the reading is unsure: each choice names a shape (a pick is a person-made
      // proposal).
      const proposal = withAskOverlay(await this.proposalOf(chatId, pid, facts, ctx, records));
      this.deps.audit('chat.detect', { id: `seat:${seat}`, kind: 'agent', trust: 'observer' }, {
        chatId, turnId, source: g.source, seat, card: g.card, option: g.option, band: g.band, confidence: g.confidence, dropped: d.seat?.dropped ?? null,
      });
      return proposal;
    } catch (err) {
      const refused = this.refusalOf(err);
      if (refused === null) throw err;
      this.log(`[proposals] chat ${chatId}: turn ${turnId}'s job block could not be proposed (${String((refused.body as { code?: unknown }).code ?? refused.code)})`);
      return null;
    }
  }

  /** The chat's newest job that Go started: its proposal and run (`null` when none). */
  private launchedJob(chatId: string): { proposal: ArtifactProposal; runId: string } | null {
    const folded = [...foldProposals(this.deps.records(chatId)).values()];
    for (let i = folded.length - 1; i >= 0; i -= 1) {
      const f = folded[i]!;
      if (f.state === 'decided' && f.decision === 'go' && f.result?.runId !== undefined && f.proposal.kind === 'job' && f.proposal.shape !== undefined) {
        return { proposal: f.accepting?.resolution ?? f.proposal, runId: f.result.runId };
      }
    }
    return null;
  }

  /**
   * (DES-CATALOG-002 §2.4, §2.5) Typed at a job's held plan without Change: the seat's `planEdit` block becomes wicked's
   * send-back offer quoting the person's own words, and a revision block that changes the job's card, option or depth
   * becomes the "start it again as…" offer naming what it gives up and what it needs. An offer decides nothing: only the
   * person's press calls the gate or the reshape route, bound to the plan version. `true` when the reply was one of these
   * (handled here, whatever the outcome); `false` to read it as anything else.
   */
  private onPlanReply(frame: { chat: string; cliKey: string; turnId?: string; ok: boolean; blocks: readonly string[] }): boolean {
    const turnId = frame.turnId;
    if (turnId === undefined || this.deps.heldPlan === undefined) return false;
    const job = this.launchedJob(frame.chat);
    if (job === null) return false;
    let planEdit: string | null = null;
    let rev: ProposalRevision | null = null;
    for (const b of frame.blocks) {
      planEdit ??= parsePlanEditBlock(b);
      const r = parseRevisionBlock(b);
      if (rev === null && r !== null && r.revises === job.proposal.pid) rev = r;
    }
    if (planEdit === null && rev === null) return false;
    const instance = this.deps.instanceOf(frame.chat);
    let published = false;
    const scheduledKey = `${frame.chat}\u0000${turnId}`;
    this.planScheduled.add(scheduledKey);
    const work = this.order.run(`chat\u0000${frame.chat}`, async () => {
      try {
        await this.planReplyWork(frame, turnId, job, planEdit, rev, instance, () => {
          published = true;
        });
      } finally {
        this.planScheduled.delete(scheduledKey);
        // A hold this turn's message took on another open proposal is released now, saying whether the change landed.
        const key = `${frame.chat}\u0000${turnId}`;
        if (this.deferredRelease.delete(key)) {
          try {
            await this.lock.run(`chat\u0000${instance ?? frame.chat}`, async () => {
              const f = [...foldProposals(this.deps.records(frame.chat)).values()].find((x) => x.state === 'revising' && x.hold === turnId);
              if (f !== undefined) this.write(frame.chat, { at: this.now(), turnId, kind: 'proposal_released', pid: f.proposal.pid, note: published ? null : "Your change wasn't applied: say it again." }, instance);
            });
          } finally {
            const n = (this.settling.get(key) ?? 1) - 1;
            if (n <= 0) this.settling.delete(key);
            else this.settling.set(key, n);
          }
        }
      }
    })
      .catch((err: unknown) => this.log(`[proposals] chat ${frame.chat}: turn ${turnId}'s plan offer failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    return true;
  }

  private async planReplyWork(
    frame: { chat: string },
    turnId: string,
    job: { proposal: ArtifactProposal; runId: string },
    planEdit: string | null,
    rev: ProposalRevision | null,
    instance: string | null,
    onPublished: () => void,
  ): Promise<void> {
    {
      if (this.deps.instanceOf(frame.chat) !== instance) return;
      if (planEdit !== null && planEdit !== job.runId) {
        this.log(`[proposals] chat ${frame.chat}: turn ${turnId}'s plan edit names ${planEdit.slice(0, 64)}, not the chat's job ${job.runId} — dropped`);
        return;
      }
      // One offer per turn, and never from a reply older than the chat's newest message (a slow seat's late answer
      // must not replace a newer offer on the same plan version).
      const isNewest = (): boolean => {
        const rs = this.deps.records(frame.chat);
        const order = rs.filter((r) => r.kind === 'user').map((r) => r.turnId);
        const mine = order.indexOf(turnId);
        return !rs.some((r) => r.kind === 'plan_offer' && r.turnId === turnId) && (mine === -1 || mine === order.length - 1);
      };
      if (!isNewest()) return;
      const held = await this.deps.heldPlan!(job.runId);
      if (held === null || held.state !== 'held') {
        this.log(`[proposals] chat ${frame.chat}: turn ${turnId}'s plan reply, but job ${job.runId} is not waiting at its plan — no offer`);
        return;
      }
      // The person's words, waited for as the turn's own record (the route writes it after the engine took it).
      for (let i = 0; i < 25 && turnWords(this.deps.records(frame.chat), turnId) === ''; i += 1) await new Promise((res) => setTimeout(res, 200));
      const message = turnWords(this.deps.records(frame.chat), turnId).trim();
      const base = { id: `${frame.chat}:offer:${turnId}`, runId: job.runId, pid: job.proposal.pid, ord: held.ord, planRev: held.planRev };
      let offer: ChatPlanOffer | null = null;
      const shapeEdit = rev === null ? null : { ...(rev.edits.card !== undefined ? { card: rev.edits.card } : {}), ...(rev.edits.option !== undefined ? { option: rev.edits.option } : {}), ...(rev.edits.depth !== undefined ? { depth: rev.edits.depth } : {}) };
      if (shapeEdit !== null && Object.keys(shapeEdit).length > 0) {
        if (!held.reshapeable) {
          this.log(`[proposals] chat ${frame.chat}: turn ${turnId} changes the job, but its work plan was already accepted — no reshape offer`);
          return;
        }
        offer = await this.reshapeOffer(frame.chat, job.proposal, shapeEdit, base);
      } else if (planEdit !== null) {
        if (message === '') return;
        const leadKey = held.lead ?? job.proposal.seats?.lead ?? null;
        const lead = leadKey === null ? 'the lead' : (this.deps.rosterEligible().find((s) => s.key === leadKey)?.name ?? leadKey);
        // The person's message whole: the lead reads every word of it (only the offer's line shows a preview).
        const note = message;
        offer = {
          ...base,
          kind: 'send_back',
          text: `Send it back to ${lead} with: “${note.length > 200 ? `${note.slice(0, 199)}…` : note}”?`,
          note,
          choices: [{ label: 'Send it back', action: 'send_back' }, { label: 'No', action: 'dismiss' }],
        };
      }
      if (offer === null) return;
      // Published under the chat's lock, re-checked there (a newer message may have landed while it resolved).
      await this.lock.run(`chat\u0000${instance ?? frame.chat}`, async () => {
        if (this.deps.instanceOf(frame.chat) !== instance || !isNewest()) return;
        if (this.write(frame.chat, { at: this.now(), turnId, kind: 'plan_offer', offer: offer! }, instance)) onPublished();
      });
    }
  }

  /** The "start it again as…" offer: the new shape resolved like a revision, its losses and missing inputs named. */
  private async reshapeOffer(chatId: string, held: ArtifactProposal, edits: Pick<ProposalRevisionEdits, 'card' | 'option' | 'depth'>, base: Pick<ChatPlanOffer, 'id' | 'runId' | 'pid' | 'ord' | 'planRev'>): Promise<ChatPlanOffer | null> {
    const chat = this.jobChat(chatId);
    if (chat === null) return null;
    const ctx = await this.jobContext(chatId, base.id, null, 'person', chat, { revises: held.pid, lineage: held.lineage ?? held.pid, notes: [] });
    const merged = await this.mergeJobRevision(held, edits, ctx);
    const card = CATALOG_V2_CARDS.find((c) => c.id === merged.facts.card);
    if (card === undefined || (merged.facts.card === held.shape?.card && optionFor(card, merged.facts.option) === held.shape?.option && merged.facts.depth === held.shape?.depth)) return null;
    const option = optionFor(card, merged.facts.option);
    let needs: string[] = [];
    let command: string | null = card.command;
    try {
      const p = await this.proposalOf(chatId, base.id, { ...merged.facts, by: 'person', source: 'reshape' }, ctx, this.deps.records(chatId), false, held);
      if (p.kind !== 'job') {
        this.log(`[proposals] chat ${chatId}: a change of job to ${card.id} makes a document — no reshape offer (it is a new proposal)`);
        return null;
      }
      if (p.coming !== undefined) return null;
      needs = (p.needs ?? []).filter((n) => n.required && n.status === 'missing').map((n) => n.label);
      command = p.command ?? command;
    } catch (err) {
      if (this.refusalOf(err) === null) throw err;
      return null;
    }
    const noun = nounOf(card, option);
    const words = [...merged.lost.map((g) => checksLabel([g])), ...merged.lostSeats.map((k) => SEAT_WORDS[k])];
    const lostText = words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
    const text = [
      `That's a different job: start it again as ${noun}?`,
      ...(words.length > 0 ? [`It would no longer have ${lostText}.`] : []),
      ...(needs.length > 0 ? [`It needs: ${needs.join(', ')}.`] : []),
      'Edits to this plan are not carried.',
    ].join(' ');
    return {
      ...base,
      kind: 'reshape',
      text,
      reshape: { card: card.id, option, depth: merged.facts.depth, label: nounOf(card, option), command: command ?? null, lost: merged.lost, lostSeats: merged.lostSeats, needs },
      choices: [{ label: 'Start again', action: 'reshape' }, { label: 'Keep this plan', action: 'dismiss' }],
    };
  }

  /**
   * (DES-CATALOG-002 §2.3, §4.6) The per-message job lines for this chat: how it routes new work, the chat catalog
   * digest, and what is open, held at its plan or running. `null` when job routing is off.
   */
  async jobTurn(chatId: string, accepts?: boolean): Promise<{ mode: 'cards' | 'prose'; context: JobTurnContext } | null> {
    if (!this.jobsOn()) return null;
    // The earlier turns' proposals are published first (codex r5): the ids this turn is told are the ones its hold binds.
    await this.order.run(`chat\u0000${chatId}`, async () => undefined);
    const mode: 'cards' | 'prose' = (accepts ?? this.acceptsJobs(chatId)) ? 'cards' : 'prose';
    const chat = this.jobChat(chatId);
    let status: ((card: string, option: string | null) => 'available' | 'coming_soon' | 'unavailable') | undefined;
    try {
      const served = await this.deps.served!(chat?.projectId ?? null);
      status = (card, option) => resolveOption(card, option, served)?.resolved.status ?? 'unavailable';
    } catch {
      status = undefined;
    }
    const context: JobTurnContext = { digest: catalogDigest('chat', status !== undefined ? { status } : {}) };
    if (mode === 'prose') {
      // The command line names the command: the chat digest's cards with their commands.
      context.digest = `${context.digest}\nCommands: ${CATALOG_V2_CARDS.filter((c) => detectable(c) && c.command !== null).map((c) => `${c.id} ${c.command}`).join('; ')}.`;
      return { mode, context };
    }
    const open = [...foldProposals(this.deps.records(chatId)).values()].find((f) => (f.state === 'open' || f.state === 'revising') && f.proposal.shape !== undefined);
    if (open !== undefined) {
      const p = open.proposal;
      context.open = { pid: p.pid, label: p.what.label, card: p.shape!.card, option: p.shape!.option, repo: p.repos[0] ?? null, seats: [...(p.seats?.keys ?? [])], checks: checksLabel(p.gate ?? []) };
    }
    const job = this.launchedJob(chatId);
    if (job !== null && this.deps.heldPlan !== undefined) {
      const held = await this.deps.heldPlan(job.runId).catch(() => null);
      if (held?.state === 'held') {
        const leadKey = held.lead ?? job.proposal.seats?.lead ?? null;
        context.heldPlan = { runId: job.runId, pid: job.proposal.pid, label: job.proposal.what.label, version: held.planRev, lead: leadKey === null ? null : (this.deps.rosterEligible().find((s) => s.key === leadKey)?.name ?? leadKey) };
      } else if (held?.state === 'running') {
        context.running = { runId: job.runId, label: job.proposal.what.label };
      }
    }
    return { mode, context };
  }

  /** The chat as a job's resolution sees it, or `null` once it has ended. */
  private jobChat(chatId: string): JobChat | null {
    const c = this.deps.chat(chatId);
    return c === null ? null : { projectId: c.projectId, repos: c.repos, lead: c.lead, seats: c.seats };
  }

  private async jobContext(chatId: string, pid: string, turnId: string | null, seat: string, chat: JobChat, extra: Pick<JobContext, 'revises' | 'lineage' | 'notes'> & Partial<Pick<JobContext, 'answers' | 'request'>>): Promise<JobContext> {
    if (this.deps.served === undefined) throw new JobRefusal('operation_unavailable', 'this daemon cannot read its catalog for a job', 409);
    let served: ServedState & { rev: string };
    try {
      served = await this.deps.served(chat.projectId);
    } catch (err) {
      throw new JobRefusal('catalog_unavailable', err instanceof Error ? err.message : String(err), 409);
    }
    const projectLabel = chat.projectId === null ? 'Not in a project · this chat' : ((await this.deps.projectName(chat.projectId)) ?? chat.projectId);
    const qeOff = (await this.deps.qeOff?.().catch(() => false)) === true;
    const powerPresets = (await this.deps.powerPresets?.(chat.projectId).catch(() => null)) ?? null;
    return { chatId, pid, turnId, seat, chat, served, roster: this.deps.rosterEligible(), projectLabel, qeOff, powerPresets, ...extra };
  }

  /** Source availability matters only to a card that shows this input. Keep a failed read a named refusal. */
  private async loadJobSources(facts: Pick<JobFacts, 'card' | 'option'>, ctx: JobContext): Promise<void> {
    const card = CATALOG_V2_CARDS.find((c) => c.id === facts.card);
    const r = card === undefined ? null : resolveOption(card.id, optionFor(card, facts.option), ctx.served);
    if (!r?.resolved.inputs.some((i) => i.id === 'sources') || ctx.jobSources !== undefined) return;
    try {
      const sources = await this.deps.jobSources?.(ctx.chat.projectId);
      if (sources !== undefined) ctx.jobSources = sources;
      if (sources !== undefined && !sources.some((s) => s.web === true)) {
        // A reason only: a failed read keeps the plain fallback, never refuses the proposal.
        const why = await this.deps.webReason?.(ctx.chat.projectId).catch(() => undefined);
        if (why !== undefined) ctx.webReason = why;
      }
    } catch (err) {
      throw new JobRefusal('sources_unavailable', err instanceof Error ? err.message : String(err), 409);
    }
  }

  /** (CJ13) The last authors read per repository and words, for a short while: a revision and its rebuild, and a run
   *  of swaps, read the change once (a failed read is never kept). */
  private readonly reviewAuthorsSeen = new Map<string, { at: number; authors: readonly string[] }>();

  /**
   * (CJ13) A review of a change is never led or checked by a seat that wrote it: the launch drops the change's authors
   * from its roster, so the proposal's seats are chosen without them (the default lead included) and the passage names
   * none of them. The change is read from the words the launch reads (the brief and its input lines). A read that
   * fails, or that would leave no seat, keeps the roster: the launch then decides (it refuses an author named as
   * primary, and a roster of authors only as `no_independent_reviewer`).
   */
  private async reviewRoster(facts: Pick<JobFacts, 'card' | 'option' | 'words' | 'details' | 'repoRef' | 'inputs'>, ctx: JobContext): Promise<JobContext> {
    const card = CATALOG_V2_CARDS.find((c) => c.id === facts.card);
    const r = card === undefined ? null : resolveOption(card.id, optionFor(card, facts.option), ctx.served);
    const repo = repoOf(facts, ctx.chat);
    if (r?.workflow !== REVIEW_CHANGE_WORKFLOW || repo === null || this.deps.reviewAuthors === undefined) return ctx;
    const words = [briefOf(facts), ...inputLines({ inputs: facts.inputs })].join('\n\n');
    const key = `${repo.id}\u0000${words}`;
    const now = Date.now();
    let authors = this.reviewAuthorsSeen.get(key);
    if (authors === undefined || now - authors.at > 30_000) {
      const read = await this.deps.reviewAuthors(repo.id, words).catch(() => null);
      if (read === null) return ctx;
      authors = { at: now, authors: read };
      for (const [k, v] of this.reviewAuthorsSeen) if (now - v.at > 30_000) this.reviewAuthorsSeen.delete(k);
      this.reviewAuthorsSeen.set(key, authors);
    }
    const roster = ctx.roster.filter((s) => !authors.authors.includes(s.key));
    return roster.length === 0 || roster.length === ctx.roster.length ? ctx : { ...ctx, roster };
  }

  /** Resolve the revision's shape first, then load only the choices that its input checks need. */
  private async mergeJobRevision(parent: ArtifactProposal, edits: ProposalRevisionEdits, ctx: JobContext): Promise<ReturnType<typeof mergeRevision>> {
    const shape = mergeRevision(parent, {
      ...(edits.card !== undefined ? { card: edits.card } : {}),
      ...(edits.option !== undefined ? { option: edits.option } : {}),
    }, ctx).facts;
    await this.loadJobSources(shape, ctx);
    // (CJ13) The seats are checked against the authors of the change the revision names (its words, details, inputs
    // and repository may all move the target), so it is merged once to read them.
    const reviewCtx = await this.reviewRoster(mergeRevision(parent, edits, ctx).facts, ctx);
    const merged = mergeRevision(parent, edits, reviewCtx);
    // Seats carried from a version that reviewed another change may all be the new change's authors: then they are
    // picked again from the reviewers left (the lead stays when it still may lead). Seats this revision names itself
    // are the person's choice and are never replaced (a choice of authors only is short, and its Start is refused).
    const named = edits.lead !== undefined || edits.addSeats !== undefined || edits.removeSeats !== undefined;
    const left = new Set(reviewCtx.roster.map((s) => s.key));
    const authors = new Set(ctx.roster.map((s) => s.key).filter((k) => !left.has(k)));
    const seats = merged.facts.seats;
    if (reviewCtx !== ctx && !named && seats !== null && seats.length > 0 && seats.every((k) => authors.has(k))) {
      const lead = merged.facts.lead !== null && left.has(merged.facts.lead) ? merged.facts.lead : null;
      return { ...merged, facts: { ...merged.facts, seats: null, lead } };
    }
    return merged;
  }

  /** Job proposals are on: the flag, the catalog read and the operation. */
  private jobsOn(): boolean {
    return this.deps.flags().proposals && this.deps.jobs?.() === true && this.deps.served !== undefined;
  }

  /**
   * A document option picked or reached by a revision is an artifact `create` (§4.6 "Across kinds"): the existing create
   * resolution (sources, scope, helpers, its own identity), with the conversation's fields on it.
   */
  private async documentProposal(chatId: string, pid: string, facts: JobFacts, ctx: JobContext, records: readonly ChatTranscriptRecord[]): Promise<ArtifactProposal> {
    const card = CATALOG_V2_CARDS.find((c) => c.id === facts.card)!;
    const r = resolveOption(card.id, optionFor(card, facts.option), ctx.served);
    const style = r?.style ?? null;
    const seed = this.deps.catalog.find((c) => c.launch.kind === 'document' && c.launch.style === style);
    if (r === null || seed === undefined) throw new JobRefusal('operation_unavailable', `${card.title} can't be made from a chat on this daemon`, 409);
    if (!this.deps.flags().create) throw new JobRefusal('operation_unavailable', 'studio cannot start a document from a chat on this daemon yet', 409);
    const turnId = ctx.turnId ?? `person:${pid.slice(pid.lastIndexOf(':') + 1)}`;
    // Crew's kind line goes first, as `withBriefLines` puts it on a run: a long request is cut at its end, never the line.
    const words = [r.resolved.brief ?? '', briefOf(facts)].filter((x) => x !== '').join('\n\n');
    const made = await this.resolve({ chatId, turnId, seat: ctx.seat, block: { op: 'entry', entry: seed.id, brief: words, sources: ['chat'], repos: facts.repoRef !== null ? [facts.repoRef] : [] }, records });
    if (made === null) throw new JobRefusal('operation_unavailable', 'studio cannot start a document from a chat on this daemon yet', 409);
    const shape: ProposalShape = { card: card.id, option: r.option?.id ?? null, depth: null, by: facts.by, source: facts.source, ...(facts.guess !== undefined ? { guess: facts.guess } : {}) };
    const kindTok = { id: 'kind', kind: (card.variant !== undefined ? 'option' : 'card') as 'option' | 'card', label: nounOf(card, shape.option), swap: null };
    const checksTok = { id: 'checks', kind: 'checks' as const, label: checksLabel(r.resolved.gate), swap: null };
    const documentsInput = r.resolved.inputs.find((i) => i.id === 'documents');
    const documents = ctx.documents ?? [];
    const ok = documents.filter((s) => s.status === 'ok');
    const label = `${ok.length} document${ok.length === 1 ? '' : 's'}`;
    const needs: ProposalNeed[] = documentsInput === undefined ? [] : [{ ...documentsInput, status: ok.length > 0 ? 'met' : 'missing', value: label }];
    const why = documents.find((s) => s.status === 'struck')?.reason;
    const question: ProposalQuestion | null = documentsInput?.required === true && ok.length === 0
      ? { kind: 'missing', text: `Which documents?${why !== undefined ? ` ${why}` : ''}`, choices: [] }
      : null;
    const documentsTok: ProposalToken[] = documentsInput === undefined ? [] : [{ id: 'documents', kind: 'documents', label, swap: null, documents }];
    // A document option this engine cannot draft (Respond and Rework without `interactive-draft-sourced`) is said, with
    // why, and offers no Start (CS8).
    const offline = r.resolved.status !== 'available' ? (r.resolved.statusNote ?? `${card.title} can't start on this daemon`) : null;
    return {
      ...made,
      // These tokens passed the document packet's plan, including PDF text and the shared budget. Keep that
      // decision rather than applying the legacy source count cap or CS4's larger job limits.
      ...(documentsInput !== undefined ? { sources: [...made.sources, ...ok], inputs: { ...facts.inputs }, needs } : {}),
      blocked: made.blocked ?? offline ?? question?.text ?? null,
      pid,
      turnId: ctx.turnId,
      // `what.entry` stays the document entry the create launcher reads its style from (codex r1); the card is in `shape`.
      shape,
      catalogRev: ctx.served.rev,
      resolution: r.resolved.resolution,
      launch: 'document',
      command: r.option?.command ?? card.command,
      gate: [...r.resolved.gate],
      words: facts.words,
      details: [...facts.details],
      sentence: { text: `I'll make {kind} from this conversation${documentsInput !== undefined ? ', reading {documents}' : ''}, filed in ${made.filedIn.label}, checked by {checks}.`, tokens: [kindTok, ...documentsTok, checksTok], notes: [...ctx.notes], ask: offline !== null ? null : question?.text ?? (made.blocked === null ? 'Start?' : null) },
      suggestions: [],
      question,
      revises: ctx.revises,
      lineage: ctx.lineage ?? pid,
      ...(ctx.answers !== undefined ? { answers: ctx.answers } : {}),
      ...(ctx.request !== undefined ? { request: ctx.request } : {}),
    };
  }

  /** Resolve facts to their proposal. `previous` marks a rebuild; null is a held job without a stored parent. */
  private async proposalOf(chatId: string, pid: string, facts: JobFacts, ctx: JobContext, records: readonly ChatTranscriptRecord[], allowHidden = false, previous?: ArtifactProposal | null): Promise<ArtifactProposal> {
    const card = CATALOG_V2_CARDS.find((c) => c.id === facts.card);
    const r = card === undefined ? null : resolveOption(card.id, optionFor(card, facts.option), ctx.served);
    await this.loadJobSources(facts, ctx);
    ctx = await this.reviewRoster(facts, ctx);
    if (r?.resolved.inputs.some((i) => i.id === 'documents')) {
      if (facts.inputs['documents'] === undefined) {
        const { binding } = bindingOf(records, ctx.turnId ?? '\u0000');
        // A rebuild never discovers new files. Only a fresh card, or a switch of card or option from a shape that took no
        // documents, fills (a person's own empty or reduced selection means the parent already took documents).
        const reshaped = previous?.shape?.card !== facts.card || previous?.shape?.option !== (r.option?.id ?? null);
        const fill = previous === undefined || (previous !== null && reshaped && !previous.needs?.some((n) => n.id === 'documents'));
        const tokens = fill ? [...new Set([
          ...this.deps.attachments(chatId).map((a) => `attachment:${a.id}`),
          ...(binding?.named.docs ?? []).map((ref) => `doc:${ref}`),
          ...(binding?.artifact !== undefined ? [`doc:${binding.artifact.ref}`] : []),
        ])].slice(0, 20) : [];
        // Persist even an empty fill, so factsOf cannot pick up files the person never saw.
        facts = { ...facts, inputs: { ...facts.inputs, documents: { kind: 'documents', tokens } } };
      }
      const input = facts.inputs['documents'];
      ctx = { ...ctx, documents: await this.authorizeDocumentsAt(chatId, input?.kind === 'documents' ? input.tokens : [], records, ctx.turnId ?? '\u0000', r !== null && proposalKindOf(r) === 'create', true) };
    }
    // An unsure reading holds no Start wherever the proposal is rebuilt (a Go's edits, a refresh; codex r4).
    if (r !== null && proposalKindOf(r) === 'create') return withAskOverlay(await this.documentProposal(chatId, pid, facts, ctx, records));
    return withAskOverlay(resolveJob(facts, ctx, { allowHidden }));
  }

  private refusalOf(err: unknown): DecideResult | null {
    if (err instanceof JobRefusal) return { code: err.status, body: { code: err.code, error: err.message } };
    if (err instanceof EditRefusal) return { code: 400, body: { code: 'edits_invalid', error: err.message } };
    return null;
  }

  /** Explicit file edits refuse any struck token; a rebuild refuses a downgrade of a file the person saw as ok. */
  private refuseStruckDocuments(p: ArtifactProposal, previous?: ArtifactProposal): void {
    const wasOk = previous?.sentence?.tokens.flatMap((t) => t.kind === 'documents' ? t.documents ?? [] : []).filter((s) => s.status === 'ok').map((s) => s.token) ?? [];
    const struck = p.sentence?.tokens.flatMap((t) => t.kind === 'documents' ? t.documents ?? [] : []).find((s) => s.status === 'struck' && (previous === undefined || wasOk.includes(s.token)));
    if (struck === undefined) return;
    const why = `${struck.label} cannot be used (${struck.reason})`;
    if (previous !== undefined) throw new JobRefusal('source_gone', why, 409);
    throw new EditRefusal(why);
  }

  /**
   * `POST /chats/:id/proposals` after the route's capability, person and owner checks: a person-made proposal (a `/`
   * pick, a typed command, a question's choice) or a revision (a swap, a suggestion, a question's choice). No seat turn
   * runs. A repeated `requestId` answers the same proposal; another body under it is refused.
   */
  propose(chatId: string, body: PersonProposalBody | PersonRevisionBody, actor: Actor, instance: string | null): Promise<DecideResult> {
    return this.lock.run(`chat\u0000${instance ?? chatId}`, async () => {
      if (this.deps.instanceOf(chatId) !== instance) return this.gone(chatId);
      if (!this.jobsOn()) return { code: 409, body: { code: 'operation_unavailable', error: 'this daemon does not take job proposals from a chat' } };
      const pid = personPid(chatId, actor.id, body.requestId);
      const digest = requestDigest(body);
      const records = this.deps.records(chatId);
      const held = foldProposals(records).get(pid);
      if (held !== undefined) {
        if (held.proposal.request?.digest === digest) return { code: 201, body: { view: viewOf(held) } };
        return { code: 409, body: { code: 'request_reused', error: 'this requestId already made a different proposal', view: viewOf(held) } };
      }
      try {
        if ('revises' in body) {
          return await this.reviseLocked(chatId, { revises: body.revises, edits: body.edits }, { person: actor, source: body.source, pid, request: { id: body.requestId, digest }, turnId: null, message: null }, instance);
        }
        const chat = this.jobChat(chatId);
        if (chat === null) return { code: 409, body: { code: 'chat_gone', error: `chat ${chatId} has ended; start a new one` } };
        // A command names its card (and maybe its option); an alias is the only way to a hidden card.
        let card = body.card;
        let option: string | null | undefined = body.option;
        let allowHidden = false;
        if (card.startsWith('/')) {
          const hit = parseCommand(card);
          if (hit === null) return { code: 400, body: { code: 'card_unknown', error: `no job has the command ${card.slice(0, 80)}` } };
          allowHidden = CATALOG_V2_CARDS.find((c) => c.id === hit.card)?.aliases.some((a) => a.command.toLowerCase() === card.trim().split(/\s+/u)[0]!.toLowerCase()) === true;
          card = hit.card;
          if (option === undefined && hit.option !== undefined) option = hit.option;
        }
        const facts: JobFacts = {
          card,
          option,
          depth: body.depth ?? null,
          words: (body.words ?? '').slice(0, 8000),
          details: [],
          repoRef: null,
          projectId: chat.projectId,
          lead: null,
          seats: null,
          inputs: {},
          skipQe: null,
          by: 'person',
          source: body.source,
        };
        // A declared app address comes only from the person's words; several addresses need their choice.
        if (CATALOG_V2_CARDS.find((c) => c.id === card)?.inputs?.includes('url') === true) {
          const url = onePersonUrl(facts.words);
          if (url !== null) facts.inputs['url'] = { kind: 'url', value: url };
        }
        const ctx = await this.jobContext(chatId, pid, null, 'person', chat, { revises: null, lineage: null, notes: [], request: { id: body.requestId, digest } });
        const proposal = await this.proposalOf(chatId, pid, facts, ctx, records, allowHidden);
        if (!this.write(chatId, { at: this.now(), turnId: `person:${pid.slice(pid.lastIndexOf(':') + 1)}`, kind: 'proposal', proposal }, instance)) return this.gone(chatId);
        const view = foldProposals(this.deps.records(chatId)).get(pid);
        return { code: 201, body: { view: view !== undefined ? viewOf(view) : { proposal, state: 'open' } } };
      } catch (err) {
        const refused = this.refusalOf(err);
        if (refused !== null) return refused;
        throw err;
      }
    });
  }

  /**
   * A revision of the lineage's open proposal (§4.6), under the chat's lock: the stale-parent check, the merge, the
   * lost-check question, the re-resolution, and the write that supersedes the parent. `src.person` is the person's
   * route (only it takes `confirmLoss`); otherwise a seat's block bound to the person's message `src.turnId`.
   */
  private async reviseLocked(
    chatId: string,
    rev: ProposalRevision,
    src: { person: Actor | null; source: ProposalShape['source']; pid: string; request?: { id: string; digest: string }; turnId: string | null; message: string | null },
    instance: string | null,
  ): Promise<DecideResult> {
    const records = this.deps.records(chatId);
    const folded = foldProposals(records);
    const parent = folded.get(rev.revises);
    if (parent === undefined) return { code: 404, body: { error: `no proposal ${rev.revises} in chat ${chatId}` } };
    // The parent must be the lineage's open proposal: superseded, accepted, decided, or held by another turn is stale.
    const ownHold = parent.state === 'revising' && src.turnId !== null && parent.hold === src.turnId;
    if (!(parent.state === 'open' || ownHold)) {
      return { code: 409, body: { code: parent.state === 'revising' ? 'proposal_revising' : 'proposal_stale', error: parent.state === 'revising' ? 'your typed change is still being applied; wait for it' : 'this proposal is no longer the open one in this chat', view: viewOf(parent) } };
    }
    if (parent.proposal.shape === undefined) return { code: 400, body: { code: 'edits_invalid', error: 'only a job proposal is revised this way' } };
    const chat = this.jobChat(chatId);
    if (chat === null) return { code: 409, body: { code: 'chat_gone', error: `chat ${chatId} has ended; start a new one` } };
    const fromPerson = src.person !== null;
    // Only the person's own press can give up a check.
    const edits: ProposalRevisionEdits & Record<string, unknown> = { ...rev.edits };
    // What the press confirms (codex r4): `true` on a lost-check question covers exactly what that question names; a
    // swap or suggestion carries the ids its own label named. Anything else covers nothing.
    const confirmIds: ReadonlySet<string> | null = !fromPerson || edits.confirmLoss === undefined
      ? null
      : Array.isArray(edits.confirmLoss)
        ? new Set(edits.confirmLoss)
        : parent.proposal.question?.kind === 'lost_check'
          ? new Set<string>([...(parent.proposal.question.lost ?? []), ...(parent.proposal.question.lostSeats ?? [])])
          : new Set<string>();
    const confirmed = confirmIds !== null;
    delete edits.confirmLoss;
    const ctx0 = await this.jobContext(chatId, src.pid, src.turnId, fromPerson ? 'person' : (parent.proposal.seat ?? 'seat'), chat, {
      revises: parent.proposal.pid,
      lineage: parent.proposal.lineage ?? parent.proposal.pid,
      notes: [],
      ...(src.turnId !== null ? { answers: src.turnId } : {}),
      ...(src.request !== undefined ? { request: src.request } : {}),
    });
    // A QE skip is never applied from a seat's block (§4.6 step 7, §9.2 (ac)): it becomes wicked's question, with the
    // person's own reason when their message (the one this turn answers) gives one unquoted, else asking for it. A skip
    // the person never asked for in their own words changes nothing. On the person's route, only the press applies it.
    let qe: { reason: string | null } | null = null;
    const extraNotes: string[] = [];
    if (edits.skipQe !== undefined && !confirmed) {
      const reason = edits.skipQe.reason;
      delete edits.skipQe;
      if (parent.proposal.gate?.includes('qe-acceptance') !== true) extraNotes.push('Not changed: this job has no QE acceptance to skip.');
      else if (fromPerson || qeSkipBound(reason, src.message)) qe = { reason };
      else if (personAskedSkip(src.message)) qe = { reason: null };
      else extraNotes.push('Not changed: QE acceptance stays. Skipping it needs your own reason, in your own words.');
    }
    // What a seat's block carries into the brief must be the person's own (codex r3): a detail added or removed, and a
    // text input, appear in their message (outside quotes and reported speech); anything else is refused with a note.
    if (!fromPerson) {
      const said = ownWords(src.message ?? '').toLowerCase();
      const fromThem = (t: string): boolean => t.trim() !== '' && said.includes(t.trim().toLowerCase());
      if (edits.detail !== undefined) {
        const add = (edits.detail.add ?? []).filter((d) => fromThem(d));
        // A removal needs the person to ask for one, and a carried fact that names a check is never dropped from a
        // seat's block (codex r4: "keep a separate judge" mentions the detail, it does not remove it).
        // The removal verb belongs to THIS detail: within a few words before it (pi r5).
        const asksRemoval = (d: string): boolean => {
          const at = said.indexOf(d.trim().toLowerCase());
          if (at === -1) return false;
          const before = said.slice(Math.max(0, at - 60), at);
          // The removal verb in the same clause, right before the detail, and not itself negated ("do not remove …").
          const m = /\b(?:remove|drop|forget|scrap|undo|take\s+out|no\s+longer|don'?t\s+need)\b(?:\s+[^\s.;,]+){0,4}\s*$/iu.exec(before);
          // Not negated, and no keeping or new clause between the verb and the detail ("remove X and keep <detail>").
          return m !== null && !/\b(?:don'?t|do\s+not|never|not)\s+$/iu.test(before.slice(0, m.index)) && !/\b(?:keep|keeping|retain|retaining|and|but|then|while|whilst)\b/iu.test(before.slice(m.index).replace(/^\S+/u, ''));
        };
        const namesCheck = (d: string): boolean => /\b(?:reviews?|reviewers?|judges?|parity|qe|acceptance|tests?|checks?|cited\s+findings|floor|gates?)\b/iu.test(d);
        const remove = (edits.detail.remove ?? []).filter((d) => fromThem(d) && asksRemoval(d) && !namesCheck(d));
        for (const d of edits.detail.add ?? []) if (!fromThem(d)) extraNotes.push(`Not changed: “${d.slice(0, 60)}” isn't in what you said`);
        for (const d of edits.detail.remove ?? []) if (!remove.includes(d)) extraNotes.push(`Not changed: “${d.slice(0, 60)}” stays (say to remove it${namesCheck(d) ? '; it names a check, so it stays' : ''})`);
        edits.detail = { ...(add.length > 0 ? { add } : {}), ...(remove.length > 0 ? { remove } : {}) };
      }
      if (edits.inputs !== undefined) {
        const kept: NonNullable<ProposalRevisionEdits['inputs']> = {};
        for (const [k, v] of Object.entries(edits.inputs)) {
          if (v.kind === 'requirements' || v.kind === 'documents' || v.kind === 'sources' || fromThem(v.value)) kept[k] = v;
          else extraNotes.push(`Not changed: ${k.slice(0, 40)} must be in your own words`);
        }
        edits.inputs = kept;
      }
    }
    // The job's own words are the person's (§4.6 rule 6): a seat's block may fill a missing intent, never replace it
    // (codex r1 on Lane D: the brief the lead reads is never the seat's rewrite).
    if (!fromPerson && edits.inputs !== undefined && Object.hasOwn(edits.inputs, 'intent') && (parent.proposal.words ?? '').trim() !== '') {
      const { intent: _dropped, ...rest } = edits.inputs;
      void _dropped;
      edits.inputs = rest;
      extraNotes.push("Not changed: the job's own words are yours; say them again to change them");
    }
    const merged = await this.mergeJobRevision(parent.proposal, edits, ctx0);
    merged.notes.push(...extraNotes);
    const ctx: JobContext = { ...ctx0, notes: merged.notes };
    // A hidden card stays reachable while the revision keeps it (it was reached by its alias once).
    const allowHidden = merged.facts.card === parent.proposal.shape.card;
    // The candidate as it would be written, settings included (a daemon's QE setting can drop QE from it): its checks
    // are compared with the parent's too, so nothing is lost unseen (codex r2).
    let candidate: ArtifactProposal | null = null;
    let candidateErr: unknown = null;
    // A revision is not the detection any more: a changed card or option drops the guess it no longer describes (codex
    // r2), and an unsure guess is cleared only by a revision that names the shape (a card or an option: the seat's
    // reading of the person's clarification, the same card included); a repository or a detail leaves the question
    // standing (codex r3).
    const g = merged.facts.guess;
    const seed = CATALOG_V2_CARDS.find((c) => c.id === merged.facts.card);
    // Named AND taken: a refused card or option leaves the question standing (codex r4).
    const namesShape = seed !== undefined
      && (rev.edits.card !== undefined || rev.edits.option !== undefined)
      && (rev.edits.card === undefined || rev.edits.card === merged.facts.card)
      && (rev.edits.option === undefined || optionFor(seed, rev.edits.option ?? undefined) === optionFor(seed, merged.facts.option ?? undefined));
    const moved = g !== undefined && (seed === undefined || g.card !== merged.facts.card || optionFor(seed, g.option) !== optionFor(seed, merged.facts.option));
    const stale = g !== undefined && (moved || (g.band === 'ask' && namesShape));
    try {
      const { guess: _g, ...unguessed } = merged.facts;
      void _g;
      const factsNow: JobFacts = stale ? unguessed : merged.facts;
      candidate = withAskOverlay(keepReshape(await this.proposalOf(chatId, src.pid, { ...factsNow, by: fromPerson ? 'person' : factsNow.by, source: src.source }, ctx, records, allowHidden, parent.proposal), parent.proposal));
    } catch (err) {
      candidateErr = err;
    }
    // Losses only the fully resolved candidate shows (a daemon setting since): never covered by an earlier press.
    const extra: CatalogGateId[] = [];
    for (const g of parent.proposal.gate ?? []) if (candidate !== null && !(candidate.gate ?? []).includes(g) && !merged.lost.includes(g) && !(g === 'qe-acceptance' && merged.facts.skipQe !== null)) extra.push(g);
    merged.lost.push(...extra);
    const loses = merged.lost.length > 0 || merged.lostSeats.length > 0;
    // A press confirms exactly what was disclosed to it (codex r3): the question's named losses, or a swap's own
    // (catalog-derived, named in its label). A loss beyond that asks again.
    const uncovered = confirmIds === null ? [...merged.lost, ...merged.lostSeats] : [...merged.lost, ...merged.lostSeats].filter((k) => !confirmIds.has(k));
    const covered = confirmed && uncovered.length === 0;
    // A candidate the daemon cannot make is said at once, never behind a question it could not honour (codex r4, r5):
    // a refusal, or a candidate blocked for a reason no answer fixes (unavailable, coming).
    if (candidate === null && candidateErr !== null && loses && !covered) {
      const refused = this.refusalOf(candidateErr);
      if (refused !== null) return refused;
    }
    // Unmakeable = coming, or blocked for a reason other than the one question an answer fixes (codex r6).
    const unmakeable = candidate !== null && (candidate.coming !== undefined || (candidate.blocked !== null && candidate.blocked !== (candidate.question?.text ?? null)));
    if (candidate !== null && loses && !covered && unmakeable) {
      return { code: 409, body: { code: 'card_not_available', error: candidate.blocked, view: viewOf(parent) } };
    }
    if (qe !== null || (loses && !covered)) {
      const base = keepReshape(await this.proposalOf(chatId, src.pid, factsOf(parent.proposal), ctx, records, true, parent.proposal), parent.proposal);
      const newCard = CATALOG_V2_CARDS.find((c) => c.id === merged.facts.card)!;
      const oldCard = CATALOG_V2_CARDS.find((c) => c.id === parent.proposal.shape!.card)!;
      const newNoun = nounOf(newCard, optionFor(newCard, merged.facts.option));
      const oldNoun = nounOf(oldCard, parent.proposal.shape!.option);
      // The choice carries exactly the edits crew kept (codex r1: never a refused seat skip), plus the press.
      const lossEdit: ProposalRevisionEdits = { ...(edits as ProposalRevisionEdits), confirmLoss: true };
      let question: NonNullable<ArtifactProposal['question']>;
      if (qe !== null && !loses) {
        question = qe.reason === null
          ? { kind: 'lost_check', text: 'Skip QE acceptance? Say why, and the job will be labelled with your reason.', choices: [{ label: 'Keep QE', edit: {} }], lost: ['qe-acceptance'], input: { kind: 'text', label: 'Your reason', edit: 'skipQe.reason' } }
          : { kind: 'lost_check', text: `Skip QE acceptance? The job will be labelled with your reason: “${qe.reason}”.`, choices: [{ label: 'Skip it', edit: { ...lossEdit, skipQe: { reason: qe.reason } } }, { label: 'Keep QE', edit: {} }], lost: ['qe-acceptance'] };
      } else {
        const lost = qe?.reason !== null && qe !== null ? [...new Set<CatalogGateId>(['qe-acceptance', ...merged.lost])] : merged.lost;
        const choice: ProposalRevisionEdits = qe !== null && qe.reason !== null ? { ...lossEdit, skipQe: { reason: qe.reason } } : lossEdit;
        const words = [...lost.map((g) => checksLabel([g])), ...merged.lostSeats.map((k) => SEAT_WORDS[k])];
        const lostText = words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
        question = {
          kind: 'lost_check',
          text: newNoun === oldNoun ? `That would no longer have ${lostText}. Change it anyway?` : `That's ${newNoun}, not ${oldNoun}: it would no longer have ${lostText}. Make it ${newNoun}?`,
          choices: [{ label: newNoun === oldNoun ? 'Change it' : `Make it ${newNoun}`, edit: choice }, { label: `Keep ${oldNoun}`, edit: {} }],
          lost,
          ...(merged.lostSeats.length > 0 ? { lostSeats: merged.lostSeats } : {}),
        };
      }
      const asked: ArtifactProposal = {
        ...base,
        // The baseline stays what the person saw (codex r3): a later unrelated revision compares against it.
        gate: [...new Set([...(parent.proposal.gate ?? []), ...(base.gate ?? [])])],
        seatRules: [...new Set([...(parent.proposal.seatRules ?? []), ...(base.seatRules ?? [])])],
        question,
        suggestions: [],
        blocked: question.text,
        ...(base.sentence !== undefined ? { sentence: { ...base.sentence, ask: question.text } } : {}),
      };
      if (!this.write(chatId, { at: this.now(), turnId: src.turnId ?? `person:${src.pid.slice(src.pid.lastIndexOf(':') + 1)}`, kind: 'proposal', proposal: asked }, instance)) return this.gone(chatId);
      const view = foldProposals(this.deps.records(chatId)).get(src.pid);
      return { code: 201, body: { view: view !== undefined ? viewOf(view) : { proposal: asked, state: 'open' } } };
    }
    // A seat's revision that changes nothing and says nothing re-proposes nothing ("skip parity": the seat says why).
    if (!fromPerson && merged.unchanged && merged.notes.length === 0 && !stale) return { code: 200, body: { view: viewOf(parent) } };
    if (candidate === null) throw candidateErr;
    const proposal = candidate;
    if (!this.write(chatId, { at: this.now(), turnId: src.turnId ?? `person:${src.pid.slice(src.pid.lastIndexOf(':') + 1)}`, kind: 'proposal', proposal }, instance)) return this.gone(chatId);
    const view = foldProposals(this.deps.records(chatId)).get(src.pid);
    return { code: 201, body: { view: view !== undefined ? viewOf(view) : { proposal, state: 'open' } } };
  }

  /**
   * The person's message `turnId` was written (`POST /chats/:id/messages`): the chat's open job proposal is held as
   * `revising` until that turn settles, under the lock Go takes, so a Go is either before the message (and launches
   * what was on screen) or after it (and waits).
   */
  holdForMessage(chatId: string, turnId: string): Promise<void> {
    const instance = this.deps.instanceOf(chatId);
    const key = `${chatId}\u0000${turnId}`;
    const done = this.lock.run(`chat\u0000${instance ?? chatId}`, async () => {
      if (!this.jobsOn() || this.deps.instanceOf(chatId) !== instance) return;
      for (const f of foldProposals(this.deps.records(chatId)).values()) {
        if (f.state !== 'open' || f.proposal.shape === undefined) continue;
        this.write(chatId, { at: this.now(), turnId, kind: 'proposal_revising', pid: f.proposal.pid }, instance);
      }
    });
    this.holding.set(key, done);
    void done.finally(() => {
      if (this.holding.get(key) === done) this.holding.delete(key);
    }).catch(() => undefined);
    return done;
  }

  /**
   * A seat's reply to a turn that holds a job proposal: its revision block (bound to that turn's message) is merged and
   * published, or refused; either way, and when the turn wrote none or failed, the hold ends.
   */
  private onTurnReply(frame: { chat: string; cliKey: string; turnId?: string; ok: boolean; blocks: readonly string[] }): void {
    const turnId = frame.turnId;
    if (turnId === undefined || !this.jobsOn()) return;
    // Answered, not gone: a read must not release this hold while its revision is still queued (codex r1).
    const key = `${frame.chat}\u0000${turnId}`;
    this.settling.set(key, (this.settling.get(key) ?? 0) + 1);
    const instance = this.deps.instanceOf(frame.chat);
    const job = this.order.run(`chat\u0000${frame.chat}`, async () => {
      // The hold is written with the person's message, which can land just after a fast reply.
      const heldBy = (): FoldedProposal | undefined => [...foldProposals(this.deps.records(frame.chat)).values()].find((f) => f.state === 'revising' && f.hold === turnId);
      for (let i = 0; i < 25 && heldBy() === undefined && !this.deps.records(frame.chat).some((r) => r.kind === 'user' && r.turnId === turnId); i += 1) {
        await new Promise((res) => setTimeout(res, 200));
      }
      // The hold is enqueued with the message; a fast reply waits for it to be written, not only for the message.
      await this.holding.get(`${frame.chat}\u0000${turnId}`);
      if (heldBy() === undefined) return;
      await this.lock.run(`chat\u0000${instance ?? frame.chat}`, async () => {
        if (this.deps.instanceOf(frame.chat) !== instance) return;
        const held = heldBy();
        if (held === undefined) return;
        let note: string | null = frame.ok ? null : "Your change wasn't applied: say it again.";
        if (frame.ok) {
          let rev: ProposalRevision | null = null;
          for (let i = frame.blocks.length - 1; i >= 0 && rev === null; i -= 1) rev = parseRevisionBlock(frame.blocks[i]!);
          if (rev !== null && rev.revises === held.proposal.pid) {
            const message = this.deps.records(frame.chat).find((r): r is Extract<ChatTranscriptRecord, { kind: 'user' }> => r.kind === 'user' && r.turnId === turnId && r.owner === true)?.text ?? null;
            try {
              const out = await this.reviseLocked(frame.chat, rev, { person: null, source: 'chat', pid: `${frame.chat}:${turnId}`, turnId, message }, instance);
              if (out.code >= 400) {
                // Said, not only logged (codex r6): the proposal is startable again as it was, and the person knows why.
                const why = (out.body as { error?: unknown }).error;
                note = `Your change wasn't applied${typeof why === 'string' && why !== '' ? `: ${why.slice(0, 160)}` : ''}.`;
                this.log(`[proposals] chat ${frame.chat}: turn ${turnId}'s revision was refused (${String((out.body as { code?: unknown }).code ?? out.code)})`);
              }
            } catch (err) {
              note = "Your change wasn't applied: say it again.";
              this.log(`[proposals] chat ${frame.chat}: turn ${turnId}'s revision failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          } else if (rev !== null) {
            if (this.planScheduled.has(key)) {
              // It names the chat's launched job: the held-plan path answers it, and releases this hold after it, saying
              // whether an offer came of it (codex r7).
              this.deferredRelease.add(key);
              // Still settling until the plan path releases it: a chat read must not reopen it first (codex r8).
              this.settling.set(key, (this.settling.get(key) ?? 0) + 1);
              return;
            }
            // Said, not silently dropped: the person's change did not land (codex r5).
            note = "Your change wasn't applied: say it again.";
            this.log(`[proposals] chat ${frame.chat}: turn ${turnId}'s revision names ${rev.revises}, not the proposal its message held — dropped`);
          }
        }
        // Released whatever happened (a published revision supersedes the parent; the record is then a no-op).
        this.write(frame.chat, { at: this.now(), turnId, kind: 'proposal_released', pid: held.proposal.pid, note }, instance);
      });
    })
      .catch((err: unknown) => this.log(`[proposals] chat ${frame.chat}: turn ${turnId}'s hold could not be settled: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.pending.delete(job);
        const n = (this.settling.get(key) ?? 1) - 1;
        if (n <= 0) this.settling.delete(key);
        else this.settling.set(key, n);
      });
    this.pending.add(job);
  }

  /**
   * A hold whose turn is no longer live (it failed or expired, or a restart forgot it) is released with a note, so the
   * proposal is startable again. Called by a Go and by a read of the chat. `true` when one was released.
   */
  async reopenStale(chatId: string, instance: string | null = this.deps.instanceOf(chatId)): Promise<boolean> {
    if (this.deps.turnLive === undefined) return false;
    const gone = (turnId: string): boolean => !this.deps.turnLive!(chatId, turnId) && !this.settling.has(`${chatId}\u0000${turnId}`);
    const stale = [...foldProposals(this.deps.records(chatId)).values()].filter((f) => f.state === 'revising' && f.hold !== undefined && gone(f.hold));
    if (stale.length === 0) return false;
    return this.lock.run(`chat\u0000${instance ?? chatId}`, async () => {
      let released = false;
      for (const f of foldProposals(this.deps.records(chatId)).values()) {
        if (f.state !== 'revising' || f.hold === undefined || !gone(f.hold)) continue;
        released = this.write(chatId, { at: this.now(), turnId: f.hold, kind: 'proposal_released', pid: f.proposal.pid, note: "Your change wasn't applied: say it again." }, instance) || released;
      }
      return released;
    });
  }

  /** A job's Go edits (option, depth, repository, seats, inputs) merged by the revision rules: one that loses a check
   *  is refused (that is the person's press on the lost-check question, not an edit at Go). */
  private async applyJobEdits(chatId: string, f: FoldedProposal, edits: ProposalEdits): Promise<ArtifactProposal> {
    const allowed: ReadonlyArray<keyof ProposalEdits> = ['option', 'depth', 'repoRef', 'seats', 'inputs'];
    for (const k of Object.keys(edits) as Array<keyof ProposalEdits>) if (!allowed.includes(k)) throw new EditRefusal(`${k} can't be changed on a job proposal`);
    const chat = this.jobChat(chatId);
    if (chat === null) throw new EditRefusal('this chat has ended');
    const rev: ProposalRevisionEdits = {
      ...(edits.option !== undefined ? { option: edits.option } : {}),
      ...(edits.depth !== undefined ? { depth: edits.depth } : {}),
      ...(edits.repoRef !== undefined ? { repoRef: edits.repoRef } : {}),
      ...(edits.inputs !== undefined ? { inputs: edits.inputs } : {}),
    };
    const ctx = await this.jobContext(chatId, f.proposal.pid, f.proposal.turnId, f.proposal.seat, chat, { revises: f.proposal.revises ?? null, lineage: f.proposal.lineage ?? f.proposal.pid, notes: [] });
    const merged = await this.mergeJobRevision(f.proposal, rev, ctx);
    if (edits.seats !== undefined) {
      const sr = f.proposal.shape === undefined ? null : resolveOption(f.proposal.shape.card, f.proposal.shape.option, ctx.served);
      if (sr?.workflow !== null && sr?.workflow !== undefined && SELF_SEATED.has(sr.workflow)) throw new EditRefusal(`${f.proposal.what.title} picks its own seat`);
      const can = new Set(ctx.roster.map((s) => s.key));
      if (edits.seats.length === 0 || edits.seats.some((k) => !can.has(k))) throw new EditRefusal('pick seats that can work now');
      merged.facts.seats = [...new Set(edits.seats)];
      merged.facts.lead = edits.seats[0]!;
    }
    if (merged.notes.length > 0) throw new EditRefusal(merged.notes[0]!);
    if (merged.lost.length > 0 || merged.lostSeats.length > 0) {
      throw new EditRefusal(`that would drop ${[...merged.lost.map((g) => checksLabel([g])), ...merged.lostSeats.map((k) => SEAT_WORDS[k])].join(', ')}; ask for it in the chat`);
    }
    if (edits.inputs?.['documents'] === undefined) {
      const gone = await this.firstGone(chatId, f.proposal);
      if (gone !== null) throw new JobRefusal('source_gone', gone, 409);
    }
    const out = keepReshape(await this.proposalOf(chatId, f.proposal.pid, merged.facts, ctx, this.deps.records(chatId), merged.facts.card === f.proposal.shape?.card, f.proposal), f.proposal);
    this.refuseStruckDocuments(out, edits.inputs?.['documents'] === undefined ? f.proposal : undefined);
    if (out.kind !== 'job') throw new EditRefusal('that option makes a document: pick it in the chat');
    const dropped = (f.proposal.gate ?? []).filter((g) => !(out.gate ?? []).includes(g));
    if (dropped.length > 0) throw new EditRefusal(`that would drop ${checksLabel(dropped)}; check the job again`);
    if (out.seats !== undefined && out.shape !== undefined) {
      const r = resolveOption(out.shape.card, out.shape.option, ctx.served);
      if (r !== null && !(r.workflow !== null && SELF_SEATED.has(r.workflow)) && out.seats.keys.length < 1 + (r.resolved.seats.distinctEvaluator ? 1 : 0) + (r.resolved.seats.distinctJudge ? 1 : 0)) {
        throw new EditRefusal('this job needs another seat to check the one that builds');
      }
    }
    return out;
  }

  /**
   * Go on a job (§4.6): the frozen catalog revision and resolution are compared with the current catalog first; a
   * mismatch records the refreshed proposal (superseding this one) and answers 409 `catalog_changed`.
   */
  private async jobStale(chatId: string, f0: FoldedProposal, instance: string | null): Promise<DecideResult | null> {
    // Re-read under the chat's lock: a revision that won the lock first made this one stale (codex r1).
    const f = foldProposals(this.deps.records(chatId)).get(f0.proposal.pid);
    if (f === undefined || f.state !== f0.state) {
      return { code: 409, body: { code: 'proposal_stale', error: 'this proposal changed while it was being started; check it again', ...(f !== undefined ? { view: viewOf(f) } : {}) } };
    }
    const p = f.state === 'accepting' && f.accepting !== undefined ? f.accepting.resolution : f.proposal;
    if (p.shape === undefined) return null;
    // A chat that has ended is re-checked from the proposal's own facts (codex r2): the check never depends on it being open.
    const chat: JobChat = this.jobChat(chatId) ?? {
      projectId: p.filedIn.projectId,
      repos: (p.repoRefs ?? []).map((id, i) => ({ id, name: p.repos[i] ?? id })),
      lead: p.seats?.lead ?? null,
      seats: p.seats?.keys ?? [],
    };
    // One refresh suffix, not one per refresh: the id stays bounded however often the catalog changes (codex r2).
    const pid = `${p.pid.replace(/(?::c:[0-9a-z]+)+$/u, '')}:c:${this.now().toString(36)}`;
    let ctx: JobContext;
    try {
      ctx = await this.jobContext(chatId, pid, p.turnId, p.seat, chat, { revises: p.pid, lineage: p.lineage ?? p.pid, notes: ['The catalog changed since this was proposed: check it again before starting.'] });
      await this.loadJobSources(factsOf(p), ctx);
    } catch (err) {
      const refused = this.refusalOf(err);
      if (refused !== null) return refused;
      throw err;
    }
    const card = CATALOG_V2_CARDS.find((c) => c.id === p.shape!.card);
    const r = card === undefined ? null : resolveOption(card.id, optionFor(card, p.shape.option), ctx.served);
    if (r !== null && ctx.served.rev === p.catalogRev && r.resolved.resolution === p.resolution) return null;
    let fresh: ArtifactProposal;
    try {
      fresh = keepReshape(await this.proposalOf(chatId, pid, factsOf(p), ctx, this.deps.records(chatId), true, p), p);
    } catch (err) {
      const refused = this.refusalOf(err);
      if (refused !== null) return { code: 409, body: { code: 'catalog_changed', error: `the catalog changed since this was proposed: ${String(refused.body['error'])}`, view: viewOf(f) } };
      throw err;
    }
    // A refresh that would carry fewer checks (or seat protections) than the proposal on screen is not startable until
    // the person presses the question naming what changed (codex r1).
    const lost = (p.gate ?? []).filter((g) => !(fresh.gate ?? []).includes(g));
    const lostSeats = (p.seatRules ?? []).filter((k) => !(fresh.seatRules ?? []).includes(k));
    if ((lost.length > 0 || lostSeats.length > 0) && fresh.kind === 'job') {
      const words = [...lost.map((g) => checksLabel([g])), ...lostSeats.map((k) => SEAT_WORDS[k])].join(', ');
      const text = `The catalog changed: this job would no longer have ${words}. Start it like that?`;
      // The baseline stays the proposal the person saw, so an unrelated revision cannot clear the question (codex r2).
      fresh = { ...fresh, gate: [...new Set([...(fresh.gate ?? []), ...lost])], seatRules: [...new Set([...(fresh.seatRules ?? []), ...lostSeats])], question: { kind: 'lost_check', text, choices: [{ label: 'Accept the change', edit: { confirmLoss: true } }], lost, ...(lostSeats.length > 0 ? { lostSeats } : {}) }, suggestions: [], blocked: text, ...(fresh.sentence !== undefined ? { sentence: { ...fresh.sentence, ask: text } } : {}) };
    }
    if (!this.write(chatId, { at: this.now(), turnId: f.turnId, kind: 'proposal', proposal: fresh }, instance)) return this.gone(chatId);
    const after = foldProposals(this.deps.records(chatId)).get(pid);
    return { code: 409, body: { code: 'catalog_changed', error: 'the catalog changed since this was proposed; check the job again and press Start', ...(after !== undefined ? { view: viewOf(after) } : {}) } };
  }

  /**
   * `POST /runs/:id/reshape` (§2.5) after the route's checks (a person, the chat is theirs, the run is held at its first
   * work-plan approval): under the chat's lock, so another proposal's Start waits for it — the crew-made reshape
   * proposal `<chatId>:reshape:<run>:<requestId>` is written (or found: a repeated request is idempotent), validated
   * against the held job's checks, then Go's one reshape transition (preflight, the held plan answered Reject through
   * `deps.reshapeReject`, `heldRejected` recorded, the launch). A failed launch after the Reject leaves it accepting:
   * the same request, or Go on it, tries again.
   */
  reshape(
    chatId: string,
    x: {
      pid: string;
      oldRunId: string;
      parentPid: string | null;
      /** The facts when the held job's proposal is not in this chat's records; else the edits below are merged into it. */
      facts: JobFacts;
      edits: Pick<ProposalRevisionEdits, 'card' | 'option' | 'depth' | 'inputs'>;
      reducedAssurance: boolean;
      relaunch: NonNullable<ArtifactProposal['relaunch']>;
      request: { id: string; digest: string };
      /** The losses the person confirmed (the ids a previous `reshape_loses_check` named). */
      confirmLoss: readonly string[];
      /** The plan version the person was offered this on: the held plan's Reject is bound to it. */
      heldPlan?: { ord: number; planRev: number };
    },
    actor: Actor,
    instance: string | null,
  ): Promise<DecideResult> {
    return this.lock.run(`pid\u0000${x.pid}`, () => this.lock.run(`chat\u0000${instance ?? chatId}`, async () => {
      if (this.deps.instanceOf(chatId) !== instance) return this.gone(chatId);
      if (!this.jobsOn()) return { code: 409, body: { code: 'operation_unavailable', error: 'this daemon does not start jobs from a chat' } };
      let folded = foldProposals(this.deps.records(chatId)).get(x.pid);
      if (folded !== undefined && folded.proposal.request?.digest !== x.request.digest) {
        return { code: 409, body: { code: 'request_reused', error: 'this requestId already started the run again as something else', view: viewOf(folded) } };
      }
      if (folded?.state === 'decided') {
        return folded.decision === 'go' ? { code: 200, body: { view: viewOf(folded) } } : { code: 409, body: { code: 'proposal_decided', error: 'this reshape was answered Not now', view: viewOf(folded) } };
      }
      if (folded === undefined) {
        const chat = this.jobChat(chatId);
        if (chat === null) return { code: 409, body: { code: 'chat_gone', error: `chat ${chatId} has ended; start a new one` } };
        const parent = x.parentPid === null ? undefined : foldProposals(this.deps.records(chatId)).get(x.parentPid);
        let proposal: ArtifactProposal;
        try {
          const ctx = await this.jobContext(chatId, x.pid, null, 'person', chat, {
            revises: x.parentPid,
            lineage: parent?.proposal.lineage ?? x.parentPid ?? x.pid,
            notes: x.reducedAssurance ? ['Reduced assurance, as the held run had it.'] : [],
            request: x.request,
          });
          // The held job's proposal, merged by the revision rules (its inputs validated against the new card, what
          // the new card does not take dropped with a note; codex r2). A QE skip is never carried.
          const heldP = parent?.accepting?.resolution ?? parent?.proposal;
          let facts = x.facts;
          if (heldP?.shape !== undefined) {
            const merged = await this.mergeJobRevision(heldP, x.edits as ProposalRevisionEdits, ctx);
            // Nothing is answered for a shape, or an input, that is not the one asked for (codex r3, r4).
            const wantCard = CATALOG_V2_CARDS.find((c) => c.id === (x.edits.card ?? merged.facts.card));
            const norm = (o: string | null | undefined): string | null => (wantCard === undefined ? null : o === null || o === undefined ? (wantCard.variant?.default ?? null) : o);
            const optionOk = wantCard !== undefined && (x.edits.option === undefined || norm(merged.facts.option) === norm(x.edits.option));
            const depthOk = x.edits.depth === undefined || x.edits.depth === null || merged.facts.depth === x.edits.depth;
            const inputsOk = merged.refusedInputs.length === 0 && Object.entries(x.edits.inputs ?? {}).every(([k, v]) => (k === 'intent' ? merged.facts.words === (v.kind === 'text' ? v.value.slice(0, 8000) : '') : JSON.stringify(merged.facts.inputs[k]) === JSON.stringify(v)
              // Words typed for an address are that address (chat-jobs applyEdits step 5, studio#1134).
              || (v.kind === 'text' && merged.facts.inputs[k]?.kind === 'url' && JSON.stringify(merged.facts.inputs[k]) === JSON.stringify({ kind: 'url', value: v.value.trim() }))));
            if (wantCard === undefined || merged.facts.card !== wantCard.id || !optionOk || !depthOk || !inputsOk) {
              return { code: 400, body: { code: 'edits_invalid', error: merged.notes[0] ?? `there is no ${String(x.edits.card)}${x.edits.option !== undefined && x.edits.option !== null ? ` · ${String(x.edits.option)}` : ''} to start it again as`, notes: merged.notes } };
            }
            // A reshape is the person's shape: no detection guess describing the held job rides on it (codex r3).
            const { guess: _old, ...personFacts } = merged.facts;
            void _old;
            facts = { ...personFacts, skipQe: null, by: 'person', source: 'reshape' };
            ctx.notes.push(...merged.notes);
          }
          if (heldP !== undefined && x.edits.inputs?.['documents'] === undefined) {
            const gone = await this.firstGone(chatId, heldP);
            if (gone !== null) throw new JobRefusal('source_gone', gone, 409);
          }
          proposal = await this.proposalOf(chatId, x.pid, facts, ctx, this.deps.records(chatId), false, heldP ?? null);
          if (x.edits.inputs?.['documents'] !== undefined) this.refuseStruckDocuments(proposal);
          else if (heldP !== undefined) this.refuseStruckDocuments(proposal, heldP);
        } catch (err) {
          const refused = this.refusalOf(err);
          if (refused !== null) return refused;
          throw err;
        }
        if (proposal.kind !== 'job') return { code: 400, body: { code: 'shape_mismatch', error: 'a held run starts again as another job, not a document' } };
        // The held job's checks and seat protections are the parent's; a replacement with fewer is started only on the
        // person's press naming them (§2.5: the reshape question names the checks given up; codex r1).
        const held = parent?.accepting?.resolution ?? parent?.proposal;
        if (held !== undefined) {
          const lost = (held.gate ?? []).filter((g) => !(proposal.gate ?? []).includes(g));
          const heldCard = held.shape === undefined ? null : CATALOG_V2_CARDS.find((c) => c.id === held.shape!.card) ?? null;
          const before = held.seatRules ?? (heldCard === null ? [] : seatProtections(resolveOption(heldCard.id, optionFor(heldCard, held.shape!.option), (await this.deps.served!(chat.projectId)))));
          const after = proposal.seatRules ?? [];
          const lostSeats = before.filter((k) => !after.includes(k));
          // Confirmed only for exactly what the person was shown (a loss since asks again; codex r4).
          if ([...lost, ...lostSeats].some((k) => !x.confirmLoss.includes(k))) {
            const words = [...lost.map((g) => checksLabel([g])), ...lostSeats.map((k) => SEAT_WORDS[k])];
            return { code: 409, body: { code: 'reshape_loses_check', error: `started again like that, it would no longer have ${words.join(', ')}: confirm to give ${words.length === 1 ? 'it' : 'them'} up`, lost, lostSeats } };
          }
        }
        proposal = { ...proposal, reshapes: x.oldRunId, relaunch: x.relaunch, ...(x.reducedAssurance ? { reducedAssurance: true as const } : {}), ...(x.heldPlan !== undefined ? { heldPlan: x.heldPlan } : {}) };
        if (!this.write(chatId, { at: this.now(), turnId: `reshape:${x.oldRunId}`, kind: 'proposal', proposal }, instance)) return this.gone(chatId);
        folded = foldProposals(this.deps.records(chatId)).get(x.pid)!;
      }
      const p = folded.state === 'accepting' && folded.accepting !== undefined ? folded.accepting.resolution : folded.proposal;
      if (folded.state === 'accepting' && folded.accepting !== undefined) {
        // A retry after the replacement launched (a lost response, a crash before the decision): adopt it (codex r1).
        const found = await this.deps.registry.find('job', folded.accepting.identity);
        if (found !== null) {
          const result: ProposalResult = { runId: folded.accepting.identity.runId, artifactRef: null, adopted: true, stub: found.stub };
          if (!this.decided(chatId, folded.turnId, x.pid, actor, 'go', result, folded.accepting.resolution, folded.accepting.edits, instance)) return this.gone(chatId);
          return { code: 200, body: { view: viewOf(foldProposals(this.deps.records(chatId)).get(x.pid)!) } };
        }
      }
      // Only the open (or interrupted) newest proposal of its lineage goes on: checked before any Reject (codex r3).
      if (folded.state === 'superseded' || folded.state === 'revising') {
        return { code: 409, body: { code: folded.state === 'revising' ? 'proposal_revising' : 'proposal_superseded', error: 'this reshape changed since; check it again', view: viewOf(folded) } };
      }
      const newest = [...foldProposals(this.deps.records(chatId)).values()].filter((f) => f.proposal.lineage === p.lineage).pop();
      if (newest !== undefined && newest.proposal.pid !== x.pid) {
        return { code: 409, body: { code: 'proposal_superseded', error: 'a newer version of this job replaced this reshape', view: viewOf(newest) } };
      }
      // A retry is checked against the catalog like any Go, interrupted ones included (codex r2, r3).
      const stale = await this.jobStale(chatId, folded, instance);
      if (stale !== null) return stale;
      if (folded.state !== 'accepting') {
        if (p.blocked !== null) return { code: 409, body: { code: 'proposal_blocked', error: p.blocked, view: viewOf(folded) } };
      }
      const current = folded.state === 'accepting' && folded.accepting !== undefined ? folded.accepting.resolution : folded.proposal;
      const identity = folded.accepting?.identity ?? this.identityOf(current);
      return this.goLocked(chatId, folded, current, null, identity, actor, instance);
    }));
  }

  /** A proposal of this chat, folded, or `null`. */
  viewOfPid(chatId: string, pid: string): ChatProposalView | null {
    const f = foldProposals(this.deps.records(chatId)).get(pid);
    return f === undefined ? null : viewOf(f);
  }

  /** The proposal as it was accepted (its effective resolution), else as it stands; `null` when the chat has none. */
  proposalOfPid(chatId: string, pid: string): ArtifactProposal | null {
    const f = foldProposals(this.deps.records(chatId)).get(pid);
    return f === undefined ? null : (f.accepting?.resolution ?? f.proposal);
  }

  // ── A3: what the create launcher and the daemon need from the proposals ────────────────────────────────────────────

  /**
   * The accepted proposal a create's `chat_id` + `proposal_id` names, for this actor (§5.2): accepting (or decided go),
   * accepted by them, a create. `null` otherwise — and then the create is refused.
   */
  grantFor(chatId: string, pid: string, actorId: string): { doc: string; projectId: string; repos: Array<{ id: string; name: string }> } | null {
    const f = foldProposals(this.deps.records(chatId)).get(pid);
    const acc = f?.accepting;
    if (f === undefined || acc === undefined || acc.actor !== actorId || acc.resolution.kind !== 'create') return null;
    if (!(f.state === 'accepting' || (f.state === 'decided' && f.decision === 'go'))) return null;
    const ref = acc.identity.artifactRef === null ? null : parseArtifactRef(acc.identity.artifactRef);
    if (ref === null) return null;
    const ids = acc.resolution.repoRefs ?? [];
    return { doc: ref.doc, projectId: ref.projectId, repos: ids.map((id, i) => ({ id, name: acc.resolution.repos[i] ?? id })) };
  }

  /** The accepted resolution and identity of a proposal (the launcher's bus trigger rebuilds its dispatch from it). */
  acceptedOf(chatId: string, pid: string): { actor: string; resolution: ArtifactProposal; identity: ProposalIdentity; turnId: string; state: ChatProposalView['state'] } | null {
    const f = foldProposals(this.deps.records(chatId)).get(pid);
    if (f?.accepting === undefined) return null;
    return { actor: f.accepting.actor, resolution: f.accepting.resolution, identity: f.accepting.identity, turnId: f.turnId, state: f.state };
  }

  /**
   * §6.2: a proposal-bound attempt ended without landing. Crew appends `<chatId>:retry:<runId>` — the same artifact, the
   * failed attempt's effective resolution (edits, helpers, sources; the conversation cutoff stays the binding's), a new
   * run id derived from its own pid — to the live chat or its kept history. Once per failed run.
   */
  async appendRetry(chatId: string, failedPid: string, runId: string, artifactRef: string, reason: string, bound?: string | null): Promise<string | null> {
    const instance = bound ?? this.deps.instanceOf(chatId);
    return this.lock.run(`chat\u0000${instance ?? chatId}`, async () => {
      // Checked under the lock: only on the chat instance the document was made in, never on another chat that reused
      // the id meanwhile (the caller resolves the instance's current id again and retries).
      if (bound !== undefined && bound !== null && this.deps.instanceOf(chatId) !== bound) {
        throw new Error(`chat ${chatId} is no longer the chat run ${runId} was made from`);
      }
      const records = this.deps.records(chatId);
      const folded = foldProposals(records);
      const failed = folded.get(failedPid);
      const base = failed?.accepting?.resolution ?? failed?.proposal;
      if (failed === undefined || base === undefined) {
        this.log(`[proposals] chat ${chatId}: run ${runId} failed but proposal ${failedPid} is not in its records — no retry card`);
        return null;
      }
      // Named by the chat's own id (an ended chat's archive alias still holds the same proposals).
      const pid = `${base.chatId}:retry:${runId}`;
      if (folded.has(pid)) return pid;
      // A5 (codex r1): a refine's retry is drawn on the document as it is now (a conflict moved its head), with the
      // protected edits of that head, Keep preselected for every one.
      const fresh = base.kind === 'refine' && base.target !== undefined ? await this.refreshTarget(base) : base;
      const retry: ArtifactProposal = {
        ...fresh,
        pid,
        turnId: null,
        sourceRunId: runId,
        artifactRef,
        reason: base.kind === 'refine'
          ? `The last change was not applied: ${reason}. Try again revises the latest version, and keeps your edits.`
          : `The last attempt ended without a draft: ${reason}. Try again fills the same document.`,
        // A refine whose edits cannot be read on the new head stays blocked with why (codex A5 r2).
        blocked: fresh !== base ? fresh.blocked : null,
      };
      return this.write(chatId, { at: this.now(), turnId: failed.turnId, kind: 'proposal', proposal: retry }, instance) ? pid : null;
    });
  }

  /**
   * The artifact job a chat's proposal started that is still live (busy until its outcome is recorded), as the card
   * names it, or `null`. A work launch filed under the chat (`POST /runs {chatId}`) is refused while one is: one live
   * job per chat, work and artifact runs together (DES §4.3).
   */
  async liveJobOf(chatId: string): Promise<string | null> {
    for (const f of foldProposals(this.deps.records(chatId)).values()) {
      const runId = f.state === 'decided' && f.decision === 'go' ? f.result?.runId ?? null : f.state === 'accepting' ? f.accepting?.identity.runId ?? null : null;
      if (runId !== null && (await this.deps.registry.live(f.proposal.kind, runId))) return f.proposal.what.label;
    }
    return null;
  }

  /** At daemon start (§6.2): an `accepting` proposal whose run exists is decided (adopted). `true` when it recorded. */
  async settleAccepting(chatId: string, pid: string): Promise<boolean> {
    const instance = this.deps.instanceOf(chatId);
    return this.lock.run(`pid\u0000${pid}`, async () => {
      const f = foldProposals(this.deps.records(chatId)).get(pid);
      const acc = f?.accepting;
      if (f === undefined || acc === undefined || f.state !== 'accepting') return false;
      const found = await this.deps.registry.find(f.proposal.kind, acc.identity);
      if (found === null) return false;
      const result: ProposalResult = { runId: acc.identity.runId, artifactRef: acc.identity.artifactRef, adopted: true, stub: found.stub };
      const actor: Actor = { id: acc.actor, kind: 'human', trust: 'operator' };
      return this.decided(chatId, f.turnId, pid, actor, 'go', result, acc.resolution, acc.edits, instance);
    });
  }
}
