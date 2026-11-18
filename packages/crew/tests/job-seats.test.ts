/**
 * (F1/F2, program B7) Agents › "Use <seat> for new work" decides which seats a chat job is drawn from
 * (`newWorkSeats`, `core/job-seats.ts`). The matrix crosses rosters, picks, the chat's own seats and seat edits, and
 * states the expected seats, the blocking line and the card's words in the table, written independently of the code.
 *
 * PR 1 keeps today's seat count (`seatsNeeded`: the Plan it card needs 2, one builds and one checks); PR 2 replaces
 * it with the engine's coverage rule (core#1558).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, ChatTranscriptRecord, ProposalRevisionEdits } from '../src/core/types.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import { buildWorkflowCatalogV2, servedState, type ServedState } from '../src/workflow-catalog/build-v2.js';
import { ChatProposals, LaunchOnceRegistry, foldProposals, type ChatProposalDeps, type ProposalChat, type ProposalDispatch, type ProposalDispatcher } from '../src/api/chat-proposals.js';
import { launchRosterNaming, proposalRoster } from '../src/api/routes.js';
import { jobLaunchRoster } from '../src/api/chat-jobs.js';
import { isSeatKeyList, jobSeatPool } from '../src/core/job-seats.js';
import { removeScratch } from './setup/scratch.js';

const ME: Actor = { id: 'maria', kind: 'human', trust: 'operator' };
const CHAT = 'c1';
const dir = mkdtempSync(join(tmpdir(), 'job-seats-'));
let served: ServedState & { rev: string };

beforeAll(async () => {
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  await adapter.loadBuiltinCatalog(() => undefined);
  const defs = adapter.listWorkflows();
  const presets = await adapter.listPresets();
  const entries = await adapter.catalog();
  served = { ...servedState({ defs, presets, entries }), rev: buildWorkflowCatalogV2({ defs, presets, entries, runs: [], actorId: '', projectId: null }).rev };
  adapter.close();
});
afterAll(() => removeScratch(dir));

class FakeLauncher implements ProposalDispatcher {
  launched: ProposalDispatch[] = [];
  async find(identity: { runId: string }): Promise<boolean> { return this.launched.some((d) => d.identity.runId === identity.runId); }
  async launch(d: ProposalDispatch): Promise<void> { this.launched.push(d); }
  async live(): Promise<boolean> { return false; }
}

// GET /roster standing rows, as `proposalRoster` reads them.
const seat = (key: string, name: string, auth = 'signed_in') => ({ key, display_name: name, enabled_for_council: true, seat_eligible_for_work: true, auth });
type Standing = ReturnType<typeof seat>;
const ROSTERS: Record<string, readonly Standing[]> = {
  'Claude+Codex+Pi': [seat('claude', 'Claude'), seat('codex', 'Codex'), seat('pi', 'Pi')],
  'Claude+Codex': [seat('claude', 'Claude'), seat('codex', 'Codex')],
  'Claude alone': [seat('claude', 'Claude')],
  'Claude+Pi': [seat('claude', 'Claude'), seat('pi', 'Pi')],
  'Claude+Codex, Codex signed out': [seat('claude', 'Claude'), seat('codex', 'Codex', 'signed_out')],
};

const PICKS: Record<string, readonly string[] | null> = {
  null: null,
  all: ['claude', 'codex', 'pi'],
  'Pi off': ['claude', 'codex'],
  'Codex and Pi off': ['claude'],
  'Claude off': ['codex', 'pi'],
  none: [],
};

/** `claude`: the person chatting with Claude alone. `admitted`: the chat holds every seat studio showed (its default). */
type ChatState = 'claude' | 'admitted';

function rig(roster: string, pick: string, chatState: ChatState = 'claude', create = false) {
  let standing: readonly Standing[] = ROSTERS[roster]!;
  const records: ChatTranscriptRecord[] = [];
  const launcher = new FakeLauncher();
  const registry = new LaunchOnceRegistry();
  registry.register('job', launcher);
  const chat: ProposalChat = {
    projectId: null, repos: [{ id: 'r-pay', name: 'payments-service' }], lead: 'claude', analysis: false,
    seats: chatState === 'claude' ? ['claude'] : ROSTERS[roster]!.map((s) => s.key),
  };
  const deps: ChatProposalDeps = {
    flags: () => ({ context: true, proposals: true, create, refine: false, theme: false, demo: false }),
    catalog: CATALOG_SEEDS,
    records: () => [...records],
    append: (_c, rec) => { records.push(rec); return true; },
    instanceOf: () => 'i1',
    projectOf: () => null,
    chat: () => chat,
    rosterEligible: () => proposalRoster(standing),
    newWorkSeats: async () => PICKS[pick]!,
    runs: async () => [],
    chatOfRun: () => undefined,
    isAskPath: () => false,
    docsRoot: async () => null,
    projectName: async () => null,
    attachments: () => [],
    workflowSteps: async () => 3,
    runCostUsd: async () => null,
    registry,
    jobs: () => true,
    served: async () => served,
    qeOff: async () => false,
    preflight: async () => null,
    powerRefusal: async () => null,
    reshapeReject: async () => null,
    turnLive: () => false,
    broadcast: () => undefined,
    audit: () => undefined,
    now: () => 1_000,
  };
  const svc = new ChatProposals(deps);
  const open = (): ArtifactProposal => [...foldProposals(records).values()].find((x) => x.state === 'open' || x.state === 'revising')!.proposal;
  let n = 0;
  return {
    svc, deps, launcher, open,
    /** The roster changes under the card (a seat signs out). */
    setStanding: (rows: readonly Standing[]) => { standing = rows; },
    /** The keys of the roster a Go of `p` hands the engine (the production narrowing, `jobLaunchRoster`). */
    engineRoster: (p: Pick<ArtifactProposal, 'seats' | 'relaunch'>) => jobLaunchRoster(launchRosterNaming(standing, p.seats?.lead ?? undefined), p).roster.map((x) => String(x.key)),
    pick: (card = 'plan-it') => svc.propose(CHAT, { card, source: 'pick', requestId: `req-${card}`, words: 'plan the move to node 22' } as never, ME, 'i1'),
    swap: (edits: ProposalRevisionEdits) => svc.propose(CHAT, { revises: open().pid, edits, source: 'swap', requestId: `swap-${++n}` } as never, ME, 'i1'),
  };
}

const NEEDS_TWO = 'Needs 2 seats that can work now (one builds, the others check it); sign another seat in';
const STAYS = 'Not changed: Pi stays; this job needs 2 seats, so another seat checks the one that builds';
const OFF = (rest: string) => `Pi is off this job; ${rest} work on it`;
const NOT_ON = "Not changed: Pi isn't on this job";
const NOT_ON_PLAIN = "Not changed: pi isn't on this job";
const CANT = "Not changed: pi can't work now";

/** [roster, pick, seats with no edit, after removeSeats [pi] (seats, note), after addSeats [pi] (seats, note)]. */
type Row = [string, string, string[], [string[], string | null], [string[], string | null]];
const MATRIX: Row[] = [
  ['Claude+Codex+Pi', 'null', ['claude', 'codex', 'pi'], [['claude', 'codex'], OFF('Claude and Codex')], [['claude', 'codex', 'pi'], null]],
  ['Claude+Codex+Pi', 'all', ['claude', 'codex', 'pi'], [['claude', 'codex'], OFF('Claude and Codex')], [['claude', 'codex', 'pi'], null]],
  ['Claude+Codex+Pi', 'Pi off', ['claude', 'codex'], [['claude', 'codex'], NOT_ON], [['claude', 'codex', 'pi'], null]],
  ['Claude+Codex+Pi', 'Codex and Pi off', ['claude'], [['claude'], NOT_ON], [['claude', 'pi'], null]],
  ['Claude+Codex+Pi', 'Claude off', ['codex', 'pi'], [['codex', 'pi'], STAYS], [['codex', 'pi'], null]],
  ['Claude+Codex+Pi', 'none', [], [[], NOT_ON], [['pi'], null]],
  ['Claude+Codex', 'null', ['claude', 'codex'], [['claude', 'codex'], NOT_ON_PLAIN], [['claude', 'codex'], CANT]],
  ['Claude+Codex', 'all', ['claude', 'codex'], [['claude', 'codex'], NOT_ON_PLAIN], [['claude', 'codex'], CANT]],
  ['Claude+Codex', 'Pi off', ['claude', 'codex'], [['claude', 'codex'], NOT_ON_PLAIN], [['claude', 'codex'], CANT]],
  ['Claude+Codex', 'Codex and Pi off', ['claude'], [['claude'], NOT_ON_PLAIN], [['claude'], CANT]],
  ['Claude+Codex', 'Claude off', ['codex'], [['codex'], NOT_ON_PLAIN], [['codex'], CANT]],
  ['Claude+Codex', 'none', [], [[], NOT_ON_PLAIN], [[], CANT]],
  ['Claude alone', 'null', ['claude'], [['claude'], NOT_ON_PLAIN], [['claude'], CANT]],
  ['Claude alone', 'all', ['claude'], [['claude'], NOT_ON_PLAIN], [['claude'], CANT]],
  ['Claude alone', 'Pi off', ['claude'], [['claude'], NOT_ON_PLAIN], [['claude'], CANT]],
  ['Claude alone', 'Codex and Pi off', ['claude'], [['claude'], NOT_ON_PLAIN], [['claude'], CANT]],
  ['Claude alone', 'Claude off', [], [[], NOT_ON_PLAIN], [[], CANT]],
  ['Claude alone', 'none', [], [[], NOT_ON_PLAIN], [[], CANT]],
  ['Claude+Pi', 'null', ['claude', 'pi'], [['claude', 'pi'], STAYS], [['claude', 'pi'], null]],
  ['Claude+Pi', 'all', ['claude', 'pi'], [['claude', 'pi'], STAYS], [['claude', 'pi'], null]],
  ['Claude+Pi', 'Pi off', ['claude'], [['claude'], NOT_ON], [['claude', 'pi'], null]],
  ['Claude+Pi', 'Codex and Pi off', ['claude'], [['claude'], NOT_ON], [['claude', 'pi'], null]],
  ['Claude+Pi', 'Claude off', ['pi'], [['pi'], STAYS], [['pi'], null]],
  ['Claude+Pi', 'none', [], [[], NOT_ON], [['pi'], null]],
  ['Claude+Codex, Codex signed out', 'null', ['claude'], [['claude'], NOT_ON_PLAIN], [['claude'], CANT]],
  ['Claude+Codex, Codex signed out', 'all', ['claude'], [['claude'], NOT_ON_PLAIN], [['claude'], CANT]],
  ['Claude+Codex, Codex signed out', 'Pi off', ['claude'], [['claude'], NOT_ON_PLAIN], [['claude'], CANT]],
  ['Claude+Codex, Codex signed out', 'Codex and Pi off', ['claude'], [['claude'], NOT_ON_PLAIN], [['claude'], CANT]],
  ['Claude+Codex, Codex signed out', 'Claude off', [], [[], NOT_ON_PLAIN], [[], CANT]],
  ['Claude+Codex, Codex signed out', 'none', [], [[], NOT_ON_PLAIN], [[], CANT]],
];

const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };
const expectWords = (p: ArtifactProposal, seats: string[]) => {
  if (seats.length === 0) expect(p.seats!.label).toBe('no seat that can work now');
  for (const k of seats) expect(p.seats!.label).toContain(NAMES[k]!);
  for (const k of Object.keys(NAMES).filter((x) => !seats.includes(x))) expect(p.seats!.label).not.toContain(NAMES[k]!);
};

describe('the seats new work uses: one pool for the card, its edits and its Start (F1/F2)', () => {
  it('the matrix covers every roster and pick', () => {
    expect(MATRIX).toHaveLength(Object.keys(ROSTERS).length * Object.keys(PICKS).length);
  });

  const BOTH = MATRIX.flatMap((row) => (['claude', 'admitted'] as const).map((c) => [...row, c] as const));
  it.each(BOTH)('%s, pick %s: the card, removeSeats [pi] and addSeats [pi] (chat: %s)', async (roster, pick, seats, [afterRemove, removeNote], [afterAdd, addNote], chatState) => {
    // No edit: the card is drawn from the pick, and is blocked exactly when it has fewer than 2 seats. The chat's own
    // seats (all admitted, or Claude alone) never bring back a seat turned off for new work.
    const r = rig(roster, pick, chatState);
    expect((await r.pick()).code).toBe(201);
    const p = r.open();
    expect(p.seats!.keys).toEqual(seats);
    expectWords(p, seats);
    expect(p.blocked).toBe(seats.length < 2 ? NEEDS_TWO : null);

    // removeSeats [pi]: applied when Pi is on the job and 2 seats stay; else the card says why not.
    const rm = rig(roster, pick, chatState);
    await rm.pick();
    expect((await rm.swap({ removeSeats: ['pi'] })).code).toBe(201);
    const pr = rm.open();
    expect(pr.seats!.keys).toEqual(afterRemove);
    expectWords(pr, afterRemove);
    expect(pr.sentence!.notes).toEqual(removeNote === null ? [] : [removeNote]);
    expect(pr.blocked).toBe(afterRemove.length < 2 ? NEEDS_TWO : null);

    // addSeats [pi]: naming a seat is the opt-in, so an unpicked Pi joins; a Pi that can't work is refused in words.
    const add = rig(roster, pick, chatState);
    await add.pick();
    expect((await add.swap({ addSeats: ['pi'] })).code).toBe(201);
    const pa = add.open();
    expect(pa.seats!.keys).toEqual(afterAdd);
    expectWords(pa, afterAdd);
    expect(pa.sentence!.notes).toEqual(addNote === null ? [] : [addNote]);
    expect(pa.blocked).toBe(afterAdd.length < 2 ? NEEDS_TWO : null);
  });

  // Every startable card (no edit, removeSeats [pi], addSeats [pi]): Start hands the engine exactly the card's seats.
  const STARTABLE = MATRIX.flatMap(([roster, pick, seats, [afterRemove], [afterAdd]]) => [
    ...(seats.length >= 2 ? [[roster, pick, 'no edit', seats] as const] : []),
    ...(afterRemove.length >= 2 ? [[roster, pick, 'removeSeats [pi]', afterRemove] as const] : []),
    ...(afterAdd.length >= 2 ? [[roster, pick, 'addSeats [pi]', afterAdd] as const] : []),
  ]);
  it.each(STARTABLE)('SAYS-VS-DOES, %s, pick %s, %s: Start launches exactly the seats the card names', async (roster, pick, edit, seats) => {
    const r = rig(roster, pick, 'admitted');
    await r.pick();
    if (edit === 'removeSeats [pi]') await r.swap({ removeSeats: ['pi'] });
    if (edit === 'addSeats [pi]') await r.swap({ addSeats: ['pi'] });
    const p = r.open();
    expect(p.seats!.keys).toEqual(seats);
    const go = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code).toBe(200);
    expect(r.launcher.launched).toHaveLength(1);
    const launched = r.launcher.launched[0]!.resolution;
    expect(launched.seats!.keys).toEqual(seats);
    // The production narrowing of the daemon's launch roster to that proposal: the engine gets these seats, no more.
    expect([...r.engineRoster({ seats: launched.seats! })].sort()).toEqual([...seats].sort());
  });

  it('F2 regression: with Pi off, no card drawn by default carries Pi, whatever seats the chat holds', async () => {
    for (const roster of Object.keys(ROSTERS)) {
      for (const pick of ['Pi off', 'Codex and Pi off']) {
        for (const chatState of ['claude', 'admitted'] as const) {
          const r = rig(roster, pick, chatState);
          await r.pick();
          expect(r.open().seats!.keys, `${roster}, ${pick}, ${chatState}`).not.toContain('pi');
        }
      }
    }
  });

  it('F1 regression: "take Pi off" on Claude+Codex+Pi leaves Claude and Codex, says so, and never says Pi stays', async () => {
    const r = rig('Claude+Codex+Pi', 'null', 'admitted');
    await r.pick();
    await r.swap({ removeSeats: ['pi'] });
    const p = r.open();
    expect(p.seats!.keys).toEqual(['claude', 'codex']);
    expect(p.sentence!.notes).toEqual(['Pi is off this job; Claude and Codex work on it']);
    expectWords(p, ['claude', 'codex']);
  });

  it('a setting that cannot be read never widens the pool: the job is refused, with the reason', async () => {
    const r = rig('Claude+Codex+Pi', 'Pi off');
    r.deps.newWorkSeats = async () => { throw new Error('settings unreadable'); };
    const res = await r.pick();
    expect(res.code).toBe(409);
    expect(res.body).toMatchObject({ code: 'settings_unavailable' });
  });

  it('a removal held behind a loss question says nothing was applied (the card published still has Pi)', async () => {
    const r = rig('Claude+Codex+Pi', 'null', 'admitted');
    expect((await r.pick('feature')).code).toBe(201);
    expect(r.open().seats!.keys).toEqual(['claude', 'codex', 'pi']);
    expect((await r.swap({ card: 'plan-it', removeSeats: ['pi'] })).code).toBe(201);
    const p = r.open();
    expect(p.question?.kind).toBe('lost_check');
    expect(p.seats!.keys).toContain('pi');
    expect(p.sentence!.notes.join(' ')).not.toMatch(/off this job/);
  });

  it('a seat that signed out since the card is not counted, nor said to work on it', async () => {
    const r = rig('Claude+Codex+Pi', 'null');
    await r.pick();
    expect(r.open().seats!.keys).toEqual(['claude', 'codex', 'pi']);
    r.setStanding([seat('claude', 'Claude'), seat('codex', 'Codex'), seat('pi', 'Pi', 'signed_out')]);
    await r.swap({ removeSeats: ['claude'] });
    const p = r.open();
    expect(p.sentence!.notes).toEqual(['Not changed: Claude stays; this job needs 2 seats, so another seat checks the one that builds']);
  });
});

describe('removal words after a kind change or a sign-out (codex r2)', () => {
  it('a job made a document with a seat removed: the helper still on it is said to still work on it, never "off"', async () => {
    const r = rig('Claude+Codex+Pi', 'null', 'admitted', true);
    await r.pick();
    expect((await r.swap({ card: 'document', option: 'presentation', removeSeats: ['claude'] } as ProposalRevisionEdits)).code).toBe(201);
    let p = r.open();
    const confirm = p.question?.choices?.[0]?.edit;
    if (confirm !== undefined) {
      expect((await r.swap(confirm as ProposalRevisionEdits)).code).toBe(201);
      p = r.open();
    }
    const workers = p.seats?.keys ?? p.helpers?.seats ?? [];
    const notes = p.sentence?.notes ?? [];
    expect(confirm, 'the kind change asks before it drops checks').toBeDefined();
    expect(p.seats).toBeUndefined();
    expect(workers).toContain('claude');
    expect(notes.join(' ')).not.toMatch(/off this job/);
    expect(notes).toContain('Not changed: Claude still works on it (its helpers are picked again; change them on the card)');
  });

  it('removing a seat that signed out never says it stays: the card drops it and says so', async () => {
    const r = rig('Claude+Pi', 'null');
    await r.pick();
    expect(r.open().seats!.keys).toEqual(['claude', 'pi']);
    r.setStanding([seat('claude', 'Claude'), seat('pi', 'Pi', 'signed_out')]);
    await r.swap({ removeSeats: ['pi'] });
    const p = r.open();
    expect(p.seats!.keys).toEqual(['claude']);
    expect(p.sentence!.notes.join(' ')).not.toMatch(/stays/);
    expect(p.sentence!.notes).toEqual(['pi is off this job; Claude works on it']);
  });
});

describe('jobSeatPool and the setting value', () => {
  const eligible = [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }, { key: 'pi', name: 'Pi' }];
  it('no pick: the pool is every eligible seat; a pick keeps roster order and ignores seats that cannot work', () => {
    expect(jobSeatPool(eligible, null).pool.map((s) => s.key)).toEqual(['claude', 'codex', 'pi']);
    expect(jobSeatPool(eligible, undefined).pool.map((s) => s.key)).toEqual(['claude', 'codex', 'pi']);
    expect(jobSeatPool(eligible, ['pi', 'claude', 'gone']).pool.map((s) => s.key)).toEqual(['claude', 'pi']);
    expect(jobSeatPool(eligible, []).pool).toEqual([]);
    expect(jobSeatPool(eligible, ['pi']).eligible).toBe(eligible);
  });
  it('isSeatKeyList admits a list of seat keys only', () => {
    expect(isSeatKeyList(['claude', 'codex'])).toBe(true);
    expect(isSeatKeyList([])).toBe(true);
    for (const bad of [null, 'claude', [''], ['  '], [1], ['x'.repeat(65)], Array.from({ length: 65 }, (_, i) => `s${i}`)]) {
      expect(isSeatKeyList(bad), JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
  });
});
