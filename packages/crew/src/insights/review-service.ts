/**
 * The run review around its workflow (DES-RUNS-REVIEW-001 §3, §5, §6):
 *
 *  - {@link ReviewService.prepareLaunch} — every launch of `review-recent-work` (a schedule, Run it now, or
 *    `POST /runs`) goes through it: it reads the run store, writes `<reviews dir>/<run>/snapshot.json` and the
 *    handoff, and makes the launch repo-less, delivering nothing, with that directory as its ONLY write root and
 *    `report.json` as its deliverable, on ONE seat.
 *  - {@link ReviewService.reconcile} — once a review run is terminal, crew reads `facts.json` (the script's) and
 *    `report.json` (the seat's), keeps at most five recommendations ranked by crew's impact score, files the
 *    steering-rule and memory ones into the approve queue, and records the review.
 *  - {@link ReviewService.accept} / {@link ReviewService.dismiss} — a person's decision on one recommendation.
 *
 * The seat never files anything and never writes a number crew stores.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStatus, SessionView } from 'wicked-crew-api-types';
import type { LaunchRunInput } from '../core/types.js';
import type { Confidence, Facts, Snapshot, Window } from './analyze.js';
import { MAX_RECOMMENDATIONS, analyze } from './analyze.js';
import { FACTS_FILE, REPORT_FILE, SNAPSHOT_FILE } from './analyze-cli.js';
import { runFactOf, type LooseEvent, type RunFact } from './run-facts.js';
import type { InsightsStore, Recommendation, Review } from './store.js';
import { REVIEW_WORKFLOW } from './workflow.js';

export const HANDOFF_FILE = 'handoff.json';
/** The seat's ONLY write root inside its review directory: the snapshot and the numbers beside it stay out of reach. */
export const OUT_DIR = 'out';
const HOUR = 3_600_000;
/** The first review looks back this far; later ones start where the last completed review's window ended. */
export const FIRST_WINDOW_MS = 48 * HOUR;
/** A window never spans more than this (a review after a long pause looks at the last two weeks). */
export const MAX_WINDOW_MS = 14 * 24 * HOUR;
/** The baseline: this many previous windows of the same length. */
export const BASELINE_WINDOWS = 4;
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
/** A review run the daemon no longer lists is given up on after this long. */
const LOST_AFTER_MS = 48 * HOUR;

export interface ReviewServiceDeps {
  store: InsightsStore;
  adapter: {
    sessionsDetail(): Promise<SessionView[]>;
    runEvents(runId: string): Promise<LooseEvent[] | null>;
    seatsForWorkflow(workflowId: string): Promise<unknown[]>;
    listRepos?(): Promise<Array<{ id: string; git_url?: string }>>;
  };
  reviewsDir: string;
  /** The approve queue (estate `proposal.*`), the same seam `/proposals` uses. */
  estateTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  log: (msg: string) => void;
  now?: () => Date;
}

export interface PrepareOptions {
  trigger: 'schedule' | 'manual';
  scheduleId?: string | null;
  /** Limit the review to these projects; empty = every run. */
  projectIds?: readonly string[];
}

/** What a person's Accept opens in studio. */
export type AcceptTarget =
  | { kind: 'proposal'; proposalId: string }
  | { kind: 'settings'; section: string }
  | { kind: 'issue'; repoRef: string | null; title: string; body: string; url: string | null }
  | { kind: 'runs'; runIds: string[] }
  | { kind: 'none' };

export class RecommendationError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string) {
    super(message);
  }
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const line = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/gu, ' ').trim();
  return t === '' ? null : t.slice(0, max);
};

export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  runDir(runId: string): string {
    return join(this.deps.reviewsDir, runId);
  }

  /** The review window: from the end of the last completed review OF THE SAME SCOPE (else 48 h back), capped at
   *  14 days. A review of other projects never moves this scope's cursor. */
  windowFor(nowMs: number, projectIds: readonly string[] = []): { window: Window; baselineWindows: Window[] } {
    const last = this.deps.store.lastCompleted(scopeKey(projectIds));
    const start = Math.max(last?.window.endMs ?? nowMs - FIRST_WINDOW_MS, nowMs - MAX_WINDOW_MS);
    // A review run seconds after the last one still compares a meaningful span.
    const len = Math.max(nowMs - start, HOUR);
    const window = { startMs: nowMs - len, endMs: nowMs };
    const baselineWindows: Window[] = [];
    for (let i = 1; i <= BASELINE_WINDOWS; i += 1) baselineWindows.push({ startMs: window.startMs - i * len, endMs: window.startMs - (i - 1) * len });
    return { window, baselineWindows };
  }

  /** Fold the run store into a snapshot (the analyze script's only input). */
  async snapshot(projectIds: readonly string[], nowMs: number): Promise<Snapshot> {
    const { window, baselineWindows } = this.windowFor(nowMs, projectIds);
    const earliest = Math.min(...baselineWindows.map((w) => w.startMs), window.startMs);
    const views = await this.deps.adapter.sessionsDetail();
    const runs: RunFact[] = [];
    for (const view of views) {
      const s = view.session as unknown as Record<string, unknown>;
      if (s['workflow_id'] === REVIEW_WORKFLOW) continue;
      if (projectIds.length > 0 && !projectIds.includes(String(s['project_id'] ?? ''))) continue;
      const dated = typeof s['created_at'] === 'number' ? (s['created_at'] < 1e12 ? s['created_at'] * 1000 : s['created_at']) : null;
      // A run dated by the daemon's launch record outside every window is skipped without reading its events.
      if (dated !== null && (dated < earliest || dated >= window.endMs)) continue;
      let events: LooseEvent[] = [];
      try {
        events = (await this.deps.adapter.runEvents(String(s['id']))) ?? [];
      } catch (err) {
        this.deps.log(`[review] events of ${String(s['id'])} unreadable, counted from its record only: ${err instanceof Error ? err.message : String(err)}`);
      }
      // An undated run (no launch record: onboarding, campaign nodes, older runs) is dated by its first event.
      const created = dated ?? Math.min(...events.map((e) => (typeof e.ts === 'number' ? e.ts : Number.POSITIVE_INFINITY)));
      if (!Number.isFinite(created) || created < earliest || created >= window.endMs) continue;
      runs.push(runFactOf(view, events, nowMs));
    }
    return { version: 1, generatedAtMs: nowMs, window, baselineWindows, projectIds: [...projectIds], runs };
  }

  /**
   * Make a launch a review launch. Mutates and returns `input`: repo-less, no deliver, one seat, the run directory
   * as the only write root, `report.json` as the only deliverable. Records the review as running.
   */
  async prepareLaunch(input: LaunchRunInput, opts: PrepareOptions): Promise<LaunchRunInput> {
    const now = this.now();
    const runId = input.sessionId;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) || runId.includes('..')) throw new Error(`a review run id must be one plain path segment: ${runId}`);
    // One review per run id: a repeated id never touches the review already recorded under it.
    if (this.deps.store.get(runId) !== undefined) throw new Error(`a review is already recorded for run ${runId}`);
    const seat = pickSeat(await this.deps.adapter.seatsForWorkflow(REVIEW_WORKFLOW));
    if (seat === null) throw new Error('no signed-in, eligible agent seat to interpret the review: sign one in (Agents) and run it again');
    const projectIds = [...(opts.projectIds ?? [])];
    const snap = await this.snapshot(projectIds, now.getTime());
    const dir = this.runDir(runId);
    mkdirSync(this.deps.reviewsDir, { recursive: true });
    try {
      mkdirSync(dir); // exclusive: the filesystem decides who owns this id
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`a review directory already exists for run ${runId}`);
      throw err;
    }
    const out = join(dir, OUT_DIR);
    mkdirSync(out);
    writeFileSync(join(dir, SNAPSHOT_FILE), JSON.stringify(snap), 'utf8');
    const factsPath = join(dir, FACTS_FILE);
    const reportPath = join(out, REPORT_FILE);
    const handoffPath = join(dir, HANDOFF_FILE);
    writeFileSync(handoffPath, JSON.stringify({ facts_path: factsPath, report_path: reportPath, max_recommendations: MAX_RECOMMENDATIONS }, null, 2), 'utf8');
    const asked = input.problem.trim();
    input.problem =
      `Review recent work: interpret the run review computed for ${snap.runs.length} runs ` +
      `(${new Date(snap.window.startMs).toISOString()} to ${new Date(snap.window.endMs).toISOString()}). ` +
      `Read the handoff file at ${handoffPath}. It names facts_path (the numbers, computed by a script) and ` +
      `report_path (the one file you write).` +
      (asked !== '' && asked !== REVIEW_WORKFLOW ? `\n\nThe person also asked: ${asked.slice(0, 2000)}` : '');
    input.workflow = REVIEW_WORKFLOW;
    input.clisJson = JSON.stringify([seat]);
    // The seat reads the review directory and writes ONLY `out/`: the snapshot and facts.json are not its to change.
    input.extraWriteRoots = [out];
    input.requireDeliverables = [reportPath];
    delete input.repoRef;
    delete input.deliver;
    delete input.baseRef;
    delete input.revisesPr;
    delete input.plan;
    delete input.projectGraph;
    input.extraReadRoots = [dir];
    this.deps.store.add({
      runId,
      trigger: opts.trigger,
      scheduleId: opts.scheduleId ?? null,
      launchedAt: now.toISOString(),
      endedAt: null,
      status: 'running',
      window: snap.window,
      baselineWindows: snap.baselineWindows,
      projectIds,
      summary: null,
      interpreted: false,
      totals: null,
      series: [],
      improvements: [],
      regressions: [],
      recommendations: [],
      watching: [],
      error: null,
    });
    return input;
  }

  /** A launch the engine refused: the review never ran. */
  launchRefused(runId: string, reason: string): void {
    this.deps.store.update(runId, { status: 'failed', endedAt: this.now().toISOString(), error: `the launch was refused: ${reason.slice(0, 500)}` });
  }

  /** Fold every running review whose run is terminal. Never throws. */
  async reconcile(status: ReadonlyMap<string, SessionStatus | string>): Promise<void> {
    for (const review of this.deps.store.running()) {
      try {
        const s = status.get(review.runId);
        if (s === undefined) {
          if (this.now().getTime() - Date.parse(review.launchedAt) > LOST_AFTER_MS) {
            this.deps.store.update(review.runId, { status: 'failed', endedAt: this.now().toISOString(), error: 'the review run is no longer on the daemon' });
          }
          continue;
        }
        if (!TERMINAL.has(s)) continue;
        await this.ingest(review, s as 'completed' | 'failed' | 'cancelled');
      } catch (err) {
        this.deps.log(`[review] ingest of ${review.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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

  async ingest(review: Review, status: 'completed' | 'failed' | 'cancelled'): Promise<Review | undefined> {
    const dir = this.runDir(review.runId);
    const endedAt = this.now().toISOString();
    // The Tool step must have run (its facts.json is the seat's input), but the numbers crew STORES are
    // re-derived here from the snapshot crew wrote, by the same deterministic code: nothing the run wrote can
    // change a metric, a candidate, a ranking or a proposal.
    const ran = existsSync(join(dir, FACTS_FILE));
    const snapshot = this.readJson(join(dir, SNAPSHOT_FILE)) as Snapshot | null;
    const facts: Facts | null = ran && snapshot !== null && snapshot.version === 1 && Array.isArray(snapshot.runs) ? analyze(snapshot) : null;
    if (facts === null) {
      return this.deps.store.update(review.runId, {
        status: status === 'completed' ? 'failed' : status,
        endedAt,
        error: status === 'cancelled' ? 'the review was cancelled before its numbers were computed' : 'the analyze step wrote no facts.json',
      });
    }
    const report = this.readJson(join(dir, OUT_DIR, REPORT_FILE)) as Record<string, unknown> | null;
    const merged = mergeReport(review.runId, facts, report);
    for (const rec of merged.recommendations) {
      const p = rec.action.proposal;
      if (p === undefined || (rec.kind !== 'steering-rule' && rec.kind !== 'memory')) continue;
      try {
        const payload =
          rec.kind === 'memory'
            ? { content: p.content, tier: 'semantic', capture: 'review', source: REVIEW_WORKFLOW }
            : { rule: p.content, severity: p.severity ?? 'warn', source: REVIEW_WORKFLOW };
        const res = (await this.deps.estateTool('proposal.submit', { kind_type: p.kindType, payload, facets: {} })) as { id?: unknown };
        if (typeof res?.id === 'string' && res.id !== '') rec.proposalId = res.id;
        else rec.proposalError = 'proposal.submit returned no id';
      } catch (err) {
        rec.proposalError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      }
    }
    return this.deps.store.update(review.runId, {
      // A run that computed its numbers but was cancelled or failed afterwards still shows them, said plainly.
      status: status === 'completed' ? 'completed' : status,
      endedAt,
      summary: merged.summary,
      interpreted: merged.interpreted,
      totals: facts.totals as unknown as Record<string, number>,
      series: facts.metrics.filter((m) => m.segment === 'all').map((m) => ({ metric: m.metric, window: m.window, baseline: m.baseline, verdict: m.verdict })),
      improvements: facts.improvements.map((f) => ({ metric: f.metric, segment: f.segment, line: f.line })),
      regressions: facts.regressions.map((f) => ({ metric: f.metric, segment: f.segment, line: f.line })),
      recommendations: merged.recommendations,
      watching: merged.watching,
      error: status === 'completed' ? null : `the review run ended ${status}${merged.interpreted ? '' : ' before its report was written'}`,
    });
  }

  /** Accept: record it, and say what to open. A proposal-backed one opens its proposal (approval stays there). */
  async accept(id: string): Promise<{ recommendation: Recommendation; open: AcceptTarget }> {
    const found = this.deps.store.findRecommendation(id);
    if (found === undefined) throw new RecommendationError(404, `no recommendation ${id}`);
    if (found.rec.state === 'dismissed') throw new RecommendationError(409, 'this recommendation was dismissed');
    const rec = this.deps.store.updateRecommendation(id, { state: 'accepted', decidedAt: this.now().toISOString(), reason: null }) as Recommendation;
    return { recommendation: rec, open: await this.targetOf(rec) };
  }

  /** Dismiss with a reason. A proposal-backed one rejects its proposal in the approve queue too. */
  async dismiss(id: string, reason: string): Promise<{ recommendation: Recommendation }> {
    const text = line(reason, 500);
    if (text === null) throw new RecommendationError(400, 'a dismissal needs a reason');
    const found = this.deps.store.findRecommendation(id);
    if (found === undefined) throw new RecommendationError(404, `no recommendation ${id}`);
    if (found.rec.state === 'accepted') throw new RecommendationError(409, 'this recommendation was accepted');
    if (found.rec.proposalId !== null && found.rec.state === 'new') {
      try {
        await this.deps.estateTool('proposal.reject', { id: found.rec.proposalId });
      } catch (err) {
        throw new RecommendationError(502, `its proposal could not be rejected: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const rec = this.deps.store.updateRecommendation(id, { state: 'dismissed', reason: text, decidedAt: this.now().toISOString() }) as Recommendation;
    return { recommendation: rec };
  }

  private async targetOf(rec: Recommendation): Promise<AcceptTarget> {
    if (rec.proposalId !== null) return { kind: 'proposal', proposalId: rec.proposalId };
    if (rec.action.setting !== undefined) return { kind: 'settings', section: rec.action.setting };
    if (rec.action.runs !== undefined) return { kind: 'runs', runIds: rec.action.runs };
    const issue = rec.action.issue;
    if (issue !== undefined) {
      let url: string | null = null;
      if (issue.repoRef !== null && this.deps.adapter.listRepos !== undefined) {
        const repo = (await this.deps.adapter.listRepos().catch(() => [])).find((r) => r.id === issue.repoRef);
        url = githubNewIssueUrl(repo?.git_url, issue.title, issue.body);
      }
      return { kind: 'issue', repoRef: issue.repoRef, title: issue.title, body: issue.body, url };
    }
    return { kind: 'none' };
  }
}

/** The scope a review covers, as one comparable key (its projects, sorted; `''` = every run). */
export function scopeKey(projectIds: readonly string[]): string {
  return [...projectIds].sort().join(',');
}

/** The one seat a review runs on: the first the roster says is eligible and not failing. `null` when none is. */
export function pickSeat(roster: readonly unknown[]): unknown | null {
  for (const seat of roster) {
    if (typeof seat !== 'object' || seat === null) continue;
    const s = seat as Record<string, unknown>;
    if (s['council_eligible'] === false) continue;
    const health = s['health'] as { status?: unknown } | null | undefined;
    if (health !== null && health !== undefined && typeof health.status === 'string' && health.status !== 'active') continue;
    return seat;
  }
  return null;
}

/** `https://github.com/<owner>/<repo>/issues/new?title=&body=` for a GitHub remote, else `null`. */
export function githubNewIssueUrl(gitUrl: string | undefined, title: string, body: string): string | null {
  if (gitUrl === undefined) return null;
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(gitUrl.trim());
  if (m === null) return null;
  const q = new URLSearchParams({ title: title.slice(0, 200), body: body.slice(0, 4000) });
  return `https://github.com/${m[1]}/${m[2]}/issues/new?${q.toString()}`;
}

/**
 * Crew's candidates, worded by the seat where its report says so. Crew decides WHICH recommendations (its top five
 * by impact) and their evidence; the seat may only retitle, describe the effect, say what would change its mind,
 * and LOWER the confidence. A report entry naming no recommended candidate is dropped.
 */
export function mergeReport(runId: string, facts: Facts, report: Record<string, unknown> | null): { summary: string | null; interpreted: boolean; recommendations: Recommendation[]; watching: Review['watching'] } {
  const byId = new Map(facts.candidates.map((c) => [c.id, c]));
  const words = new Map<string, Record<string, unknown>>();
  const entries = Array.isArray(report?.['recommendations']) ? (report['recommendations'] as unknown[]) : [];
  for (const e of entries) {
    if (typeof e !== 'object' || e === null) continue;
    const cand = (e as Record<string, unknown>)['candidate'];
    if (typeof cand === 'string' && facts.recommended.includes(cand) && !words.has(cand)) words.set(cand, e as Record<string, unknown>);
  }
  const summary = line(report?.['summary'], 1200);
  const interpreted = report !== null && summary !== null;
  const recommendations: Recommendation[] = facts.recommended.flatMap((cid) => {
    const c = byId.get(cid);
    if (c === undefined) return [];
    const w = words.get(cid);
    const asked = w?.['confidence'];
    const confidence: Confidence =
      (asked === 'high' || asked === 'medium' || asked === 'low') && CONFIDENCE_RANK[asked] < CONFIDENCE_RANK[c.confidence] ? asked : c.confidence;
    return [{
      id: `${runId}:${c.id}`,
      candidate: c.id,
      kind: c.kind,
      title: line(w?.['title'], 90) ?? c.title,
      evidence: c.evidence,
      expectedEffect: line(w?.['expectedEffect'], 300) ?? c.expectedEffect,
      confidence,
      changeMind: line(w?.['changeMind'], 300) ?? c.changeMind,
      impact: c.impact,
      basis: c.basis,
      action: c.action,
      state: 'new',
      reason: null,
      decidedAt: null,
      proposalId: null,
      proposalError: null,
    }];
  });
  const watching = facts.watching.flatMap((cid) => {
    const c = byId.get(cid);
    return c === undefined ? [] : [{ id: c.id, title: c.title, line: c.evidence.line }];
  });
  return { summary, interpreted, recommendations, watching };
}
