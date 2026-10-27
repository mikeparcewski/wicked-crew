/**
 * Synthetic cases for the edges real data does not cover yet (DES-DEFAULT-EVALS-001 §4). Seeded and deterministic:
 * the same real cases in give the same synthetic cases out. A class gets synthetic cases only while it has fewer than
 * {@link MIN_CASES} real ones, so synthetic data fills gaps and never outweighs what really happened.
 *
 * Synthetic cases carry their input and the expected answer (`by: 'fixture'`) and NO observation: a replay adapter
 * (the current classifier, run on the input) supplies it. A suite with no replay adapter reports them as unscored.
 */

import { MIN_CASES } from './stats.js';
import { isModelLabelled } from './score.js';
import type { EvalCase, SuiteId } from './types.js';

interface Template {
  label: string;
  inputs: Array<Record<string, unknown>>;
}

/** Archetype prompts: short, plain, one per line of work, with the edges the regex is known to miss. */
const ARCHETYPE: Template[] = [
  { label: 'build', inputs: ['Add a median(xs) function to src/math.js with tests', 'Implement retry with backoff in the uploader', 'Fix the off-by-one in pagination', 'Make the export button stop hanging', 'Wire the new settings toggle to the API', 'The login page crashes on submit; fix it'].map((prompt) => ({ prompt })) },
  { label: 'review', inputs: ['Review PR 1152 for correctness', 'Look over this diff and tell me what is risky', 'Is this migration safe to merge?', 'Check the security of the new upload endpoint', 'Give me a code review of src/actor.rs changes'].map((prompt) => ({ prompt })) },
  { label: 'explore', inputs: ['Where is wicked-core riskiest to change?', 'How does the floor decide base red?', 'What calls resolveAcceptanceGate?', 'Explain how judges are picked', 'Which modules depend on the event log?'].map((prompt) => ({ prompt })) },
  { label: 'specify', inputs: ['Write the requirements for project-scoped memories', 'Draft acceptance criteria for the needs-you count', 'Spec out the scheduler API before we build it', 'What should the evals results page show? Write it up as a spec', 'Define the wire shape for default eval reports'].map((prompt) => ({ prompt })) },
  { label: 'decide', inputs: ['Should we use Wilson or bootstrap intervals here?', 'Pick between SQLite and JSONL for the eval store', 'Do we merge red-base runs into one item or keep them separate?', 'Which seat should judge by default, codex or claude?', 'Choose: one statistics module or two?'].map((prompt) => ({ prompt })) },
  { label: 'incident', inputs: ['The gateway is down and every run fails with 503', 'Production deploy is failing right now, help', 'All seats are benched and nothing runs', 'The daemon crashed on boot after the upgrade', 'CI is red on main for every PR since an hour ago'].map((prompt) => ({ prompt })) },
  { label: 'ship', inputs: ['Cut the 0.16.4 release', 'Publish core-ts to npm', 'Tag and release the studio bundle', 'Ship this branch: merge and release', 'Prepare the release notes and tag v1.2.0'].map((prompt) => ({ prompt })) },
  { label: 'migrate', inputs: ['Migrate the eval store from JSONL to SQLite', 'Upgrade vitest 4 to 5 across the repo', 'Move learn onto the generic scheduler', 'Port the hooks from Python to TypeScript', 'Rename the wire field ask_turn everywhere'].map((prompt) => ({ prompt })) },
  { label: 'none', inputs: ['Say hi.', 'thanks', 'ok go ahead', 'good', 'what time is it?'].map((prompt) => ({ prompt })) },
];

/** Floor evidence shapes, one per class. Unscored until core exposes a replay entry for the floor class. */
const FLOOR: Template[] = [
  { label: 'pass', inputs: [{ condition: null, denialSource: null, failing: [] }] },
  { label: 'real_fail', inputs: [{ condition: 'floor_failed', denialSource: 'repo_checks', failing: ['test'], headOnly: 2, baseFailing: 0 }] },
  { label: 'base_red', inputs: [{ condition: 'floor_failed', denialSource: 'repo_checks', failing: ['test'], headOnly: 0, baseFailing: 12 }] },
  { label: 'inconclusive', inputs: [{ condition: 'floor_failed', denialSource: 'repo_checks_timeout', failing: ['test'] }, { condition: 'floor_failed', denialSource: 'repo_checks', failing: ['test'], flaky: true }] },
  { label: 'boundary_deny', inputs: [{ condition: 'boundary_deny', denialSource: 'input_governance', failing: [], refusedTool: 'Write' }] },
];

const QE: Template[] = [
  { label: 'PASS', inputs: [{ reason: 'All criteria satisfied from captured evidence.' }] },
  { label: 'FAIL', inputs: [{ reason: 'FAIL: the new test fails on the change; criterion 2 is not met.' }] },
  { label: 'INCONCLUSIVE', inputs: [{ reason: 'inconclusive: ENVIRONMENT_ISSUE, the test runner could not start on the seat.' }] },
];

const TEMPLATES: Partial<Record<SuiteId, { templates: Template[]; replayable: boolean }>> = {
  archetype: { templates: ARCHETYPE, replayable: true },
  'floor-class': { templates: FLOOR, replayable: false },
  'qe-verdict': { templates: QE, replayable: false },
};

/** Which suites' synthetic cases a replay adapter can score (the rest are reported as unscored). */
export function syntheticSuites(): SuiteId[] {
  return Object.keys(TEMPLATES) as SuiteId[];
}

/**
 * Synthetic cases for every class that has fewer than {@link MIN_CASES} people-labelled real cases. Templates are
 * taken in order, so the result is deterministic; a class with no template left stops short and says nothing more.
 */
export function generateSynthetic(real: readonly EvalCase[]): EvalCase[] {
  const out: EvalCase[] = [];
  for (const [suite, spec] of Object.entries(TEMPLATES) as Array<[SuiteId, { templates: Template[] }]>) {
    for (const t of spec.templates) {
      const have = real.filter((c) => c.suite === suite && c.source === 'real' && !isModelLabelled(c) && c.expected.label === t.label).length;
      const need = Math.max(0, MIN_CASES - have);
      t.inputs.slice(0, need).forEach((input, i) => {
        out.push({
          id: `${suite}:synthetic:${t.label}:${i}`,
          suite,
          source: 'synthetic',
          project: null,
          inputKey: `${suite}:synthetic:${t.label}:${i}`,
          input,
          observed: null,
          expected: { label: t.label, by: 'fixture', why: 'generated for a class with too few real cases' },
        });
      });
    }
  }
  return out;
}
