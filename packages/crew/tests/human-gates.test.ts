// FINDING-023 (residual): core#208 made a workflow's phase gate deliberately win over a run-level
// humanConfirm:none (it pauses, with a self-disclosing note), but there was no way to learn a
// workflow's gates BEFORE launching — an operator picking `none` for an "unattended" run only found
// out when it paused. `humanGatePhaseIds` is the launch-time signal (surfaced on GET /workflows/:id).

import { describe, expect, it } from 'vitest';
import { humanGatePhaseIds, BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { PhaseDef, WorkflowDef } from '../src/core/types.js';

function phase(id: string, gate: PhaseDef['gate']): PhaseDef {
  return {
    id,
    kind: 'build',
    gate_type: 'value',
    gate,
    executes_code: false,
    verified_evidence: false,
    required_deliverables: [],
    depends_on: [],
    role: 'neutral',
    skill_ref: null,
    allowed_skills: [],
    validator_pin: null,
  };
}

describe('FINDING-023: human-gate disclosure', () => {
  it('returns exactly the phases that pause for a person (unconditional AND conditional)', () => {
    const wf: WorkflowDef = {
      id: 'mixed',
      phases: [
        phase('recon', 'auto'), // not a gate
        phase('clarify', { human_confirm: { unconditional: true } }), // gate
        phase('build', 'auto'), // not a gate
        phase('review', { human_confirm_if: 'verdict_not_pass' }), // conditional gate — MUST count
      ],
    };
    // Order preserved; both gate forms included; 'auto' excluded.
    expect(humanGatePhaseIds(wf)).toEqual(['clarify', 'review']);
  });

  it('reports no gates for a fully-auto workflow', () => {
    const wf: WorkflowDef = { id: 'auto-only', phases: [phase('a', 'auto'), phase('b', 'auto')] };
    expect(humanGatePhaseIds(wf)).toEqual([]);
  });

  it("the shipped 'feature' built-in advertises its human gates", () => {
    const feature = BUILTIN_WORKFLOWS.find((w) => w.id === 'feature');
    expect(feature, "the 'feature' built-in should exist").toBeDefined();
    // feature carries human gates (clarify + adversarial-review per the workflow def); the point of
    // the finding is that these are now discoverable pre-launch, so the set must be non-empty.
    expect(humanGatePhaseIds(feature as WorkflowDef).length).toBeGreaterThan(0);
  });
});
