// FINDING-072 guard: the resolved `wicked-core-ts` must actually publish the fields this package
// reads off engine records.
//
// `wicked-core-ts` resolves from npm (`^0.3.0`), and the engine this package is developed against —
// the sibling `wicked-core` checkout — runs ahead of anything published. Nothing reconciled the two.
// The version range cannot express "needs an engine with `code_graph_db`", so a field adopted between
// publishes typecheck-passes, lint-passes, and dies at runtime.
//
// It already happened. wicked-crew#184 made `_doOnboardingLaunch` call `codeGraphDb()`, which throws
// by design when the field is absent — correct behaviour, since a silent fallback to a hand-joined
// path is exactly what FINDING-069 was. Against npm's 0.3.0 the field is ALWAYS absent, so onboarding
// a repo was impossible on the engine CI installs. That PR merged green, because no test reached the
// path. CI proved only that broken code compiles.
//
// So this asserts the CONTRACT, not the type. `RepoEntry.code_graph_db` is declared optional in
// `types.ts` precisely because a stale addon omits it — meaning TypeScript is structurally unable to
// catch this, and a test that inspected the interface would assert its own source file. The only
// thing that settles it is registering a repo through a real engine handle and looking at what comes
// back.
//
// When this fails, the addon is older than the code. Rebuild it and re-link:
//
//     cd ../wicked-core/crates/wicked-core-ts && npm install && npm run build
//     node scripts/use-local-core-ts.mjs
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import type { RepoEntry } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

let adapter: CoreAdapter;
let dir: string;
let repoDir: string;
let entry: RepoEntry;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'engine-contract-'));
  // registerRepo prepares a worktree, so it insists on a git repo with at least one commit. Identity
  // is set locally so this does not depend on a global git config.
  repoDir = mkdtempSync(join(tmpdir(), 'engine-contract-repo-'));
  const git = (...a: string[]): void => {
    execFileSync('git', a, { cwd: repoDir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'engine contract fixture');
  git('commit', '-q', '--allow-empty', '-m', 'root');

  adapter = new CoreAdapter({ dbPath: join(dir, 'contract.db'), stub: true });
  entry = await adapter.registerRepo('engine-contract-fixture', repoDir);
});

afterAll(() => {
  if (adapter) adapter.close();
  // See armed-workflow-served.test.ts: close() returns before the actor thread finishes flushing
  // SQLite's WAL sidecars, and `force` does not cover the ENOTEMPTY that races with it.
  if (dir) removeScratch(dir);
  if (repoDir) removeScratch(repoDir);
});

describe('the resolved wicked-core-ts is new enough for this code', () => {
  it('publishes code_graph_db on a registered repo (wicked-core#170)', () => {
    expect(
      entry.code_graph_db,
      'the resolved wicked-core-ts predates code_graph_db (wicked-core#170), so every ' +
        'graph-backed surface in this package is broken at runtime — see FINDING-072',
    ).toBeTypeOf('string');
    expect(entry.code_graph_db).not.toBe('');
  });

  it('publishes it as an absolute path, since nothing here resolves it against a cwd', () => {
    // The run's workdir is a per-run worktree, not the repo root — a relative path would resolve
    // differently for the indexer and for the worker querying it. That divergence IS FINDING-069.
    expect(isAbsolute(entry.code_graph_db ?? '')).toBe(true);
  });
});
