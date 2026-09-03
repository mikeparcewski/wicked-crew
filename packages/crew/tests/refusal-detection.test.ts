// Unit tests: gate-prompt refusal detection (src/api/gate-cache.ts, issue #419).
//
// The gate wire gains an ADDITIVE `refusal` warning when a paused unit's prompt reads as a pure
// sandbox/tool refusal — the worker reported it could not act, with no sign of productive work — so
// an operator does not approve a refusal as if it were work. The signal never gates a decision, and
// the detection MUST run identically on the live-fold, replay, and durable-row paths. The bias is
// toward NOT flagging: a genuine work transcript that mentions "sandbox"/"blocked", or a mixed turn
// that refused one tool but did real work elsewhere, must stay unflagged.

import { describe, expect, it } from 'vitest';
import { GateCache, detectRefusal } from '../src/api/gate-cache.js';
import type { CoreEvent } from '../src/core/types.js';

const RUN = 'run-419-refusal';

function gatePrompt(prompt: string): CoreEvent {
  return { type: 'awaitingHuman', session: RUN, ts: 1_785_614_004_730, ord: 4, prompt } as CoreEvent;
}

describe('detectRefusal (issue #419)', () => {
  it('flags a pure sandbox refusal with a reason', () => {
    const r = detectRefusal('Blocked by the managed read-only sandbox: writes are rejected.');
    expect(r?.matched).toBe(true);
    expect(typeof r?.reason).toBe('string');
  });

  it('flags the real codex read-only-workspace shape', () => {
    const r = detectRefusal(
      'Blocked by this read-only workspace; I could not modify or regenerate files.',
    );
    expect(r?.matched).toBe(true);
  });

  it('does NOT flag a genuine work transcript that merely mentions sandbox/blocked', () => {
    expect(
      detectRefusal('I updated the sandbox config and the previously blocked test now passes.'),
    ).toBeUndefined();
  });

  it('does NOT flag a mixed turn that refused one tool but did real work', () => {
    // The exact adversarial case: a refusal phrase AND real work in the same transcript.
    expect(
      detectRefusal('network access was unavailable; I fixed the bug and ran tests — 43 passed.'),
    ).toBeUndefined();
  });

  it('does NOT flag a mixed turn reporting a git-stat summary (Copilot #433 — "N files changed")', () => {
    // The git diff-stat phrasing is files-FIRST, distinct from "changed N files".
    expect(
      detectRefusal('Some writes were rejected, but I recovered: 3 files changed, 12 insertions(+).'),
    ).toBeUndefined();
  });

  it('returns undefined for a normal gate prompt', () => {
    expect(detectRefusal('Approve the output of unit 1 (clarify — Fix issue #419).')).toBeUndefined();
  });
});

describe('GateCache carries the refusal warning', () => {
  it('a refusal prompt lands a refusal on the cache entry (live ingest)', () => {
    const cache = new GateCache();
    cache.ingest(gatePrompt('Blocked by this read-only workspace; writes are rejected.'));
    expect(cache.get(RUN)?.refusal?.matched).toBe(true);
  });

  it('a normal gate entry has NO refusal key — the wire stays byte-identical', () => {
    const cache = new GateCache();
    cache.ingest(gatePrompt('Approve unit 4 before it runs: adversarial-review'));
    const entry = cache.get(RUN)!;
    expect('refusal' in entry).toBe(false);
  });

  it('live ingest and durable replay agree on the refusal', () => {
    const prompt = 'Blocked by the managed read-only sandbox: writes are rejected.';
    const live = new GateCache();
    live.ingest(gatePrompt(prompt));
    const replayed = new GateCache().rebuild(RUN, [gatePrompt(prompt)]);
    expect(replayed?.refusal).toEqual(live.get(RUN)?.refusal);
    expect(replayed?.refusal?.matched).toBe(true);
  });
});
