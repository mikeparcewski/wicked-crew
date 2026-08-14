// Unit tests: the evidence bundle assembler (src/api/evidence.ts).
//
// The endpoint test covers the happy path a stub run actually produces; these
// pin what a clean stub run does not reach — a transcript-read failure, an
// unreadable or absent event history, and the Content-Disposition filename.
//
// The `evidenceEvents` suite that used to live here is GONE with the function:
// the trail is no longer re-derived from unit records, it is read back from
// core's durable log (FINDING-014). Its inputs — `routing`, `assigned_cli`,
// `denial_reason`, `phase_status`, `conformance_ref` — are still asserted, on
// `bundle.units`, which is where they ride verbatim.

import { describe, expect, it } from 'vitest';
import { buildEvidenceBundle, evidenceFilename } from '../src/api/evidence.js';
import type { AgentSession, RecordedEvent, SessionView, WorkUnit } from '../src/core/types.js';

/** No recorded history, the common shape for the assembler tests that ignore it. */
const noEvents = () => Promise.resolve([] as RecordedEvent[]);

const SESSION: AgentSession = {
  id: 'run-1',
  workflow_id: 'feature',
  problem: 'Ship the thing',
  entity_mode: 'shared',
  collection_scope: null,
  clis: ['alpha', 'beta'],
  status: 'completed',
  human_confirm: 'none',
  unit_ix: 2,
  attempt: 0,
  workdir: null,
  repo_ref: null,
    extra_write_roots: [],
    archived_at: null,
    archive_note: null,
};

function unit(ord: number, over: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id: `run-1:u${ord}`,
    session_id: 'run-1',
    ord,
    description: `unit ${ord}`,
    stage: 'build',
    assigned_cli: 'alpha',
    assigned_invocation: 'alpha {PROMPT}',
    council_task_ref: null,
    routing: null,
    denial_reason: null,
    phase_ref: null,
    conformance_ref: null,
    phase_status: null,
    collection_scope: null,
    status: 'done',
    ...over,
  };
}

describe('buildEvidenceBundle', () => {
  const view: SessionView = { session: SESSION, units: [unit(2), unit(1)] };

  it('sorts units by ord and attaches each transcript', async () => {
    const seen: string[] = [];
    const bundle = await buildEvidenceBundle(
      view,
      (id) => {
        seen.push(id);
        return Promise.resolve(`transcript for ${id}`);
      },
      noEvents,
    );
    expect(bundle.units.map((u) => u.ord)).toEqual([1, 2]);
    expect(bundle.units.map((u) => u.transcript)).toEqual([
      'transcript for run-1:u1',
      'transcript for run-1:u2',
    ]);
    expect(seen.sort()).toEqual(['run-1:u1', 'run-1:u2']);
    expect(bundle.session).toBe(SESSION);
  });

  it('keeps a unit whose core id lacks the run prefix addressable', async () => {
    const odd: SessionView = { session: SESSION, units: [unit(1, { id: 'legacy-unit' })] };
    const bundle = await buildEvidenceBundle(odd, (id) => Promise.resolve(id), noEvents);
    expect(bundle.units[0]?.transcript).toBe('run-1:u1');
  });

  it('reports a failed transcript read instead of failing the export or hiding the gap', async () => {
    const bundle = await buildEvidenceBundle(
      view,
      (id) => (id.endsWith('u2') ? Promise.reject(new Error('store closed')) : Promise.resolve('ok')),
      noEvents,
    );
    expect(bundle.units[0]?.transcript).toBe('ok');
    expect(bundle.units[0]?.transcriptError).toBeUndefined();
    expect(bundle.units[1]?.transcript).toBeNull();
    expect(bundle.units[1]?.transcriptError).toBe('store closed');
  });

  it('distinguishes “no transcript captured” from a read failure', async () => {
    const bundle = await buildEvidenceBundle(view, () => Promise.resolve(null), noEvents);
    expect(bundle.units.every((u) => u.transcript === null && u.transcriptError === undefined)).toBe(true);
  });

  it('carries the routing and gate fields the derived trail used to restate', async () => {
    // These five were the ONLY inputs to the old `evidenceEvents`, so dropping it
    // loses nothing — but only while they keep riding on the units verbatim.
    const routing = { method: 'council', winner: 'alpha', agreement_pct: 80, returned: 2, dissent: 1 } as const;
    const denied: SessionView = {
      session: SESSION,
      units: [
        unit(1, { routing }),
        unit(2, { status: 'rejected', denial_reason: 'no verified evidence', conformance_ref: 'claim-9', phase_status: 'denied' }),
      ],
    };
    const bundle = await buildEvidenceBundle(denied, () => Promise.resolve(null), noEvents);
    expect(bundle.units[0]).toMatchObject({ routing, assigned_cli: 'alpha' });
    expect(bundle.units[1]).toMatchObject({
      status: 'rejected',
      denial_reason: 'no verified evidence',
      phase_status: 'denied',
      conformance_ref: 'claim-9',
    });
  });
});

describe('buildEvidenceBundle — the recorded event trail (FINDING-014)', () => {
  const view: SessionView = { session: SESSION, units: [unit(1)] };
  const frame = (seq: number, type: string): RecordedEvent => ({ type, ts: 1_700_000_000_000 + seq, seq });

  it('carries core’s recorded history verbatim, in recorded order', async () => {
    // Verbatim is the point: the bundle must describe the run in the same words
    // the operator watched it happen in, including the frames a re-derivation
    // could not have known about at all.
    const recorded = [
      frame(1, 'sessionStarted'),
      frame(2, 'councilVoted'),
      frame(3, 'acpFallback'),
      frame(4, 'gateEvaluated'),
      frame(5, 'gateDecided'),
    ];
    const bundle = await buildEvidenceBundle(view, () => Promise.resolve(null), () => Promise.resolve(recorded));
    expect(bundle.events).toEqual(recorded);
    expect(bundle.eventsUnavailable).toBeUndefined();
  });

  it('reads the history for the run being exported, not any other run', async () => {
    // The export is per-run; asking with the wrong id is how one run's bundle
    // would come to carry another's trail.
    const asked: string[] = [];
    await buildEvidenceBundle(view, () => Promise.resolve(null), (runId) => {
      asked.push(runId);
      return Promise.resolve([frame(1, 'sessionStarted')]);
    });
    expect(asked).toEqual(['run-1']);
  });

  it('says WHY an empty trail is empty rather than implying the run decided nothing', async () => {
    const bundle = await buildEvidenceBundle(view, () => Promise.resolve(null), noEvents);
    expect(bundle.events).toEqual([]);
    expect(bundle.eventsUnavailable).toMatch(/recorded no events/);
    expect(bundle.eventsUnavailable).toMatch(/not a run that made no decisions/);
  });

  it('reports a failed read distinctly from a run with no recorded history', async () => {
    // Both end in `events: []`. An operator problem and a fact about the run must
    // never read the same — the same posture `transcriptError` takes per unit.
    const bundle = await buildEvidenceBundle(view, () => Promise.resolve(null), () =>
      Promise.reject(new Error('event log unreadable')),
    );
    expect(bundle.events).toEqual([]);
    expect(bundle.eventsUnavailable).toContain('event log unreadable');
    expect(bundle.eventsUnavailable).not.toMatch(/recorded no events/);
  });

  it('does not fail the whole export when the history cannot be read', async () => {
    // A partial bundle that names its gap beats no bundle at all.
    const bundle = await buildEvidenceBundle(view, () => Promise.resolve('t'), () =>
      Promise.reject(new Error('boom')),
    );
    expect(bundle.units[0]?.transcript).toBe('t');
    expect(bundle.session).toBe(SESSION);
  });
});

describe('evidenceFilename', () => {
  it('names the download after the run', () => {
    expect(evidenceFilename('run-1')).toBe('run-1-evidence.json');
    expect(evidenceFilename('a.b_c-1')).toBe('a.b_c-1-evidence.json');
  });

  it('folds characters that could break out of the Content-Disposition header', () => {
    expect(evidenceFilename('a"b\r\nX-Evil: 1')).toBe('a_b__X-Evil__1-evidence.json');
    expect(evidenceFilename('../../etc/passwd')).toBe('.._.._etc_passwd-evidence.json');
  });

  it('never yields a bare “-evidence.json” for an empty id', () => {
    expect(evidenceFilename('')).toBe('run-evidence.json');
  });

  it('caps a pathological run id so the header stays bounded', () => {
    expect(evidenceFilename('x'.repeat(500))).toBe(`${'x'.repeat(128)}-evidence.json`);
  });
});

describe('parseAssumptions (external-transform convention)', () => {
  it('parses known and needs-research markers with the run ord', async () => {
    const { parseAssumptions } = await import('../src/api/evidence.js');
    const t =
      'work done\n' +
      'ASSUMPTION[external-transform] library=libpostal transform=address normalization confidence=known :: expands abbreviations per locale\n' +
      'ASSUMPTION[external-transform] library=stripe-tax transform=tax enrichment confidence=needs-research :: rounding rules unverified\n';
    const got = parseAssumptions(3, t);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ ord: 3, library: 'libpostal', known: true });
    expect(got[1]).toMatchObject({ library: 'stripe-tax', known: false });
    expect(got[1]!.detail).toContain('unverified');
  });

  it('malformed markers become needs-review placeholders, never silence', async () => {
    const { parseAssumptions } = await import('../src/api/evidence.js');
    const got = parseAssumptions(1, 'ASSUMPTION[external-transform] libpostal does stuff');
    expect(got).toHaveLength(1);
    expect(got[0]!.known).toBe(false);
    expect(got[0]!.detail).toContain('malformed marker');
    expect(parseAssumptions(1, null)).toHaveLength(0);
  });
});
