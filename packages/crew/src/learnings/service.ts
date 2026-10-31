/**
 * Run learnings, part 2: from a run's record to the approve queue (the operator's 2026-10-30 ask).
 *
 *  - At the run's CHECKPOINTS (a power checkpoint, a unit done, a gate decided) the template
 *    learnings found so far ({@link extractLearnings}: a flaky test, a check the sandbox could not
 *    start) are filed at once.
 *  - At the run's END the rest of the evidence (rulings, steers, decisions, review findings, base-red
 *    checks) goes to ONE cheap seat that did not build the run: a `distill-learnings` run, one seat,
 *    one turn, no repository. Crew files what it writes. When no such seat can run (none signed in,
 *    the launch refused, it wrote nothing usable), the evidence is filed raw, trimmed and capped.
 *
 * Everything filed is a PROPOSAL of kind `memory` in estate's queue, attributed to the SOURCE run
 * (`provenance.run_id`), faceted by repo, project and seat. Nothing is written without a person's
 * approval. The same evidence is never proposed twice: a candidate whose text is already in the queue
 * (pending or approved) or in the memory store is skipped, whichever run filed it.
 *
 * Never throws into the event pump: every failure is logged and the run is left as it was.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionView } from 'wicked-crew-api-types';
import type { LaunchRunInput, WorkflowDef } from '../core/types.js';
import type { LooseEvent } from '../insights/run-facts.js';
import { creatorSeats, extractLearnings, normalizeLearning, projectOf, repoOf, type LearningCandidate, type LearningKind } from './extract.js';

export const DISTILL_WORKFLOW = 'distill-learnings';
export const DISTILL_WORKFLOW_FILE = fileURLToPath(new URL('../../workflows/distill-learnings.json', import.meta.url));
export const HANDOFF_FILE = 'handoff.json';
export const OUT_DIR = 'out';
export const REPORT_FILE = 'report.json';
/** Written once a source run's learnings were filed at its end: a resume's second terminal frame files nothing. */
export const FILED_FILE = 'filed.json';
/** The distil run launched for a source run (its id and seat). */
export const DISTILL_FILE = 'distill.json';
/** The agent named on a learning crew worded itself (a template, or raw evidence). */
export const CREW_AGENT = 'crew';
/** The most learnings one run proposes from its end (the distil seat's, or the raw fallback). */
export const MAX_END_LEARNINGS = 5;
/** The shortest learning worth a person's time (estate refuses shorter bodies too). */
export const MIN_LEARNING_CHARS = 40;
export const MAX_LEARNING_CHARS = 1500;

/** Runs whose own record is not a source of learnings: they capture, review or set up. */
export const NO_LEARNINGS_WORKFLOWS: ReadonlySet<string> = new Set([
  DISTILL_WORKFLOW,
  'inspect-unit',
  'capture-learnings',
  'review-recent-work',
  'run-evals',
  'onboarding',
  'learn',
]);

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
const CHECKPOINT_EVENTS: ReadonlySet<string> = new Set(['powerCheckpointReached', 'unitDone', 'gateDecided']);
const END_EVENTS: ReadonlySet<string> = new Set(['sessionCompleted', 'sessionFailed', 'runCancelled']);

export type RunLearningsMode = 'off' | 'extract' | 'distill';

/** `WICKED_CREW_RUN_LEARNINGS`: `off`, `extract` (no distil seat), `distill` (the default). A test process
 *  (vitest, NODE_ENV=test) defaults to `off`, so a headless server never spawns estate on a stub run's frames. */
export function runLearningsMode(env: NodeJS.ProcessEnv = process.env): RunLearningsMode {
  const v = (env['WICKED_CREW_RUN_LEARNINGS'] ?? '').trim().toLowerCase();
  if (v === 'off' || v === 'extract' || v === 'distill') return v;
  return env['VITEST'] !== undefined || env['NODE_ENV'] === 'test' ? 'off' : 'distill';
}

/** Where each source run's distil handoff lives: outside the daemon state home (the worker fence), like reviews. */
export function defaultLearningsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_LEARNINGS_DIR'] ?? join(homedir(), '.wicked', 'learnings');
}

export function loadDistillWorkflow(file = DISTILL_WORKFLOW_FILE): WorkflowDef {
  const def = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete def['$comment'];
  return def as unknown as WorkflowDef;
}

/** One row of estate's `proposal.list`, read loosely. */
export interface ProposalRow {
  id: string;
  kind_type: string;
  state: string;
  created_at?: number;
  payload: Record<string, unknown>;
  facets: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

/** What `GET /runs/:id/learnings` answers. */
export interface RunLearningsView {
  runId: string;
  proposed: number;
  pending: number;
  approved: number;
  rejected: number;
  /** A distil seat is still reading this run's evidence. */
  distilling: boolean;
  items: Array<{ id: string; state: string; capture: string | null; content: string; agent: string | null; createdAt: number | null }>;
}

export interface SubmitArgs {
  kind_type: 'memory';
  payload: Record<string, unknown>;
  facets: Record<string, string>;
}

export interface RunLearningsDeps {
  adapter: {
    sessionsDetail(): Promise<SessionView[]>;
    runEvents(runId: string): Promise<LooseEvent[] | null>;
    seatsForWorkflow(workflowId: string): Promise<unknown[]>;
    launchRun(input: LaunchRunInput): Promise<string>;
  };
  /** File one proposal attributed to `runId` (its provenance), as `agent`. Returns the proposal id. */
  submit(runId: string, agent: string, args: SubmitArgs): Promise<string | null>;
  /** Every proposal in the queue, any state. */
  listProposals(): Promise<ProposalRow[]>;
  /** The text of every memory in the store (the dedupe set). */
  listMemoryContents(): Promise<string[]>;
  /** The launch bookkeeping a chained run gets (launch entry, project filing, `runChained` frame). */
  launched?(distillRunId: string, sourceRunId: string, projectId: string | null): void;
  learningsDir: string;
  mode: RunLearningsMode;
  log: (msg: string) => void;
  newRunId: () => string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KINDS: ReadonlySet<string> = new Set(['gotcha', 'decision', 'pattern', 'steering']);
/** Raw fallback order: the operator's own words first, then what bit, then the rest. */
const FALLBACK_ORDER: Record<string, number> = { operator_ruling: 0, steer: 1, qe_review: 2, working_notes: 3, review: 4, repo_checks: 5 };

function tierOf(kind: LearningKind): string {
  return kind === 'pattern' ? 'procedural' : 'semantic';
}

/** The proposals one run filed (provenance), as the run's end card and the queue's filter read them. */
export function learningsOfRun(runId: string, rows: readonly ProposalRow[]): RunLearningsView['items'] {
  return rows
    .filter((r) => r.kind_type === 'memory' && r.provenance['run_id'] === runId)
    .map((r) => ({
      id: r.id,
      state: r.state,
      capture: typeof r.payload['capture'] === 'string' ? r.payload['capture'] : null,
      content: typeof r.payload['content'] === 'string' ? r.payload['content'] : '',
      agent: typeof r.provenance['run_agent'] === 'string' ? r.provenance['run_agent'] : null,
      createdAt: typeof r.created_at === 'number' ? r.created_at : null,
    }));
}

/**
 * A distil report's learnings, validated: known kind, sane length, at most {@link MAX_END_LEARNINGS}. `null` when
 * there is no usable report: none, malformed, or entries none of which survive validation. An explicitly EMPTY list is
 * the seat's judgment (nothing durable) and is kept as `[]`.
 */
export function parseDistillReport(raw: unknown): Array<{ kind: LearningKind; content: string }> | null {
  if (!isRecord(raw) || !Array.isArray(raw['learnings'])) return null;
  const entries = raw['learnings'];
  const out: Array<{ kind: LearningKind; content: string }> = [];
  for (const e of entries) {
    if (!isRecord(e)) continue;
    const kind = typeof e['kind'] === 'string' && KINDS.has(e['kind']) ? (e['kind'] as LearningKind) : 'gotcha';
    const content = typeof e['content'] === 'string' ? e['content'].replace(/\s+/gu, ' ').trim() : '';
    if (content.length < MIN_LEARNING_CHARS || content.length > MAX_LEARNING_CHARS) continue;
    out.push({ kind, content });
    if (out.length >= MAX_END_LEARNINGS) break;
  }
  return entries.length > 0 && out.length === 0 ? null : out;
}

interface DistillRecord {
  sourceRunId: string;
  distillRunId: string | null;
  seat: string | null;
}

export class RunLearningsService {
  /**
   * Every sweep and reconcile runs on ONE daemon-wide queue: the dedupe read and the submits that follow it are
   * atomic across runs (two runs that hit the same flaky test propose it once), and a run's end, its distil report
   * and a resume's second terminal frame never interleave. A task already queued and not yet started is not queued
   * twice.
   */
  private tail: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();
  /** distil run id → its source run (rebuilt from disk after a restart). */
  private readonly distills = new Map<string, string>();
  private distillsLoaded = false;

  constructor(private readonly deps: RunLearningsDeps) {}

  private dirOf(sourceRunId: string): string {
    return join(this.deps.learningsDir, sourceRunId);
  }

  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    if (this.queued.has(key)) return this.tail;
    this.queued.add(key);
    this.tail = this.tail.then(async () => {
      this.queued.delete(key);
      try {
        await task();
      } catch (err) {
        this.deps.log(`[learnings] ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return this.tail;
  }

  /** Fold one engine frame. Never throws. */
  onEvent(event: { type: string; session?: unknown }): void {
    if (this.deps.mode === 'off') return;
    const session = event.session;
    if (typeof session !== 'string' || session === '') return;
    if (END_EVENTS.has(event.type)) {
      void this.enqueue(`end:${session}`, () => this.onEnd(session));
    } else if (CHECKPOINT_EVENTS.has(event.type)) {
      void this.enqueue(`checkpoint:${session}`, () => this.sweepOnce(session, 'checkpoint'));
    }
  }

  /** Read the run's record and file what is new (a test's direct entry; frames go through {@link onEvent}). */
  sweep(runId: string, phase: 'checkpoint' | 'end'): Promise<void> {
    return this.enqueue(`${phase}:${runId}`, () => (phase === 'end' ? this.onEnd(runId) : this.sweepOnce(runId, 'checkpoint')));
  }

  private async onEnd(runId: string): Promise<void> {
    this.loadDistills();
    const source = this.distills.get(runId);
    if (source !== undefined) {
      await this.reconcileDistill(runId, source);
      return;
    }
    await this.sweepOnce(runId, 'end');
  }

  /**
   * After a restart: finish every run whose end was interrupted. A handoff with no distil run (the daemon stopped
   * before the launch) is ended again; a distil run that ended while the daemon was down is reconciled; one the
   * daemon no longer knows is filed raw. Never throws.
   */
  recover(): Promise<void> {
    if (this.deps.mode === 'off') return Promise.resolve();
    return this.enqueue('recover', async () => {
      if (!existsSync(this.deps.learningsDir)) return;
      const views = new Map((await this.deps.adapter.sessionsDetail()).map((v) => [v.session.id, v] as const));
      for (const name of readdirSync(this.deps.learningsDir)) {
        const dir = join(this.deps.learningsDir, name);
        if (existsSync(join(dir, FILED_FILE))) continue;
        const rec = this.readJson(join(dir, DISTILL_FILE));
        const child = isRecord(rec) && typeof rec['distillRunId'] === 'string' ? rec['distillRunId'] : null;
        if (child === null) {
          if (views.has(name)) await this.sweepOnce(name, 'end');
          continue;
        }
        this.distills.set(child, name);
        const status = views.get(child)?.session.status;
        if (status === undefined || TERMINAL.has(status)) await this.reconcileDistill(child, name);
      }
    });
  }

  private async viewOf(runId: string): Promise<SessionView | null> {
    return (await this.deps.adapter.sessionsDetail()).find((v) => v.session.id === runId) ?? null;
  }

  private async sweepOnce(runId: string, phase: 'checkpoint' | 'end'): Promise<void> {
    const view = await this.viewOf(runId);
    if (view === null) return;
    const workflow = String(view.session.workflow_id ?? '');
    if (NO_LEARNINGS_WORKFLOWS.has(workflow)) return;
    const dir = this.dirOf(runId);
    if (phase === 'end' && (existsSync(join(dir, FILED_FILE)) || this.distillOf(runId) !== null)) return;
    const events = (await this.deps.adapter.runEvents(runId)) ?? [];
    const candidates = extractLearnings(view, events);
    const known = await this.knownTexts();
    const fresh = (c: LearningCandidate): boolean => !known.has(normalizeLearning(c.content));
    let failed = 0;
    for (const c of candidates.filter((x) => x.form === 'template' && fresh(x))) {
      if ((await this.file(view, CREW_AGENT, c.kind, c.content, c.cli)) === null) failed += 1;
      else known.add(normalizeLearning(c.content));
    }
    if (phase !== 'end') return;
    const material = candidates.filter((x) => x.form === 'material' && fresh(x));
    mkdirSync(dir, { recursive: true });
    if (material.length === 0) {
      if (failed === 0) this.markFiled(runId, { distilled: false, filed: 0 });
      return;
    }
    const launched = this.deps.mode === 'distill' ? await this.launchDistill(view, material, known) : null;
    if (launched === null) await this.fileRaw(view, material, failed);
  }

  /** The distil run recorded for a source run, if one was launched. */
  private distillOf(sourceRunId: string): string | null {
    const rec = this.readJson(join(this.dirOf(sourceRunId), DISTILL_FILE));
    return isRecord(rec) && typeof rec['distillRunId'] === 'string' ? rec['distillRunId'] : null;
  }

  /** The normalized text of every proposal in the queue (a person's rejection is not proposed again) and every stored memory. */
  private async knownTexts(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const p of await this.deps.listProposals()) {
      const text = p.payload['content'];
      if (typeof text === 'string') out.add(normalizeLearning(text));
    }
    try {
      for (const m of await this.deps.listMemoryContents()) out.add(normalizeLearning(m));
    } catch (err) {
      this.deps.log(`[learnings] memory list unreadable, deduping against the queue only: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out;
  }

  private async file(view: SessionView, agent: string, kind: LearningKind, content: string, cli: string | null): Promise<string | null> {
    const facets: Record<string, string> = {};
    const repo = repoOf(view);
    const project = projectOf(view);
    if (repo !== null) facets['repo'] = repo;
    if (project !== null) facets['project'] = project;
    if (cli !== null) facets['cli'] = cli;
    try {
      return await this.deps.submit(view.session.id, agent, {
        kind_type: 'memory',
        payload: { content, capture: kind, tier: tierOf(kind), reach: 'project' },
        facets,
      });
    } catch (err) {
      this.deps.log(`[learnings] proposing a learning from ${view.session.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** No distil seat: the evidence as it is, trimmed and capped, for a person to edit or reject. */
  /** `failedBefore`: submits of this end that already failed. The run is marked filed only when none did, so a
   *  failed submit is retried on the next recovery (the dedupe keeps what landed from landing twice). */
  private async fileRaw(view: SessionView, material: readonly LearningCandidate[], failedBefore = 0): Promise<void> {
    const ordered = material
      .filter((c) => c.content.length >= MIN_LEARNING_CHARS)
      .sort((a, b) => (FALLBACK_ORDER[a.source] ?? 9) - (FALLBACK_ORDER[b.source] ?? 9))
      .slice(0, MAX_END_LEARNINGS);
    let filed = 0;
    let failed = failedBefore;
    for (const c of ordered) {
      if ((await this.file(view, CREW_AGENT, c.kind, c.content, c.cli)) !== null) filed += 1;
      else failed += 1;
    }
    if (failed === 0) this.markFiled(view.session.id, { distilled: false, filed });
    else this.deps.log(`[learnings] ${view.session.id}: ${failed} learning(s) could not be proposed; retried at the next recovery`);
  }

  private markFiled(sourceRunId: string, what: Record<string, unknown>): void {
    try {
      mkdirSync(this.dirOf(sourceRunId), { recursive: true });
      writeFileSync(join(this.dirOf(sourceRunId), FILED_FILE), JSON.stringify({ ...what, at: new Date().toISOString() }), 'utf8');
    } catch (err) {
      this.deps.log(`[learnings] could not record ${sourceRunId} as filed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A seat that did not build this run, signed in and eligible; `null` when there is none. */
  private async distillSeat(view: SessionView): Promise<Record<string, unknown> | null> {
    const builders = new Set(creatorSeats(view));
    for (const seat of await this.deps.adapter.seatsForWorkflow(DISTILL_WORKFLOW)) {
      if (!isRecord(seat)) continue;
      const key = typeof seat['key'] === 'string' ? seat['key'] : null;
      if (key === null || builders.has(key)) continue;
      if (typeof seat['cli'] === 'string' && builders.has(seat['cli'])) continue;
      if (seat['council_eligible'] === false) continue;
      const health = seat['health'];
      if (isRecord(health) && typeof health['status'] === 'string' && health['status'] !== 'active') continue;
      return seat;
    }
    return null;
  }

  /** Launch the distil run. `null` when it could not be launched (the caller files the evidence raw). */
  private async launchDistill(view: SessionView, material: readonly LearningCandidate[], known: ReadonlySet<string>): Promise<string | null> {
    const sourceRunId = view.session.id;
    const dir = this.dirOf(sourceRunId);
    let seat: Record<string, unknown> | null;
    try {
      seat = await this.distillSeat(view);
    } catch (err) {
      this.deps.log(`[learnings] no roster for the distil seat of ${sourceRunId}: ${err instanceof Error ? err.message : String(err)}`);
      seat = null;
    }
    if (seat === null) {
      this.deps.log(`[learnings] ${sourceRunId}: no signed-in seat other than the builder's to distil its learnings; filing the evidence as it is`);
      return null;
    }
    const out = join(dir, OUT_DIR);
    mkdirSync(out, { recursive: true });
    const reportPath = join(out, REPORT_FILE);
    const handoffPath = join(dir, HANDOFF_FILE);
    const title = String((view.session as unknown as Record<string, unknown>)['title'] ?? view.session.problem.split('\n')[0] ?? sourceRunId).slice(0, 160);
    writeFileSync(
      handoffPath,
      JSON.stringify(
        {
          source_run: sourceRunId,
          title,
          repository: repoOf(view),
          status: view.session.status,
          evidence: material.map((c, i) => ({ id: `e${i + 1}`, kind: c.kind, source: c.source, text: c.content })),
          already_proposed: [...known].slice(0, 200),
          report_path: reportPath,
          max_learnings: MAX_END_LEARNINGS,
        },
        null,
        2,
      ),
      'utf8',
    );
    const distillRunId = this.deps.newRunId();
    const record: DistillRecord = { sourceRunId, distillRunId, seat: String(seat['key']) };
    writeFileSync(join(dir, DISTILL_FILE), JSON.stringify(record), 'utf8');
    this.distills.set(distillRunId, sourceRunId);
    const projectId = projectOf(view);
    const input: LaunchRunInput = {
      problem:
        `Distill learnings from the run "${title}". Read the handoff file at ${handoffPath}. ` +
        `It holds the run's evidence and names report_path, the one file you write.`,
      sessionId: distillRunId,
      clisJson: JSON.stringify([seat]),
      workflow: DISTILL_WORKFLOW,
      extraWriteRoots: [out],
      extraReadRoots: [dir],
      requireDeliverables: [reportPath],
      ...(projectId !== null ? { projectId } : {}),
    };
    try {
      const launched = await this.deps.adapter.launchRun(input);
      this.deps.launched?.(launched, sourceRunId, projectId);
      this.deps.log(`[learnings] ${sourceRunId} ended with ${material.length} piece(s) of evidence → distill-learnings ${launched} on ${record.seat}`);
      return launched;
    } catch (err) {
      this.distills.delete(distillRunId);
      writeFileSync(join(dir, DISTILL_FILE), JSON.stringify({ ...record, distillRunId: null, refused: err instanceof Error ? err.message : String(err) }), 'utf8');
      this.deps.log(`[learnings] distill launch for ${sourceRunId} refused (${err instanceof Error ? err.message : String(err)}); filing the evidence as it is`);
      return null;
    }
  }

  /** After a restart: which distil run belongs to which source run, from the handoff directories. */
  private loadDistills(): void {
    if (this.distillsLoaded) return;
    try {
      if (existsSync(this.deps.learningsDir)) {
        for (const name of readdirSync(this.deps.learningsDir)) {
          if (existsSync(join(this.deps.learningsDir, name, FILED_FILE))) continue;
          const rec = this.readJson(join(this.deps.learningsDir, name, DISTILL_FILE));
          if (isRecord(rec) && typeof rec['distillRunId'] === 'string' && typeof rec['sourceRunId'] === 'string') {
            this.distills.set(rec['distillRunId'], rec['sourceRunId']);
          }
        }
      }
      this.distillsLoaded = true;
    } catch (err) {
      // Read again on the next frame.
      this.deps.log(`[learnings] the learnings directory is unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readJson(path: string): unknown {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      return null;
    }
  }

  /** A distil run ended: file what it wrote under the source run, or the raw evidence when it wrote nothing usable. */
  async reconcileDistill(distillRunId: string, sourceRunId: string): Promise<void> {
    const dir = this.dirOf(sourceRunId);
    if (existsSync(join(dir, FILED_FILE))) return;
    try {
      const view = await this.viewOf(sourceRunId);
      if (view === null) return;
      const rec = this.readJson(join(dir, DISTILL_FILE));
      const seat = isRecord(rec) && typeof rec['seat'] === 'string' ? rec['seat'] : CREW_AGENT;
      const report = parseDistillReport(this.readJson(join(dir, OUT_DIR, REPORT_FILE)));
      if (report === null) {
        this.deps.log(`[learnings] distill-learnings ${distillRunId} wrote no usable report for ${sourceRunId}; filing the evidence as it is`);
        const events = (await this.deps.adapter.runEvents(sourceRunId)) ?? [];
        const known = await this.knownTexts();
        await this.fileRaw(view, extractLearnings(view, events).filter((c) => c.form === 'material' && !known.has(normalizeLearning(c.content))));
        return;
      }
      const known = await this.knownTexts();
      let filed = 0;
      let failed = 0;
      for (const l of report) {
        if (known.has(normalizeLearning(l.content))) continue;
        if ((await this.file(view, seat, l.kind, l.content, null)) === null) {
          failed += 1;
          continue;
        }
        filed += 1;
        known.add(normalizeLearning(l.content));
      }
      if (failed === 0) this.markFiled(sourceRunId, { distilled: true, distillRunId, seat, filed });
      else this.deps.log(`[learnings] ${sourceRunId}: ${failed} distilled learning(s) could not be proposed; retried at the next recovery`);
    } catch (err) {
      this.deps.log(`[learnings] reconciling distill-learnings ${distillRunId} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.distills.delete(distillRunId);
    }
  }

  /** The run's end card: what it proposed, and whether a distil seat is still at it. */
  async view(runId: string): Promise<RunLearningsView> {
    this.loadDistills();
    const items = learningsOfRun(runId, await this.deps.listProposals());
    const distilling = [...this.distills.values()].includes(runId) && !existsSync(join(this.dirOf(runId), FILED_FILE));
    return {
      runId,
      proposed: items.length,
      pending: items.filter((i) => i.state === 'pending').length,
      approved: items.filter((i) => i.state === 'approved').length,
      rejected: items.filter((i) => i.state === 'rejected').length,
      distilling,
      items,
    };
  }
}
