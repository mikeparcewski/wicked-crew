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
 * Nothing in this slice starts work: each operation's launcher is registered by its own slice (A3 create, A5 refine,
 * A7 theme, A8 demo). Production advertises `proposals` with every operation off, so seats are told about nothing and
 * the resolver refuses any block. The TEST configuration (`WICKED_CHAT_ARTIFACTS_STUB=1`, DES §13 A2) turns every
 * operation's resolution on and registers a {@link RecordingStubDispatcher}, which records a dispatch and starts
 * nothing.
 *
 * Records go to the chat's live transcript, or to its kept history copy once the chat has ended, so an open proposal
 * stays answerable after a restart (§4.3).
 */

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

import type {
  Actor,
  ArtifactProposal,
  ArtifactProposalKind,
  ChatArtifactsCapabilities,
  ChatContextBinding,
  ChatProposalFrame,
  ChatProposalView,
  ChatTranscriptRecord,
  CoreEvent,
  ProposalAccepting,
  ProposalEdits,
  ProposalHelpers,
  ProposalIdentity,
  ProposalResult,
  ProposalSource,
  ProposalTime,
  SessionView,
} from '../core/types.js';
import type { CatalogSeed } from '../workflow-catalog/catalog-data.js';
import { artifactExists, artifactHead, chatMount, parseArtifactRef, UNFILED_MOUNT } from './chat-context.js';
import { tornTailPrefix } from './chat-transcripts.js';
import type { MakeDigest } from './chat-scope.js';

// ── the block ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Sources a block may name. */
export const PROPOSAL_SOURCES_MAX = 12;

const TOKEN = z.string().trim().min(1).max(300);
const SOURCES = z.array(TOKEN).max(PROPOSAL_SOURCES_MAX).default([]);
const REPOS = z.array(z.string().trim().min(1).max(200)).max(8).default([]);
const REASON = z.string().max(600).optional();

/** studio's appearance scalars (`theming/appearance.ts`), as a partial patch: only the keys that change. */
export const ThemePatchSchema = z
  .object({
    theme: z.enum(['wicked-dark', 'wicked-light']).optional(),
    accent_h: z.number().min(0).max(360).optional(),
    accent_s: z.number().min(0).max(100).optional(),
    accent_l: z.number().min(0).max(100).optional(),
    ambient: z.boolean().optional(),
    ambient_still: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'a theme patch changes at least one key');

const EntryBlock = z.object({
  entry: z.string().trim().min(1).max(80),
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
  | ({ op: 'theme' } & z.infer<typeof ThemeBlock>);

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
  const ops = (['entry', 'refine', 'theme'] as const).filter((k) => o[k] !== undefined && o[k] !== null);
  if (ops.length !== 1) return null;
  if (ops[0] === 'entry') {
    const r = EntryBlock.safeParse(o);
    return r.success ? { op: 'entry', ...r.data } : null;
  }
  if (ops[0] === 'refine') {
    const r = RefineBlock.safeParse(o);
    return r.success ? { op: 'refine', ...r.data } : null;
  }
  const r = ThemeBlock.safeParse(o);
  return r.success ? { op: 'theme', ...r.data } : null;
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

type ProposalRecord = Extract<ChatTranscriptRecord, { kind: 'proposal' | 'proposal_accepting' | 'proposal_decided' }>;

/** A folded proposal plus what the accept path needs that the wire view does not carry. */
export interface FoldedProposal extends ChatProposalView {
  turnId: string;
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
      for (const [other, v] of out) if (other !== pid && v.state === 'open') v.state = 'superseded';
      out.set(pid, { proposal: r.proposal, state: 'open', turnId: r.turnId });
    } else if (r.kind === 'proposal_accepting') {
      const v = out.get(r.pid);
      if (v === undefined || v.state === 'decided') continue;
      v.state = 'accepting';
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
}

/** One operation's launcher (A3 create, A5 refine, A7 theme, A8 demo register theirs). */
export interface ProposalDispatcher {
  /** Whether the run this identity names already exists (it is then adopted, never started again). */
  find(identity: ProposalIdentity): Promise<boolean>;
  /** Start it, with `identity.runId` as the launch's `sessionId`. Called only when {@link find} said no, under the
   *  run id's lock. */
  launch(dispatch: ProposalDispatch): Promise<void>;
  /** Whether a run it started is still live (the one-live-job-per-chat rule). */
  live?(runId: string): Promise<boolean>;
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

  /** Whether a run this daemon started for the artifact is still live. */
  async liveForArtifact(artifactRef: string): Promise<boolean> {
    for (const r of this.byArtifact.get(artifactRef) ?? []) if (await this.live(r.kind, r.runId)) return true;
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

// ── resolution ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The workflow each operation's run is. */
export const PROPOSAL_WORKFLOWS: Readonly<Record<Exclude<ArtifactProposalKind, 'theme'>, string>> = {
  create: 'interactive-draft',
  refine: 'interactive-chat',
  demo: 'demo',
};

const STOPS: Readonly<Record<Exclude<ArtifactProposalKind, 'theme'>, string>> = {
  create: 'Stops for you if the check fails. The plan or an escalation may also ask.',
  refine: 'Stops for you if the check fails. The plan or an escalation may also ask.',
  demo: 'Stops for you after the script and after the review.',
};

const STYLE_LABEL: Readonly<Record<string, string>> = { ppt: 'Slides', web: 'Web page', doc: 'Document', brochure: 'Brochure' };
const NOUN: Readonly<Record<Exclude<ArtifactProposalKind, 'theme'>, [string, string]>> = {
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

export interface ChatProposalDeps {
  /** The operations crew advertises (and `proposals`). */
  flags(): ChatArtifactsCapabilities;
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
  /** Seats that can work now, in roster order (enabled, work-eligible, not signed out, not opt-in). */
  rosterEligible(): ReadonlyArray<{ key: string; name: string }>;
  /** Every run, decorated as `GET /runs` serves it (`project_id`, `document_id`, `run_identity`, times). */
  runs(): Promise<SessionView[]>;
  /** The chat a run was filed under, and whether it is a chat's own ask path. */
  chatOfRun(runId: string): string | undefined;
  isAskPath(runId: string): boolean;
  /** The docs root of a project (`default` = Unfiled); `null` = no such project. */
  docsRoot(projectId: string): Promise<string | null>;
  projectName(projectId: string): Promise<string | null>;
  /** This chat's attachments. */
  attachments(chatId: string): ReadonlyArray<{ id: string; name: string }>;
  /** Steps of a workflow as a launch in this project resolves it, when known. */
  workflowSteps(name: string, projectId: string | null): Promise<number | null>;
  /** A completed run's cost when every agent step reported one, else `null`. */
  runCostUsd(view: SessionView): Promise<number | null>;
  registry: LaunchOnceRegistry;
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

/** Every http(s) address in the person's words, whole (trailing sentence punctuation dropped). */
function personUrls(words: string): Set<string> {
  const out = new Set<string>();
  for (const m of words.matchAll(/https?:\/\/[^\s"'<>`]+/gu)) out.add(m[0].replace(/[.,;:!?)\]}]+$/u, ''));
  return out;
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

export class ChatProposals {
  private readonly lock = new KeyedLock();
  /** Per chat: resolutions publish in the order their replies were folded (a slow one never lands after a newer one). */
  private readonly order = new KeyedLock();
  private readonly pending = new Set<Promise<void>>();
  private readonly costs = new Map<string, number | null>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: ChatProposalDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  /** What a seat may be told it can make now (`chat-scope.ts`'s per-message digest). */
  digest(): MakeDigest {
    const f = this.deps.flags();
    const on = f.proposals;
    return {
      create: on && f.create,
      refine: on && f.refine,
      theme: on && f.theme,
      demo: on && f.demo,
      entries: on
        ? this.deps.catalog.flatMap((c): Array<MakeDigest['entries'][number]> => {
            if (c.status === 'coming_soon') return [];
            if (c.launch.kind === 'document' && f.create) return [{ id: c.id, title: c.title ?? c.id, kind: 'document' as const, outcome: c.outcome }];
            if (c.launch.kind === 'demo' && f.demo) return [{ id: c.id, title: c.title ?? c.id, kind: 'demo' as const, outcome: c.outcome }];
            return [];
          })
        : [],
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
    if (frame.blocks.length === 0 || frame.turnId === undefined || !frame.ok) return;
    if (!this.deps.flags().proposals) return;
    const block = lastValidBlock(frame.blocks);
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
        return rs.some((r) => r.kind === 'proposal' && (r.proposal.pid === pid || (r.proposal.turnId !== null && order.indexOf(r.proposal.turnId) > mine)));
      };
      if (has()) return;
      const proposal = await this.resolve({ chatId: frame.chat, turnId, seat: frame.cliKey, block, records: this.deps.records(frame.chat) });
      if (proposal === null) return;
      // Published under the chat's lock, so it never lands between an accept's checks and its record.
      await this.lock.run(`chat\u0000${frame.chat}`, async () => {
        if (!has()) this.write(frame.chat, { at: this.now(), turnId, kind: 'proposal', proposal }, instance);
      });
    })
      .catch((err: unknown) => this.log(`[proposals] chat ${frame.chat}: turn ${turnId}'s proposal could not be resolved: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
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
          }
        }
      }
      const sources = await this.resolveSources(block.sources, { chatId, turnId, records, binding, turnHas, chat, words, personNamed: false });
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
    for (const want of block.repos) {
      const hit = chat.repos.find((r) => r.name === want || r.id === want);
      if (hit === undefined) blocked.push(`${want} isn't in this chat's scope`);
      else if (!repos.includes(hit.name)) repos.push(hit.name);
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
  private async timeOf(kind: Exclude<ArtifactProposalKind, 'theme'>, seed: CatalogSeed | null, projectId: string | null): Promise<ProposalTime> {
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
    for (const raw of tokens.slice(0, PROPOSAL_SOURCES_MAX)) {
      const token = raw.trim();
      if (seen.has(token)) continue;
      seen.add(token);
      if (token === 'chat') {
        push({ token, label: 'this conversation', status: 'ok' });
        continue;
      }
      if (token === 'page') {
        if (ctx.turnHas && ctx.binding?.page === true) push({ token, label: 'the page you were on', status: 'ok' });
        else strike(token, 'the page you were on', 'no page was shared with this message');
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
        if (a === undefined) strike(token, `attachment ${id.slice(0, 12)}`, 'not a file attached to this chat');
        else push({ token, label: a.name, status: 'ok' });
        continue;
      }
      if (kind === 'run') {
        const want = id.toLowerCase();
        const short = want.slice(0, 8);
        if (!/^[a-z0-9][a-z0-9._-]{3,127}$/.test(want)) {
          strike(token, `run ${short}`, 'not a run id');
          continue;
        }
        // Authorized before anything of it is read: a seat's token is matched against the runs the person named in
        // this chat (full ids), never against every run on the daemon — an unnamed id learns nothing of what exists.
        // A source the person adds is theirs to name, and is looked up.
        let candidates: string[];
        if (ctx.personNamed) {
          candidates = (await allRuns()).map((v) => v.session.id).filter((id) => id === want || id.startsWith(want));
        } else {
          candidates = (ctx.binding?.named.runs ?? []).filter((id) => id === want || id.startsWith(want));
          if (candidates.length === 0) {
            strike(`run:${want}`, `run ${short}`, 'not named in this chat');
            continue;
          }
        }
        const hit = candidates.includes(want) ? want : candidates.length === 1 ? candidates[0]! : null;
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

  // ── the answer ───────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `POST /chats/:id/proposals/:pid` after the route's capability, person and owner checks. `instance` is the chat
   * instance those checks passed against: nothing is read for, or written to, a chat that reused the id since. One
   * lock per proposal: a second tab or a double click waits for the first and gets its result.
   */
  decide(chatId: string, pid: string, body: { decision: 'go' | 'not_now'; edits?: ProposalEdits | undefined }, actor: Actor, instance: string | null): Promise<DecideResult> {
    // Keyed by the pid alone (it is unique: `<chat>:<turn uuid>`), so the same proposal answered through an ended chat's
    // archived alias still waits for an in-flight answer through its first name.
    return this.lock.run(`pid\u0000${pid}`, () => this.decideLocked(chatId, pid, body, actor, instance));
  }

  private gone(chatId: string): DecideResult {
    return { code: 409, body: { code: 'chat_gone', error: `chat ${chatId} ended and its id was reused; this proposal can no longer be answered here` } };
  }

  private async decideLocked(chatId: string, pid: string, body: { decision: 'go' | 'not_now'; edits?: ProposalEdits | undefined }, actor: Actor, instance: string | null): Promise<DecideResult> {
    if (this.deps.instanceOf(chatId) !== instance) return this.gone(chatId);
    const records = this.deps.records(chatId);
    const folded = foldProposals(records).get(pid);
    if (folded === undefined) return { code: 404, body: { error: `no proposal ${pid} in chat ${chatId}` } };
    const kind = folded.proposal.kind;
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
          if (err instanceof EditRefusal) return { code: 400, body: { code: 'edits_invalid', error: err.message } };
          throw err;
        }
      }
      return this.go(chatId, folded, again, again === acc.resolution ? acc.edits : { ...(acc.edits ?? {}), ...body.edits }, acc.identity, actor, instance);
    }
    if (folded.state === 'superseded') {
      return { code: 409, body: { code: 'proposal_superseded', error: 'a newer proposal in this chat replaced this one', view: viewOf(folded) } };
    }
    // 2. Not now: nothing else is checked.
    if (body.decision === 'not_now') {
      if (!this.decided(chatId, folded.turnId, pid, actor, 'not_now', null, folded.proposal, null, instance)) return this.gone(chatId);
      return ok(reread());
    }
    // 3. A fresh Go: the edits first (the one block a person can lift is a missing second helper), then the block.
    let effective: ArtifactProposal;
    try {
      effective = await this.applyEdits(chatId, folded, body.edits);
    } catch (err) {
      if (err instanceof EditRefusal) return { code: 400, body: { code: 'edits_invalid', error: err.message } };
      throw err;
    }
    if (effective.blocked !== null) {
      return { code: 409, body: { code: 'proposal_blocked', error: effective.blocked, view: viewOf(folded) } };
    }
    return this.go(chatId, folded, effective, body.edits ?? null, this.identityOf(effective), actor, instance);
  }

  /**
   * The state checks, then `accepting`, the launch, and `decided` — under the chat's lock and the document's, so two
   * proposals of one chat (or two chats changing one document) can never both pass the busy check.
   */
  private go(chatId: string, folded: FoldedProposal, resolution: ArtifactProposal, edits: ProposalEdits | null, identity: ProposalIdentity, actor: Actor, instance: string | null): Promise<DecideResult> {
    const docKey = resolution.kind === 'refine' && identity.artifactRef !== null ? identity.artifactRef : null;
    return this.lock.run(`chat\u0000${chatId}`, () =>
      docKey === null
        ? this.goLocked(chatId, folded, resolution, edits, identity, actor, instance)
        : this.lock.run(`doc\u0000${docKey}`, () => this.goLocked(chatId, folded, resolution, edits, identity, actor, instance)));
  }

  private async goLocked(chatId: string, folded: FoldedProposal, resolution: ArtifactProposal, edits: ProposalEdits | null, identity: ProposalIdentity, actor: Actor, instance: string | null): Promise<DecideResult> {
    const kind = resolution.kind;
    const pid = resolution.pid;
    // Under the chat's lock: a newer proposal published while this one was being checked supersedes it.
    if (this.deps.instanceOf(chatId) !== instance) return this.gone(chatId);
    const now = foldProposals(this.deps.records(chatId)).get(pid);
    if (now === undefined || now.state === 'superseded' || now.state === 'decided' || now.state !== folded.state) {
      return { code: 409, body: { code: now?.state === 'decided' ? 'proposal_decided' : 'proposal_superseded', error: 'this proposal changed while it was being answered; check the card again', ...(now !== undefined ? { view: viewOf(now) } : {}) } };
    }
    const flags = this.deps.flags();
    if (!flags.proposals || !flags[kind] || !this.deps.registry.has(kind)) {
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
    // Where it is filed still exists (a create or demo files into the chat's project).
    if ((kind === 'create' || kind === 'demo') && (await this.deps.docsRoot(resolution.filedIn.projectId ?? 'default')) === null) {
      return { code: 409, body: { code: 'source_gone', error: `${resolution.filedIn.label} is no longer on this daemon`, view: viewOf(folded) } };
    }
    // Every source and the target still exist, and are still where they were authorized.
    const gone = await this.firstGone(chatId, resolution);
    if (gone !== null) return { code: 409, body: { code: 'source_gone', error: gone, view: viewOf(folded) } };
    const busy = await this.busy(chatId, identity.artifactRef, resolution);
    if (busy !== null) return { code: 409, body: { code: busy.code, error: busy.reason, view: viewOf(folded) } };
    // A refine is on the head it was proposed on; else the card re-resolves (same pid, the new base). Read last, right
    // before the record: the landing itself is checked against this base (`expect_head`, slices I1 and A5).
    if (resolution.target !== undefined) {
      const ref = parseArtifactRef(resolution.target.ref)!;
      const root = await this.deps.docsRoot(ref.projectId);
      const head = root === null ? null : artifactHead(root, ref.doc);
      if (head === null) return { code: 409, body: { code: 'source_gone', error: `${resolution.target.title} is gone`, view: viewOf(folded) } };
      if (head !== resolution.target.base) {
        // From the proposal as crew recorded it (never the refused request's edits): the person chooses again.
        const recorded = folded.proposal;
        const fresh: ArtifactProposal = { ...recorded, target: { ...(recorded.target ?? resolution.target), base: head } };
        if (!this.write(chatId, { at: this.now(), turnId: folded.turnId, kind: 'proposal', proposal: fresh }, instance)) return this.gone(chatId);
        const after = foldProposals(this.deps.records(chatId)).get(pid);
        return {
          code: 409,
          body: { code: 'proposal_reresolved', error: `${resolution.target.title} changed since this was proposed (now v${head}); check the card again`, ...(after !== undefined ? { view: viewOf(after) } : {}) },
        };
      }
    }

    // Recorded before anything starts.
    const accepting: ProposalRecord = { at: this.now(), turnId: folded.turnId, kind: 'proposal_accepting', pid, actor: actor.id, edits, resolution, identity };
    if (!this.write(chatId, accepting, instance)) return this.gone(chatId);
    let result: ProposalResult;
    try {
      result = await this.deps.registry.launchOnce({ kind, pid, chatId, actor, identity, resolution });
    } catch (err) {
      // Accepting stays recorded: the card shows "Interrupted · Go again", which resumes the same identity.
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.audit('chat.proposal.launch_failed', actor, { chatId, pid, error: msg });
      const after = foldProposals(this.deps.records(chatId)).get(pid);
      return { code: 502, body: { code: 'launch_failed', error: `could not start it: ${msg}. Go again resumes the same job.`, ...(after !== undefined ? { view: viewOf(after) } : {}) } };
    }
    if (!this.decided(chatId, folded.turnId, pid, actor, 'go', result, resolution, edits, instance)) return this.gone(chatId);
    const after = foldProposals(this.deps.records(chatId)).get(pid) ?? folded;
    return { code: 200, body: { view: viewOf(after) } };
  }

  /** Record the answer (and audit exactly what was answered); `false` when the chat is no longer this instance. */
  private decided(chatId: string, turnId: string, pid: string, actor: Actor, decision: 'go' | 'not_now', result: ProposalResult | null, resolution: ArtifactProposal, edits: ProposalEdits | null, instance: string | null): boolean {
    if (!this.write(chatId, { at: this.now(), turnId, kind: 'proposal_decided', pid, actor: actor.id, decision, result }, instance)) return false;
    this.deps.audit(decision === 'go' ? 'chat.proposal.accepted' : 'chat.proposal.declined', actor, { chatId, pid, kind: resolution.kind, resolution, edits, result });
    return true;
  }

  /** The identity a Go is named by (DES §4.3 step 2). */
  identityOf(p: ArtifactProposal): ProposalIdentity {
    const runId = proposalRunId(p.pid);
    if (p.kind === 'refine') return { artifactRef: p.target?.ref ?? null, runId };
    if (p.kind === 'create') {
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
    for (const s of p.sources) {
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
    for (const f of foldProposals(this.deps.records(chatId)).values()) {
      if (f.proposal.pid === p.pid) continue;
      // Another proposal of this chat started a job (decided go, or accepting with its run launched) still live.
      const runId = f.state === 'decided' && f.decision === 'go' ? f.result?.runId ?? null
        : f.state === 'accepting' ? f.accepting?.identity.runId ?? null : null;
      if (runId !== null && (await this.deps.registry.live(f.proposal.kind, runId))) {
        return { code: 'chat_busy', reason: `This chat already has a job running (${f.proposal.what.label}). Wait, or stop that run.` };
      }
    }
    for (const v of runs) {
      if (!isLive(v) || this.deps.chatOfRun(v.session.id) !== chatId || this.deps.isAskPath(v.session.id)) continue;
      return { code: 'chat_busy', reason: `This chat already has a job running (run ${v.session.id.slice(0, 8)}). Wait, or stop that run.` };
    }
    if (artifactRef !== null && p.kind === 'refine') {
      if (await this.deps.registry.liveForArtifact(artifactRef)) {
        return { code: 'document_busy', reason: `“${p.target?.title ?? artifactRef}” is being revised. Wait, or stop that run.` };
      }
      const ref = parseArtifactRef(artifactRef);
      if (ref !== null) {
        for (const v of runs) {
          const doc = (v.session as { document_id?: string | null }).document_id;
          if (isLive(v) && doc === ref.doc && runMount(v) === ref.mount) {
            return { code: 'document_busy', reason: `“${p.target?.title ?? ref.doc}” is being revised. Wait, or stop that run.` };
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
    const allowed: Record<ArtifactProposalKind, ReadonlyArray<keyof ProposalEdits>> = {
      create: ['title', 'brief', 'sources', 'helpers'],
      refine: ['ask', 'helpers'],
      theme: ['name', 'patch'],
      demo: ['audience', 'show', 'helpers'],
    };
    for (const k of Object.keys(edits) as Array<keyof ProposalEdits>) {
      if (!allowed[p.kind].includes(k)) throw new EditRefusal(`${k} can't be changed on a ${p.kind} proposal here yet`);
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
    if (edits.sources !== undefined) {
      if (edits.sources.length > PROPOSAL_SOURCES_MAX) throw new EditRefusal(`at most ${PROPOSAL_SOURCES_MAX} sources`);
      const records = this.deps.records(chatId);
      const { binding, turnHas } = bindingOf(records, f.turnId);
      // A source the person adds counts as named by them, and is still checked against the scope.
      const sources = await this.resolveSources(edits.sources, {
        chatId,
        turnId: f.turnId,
        records,
        binding,
        turnHas,
        chat: { projectId: p.filedIn.projectId },
        words: personWords(records, f.turnId),
        personNamed: true,
      });
      // A source the person adds that cannot be used is said back, never silently dropped from a launch.
      const added = sources.find((src) => src.status === 'struck' && !p.sources.some((old) => old.token === src.token && old.status === 'struck'));
      if (added !== undefined) throw new EditRefusal(`${added.label}: ${added.reason ?? 'it cannot be used'}`);
      next = { ...next, sources };
    }
    return next;
  }
}
