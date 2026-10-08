// ASK-C3 — the ask path's Watchtower rows (DES-ASK-TEAM-CHAT-001 §4.1, §4.5, §4.6; §10 ASK-C3):
// `path.repicked` (problem), the absent reviewer and a non-answered help (quiet), each a projection of
// one `wicked.team.*` bus row the registry PULLS. Rows clear on `member.joined{attached}` /
// `help.answered{answered}` / `path.ended`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchFinding } from 'wicked-crew-api-types';
import { emitOnBus, readBus } from '../src/core/bus.js';
import { SHIPPED_CHECKS } from '../src/watch/checks/index.js';
import {
  HELP_ANSWERED_TYPE,
  HELP_REQUESTED_TYPE,
  MEMBER_JOINED_TYPE,
  PATH_ENDED_TYPE,
  PATH_REPICKED_TYPE,
  helpUnansweredCheck,
  pathRepickedCheck,
  reviewerAbsentCheck,
} from '../src/watch/checks/team-path.js';
import { WATCH_FINDING_CLEARED, WATCH_FINDING_PREFIX, WATCH_FINDING_RAISED } from '../src/watch/events.js';
import { loadEntries, SHIPPED_ENTRIES_DIR } from '../src/watch/loader.js';
import { WatchRegistry } from '../src/watch/registry.js';
import { Router } from '../src/watch/router.js';
import type { CheckOutput, KeyPointInput, RunWatchState, WatchCheck } from '../src/watch/types.js';
import { removeScratch } from './setup/scratch.js';

const ctx = { now: () => 0, stats: () => ({ queueDepth: 0, queueHwm: 0, shedTotal: 0, tailLagMs: 0 }) };
const fresh = (runId = 'run-1'): RunWatchState => ({ runId, seen: new Set(), bag: new Map() });

let seq = 0;
/** A team bus row as the pull hands it over (the payload carries the team envelope). */
const team = (type: string, payload: Record<string, unknown>, runId = 'run-1'): KeyPointInput => {
  seq++;
  return {
    source: 'bus',
    type,
    event: {
      event_id: seq,
      event_type: type,
      domain: 'wicked-team',
      subdomain: type.split('.')[2],
      idempotency_key: `k-${seq}`,
      emitted_at: seq,
      payload: { run_id: runId, ord: 1, attempt: 0, by: 'engine', at: seq, re: null, ...payload },
    },
    runId,
    at: seq,
    busKey: `k-${seq}`,
  };
};

async function run(check: WatchCheck, state: RunWatchState, input: KeyPointInput): Promise<CheckOutput[]> {
  return await check.evaluate(input, state, {}, {}, ctx);
}

const repicked = (pickSeq: number, extra: Record<string, unknown> = {}) =>
  team(PATH_REPICKED_TYPE, { from: 'claude', to: 'codex', reason: 'timed_out', selection: 'random', pick_seq: pickSeq, ...extra });
const ended = (runId = 'run-1') => team(PATH_ENDED_TYPE, { ord: null, attempt: null, status: 'completed' }, runId);
const joined = (status: string, extra: Record<string, unknown> = {}) =>
  team(MEMBER_JOINED_TYPE, { member_id: 'm1', open_seq: 1, seat: null, role: 'monitor', status, reason: 'no distinct signed-in seat', error: null, ...extra });
const asked = (helpId: string, question: string) => team(HELP_REQUESTED_TYPE, { help_id: helpId, help_seq: 1, question, context: '' });
const answered = (helpId: string, outcome: string | undefined, extra: Record<string, unknown> = {}) =>
  team(HELP_ANSWERED_TYPE, {
    help_id: helpId,
    answer_id: `${helpId}-a`,
    answer: outcome === undefined || outcome === 'answered' ? 'yes' : null,
    evidence: [],
    ...(outcome !== undefined ? { outcome } : {}),
    ...extra,
  });

describe('deterministic:path_repicked (problem)', () => {
  it('one row per pick_seq, naming who took over and why; a redelivery is the same row; path.ended clears it', async () => {
    const s = fresh();
    const [row] = await run(pathRepickedCheck as unknown as WatchCheck, s, repicked(1));
    expect(row).toMatchObject({ op: 'raise', subject: 'repick:1', ord: 1, attempt: 0, re: 'path.repicked#1' });
    expect(row).toMatchObject({ sentence: 'codex takes over — claude stopped answering (timed_out).' });
    expect(await run(pathRepickedCheck as unknown as WatchCheck, s, repicked(1))).toEqual([]);
    expect(await run(pathRepickedCheck as unknown as WatchCheck, s, repicked(2, { from: 'codex', to: 'pi' }))).toMatchObject([{ op: 'raise', subject: 'repick:2' }]);
    expect(await run(pathRepickedCheck as unknown as WatchCheck, s, ended())).toEqual([
      { op: 'clear', subject: 'repick:1' },
      { op: 'clear', subject: 'repick:2' },
    ]);
    // Nothing raises after the path ended (a late redelivery).
    expect(await run(pathRepickedCheck as unknown as WatchCheck, s, repicked(3))).toEqual([]);
    expect(pathRepickedCheck.coverage(s)).toEqual({ state: 'checked' });
    expect(pathRepickedCheck.coverage(fresh())).toEqual({ state: 'not_checked', reason: 'no team path row on this run yet' });
  });

  it('a row without pick_seq has no producer identity and raises nothing', async () => {
    expect(await run(pathRepickedCheck as unknown as WatchCheck, fresh(), repicked(1, { pick_seq: undefined }))).toEqual([]);
  });
});

describe('deterministic:reviewer_absent (quiet)', () => {
  it('seat:null raises "No reviewer" once per slot (not once per attempt) and an attach of that slot clears it', async () => {
    const s = fresh();
    const [row] = await run(reviewerAbsentCheck as unknown as WatchCheck, s, joined('failed'));
    expect(row).toMatchObject({ op: 'raise', subject: '1:0:m1:1', facts: { member_id: 'm1', seat: null } });
    expect((row as { sentence: string }).sentence).toBe('No reviewer — no distinct signed-in seat. Sign in another helper to get one.');
    // The engine publishes the row once per attempt: the next attempt's is the same absence.
    expect(await run(reviewerAbsentCheck as unknown as WatchCheck, s, joined('failed', { ord: 2, attempt: 0, open_seq: 2 }))).toEqual([]);
    // Another slot attaching does not clear m1.
    expect(await run(reviewerAbsentCheck as unknown as WatchCheck, s, joined('attached', { member_id: 'm2', seat: 'codex' }))).toEqual([]);
    expect(await run(reviewerAbsentCheck as unknown as WatchCheck, s, joined('attached', { seat: 'codex', open_seq: 3 }))).toEqual([{ op: 'clear', subject: '1:0:m1:1' }]);
    // A later absence after the clear is a new row with its own key.
    expect(await run(reviewerAbsentCheck as unknown as WatchCheck, s, joined('failed', { ord: 4, open_seq: 4 }))).toMatchObject([{ op: 'raise', subject: '4:0:m1:4' }]);
    expect(await run(reviewerAbsentCheck as unknown as WatchCheck, s, ended())).toEqual([{ op: 'clear', subject: '4:0:m1:4' }]);
  });

  it('a seated member that could not join says so with its seat', async () => {
    const [row] = await run(reviewerAbsentCheck as unknown as WatchCheck, fresh(), joined('failed', { seat: 'codex', reason: 'seat refused' }));
    expect(row).toMatchObject({ sentence: 'The reviewer could not join on codex: seat refused.' });
  });
});

describe('deterministic:help_unanswered (quiet)', () => {
  it('timed_out / failed / no_member raise with the joined question; an old row (no outcome) is answered; an answered help clears the open rows', async () => {
    const s = fresh();
    expect(await run(helpUnansweredCheck as unknown as WatchCheck, s, asked('h1', 'check the migration'))).toEqual([]);
    const [t] = await run(helpUnansweredCheck as unknown as WatchCheck, s, answered('h1', 'timed_out', { by: 'codex', error: 'budget' }));
    expect(t).toMatchObject({
      op: 'raise',
      subject: 'help:h1:h1-a',
      sentence: 'Asked for help; codex did not answer (timed out): "check the migration"',
      facts: { help_id: 'h1', outcome: 'timed_out', question: 'check the migration', error: 'budget' },
    });
    const [n] = await run(helpUnansweredCheck as unknown as WatchCheck, s, answered('h2', 'no_member'));
    expect(n).toMatchObject({ sentence: 'Asked for help; no other helper is signed in.' });
    // No outcome = an old row = answered: it clears both open rows.
    expect(await run(helpUnansweredCheck as unknown as WatchCheck, s, answered('h3', undefined))).toEqual([
      { op: 'clear', subject: 'help:h1:h1-a' },
      { op: 'clear', subject: 'help:h2:h2-a' },
    ]);
    const [f] = await run(helpUnansweredCheck as unknown as WatchCheck, s, answered('h4', 'failed'));
    expect(f).toMatchObject({ sentence: 'Asked for help; the helper did not answer (failed).' });
    expect(await run(helpUnansweredCheck as unknown as WatchCheck, s, ended())).toEqual([{ op: 'clear', subject: 'help:h4:h4-a' }]);
  });
});

describe('the shipped ASK-C3 entries', () => {
  it('are bus entries on the team rows, joined to path.ended, advisory flags', () => {
    const { entries, refused } = loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS);
    expect(refused).toEqual([]);
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get('path-repicked')).toMatchObject({
      on: { source: 'bus', type: PATH_REPICKED_TYPE },
      join: [{ source: 'bus', type: PATH_ENDED_TYPE }],
      check: 'deterministic:path_repicked',
      emit: { as: 'flag', watch_kind: 'problem' },
      enabled: true,
    });
    expect(byId.get('reviewer-absent')).toMatchObject({
      on: { source: 'bus', type: MEMBER_JOINED_TYPE },
      join: [{ source: 'bus', type: PATH_ENDED_TYPE }],
      emit: { as: 'flag', watch_kind: 'quiet' },
    });
    expect(byId.get('help-unanswered')).toMatchObject({
      on: { source: 'bus', type: HELP_ANSWERED_TYPE },
      join: [{ source: 'bus', type: HELP_REQUESTED_TYPE }, { source: 'bus', type: PATH_ENDED_TYPE }],
      emit: { as: 'flag', watch_kind: 'quiet' },
    });
    const r = new Router(entries.filter((e) => ['path-repicked', 'reviewer-absent', 'help-unanswered'].includes(e.id)));
    expect(r.busTypes().sort()).toEqual([HELP_ANSWERED_TYPE, HELP_REQUESTED_TYPE, MEMBER_JOINED_TYPE, PATH_ENDED_TYPE, PATH_REPICKED_TYPE].sort());
  });
});

// ── end to end over the bus ───────────────────────────────────────────────────

let dir: string;
let busPath: string;
let registries: WatchRegistry[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watch-ask-c3-'));
  busPath = join(dir, 'bus', 'bus.db');
  registries = [];
});

afterEach(async () => {
  for (const r of registries) await r.stop();
  removeScratch(dir);
});

async function emitTeam(type: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await emitOnBus(busPath, {
    event_type: type,
    domain: 'wicked-team',
    subdomain: type.split('.')[2]!,
    idempotency_key: key,
    payload: { run_id: 'run-9', ord: 1, attempt: 0, by: 'engine', at: Date.now(), re: null, ...payload },
  });
}

async function watchRows(): Promise<Array<{ event_type: string; payload: WatchFinding }>> {
  return (await readBus(busPath, WATCH_FINDING_PREFIX, { history: true })).map((r) => ({ event_type: r.event_type, payload: r.payload as WatchFinding }));
}

describe('ASK-C3 through the registry', () => {
  it('a pulled path.repicked row raises a problem flag; the pulled path.ended clears it', async () => {
    const d = join(dir, 'entries');
    mkdirSync(d, { recursive: true });
    for (const e of loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS).entries.filter((x) => x.on.source === 'internal' || x.id === 'path-repicked')) {
      writeFileSync(join(d, `${e.id}.json`), JSON.stringify(e));
    }
    const r = new WatchRegistry({
      dbPath: busPath,
      settings: async () => undefined,
      projectOf: () => 'proj-1',
      flushMs: 0,
      tickMs: 0,
      pollIntervalMs: 20,
      sleep: async () => undefined,
      entriesDir: d,
    });
    registries.push(r);
    await r.arm();
    await emitTeam(PATH_REPICKED_TYPE, 'team:repick:run-9:1', { from: 'claude', to: 'codex', reason: 'timed_out', selection: 'random', pick_seq: 1 });
    const poll = async (want: number) => {
      let rows: Awaited<ReturnType<typeof watchRows>> = [];
      for (let i = 0; i < 100 && rows.length < want; i++) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await r.flush();
        rows = await watchRows();
      }
      return rows;
    };
    const raisedRows = await poll(1);
    expect(raisedRows.map((x) => x.event_type)).toEqual([WATCH_FINDING_RAISED]);
    expect(raisedRows[0]!.payload).toMatchObject({ entry_id: 'path-repicked', kind: 'flag', watch_kind: 'problem', run_id: 'run-9', project_id: 'proj-1' });
    expect(r.feed({ run: 'run-9' }).findings).toHaveLength(1);
    await emitTeam(PATH_ENDED_TYPE, 'team:ended:run-9', { ord: null, attempt: null, status: 'completed' });
    const rows = await poll(2);
    expect(rows.map((x) => x.event_type)).toEqual([WATCH_FINDING_RAISED, WATCH_FINDING_CLEARED]);
    expect(r.feed({ run: 'run-9' }).cleared).toHaveLength(1);
  });
});
