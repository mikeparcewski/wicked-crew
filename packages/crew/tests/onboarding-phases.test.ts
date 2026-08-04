// Two regressions on the same def, asserted together because the second is what the fix for the
// first was originally built on top of.
//
// ── FINDING-068 ────────────────────────────────────────────────────────────────────────────────
// `onboarding` carried a third phase, `domain`, shelling out to `wicked-core domain-graph`. That
// phase could never pass. `domain-graph` fails CLOSED below 1.0 front-half coverage — the fraction
// of behavior-bearing symbols carrying a requirement annotation or a risk flag — and nothing in
// onboarding annotates a single symbol (`wicked-estate clusters --annotate` is CLUSTERING). On
// AutoGPT, indexed and annotated by exactly the two phases that precede it:
//
//     total 42925 · behavior_bearing 28885 · resolved 0 · risk_flagged 0 · coverage 0.0000
//
// Not "short of the bar": nothing had ever been in the numerator. So every repo registration ended
// `sessionFailed`, on a phase structurally incapable of passing, AFTER the two phases that matter
// had both succeeded. The gate is not the defect and must not be relaxed to make this pass —
// refusing to translate a partially-annotated graph is the design (DES-OUTGOV-001/005).
//
// ── FINDING-075 (wicked-crew#196) ──────────────────────────────────────────────────────────────
// The paths were baked into this def per launch and written to ONE shared file,
// `~/.config/wicked-core/workflows/onboarding.json`. The engine resolves a workflow at DISPATCH
// time, after the launch call returns, so concurrent registrations raced on that file and the last
// writer won: runs labelled `cli-harness-crush` and `plugins-skills-agents` both ran
// `wicked-estate index .../agentic-products/open-code-review`. Cross-org, and visible only because
// three writers hit one SQLite file — otherwise each reports success for a repo it never opened.
//
// So the def must now carry core's PLACEHOLDERS and no absolute path. Core substitutes them per run
// from the launch's `repoRef` (wicked-core#179), which is per-run state, not shared state.
import { describe, expect, it } from 'vitest';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';

// Resolved once, eagerly, and THROWN on rather than left optional. A `find` plus `!` in every case
// means a rename surfaces as a TypeError inside whichever assertion happens to run first, burying
// the one sentence that would explain it.
const onboarding = (() => {
  const found = BUILTIN_WORKFLOWS.find((w) => w.id === 'onboarding');
  if (!found) throw new Error('no `onboarding` entry in BUILTIN_WORKFLOWS — renamed or removed?');
  return found;
})();

describe('the onboarding def', () => {
  it('is index → annotate, and nothing downstream of them (FINDING-068)', () => {
    expect(onboarding.phases.map((p) => p.id)).toEqual(['index', 'annotate']);
  });

  it('shells out to no command whose precondition onboarding cannot produce (FINDING-068)', () => {
    // Stated as "no phase runs domain-graph" rather than "no phase named `domain`": the defect is
    // the COMMAND's unmeetable precondition, not the phase's name.
    for (const phase of onboarding.phases) {
      const cmd = phase.executor?.type === 'tool' ? phase.executor.cmd : [];
      expect(cmd, `onboarding phase \`${phase.id}\` runs \`${cmd.join(' ')}\``).not.toContain(
        'domain-graph',
      );
    }
  });

  it('declares repo placeholders rather than carrying anyone absolute paths (FINDING-075)', () => {
    for (const phase of onboarding.phases) {
      expect(phase.executor?.type, `phase \`${phase.id}\` has no tool executor`).toBe('tool');
      const cmd = phase.executor?.type === 'tool' ? phase.executor.cmd : [];

      // Every phase reads the graph, so every phase must be told WHICH graph — and by placeholder,
      // because one baked path in a shared def is one repo's path in every run of it.
      expect(cmd, `phase \`${phase.id}\` names no --db`).toContain('--db');
      expect(cmd[cmd.indexOf('--db') + 1]).toBe('{code_graph_db}');

      // An absolute path here is the regression itself: it can only have come from one repo, and
      // this def is shared by every run.
      const absolute = cmd.filter((a) => a.startsWith('/'));
      expect(
        absolute,
        `phase \`${phase.id}\` bakes absolute path(s) into a SHARED def — whichever repo they ` +
          `belong to, every other repo's run would use them (FINDING-075)`,
      ).toEqual([]);
    }
  });

  it('passes the index phase a repo root, and by placeholder (FINDING-075)', () => {
    const index = onboarding.phases.find((p) => p.id === 'index')!;
    const cmd = index.executor?.type === 'tool' ? index.executor.cmd : [];
    // Without an explicit root, `wicked-estate index` reads its cwd — which is the per-run WORKTREE,
    // not the repo. That is how FINDING-067 indexed the wrong tree.
    expect(cmd).toContain('{repo_root}');
  });
});
