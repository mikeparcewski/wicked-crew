// The crew-side eval RUN history store (EvalRunStore) — the durable seam behind the Evals section.
//
// Unit-level, no server: construct over an explicit temp root with pinned `now`/`mintId` seams and
// assert the record → list → get contract, the newest-first + filter behavior, and the tolerant
// reads (a torn index line, a missing detail file) the store owes so one bad row never blanks the
// history.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalRunStore, defaultEvalStoreRoot, type RecordEvalRunInput } from '../src/api/eval-store.js';
import { removeScratch } from './setup/scratch.js';
import type { GovernanceEvalResult, GovernanceEvalRuleCoverage } from '../src/core/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-store-'));
});
afterEach(() => {
  removeScratch(dir);
});

/** A results fixture spanning the three verdicts across two steering types (for per_type checks).
 *  `nearest_rules` rides the gap ONLY — the engine omits it on every other verdict (evals.rs
 *  `SampleResult`: "present on gaps (possibly empty); omitted otherwise"). */
const RESULTS: GovernanceEvalResult[] = [
  { sample: { id: 'S-1', description: 'a', kind: 'bad', steering_type: 'security' }, expected: 'deny', fired: ['POL-1'], verdict: 'caught' },
  { sample: { id: 'S-2', description: 'b', kind: 'bad', steering_type: 'security' }, expected: 'deny', fired: [], verdict: 'gap', nearest_rules: [{ rule_id: 'PAT-9', similarity: 0.5 }] },
  { sample: { id: 'S-3', description: 'c', kind: 'good', steering_type: 'development' }, expected: 'allow', fired: ['POL-2'], verdict: 'false_positive' },
];

/** The engine's rule-side coverage (core #394): one rule fired somewhere, two never did. */
const RULE_COVERAGE: GovernanceEvalRuleCoverage = {
  exercised: 1,
  unexercised: [
    { rule_id: 'PAT-9', steering_type: 'architecture' },
    { rule_id: 'POL-1801', steering_type: 'development' },
  ],
};

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

  it('S2: rejects a path-manipulation id BEFORE touching the fs — encoded, embedded-slash, backslash, NUL (Copilot #467)', async () => {
    const store = new EvalRunStore(dir, () => undefined, () => 1, () => 'run-ok');
    await store.record(input());
    // Plant a file OUTSIDE the results dir that a traversal id would otherwise reach — a
    // sentinel: if any shape below resolved it, get() would return THIS object, not null.
    writeFileSync(join(dir, 'secret.json'), JSON.stringify({ id: 'x', results: [] }), 'utf8');
    const traversal = [
      '../secret', // plain parent hop
      '..%2Fsecret', // URL-encoded separator (as a param decoder might leave it)
      '%2e%2e%2fsecret', // fully encoded `../`
      '..%5Csecret', // encoded backslash
      '..\\secret', // literal backslash (win32 separator)
      'a/../../secret', // embedded slash with a hop
      'results/../secret', // hop out of the results dir by name
      'x/y', // embedded slash, no hop
      './x', // dot-segment
      'a.b', // any `.` — an id never carries one (a `.json` suffix would double-extend)
      'run-ok.json', // the detail file's own name
      'run-ok\0', // NUL (the `\0` escape — never a raw byte in source) — a C-string truncation would resolve `run-ok`
      'run ok', // whitespace
      '', // empty
    ];
    for (const bad of traversal) {
      expect(await store.get(bad), JSON.stringify(bad)).toBeNull();
    }
    // A well-formed id still resolves.
    expect(await store.get('run-ok')).not.toBeNull();
  });

  it('S4: a torn tail line + a malformed row + a missing detail + a corrupt detail degrade ONE row each, never the store', async () => {
    let i = 0;
    const store = new EvalRunStore(dir, () => undefined, () => i, () => `run-${i++}`);
    await store.record(input()); // run-0
    await store.record(input()); // run-1
    await store.record(input()); // run-2
    const indexPath = join(dir, 'runs.jsonl');
    // Tear the LAST line mid-JSON (a crash between the detail rename and a complete append).
    const lines = readFileSync(indexPath, 'utf8').split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(3);
    const last = lines[2]!;
    writeFileSync(indexPath, `${lines.slice(0, 2).join('\n')}\n${last.slice(0, Math.floor(last.length / 2))}`, 'utf8');
    // A row that PARSES but is not a run (no id / created_at) — a malformed record shape.
    appendFileSync(indexPath, '\n{"not":"a run","results":[]}\n', 'utf8');
    // One detail gone, one detail corrupt.
    rmSync(join(dir, 'results', 'run-0.json'));
    writeFileSync(join(dir, 'results', 'run-1.json'), '{ broken', 'utf8');

    // The two intact rows still list (newest first); the torn row and the malformed row are skipped.
    expect((await store.list()).map((r) => r.id)).toEqual(['run-1', 'run-0']);
    // Missing and corrupt details are honestly null, never a throw.
    expect(await store.get('run-0')).toBeNull();
    expect(await store.get('run-1')).toBeNull();
    // The torn row's detail was written BEFORE its index line: an orphan detail is readable by id
    // (harmless, self-garbage-collecting) — the ordering guarantees a dangling row, never this.
    expect((await store.get('run-2'))?.id).toBe('run-2');
  });
});

describe('EvalRunStore — write ordering + queue recovery, proven under faults', () => {
  it('S1: the detail file lands BEFORE the index append — an index fault leaves the detail, never a dangling row', async () => {
    const warnings: string[] = [];
    const store = new EvalRunStore(dir, (m) => warnings.push(m), () => 1, () => 'run-first');
    // Make the index path a DIRECTORY: the detail write succeeds, the append fails (EISDIR).
    mkdirSync(join(dir, 'runs.jsonl'), { recursive: true });
    await expect(store.record(input())).rejects.toThrow();
    // The detail exists ⇒ it was written before the (failed) index step. Were the order reversed,
    // the failure would have happened first and no detail could exist.
    const detail = JSON.parse(readFileSync(join(dir, 'results', 'run-first.json'), 'utf8')) as { id: string; results: unknown[] };
    expect(detail.id).toBe('run-first');
    expect(detail.results).toHaveLength(3);
    // tmp+rename left no `.tmp-*` behind.
    expect(readdirSync(join(dir, 'results'))).toEqual(['run-first.json']);
    // The unreadable index reads as an EMPTY history, loudly (warned), never a throw.
    expect(await store.list()).toEqual([]);
    expect(warnings.some((w) => w.includes('could not read'))).toBe(true);
  });

  it('a failed write does not wedge the queue — the next record() goes through (eval-store.ts writeTail)', async () => {
    let i = 0;
    const store = new EvalRunStore(dir, () => undefined, () => i, () => `run-${i++}`);
    // The results DIR path pre-exists as a FILE: mkdir fails, the first write rejects.
    writeFileSync(join(dir, 'results'), 'not a directory', 'utf8');
    await expect(store.record(input())).rejects.toThrow();
    // Clear the fault; the chain must have advanced past the failure.
    rmSync(join(dir, 'results'));
    const ok = await store.record(input());
    expect(ok.id).toBe('run-1');
    expect((await store.list()).map((r) => r.id)).toEqual(['run-1']);
    expect((await store.get('run-1'))?.results).toHaveLength(3);
  });
});

describe('EvalRunStore — engine readings persist verbatim (degraded, rule_coverage)', () => {
  it('S12: degraded "facet-only" and rule_coverage ride the row AND the drilldown unchanged', async () => {
    const store = new EvalRunStore(dir, () => undefined, () => 1, () => 'run-degraded');
    await store.record(input({ degraded: 'facet-only', rule_coverage: RULE_COVERAGE }));
    const [row] = await store.list();
    expect(row!.degraded).toBe('facet-only');
    expect(row!.rule_coverage).toEqual(RULE_COVERAGE);
    const detail = await store.get('run-degraded');
    expect(detail!.degraded).toBe('facet-only');
    expect(detail!.rule_coverage).toEqual(RULE_COVERAGE);
    // The raw index line carries the engine's snake_case spelling, not a reshaped one.
    const raw = readFileSync(join(dir, 'runs.jsonl'), 'utf8');
    expect(raw).toContain('"rule_coverage":{"exercised":1,"unexercised":[{"rule_id":"PAT-9"');
    expect(raw).toContain('"degraded":"facet-only"');
  });

  it('a run recorded WITHOUT rule_coverage (pre-#394 engine) stays without it — the key is absent, not null', async () => {
    const store = new EvalRunStore(dir, () => undefined, () => 1, () => 'run-old-engine');
    await store.record(input()); // the default input carries no rule_coverage
    const [row] = await store.list();
    expect('rule_coverage' in row!).toBe(false);
    expect(row!.degraded).toBeNull(); // `degraded` is ALWAYS in-band, null included
    const detail = await store.get('run-old-engine');
    expect('rule_coverage' in detail!).toBe(false);
  });
});

describe('EvalRunStore — concurrent writes are serialized (Copilot #467)', () => {
  it('S3: 50 records fired concurrently all land as whole, parseable index lines (no interleaving)', async () => {
    let i = 0;
    const store = new EvalRunStore(dir, () => undefined, () => i, () => `run-${i++}`);
    // Fire 50 records at once — without serialization their index appends could interleave.
    await Promise.all(Array.from({ length: 50 }, () => store.record(input())));

    // Every non-empty index line parses (no torn/interleaved lines) and all 50 ids are present once.
    const lines = readFileSync(join(dir, 'runs.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(50);
    const ids = lines.map((l) => (JSON.parse(l) as { id: string }).id); // throws if any line is torn
    expect(new Set(ids).size).toBe(50);
    // Append order is the serialized order: run-0 first … run-49 last (no reordering either).
    expect(ids).toEqual(Array.from({ length: 50 }, (_, n) => `run-${n}`));
    expect(await store.list()).toHaveLength(50);
    // Every listed row resolves to its detail — no dangling row among the 50.
    expect(readdirSync(join(dir, 'results')).filter((f) => f.endsWith('.json'))).toHaveLength(50);
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
