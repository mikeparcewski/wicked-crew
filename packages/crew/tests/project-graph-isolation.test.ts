/**
 * crew#330 — project graphs must FOLLOW `--db`, never escape to the real home.
 *
 * # The bug this file pins
 *
 * `wicked-crew serve --db $SCRATCH/core.db --bus-db $SCRATCH/bus.db --port 7788` read as a fully
 * isolated daemon — and then built its project graph at `~/.wicked-crew/project-graphs/<id>/
 * code-graph.db` (41.7 MB, observed), because `projectGraphRoot()` resolved from `homedir()`
 * unconditionally. Every other durable thing the flags control moved; this one silently didn't,
 * keyed by project ids only the scratch store ever knew, with nothing to reap them.
 *
 * # The fix under test
 *
 * The CLI bootstrap threads the RESOLVED state home — `stateHomeOfDb(dbPath)`, the `--db` parent —
 * into the shared state-home seam via `setCrewStateHome` (state-home.ts — generalized from this module's private seam when crew#353 found the settings store making the same escape), and `projectGraphRoot` prefers it over the
 * homedir fallback. Precedence, most-specific first:
 *
 *   1. `WICKED_CREW_PROJECT_GRAPH_ROOT` (explicit env override — the pre-existing escape hatch)
 *   2. the configured state home + `/project-graphs` (NEW — what `--db` implies)
 *   3. `~/.wicked-crew/project-graphs` (the default, identical to pre-fix behaviour)
 *
 * The end-to-end case drives the REAL refresh route (fake adapter, stub estate binary — the same
 * seams project-graph-refresh.test.ts uses) with a tmp state home configured and NO env override,
 * then asserts the graph landed inside the isolated dir and that `$HOME/.wicked-crew` holds no
 * trace of the project. That is the exact observation from the issue, inverted.
 *
 * POSIX-only for the route-level case: the stub is a `#!/usr/bin/env node` script and `execFile`
 * cannot run a `.cmd` shim without a shell. The pure precedence cases run everywhere.
 */
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { registerProjectRoutes } from '../src/projects/routes.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { ProjectSettingsStore } from '../src/projects/settings.js';
import { projectGraphDb, projectGraphManifest, projectGraphRoot } from '../src/projects/graph-paths.js';
import { setCrewStateHome, stateHomeOfDb } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { Project, ProjectMember, RepoEntry } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const POSIX = process.platform !== 'win32';

/** Unique to this suite so the "$HOME holds no trace" assertion can never collide with a real
 *  daemon's graphs on a developer machine. */
const PROJECT_ID = 'proj_330_isolation_regress';

const NO_ENV = {} as NodeJS.ProcessEnv;

afterEach(() => {
  // Module state must never leak into another test (or another file's expectations of the
  // homedir default).
  setCrewStateHome(undefined);
});

describe('projectGraphRoot precedence (crew#330)', () => {
  it('a configured state home moves the root — the --db parent owns the graphs', () => {
    setCrewStateHome(join(sep, 'scratch', 'daemon-a'));
    expect(projectGraphRoot(NO_ENV)).toBe(join(sep, 'scratch', 'daemon-a', 'project-graphs'));
    // And the db/manifest hang off it — the paths the refresh path actually writes.
    expect(projectGraphDb(PROJECT_ID, NO_ENV)).toBe(
      join(sep, 'scratch', 'daemon-a', 'project-graphs', PROJECT_ID, 'code-graph.db'),
    );
    expect(projectGraphManifest(PROJECT_ID, NO_ENV)).toBe(
      join(sep, 'scratch', 'daemon-a', 'project-graphs', PROJECT_ID, 'manifest.json'),
    );
  });

  it('WICKED_CREW_PROJECT_GRAPH_ROOT still outranks the configured state home', () => {
    setCrewStateHome(join(sep, 'scratch', 'daemon-a'));
    const env = { WICKED_CREW_PROJECT_GRAPH_ROOT: join(sep, 'ci', 'pg') } as NodeJS.ProcessEnv;
    expect(projectGraphRoot(env)).toBe(join(sep, 'ci', 'pg'));
  });

  it('no configured state home ⇒ the historical homedir default (library/unit consumers)', () => {
    setCrewStateHome(undefined);
    expect(projectGraphRoot(NO_ENV)).toBe(join(homedir(), '.wicked-crew', 'project-graphs'));
  });

  it('the default daemon (no --db) resolves byte-identically to the pre-fix path', () => {
    // What cli/index.ts does when --db is absent: dbPath = ~/.wicked-crew/core.db.
    setCrewStateHome(stateHomeOfDb(join(homedir(), '.wicked-crew', 'core.db')));
    expect(projectGraphRoot(NO_ENV)).toBe(join(homedir(), '.wicked-crew', 'project-graphs'));
  });

  it('stateHomeOfDb is the --db parent, absolutized so a relative --db cannot drift', () => {
    expect(stateHomeOfDb(join(sep, 'x', 'y', 'core.db'))).toBe(join(sep, 'x', 'y'));
    expect(stateHomeOfDb(join('scratch', 'core.db'))).toBe(resolve('scratch'));
  });
});

// ── The end-to-end regression: an isolated refresh writes NOTHING under $HOME ─────────────────

/**
 * A minimal wicked-estate stand-in: advertises `--repo` in its usage banner (so the capability
 * probe passes), records labels into the db file on `index`, and prints the labelled-repo block
 * on `stats` (so the post-index evidence check passes). Everything it writes goes to the `--db`
 * path crew hands it — which is the property under test.
 */
const STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
if (argv.includes('--help') || argv[0] === undefined) {
  process.stdout.write('stub-estate 9.9.9 — usage:\\n');
  process.stdout.write('  wicked-estate index <path>         [--db <file|:memory:>] [--repo <name>] [--force]\\n');
  process.exit(0);
}
const db = opt('--db');
const state = () => { try { return JSON.parse(fs.readFileSync(db, 'utf8')); } catch { return { repos: {} }; } };
if (argv[0] === 'index') {
  const s = state();
  s.repos[opt('--repo')] = { root: argv[1] };
  fs.writeFileSync(db, JSON.stringify(s));
  process.exit(0);
}
if (argv[0] === 'stats') {
  const s = state();
  const labels = Object.keys(s.repos);
  process.stdout.write('nodes=1 edges=0 files=1\\n');
  if (labels.length > 0) {
    process.stdout.write('repos (' + labels.length + '):\\n');
    for (const l of labels.sort()) process.stdout.write('  ' + l + '  files=1  root=' + s.repos[l].root + '\\n');
  }
  process.exit(0);
}
process.stderr.write('stub-estate: unexpected ' + argv.join(' ') + '\\n');
process.exit(2);
`;

describe.skipIf(!POSIX)('POST /graph/refresh under an isolated state home (crew#330)', () => {
  let app: FastifyInstance;
  let work: string;
  let stateHome: string;
  const repos = new Map<string, RepoEntry>();
  let members: string[] = [];
  let savedEnvRoot: string | undefined;

  function git(args: string[], cwd: string): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }

  function makeRepo(name: string): string {
    const root = join(work, 'repos', name);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), `export function fn_${name}(): number { return 1; }\n`);
    git(['init', '-q', '-b', 'main'], root);
    git(['config', 'user.email', 'test@example.invalid'], root);
    git(['config', 'user.name', 'test'], root);
    git(['add', '-A'], root);
    git(['commit', '-qm', 'init'], root);
    return root;
  }

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'crew-330-'));
    // The shape the daemon sees: `--db <work>/state/core.db` ⇒ state home = <work>/state.
    stateHome = join(work, 'state');
    mkdirSync(stateHome, { recursive: true });
    const exe = join(work, 'stub-estate');
    writeFileSync(exe, STUB);
    chmodSync(exe, 0o755);
    process.env['WICKED_ESTATE_EXE'] = exe;
    // The point of the test: NO env override. The configured state home must carry alone.
    savedEnvRoot = process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'];
    delete process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'];
    setCrewStateHome(stateHomeOfDb(join(stateHome, 'core.db')));

    repos.clear();
    members = [];
    const adapter = {
      projectGet: vi.fn(async (id: string) => ({ id, name: id, status: 'active' }) as unknown as Project),
      projectMembers: vi.fn(async () =>
        members.map(
          (ref): ProjectMember => ({
            id: `${PROJECT_ID}:crew.repo:${ref}`,
            project_id: PROJECT_ID,
            member_kind: 'crew.repo',
            member_ref: ref,
            meta: null,
            attached_at: 0,
            attached_by: 'api',
          }),
        ),
      ),
      listRepos: vi.fn(async () => [...repos.values()]),
      projectList: vi.fn(async () => []),
      sessions: vi.fn(async () => []),
      chatList: vi.fn(async () => []),
    } as unknown as CoreAdapter;

    app = Fastify({ logger: false });
    registerProjectRoutes(app, adapter, {
      bus: null,
      index: new MembershipIndex(),
      log: () => {},
      settings: new ProjectSettingsStore(join(work, 'settings.json')),
    });
  });

  afterEach(async () => {
    await app?.close();
    delete process.env['WICKED_ESTATE_EXE'];
    if (savedEnvRoot === undefined) delete process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'];
    else process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'] = savedEnvRoot;
    setCrewStateHome(undefined);
    removeScratch(work);
  });

  // Generous timeout: the case shells out (git init/commit + the stub estate) and has been
  // observed at 35s under a fully loaded suite run — the default 30s made it flake under load.
  it('builds the graph INSIDE the isolated state home and leaves $HOME untouched', { timeout: 120_000 }, async () => {
    const root = makeRepo('alpha');
    repos.set('alpha', {
      id: 'alpha',
      name: 'alpha',
      root_path: root,
      default_branch: 'main',
      registered_at: 0,
      code_graph_db: join(root, '.codegraph', 'estate.db'),
    } as RepoEntry);
    members = ['alpha'];

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/graph/refresh`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { indexed: string[]; failed: unknown[] };
    expect(body.indexed).toEqual(['alpha']);
    expect(body.failed).toEqual([]);

    // The graph and its manifest landed under the --db parent…
    const isolatedDir = join(stateHome, 'project-graphs', PROJECT_ID);
    expect(existsSync(join(isolatedDir, 'code-graph.db'))).toBe(true);
    expect(existsSync(join(isolatedDir, 'manifest.json'))).toBe(true);

    // …and the developer's real home holds NO trace of this project. This is the exact
    // observation from crew#330 ("a scratch daemon wrote ~/.wicked-crew/project-graphs/<id>/
    // code-graph.db"), inverted. The project id is unique to this suite, so a real daemon's
    // graphs on the machine running the tests cannot produce a false failure — or mask a real one.
    expect(existsSync(join(homedir(), '.wicked-crew', 'project-graphs', PROJECT_ID))).toBe(false);
  });
});
