// The steering-author LANDING at the gate (crew#388) — route behavior over a stubbed adapter.
//
// The defect this pins against: the doctrine said "approved rules land via the rules CRUD with
// provenance.source 'chat' — the run itself writes nothing", and NOTHING performed that write.
// POST /runs/:id/gate confirmed the gate and stopped; every chat-authored rule ever approved was
// silently lost (campaign 2026-09-01 scenario C5, run f3db4335). These tests pin the contract the
// gate route now owes:
//
//  - APPROVE of a steering-author propose gate LANDS the proposal: the store write happens
//    (upsertConformanceRule, chat provenance forced), the response carries `landing`, and the
//    audit trail records `governance.rule.upserted` per rule.
//  - The proposal is read MACHINE-READABLY first (the propose phase's proposed-rules.json in the
//    run's steering inbox); the stored transcript is the fallback.
//  - IDEMPOTENT: a replayed approve finds the durable marker and re-lands nothing.
//  - FAIL-LOUD: an unparseable proposal still approves the RUN but answers an explicit
//    `landing.outcome: "failed"` + `governance.steering.landing_failed` — never a silent no-op.
//  - A REJECT lands nothing. An AMEND-approve lands the proposal UNCHANGED (the amend steers the
//    run, not the rule). A gated /resume lands too (no side door). Non-steering gates untouched.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { steeringInboxDir } from '../src/api/governance-steering.js';
import { steeringProposalPath } from '../src/api/steering-landing.js';
import type { ConformanceRule, SessionView } from '../src/core/types.js';

let dir: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let priorInboxDir: string | undefined;

/** Mutable per-case state the stubbed adapter answers from. */
let views: SessionView[] = [];
let upserted: ConformanceRule[] = [];
let confirmCalls: { runId: string; approve: boolean; amend?: string }[] = [];
let transcript: string | null = null;
let transcriptReads: string[] = [];

const PROBLEM =
  "Author steering rules for the 'operations' steering type (use it as the default steering_type for every proposed rule without a better fit).\n\nOperator intent:\nnever deploy on friday";

const PROPOSAL = [
  {
    id: 'POL-0001',
    rule_type: 'policy',
    statement: 'never deploy on friday',
    severity: 'error',
    confidence: 0.9,
    targets: {},
    provenance: { source: 'chat', source_kinds: [] },
    steering_type: 'operations',
  },
];

/** A steering-author run parked at its propose gate (TH-12: the phase RAN, then paused). */
function steeringRun(id: string): SessionView {
  return {
    session: {
      id,
      workflow_id: 'steering-author',
      problem: PROBLEM,
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['claude'],
      status: 'awaiting_human',
      human_confirm: 'none',
      unit_ix: 2,
      attempt: 1,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [steeringInboxDir(id)],
      archived_at: null,
      archive_note: null,
    },
    units: [
      { id: `${id}:analyze`, ord: 1, session_id: id, status: 'done' },
      { id: `${id}:propose`, ord: 2, session_id: id, status: 'distributed' },
    ],
  } as unknown as SessionView;
}

/** A legacy human-gated run of another workflow — the regression control. */
function featureRun(id: string): SessionView {
  const v = steeringRun(id);
  v.session.workflow_id = 'feature';
  v.units = [
    { id: `${id}:clarify`, ord: 1, session_id: id, status: 'distributed' },
  ] as unknown as SessionView['units'];
  return v;
}

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function auditEntries(runId: string, action: string): Promise<Record<string, unknown>[]> {
  const { body } = await send('GET', `/audit?runId=${runId}&action=${action}`);
  return body['entries'] as Record<string, unknown>[];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'steering-gate-landing-'));
  priorInboxDir = process.env['WICKED_STEERING_INBOX_DIR'];
  process.env['WICKED_STEERING_INBOX_DIR'] = join(dir, 'inbox');

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapter.sessionsDetail = async () => views;
  adapter.sessions = async () => views.map((v) => v.session.id);
  adapter.steeringSupported = () => true;
  adapter.confirmGate = async (runId: string, approve: boolean, amend?: string) => {
    confirmCalls.push({ runId, approve, ...(amend !== undefined ? { amend } : {}) });
    const run = views.find((v) => v.session.id === runId);
    if (run) run.session.status = approve ? 'completed' : 'cancelled';
    return approve ? 'completed' : 'cancelled';
  };
  adapter.upsertConformanceRule = async (rule: ConformanceRule) => {
    upserted.push(rule);
  };
  adapter.listConformanceRules = async () => upserted;
  adapter.workOutput = async (unitId: string) => {
    transcriptReads.push(unitId);
    return transcript;
  };
  // Durable interaction rows: none — gate reads fall through to the event log in these tests.
  adapter.interactionRequests = async () => [];
  adapter.runEvents = async () => [];

  app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

beforeEach(() => {
  views = [];
  upserted = [];
  confirmCalls = [];
  transcript = null;
  transcriptReads = [];
});

afterAll(async () => {
  await app.close();
  adapter.close();
  if (priorInboxDir === undefined) delete process.env['WICKED_STEERING_INBOX_DIR'];
  else process.env['WICKED_STEERING_INBOX_DIR'] = priorInboxDir;
  rmSync(dir, { recursive: true, force: true });
});

/** Land the proposal file the propose phase writes (the machine-readable primary source). */
function writeProposalFile(runId: string, content: string = JSON.stringify(PROPOSAL)): void {
  mkdirSync(steeringInboxDir(runId), { recursive: true });
  writeFileSync(steeringProposalPath(runId), content, 'utf8');
}

describe('POST /runs/:id/gate on a steering-author propose gate (crew#388)', () => {
  it('APPROVE lands the proposal: store write + landing field + per-rule audit — and the store GET proves it', async () => {
    const RUN = 'land-approve-1';
    views = [steeringRun(RUN)];
    writeProposalFile(RUN);

    const { status, body } = await send('POST', `/runs/${RUN}/gate`, { approve: true });
    expect(status).toBe(200);
    expect(body['status']).toBe('completed');
    expect(body['landing']).toMatchObject({
      outcome: 'landed',
      ruleIds: ['POL-0001'],
      source: 'deliverable',
    });

    // The store write happened, chat provenance forced — the doctrine's exact promise.
    expect(upserted).toHaveLength(1);
    expect(upserted[0]!.id).toBe('POL-0001');
    expect(upserted[0]!.provenance.source).toBe('chat');

    // The store GET proves it (what the studio's Steering page reloads).
    const rules = await send('GET', '/governance/rules');
    expect(rules.status).toBe(200);
    const listed = rules.body['rules'] as ConformanceRule[];
    expect(listed.some((r) => r.id === 'POL-0001' && r.provenance.source === 'chat')).toBe(true);

    // AUDITABLE: governance.rule.upserted with the chat provenance + the run id.
    const entries = await auditEntries(RUN, 'governance.rule.upserted');
    expect(entries).toHaveLength(1);
    expect(entries[0]!['detail']).toMatchObject({
      id: 'POL-0001',
      source: 'chat',
      via: 'steering-author',
    });
  });

  it('IDEMPOTENT: a replayed approve finds the marker and re-lands nothing', async () => {
    const RUN = 'land-replay-1';
    views = [steeringRun(RUN)];
    writeProposalFile(RUN);

    const first = await send('POST', `/runs/${RUN}/gate`, { approve: true });
    expect((first.body['landing'] as Record<string, unknown>)['outcome']).toBe('landed');
    expect(upserted).toHaveLength(1);

    // Simulate the replay window (daemon restarted mid-request / double-driven gate): the run
    // reads as awaiting_human again, the approve is re-posted.
    views = [steeringRun(RUN)];
    const second = await send('POST', `/runs/${RUN}/gate`, { approve: true });
    expect(second.status).toBe(200);
    expect(second.body['landing']).toMatchObject({
      outcome: 'landed',
      ruleIds: ['POL-0001'],
      alreadyLanded: true,
    });
    // Landed ONCE: the store took exactly one write, and the audit shows exactly one upsert.
    expect(upserted).toHaveLength(1);
    expect(await auditEntries(RUN, 'governance.rule.upserted')).toHaveLength(1);
  });

  it('a re-post against a run that already moved on stays a 409 (the standing guard)', async () => {
    const RUN = 'land-409-1';
    const run = steeringRun(RUN);
    run.session.status = 'completed';
    views = [run];
    const { status } = await send('POST', `/runs/${RUN}/gate`, { approve: true });
    expect(status).toBe(409);
    expect(upserted).toHaveLength(0);
  });

  it('FAIL-LOUD: an unparseable proposal approves the RUN but answers an explicit landing failure', async () => {
    const RUN = 'land-loud-1';
    views = [steeringRun(RUN)];
    // No proposal file; the stored transcript is prose with no JSON array anywhere.
    transcript = 'I analyzed the handbook and propose codifying the deploy freeze, details above.';

    const { status, body } = await send('POST', `/runs/${RUN}/gate`, { approve: true });
    // The approve itself SUCCEEDS for the run — the gate decision already happened.
    expect(status).toBe(200);
    expect(body['status']).toBe('completed');
    // ...but the landing is loudly failed, with an operator-readable reason. Never a no-op.
    const landing = body['landing'] as Record<string, unknown>;
    expect(landing['outcome']).toBe('failed');
    expect(landing['ruleIds']).toEqual([]);
    expect(String(landing['error'])).toMatch(/could not be parsed/);
    expect(upserted).toHaveLength(0);
    // The transcript WAS consulted (the fallback ran) — read for the propose unit.
    expect(transcriptReads).toContain(`${RUN}:propose`);
    // And the audit trail carries the failure.
    const entries = await auditEntries(RUN, 'governance.steering.landing_failed');
    expect(entries).toHaveLength(1);
    expect(String((entries[0]!['detail'] as Record<string, unknown>)['error'])).toMatch(
      /could not be parsed/,
    );
  });

  it('falls back to the stored transcript when the proposal file is missing', async () => {
    const RUN = 'land-transcript-1';
    views = [steeringRun(RUN)];
    transcript = `Proposal:\n\`\`\`json\n${JSON.stringify(PROPOSAL)}\n\`\`\`\n`;

    const { body } = await send('POST', `/runs/${RUN}/gate`, { approve: true });
    expect(body['landing']).toMatchObject({
      outcome: 'landed',
      ruleIds: ['POL-0001'],
      source: 'transcript',
    });
    expect(upserted).toHaveLength(1);
  });

  it('REJECT lands nothing — the proposal stays an artifact', async () => {
    const RUN = 'land-reject-1';
    views = [steeringRun(RUN)];
    writeProposalFile(RUN);

    const { status, body } = await send('POST', `/runs/${RUN}/gate`, { approve: false });
    expect(status).toBe(200);
    expect(body['status']).toBe('cancelled');
    expect('landing' in body).toBe(false);
    expect(upserted).toHaveLength(0);
  });

  it('AMEND-approve lands the proposal UNCHANGED — the amend steers the run, not the rule', async () => {
    const RUN = 'land-amend-1';
    views = [steeringRun(RUN)];
    writeProposalFile(RUN);

    const { body } = await send('POST', `/runs/${RUN}/gate`, {
      approve: true,
      amend: 'also mention the change-freeze calendar next time',
    });
    expect((body['landing'] as Record<string, unknown>)['outcome']).toBe('landed');
    // The amend reached the ENGINE (it steers the run's continuation)...
    expect(confirmCalls).toEqual([
      { runId: RUN, approve: true, amend: 'also mention the change-freeze calendar next time' },
    ]);
    // ...and the landed rule is byte-for-byte the proposal, not the note.
    expect(upserted).toHaveLength(1);
    expect(upserted[0]!.statement).toBe('never deploy on friday');
  });

  it('a missing steering_type lands with the type the run was authored for (problem preamble)', async () => {
    const RUN = 'land-type-1';
    views = [steeringRun(RUN)];
    const untyped = [{ ...PROPOSAL[0], steering_type: undefined }];
    writeProposalFile(RUN, JSON.stringify(untyped));

    await send('POST', `/runs/${RUN}/gate`, { approve: true });
    expect(upserted).toHaveLength(1);
    expect((upserted[0] as unknown as Record<string, unknown>)['steering_type']).toBe('operations');
  });

  it('legacy non-steering-author gates are untouched: no landing field, no store write', async () => {
    const RUN = 'land-legacy-1';
    views = [featureRun(RUN)];
    writeProposalFile(RUN); // even a stray file must not tempt the legacy path

    const { status, body } = await send('POST', `/runs/${RUN}/gate`, { approve: true });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'completed' });
    expect(upserted).toHaveLength(0);
  });
});

describe('POST /runs/:id/resume on a gated steering-author run (no side door)', () => {
  it('a gated resume IS an approve — it lands the proposal exactly like the gate route', async () => {
    const RUN = 'land-resume-1';
    views = [steeringRun(RUN)];
    writeProposalFile(RUN);

    const { status, body } = await send('POST', `/runs/${RUN}/resume`);
    expect(status).toBe(200);
    expect(body['landing']).toMatchObject({ outcome: 'landed', ruleIds: ['POL-0001'] });
    expect(upserted).toHaveLength(1);
    expect(upserted[0]!.provenance.source).toBe('chat');
  });
});
