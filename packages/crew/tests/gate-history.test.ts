// GET /gates/decided — the decided-gate history a skin reads for a seat's track record on a step
// (brainstorm-actionable idea 7) and for the "make it a rule" offer and its preview (idea 8).
//
// Over the REAL server assembly (createServer) on a stub engine: the history is the daemon's own
// `gate.decided` audit lines, joined to the engine's gate rows (the gate's kind and what it
// reviewed) and to the run (its project, its accepted plan band, the seat that created the work).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DecidedGatesResponse } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { removeScratch } from './setup/scratch.js';

type U = { phase: string; cli: string | null; role?: string };

function view(id: string, projectId: string | null, band: string | null, units: U[], workflowId = 'feature') {
  return {
    session: {
      id, workflow_id: workflowId, problem: `work ${id}`, entity_mode: 'shared', collection_scope: null,
      clis: ['claude', 'codex'], status: 'completed', human_confirm: 'all', unit_ix: 0, attempt: 0, workdir: null,
      repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null, project_id: projectId,
      ...(band !== null ? { team_plan: { rev: 1, accepted_rev: 1, accepted: { rev: 1, by: 'engine', band, high_risk: false } } } : {}),
    },
    units: units.map((u, ord) => ({
      id: `${id}:${ord}`, ord, phase_ref: u.phase, assigned_cli: u.cli, status: 'done', stage: 'build',
      ...(u.role !== undefined ? { role: u.role } : {}),
    })),
  };
}

const UNITS: U[] = [
  { phase: 'understand', cli: 'claude' },
  { phase: 'build', cli: 'claude', role: 'creator' },
  { phase: 'review', cli: 'codex', role: 'evaluator' },
  { phase: 'deliver', cli: null },
];

const DAY = 86_400_000;
const NOW = Date.now();
const HUMAN = { id: 'local', kind: 'human', trust: 'admin' };

let scratch: string;
let app: FastifyInstance;

function stubAdapter(): CoreAdapter {
  const views = [
    view('run-1', 'P', '0-19', UNITS),
    view('run-2', 'P', '0-19', [UNITS[0]!, { phase: 'build', cli: 'codex', role: 'creator' }, UNITS[2]!, UNITS[3]!]),
    view('run-3', 'Q', '40-69', UNITS),
  ];
  // The engine's gate rows, every status (the history reads answered ones).
  const rows = [
    { id: 'ir1', session_id: 'run-1', kind: 'gate', ord: 2, reviewing_ord: 1, gate_kind: 'def', status: 'answered' },
    { id: 'ir2', session_id: 'run-1', kind: 'gate', ord: 3, reviewing_ord: 2, gate_kind: 'deliver', status: 'answered' },
    { id: 'ir3', session_id: 'run-2', kind: 'gate', ord: 2, reviewing_ord: 1, gate_kind: 'def', status: 'answered' },
    { id: 'ir4', session_id: 'run-3', kind: 'gate', ord: 2, reviewing_ord: 1, gate_kind: 'def', status: 'answered' },
  ];
  return {
    stub: true,
    projectsSupported: () => false,
    getSettings: async () => ({}),
    onLaunch: (): (() => void) => () => undefined,
    onEvent: () => () => undefined,
    sessionsDetail: async () => views,
    listRepos: async () => [],
    interactionRequests: async (runId?: string) => rows.filter((r) => runId === undefined || r.session_id === runId),
    runEvents: async () => null,
    confirmGate: async () => 'executing',
  } as unknown as CoreAdapter;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-gate-history-'));
  const line = (ts: number, runId: string, actor: object, detail: object) =>
    JSON.stringify({ ts, action: 'gate.decided', actor, runId, detail });
  writeFileSync(
    join(scratch, 'audit.log'),
    [
      line(NOW - 40 * DAY, 'run-1', HUMAN, { approve: true, ord: 2, status: 'executing' }), // outside the window
      // No engine row for this gate (codex on #691): its kind and reviewed unit are unknown.
      line(NOW - 5 * DAY, 'run-2', HUMAN, { approve: true, ord: 3, status: 'executing' }),
      line(NOW - 3 * DAY, 'run-1', HUMAN, { approve: true, ord: 2, status: 'executing' }),
      line(NOW - 3 * DAY + 1000, 'run-1', HUMAN, { approve: true, ord: 3, status: 'executing' }),
      line(NOW - 2 * DAY, 'run-2', HUMAN, { approve: false, action: 'request_changes', amend: 'fix it', ord: 2, status: 'executing' }),
      line(NOW - 1 * DAY, 'run-3', { id: 'standing-order:abc', kind: 'system', trust: 'operator' }, {
        approve: true, ord: 2, standingOrder: { id: 'abc', text: 'always approve' }, status: 'executing',
      }),
      JSON.stringify({ ts: NOW - DAY, action: 'run.launched', actor: HUMAN, runId: 'run-3', detail: {} }),
    ].join('\n') + '\n',
  );
  app = await createServer(stubAdapter(), {
    auth: { mode: 'off' },
    auditPath: join(scratch, 'audit.log'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
    studioRoot: join(scratch, 'no-studio'),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  removeScratch(scratch);
});

describe('GET /gates/decided', () => {
  it('lists the decided gates since the clock, newest first, each with its kind, phase, project, band and creator seat', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/gates/decided?since=${NOW - 30 * DAY}` });
    expect(res.statusCode).toBe(200);
    const { gates } = res.json() as DecidedGatesResponse;
    expect(gates.map((g) => `${g.runId}:${g.ord}`)).toEqual(['run-3:2', 'run-2:2', 'run-1:3', 'run-1:2', 'run-2:3']);
    const [r3, r2, deliver, r1, unknown] = gates;
    expect(unknown).toMatchObject({ gateKind: null, phase: null, orderApprovable: false, projectId: 'P' });
    expect(r1).toEqual({
      runId: 'run-1', ord: 2, decidedAt: NOW - 3 * DAY, decision: 'approve', actor: 'local', byOrder: false,
      gateKind: 'def', phase: 'build', projectId: 'P', band: '0-19',
      creator: { seat: 'claude', phase: 'build', ord: 1 }, orderApprovable: true,
    });
    // The deliver gate is never an order's to approve (the crew invariant), whatever it reviewed.
    expect(deliver).toMatchObject({ gateKind: 'deliver', decision: 'approve', orderApprovable: false, creator: { seat: 'claude' } });
    // A different creator seat, and a send-back.
    expect(r2).toMatchObject({ decision: 'request_changes', creator: { seat: 'codex', phase: 'build' }, byOrder: false });
    // A standing order's approval is named as one.
    expect(r3).toMatchObject({ actor: 'standing-order:abc', byOrder: true, projectId: 'Q', band: '40-69' });
  });

  it('refuses a malformed clock', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/gates/decided?since=yesterday' });
    expect(res.statusCode).toBe(400);
  });
});
