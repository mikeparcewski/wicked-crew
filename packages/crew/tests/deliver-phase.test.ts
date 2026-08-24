// crew#293 — the first-class deliver phase, pure half: the script generator, the PhaseDef
// shape, and per-run composition. The launch threading lives in deliver-launch.test.ts
// (adapter) and deliver-route.test.ts (HTTP).
//
// The script assertions pin the FIELD-PROVEN hardening, not the wording: the refuse-main
// guard, the rebase-before-push step, and — the one deliberate change from the field overlay —
// no gh account name baked into crew code (the env-driven GH_ACCOUNT guard replaces it).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DELIVER_PHASE_ID,
  composeDeliverWorkflow,
  deliverPrPhase,
  deliverPrScript,
} from '../src/core/deliver.js';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';
import { SKIP_CORE_CHECKS, requireCoreDir } from './support/core-checkout.js';

describe('deliverPrScript (the hardened field script)', () => {
  const script = deliverPrScript();

  it('derives the branch from the worktree run-id with a current-branch fallback', () => {
    expect(script).toContain('R=$(basename "$PWD")');
    expect(script).toContain('B="wicked/$R"');
    expect(script).toContain('git branch --show-current');
  });

  it('REFUSES to push main/master (and a detached-HEAD empty name)', () => {
    expect(script).toMatch(/case "\$B" in ""\|main\|master\|"\$DEF"\)/);
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
    expect(lines[lines.length - 1]).toBe('echo "$URL"');
  });

  // crew#317 — the three defects, pinned as script properties. The BEHAVIOUR of each is driven
  // for real against temp git repos in deliver-script-exec.test.ts; these keep the shape from
  // regressing without paying for a git repo per assertion.
  it('STAGES AND COMMITS the run’s work before it pushes anything', () => {
    expect(script).toContain('git add -A');
    expect(script).toContain('git diff --cached --quiet || git commit -q -m "$M"');
    // The commit precedes both the rebase (which refuses a dirty tree) and the push.
    expect(script.indexOf('git add -A')).toBeLessThan(script.indexOf('git rebase'));
    expect(script.indexOf('git commit')).toBeLessThan(script.indexOf('git push -u origin'));
    // Author identity is the repo's own — crew never bakes one in.
    expect(script).not.toContain('user.email');
    expect(script).not.toContain('user.name');
  });

  it('names the run AND its intent in the commit subject, single-line-safe', () => {
    const withIntent = deliverPrScript('add the attention-reason helper');
    expect(withIntent).toContain("I='add the attention-reason helper'");
    expect(withIntent).toContain('M="wicked-crew run $R: $I"');
    // No intent ⇒ the run id alone, never a dangling separator.
    expect(script).toContain("I=''");
    expect(script).toContain('else M="wicked-crew run $R"');
    // A hostile intent can neither escape the single-quoted assignment nor add a line.
    const hostile = deliverPrScript("x'; rm -rf /; echo '\n\nsecond line");
    expect(hostile).not.toContain("rm -rf /'");
    const assignment = hostile.split('\n').filter((l) => l.startsWith("I='"));
    expect(assignment).toHaveLength(1);
    expect(assignment[0]).toBe("I='x; rm -rf /; echo second line'");
  });

  it('FAILS LOUDLY with nothing pushed when there is nothing to deliver', () => {
    expect(script).toContain('deliver: nothing to deliver — the run produced no committed change');
    // The refusal is asserted BEFORE the push, and it exits non-zero.
    const nothing = script.indexOf('nothing to deliver');
    expect(nothing).toBeGreaterThan(-1);
    expect(nothing).toBeLessThan(script.indexOf('git push -u origin'));
    expect(script).toMatch(/nothing to deliver[^\n]*nothing was pushed"; exit 1; \}/);
  });

  it('captures gh’s output and status separately — no `| tail -1` verdict laundering', () => {
    expect(script).toContain('if ! OUT=$(gh pr create --head "$B" --fill 2>&1); then');
    expect(script).toContain('deliver: gh pr create failed for $B — no PR was opened');
    // The gh invocation must not be piped at all: the phase's verdict is gh's own status.
    const ghLine = script.split('\n').find((l) => l.includes('gh pr create'))!;
    expect(ghLine).not.toContain('| tail');
  });

  it('RE-DERIVES done: a real PR URL and a branch ahead of the remote default', () => {
    expect(script).toContain("grep -Eo 'https://[^[:space:]]+/pull/[0-9]+'");
    expect(script).toContain('exited 0 but produced no PR URL');
    expect(script).toContain('P=$(git rev-list --count "$D..origin/$B")');
    expect(script).toContain('is not ahead of $D on the remote after the push');
    // Both assertions gate the final URL line.
    const lines = script.split('\n');
    expect(lines.indexOf('echo "$URL"')).toBe(lines.length - 1);
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

  // crew#317: the overlay def that shipped run d1bc72c2 began `set -e` with NO pipefail, which
  // is why its `gh … | tail -1` reported tail's status and the phase passed on a failed PR. This
  // script has always carried pipefail; it keeps it, and no longer depends on it for the verdict.
  it('keeps `set -euo pipefail` as line 1 — the overlay that lost a gh failure had only `set -e`', () => {
    expect(script.split('\n')[0]).toBe('set -euo pipefail');
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
    expect(phase.required_deliverables).toEqual([]);
    expect(phase.skill_ref).toBeNull();
    expect(phase.allowed_skills).toEqual([]);
  });

  // crew#317 — the delivering phase was the one phase nothing re-derived (`verified_evidence:
  // false`, `validator_pin: null`, `governed=false`). It now declares verified_evidence, which
  // core's `enforce_verified_evidence` arms AT REGISTRATION with the built-in evidence floor
  // (EVIDENCE_FLOOR_PIN — "the run left a change in its worktree"). The pin stays null on OUR
  // side deliberately: `attach_pinned_validators` is fail-closed on a pin that is not vaulted,
  // and crew has no provision/approve surface, so a crew-minted pin would bail every run.
  it('declares verified_evidence so the engine floors it, and mints no pin of its own', () => {
    const phase = deliverPrPhase(['review']);
    expect(phase.verified_evidence).toBe(true);
    expect(phase.validator_pin).toBeNull();
  });

  it('threads the run intent into the script it carries', () => {
    const phase = deliverPrPhase(['review'], 'ship the deliver fix');
    expect(phase.executor).toEqual({
      type: 'tool',
      cmd: ['bash', '-lc', deliverPrScript('ship the deliver fix')],
    });
    expect((phase.executor as { cmd: string[] }).cmd[2]).toContain("I='ship the deliver fix'");
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


describe('deliver review follow-ups (#303)', () => {
  it('refuses the derived default branch, not only main/master', () => {
    const script = deliverPrScript();
    expect(script).toContain('DEF="${D#origin/}"');
    expect(script).toContain('"$DEF"');
    // derivation must precede the refusal so $DEF is bound when the case runs
    expect(script.indexOf('DEF=')).toBeLessThan(script.indexOf('case "$B"'));
  });
  it('caps the composed workflow id at 128 chars', () => {
    const base = { id: 'feature', phases: [{ id: 'build' }] } as never;
    const longRun = 'r'.repeat(300);
    const composed = composeDeliverWorkflow(base, longRun);
    expect(composed.id.length).toBeLessThanOrEqual(128);
    expect(composed.id.startsWith('feature-deliver-')).toBe(true);
  });
});

// crew#317 — the deliver phase's governance is a CROSS-REPO claim: crew sets a flag and relies on
// wicked-core to turn it into a real gate. Transcribing that belief into a comment is the drift
// this repo keeps paying for (FINDING-049/-084/-088), so it is DERIVED from core's own source, in
// the established style of the sibling drift guards.
//
// The mechanism, in core's `workflow.rs`: `WorkflowRegistry::register` — the choke point every def
// crosses, including crew's per-run `registerWorkflow` — calls `enforce_verified_evidence`, which
// pins `builtin_floors::EVIDENCE_FLOOR_PIN` onto any `verified_evidence` phase that names no
// validator of its own. That is why `deliverPrPhase` can declare the flag and leave the pin null:
// crew cannot mint a pin (`attach_pinned_validators` is fail-closed on one that is not vaulted,
// and crew has no provision/approve surface), but it can declare the requirement.
describe.skipIf(SKIP_CORE_CHECKS)('the engine really arms verified_evidence (cross-repo)', () => {
  const workflowRs = (): string => {
    const path = join(requireCoreDir(), 'src', 'workflow.rs');
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      throw new Error(
        `cannot read core's src/workflow.rs at ${path}: ${e instanceof Error ? e.message : String(e)}\n` +
          "  The deliver phase's ONLY governance is core arming its verified_evidence flag with " +
          'the built-in evidence floor. If that moved, follow it — do not delete this guard.',
      );
    }
  };

  it('register() runs enforce_verified_evidence, which floors an unpinned flagged phase', () => {
    const src = workflowRs();
    expect(src).toContain('let def = enforce_verified_evidence(def);');
    expect(src).toContain('fn enforce_verified_evidence(mut def: WorkflowDef) -> WorkflowDef {');
    // Flagged AND unpinned is exactly the shape deliverPrPhase ships.
    expect(src).toContain('if !phase.verified_evidence || phase.validator_pin.is_some() {');
    expect(src).toContain(
      'phase.validator_pin = Some(crate::builtin_floors::EVIDENCE_FLOOR_PIN.to_string());',
    );
  });

  it('the floor it arms re-derives done from the worktree, committed work included', () => {
    const floors = readFileSync(join(requireCoreDir(), 'src', 'builtin_floors.rs'), 'utf8');
    // The criterion the deliver phase inherits — the product thesis stated as a check.
    expect(floors).toContain(
      'the run left a change in its worktree (done is re-derived from the diff, never asserted)',
    );
    // Clause 2 (core#280) is the one that matters here: the deliver phase COMMITS the run's work,
    // so a floor reading `git status --porcelain` alone would deny every delivered run.
    expect(floors).toContain("git log --oneline HEAD --not --exclude='wicked/*' --branches");
  });
});
