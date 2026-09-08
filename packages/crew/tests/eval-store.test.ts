// The crew-side eval RUN history store (EvalRunStore) — the durable seam behind the Evals section.
//
// Unit-level, no server: construct over an explicit temp root with pinned `now`/`mintId` seams and
// assert the record → list → get contract, the newest-first + filter behavior, and the tolerant
// reads (a torn index line, a missing detail file) the store owes so one bad row never blanks the
// history.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalRunStore, defaultEvalStoreRoot, type RecordEvalRunInput } from '../src/api/eval-store.js';
import { removeScratch } from './setup/scratch.js';
import type { GovernanceEvalResult } from '../src/core/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-store-'));
});
afterEach(() => {
  removeScratch(dir);
});

/** A results fixture spanning the three verdicts across two steering types (for per_type checks). */
const RESULTS: GovernanceEvalResult[] = [
  { sample: { id: 'S-1', description: 'a', kind: 'bad', steering_type: 'security' }, expected: 'deny', fired: ['POL-1'], verdict: 'caught' },
  { sample: { id: 'S-2', description: 'b', kind: 'bad', steering_type: 'security' }, expected: 'deny', fired: [], verdict: 'gap', nearest_rules: [{ rule_id: 'PAT-9', similarity: 0.5 }] },
  { sample: { id: 'S-3', description: 'c', kind: 'good', steering_type: 'development' }, expected: 'allow', fired: ['POL-2'], verdict: 'false_positive', nearest_rules: [] },
];

function input(over: Partial<RecordEvalRunInput> = {}): RecordEvalRunInput {
  return {
    actor: 'mikeparcewski',
    corpus: null,
    type_filter: null,
    rule_store: '/home/x/.wicked-estate/core.db',
    summary: { total: 3, caught: 1, gaps: 1, false_positives: 1 },
    per_type: {
      security: { total: 2, caught: 1, gaps: 1, false_positives: 0 },
      development: { total: 1, caught: 0, gaps: 0, false_positives: 1 },
    },
    degraded: null,
    results: RESULTS,
    ...over,
  };
}

describe('EvalRunStore — record / list / get', () => {
  it('records a run, mints id + created_at, and lists the rollup WITHOUT results', async () => {
    const store = new EvalRunStore(dir, () => undefined, () => 1_700_000_100, () => 'run-1');
    const summary = await store.record(input());
    expect(summary.id).toBe('run-1');
    expect(summary.created_at).toBe(1_700_000_100);
    expect(summary.actor).toBe('mikeparcewski');

    const [row, ...rest] = await store.list();
    expect(rest).toHaveLength(0);
    expect(row!.id).toBe('run-1');
    expect(row!.summary).toEqual({ total: 3, caught: 1, gaps: 1, false_positives: 1 });
    expect(row!.per_type?.security).toEqual({ total: 2, caught: 1, gaps: 1, false_positives: 0 });
    // The LIST row is a rollup only — the heavy per-sample results are not on it.
    expect('results' in row!).toBe(false);
  });

  it('get() returns the full run WITH results; an unknown id is null', async () => {
    const store = new EvalRunStore(dir, () => undefined, () => 1, () => 'run-x');
    await store.record(input());
    const detail = await store.get('run-x');
    expect(detail).not.toBeNull();
    expect(detail!.results).toHaveLength(3);
    expect(detail!.results[1]!.verdict).toBe('gap');
    expect(await store.get('does-not-exist')).toBeNull();
  });

  it('lists newest first (append order reversed)', async () => {
    let n = 0;
    const store = new EvalRunStore(dir, () => undefined, () => 1_700_000_000 + n, () => `run-${n++}`);
    await store.record(input()); // run-0
    await store.record(input()); // run-1
    await store.record(input()); // run-2
    expect((await store.list()).map((r) => r.id)).toEqual(['run-2', 'run-1', 'run-0']);
  });

  it('an empty (never-written) store lists empty, never throws', async () => {
    const store = new EvalRunStore(join(dir, 'nope'), () => undefined);
    expect(await store.list()).toEqual([]);
    expect(await store.get('anything')).toBeNull();
    // Listing must not have created the root — the store writes lazily, on first record.
    expect(existsSync(join(dir, 'nope'))).toBe(false);
  });
});

describe('EvalRunStore — filters', () => {
  it('narrows the list by type_filter and by corpus', async () => {
    let i = 0;
    const store = new EvalRunStore(dir, () => undefined, () => i, () => `run-${i++}`);
    await store.record(input({ type_filter: 'security', corpus: null }));
    await store.record(input({ type_filter: null, corpus: 'evals:dev' }));
    await store.record(input({ type_filter: 'security', corpus: 'evals:dev' }));

    expect((await store.list({ type_filter: 'security' })).map((r) => r.id).sort()).toEqual(['run-0', 'run-2']);
    expect((await store.list({ corpus: 'evals:dev' })).map((r) => r.id).sort()).toEqual(['run-1', 'run-2']);
    expect((await store.list({ type_filter: null })).map((r) => r.id)).toEqual(['run-1']);
    // A filter that matches nothing is an empty list, not an error.
    expect(await store.list({ corpus: 'evals:missing' })).toEqual([]);
  });
});

describe('EvalRunStore — tolerant reads (one bad row never blanks the history)', () => {
  it('skips a torn index line but keeps the readable rows', async () => {
    let i = 0;
    const store = new EvalRunStore(dir, () => undefined, () => i, () => `run-${i++}`);
    await store.record(input()); // run-0
    await store.record(input()); // run-1
    // Corrupt the middle of the index with a torn line (a crash-torn append).
    appendFileSync(join(dir, 'runs.jsonl'), '{ this is not json\n', 'utf8');
    await store.record(input()); // run-2
    expect((await store.list()).map((r) => r.id)).toEqual(['run-2', 'run-1', 'run-0']);
  });

  it('a listed row whose detail file is gone → get() is null, list() still shows the row', async () => {
    const store = new EvalRunStore(dir, () => undefined, () => 1, () => 'run-gone');
    await store.record(input());
    rmSync(join(dir, 'results', 'run-gone.json'));
    expect((await store.list()).map((r) => r.id)).toEqual(['run-gone']); // the rollup survives
    expect(await store.get('run-gone')).toBeNull(); // the drilldown is honestly absent
  });

  it('a detail file with malformed JSON → get() is null, not a throw', async () => {
    const store = new EvalRunStore(dir, () => undefined, () => 1, () => 'run-bad');
    await store.record(input());
    writeFileSync(join(dir, 'results', 'run-bad.json'), '{ broken', 'utf8');
    expect(await store.get('run-bad')).toBeNull();
  });

  it('rejects a path-manipulation id BEFORE touching the fs (Copilot #467)', async () => {
    const store = new EvalRunStore(dir, () => undefined, () => 1, () => 'run-ok');
    await store.record(input());
    // Plant a file OUTSIDE the results dir that a traversal id would otherwise reach.
    writeFileSync(join(dir, 'secret.json'), JSON.stringify({ id: 'x', results: [] }), 'utf8');
    for (const bad of ['../secret', '..%2Fsecret', 'a/../../secret', 'a.b', 'x/y', './x', '']) {
      expect(await store.get(bad)).toBeNull();
    }
    // A well-formed id still resolves.
    expect(await store.get('run-ok')).not.toBeNull();
  });
});

describe('EvalRunStore — concurrent writes are serialized (Copilot #467)', () => {
  it('records fired concurrently all land as whole, parseable index lines (no interleaving)', async () => {
    let i = 0;
    const store = new EvalRunStore(dir, () => undefined, () => i, () => `run-${i++}`);
    // Fire 25 records at once — without serialization their index appends could interleave.
    await Promise.all(Array.from({ length: 25 }, () => store.record(input())));

    // Every non-empty index line parses (no torn/interleaved lines) and all 25 ids are present once.
    const lines = readFileSync(join(dir, 'runs.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(25);
    const ids = lines.map((l) => (JSON.parse(l) as { id: string }).id); // throws if any line is torn
    expect(new Set(ids).size).toBe(25);
    expect((await store.list())).toHaveLength(25);
  });
});

describe('EvalRunStore — root resolution', () => {
  it('defaultEvalStoreRoot honors the WICKED_CREW_EVAL_STORE override (the tests-pin precedent)', () => {
    expect(defaultEvalStoreRoot({ WICKED_CREW_EVAL_STORE: '/tmp/pinned/evals' })).toBe('/tmp/pinned/evals');
    // No override → the state home's `evals/` (ends in the store's own segment).
    expect(defaultEvalStoreRoot({}).endsWith(join('.wicked-crew', 'evals'))).toBe(true);
  });

  it('writes a parseable one-object-per-line index and a detail file under the root', async () => {
    const root = join(dir, 'explicit');
    const store = new EvalRunStore(root, () => undefined, () => 1, () => 'r');
    await store.record(input());
    expect(existsSync(join(root, 'runs.jsonl'))).toBe(true);
    expect(existsSync(join(root, 'results', 'r.json'))).toBe(true);
    const raw = readFileSync(join(root, 'runs.jsonl'), 'utf8').trim();
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
