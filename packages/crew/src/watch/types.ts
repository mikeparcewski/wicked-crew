/**
 * The watch registry's internal shapes (DES-TRIGGER-REGISTRY-001 §4.2, §4.4). The wire shapes are
 * api-types' (`WatchFinding`, `WatchEntry`, …); these are what the runtime passes between its parts.
 */

import type { ZodType } from 'zod';
import type {
  WatchCoverage,
  WatchEmitAs,
  WatchEntrySource,
  WatchEvidenceRef,
  WatchKind,
  WatchPriority,
  WatchSeverity,
} from 'wicked-crew-api-types';

/** One registry entry as loaded from `watch/entries/<id>.json` (before the operator's overrides). */
export interface LoadedEntry {
  id: string;
  version: number;
  on: { source: WatchEntrySource; type: string };
  /**
   * TR-W5b: the key points the check JOINS to its trigger (DES §4.3 rows 1, 3, 5 — "joined to the
   * same unit's …"). Routed to the check unfiltered so it can fold them; only `on` triggers a row.
   * Absent = none.
   */
  join?: Array<{ source: Exclude<WatchEntrySource, 'internal'>; type: string }>;
  filter: Record<string, unknown>;
  check: string;
  params: Record<string, unknown>;
  threshold: Record<string, unknown>;
  emit: {
    as: WatchEmitAs;
    severity: WatchSeverity;
    watch_kind: WatchKind;
    attach: 'gate' | null;
    rate: { per_run: number };
  };
  priority: WatchPriority;
  enabled: boolean;
}

/** One key point, as a source hands it to the router. */
export interface KeyPointInput {
  source: WatchEntrySource;
  /** The CoreEvent `type`, the bus `event_type`, the watchdog frame `type`, or the internal tick name. */
  type: string;
  /** The event itself (a CoreEvent, a bus row, a watchdog frame, an internal tick). */
  event: Record<string, unknown>;
  /** The run it belongs to, `null` for run-less inputs. */
  runId: string | null;
  /** Unix millis of the source event (the anchor's `at`). */
  at: number;
  /** For a bus input: the source row's idempotency key (its `subject`). */
  busKey?: string;
  /** Set while the boot replay re-reads a live run's persisted events. */
  replay?: boolean;
}

/** Per-run state a check may fold into and read back. One bag per (run, entry). */
export interface RunWatchState {
  runId: string | null;
  /** Event types this run has shown the registry, for coverage ("the engine is too old" and the like). */
  seen: Set<string>;
  bag: Map<string, unknown>;
}

/** The registry's own numbers, for the internal checks (`registry-lagging`). */
export interface RegistryStats {
  queueDepth: number;
  queueHwm: number;
  shedTotal: number;
  tailLagMs: number;
}

/** What a check may know about a steering rule (TR-W6 `warned_rule`): never the whole store. */
export interface WatchRuleBrief {
  effect?: string | undefined;
  severity: string;
}

/** WT-W4: one run of a project as discovery sees it (DES-walkthrough-proof §4.13). */
export interface DiscoveryRun {
  run_id: string;
  /** What the run was launched as (`workflow_id`: a workflow, a preset or `plan`). */
  kind: string;
  /** Launch instant, epoch ms. */
  launched_at: number;
  /**
   * Catalog ids a PERSON put in the plan (`plan.proposed{by:"human"}` steps the PA's proposal did not
   * carry; floor-added never; PA additions never), less any an accepted override removed. Sorted.
   */
  human_added: string[];
  /** The newest `walkthrough_review` seal's `overall` (`PASS` | `FAIL` | …), `null` when none was recorded. */
  walkthrough: string | null;
  /** The QE verdict the acceptance gate attributes to the run's `test` step, `null` when none is. */
  test: string | null;
}

/** WT-W4: the project-level view the discovery checks count over. */
export interface DiscoverySnapshot {
  project_id: string;
  /** Oldest launch first. */
  runs: DiscoveryRun[];
  /** Runs of the project whose records could not be read (unknown, never "no"). */
  unreadable: number;
}

export interface CheckCtx {
  now(): number;
  stats(): RegistryStats;
  /**
   * TR-W6: the registry's bounded snapshot of the daemon's steering rules by id (refreshed on a
   * cadence, never per frame). Absent on a registry without a rule source; rejects when the store
   * cannot be read — a check treats both as "not classifiable", never as "no rule fired".
   */
  rules?: () => Promise<ReadonlyMap<string, WatchRuleBrief>>;
  /**
   * WT-W4: the project view discovery counts over, for the run's project (bounded, cached per
   * project by the registry). Absent on a registry without a source; `null` when the run belongs to
   * no project; rejects when the view cannot be read in time and no earlier view exists.
   */
  discovery?: (runId: string) => Promise<DiscoverySnapshot | null>;
}

/** What a check returns: a row to raise, or a raised row (by subject) that has resolved. */
export type CheckOutput =
  | {
      op: 'raise';
      /** Producer-assigned identity only (§4.5): `ord:attempt:<type>`, a bus key, a path, a rule id. */
      subject: string;
      sentence: string;
      facts?: Record<string, unknown>;
      ord?: number | null;
      attempt?: number | null;
      /** Overrides the entry's severity (a warned rule carries the rule's own). */
      severity?: WatchSeverity;
      /**
       * TR-W5b: overrides the entry's `emit.as` between `finding` and `flag` (one entry, several
       * arms: deliver-audit's unverified lift is a finding, its skipped lift a flag). Never a
       * proposal, never anything allow-like.
       */
      kind?: 'finding' | 'flag';
      re: string;
      evidence?: WatchEvidenceRef[];
      /**
       * TR-W6: set only when the row is for an EARLIER key point than the one being evaluated (a
       * frame a check kept and classified later): that key point's own time and replay provenance,
       * so the anchor is the source event's and a replayed row over the rate is still dropped.
       * Absent = the evaluated input's.
       */
      at?: number;
      replay?: boolean;
      /**
       * WT-W4: makes the row PROJECT-scoped instead of run-scoped — `run_id: null`, `anchor: null`,
       * `project_id` = this — so a fact about the project (a discovery proposal) is one row however
       * many of its runs re-derive it. The subject must then carry the project.
       */
      project?: string;
    }
  | { op: 'clear'; subject: string };

export interface WatchCheck<P = Record<string, unknown>, T = Record<string, unknown>> {
  /** `"deterministic:<name>"` (`"llm:<prompt-ref>@<n>"` lands with TR-W9). */
  name: string;
  lane: 'deterministic' | 'llm';
  paramsSchema: ZodType<P>;
  thresholdSchema: ZodType<T>;
  /** Pure over (input, the run's folded state); 0..n outputs. A throw is counted by the lane, never escapes. */
  evaluate(input: KeyPointInput, state: RunWatchState, params: P, threshold: T, ctx: CheckCtx): Promise<CheckOutput[]> | CheckOutput[];
  /** What this check can see on this run (G7). `null`: the check is run-less and has no run coverage. */
  coverage(state: RunWatchState): Omit<WatchCoverage, 'entry_id'> | null;
  /** The threshold in plain words, for "When Studio speaks up". */
  describe(threshold: T): string;
}
