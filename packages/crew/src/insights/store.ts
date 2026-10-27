/**
 * The review history (DES-RUNS-REVIEW-001 §6): every review, its numbers, its recommendations and what happened
 * to each. One JSON file in the state home, `daemon-insights.json` (the `daemon-` prefix the state-home fence
 * already classifies), written atomically. A malformed file starts empty and never fails the boot.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crewStateHome } from '../projects/state-home.js';
import type { Candidate, Confidence, Finding, MetricId, RecommendationKind, SampleStat, Window } from './analyze.js';
import type { Verdict } from './stats.js';

export const INSIGHTS_FILENAME = 'daemon-insights.json';
/** Reviews kept (about four months at the default cadence). */
export const MAX_REVIEWS = 60;

export type ReviewStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type RecommendationState = 'new' | 'accepted' | 'dismissed';

export interface Recommendation {
  /** `<review run id>:<candidate id>`: unique across the history. */
  id: string;
  candidate: string;
  kind: RecommendationKind;
  title: string;
  evidence: Candidate['evidence'];
  expectedEffect: string;
  confidence: Confidence;
  changeMind: string;
  impact: number;
  basis: Candidate['basis'];
  action: Candidate['action'];
  state: RecommendationState;
  reason: string | null;
  decidedAt: string | null;
  /** The approve-queue proposal filed for a steering-rule or memory recommendation. */
  proposalId: string | null;
  proposalError: string | null;
}

export interface SeriesPoint {
  metric: MetricId;
  window: SampleStat;
  baseline: SampleStat;
  verdict: Verdict;
}

export interface Review {
  runId: string;
  trigger: 'schedule' | 'manual';
  scheduleId: string | null;
  launchedAt: string;
  endedAt: string | null;
  status: ReviewStatus;
  window: Window;
  baselineWindows: Window[];
  projectIds: string[];
  /** The seat's plain-language summary; `null` when the run wrote no usable report. */
  summary: string | null;
  /** Whether the seat's report was read (false = crew's own wording is shown, labelled "not interpreted"). */
  interpreted: boolean;
  totals: Record<string, number> | null;
  /** The `all` segment's metrics: the trend lines. */
  series: SeriesPoint[];
  improvements: Pick<Finding, 'metric' | 'segment' | 'line'>[];
  regressions: Pick<Finding, 'metric' | 'segment' | 'line'>[];
  recommendations: Recommendation[];
  watching: { id: string; title: string; line: string }[];
  error: string | null;
}

export function defaultInsightsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_INSIGHTS'] ?? join(crewStateHome(), INSIGHTS_FILENAME);
}

export class InsightsStore {
  private readonly path: string;
  private reviews: Review[] = [];

  constructor(path?: string) {
    this.path = path ?? defaultInsightsPath();
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { reviews?: unknown };
      if (Array.isArray(parsed?.reviews)) {
        this.reviews = parsed.reviews.filter(
          (r): r is Review => typeof r === 'object' && r !== null && typeof (r as Review).runId === 'string' && Array.isArray((r as Review).recommendations),
        );
      }
    } catch {
      // Missing or malformed: no history yet.
    }
  }

  /** Newest first. */
  list(): Review[] {
    return [...this.reviews].sort((a, b) => b.launchedAt.localeCompare(a.launchedAt));
  }

  get(runId: string): Review | undefined {
    return this.reviews.find((r) => r.runId === runId);
  }

  /** The latest review that finished with numbers: the next window starts where its window ended. */
  lastCompleted(): Review | undefined {
    return this.list().find((r) => r.status === 'completed');
  }

  running(): Review[] {
    return this.reviews.filter((r) => r.status === 'running');
  }

  add(review: Review): void {
    this.reviews = [review, ...this.reviews.filter((r) => r.runId !== review.runId)];
    this.reviews = this.list().slice(0, MAX_REVIEWS);
    this.persist();
  }

  update(runId: string, patch: Partial<Omit<Review, 'runId'>>): Review | undefined {
    const i = this.reviews.findIndex((r) => r.runId === runId);
    if (i < 0) return undefined;
    const next = { ...(this.reviews[i] as Review), ...patch };
    this.reviews[i] = next;
    this.persist();
    return next;
  }

  findRecommendation(id: string): { review: Review; rec: Recommendation } | undefined {
    for (const review of this.reviews) {
      const rec = review.recommendations.find((r) => r.id === id);
      if (rec !== undefined) return { review, rec };
    }
    return undefined;
  }

  updateRecommendation(id: string, patch: Partial<Omit<Recommendation, 'id'>>): Recommendation | undefined {
    const found = this.findRecommendation(id);
    if (found === undefined) return undefined;
    const next = { ...found.rec, ...patch };
    found.review.recommendations = found.review.recommendations.map((r) => (r.id === id ? next : r));
    this.persist();
    return next;
  }

  /** Recommendations nobody has decided yet, across the history. */
  newCount(): number {
    return this.reviews.reduce((a, r) => a + r.recommendations.filter((x) => x.state === 'new').length, 0);
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, reviews: this.reviews }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}
