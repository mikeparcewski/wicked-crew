// (operator ruling 2026-10-14) A gate judged by a FALLBACK seat — the run's preferred judge was benched
// (codex's worktree bench) or failed as a seat — carries the engine's disclosure on its receipt
// (`assurance.judgeFallbacks`, api-types 0.121.0), and the PR body's phase table shows it beside the gate.
import { describe, expect, it } from 'vitest';
import { judgeFallbackLabel, factsFromRun } from '../src/core/deliver-text.js';
import type { SessionView } from '../src/core/types.js';

const label = "judge: agy (fallback; codex benched: codex cannot work in this run's worktree on this host)";
const fallback = { seat: 'agy', preferred: ['codex'], reason: 'codex benched: …', label };

describe('judgeFallbackLabel', () => {
  it('is the engine line, as-is', () => {
    expect(judgeFallbackLabel({ assurance: { judgeFallbacks: [fallback] } })).toBe(label);
  });
  it('is null for the run’s own judge, an older engine, or a malformed entry', () => {
    expect(judgeFallbackLabel({ assurance: { ran: ['judge'], judge: 'pi' } })).toBeNull();
    expect(judgeFallbackLabel({})).toBeNull();
    expect(judgeFallbackLabel({ assurance: null })).toBeNull();
    expect(judgeFallbackLabel({ assurance: { judgeFallbacks: [{ label: '  ' }, null] } })).toBeNull();
  });
});

describe('the PR body phase table', () => {
  it('shows the fallback judge beside the gate', () => {
    const view = {
      session: { id: 'r1', problem: 'fix the tip', workflow_id: 'wf-r1', repo_ref: 'tiny-tip' },
      units: [
        { id: 'r1:fix', session_id: 'r1', ord: 1, stage: 'build', role: 'creator', status: 'done', gate: 'auto', routing: null, assigned_cli: 'claude', assurance: { judgeFallbacks: [fallback] } },
        { id: 'r1:verify', session_id: 'r1', ord: 2, stage: 'review', role: 'evaluator', status: 'done', gate: 'auto', routing: null, assigned_cli: 'pi', assurance: { judge: 'pi' } },
      ],
    } as unknown as SessionView;
    const facts = factsFromRun(view, null, { workflowId: 'bug' });
    expect(facts.phases[0]!.gate).toBe(`auto · ${label}`);
    expect(facts.phases[1]!.gate).toBe('auto');
  });
});
