// crew#293 — the first-class deliver phase, pure half: the script generator, the PhaseDef
// shape, and per-run composition. The launch threading lives in deliver-launch.test.ts
// (adapter) and deliver-route.test.ts (HTTP).
//
// The script assertions pin the FIELD-PROVEN hardening, not the wording: the refuse-main
// guard, the rebase-before-push step, and — the one deliberate change from the field overlay —
// no gh account name baked into crew code (the env-driven GH_ACCOUNT guard replaces it).

import { describe, expect, it } from 'vitest';
import {
  DELIVER_PHASE_ID,
  composeDeliverWorkflow,
  deliverPrPhase,
  deliverPrScript,
} from '../src/core/deliver.js';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';

describe('deliverPrScript (the hardened field script)', () => {
  const script = deliverPrScript();

  it('derives the branch from the worktree run-id with a current-branch fallback', () => {
    expect(script).toContain('B="wicked/$(basename "$PWD")"');
    expect(script).toContain('git branch --show-current');
  });

  it('REFUSES to push main/master (and a detached-HEAD empty name)', () => {
    expect(script).toMatch(/case "\$B" in ""\|main\|master\)/);
    expect(script).toContain('refusing to push');
    // The refusal exits non-zero — a printed warning that still pushes is no guard at all.
    expect(script).toMatch(/refusing to push[^\n]*"; exit 1;;/);
  });

  it('rebases onto origin’s default branch before pushing, failing visibly on conflict', () => {
    expect(script).toContain('git fetch origin');
    expect(script).toMatch(/git rebase /);
    // origin/HEAD resolution with the origin/main fallback the task names.
    expect(script).toContain('refs/remotes/origin/HEAD');
    expect(script).toContain('origin/main');
    // A conflicting rebase must fail the phase (exit 1) and push nothing — the exit appears
    // in the rebase failure arm, before any push runs.
    expect(script).toMatch(/git rebase [^\n]*exit 1/);
    const rebaseAt = script.indexOf('git rebase');
    const pushAt = script.indexOf('git push -u origin');
    expect(rebaseAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(rebaseAt);
  });

  it('pushes -u and opens the PR with gh, URL as the last line', () => {
    expect(script).toContain('git push -u origin "$B"');
    expect(script).toContain('gh pr create --head "$B" --fill');
    const lines = script.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toContain('tail -1');
  });

  it('bakes NO account name into crew code — the guard is env-driven (GH_ACCOUNT)', () => {
    // The field overlay guarded a personal account by name; that must never ship in crew.
    expect(script).not.toContain('mikeparcewski');
    expect(script).toContain('GH_ACCOUNT');
    // The switch only runs when GH_ACCOUNT is set AND differs from the current login.
    expect(script).toContain('gh api user -q .login');
    expect(script).toContain('gh auth switch --hostname github.com --user "$GH_ACCOUNT"');
    expect(script).toMatch(/if \[ -n "\$\{GH_ACCOUNT:-\}" \]/);
  });

  it('fails the phase when gh fails despite the tail pipe (pipefail)', () => {
    expect(script).toContain('set -euo pipefail');
  });
});

describe('deliverPrPhase (the PhaseDef shape core accepts)', () => {
  it('is a neutral auto-gated build Tool phase running the hardened script', () => {
    const phase = deliverPrPhase(['review']);
    expect(phase).toMatchObject({
      id: DELIVER_PHASE_ID,
      kind: 'build',
      gate: 'auto',
      executes_code: false,
      role: 'neutral',
      depends_on: ['review'],
    });
    expect(phase.executor).toEqual({ type: 'tool', cmd: ['bash', '-lc', deliverPrScript()] });
    // The fields core's serde would default are spelled out so the def satisfies crew's own
    // WorkflowDef type without casts.
    expect(phase.gate_type).toBeNull();
    expect(phase.verified_evidence).toBe(false);
    expect(phase.required_deliverables).toEqual([]);
    expect(phase.skill_ref).toBeNull();
    expect(phase.allowed_skills).toEqual([]);
    expect(phase.validator_pin).toBeNull();
  });
});

describe('composeDeliverWorkflow (per-run composition)', () => {
  const feature = BUILTIN_WORKFLOWS.find((w) => w.id === 'feature')!;

  it('appends deliver exactly once, last, depending on the base’s last phase', () => {
    const composed = composeDeliverWorkflow(feature, 'run-123');
    expect(composed.phases).toHaveLength(feature.phases.length + 1);
    const delivers = composed.phases.filter((p) => p.id === DELIVER_PHASE_ID);
    expect(delivers).toHaveLength(1);
    expect(composed.phases[composed.phases.length - 1]!.id).toBe(DELIVER_PHASE_ID);
    expect(delivers[0]!.depends_on).toEqual(['review']);
  });

  it('mints a run-scoped id and never mutates the shared def', () => {
    const before = JSON.stringify(feature);
    const composed = composeDeliverWorkflow(feature, 'run-123');
    expect(composed.id).toBe('feature-deliver-run-123');
    // The SHARED def must be byte-identical afterwards — per-run composition, not mutation.
    expect(JSON.stringify(feature)).toBe(before);
    expect(feature.phases.some((p) => p.id === DELIVER_PHASE_ID)).toBe(false);
    // And the composed def is register-input, not catalog data: no is_system field, which
    // core's overlay schema rejects as unknown.
    expect('is_system' in composed).toBe(false);
  });

  it('keeps the composed id inside registerWorkflow’s safe charset', () => {
    const composed = composeDeliverWorkflow(feature, 'run/../../etc:passwd');
    expect(composed.id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  });

  it('refuses a def that already delivers — the caller launches it as-is instead', () => {
    const alreadyDelivering: WorkflowDef = {
      id: 'feature-pr',
      phases: [...feature.phases, deliverPrPhase(['review'])],
    };
    expect(() => composeDeliverWorkflow(alreadyDelivering, 'run-123')).toThrow(/already has/);
  });
});
