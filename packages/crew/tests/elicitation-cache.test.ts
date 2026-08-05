// Unit tests: elicitation prompt cache (src/api/elicitation-cache.ts, DES-002).
//
// The ElicitationCache is the server-side display store for a run's current pending
// elicitation. Key properties under test:
//   - create/get/take lifecycle
//   - Generation-based restoreIfUnchanged (prevents zombie entries)
//   - ingest terminal events prune entries
//   - reconcile bumps gen for absent terminal runs (F8 from DES-002)

import { describe, expect, it } from 'vitest';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreEvent, SessionView } from '../src/core/types.js';

const RUN = 'run-elicit-cache-001';
const OTHER = 'run-elicit-cache-other';

function makeEntry(overrides: {
  runId?: string;
  elicitationId?: string;
  message?: string;
  options?: string[] | null;
} = {}) {
  return {
    runId: overrides.runId ?? RUN,
    elicitationId: overrides.elicitationId ?? 'e-001',
    message: overrides.message ?? 'What colour?',
    options: overrides.options !== undefined ? overrides.options : null,
  };
}

function event(type: string, extra: Record<string, unknown> = {}): CoreEvent {
  return { type, session: RUN, ...extra } as CoreEvent;
}

/** Minimal SessionView for reconcile — only the two fields reconcile reads. */
function view(id: string, status: string): SessionView {
  return { session: { id, status }, units: [] } as unknown as SessionView;
}

describe('ElicitationCache', () => {
  it('create then get returns the entry with a receivedAt ISO-8601 timestamp', () => {
    const cache = new ElicitationCache();
    cache.create(makeEntry());
    const got = cache.get(RUN);
    expect(got).toMatchObject({
      runId: RUN,
      elicitationId: 'e-001',
      message: 'What colour?',
      options: null,
    });
    expect(got?.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('take returns {entry,gen} for a known run and undefined for an unknown run', () => {
    const cache = new ElicitationCache();
    cache.create(makeEntry());
    const taken = cache.take(RUN);
    expect(taken).toBeDefined();
    expect(taken!.entry).toMatchObject({ runId: RUN, elicitationId: 'e-001' });
    expect(typeof taken!.gen).toBe('number');
    // Unknown run → undefined
    expect(cache.take('nobody')).toBeUndefined();
  });

  it('get returns undefined after take (entry was atomically removed)', () => {
    const cache = new ElicitationCache();
    cache.create(makeEntry());
    cache.take(RUN);
    expect(cache.get(RUN)).toBeUndefined();
  });

  it('a second create for the same runId replaces the first entry', () => {
    const cache = new ElicitationCache();
    cache.create(makeEntry({ elicitationId: 'e-001' }));
    cache.create(makeEntry({ elicitationId: 'e-002' }));
    expect(cache.get(RUN)?.elicitationId).toBe('e-002');
  });

  it('ingest sessionCompleted deletes the entry for that run', () => {
    const cache = new ElicitationCache();
    cache.create(makeEntry());
    cache.ingest(event('sessionCompleted'));
    expect(cache.get(RUN)).toBeUndefined();
  });

  it('ingest resumed does NOT delete the entry', () => {
    // resumed ≠ terminal — an elicitation can survive a resume in theory.
    const cache = new ElicitationCache();
    cache.create(makeEntry());
    cache.ingest(event('resumed'));
    expect(cache.get(RUN)).toBeDefined();
  });

  it('ingest elicitationCreated stores an entry with the given options', () => {
    const cache = new ElicitationCache();
    cache.ingest(event('elicitationCreated', {
      elicitationId: 'e-ingest',
      message: 'Choose:',
      options: ['alpha', 'beta'],
    }));
    expect(cache.get(RUN)).toMatchObject({
      runId: RUN,
      elicitationId: 'e-ingest',
      message: 'Choose:',
      options: ['alpha', 'beta'],
    });
  });

  it('reconcile drops terminal-status entries and retains executing entries', () => {
    const cache = new ElicitationCache();
    cache.create(makeEntry({ runId: RUN }));
    cache.create(makeEntry({ runId: OTHER }));
    cache.reconcile([view(RUN, 'executing'), view(OTHER, 'completed')]);
    expect(cache.get(RUN)).toBeDefined();
    expect(cache.get(OTHER)).toBeUndefined();
  });

  it('ingest elicitationCreated with no options field normalises to null', () => {
    // The wire carries options:null for free-text; absent normalises the same way.
    const cache = new ElicitationCache();
    cache.ingest(event('elicitationCreated', { elicitationId: 'e-ft', message: 'Type anything' }));
    expect(cache.get(RUN)?.options).toBeNull();
  });

  it('reconcile bumps gen for absent terminal runs so restoreIfUnchanged returns false (F8)', () => {
    // Scenario: POST takes the entry (entry absent); a reconcile tick identifies the run as
    // terminal (e.g. runCancelled event was missed). The subsequent restoreIfUnchanged in the
    // POST error path must be a no-op.
    const cache = new ElicitationCache();
    cache.create(makeEntry());
    const taken = cache.take(RUN)!;
    expect(taken).toBeDefined();

    // Run is now terminal but entry is absent (taken above).
    cache.reconcile([view(RUN, 'completed')]);

    // restoreIfUnchanged must see the gen bump and bail.
    expect(cache.restoreIfUnchanged(RUN, taken.entry, taken.gen)).toBe(false);
    expect(cache.get(RUN)).toBeUndefined();
  });
});
