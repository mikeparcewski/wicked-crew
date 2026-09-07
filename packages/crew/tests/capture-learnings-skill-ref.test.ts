// Guards the repo-learning workflow's shape after moving its method out of inline prose and into
// the garden skill `wicked-garden-repo-learn`.
//
// The learning method used to live as ~600-column inline `instructions` on each phase. A governed
// worker's prompt rides a SINGLE pty line capped at 1022 bytes (>=1023B is silently discarded by the
// terminal — wicked-core execute_wrapped.rs), and the planner folds a phase's `instructions` onto
// that same line alongside the run intent. So the real logic (bounded git-churn sampling, the estate
// MCP tool names, the proposal payload schemas) belongs in the SKILL, reached via `skill_ref`; the
// inline text must stay a short one-line orientation. This test fails loudly if a phase ever loses
// its `skill_ref` or re-inlines the method — the exact regression that would blow the pty line.
//
// `capture-learnings` is crew-only (core does not seed or ship it), so — unlike the drop-ins in
// builtin-overlay-shadow.test.ts — there is no core JSON to diff against; the contract is asserted
// here directly on `BUILTIN_WORKFLOWS`.
import { describe, expect, it } from 'vitest';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';

const SKILL = 'wicked-garden-repo-learn';

// The pty line is 1022 bytes and also has to carry the base directive, the run intent, the worktree
// map, and the conventions appendix. A phase orientation well under this leaves room for all of them;
// the real method is in the skill, so there is no reason for it to grow past a couple of sentences.
const MAX_INLINE_BYTES = 600;

// Markers of the OLD inline method that now lives in the skill. If any reappears in a phase's inline
// instructions, the prose has been re-inlined and the pty-line budget is at risk again.
const SKILL_OWNED_MARKERS = ['RankHotspots', 'BlastRadius', 'proposal.submit', 'kind_type', 'FetchContent'];

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('capture-learnings is skill-driven, not inline-prose-driven', () => {
  const def = BUILTIN_WORKFLOWS.find((w) => w.id === 'capture-learnings');

  it('is served as a crew-only system workflow', () => {
    expect(def, 'capture-learnings must be in BUILTIN_WORKFLOWS').toBeDefined();
    expect(def!.is_system).toBe(true);
  });

  it('keeps the dependent churn → hotspots → capture chain in one workflow', () => {
    const phases = def!.phases;
    expect(phases.map((p) => p.id)).toEqual(['churn', 'hotspots', 'capture']);
    // The chain is the whole reason this is ONE workflow and not four runs: crew threads each phase's
    // output into the next only WITHIN a run, so the dependency edges must be present.
    expect(phases.find((p) => p.id === 'churn')!.depends_on).toEqual([]);
    expect(phases.find((p) => p.id === 'hotspots')!.depends_on).toEqual(['churn']);
    expect(phases.find((p) => p.id === 'capture')!.depends_on).toEqual(['hotspots']);
    // Evaluator≠creator bookkeeping: recon phases are neutral, the single capture phase is the creator
    // that emits proposals (both memories and policies) from the shared understanding.
    expect(phases.find((p) => p.id === 'capture')!.role).toBe('creator');
  });

  it('drives every phase through the garden skill and keeps inline instructions short', () => {
    for (const p of def!.phases) {
      expect(p.skill_ref, `phase ${p.id} must reference ${SKILL}`).toBe(SKILL);
      const instr = p.instructions ?? '';
      expect(instr.length, `phase ${p.id} needs a short orientation`).toBeGreaterThan(0);
      expect(instr.includes('\n'), `phase ${p.id} instruction must be single-line`).toBe(false);
      expect(
        byteLen(instr),
        `phase ${p.id} inline instructions (${byteLen(instr)}B) must stay well under the pty line`,
      ).toBeLessThan(MAX_INLINE_BYTES);
      for (const marker of SKILL_OWNED_MARKERS) {
        expect(
          instr,
          `phase ${p.id} re-inlined "${marker}" — that method belongs in the ${SKILL} skill`,
        ).not.toContain(marker);
      }
    }
  });
});
