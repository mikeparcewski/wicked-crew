// TR-W4 (DES-TRIGGER-REGISTRY-001 §4.5, §9): the watch wire contract, published before any
// runtime. Each value below is typed against `wicked-crew-api-types`, so this file is a
// COMPILE-TIME assertion enforced by `tsc --noEmit -p tsconfig.test.json` (`npm run typecheck`).
// The shapes are the spec's own examples: the `watch_finding.raised` payload (§4.5), the `/ws`
// frame, one entry (§4.2), the health body and the coverage list (§4.7). The runtime `it` blocks
// only keep the guard visible in the test run (vitest does not typecheck).

import { describe, expect, it } from 'vitest';
import type {
  WatchBusEvent,
  WatchCoverage,
  WatchEntry,
  WatchEventFrame,
  WatchFeedResponse,
  WatchFinding,
  WatchFindingCleared,
  WatchHealth,
} from 'wicked-crew-api-types';

const raised: WatchFinding = {
  run_id: 'r-88',
  ord: 5,
  attempt: 1,
  by: 'watch:claim-vs-evidence@1',
  at: 1759300320000,
  re: 'repoChecksEvaluated#5:1',
  watch_id: 'w-1f00000000000000000000000000000a',
  entry_id: 'claim-vs-evidence',
  entry_version: 1,
  check: 'deterministic:claim_vs_evidence',
  kind: 'finding',
  severity: 'medium',
  watch_kind: 'problem',
  attach: null,
  project_id: 'kes',
  sentence: 'The error-states step handed back as finished; its own checks failed (lint).',
  facts: { arm: 'creator', failed_checks: ['lint'] },
  anchor: { run_id: 'r-88', ord: 5, attempt: 1, at: 1759299240000 },
  evidence: [{ kind: 'run_event', type: 'repoChecksEvaluated', ord: 5, attempt: 1 }],
  model: null,
  rolled_up: 0,
};

// A run-less finding (a bus-sourced or registry-internal flag) carries nulls, not absent keys.
const runless: WatchFinding = {
  ...raised,
  run_id: null,
  ord: null,
  attempt: null,
  re: 'wicked.team.plan.accepted#k',
  kind: 'flag',
  severity: 'info',
  watch_kind: 'quiet',
  attach: 'gate',
  anchor: null,
  model: { seat: 'codex', model: 'gpt-5', latency_ms: 812 },
};

const cleared: WatchFindingCleared = {
  run_id: 'r-88',
  ord: 5,
  attempt: 2,
  by: 'watch:claim-vs-evidence@1',
  at: 1759300420000,
  re: 'repoChecksEvaluated#5:2',
  watch_id: raised.watch_id,
  entry_id: 'claim-vs-evidence',
  entry_version: 1,
  reason: 'resolved',
  project_id: 'kes',
};

const dismissed: WatchFindingCleared = {
  ...cleared,
  reason: 'dismissed',
  dismissed_by: 'operator',
};

const rolledUp: WatchFindingCleared = { ...cleared, reason: 'rolled_up', replaced_by: 'w-2' };

const frame: WatchEventFrame = {
  type: 'watchEvent',
  event: {
    event_id: 42,
    event_type: 'wicked.crew.watch_finding.raised',
    payload: raised,
  },
  project_id: 'kes',
};

const clearFrame: WatchEventFrame = {
  type: 'watchEvent',
  event: { event_id: 43, event_type: 'wicked.crew.watch_finding.cleared', payload: dismissed },
};

/** The union discriminates on `event_type`: a cleared row's payload has no `sentence`. */
function sentenceOf(e: WatchBusEvent): string | null {
  return e.event_type === 'wicked.crew.watch_finding.raised' ? e.payload.sentence : null;
}

const entry: WatchEntry = {
  id: 'scope-drift',
  version: 1,
  on: { source: 'core', type: 'repoChecksEvaluated' },
  filter: { floor: 'creator' },
  check: 'deterministic:scope_drift',
  params: {},
  threshold: { min_paths: 1 },
  emit: {
    as: 'flag',
    severity: 'medium',
    watch_kind: 'problem',
    attach: null,
    rate: { per_run: 5 },
  },
  priority: 'p1',
  enabled: true,
  threshold_text: 'Speaks up when 1 or more files change outside the plan.',
};

const busEntry: WatchEntry = {
  ...entry,
  id: 'plan-scope',
  on: { source: 'bus', type: 'wicked.team.plan.accepted' },
  check: 'llm:gate-ask-vs-plan@1',
  emit: { as: 'proposal', severity: 'info', watch_kind: 'decision', attach: 'gate', rate: { per_run: 1 } },
  priority: 'p0',
};

const coverage: WatchCoverage[] = [
  { entry_id: 'scope-drift', state: 'not_checked', reason: 'no declared scope' },
  { entry_id: 'claim-vs-evidence', state: 'checked' },
];

const feed: WatchFeedResponse = { findings: [raised], coverage };

const health: WatchHealth = {
  armed: true,
  reason: null,
  sources: { bus: 'ok', core: 'ok', watchdog: 'ok' },
  queue: { depth: 0, hwm: 3, shed_by_priority: { p0: 0, p1: 0, p2: 0 } },
  tail_lag_ms: 120,
  emit: { failed: 0 },
  entries: {
    loaded: 7,
    refused: [{ id: 'bad-entry', reason: 'unknown check "deterministic:nope"' }],
    off: [{ id: 'scope-drift', by: 'operator', at: 1759300000000 }],
    thresholds_changed: [{ id: 'quiet-after-claim', by: 'operator', at: 1759300000000 }],
  },
  llm: { enabled: false, inflight: 0, timeouts: 0, skipped_no_seat: 0 },
  replay: { core_gap: false },
};

describe('watch wire contract (TR-W4)', () => {
  it('types the raised and cleared rows, the frame, an entry, coverage and health', () => {
    expect(sentenceOf(frame.event)).toBe(raised.sentence);
    expect(sentenceOf(clearFrame.event)).toBeNull();
    expect(runless.run_id).toBeNull();
    expect(rolledUp.replaced_by).toBe('w-2');
    expect(busEntry.on.source).toBe('bus');
    expect(feed.coverage?.[0]?.state).toBe('not_checked');
    expect(health.entries.refused).toHaveLength(1);
  });
});
