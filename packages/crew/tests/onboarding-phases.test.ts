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
// hot-registers the result. So the overlay file is the artifact under test, and reading it back also
// covers the second half of the same defect class — a phase present in the def but absent from the
// launch path's `CMDS` map silently degrades to an AGENT phase rather than failing.
//
// The gate is not the defect and must not be relaxed to make this pass. Refusing to translate a
// partially-annotated graph is the design (DES-OUTGOV-001/005); a domain model built from a
// 0%-covered graph is a file full of confident nonsense.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';

let adapter: CoreAdapter;
let dir: string;
let repoDir: string;
let overlayDir: string;
let priorOverlayDir: string | undefined;
/** The def the launch path wrote to core's overlay dir — what the engine actually resolves. */
let written: WorkflowDef;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'onboarding-phases-'));
  overlayDir = join(dir, 'workflows');
  // Redirect the overlay write. Without this the test writes into the developer's real
  // `~/.config/wicked-core/workflows`, baking a temp repo's paths into their live onboarding def.
  priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
  process.env['WICKED_WORKFLOWS_DIR'] = overlayDir;

  // `registerRepo` prepares a worktree, so it insists on a git repo with at least one commit.
  // Identity is set locally so this does not depend on a global git config.
  repoDir = mkdtempSync(join(tmpdir(), 'onboarding-phases-repo-'));
  const git = (...a: string[]): void => {
    execFileSync('git', a, { cwd: repoDir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'onboarding fixture');
  git('commit', '-q', '--allow-empty', '-m', 'root');

  adapter = new CoreAdapter({ dbPath: join(dir, 'onboarding.db'), stub: true });
  const entry = await adapter.registerRepo('onboarding-fixture', repoDir);
  try {
    await adapter.launchOnboardingRun(entry.id, 'onboarding-fixture');
  } catch {
    // The run's own outcome is not what this measures — a stub run has no estate binary to drive.
    // The overlay write happens BEFORE the launch, so swallowing this keeps an unrelated engine
    // failure from masquerading as the regression.
  }
  written = JSON.parse(readFileSync(join(overlayDir, 'onboarding.json'), 'utf8')) as WorkflowDef;
});

afterAll(() => {
  if (priorOverlayDir === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
  else process.env['WICKED_WORKFLOWS_DIR'] = priorOverlayDir;
  if (adapter) adapter.close();
  // See armed-workflow-served.test.ts: close() returns before the actor thread finishes flushing
  // SQLite's WAL sidecars, and `force` does not cover the ENOTEMPTY that races with it.
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (repoDir) rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('onboarding runs only what it can actually finish', () => {
  it('is index → annotate, and nothing downstream of them', () => {
    expect(written.phases.map((p) => p.id)).toEqual(['index', 'annotate']);
  });

  it('shells out to no command whose precondition onboarding cannot produce', () => {
    // Stated as "no phase runs domain-graph" rather than "no phase named `domain`": the defect is
    // the COMMAND's unmeetable precondition, not the phase's name. Mirrors core's
    // `onboarding_runs_only_what_it_can_actually_finish`.
    for (const phase of written.phases) {
      const cmd = phase.executor?.type === 'tool' ? phase.executor.cmd : [];
      expect(cmd, `onboarding phase \`${phase.id}\` runs \`${cmd.join(' ')}\``).not.toContain('domain-graph');
    }
  });

  it('bakes a runtime --db into every phase, so none degrades to an agent', () => {
    // The launch path maps phase id → cmd and leaves a phase it has no entry for UNTOUCHED. An
    // unmatched id therefore stays an agent phase: a deterministic tool step silently becomes a
    // council-less LLM step. Two artifacts that must agree (the phase list and that map), with
    // nothing failing when they diverge — so this fails instead.
    for (const phase of written.phases) {
      expect(phase.executor?.type, `phase \`${phase.id}\` has no tool executor`).toBe('tool');
      const cmd = phase.executor?.type === 'tool' ? phase.executor.cmd : [];
      expect(cmd, `phase \`${phase.id}\` was not given a resolved --db`).toContain('--db');
    }
  });
});
