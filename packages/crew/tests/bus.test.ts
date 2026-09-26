// wicked-core#631 — crew's one bus mechanism (src/core/bus.ts) over a scripted engine: the adapter
// attaches its engine to the bus file it handed it, emits go to `busEmit`, reads page `busRead`,
// and a tap starts at the tail, relays matching rows in order, and follows a replaced bus file.
// The real engine behind the same calls is pinned in bus-seams-engine.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import {
  attachEngineBus,
  busTesting,
  detachEngineBus,
  emitOnBus,
  readBus,
  tapBus,
  type BusEvent,
  type BusTap,
  type EngineBus,
} from '../src/core/bus.js';

/** An in-memory engine bus with the engine's read contract. */
function scriptedEngine() {
  let rows: BusEvent[] = [];
  let nextId = 1;
  const emitted: string[] = [];
  const reads: Array<{ afterId: number; limit: number; typePrefix: string | null | undefined }> = [];
  const engine: EngineBus = {
    async busEmit(eventJson) {
      emitted.push(eventJson);
      const e = JSON.parse(eventJson) as BusEvent;
      const dup = rows.find((r) => e.idempotency_key !== undefined && r.idempotency_key === e.idempotency_key);
      if (dup !== undefined) return dup.event_id;
      const row = { ...e, subdomain: e.subdomain ?? '', event_id: nextId++, emitted_at: Date.now() } as BusEvent;
      rows.push(row);
      return row.event_id;
    },
    async busRead(afterId, limit, typePrefix) {
      reads.push({ afterId, limit, typePrefix });
      const tail = rows.length === 0 ? 0 : rows[rows.length - 1]!.event_id;
      if (afterId > tail) return JSON.stringify({ next: 0, rows: [] });
      if (limit === 0) return JSON.stringify({ next: tail, rows: [] });
      const page = rows
        .filter((r) => r.event_id > afterId && (typePrefix == null || r.event_type.startsWith(typePrefix)))
        .slice(0, limit);
      return JSON.stringify({ next: page.length === limit ? page[page.length - 1]!.event_id : tail, rows: page });
    },
  };
  return {
    engine,
    emitted,
    reads,
    push: (event_type: string, payload: unknown = {}, domain = 'd') =>
      engine.busEmit(JSON.stringify({ event_type, domain, payload })),
    /** The bus file is replaced under the same path: the ids restart. */
    replace: () => {
      rows = [];
      nextId = 1;
    },
  };
}

const PATH = '/virtual/bus631/bus.db';
let tap: BusTap | null = null;
let attached: EngineBus | null = null;

afterEach(async () => {
  await tap?.stop();
  tap = null;
  if (attached !== null) detachEngineBus(PATH, attached);
  attached = null;
});

function attach(): ReturnType<typeof scriptedEngine> {
  const s = scriptedEngine();
  attachEngineBus(PATH, s.engine);
  attached = s.engine;
  return s;
}

async function until(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('crew bus through the engine (wicked-core#631)', () => {
  it('emitOnBus hands the row to the engine attached for that path and resolves its event id', async () => {
    const s = attach();
    const row = { event_type: 'wicked.crew.project.created', domain: 'wicked-crew', payload: { a: 1 }, idempotency_key: 'k' };
    const id = await emitOnBus('/virtual/bus631/./bus.db', row); // another spelling of the same file
    expect(JSON.parse(s.emitted[0]!)).toEqual(row);
    expect(await emitOnBus(PATH, row)).toBe(id); // a duplicate key is the existing row: success
  });

  it('a bus no engine holds is refused — no fallback', async () => {
    const double = busTesting.unattached;
    busTesting.unattached = undefined;
    try {
      await expect(emitOnBus('/virtual/nobody/bus.db', { event_type: 'wicked.a.b', domain: 'd', payload: {} })).rejects.toThrow(
        /no engine holds the bus/,
      );
      await expect(tapBus({ dbPath: '/virtual/nobody/bus.db', filter: 'wicked.a.**', handler: () => undefined })).rejects.toThrow(
        /no engine holds the bus/,
      );
      await expect(tapBus({ dbPath: undefined, filter: 'wicked.a.**', handler: () => undefined })).rejects.toThrow(/no bus named/);
    } finally {
      busTesting.unattached = double;
    }
  });

  it('readBus pages every live row with the prefix, oldest first', async () => {
    const s = attach();
    for (let i = 0; i < 1203; i++) await s.push(i % 2 === 0 ? 'wicked.team.step.claimed' : 'wicked.interactive.status.posted', { i });
    const rows = await readBus(PATH, 'wicked.team.');
    expect(rows).toHaveLength(602);
    expect(rows.map((r) => (r.payload as { i: number }).i)).toEqual(Array.from({ length: 602 }, (_, k) => k * 2));
    expect(s.reads.every((r) => r.typePrefix === 'wicked.team.' && r.limit === 500)).toBe(true);
  });

  it('a tap starts at the tail, relays matching rows in order, and reads with the filter prefix', async () => {
    const s = attach();
    await s.push('wicked.interactive.doc.created', { n: 0 }); // history: before the tap
    const seen: number[] = [];
    tap = await tapBus({
      dbPath: PATH,
      filter: 'wicked.interactive.**',
      pollIntervalMs: 10,
      handler: (e) => {
        seen.push((e.payload as { n: number }).n);
      },
    });
    await s.push('wicked.interactive.doc.created', { n: 1 });
    await s.push('wicked.team.path.started', { n: 99 });
    await s.push('wicked.interactive.status.posted', { n: 2 });
    await until(() => seen.length === 2);
    expect(seen).toEqual([1, 2]);
    expect(s.reads.slice(1).every((r) => r.typePrefix === 'wicked.interactive.')).toBe(true);
  });

  it('an exact@domain filter delivers only that type from that publisher', async () => {
    const s = attach();
    const seen: string[] = [];
    tap = await tapBus({
      dbPath: PATH,
      filter: 'wicked.interactive.doc.created@wicked-interactive',
      pollIntervalMs: 10,
      handler: (e) => {
        seen.push(`${e.event_type}@${e.domain}`);
      },
    });
    await s.push('wicked.interactive.doc.created', {}, 'someone-else');
    await s.push('wicked.interactive.doc.created_v2', {}, 'wicked-interactive');
    await s.push('wicked.interactive.doc.created', {}, 'wicked-interactive');
    await until(() => seen.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['wicked.interactive.doc.created@wicked-interactive']);
  });

  it('a filter crew does not support is refused at arm', async () => {
    attach();
    await expect(tapBus({ dbPath: PATH, filter: 'wicked.*.created', handler: () => undefined })).rejects.toThrow(/unsupported bus filter/);
  });

  it('a failed handler goes to onError and the tap moves on; a failed read is retried', async () => {
    const s = attach();
    const errors: string[] = [];
    const seen: number[] = [];
    let failReads = 0;
    const read = s.engine.busRead.bind(s.engine);
    s.engine.busRead = async (...args) => {
      if (failReads > 0) {
        failReads--;
        throw new Error('bus busy');
      }
      return read(...args);
    };
    tap = await tapBus({
      dbPath: PATH,
      filter: 'wicked.a.**',
      pollIntervalMs: 10,
      handler: (e) => {
        const n = (e.payload as { n: number }).n;
        if (n === 1) throw new Error('handler boom');
        seen.push(n);
      },
      onError: (err) => errors.push(err.message),
    });
    failReads = 2;
    await s.push('wicked.a.b', { n: 1 });
    await s.push('wicked.a.b', { n: 2 });
    await until(() => seen.length === 1);
    expect(seen).toEqual([2]);
    expect(errors).toEqual(['bus busy', 'bus busy', 'handler boom']);
  });

  it('a first read that fails is retried, never a guessed start', async () => {
    const s = attach();
    await s.push('wicked.a.b', { n: 0 }); // history
    const read = s.engine.busRead.bind(s.engine);
    let fail = true;
    s.engine.busRead = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('not yet');
      }
      return read(...args);
    };
    const seen: number[] = [];
    const errors: string[] = [];
    tap = await tapBus({
      dbPath: PATH,
      filter: 'wicked.a.**',
      pollIntervalMs: 10,
      handler: (e) => {
        seen.push((e.payload as { n: number }).n);
      },
      onError: (err) => errors.push(err.message),
    });
    expect(errors).toEqual(['not yet']);
    await until(() => s.reads.length >= 2); // the start was read again
    await s.push('wicked.a.b', { n: 1 });
    await until(() => seen.length === 1);
    expect(seen).toEqual([1]); // the history row was never delivered
  });

  it('follows a bus file replaced under the same path: the engine answers cursor 0, the tap reads the new file', async () => {
    const s = attach();
    const seen: number[] = [];
    tap = await tapBus({
      dbPath: PATH,
      filter: 'wicked.a.**',
      pollIntervalMs: 10,
      handler: (e) => {
        seen.push((e.payload as { n: number }).n);
      },
    });
    for (let n = 1; n <= 3; n++) await s.push('wicked.a.b', { n });
    await until(() => seen.length === 3);
    s.replace();
    await s.push('wicked.a.b', { n: 10 }); // event_id 1 in the NEW file, below the old cursor
    await until(() => seen.includes(10));
    expect(seen).toEqual([1, 2, 3, 10]);
  });
});
