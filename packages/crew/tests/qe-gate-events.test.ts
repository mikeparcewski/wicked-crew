// The QeGateCache fold — the in-memory half of the opt-in bus seam (Phase 6a).
//
// The cache is a freshness signal, never the system of record: the ledger decides the gate. What
// this pins is the fold's honesty about the wire contract (the old wicked-testing gate.mjs shape,
// unrenamed): the 8 canonical gate fields survive intact, the deploy signal never SHADOWS the gate
// result it travels with, and frames that are not qe gate/deploy events — or are missing run_id —
// are ignored rather than half-cached.

import { describe, expect, it } from 'vitest';
import { QeGateCache, QE_BUS_FILTER, QE_GATE_EVENT_TYPES } from '../src/qe/gate-events.js';

/** The 8-field canonical gate payload (REQ-003 §4.2), as gate.mjs emits it. */
function gatePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'qe-run-1',
    context: 'project-1',
    gate_verdict: 'PASS',
    exit_code: 0,
    verdict_summary: 'all green',
    mode: 'gate',
    completed_at: '2026-08-12T03:00:00Z',
    scenario_count: 3,
    ...overrides,
  };
}

describe('QeGateCache', () => {
  it('folds the canonical gate payload, all 8 fields intact', () => {
    const cache = new QeGateCache();
    expect(cache.ingest('wicked.qe.gate.passed', gatePayload(), '2026-08-12T03:00:01Z')).toBe(true);
    expect(cache.forRun('qe-run-1')).toEqual({
      eventType: 'wicked.qe.gate.passed',
      runId: 'qe-run-1',
      context: 'project-1',
      gateVerdict: 'PASS',
      exitCode: 0,
      verdictSummary: 'all green',
      mode: 'gate',
      completedAt: '2026-08-12T03:00:00Z',
      scenarioCount: 3,
      observedAt: '2026-08-12T03:00:01Z',
    });
    expect(cache.forContext('project-1')?.runId).toBe('qe-run-1');
    expect(cache.latest()?.runId).toBe('qe-run-1');
  });

  it('accepts all three gate outcomes', () => {
    const cache = new QeGateCache();
    for (const [i, type] of QE_GATE_EVENT_TYPES.entries()) {
      expect(cache.ingest(type, gatePayload({ run_id: `r-${i}` }))).toBe(true);
    }
    expect(cache.size()).toBe(3);
  });

  it('caches the deploy signal but never lets it shadow the gate result it travels with', () => {
    const cache = new QeGateCache();
    cache.ingest('wicked.qe.gate.passed', gatePayload());
    // gate.mjs emits deploy.completed alongside the PASS, same run — arriving second.
    cache.ingest('wicked.qe.deploy.completed', { run_id: 'qe-run-1', project_id: 'project-1' });
    const entry = cache.forRun('qe-run-1');
    expect(entry?.eventType, 'the verdict-carrying frame must win the run slot').toBe(
      'wicked.qe.gate.passed',
    );
    expect(entry?.gateVerdict).toBe('PASS');
    // …while latest() honestly reports what was seen last.
    expect(cache.latest()?.eventType).toBe('wicked.qe.deploy.completed');
  });

  it('fills the run slot from a lone deploy signal (cursor_init latest can catch the tail of a pair)', () => {
    const cache = new QeGateCache();
    cache.ingest('wicked.qe.deploy.completed', { run_id: 'qe-run-2', project_id: 'project-2' });
    expect(cache.forRun('qe-run-2')).toMatchObject({
      eventType: 'wicked.qe.deploy.completed',
      context: 'project-2',
      gateVerdict: null,
    });
  });

  it('replaces an older result for the same run (idempotent under at-least-once redelivery)', () => {
    const cache = new QeGateCache();
    cache.ingest('wicked.qe.gate.failed', gatePayload({ gate_verdict: 'FAIL', exit_code: 1 }));
    cache.ingest('wicked.qe.gate.passed', gatePayload());
    expect(cache.forRun('qe-run-1')?.gateVerdict).toBe('PASS');
    expect(cache.size()).toBe(1);
  });

  it('ignores non-qe frames and malformed payloads', () => {
    const cache = new QeGateCache();
    expect(cache.ingest('wicked.test.verdict.created', gatePayload())).toBe(false);
    expect(cache.ingest('wicked.qe.gate.passed', 'not-an-object')).toBe(false);
    expect(cache.ingest('wicked.qe.gate.passed', gatePayload({ run_id: undefined }))).toBe(false);
    expect(cache.size()).toBe(0);
    expect(cache.latest()).toBeUndefined();
  });

  it('subscribes with a filter that covers both event families', () => {
    // `prefix.**` = one or more remaining segments in wicked-bus grammar — one
    // durable cursor for wicked.qe.gate.* AND wicked.qe.deploy.completed.
    expect(QE_BUS_FILTER).toBe('wicked.qe.**');
  });
});
