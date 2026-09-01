// The doc-delete ledger sweep (crew#338): `InteractiveHandoffLedger.removeDoc` + the
// four-ledger `sweepDocLedgers` aggregate. What is pinned here is the reason the issue exists:
// the DRAFT leg keys by document id, so a row that outlives its doc claims the name forever —
// removal must therefore hit BOTH key grammars (exact `<doc>` and every `<doc>:<suffix>`),
// persist durably, stay idempotent (at-least-once redelivery), and never bleed into a sibling
// doc whose name shares a prefix.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveHandoffLedger } from '../src/interactive/ledger.js';
import { sweepDocLedgers } from '../src/interactive/doc-ledger-sweep.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-docdel-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('InteractiveHandoffLedger.removeDoc', () => {
  it('removes BOTH key grammars: the exact doc id and every `<doc>:<suffix>` row', () => {
    const path = join(dir, 'ledger.json');
    const ledger = new InteractiveHandoffLedger(path);
    ledger.recordLaunch('my-doc', 'run-1'); // draft/demo grammar
    ledger.recordLaunch('my-doc:v3', 'run-2'); // edit/demo handoff grammar
    ledger.recordLaunch('my-doc:m:abc123', 'run-3'); // chat grammar (message id)
    ledger.recordLaunch('my-doc:e:42', 'run-4'); // chat grammar (event id)
    ledger.recordLaunch('other-doc', 'run-5');

    const removed = ledger.removeDoc('my-doc');
    expect(removed.sort()).toEqual(['my-doc', 'my-doc:e:42', 'my-doc:m:abc123', 'my-doc:v3']);
    expect(ledger.has('my-doc')).toBe(false);
    expect(ledger.has('other-doc')).toBe(true);
  });

  it('never touches a sibling doc whose name shares a prefix (the `:` fence)', () => {
    const ledger = new InteractiveHandoffLedger(join(dir, 'ledger.json'));
    ledger.recordLaunch('my-doc-two', 'run-1');
    ledger.recordLaunch('my-doc-two:v1', 'run-2');
    expect(ledger.removeDoc('my-doc')).toEqual([]);
    expect(ledger.has('my-doc-two')).toBe(true);
    expect(ledger.has('my-doc-two:v1')).toBe(true);
  });

  it('persists the removal durably — a fresh load no longer sees the rows', () => {
    const path = join(dir, 'ledger.json');
    const ledger = new InteractiveHandoffLedger(path);
    ledger.recordLaunch('my-doc', 'run-1');
    ledger.recordLaunch('my-doc:v2', 'run-2');
    ledger.removeDoc('my-doc');
    const reloaded = new InteractiveHandoffLedger(path);
    expect(reloaded.size()).toBe(0);
    // …and the same name is claimable again: the whole point of crew#338.
    expect(reloaded.has('my-doc')).toBe(false);
  });

  it('is idempotent, and a no-op sweep does not create or rewrite the file', () => {
    const path = join(dir, 'ledger.json');
    const ledger = new InteractiveHandoffLedger(path);
    expect(ledger.removeDoc('never-there')).toEqual([]);
    expect(existsSync(path)).toBe(false); // nothing removed ⇒ nothing written

    ledger.recordLaunch('my-doc', 'run-1');
    expect(ledger.removeDoc('my-doc')).toEqual(['my-doc']);
    expect(ledger.removeDoc('my-doc')).toEqual([]); // the redelivery case
  });
});

describe('sweepDocLedgers', () => {
  it('prefers a LIVE ledger instance and falls back to the file for un-armed seams', () => {
    const livePath = join(dir, 'draft.json');
    const filePath = join(dir, 'edit.json');
    const live = new InteractiveHandoffLedger(livePath);
    live.recordLaunch('my-doc', 'run-1');
    // The un-armed seam's ledger exists only as a FILE from a previous daemon lifetime.
    const previous = new InteractiveHandoffLedger(filePath);
    previous.recordLaunch('my-doc:v2', 'run-2');

    const sweep = sweepDocLedgers('my-doc', [
      { name: 'draft', ledger: live, path: livePath },
      { name: 'edit', path: filePath },
    ]);
    expect(sweep.ok).toBe(true);
    expect(sweep.removed_keys.sort()).toEqual(['my-doc', 'my-doc:v2']);
    // The live instance itself was swept — its next persist cannot resurrect the row.
    expect(live.has('my-doc')).toBe(false);
    expect(new InteractiveHandoffLedger(filePath).size()).toBe(0);
  });

  it('a live instance is authoritative over its file (a file-only rewrite would be undone)', () => {
    const path = join(dir, 'draft.json');
    const live = new InteractiveHandoffLedger(path);
    live.recordLaunch('my-doc', 'run-1');
    live.recordLaunch('other-doc', 'run-2');

    sweepDocLedgers('my-doc', [{ name: 'draft', ledger: live, path }]);
    // The seam keeps writing after the sweep — the removed row must NOT ride back in.
    live.recordEmitted('other-doc');
    const reloaded = new InteractiveHandoffLedger(path);
    expect(reloaded.has('my-doc')).toBe(false);
    expect(reloaded.has('other-doc')).toBe(true);
  });

  it('missing files sweep to nothing without creating them', () => {
    const path = join(dir, 'never-written.json');
    const sweep = sweepDocLedgers('my-doc', [{ name: 'draft', path }]);
    expect(sweep).toEqual({ ok: true, removed_keys: [] });
    expect(existsSync(path)).toBe(false);
  });

  it('NEVER throws: a failing ledger is named in `errors` while the others still get swept', () => {
    const okPath = join(dir, 'ok.json');
    const ok = new InteractiveHandoffLedger(okPath);
    ok.recordLaunch('my-doc', 'run-1');
    const broken = new InteractiveHandoffLedger(join(dir, 'broken.json'));
    broken.recordLaunch('my-doc', 'run-2');
    broken.removeDoc = () => {
      throw new Error('EACCES: permission denied');
    };

    const sweep = sweepDocLedgers('my-doc', [
      { name: 'draft', ledger: broken, path: join(dir, 'broken.json') },
      { name: 'edit', ledger: ok, path: okPath },
    ]);
    expect(sweep.ok).toBe(false);
    expect(sweep.removed_keys).toEqual(['my-doc']); // the healthy ledger was still swept
    expect(sweep.errors).toEqual([{ ledger: 'draft', error: 'EACCES: permission denied' }]);
  });

  it('sweeps a hand-corrupted sibling row set without touching valid rows (malformed file)', () => {
    // A malformed ledger file loads empty (the constructor's posture) — the sweep then removes
    // nothing and reports ok, rather than failing the whole delete.
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{not json', 'utf8');
    const sweep = sweepDocLedgers('my-doc', [{ name: 'draft', path }]);
    expect(sweep).toEqual({ ok: true, removed_keys: [] });
    // The file itself is untouched (nothing removed ⇒ nothing rewritten).
    expect(readFileSync(path, 'utf8')).toBe('{not json');
  });
});
