// A6 / PLAN G12: what crew checked on each run's document before it landed (the floor, its page count, the writer's
// notes), served on the checks read by the version interactive records each run on — notes from the nearest ancestor
// whose run recorded them, the floor only for the version's own run ("not measured" for a hand version).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocChecksResponse } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import { registerInteractiveDocChecks } from '../src/interactive/doc-checks-routes.js';
import { LandingRecordStore, parseNotes, recordLanding } from '../src/interactive/landing-record.js';
import { readLineage } from '../src/interactive/doc-checks-routes.js';
import { removeScratch } from './setup/scratch.js';

describe('the landing record and the checks read', () => {
  let dir: string;
  let app: FastifyInstance;
  let store: LandingRecordStore;
  const docs = (): string => join(dir, 'docs');

  /** A document's manifest: v0 root, v1 by run-a, v2 by hand, v3 by run-b (no notes), v4 a hand fork of v1. */
  const manifest = (versions: Array<Record<string, unknown>>, head: number): void => {
    mkdirSync(join(docs(), 'note'), { recursive: true });
    writeFileSync(join(docs(), 'note', 'versions.json'), JSON.stringify({ head, versions }), 'utf8');
  };
  const record = (runId: string, notes: boolean, struck: Array<{ token: string; reason: string }> = []): void => {
    const out = join(dir, `${runId}.html`);
    writeFileSync(out, `<p>${runId}</p>`, 'utf8');
    const notesPath = join(dir, `${runId}-notes.json`);
    if (notes) writeFileSync(notesPath, JSON.stringify({ left_out: [{ claim: `from ${runId}`, why: 'no record' }], sources: [{ token: 'chat', used: true }], assumptions: [] }), 'utf8');
    recordLanding(store, { ref: 'kes/note', runId, outPath: out, notesPath, floor: { verdict: 'pass', summary: 'ok', pages: { count: 1, measured: true, budget: 1, exact: true } }, struck });
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-landing-'));
    store = new LandingRecordStore(join(dir, 'landings'));
    app = Fastify();
    const adapter = { projectGet: async (id: string) => (id === 'kes' ? { id } : null) } as unknown as CoreAdapter;
    registerInteractiveDocChecks(app, adapter, { reviewsDir: () => join(dir, '_reviews'), landings: store, docsRoot: async () => docs() });
    await app.ready();
    manifest(
      [
        { version: 0, parent: null },
        { version: 1, parent: 0, kind: 'generated', run_id: 'run-a' },
        { version: 2, parent: 1, kind: 'deterministic', run_id: null },
        { version: 3, parent: 2, kind: 'generated', run_id: 'run-b' },
        { version: 4, parent: 1, kind: 'fork', run_id: null },
      ],
      3,
    );
    record('run-a', true, [{ token: 'run:9f9f9f9f', reason: 'not named in this chat' }]);
    // codex r1: crew's struck sources on a run with no writer notes never stand in for notes (the ancestor's still show).
    record('run-b', false, [{ token: 'run:1a1a1a1a', reason: 'gone' }]);
  });
  afterEach(async () => {
    await app.close();
    removeScratch(dir);
  });

  const get = async (q: string): Promise<DocChecksResponse> =>
    (await app.inject({ method: 'GET', url: `/api/v1/projects/kes/interactive/docs/note/checks${q}` })).json() as DocChecksResponse;

  it("a run's own version shows its floor; notes come from the nearest ancestor that recorded them, labelled", async () => {
    const head = await get('');
    expect(head.floor).toMatchObject({ source: 'floor', version: 3, run_id: 'run-b', verdict: 'pass', pages: { count: 1, measured: true } });
    expect(head.notes).toMatchObject({ from_version: 1, run_id: 'run-a', left_out: [{ claim: 'from run-a', why: 'no record' }] });
    const v1 = await get('?version=1');
    expect(v1.floor?.run_id).toBe('run-a');
    expect(v1.notes?.struck).toEqual([{ token: 'run:9f9f9f9f', reason: 'not named in this chat' }]);
  });

  it('a version a person made shows "not measured" for the floor and its ancestor\'s notes', async () => {
    const hand = await get('?version=2');
    expect(hand.floor).toBeNull();
    expect(hand.notes?.from_version).toBe(1);
    expect((await get('?version=4')).notes?.from_version).toBe(1);
  });

  it('no run on the lineage recorded notes: null, never an empty list passed off as clean', async () => {
    expect((await get('?version=0')).notes).toBeNull();
    expect((await get('?version=0')).floor).toBeNull();
  });

  it('only the three fields a valid notes.json holds are kept', () => {
    expect(parseNotes({ left_out: [], sources: [], assumptions: ['a'] })).toEqual({ left_out: [], sources: [], assumptions: ['a'] });
    // Anything else in it makes it not the one shape (as garden's notes_check says): never read past.
    expect(parseNotes({ left_out: [], sources: [], assumptions: ['a'], steer: 'x' })).toBeNull();
    expect(parseNotes({ left_out: [] })).toBeNull();
    expect(parseNotes([])).toBeNull();
    // Strict: one bad entry makes the file invalid (never a reduced valid-looking copy); lengths count code points.
    expect(parseNotes({ left_out: [{ claim: 'x', why: 'y' }, { claim: '' }], sources: [], assumptions: [] })).toBeNull();
    expect(parseNotes({ left_out: [], sources: [], assumptions: ['😀'.repeat(600)] })?.assumptions).toHaveLength(1);
  });

  it('a run id that is an object property is no record (codex r1)', async () => {
    const lineage = readLineage(docs(), 'note')!;
    lineage.versions.set(5, { parent: 3, runId: 'constructor' });
    expect(store.get('kes/note', 'constructor')).toBeNull();
  });

  it('a failing floor lands nothing, so it is never recorded', () => {
    const out = join(dir, 'x.html');
    writeFileSync(out, '<p>x</p>', 'utf8');
    recordLanding(store, { ref: 'kes/note', runId: 'run-x', outPath: out, notesPath: join(dir, 'none.json'), floor: { verdict: 'fail', summary: 'no' } });
    expect(store.get('kes/note', 'run-x')).toBeNull();
  });
});
