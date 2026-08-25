/**
 * The REFRESH path — the half of the project graph that was proved in throwaway scripts and left
 * unpinned by the suite.
 *
 * # Why this file exists
 *
 * project-graph-route.test.ts stops one step short of `wicked-estate` on purpose: every case it
 * covers is decided before a binary would run. That left the build itself — the `--repo` label on
 * every invocation, the capability probe, the post-index evidence check, the incremental skip rule,
 * the label-uniqueness pre-flight, the stale-repo bookkeeping — with no test at all. An adversarial
 * mutation pass confirmed it: dropping `--repo` from the index command, indexing only the FIRST
 * member and stopping, skipping every repo that has any prior manifest row, and making the
 * capability probe return `true` for every binary ALL passed the suite unchanged. Those are the
 * four mutations that reproduce wicked-estate#117's silent data loss exactly.
 *
 * # Why a stub binary rather than the real estate
 *
 * `WICKED_ESTATE_EXE` is the seam the module already publishes, and the properties under test are
 * properties of the CALL crew makes and of what it does with the answer — which repos it indexes,
 * under which labels, in which order, and what it refuses. A stub can also be a wicked-estate that
 * ACCEPTS `--repo` AND IGNORES IT (0.14.4's actual behaviour), which is the failure the probe and
 * the evidence check exist for and which no installed binary can be made to reproduce on demand.
 *
 * POSIX-only: the stub is a `#!/usr/bin/env node` script and `execFile` cannot run a `.cmd` shim
 * without a shell. Skipped rather than silently vacuous on Windows.
 */
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { registerProjectRoutes } from '../src/projects/routes.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { ProjectSettingsStore } from '../src/projects/settings.js';
import { repoLabel } from '../src/projects/graph-paths.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { Project, ProjectMember, RepoEntry } from '../src/core/types.js';

const POSIX = process.platform !== 'win32';
const PROJECT_ID = 'proj_refresh';

/**
 * A wicked-estate stand-in.
 *
 * Records every `index` invocation verbatim so a test can assert the exact argv crew built, and
 * enforces the one refusal that matters here — `repo_scope.rs::guard`'s "label already bound to
 * another repo", the one a moved checkout trips.
 *
 * Two env switches reproduce the two broken binaries this surface has to survive:
 *   STUB_NO_REPO_FLAG=1  — a pre-#117 usage banner (no `--repo`), what the probe must catch.
 *   STUB_DROPS_REPO=1    — 0.14.4 exactly: takes `--repo`, ignores it, exits 0. Nothing but the
 *                          post-index read of `stats` can tell this one from a working build.
 */
const STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };

if (argv.includes('--help') || cmd === undefined) {
  const repoLine = process.env.STUB_NO_REPO_FLAG === '1' ? '' : ' [--repo <name>]';
  process.stdout.write('stub-estate 9.9.9 — usage:\\n');
  process.stdout.write('  wicked-estate index <path>         [--db <file|:memory:>]' + repoLine + ' [--force]\\n');
  process.exit(0);
}

const db = opt('--db');
const state = () => { try { return JSON.parse(fs.readFileSync(db, 'utf8')); } catch { return { repos: {} }; } };
const save = (s) => fs.writeFileSync(db, JSON.stringify(s, null, 2));

if (cmd === 'index') {
  const root = argv[1];
  const label = process.env.STUB_DROPS_REPO === '1' ? undefined : opt('--repo');
  fs.appendFileSync(db + '.calls', JSON.stringify(argv) + '\\n');
  // A real index takes seconds; a stub returns in a millisecond. STUB_INDEX_DELAY_MS widens the
  // window a second caller has to arrive in, so the coalescing test is testing coalescing rather
  // than the luck of an event-loop ordering.
  const delay = Number(process.env.STUB_INDEX_DELAY_MS || 0);
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  const s = state();
  // guard #4: a label is bound to the root it was first indexed from.
  if (label !== undefined && s.repos[label] !== undefined && s.repos[label].root !== root) {
    process.stderr.write("Error: invalid argument: REPO COLLISION: label '" + label +
      "' is already bound to " + s.repos[label].root + " in this graph\\n");
    process.exit(1);
  }
  // An UNLABELLED index is 0.14.4's: paths are not namespaced, so it overwrites whatever was in
  // the database and leaves no labelled-repo registry behind at all. Verified against the real
  // 0.14.4 — two labelled repos in, then \`stats\` prints an empty \`repo:\` block and the first
  // repo's symbols resolve to nothing.
  if (label === undefined) s.repos = {};
  const key = label === undefined ? '__unlabelled__' : label;
  let names = [];
  try {
    names = String(fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8'))
      .split(/\\r?\\n/)
      .map((l) => (l.match(/function ([A-Za-z0-9_]+)/) || [])[1])
      .filter(Boolean);
  } catch { names = []; }
  s.repos[key] = { root, names };
  save(s);
  process.stdout.write('indexed ' + root + '\\n');
  process.exit(0);
}

if (cmd === 'stats') {
  const s = state();
  const labels = Object.keys(s.repos).filter((l) => l !== '__unlabelled__');
  process.stdout.write('nodes=1 edges=0 files=1\\n');
  if (labels.length > 0) {
    process.stdout.write('repos (' + labels.length + '):\\n');
    for (const l of labels.sort()) process.stdout.write('  ' + l + '  files=1  root=' + s.repos[l].root + '\\n');
  }
  process.exit(0);
}

if (cmd === 'resolve' || cmd === 'blast-radius') {
  const want = argv[1];
  const s = state();
  const hits = [];
  for (const [label, rec] of Object.entries(s.repos)) {
    if (!rec.names.includes(want)) continue;
    const prefix = label === '__unlabelled__' ? '' : label + '/';
    hits.push({ id: 'sym ' + prefix + want, name: want, kind: 'Function', file: prefix + 'src/index.ts', line: 1 });
  }
  process.stdout.write(
    cmd === 'resolve' ? JSON.stringify(hits) : JSON.stringify({ target: want, dependents: hits, unresolved: 0 }),
  );
  process.exit(0);
}
process.stderr.write('stub-estate: unexpected ' + argv.join(' ') + '\\n');
process.exit(2);
`;

interface Fixture {
  app: FastifyInstance;
  work: string;
  graphRoot: string;
  dbPath: string;
  repos: Map<string, RepoEntry>;
  members: string[];
}
let fx: Fixture;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A real git repo whose `src/index.ts` exports a symbol unique to it plus one every repo shares. */
function makeRepo(name: string): string {
  const root = join(fx.work, 'repos', name);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'index.ts'),
    `export function sharedName(): string { return '${name}'; }\nexport function only_${name}(): number { return 1; }\n`,
  );
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@example.invalid'], root);
  git(['config', 'user.name', 'test'], root);
  git(['add', '-A'], root);
  git(['commit', '-qm', 'init'], root);
  return root;
}

function register(id: string, root: string): void {
  fx.repos.set(id, {
    id,
    name: id,
    root_path: root,
    default_branch: 'main',
    registered_at: 0,
    code_graph_db: join(root, '.codegraph', 'estate.db'),
  });
}

function attach(...ids: string[]): void {
  fx.members = ids;
}

function member(ref: string): ProjectMember {
  return {
    id: `${PROJECT_ID}:crew.repo:${ref}`,
    project_id: PROJECT_ID,
    member_kind: 'crew.repo',
    member_ref: ref,
    meta: null,
    attached_at: 0,
    attached_by: 'api',
  };
}

/** Every `index` argv the stub was handed, in order. */
function indexCalls(): string[][] {
  if (!existsSync(`${fx.dbPath}.calls`)) return [];
  return readFileSync(`${fx.dbPath}.calls`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as string[]);
}

interface Hit {
  repoId: string;
  repo: string;
  file: string;
  name: string;
  kind: string;
  line: number;
}
interface StatusBody {
  state: string;
  detail: string;
  missingRepos: string[];
  staleRepos: string[];
  repos: Array<{ repoId: string; label: string; indexed: boolean; reason?: string }>;
  linkage: string;
  note: string;
}
interface RefreshBody {
  status: StatusBody;
  indexed: string[];
  skipped: string[];
  failed: Array<{ repoId: string; label: string; error: string }>;
  error?: string;
}
interface QueryBase {
  byRepo: Array<{ repoId: string; repo: string; count: number }>;
  reposSearched: string[];
  missingRepos: string[];
  linkage: string;
  note: string;
}
interface SearchBody extends QueryBase {
  matches: Hit[];
}
interface BlastBody extends QueryBase {
  dependents: Hit[];
  unresolved: number;
}

async function refresh(): Promise<{ code: number; body: RefreshBody }> {
  const res = await fx.app.inject({
    method: 'POST',
    url: `/api/v1/projects/${PROJECT_ID}/graph/refresh`,
  });
  return { code: res.statusCode, body: res.json() as RefreshBody };
}

async function get<T>(path: string): Promise<{ code: number; body: T }> {
  const res = await fx.app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}${path}` });
  return { code: res.statusCode, body: res.json() as T };
}

const status = async (): Promise<StatusBody> =>
  (await get<{ status: StatusBody }>('/graph')).body.status;

beforeEach(() => {
  const work = mkdtempSync(join(tmpdir(), 'crew-graph-refresh-'));
  const graphRoot = join(work, 'graphs');
  const exe = join(work, 'stub-estate');
  writeFileSync(exe, STUB);
  chmodSync(exe, 0o755);
  process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'] = graphRoot;
  process.env['WICKED_ESTATE_EXE'] = exe;
  delete process.env['STUB_NO_REPO_FLAG'];
  delete process.env['STUB_DROPS_REPO'];
  delete process.env['STUB_INDEX_DELAY_MS'];

  fx = {
    app: undefined as unknown as FastifyInstance,
    work,
    graphRoot,
    dbPath: join(graphRoot, PROJECT_ID, 'code-graph.db'),
    repos: new Map(),
    members: [],
  };

  const adapter = {
    projectGet: vi.fn(async (id: string) => ({ id, name: id, status: 'active' }) as unknown as Project),
    projectMembers: vi.fn(async () => fx.members.map(member)),
    listRepos: vi.fn(async () => [...fx.repos.values()]),
    projectList: vi.fn(async () => []),
    sessions: vi.fn(async () => []),
    chatList: vi.fn(async () => []),
  } as unknown as CoreAdapter;

  fx.app = Fastify({ logger: false });
  registerProjectRoutes(fx.app, adapter, {
    bus: null,
    index: new MembershipIndex(),
    log: () => undefined,
    settings: new ProjectSettingsStore(join(work, 'settings.json')),
  });
});

afterEach(async () => {
  await fx.app?.close();
  delete process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'];
  delete process.env['WICKED_ESTATE_EXE'];
  delete process.env['STUB_NO_REPO_FLAG'];
  delete process.env['STUB_DROPS_REPO'];
  delete process.env['STUB_INDEX_DELAY_MS'];
  rmSync(fx.work, { recursive: true, force: true });
});

describe.skipIf(!POSIX)('POST /projects/:id/graph/refresh — the build itself', () => {
  it('indexes EVERY member repo, each under its own --repo label', async () => {
    for (const n of ['alpha', 'beta', 'gamma']) register(n, makeRepo(n));
    attach('alpha', 'beta', 'gamma');

    const res = await refresh();
    expect(res.code).toBe(200);
    expect([...res.body['indexed']].sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(res.body['failed']).toEqual([]);

    // Not "three calls happened" — the exact flag that makes co-location possible, on each of them.
    // Dropping `--repo` is wicked-estate#117's silent loss: three repos in, a graph holding one.
    const calls = indexCalls();
    expect(calls).toHaveLength(3);
    for (const label of ['alpha', 'beta', 'gamma']) {
      const call = calls.find((c) => c[1] === fx.repos.get(label)!.root_path);
      expect(call, `no index call for ${label}`).toBeDefined();
      expect(call).toContain('--repo');
      expect(call![call!.indexOf('--repo') + 1]).toBe(label);
      expect(call![call!.indexOf('--db') + 1]).toBe(fx.dbPath);
    }
    expect(res.body['status']['state']).toBe('ready');
  });

  it('a symbol every repo shares comes back once per repo, each attributed', async () => {
    for (const n of ['alpha', 'beta']) register(n, makeRepo(n));
    attach('alpha', 'beta');
    await refresh();

    const found = await get<SearchBody>('/graph/search?name=sharedName');
    expect(found.code).toBe(200);
    expect(found.body['matches'].map((m) => [m.repo, m.repoId, m.file])).toEqual([
      ['alpha', 'alpha', 'src/index.ts'],
      ['beta', 'beta', 'src/index.ts'],
    ]);
    expect(found.body['byRepo']).toEqual([
      { repoId: 'alpha', repo: 'alpha', count: 1 },
      { repoId: 'beta', repo: 'beta', count: 1 },
    ]);
  });

  it('a symbol unique to one repo is attributed to THAT repo only', async () => {
    for (const n of ['alpha', 'beta']) register(n, makeRepo(n));
    attach('alpha', 'beta');
    await refresh();
    const found = await get<SearchBody>('/graph/search?name=only_beta');
    expect(found.body['matches'].map((m) => m.repo)).toEqual(['beta']);
  });

  it('REFUSES to index anything through an estate whose usage banner has no --repo', async () => {
    process.env['STUB_NO_REPO_FLAG'] = '1';
    for (const n of ['alpha', 'beta']) register(n, makeRepo(n));
    attach('alpha', 'beta');

    const res = await refresh();
    expect(res.code).toBe(400);
    expect(res.body['error']).toMatch(/does not support 'index --repo/);
    // The point of probing BEFORE the first index: nothing was written, so there is no half-built
    // graph holding one repo of three to mistake for a whole one.
    expect(indexCalls()).toEqual([]);
    expect(existsSync(fx.dbPath)).toBe(false);
  });

  it('REFUSES an estate that accepts --repo and ignores it — the help text is a claim, stats is the evidence', async () => {
    // 0.14.4 exactly. The banner advertises the flag; the database never records a label.
    process.env['STUB_DROPS_REPO'] = '1';
    for (const n of ['alpha', 'beta']) register(n, makeRepo(n));
    attach('alpha', 'beta');

    const res = await refresh();
    expect(res.code).toBe(400);
    expect(res.body['error']).toMatch(/records no repo labelled/);
    // It stops at the FIRST repo's evidence rather than letting repo 2 overwrite repo 1. Collecting
    // this in `failed` and carrying on — which is what it used to do — runs a full index per member
    // against a binary that cannot keep them apart, each clobbering the last, while every entry's
    // message says "Refusing to continue". One index call, and only one.
    expect(indexCalls()).toHaveLength(1);
    expect((await status())['state']).not.toBe('ready');
  });

  it('re-indexes only what changed — clean and unmoved and at the same commit is skipped', async () => {
    for (const n of ['alpha', 'beta']) register(n, makeRepo(n));
    attach('alpha', 'beta');
    await refresh();
    expect(indexCalls()).toHaveLength(2);

    const second = await refresh();
    expect(second.body['indexed']).toEqual([]);
    expect([...second.body['skipped']].sort()).toEqual(['alpha', 'beta']);
    expect(indexCalls()).toHaveLength(2); // no new invocation at all

    // A new commit in beta is positive evidence of change: beta re-indexes, alpha still does not.
    writeFileSync(join(fx.repos.get('beta')!.root_path, 'src', 'added.ts'), 'export const x = 1;\n');
    git(['add', '-A'], fx.repos.get('beta')!.root_path);
    git(['commit', '-qm', 'more'], fx.repos.get('beta')!.root_path);
    const third = await refresh();
    expect(third.body['indexed']).toEqual(['beta']);
    expect(third.body['skipped']).toEqual(['alpha']);
  });

  it('a DIRTY checkout is re-indexed — a working tree cannot be identified by its HEAD', async () => {
    register('alpha', makeRepo('alpha'));
    attach('alpha');
    await refresh();
    writeFileSync(join(fx.repos.get('alpha')!.root_path, 'src', 'dirty.ts'), 'export const y = 2;\n');
    const res = await refresh();
    expect(res.body['indexed']).toEqual(['alpha']);
    expect(res.body['skipped']).toEqual([]);
  });

  it('a DELETED database re-indexes everything — a surviving manifest must never fake a fresh graph', async () => {
    for (const n of ['alpha', 'beta']) register(n, makeRepo(n));
    attach('alpha', 'beta');
    await refresh();
    rmSync(fx.dbPath);
    rmSync(`${fx.dbPath}.calls`);
    // The manifest still describes both repos. Trusting it here would skip both, leave the graph
    // empty, and make the project answer "nothing found" for ever.
    const res = await refresh();
    expect([...res.body['indexed']].sort()).toEqual(['alpha', 'beta']);
    expect(res.body['skipped']).toEqual([]);
    expect(indexCalls()).toHaveLength(2);
  });

  it('REFUSES before indexing when two members would share one estate label', async () => {
    // `acme/widgets` is not a legal estate label and is minted to this sanitized+digested form,
    // which another repo happens to carry as its literal registry id. One label, two repos: the
    // second would overwrite the first under a name that looks right in every result.
    const minted = repoLabel('acme/widgets');
    register('acme/widgets', makeRepo('slashy'));
    register(minted, makeRepo('collider'));
    attach('acme/widgets', minted);

    const res = await refresh();
    expect(res.code).toBe(400);
    expect(res.body['error']).toMatch(/both map to the estate label/);
    expect(indexCalls()).toEqual([]);
  });

  it('indexes an illegal repo id under a minted label and maps hits back to the ORIGINAL id', async () => {
    register('acme/widgets', makeRepo('slashy'));
    attach('acme/widgets');
    const res = await refresh();
    expect(res.body['indexed']).toEqual([repoLabel('acme/widgets')]);
    const found = await get<SearchBody>('/graph/search?name=only_slashy');
    expect(found.body['matches']).toHaveLength(1);
    expect(found.body['matches'][0]!['repoId']).toBe('acme/widgets');
    expect(found.body['matches'][0]!['repo']).toBe(repoLabel('acme/widgets'));
  });

  it('names a detached member as stale and stops answering about it', async () => {
    for (const n of ['alpha', 'beta']) register(n, makeRepo(n));
    attach('alpha', 'beta');
    await refresh();

    attach('alpha'); // beta detached; estate has no per-label delete, so its rows remain
    const status = await get<{ status: StatusBody }>('/graph');
    expect(status.body['status']['staleRepos']).toEqual(['beta']);
    const found = await get<SearchBody>('/graph/search?name=sharedName');
    expect(found.body['matches'].map((m) => m.repo)).toEqual(['alpha']);
    expect(found.body['reposSearched']).toEqual(['alpha']);
  });
});

/**
 * REGRESSION — a repo that moved on disk.
 *
 * wicked-estate binds a label to the root it first saw and refuses to rebind it, so the refresh of
 * a moved checkout FAILS. Before this was fixed the manifest's prior row survived that failure and
 * `buildStatus` read it as proof the repo was indexed: `GET /graph` answered `state: "ready"`,
 * `missingRepos: []`, `repos[i].indexed: true` with the CURRENT root printed beside a commit that
 * was only ever read from the OLD one — while `/graph/search` kept serving the old checkout's
 * symbols. Every subsequent refresh failed identically, so it never healed and never said so.
 */
describe.skipIf(!POSIX)('a member repo re-registered at a new path', () => {
  it('is reported NOT indexed, is excluded from answers, and names both roots', async () => {
    for (const n of ['alpha', 'gamma']) register(n, makeRepo(n));
    attach('alpha', 'gamma');
    await refresh();
    expect((await get<{ status: StatusBody }>('/graph')).body['status']['state']).toBe('ready');

    const from = fx.repos.get('gamma')!.root_path;
    const to = join(fx.work, 'repos', 'gamma-moved');
    renameSync(from, to);
    register('gamma', to);

    const res = await refresh();
    expect(res.body['failed']).toHaveLength(1);
    expect(res.body['failed'][0]!['error']).toMatch(/REPO COLLISION/);

    const status = (await get<{ status: StatusBody }>('/graph')).body['status'];
    expect(status['missingRepos']).toEqual(['gamma']);
    expect(status['state']).toBe('ready-single-repo');
    const row = status['repos'].find((r) => r.repoId === 'gamma');
    expect(row!['indexed']).toBe(false);
    expect(row!['reason']).toContain(from);
    expect(row!['reason']).toContain(to);
    // The stale rows are excluded rather than served as if they described the current checkout.
    const found = await get<SearchBody>('/graph/search?name=only_gamma');
    expect(found.body['matches']).toEqual([]);
    expect(found.body['reposSearched']).toEqual(['alpha']);
    expect(found.body['missingRepos']).toEqual(['gamma']);
  });
});

/**
 * REGRESSION — the evidence check must re-run on EVERY refresh, not once per database.
 *
 * The check used to be seeded `verifiedLabelling = dbExisted && priorByLabel.size > 0`, which made
 * it a one-time initiation: once any run had written labels, no later run looked at the database
 * again. But the thing it guards is a property of the BINARY, not of the graph. Swap in one that
 * advertises `--repo` and drops it — a downgrade, a vendored build, a re-pointed
 * `WICKED_ESTATE_EXE` — and it clears the help-text probe, indexes over the labelled rows, and the
 * refresh answers 200 / `indexed: [...]` / `failed: []` while `GET /graph` still reads `ready`,
 * `missingRepos: []`, and every query returns `[]` at 200. Reproduced end to end against the real
 * wicked-estate 0.14.4 wearing a newer usage banner.
 */
describe.skipIf(!POSIX)('an estate downgraded AFTER the graph was built', () => {
  it('is caught on the next refresh, and the graph stops claiming to be ready', async () => {
    for (const n of ['alpha', 'beta']) register(n, makeRepo(n));
    attach('alpha', 'beta');
    await refresh();
    expect((await status())['state']).toBe('ready');
    expect((await get<SearchBody>('/graph/search?name=only_alpha')).body['matches']).toHaveLength(1);

    // The binary changes under a graph that is already good, and one repo changes so it is not
    // skipped. Nothing about the DATABASE says anything is wrong — only the next `stats` does.
    process.env['STUB_DROPS_REPO'] = '1';
    writeFileSync(join(fx.repos.get('beta')!.root_path, 'src', 'more.ts'), 'export const q = 1;\n');

    const res = await refresh();
    expect(res.code).toBe(400);
    expect(res.body['error']).toMatch(/records no repo labelled/);

    // Loud on the READ path too. The offending index already overwrote the labelled rows, so a
    // manifest that still describes them would answer `ready` about a graph holding nothing this
    // surface can attribute — 200 with `matches: []`, which reads as "not in this project".
    const after = await status();
    expect(after['state']).toBe('not-indexed');
    expect([...after['missingRepos']].sort()).toEqual(['alpha', 'beta']);
    const q = await get<SearchBody>('/graph/search?name=only_alpha');
    expect(q.code).toBe(404);
  });
});

/**
 * CONCURRENCY — the one property a mutation pass found completely uncovered.
 *
 * Two `wicked-estate index` processes writing one SQLite file is a writer race, and nothing in the
 * refresh path serializes at the filesystem: the guard is the in-flight map alone. Deleting that
 * map passed the whole suite, which meant the only thing standing between a double-clicked Refresh
 * and two concurrent writers was a comment.
 *
 * The assertion is INVOCATION COUNT, not response equality. Two uncoalesced refreshes of a
 * deterministic build produce identical bodies too — comparing them proves nothing about whether
 * the work ran once.
 */
describe.skipIf(!POSIX)('two refreshes at once', () => {
  it('COALESCE onto one build — never two estate writers on one database', async () => {
    process.env['STUB_INDEX_DELAY_MS'] = '250';
    for (const n of ['alpha', 'beta']) register(n, makeRepo(n));
    attach('alpha', 'beta');

    const [a, b] = await Promise.all([refresh(), refresh()]);
    expect(a.code).toBe(200);
    expect(b.code).toBe(200);
    // Two repos, TWO index calls total. Four means both refreshes ran the build.
    expect(indexCalls()).toHaveLength(2);
    // And the second caller is served the first's answer rather than a fabricated one.
    expect(b.body).toEqual(a.body);
    expect([...a.body['indexed']].sort()).toEqual(['alpha', 'beta']);
  });

  it('releases the slot when the build finishes, so a later refresh really runs', async () => {
    register('alpha', makeRepo('alpha'));
    attach('alpha');
    await Promise.all([refresh(), refresh()]);
    expect(indexCalls()).toHaveLength(1);

    // A stuck in-flight entry would make every subsequent refresh return the old result for ever.
    writeFileSync(join(fx.repos.get('alpha')!.root_path, 'src', 'later.ts'), 'export const z = 3;\n');
    const after = await refresh();
    expect(after.body['indexed']).toEqual(['alpha']);
    expect(indexCalls()).toHaveLength(2);
  });

  it('releases the slot after a FAILED build too', async () => {
    process.env['STUB_NO_REPO_FLAG'] = '1';
    register('alpha', makeRepo('alpha'));
    attach('alpha');
    expect((await refresh()).code).toBe(400);

    delete process.env['STUB_NO_REPO_FLAG'];
    const ok = await refresh();
    expect(ok.code).toBe(200);
    expect(ok.body['indexed']).toEqual(['alpha']);
  });
});

describe.skipIf(!POSIX)('what the answers promise', () => {
  it('never claims cross-repo linkage, and search states that it matches exact names only', async () => {
    register('alpha', makeRepo('alpha'));
    attach('alpha');
    await refresh();

    const found = await get<SearchBody>('/graph/search?name=shared'); // a PREFIX, not the name
    expect(found.code).toBe(200);
    expect(found.body['matches']).toEqual([]);
    // An empty result from an exact-name resolver must not read as "not in this project".
    expect(found.body['note']).toMatch(/exact-name/i);
    expect(found.body['note']).toMatch(/never "not in this project"/i);

    // Pinned as the DENIALS the note has to make, not as equality with the constant: comparing a
    // payload to the same string the payload is built from passes just as happily when that string
    // is rewritten to claim the opposite, which is what a mutation pass found it doing.
    const blast = (await get<BlastBody>('/graph/blast-radius?name=sharedName')).body;
    for (const payload of [found.body, blast] as QueryBase[]) {
      expect(payload['linkage']).toBe('co-located');
      expect(payload['note']).toMatch(/not linked/i);
      expect(payload['note']).toMatch(/edges do not resolve across repos/i);
      expect(payload['note']).toMatch(/never a cross-repo trace/i);
    }
  });
});
