// crew#851 — the deliver READ RACE: a run that pushed its branch and opened its PR was served
// `status: completed` + `delivery: 'stranded'` when `GET /runs/:id` landed between the engine's
// terminal flip and the async `run.delivered` resolution (0.8.3 release smoke F-SMOKE-003, macOS
// leg; ubuntu read 'delivered' on identical inputs ~1 s later). The DTO was built from a record
// that already held the delivery (the deliver unit's stored output); only the index lagged, and the
// fallback label — a stat of the still-present worktree — asserted "work not lifted".
//
// Pins, with Fastify inject() over a mock adapter (no NAPI) and a REAL worktree directory so the
// stat fallback WOULD say stranded:
//   - a `workOutput` that resolves only AFTER the first GET was issued ⇒ both run DTOs read
//     'delivered' + deliverUrl, never 'stranded';
//   - ONE engine read per run across the terminal frame and concurrent GETs (in-flight memo), and
//     the record written once;
//   - a push-only transcript (N1) in the same window ⇒ 'pushed';
//   - a `done` deliver unit whose transcript carries no record is read ONCE and then settled —
//     the honest derivation ('stranded' for a present worktree) stands and the engine is not
//     re-asked on every poll;
//   - `pending()` is false outside the window: non-terminal, rejected deliver unit, already recorded.
import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { DeliveryIndex, DeliveryResolver, type DeliveryRecord } from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';
import { removeScratch } from './setup/scratch.js';

const PR_URL = 'https://github.com/o/r/pull/1';
/** The deliver phase's transcript tail on an unchanged lift: push output, then the URL twice. */
const DELIVER_TRANSCRIPT = [
  ' * [new branch]      wicked/run-a -> wicked/run-a',
  "branch 'wicked/run-a' set up to track 'origin/wicked/run-a'.",
  PR_URL,
  PR_URL,
].join('\n');
const PUSH_ONLY_TRANSCRIPT = 'deliver: PUSHED-NO-PR wicked/run-a /srv/remote.git';

function view(id: string, workdir: string, status = 'completed', deliverStatus = 'done'): SessionView {
  return {
    session: {
      id,
      workflow_id: 'feature',
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status,
      human_confirm: 'none',
      unit_ix: 5,
      attempt: 0,
      workdir,
      repo_ref: 'repo-1',
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [
      { id: `${id}:u4`, ord: 4, status: 'done', tool_cmd: [] },
      { id: `${id}:deliver`, ord: 5, status: deliverStatus, tool_cmd: [] },
    ],
  } as unknown as SessionView;
}

/** A promise the test resolves by hand — the engine read that lands AFTER the poll arrived. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const scratch: string[] = [];
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const d of scratch.splice(0)) removeScratch(d);
});

function harness(
  views: SessionView[],
  workOutput: (unitId: string) => Promise<string | null>,
  opts: { settleMs?: number; recordThrowsOnce?: boolean } = {},
) {
  const index = new DeliveryIndex();
  const records: Array<[string, DeliveryRecord]> = [];
  const workOutputSpy = vi.fn(workOutput);
  let recordThrows = opts.recordThrowsOnce === true;
  const adapter = {
    sessionsDetail: vi.fn().mockResolvedValue(views),
    sessions: vi.fn().mockResolvedValue(views.map((v) => v.session.id)),
    workOutput: workOutputSpy,
  };
  const resolver = new DeliveryResolver({
    listViews: () => adapter.sessionsDetail(),
    workOutput: (unitId) => adapter.workOutput(unitId),
    isDelivered: (runId) => index.isDelivered(runId),
    record: (runId, record) => {
      if (recordThrows) {
        recordThrows = false;
        throw new Error('audit trail unavailable');
      }
      records.push([runId, record]);
      if ('url' in record) index.set(runId, record.url);
      else index.setPushed(runId, record.pushed);
    },
  });
  app = Fastify({ logger: false });
  registerRoutes(
    app,
    adapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    { deliveryIndex: index, deliveryResolver: resolver, ...(opts.settleMs !== undefined ? { deliverySettleMs: opts.settleMs } : {}) },
  );
  return { index, resolver, records, workOutputSpy, adapter };
}

async function getRun(id: string): Promise<Record<string, unknown>> {
  const res = await app!.inject({ method: 'GET', url: `/api/v1/runs/${id}` });
  expect(res.statusCode).toBe(200);
  return (res.json() as { run: { session: Record<string, unknown> } }).run.session;
}

async function listRuns(): Promise<Record<string, unknown>[]> {
  const res = await app!.inject({ method: 'GET', url: '/api/v1/runs' });
  expect(res.statusCode).toBe(200);
  return (res.json() as { runs: { session: Record<string, unknown> }[] }).runs.map((r) => r.session);
}

describe('crew#851 — a pushed + PR-opened run is never read as stranded in the completion window', () => {
  it("GET /runs/:id issued BEFORE the delivery resolved reads 'delivered', and the engine is read once", async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'crew-851-wt-'));
    scratch.push(worktree);
    const output = deferred<string | null>();
    const h = harness([view('run-a', worktree)], () => output.promise);
    await app!.ready();

    // The poll lands FIRST (the terminal event can trail the engine's status flip): the route
    // alone must start the read…
    const poll = getRun('run-a');
    await new Promise((r) => setImmediate(r));
    expect(h.workOutputSpy).toHaveBeenCalledTimes(1);
    // …and the terminal frame arriving while that read is in flight JOINS it — no second read
    // (codex r2 on #859: this pins the sharing in both directions).
    const frame = h.resolver.resolve('run-a');
    await new Promise((r) => setImmediate(r));
    expect(h.workOutputSpy).toHaveBeenCalledTimes(1);
    output.resolve(DELIVER_TRANSCRIPT);
    await frame;
    const session = await poll;

    expect(session['status']).toBe('completed');
    expect(session['delivery']).toBe('delivered');
    expect(session['deliverUrl']).toBe(PR_URL);
    // One read, one record — the frame and the poll shared the promise.
    expect(h.workOutputSpy).toHaveBeenCalledTimes(1);
    expect(h.workOutputSpy).toHaveBeenCalledWith('run-a:deliver');
    expect(h.records).toEqual([['run-a', { url: PR_URL }]]);

    // Settled: a later poll derives from the index and never re-asks the engine.
    const again = await getRun('run-a');
    expect(again['delivery']).toBe('delivered');
    expect(h.workOutputSpy).toHaveBeenCalledTimes(1);
  });

  it("GET /runs (the list) in the window reads 'delivered' for the run — the smoke's terminal poll", async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'crew-851-wt-'));
    scratch.push(worktree);
    const h = harness([view('run-a', worktree)], async () => DELIVER_TRANSCRIPT);
    await app!.ready();
    // No terminal frame has fired yet (the event can trail the engine's status flip): the read
    // path alone must resolve the window.
    const runs = await listRuns();
    const a = runs.find((r) => r['id'] === 'run-a')!;
    expect(a['status']).toBe('completed');
    expect(a['delivery']).toBe('delivered');
    expect(a['deliverUrl']).toBe(PR_URL);
    expect(h.workOutputSpy).toHaveBeenCalledTimes(1);
    expect(h.index.urlFor('run-a')).toBe(PR_URL);
  });

  it("a push-only delivery (N1) in the window reads 'pushed', never 'stranded'", async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'crew-851-wt-'));
    scratch.push(worktree);
    harness([view('run-a', worktree)], async () => PUSH_ONLY_TRANSCRIPT);
    await app!.ready();
    const session = await getRun('run-a');
    expect(session['delivery']).toBe('pushed');
    expect(session['deliverBranch']).toBe('wicked/run-a');
    expect('deliverUrl' in session).toBe(false);
  });

  it('a done deliver unit with no record is read ONCE, then the honest derivation stands', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'crew-851-wt-'));
    scratch.push(worktree);
    const h = harness([view('run-a', worktree)], async () => 'deliver: pushed wicked/run-a, prose only');
    await app!.ready();
    const first = await getRun('run-a');
    // Nothing on record and the worktree is there: the stat-only tri-state is the truth here.
    expect(first['delivery']).toBe('stranded');
    expect(h.records).toEqual([]);
    await getRun('run-a');
    await listRuns();
    expect(h.workOutputSpy).toHaveBeenCalledTimes(1);
    expect(h.resolver.pending(view('run-a', worktree))).toBe(false);
  });

  it('a read that threw is not settled: the next poll retries and heals the field', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'crew-851-wt-'));
    scratch.push(worktree);
    let calls = 0;
    const h = harness([view('run-a', worktree)], async () => {
      calls += 1;
      if (calls === 1) throw new Error('engine busy');
      return DELIVER_TRANSCRIPT;
    });
    await app!.ready();
    const first = await getRun('run-a');
    expect(first['delivery']).toBe('stranded');
    const second = await getRun('run-a');
    expect(second['delivery']).toBe('delivered');
    expect(h.workOutputSpy).toHaveBeenCalledTimes(2);
  });

  it('a record write that threw leaves the run unsettled: the next poll re-reads and records (codex r1 on #859)', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'crew-851-wt-'));
    scratch.push(worktree);
    const h = harness([view('run-a', worktree)], async () => DELIVER_TRANSCRIPT, { recordThrowsOnce: true });
    await app!.ready();
    const first = await getRun('run-a');
    expect(first['delivery']).toBe('stranded');
    expect(h.records).toEqual([]);
    expect(h.resolver.pending(view('run-a', worktree))).toBe(true);
    const second = await getRun('run-a');
    expect(second['delivery']).toBe('delivered');
    expect(h.records).toEqual([['run-a', { url: PR_URL }]]);
    expect(h.workOutputSpy).toHaveBeenCalledTimes(2);
  });

  it('the request-path wait is BOUNDED: a hung engine read costs one poll the bound, then heals the next (codex r1 on #859)', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'crew-851-wt-'));
    scratch.push(worktree);
    const output = deferred<string | null>();
    const h = harness([view('run-a', worktree), view('run-b', worktree)], (unitId) =>
      unitId.startsWith('run-a') ? output.promise : Promise.resolve(DELIVER_TRANSCRIPT.replaceAll('run-a', 'run-b')),
    { settleMs: 50 });
    await app!.ready();
    const started = Date.now();
    const runs = await listRuns();
    expect(Date.now() - started).toBeLessThan(1_500);
    // run-b's read landed inside the bound; run-a's is still hanging — honest fallback for THIS poll.
    expect(runs.find((r) => r['id'] === 'run-b')!['delivery']).toBe('delivered');
    expect(runs.find((r) => r['id'] === 'run-a')!['delivery']).toBe('stranded');
    expect(h.workOutputSpy).toHaveBeenCalledTimes(2);
    // The read was not abandoned: when it lands, the next poll reads delivered — with no second read.
    output.resolve(DELIVER_TRANSCRIPT);
    await new Promise((r) => setImmediate(r));
    const again = await getRun('run-a');
    expect(again['delivery']).toBe('delivered');
    expect(h.workOutputSpy).toHaveBeenCalledTimes(2);
  });

  it('a null transcript for a done deliver unit does not settle: the next poll re-reads (codex r2 on #859)', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'crew-851-wt-'));
    scratch.push(worktree);
    let calls = 0;
    const h = harness([view('run-a', worktree)], async () => {
      calls += 1;
      return calls === 1 ? null : DELIVER_TRANSCRIPT;
    });
    await app!.ready();
    expect((await getRun('run-a'))['delivery']).toBe('stranded');
    expect(h.resolver.pending(view('run-a', worktree))).toBe(true);
    expect((await getRun('run-a'))['delivery']).toBe('delivered');
    expect(h.workOutputSpy).toHaveBeenCalledTimes(2);
  });

  it('pending() is false outside the window', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'crew-851-wt-'));
    scratch.push(worktree);
    const h = harness([], async () => null);
    expect(h.resolver.pending(view('run-x', worktree, 'running'))).toBe(false);
    expect(h.resolver.pending(view('run-x', worktree, 'completed', 'rejected'))).toBe(false);
    expect(h.resolver.pending(view('run-x', worktree, 'completed', 'running'))).toBe(false);
    expect(h.resolver.pending(view('run-x', worktree))).toBe(true);
    // A deliver that succeeded before a LATER phase failed is still in the window (sessionFailed
    // triggers the same resolution in the daemon).
    expect(h.resolver.pending(view('run-x', worktree, 'failed'))).toBe(true);
    h.index.set('run-x', PR_URL);
    expect(h.resolver.pending(view('run-x', worktree))).toBe(false);
  });
});
