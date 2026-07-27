// Unit tests: the evidence bundle assembler (src/api/evidence.ts).
//
// The endpoint test covers the happy path a stub run actually produces; these
// pin the derivation itself — council provenance, a DENIED unit, an unresolved
// unit that must NOT get a verdict, transcript-read failure, and the
// Content-Disposition filename, none of which a clean stub run exercises.

import { describe, expect, it } from 'vitest';
import { buildEvidenceBundle, evidenceEvents, evidenceFilename } from '../src/api/evidence.js';
import type { AgentSession, SessionView, WorkUnit } from '../src/core/types.js';

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

describe('evidenceEvents', () => {
  it('emits council routing provenance verbatim, before that unit’s gate decision', () => {
    const routing = { method: 'council', winner: 'alpha', agreement_pct: 80, returned: 2, dissent: 1 } as const;
    const events = evidenceEvents([unit(1, { routing })]);
    expect(events).toEqual([
      { type: 'routingDecided', unitId: 'run-1:u1', ord: 1, assignedCli: 'alpha', routing },
      { type: 'gateDecided', unitId: 'run-1:u1', ord: 1, allow: true, denialReason: null, phaseStatus: null, conformanceRef: null },
    ]);
  });

  it('records a denied gate with its reason and conformance ref', () => {
    const events = evidenceEvents([
      unit(1, { status: 'rejected', denial_reason: 'no verified evidence', conformance_ref: 'claim-9', phase_status: 'denied' }),
    ]);
    expect(events).toEqual([
      { type: 'gateDecided', unitId: 'run-1:u1', ord: 1, allow: false, denialReason: 'no verified evidence', phaseStatus: 'denied', conformanceRef: 'claim-9' },
    ]);
  });

  it('emits no gate decision for a unit whose gate has not resolved', () => {
    const events = evidenceEvents([unit(1, { status: 'pending' }), unit(2, { status: 'distributed' })]);
    expect(events).toEqual([]);
  });

  it('orders the trail by unit ord regardless of input order', () => {
    const events = evidenceEvents([unit(3), unit(1), unit(2)]);
    expect(events.map((e) => e.ord)).toEqual([1, 2, 3]);
  });
});

describe('buildEvidenceBundle', () => {
  const view: SessionView = { session: SESSION, units: [unit(2), unit(1)] };

  it('sorts units by ord and attaches each transcript', async () => {
    const seen: string[] = [];
    const bundle = await buildEvidenceBundle(view, (id) => {
      seen.push(id);
      return Promise.resolve(`transcript for ${id}`);
    });
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
    const bundle = await buildEvidenceBundle(odd, (id) => Promise.resolve(id));
    expect(bundle.units[0]?.transcript).toBe('run-1:u1');
  });

  it('reports a failed transcript read instead of failing the export or hiding the gap', async () => {
    const bundle = await buildEvidenceBundle(view, (id) =>
      id.endsWith('u2') ? Promise.reject(new Error('store closed')) : Promise.resolve('ok'),
    );
    expect(bundle.units[0]?.transcript).toBe('ok');
    expect(bundle.units[0]?.transcriptError).toBeUndefined();
    expect(bundle.units[1]?.transcript).toBeNull();
    expect(bundle.units[1]?.transcriptError).toBe('store closed');
  });

  it('distinguishes “no transcript captured” from a read failure', async () => {
    const bundle = await buildEvidenceBundle(view, () => Promise.resolve(null));
    expect(bundle.units.every((u) => u.transcript === null && u.transcriptError === undefined)).toBe(true);
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
