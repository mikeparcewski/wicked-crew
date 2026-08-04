// FINDING-068 regression: onboarding must not run a phase whose precondition no phase in
// onboarding produces.
//
// The `onboarding` def carried a third phase, `domain`, shelling out to `wicked-core domain-graph`.
// That phase could never pass. `domain-graph` fails CLOSED below 1.0 front-half coverage — the
// fraction of behavior-bearing symbols carrying a requirement annotation or a risk flag — and
// nothing in onboarding annotates a single symbol (`wicked-estate clusters --annotate` is
// CLUSTERING). On AutoGPT, indexed and annotated by exactly the two phases that precede it:
//
//     total 42925 · behavior_bearing 28885 · resolved 0 · risk_flagged 0 · coverage 0.0000
//
// Not "short of the bar": nothing had ever been in the numerator. So every repo registration ended
// `sessionFailed`, on a phase structurally incapable of passing, AFTER the two phases that matter
// had both succeeded. Coverage comes from the agentic `domain-extraction` workflow, whose `extract`
// phase writes the annotations and whose `coverage` phase measures them; `domain-graph` is that
// workflow's last phase, downstream of its own precondition. Onboarding is deterministic tools and
// no council by construction, so it cannot host any of them.
//
// What this asserts is the def that REACHES THE ENGINE, not the mirror in `BUILTIN_WORKFLOWS`.
// `onboarding` is the one core-seeded id crew deliberately shadows (see
// `builtin-overlay-shadow.test.ts`): the launch path rewrites it with runtime-baked `--db` paths and
// hot-registers the result. `onboardingDefFor` IS that rewrite, and `_doOnboardingLaunch` hands its
// return value to `_writeBuiltinOverlay` verbatim — so this is the artifact the engine resolves.
//
// It is asserted through the pure function rather than by driving a real launch and reading the
// overlay back off disk. A live launch needs an engine handle, and this package's CI resolves
// `wicked-core-ts` from npm — where the newest published build (0.3.0) predates `code_graph_db`
// entirely. Driving the launch there dies on `codeGraphDb`'s deliberate throw before the overlay is
// ever written, so the suite reported a bare ENOENT about a phase list it never got to look at
// (FINDING-072 tracks that CI-fidelity gap; it is not this test's job to paper over it).
//
// The gate is not the defect and must not be relaxed to make this pass. Refusing to translate a
// partially-annotated graph is the design (DES-OUTGOV-001/005); a domain model built from a
// 0%-covered graph is a file full of confident nonsense.
import { describe, expect, it } from 'vitest';
import { onboardingDefFor } from '../src/core/adapter.js';
import type { RepoEntry } from '../src/core/types.js';

// Only the three fields the rewrite reads. Typed through RepoEntry so a field rename breaks the
// build here rather than silently making this a test of nothing.
const REPO = {
  id: 'onboarding-fixture',
  name: 'onboarding-fixture',
  root_path: '/repos/onboarding-fixture',
  code_graph_db: '/repos/onboarding-fixture/.codegraph/estate.db',
} as unknown as RepoEntry;

describe('onboarding runs only what it can actually finish', () => {
  const def = onboardingDefFor(REPO);

  it('is index → annotate, and nothing downstream of them', () => {
    expect(def.phases.map((p) => p.id)).toEqual(['index', 'annotate']);
  });

  it('shells out to no command whose precondition onboarding cannot produce', () => {
    // Stated as "no phase runs domain-graph" rather than "no phase named `domain`": the defect is
    // the COMMAND's unmeetable precondition, not the phase's name. Mirrors core's
    // `onboarding_runs_only_what_it_can_actually_finish`.
    for (const phase of def.phases) {
      const cmd = phase.executor?.type === 'tool' ? phase.executor.cmd : [];
      expect(cmd, `onboarding phase \`${phase.id}\` runs \`${cmd.join(' ')}\``).not.toContain(
        'domain-graph',
      );
    }
  });

  it('bakes the engine-resolved --db into every phase, so none degrades to an agent', () => {
    // The rewrite maps phase id → cmd and leaves a phase it has no entry for UNTOUCHED. An unmatched
    // id therefore stays an agent phase: a deterministic tool step silently becomes a council-less
    // LLM step. Two artifacts that must agree (the phase list and that map), with nothing failing
    // when they diverge — so this fails instead.
    for (const phase of def.phases) {
      expect(phase.executor?.type, `phase \`${phase.id}\` has no tool executor`).toBe('tool');
      const cmd = phase.executor?.type === 'tool' ? phase.executor.cmd : [];
      expect(cmd, `phase \`${phase.id}\` was not given a resolved --db`).toContain('--db');
      // The path the ENGINE published, not one re-derived here — the whole point of FINDING-069.
      expect(cmd[cmd.indexOf('--db') + 1]).toBe(REPO.code_graph_db);
    }
  });
});
