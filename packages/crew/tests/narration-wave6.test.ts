// Wave 6 — the narrator consumes the new engine fields (`degradedReason` on every routing arm,
// `gateEvaluated.ungated`, `workerToolCallDenied`, the `auth_failed`/`unauthenticated` fallback
// kinds) and every seam line carries `run_id` + `unit_ord` (F-4R2-005).
import { describe, expect, it } from 'vitest';

import type { CoreEvent } from '../src/core/types.js';
import {
  acpFallbackLine,
  councilOutcomeSuffix,
  ungatedGateNote,
  workerToolCallDeniedLine,
} from '../src/interactive/council-outcome.js';
import { narrationStamps } from '../src/interactive/draft-events.js';

const ev = (o: Record<string, unknown>): CoreEvent => o as unknown as CoreEvent;

describe('councilOutcomeSuffix — degradedReason on a whole council (wave 6 semantics)', () => {
  it('quotes the engine’s degradedReason even when every convened ballot came back', () => {
    const s = councilOutcomeSuffix(
      ev({ type: 'unitDistributed', seated: 1, returned: 1, degradedReason: '4 of 5 seats benched: codex (signed out — launcher)' }),
    );
    expect(s).toBe(' (4 of 5 seats benched: codex (signed out — launcher))');
  });
  it('is empty for a whole, undegraded council', () => {
    expect(councilOutcomeSuffix(ev({ type: 'unitDistributed', seated: 5, returned: 5, degradedReason: null }))).toBe('');
  });
});

describe('ungatedGateNote (F-7R2-005)', () => {
  it('names the missing layers when the engine says the unit was UNGATED', () => {
    expect(
      ungatedGateNote(ev({ type: 'gateEvaluated', ungated: true, ungatedReason: 'no judge: no eligible judge seat distinct from creator `claude`' })),
    ).toBe('UNGATED — no judge: no eligible judge seat distinct from creator `claude`');
  });
  it('has a fallback wording when the engine gave no reason, and is null for a gated unit or an older engine', () => {
    expect(ungatedGateNote(ev({ type: 'gateEvaluated', ungated: true, ungatedReason: null }))).toMatch(/^UNGATED — nothing gated this unit/);
    expect(ungatedGateNote(ev({ type: 'gateEvaluated', ungated: false }))).toBeNull();
    expect(ungatedGateNote(ev({ type: 'gateEvaluated' }))).toBeNull();
  });
});

describe('workerToolCallDeniedLine (F-7R2-012)', () => {
  it('names the seat, its role, the refused command and the remedy', () => {
    const line = workerToolCallDeniedLine(
      ev({
        type: 'workerToolCallDenied',
        cli: 'claude',
        role: 'creator',
        tool: 'Bash',
        command: 'gh pr create --fill',
        reason: 'remote-write fence: gh pr create',
        remedy: "delivery is performed by the run's deliver phase",
      }),
    );
    expect(line).toBe("claude (creator) asked to run `gh pr create --fill` — refused: delivery is performed by the run's deliver phase");
  });
  it('degrades honestly when fields are missing', () => {
    expect(workerToolCallDeniedLine(ev({ type: 'workerToolCallDenied' }))).toBe(
      'a worker asked to run a remote-writing command — refused: delivery is performed by the run’s deliver phase',
    );
  });
});

describe('acpFallbackLine', () => {
  it('an authentication kind benches the seat (auth_failed / unauthenticated / auth_required)', () => {
    for (const kind of ['auth_failed', 'unauthenticated', 'auth_required']) {
      expect(acpFallbackLine(ev({ type: 'acpFallback', cliKey: 'pi', fallbackKind: kind }))).toContain('pi is not signed in');
      expect(acpFallbackLine(ev({ type: 'acpFallback', cliKey: 'pi', fallbackKind: kind }))).toContain('benched for this run');
    }
  });
  it('a deliberate *_requires_wrapped reroute is routing, not a drop', () => {
    expect(acpFallbackLine(ev({ type: 'acpFallback', cliKey: 'codex', fallbackKind: 'read_only_requires_wrapped' }))).toBe(
      'codex routed to single-shot mode (read only requires wrapped)…',
    );
  });
  it('anything else is the classic dropped-session line', () => {
    expect(acpFallbackLine(ev({ type: 'acpFallback', cliKey: 'codex', fallbackKind: 'session_died' }))).toBe(
      "codex's live session dropped — continuing in single-shot mode…",
    );
    expect(acpFallbackLine(ev({ type: 'acpFallback' }))).toBe("the worker's live session dropped — continuing in single-shot mode…");
  });
});

describe('narrationStamps (F-4R2-005)', () => {
  it('stamps run_id and unit_ord when known, nothing otherwise', () => {
    expect(narrationStamps({})).toEqual({});
    expect(narrationStamps({ runId: 'r-1' })).toEqual({ run_id: 'r-1' });
    expect(narrationStamps({ runId: 'r-1', narrationOrd: 3 })).toEqual({ run_id: 'r-1', unit_ord: 3 });
  });
});
