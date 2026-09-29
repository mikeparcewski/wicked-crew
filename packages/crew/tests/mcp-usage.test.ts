// DES-MCP-TOOLS-001 slice S7 — the MCP usage fold, decisions split by allow / ask / deny.
//
// The slice's proving test: the fold over fixture call records matches HAND-COMPUTED numbers
// (the counts, the decision split, the error rate, nearest-rank p50/p95/p99 and the tool chains),
// through the pure fold and through `GET /mcp/usage` over a real `calls.ndjson`. The file reader's
// 30-day fold into `calls-daily.ndjson` is pinned beside it.

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { McpCallDecision, McpCallOutcome, McpCallRecord, McpUsageResponse } from '../src/core/types.js';
import { foldDaily, McpCallRecordFile, parseCallRecord } from '../src/mcp/call-records.js';
import { foldChains, foldMcpUsage, nearestRank } from '../src/mcp/usage.js';
import { removeScratch } from './setup/scratch.js';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
let seq = 0;

function rec(
  start: string,
  subject: string,
  decision: McpCallDecision,
  ms: number,
  opts: { run?: string | null; unit?: string | null; seat?: string | null; error?: string | null; outcome?: McpCallOutcome } = {},
): McpCallRecord {
  const run = opts.run === undefined ? 'r1' : opts.run;
  const error = opts.error ?? null;
  const outcome: McpCallOutcome = opts.outcome ?? (decision === 'allow' ? (error === null || error === 'tool_error' ? 'ok' : 'upstream_error') : decision === 'ask' ? 'pending_approval' : decision === 'deny' ? 'denied' : 'guard_error');
  const errored = error !== null || outcome !== 'ok';
  seq += 1;
  return {
    traceId: run,
    spanId: `s${String(seq).padStart(4, '0')}`,
    parentSpanId: run === null ? null : (opts.unit === undefined ? '1:1' : opts.unit),
    name: 'mcp.tool.call',
    start,
    end: new Date(Date.parse(start) + ms).toISOString(),
    ms,
    status: { code: errored ? 'error' : 'ok', errorClass: errored ? (error ?? outcome) : null },
    decision: { decision, by: decision === 'deny' ? 'engine:mcp-phase-role' : 'MCP-POSTURE-READ', ruleIds: [], claimId: run === null ? null : `c${seq}` },
    outcome,
    attrs: {
      'mcp.subject': subject,
      'mcp.class': run === null ? null : subject.endsWith('create') ? 'write' : 'read',
      'mcp.kind': 'mcp-stdio',
      'wicked.seat': opts.seat === undefined ? 'codex' : opts.seat,
      'wicked.phase': 'build',
      'wicked.carrier': 'shim',
      'bytes.out': 0,
      retries: 0,
    },
  };
}

const SEARCH = 'mcp:jira/search';
const CREATE = 'mcp:jira/create';
const GET = 'mcp:sentry/get';

/**
 * The fixture. In the 7-day window: 10 calls, 7 allowed (ms 10, 40, 100, 20, 30, 50, 60; one
 * upstream error), 1 ask, 1 deny, 1 guard error. Out of it: one 10 days old, one 40 days old.
 */
function fixture(): McpCallRecord[] {
  return [
    // r1, unit 1:1, codex: search → create → sentry/get (the get fails upstream)
    rec('2026-09-28T10:00:00.000Z', SEARCH, 'allow', 10),
    rec('2026-09-28T10:00:01.000Z', CREATE, 'allow', 40),
    rec('2026-09-28T10:00:02.000Z', GET, 'allow', 100, { error: 'http_5xx' }),
    // r1, unit 2:1, claude (an evaluator): search → create, the create denied by phase role
    rec('2026-09-28T11:00:00.000Z', SEARCH, 'allow', 20, { unit: '2:1', seat: 'claude' }),
    rec('2026-09-28T11:00:01.000Z', CREATE, 'deny', 1, { unit: '2:1', seat: 'claude' }),
    // r2, unit 1:1, codex: search → create (asks) → search → search (a repeat, not a chain)
    rec('2026-09-27T08:00:00.000Z', SEARCH, 'allow', 30, { run: 'r2' }),
    rec('2026-09-27T08:00:01.000Z', CREATE, 'ask', 2, { run: 'r2' }),
    rec('2026-09-27T08:00:02.000Z', SEARCH, 'allow', 50, { run: 'r2' }),
    rec('2026-09-27T08:00:03.000Z', SEARCH, 'allow', 60, { run: 'r2' }),
    // refused before the token resolved to a unit: no run, no seat
    rec('2026-09-26T00:00:00.000Z', CREATE, 'guard_error', 0, { run: null, seat: null }),
    // out of the 7-day window, inside the 30-day one
    rec('2026-09-18T12:00:00.000Z', SEARCH, 'allow', 999, { seat: 'pi', run: 'r0' }),
    // older than 30 days: folded into calls-daily.ndjson by the file reader
    rec('2026-08-19T12:00:00.000Z', SEARCH, 'allow', 7, { seat: 'pi', run: 'rold' }),
  ];
}

describe('nearestRank', () => {
  it('is the value at position ceil(q × n) of the sorted list', () => {
    const ms = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(nearestRank(ms, 0.5)).toBe(10); // ceil(10)   = 10th
    expect(nearestRank(ms, 0.95)).toBe(19); // ceil(19)  = 19th
    expect(nearestRank(ms, 0.99)).toBe(20); // ceil(19.8) = 20th
    expect(nearestRank([5], 0.95)).toBe(5);
    expect(nearestRank([], 0.5)).toBeNull();
  });
});

describe('foldMcpUsage over the fixture, against hand-computed numbers', () => {
  it('7 days: counts, the decision split, error rate and percentiles over the calls that ran', () => {
    const u = foldMcpUsage(fixture(), { days: 7 }, NOW);
    expect(u.since).toBe('2026-09-21T12:00:00.000Z');
    expect(u.until).toBe('2026-09-28T12:00:00.000Z');
    // sorted ran ms: 10 20 30 40 50 60 100 (n = 7)
    expect(u.totals).toEqual({
      calls: 10,
      decisions: { allow: 7, ask: 1, deny: 1, guard_error: 1 },
      ran: 7,
      errors: 1,
      errorRate: 1 / 7,
      p50Ms: 40, // ceil(3.5)  = 4th
      p95Ms: 100, // ceil(6.65) = 7th
      p99Ms: 100, // ceil(6.93) = 7th
    });
    expect(u.seats).toEqual(['claude', 'codex']);
    expect(u.skipped).toBe(0);
  });

  it('per tool: search ran 5 times (10 20 30 50 60), create split allow/ask/deny/guard_error', () => {
    const u = foldMcpUsage(fixture(), { days: 7 }, NOW);
    expect(u.tools.map((t) => [t.subject, t.calls])).toEqual([
      [SEARCH, 5],
      [CREATE, 4],
      [GET, 1],
    ]);
    const search = u.tools[0]!;
    expect(search).toMatchObject({ server: 'jira', tool: 'search', class: 'read', seats: ['claude', 'codex'], ran: 5, errors: 0, errorRate: 0, p50Ms: 30, p95Ms: 60, p99Ms: 60, lastCall: '2026-09-28T11:00:00.000Z' });
    const create = u.tools[1]!;
    expect(create.decisions).toEqual({ allow: 1, ask: 1, deny: 1, guard_error: 1 });
    expect(create).toMatchObject({ ran: 1, p50Ms: 40, p95Ms: 40, seats: ['claude', 'codex'] });
    expect(u.tools[2]).toMatchObject({ server: 'sentry', ran: 1, errors: 1, errorRate: 1, p95Ms: 100 });
    expect(u.servers).toEqual([
      { server: 'jira', calls: 9, decisions: { allow: 6, ask: 1, deny: 1, guard_error: 1 }, lastCall: '2026-09-28T11:00:01.000Z' },
      { server: 'sentry', calls: 1, decisions: { allow: 1, ask: 0, deny: 0, guard_error: 0 }, lastCall: '2026-09-28T10:00:02.000Z' },
    ]);
  });

  it('chains: consecutive calls of one unit attempt, repeats and unit-less calls left out', () => {
    const u = foldMcpUsage(fixture(), { days: 7 }, NOW);
    // r1 1:1 search→create, create→get; r1 2:1 search→create; r2 search→create, create→search
    expect(u.chains).toEqual([
      { from: SEARCH, to: CREATE, count: 3, runs: 2 },
      { from: CREATE, to: SEARCH, count: 1, runs: 1 },
      { from: CREATE, to: GET, count: 1, runs: 1 },
    ]);
    // A subject filter keeps the chains that touch it, folded from the unfiltered sequence.
    expect(foldMcpUsage(fixture(), { days: 7, subject: GET }, NOW).chains).toEqual([{ from: CREATE, to: GET, count: 1, runs: 1 }]);
    // The decision filter narrows the sequence first: allowed calls only.
    // (equal counts sort by `from`, then `to`)
    expect(foldMcpUsage(fixture(), { days: 7, decision: 'allow' }, NOW).chains).toEqual([
      { from: CREATE, to: GET, count: 1, runs: 1 },
      { from: SEARCH, to: CREATE, count: 1, runs: 1 },
    ]);
  });

  it('the drill-down is tool × seat × run, newest first; the guard error has no run', () => {
    const u = foldMcpUsage(fixture(), { days: 7, subject: CREATE }, NOW);
    expect(u.runs).toEqual([
      { subject: CREATE, seat: 'claude', runId: 'r1', calls: 1, decisions: { allow: 0, ask: 0, deny: 1, guard_error: 0 }, errors: 0, lastCall: '2026-09-28T11:00:01.000Z' },
      { subject: CREATE, seat: 'codex', runId: 'r1', calls: 1, decisions: { allow: 1, ask: 0, deny: 0, guard_error: 0 }, errors: 0, lastCall: '2026-09-28T10:00:01.000Z' },
      { subject: CREATE, seat: 'codex', runId: 'r2', calls: 1, decisions: { allow: 0, ask: 1, deny: 0, guard_error: 0 }, errors: 0, lastCall: '2026-09-27T08:00:01.000Z' },
      { subject: CREATE, seat: null, runId: null, calls: 1, decisions: { allow: 0, ask: 0, deny: 0, guard_error: 1 }, errors: 0, lastCall: '2026-09-26T00:00:00.000Z' },
    ]);
    expect(u.totals.decisions).toEqual({ allow: 1, ask: 1, deny: 1, guard_error: 1 });
  });

  it('filters: seat and decision narrow every section; the seat options do not', () => {
    const u = foldMcpUsage(fixture(), { days: 7, seat: 'claude' }, NOW);
    expect(u.totals).toMatchObject({ calls: 2, decisions: { allow: 1, ask: 0, deny: 1, guard_error: 0 }, ran: 1, p95Ms: 20 });
    expect(u.seats).toEqual(['claude', 'codex']);
    const denies = foldMcpUsage(fixture(), { days: 7, decision: 'deny' }, NOW);
    expect(denies.totals).toMatchObject({ calls: 1, ran: 0, errorRate: null, p50Ms: null, p95Ms: null, p99Ms: null });
    expect(denies.filters).toEqual({ subject: null, seat: null, decision: 'deny' });
  });

  it('the window: 1 day keeps r1 only; 30 days adds the 10-day-old call (and its 999 ms)', () => {
    const one = foldMcpUsage(fixture(), { days: 1 }, NOW);
    expect(one.totals).toMatchObject({ calls: 5, ran: 4, p95Ms: 100 });
    expect(one.daily.map((d) => [d.day, d.calls])).toEqual([
      ['2026-09-27', 0],
      ['2026-09-28', 5],
    ]);
    const thirty = foldMcpUsage(fixture(), { days: 30 }, NOW);
    // ran: 10 20 30 40 50 60 100 999 (n = 8) → p50 = 4th = 40, p95 = ceil(7.6) = 8th = 999
    expect(thirty.totals).toMatchObject({ calls: 11, ran: 8, p50Ms: 40, p95Ms: 999 });
    expect(thirty.seats).toEqual(['claude', 'codex', 'pi']);
    expect(thirty.daily).toHaveLength(31);
  });

  it('seven days: one row per UTC day the window touches, zeros included, split by decision', () => {
    const u = foldMcpUsage(fixture(), { days: 7 }, NOW);
    expect(u.daily.map((d) => d.day)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']);
    expect(u.daily.find((d) => d.day === '2026-09-27')).toEqual({ day: '2026-09-27', calls: 4, decisions: { allow: 3, ask: 1, deny: 0, guard_error: 0 } });
    expect(u.daily.reduce((n, d) => n + d.calls, 0)).toBe(u.totals.calls);
  });

  it('a start written with an offset lands on its UTC day and orders by its instant', () => {
    const late = rec('2026-09-27T23:30:00.000-02:00', SEARCH, 'allow', 5, { run: 'rz' }); // = 09-28T01:30Z
    const early = rec('2026-09-28T02:10:00.000+02:00', CREATE, 'allow', 5, { run: 'rz' }); // = 09-28T00:10Z
    const u = foldMcpUsage([late, early], { days: 1 }, NOW);
    expect(u.daily.find((d) => d.day === '2026-09-28')?.calls).toBe(2);
    expect(u.chains).toEqual([{ from: CREATE, to: SEARCH, count: 1, runs: 1 }]);
    expect(u.tools.find((t) => t.subject === SEARCH)?.lastCall).toBe('2026-09-28T01:30:00.000Z');
  });

  it('foldChains caps at 20, most frequent first', () => {
    const many: McpCallRecord[] = [];
    for (let i = 0; i < 25; i++) {
      many.push(rec(`2026-09-28T09:00:${String(i).padStart(2, '0')}.000Z`, `mcp:s/t${i}`, 'allow', 1, { unit: `${i}:1` }));
      many.push(rec(`2026-09-28T09:01:${String(i).padStart(2, '0')}.000Z`, `mcp:s/u${i}`, 'allow', 1, { unit: `${i}:1` }));
    }
    expect(foldChains(many)).toHaveLength(20);
  });
});

describe('the call records file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wc-mcp-usage-'));
  });
  afterEach(() => removeScratch(dir));

  it('parseCallRecord refuses a line without the fields the fold reads', () => {
    expect(parseCallRecord('{')).toBeNull();
    expect(parseCallRecord('{"spanId":"x"}')).toBeNull();
    expect(parseCallRecord(JSON.stringify({ ...rec('2026-09-28T00:00:00.000Z', SEARCH, 'allow', 1), decision: { decision: 'maybe' } }))).toBeNull();
    expect(parseCallRecord(JSON.stringify(rec('2026-09-28T00:00:00.000Z', SEARCH, 'allow', 1)))).not.toBeNull();
  });

  it('a read folds records older than 30 days into calls-daily.ndjson and rewrites the raw file without them', async () => {
    const file = new McpCallRecordFile(dir);
    const all = fixture();
    for (const r of all) await file.append(r);
    writeFileSync(file.path, `${readFileSync(file.path, 'utf8')}not json\n`);
    const read = await file.read(NOW);
    expect(read.folded).toBe(1);
    expect(read.skipped).toBe(1);
    expect(read.records).toHaveLength(all.length - 1);
    const daily = readFileSync(file.dailyPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown);
    expect(daily).toEqual([{ day: '2026-08-19', subject: SEARCH, seat: 'pi', decision: 'allow', calls: 1, errors: 0, msTotal: 7 }]);
    const raw = readFileSync(file.path, 'utf8');
    expect(raw).not.toContain('2026-08-19');
    expect(raw).toContain('not json'); // an unreadable line is kept, not destroyed
    // A second read has nothing left to fold.
    expect((await file.read(NOW)).folded).toBe(0);
    expect(readFileSync(file.dailyPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('a read serialized behind an append sees the appended record', async () => {
    const file = new McpCallRecordFile(dir);
    const r = rec('2026-09-28T11:59:00.000Z', SEARCH, 'allow', 3);
    const [, read] = await Promise.all([file.append(r), file.read(NOW)]);
    expect(read.records.map((x) => x.spanId)).toEqual([r.spanId]);
  });

  it('no file reads as no calls, and writes nothing', async () => {
    const file = new McpCallRecordFile(join(dir, 'absent'));
    expect(await file.read(NOW)).toEqual({ records: [], skipped: 0, folded: 0 });
    expect(existsSync(join(dir, 'absent'))).toBe(false);
  });

  it('foldDaily sums calls, errors and ms per day × subject × seat × decision', () => {
    const rows = foldDaily([
      rec('2026-08-01T01:00:00.000Z', SEARCH, 'allow', 5),
      rec('2026-08-01T02:00:00.000Z', SEARCH, 'allow', 7, { error: 'timeout' }),
      rec('2026-08-01T03:00:00.000Z', SEARCH, 'deny', 1),
    ]);
    expect(rows).toEqual([
      { day: '2026-08-01', subject: SEARCH, seat: 'codex', decision: 'allow', calls: 2, errors: 1, msTotal: 12 },
      { day: '2026-08-01', subject: SEARCH, seat: 'codex', decision: 'deny', calls: 1, errors: 1, msTotal: 1 },
    ]);
  });
});

describe('GET /mcp/usage', () => {
  let dir: string;
  let app: FastifyInstance;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wc-mcp-usage-route-'));
    const file = new McpCallRecordFile(dir);
    for (const r of fixture()) await file.append(r);
    app = Fastify();
    registerMcpRoutes(app, { usage: file, now: () => NOW, audit: new AuditLog(join(dir, 'audit.jsonl')), actorOf: () => LOCAL_ACTOR });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    removeScratch(dir);
  });

  it('answers the same fold as the pure function over the same records (default 7 days)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/mcp/usage' });
    expect(res.statusCode).toBe(200);
    const body = res.json<McpUsageResponse>();
    const expected = foldMcpUsage(fixture().filter((r) => r.start >= '2026-08-29'), { days: 7 }, NOW);
    expect(body).toEqual(expected);
    expect(body.totals).toMatchObject({ calls: 10, decisions: { allow: 7, ask: 1, deny: 1, guard_error: 1 }, p50Ms: 40, p95Ms: 100 });
    expect(body.chains[0]).toEqual({ from: SEARCH, to: CREATE, count: 3, runs: 2 });
  });

  it('takes days, subject, seat and decision from the query', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/mcp/usage?days=30&subject=${encodeURIComponent(SEARCH)}&seat=codex&decision=allow` });
    expect(res.statusCode).toBe(200);
    const body = res.json<McpUsageResponse>();
    expect(body.days).toBe(30);
    expect(body.filters).toEqual({ subject: SEARCH, seat: 'codex', decision: 'allow' });
    // codex's allowed searches in 30 days: 10, 30, 50, 60 (the 999 one is pi's)
    expect(body.totals).toMatchObject({ calls: 4, ran: 4, p50Ms: 30, p95Ms: 60 });
  });

  it.each([
    ['days=0'],
    ['days=31'],
    ['days=seven'],
    ['decision=maybe'],
    ['seat=a%20b'],
    ['other=1'],
  ])('400 on %s', async (q) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/mcp/usage?${q}` });
    expect(res.statusCode).toBe(400);
  });

  it('503 mcp_unavailable when the daemon has no call records seam', async () => {
    const bare = Fastify();
    registerMcpRoutes(bare, { audit: new AuditLog(join(dir, 'a2.jsonl')), actorOf: () => LOCAL_ACTOR });
    const res = await bare.inject({ method: 'GET', url: '/api/v1/mcp/usage' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'mcp_unavailable' });
    await bare.close();
  });

  it('503 records_unreadable when the records cannot be read', async () => {
    const broken = Fastify();
    registerMcpRoutes(broken, { usage: { read: async () => { throw new Error('EACCES'); } }, audit: new AuditLog(join(dir, 'a3.jsonl')), actorOf: () => LOCAL_ACTOR });
    const res = await broken.inject({ method: 'GET', url: '/api/v1/mcp/usage' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'records_unreadable' });
    await broken.close();
  });
});
