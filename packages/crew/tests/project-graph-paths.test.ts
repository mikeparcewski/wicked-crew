/**
 * The project graph's location and its repo labels — the two things that, spelled twice, produce a
 * silently wrong graph.
 *
 * The label tests exist because estate binds a label to a repo PERMANENTLY: re-indexing a repo under
 * a second label is refused as a duplicate, and re-using a label for a different repo is refused as
 * a collision. So `repoLabel` must be a pure, stable function of the registry id — an id-derived
 * label that moved when a repo was renamed would strand the graph on the next refresh.
 *
 * The path tests pin the two rules that keep this out of trouble: nothing under a repo checkout (we
 * have just cleaned `.codegraph/` out of six working trees), and a project id that is not a legal
 * path segment is REJECTED rather than sanitized — two ids sanitizing into one directory is the same
 * silent-overwrite class this whole feature exists to close.
 */
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  assertProjectIdIsPathSafe,
  isValidRepoLabel,
  projectGraphDb,
  projectGraphDir,
  projectGraphManifest,
  projectGraphRoot,
  projectGraphRootForDb,
  repoLabel,
} from '../src/projects/graph-paths.js';

/** estate's own rule, restated independently of the implementation (repo_scope.rs::validate_label). */
function estateWouldAccept(label: string): boolean {
  return (
    label.length >= 1 &&
    label.length <= 64 &&
    label !== '.' &&
    label !== '..' &&
    [...label].every((c) => /[A-Za-z0-9]/.test(c) || c === '-' || c === '_' || c === '.')
  );
}

describe('repoLabel', () => {
  it('uses the registry id verbatim — every id in the live registry is already a legal label', () => {
    // Read off `GET /api/v1/repos` on the running daemon. The registry's `wicked-core` row is
    // deliberately NOT listed: core-checkout-policy.test.ts audits every test file for a quoted
    // `wicked-core`, because five hand-spelled sibling-checkout paths is what FINDING-094 was, and
    // an audit with a carve-out for "but I only meant it as data" is an audit people route around.
    const live = [
      'wicked-ledger',
      'wicked-vault',
      'wicked-installer',
      'wicked-crew',
      'wicked-estate',
      'wicked-garden',
      'wicked-studio',
      'wicked-interactive',
      'wicked-web',
      'wickedagile',
      'pageindex-proof',
      'uxr-payments-repo',
      'anything-llm',
    ];
    for (const id of live) {
      expect(repoLabel(id)).toBe(id);
      expect(estateWouldAccept(repoLabel(id))).toBe(true);
    }
  });

  it('mints a legal label for ids estate would refuse, and never returns one it would refuse', () => {
    const hostile = [
      'acme/widgets', // `/` would forge a path in another repo's namespace
      '..', // estate refuses this one by name
      '.',
      '', // empty
      'repo with spaces',
      'ünïcödé-repo',
      'a'.repeat(200), // over the 64-char ceiling
      'repo:8080',
      '../../etc/passwd',
    ];
    for (const id of hostile) {
      const label = repoLabel(id);
      expect(estateWouldAccept(label), `label for ${JSON.stringify(id)}: ${label}`).toBe(true);
      expect(isValidRepoLabel(label)).toBe(true);
      expect(label).not.toContain('/');
    }
  });

  it('is STABLE — the same id always mints the same label (estate binds it permanently)', () => {
    for (const id of ['acme/widgets', 'wicked-ledger', 'a'.repeat(200)]) {
      expect(repoLabel(id)).toBe(repoLabel(id));
    }
  });

  it('keeps ids apart that sanitize identically — the digest is of the FULL id, not the stem', () => {
    // `acme/widgets` and `acme:widgets` both collapse to `acme-widgets` once illegal characters go.
    // Without the digest they would be ONE label, and the second repo would overwrite the first.
    expect(repoLabel('acme/widgets')).not.toBe(repoLabel('acme:widgets'));
    // Same argument past the truncation point: two 200-char ids sharing their first 51 characters.
    const long = 'x'.repeat(60);
    expect(repoLabel(`${long}/alpha`)).not.toBe(repoLabel(`${long}/beta`));
  });
});

describe('project graph paths', () => {
  const env = { WICKED_CREW_PROJECT_GRAPH_ROOT: join(sep, 'tmp', 'pg') } as NodeJS.ProcessEnv;

  it('defaults under the daemon state directory, NOT under any repo checkout', () => {
    const root = projectGraphRoot({} as NodeJS.ProcessEnv);
    expect(root).toBe(join(homedir(), '.wicked-crew', 'project-graphs'));
    // The failure this pins: a project graph written into a member repo's working tree, which is
    // what `.codegraph/estate.db` does per-repo and what was just cleaned out of six checkouts.
    expect(root).not.toContain('.codegraph');
  });

  it('honours WICKED_CREW_PROJECT_GRAPH_ROOT', () => {
    expect(projectGraphRoot(env)).toBe(join(sep, 'tmp', 'pg'));
  });

  it('treats an EMPTY WICKED_CREW_PROJECT_GRAPH_ROOT as unset, not as the empty path', () => {
    // `VAR=` is the ordinary shell idiom for clearing a variable. Taken literally it produced the
    // bare relative `project-graphs`, which scatters a graph per directory the daemon started from.
    const root = projectGraphRoot({ WICKED_CREW_PROJECT_GRAPH_ROOT: '' } as NodeJS.ProcessEnv);
    expect(root).toBe(join(homedir(), '.wicked-crew', 'project-graphs'));
  });

  it('returns the override TRIMMED, not merely tested trimmed (Copilot on #339)', () => {
    // Judging presence by the trimmed value and then USING the untrimmed one is what turns a stray
    // space — the ordinary cost of copying a path out of a log line — into a graph directory whose
    // name nobody can type again, silently distinct from the one the operator meant.
    const padded = {
      WICKED_CREW_PROJECT_GRAPH_ROOT: `  ${join(sep, 'tmp', 'pg')}  `,
    } as NodeJS.ProcessEnv;
    expect(projectGraphRoot(padded)).toBe(join(sep, 'tmp', 'pg'));
    expect(projectGraphDb('proj_1', padded)).toBe(join(sep, 'tmp', 'pg', 'proj_1', 'code-graph.db'));
  });

  it('puts the database and its manifest in ONE per-project directory', () => {
    const dir = projectGraphDir('proj_178751942378800000', env);
    expect(dir).toBe(join(sep, 'tmp', 'pg', 'proj_178751942378800000'));
    expect(projectGraphDb('proj_178751942378800000', env)).toBe(join(dir, 'code-graph.db'));
    expect(projectGraphManifest('proj_178751942378800000', env)).toBe(join(dir, 'manifest.json'));
  });

  it('accepts the ids the daemon actually mints, including the synthesized default', () => {
    expect(() => assertProjectIdIsPathSafe('proj_178751942378800000')).not.toThrow();
    expect(() => assertProjectIdIsPathSafe('default')).not.toThrow();
  });

  it('REJECTS a project id that is not a legal path segment — never sanitizes it', () => {
    // Sanitizing is what would let two project ids share one database. It is also the traversal
    // guard: the id is spliced into a filesystem path.
    for (const bad of ['../../etc', 'a/b', '', '.', '..', 'a'.repeat(65)]) {
      expect(() => assertProjectIdIsPathSafe(bad), JSON.stringify(bad)).toThrow(
        /cannot address a project graph directory/,
      );
      expect(() => projectGraphDb(bad, env)).toThrow();
    }
  });
});

describe('the project-graph root implied by a --db (crew#330)', () => {
  it('is the store’s sibling, so one --db moves the graph with it', () => {
    // The observed failure: `serve --db <scratch>/core.db --bus-db <scratch>/bus.db` moved the
    // engine store and the bus, and left a 41.7 MB graph in the developer's real ~/.wicked-crew,
    // keyed by project ids that existed only in the scratch store — so nothing could reap them.
    //
    // The expectation is `resolve`d, not spelled with a bare `sep` (Copilot on #339): a root-
    // relative path is only half-absolute on win32, where `resolve` supplies the current drive.
    // `\scratch\project-graphs` would then fail against a correct `C:\scratch\project-graphs` —
    // a green POSIX suite hiding a test that cannot pass on Windows at all.
    const storeDir = resolve(join(sep, 'scratch'));
    expect(projectGraphRootForDb(join(storeDir, 'core.db'))).toBe(join(storeDir, 'project-graphs'));
  });

  it('resolves a relative --db against the cwd, exactly as the store itself is resolved', () => {
    expect(projectGraphRootForDb(join('rel', 'core.db'))).toBe(join(resolve('rel'), 'project-graphs'));
  });

  it('declines a store that is not a file — an in-memory db has no sibling directory', () => {
    // `dirname(resolve(':memory:'))` is the cwd, which would plant the graph wherever the daemon
    // happened to be started from — a WORSE landing site than the state home, because it moves.
    expect(projectGraphRootForDb(':memory:')).toBeNull();
    expect(projectGraphRootForDb('file::memory:?cache=shared')).toBeNull();
    expect(projectGraphRootForDb('   ')).toBeNull();
  });
});

describe('the rejection message names the rule that actually fired (Copilot on #326)', () => {
  it('a relative path segment is refused for being one, not for its characters', () => {
    for (const id of ['.', '..']) {
      let msg = '';
      try {
        assertProjectIdIsPathSafe(id);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain('relative path segment');
      // The charset line would be actively misleading here: `.` and `..` SATISFY it.
      expect(msg).not.toContain('[A-Za-z0-9._-]');
    }
  });

  it('an illegal character is still reported as an illegal character', () => {
    let msg = '';
    try {
      assertProjectIdIsPathSafe('a/b');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('[A-Za-z0-9._-]');
  });
});
