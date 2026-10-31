// A registered repo whose folder is gone is named, never reported as `spawn <binary> ENOENT`.
//
// Rig :7721: tiny-math was registered under a lane folder named `target`; a cleanup that removed
// every `target/` as build output deleted it. Node reports a missing spawn `cwd` exactly like a
// missing binary, so the repo page said "couldn't load the code map — spawn wicked-estate ENOENT"
// and its history said "git executable not found on server", both about installed binaries.
//
// Pins:
//   - `listRepos` carries crew's `repo_folder_missing` finding for a repo whose folder is gone (and
//     only then; never twice; the engine's own findings kept);
//   - every repo route that spawns there answers 409 in the finding's words and spawns nothing;
//     so do a launch and a chat that name the repo;
//   - `execCapped` names a missing cwd instead of ENOENT; a missing BINARY is still ENOENT;
//   - the Nerve Center carries a `repos` row, `down`, and Needs-you an item with the fix.

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { resolveChatScope } from '../src/api/chat-scope.js';
import { buildNeeds } from '../src/api/needs.js';
import { reposRow } from '../src/api/system-snapshot.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { ExecCwdMissing, execCapped } from '../src/core/exec.js';
import {
  REPO_FOLDER_MISSING,
  repoFolderMissing,
  repoFolderMissingMessage,
  withFolderFindings,
} from '../src/core/repoPaths.js';
import type { RepoEntry } from '../src/core/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-repo-folder-missing-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['WICKED_ESTATE_EXE'];
  delete process.env['STUB_ARGV_LOG'];
});

function repo(id: string, root: string, extra: Partial<RepoEntry> = {}): RepoEntry {
  return {
    id,
    name: id,
    root_path: root,
    default_branch: 'main',
    registered_at: 1,
    code_graph_db: join(dir, `${id}.db`),
    findings: [],
    ...extra,
  };
}

describe('listRepos: the repo_folder_missing finding', () => {
  it('is added for a folder that is gone, with the path and the fix, and not for one that is there', async () => {
    const here = join(dir, 'here');
    mkdirSync(here);
    const gone = join(dir, 'target');
    const [a, b] = await withFolderFindings([repo('here', here), repo('tiny-math', gone)]);
    expect(repoFolderMissing(a!)).toBeNull();
    expect(b!.findings).toEqual([{ code: REPO_FOLDER_MISSING, message: repoFolderMissingMessage(gone), path: gone }]);
    expect(b!.findings![0]!.message).toBe(
      `This repository's folder is missing: ${gone}. Re-link it: register it again under the same name at its folder's new place, or put the folder back.`,
    );
  });

  it('a FILE where the folder was counts as missing; the engine findings are kept and the finding is never doubled', async () => {
    const file = join(dir, 'file');
    writeFileSync(file, '');
    const engine = { code: 'in_tree_code_graph_ignored', message: 'old graph', path: '/x' };
    const once = await withFolderFindings([repo('r', file, { findings: [engine] })]);
    const twice = await withFolderFindings(once);
    expect(twice[0]!.findings!.map((f) => f.code)).toEqual(['in_tree_code_graph_ignored', REPO_FOLDER_MISSING]);
  });

  it('a folder that comes back clears the finding', async () => {
    const root = join(dir, 'back');
    const [stale] = await withFolderFindings([repo('r', root)]);
    mkdirSync(root);
    const [fresh] = await withFolderFindings([stale!]);
    expect(repoFolderMissing(fresh!)).toBeNull();
  });

  it('CoreAdapter.listRepos decorates what the engine lists', async () => {
    const gone = join(dir, 'gone');
    const self = { core: { listRepos: async () => JSON.stringify([repo('tiny-math', gone)]) } };
    const listed = await CoreAdapter.prototype.listRepos.call(self as unknown as CoreAdapter);
    expect(repoFolderMissing(listed[0]!)?.path).toBe(gone);
  });
});

describe('execCapped: a missing cwd is named, not ENOENT', () => {
  it('names the folder, with a code no missing-binary branch claims', async () => {
    const gone = join(dir, 'gone');
    const err = await execCapped(process.execPath, ['-e', '0'], { cwd: gone }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecCwdMissing);
    expect((err as Error).message).toContain(gone);
    expect((err as { code: string }).code).not.toBe('ENOENT');
  });

  it('a missing BINARY in a folder that exists is still ENOENT', async () => {
    const err = await execCapped(join(dir, 'no-such-binary'), [], { cwd: dir }).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('ENOENT');
  });
});

const STUB = `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write('{"nodes":[],"edges":[]}');
`;

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('repo routes, launch and chat refuse a missing folder by name (409), spawning nothing', () => {
  let app: FastifyInstance;
  let argvLog: string;
  let gone: string;
  const launchRun = vi.fn();

  beforeEach(async () => {
    const exe = join(dir, 'stub-estate');
    writeFileSync(exe, STUB);
    chmodSync(exe, 0o755);
    argvLog = join(dir, 'argv.log');
    writeFileSync(argvLog, '');
    process.env['WICKED_ESTATE_EXE'] = exe;
    process.env['STUB_ARGV_LOG'] = argvLog;
    gone = join(dir, 'lanes', 'e2e', 'target');
    const r = repo('tiny-math', gone);
    writeFileSync(r.code_graph_db!, ''); // a built graph: only the folder is missing
    const adapter = {
      listRepos: () => withFolderFindings([r]),
      getSettings: vi.fn().mockResolvedValue({ graphNodeLimit: 150 }),
      launchOnboardingRun: launchRun,
      launchRun,
    };
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      adapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const expectRefused = (res: { statusCode: number; json: () => unknown }): void => {
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: REPO_FOLDER_MISSING, error: repoFolderMissingMessage(gone), path: gone });
  };

  it.each([
    ['GET', '/api/v1/repos/tiny-math/graph'],
    ['GET', '/api/v1/repos/tiny-math/graph/blast-radius?name=sum'],
    ['GET', '/api/v1/repos/tiny-math/domain-graph'],
    ['GET', '/api/v1/repos/tiny-math/git-history'],
    ['GET', '/api/v1/repos/tiny-math/contributors'],
    ['POST', '/api/v1/repos/tiny-math/onboard'],
  ] as const)('%s %s', async (method, url) => {
    const res = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
    expectRefused(res);
    expect(readFileSync(argvLog, 'utf8')).toBe('');
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('POST /runs naming the repo is refused before the engine sees it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix sum', repoRef: 'tiny-math' } });
    expectRefused(res);
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('a chat naming the repo is refused in the same words', async () => {
    const res = await resolveChatScope(
      { chatId: 'c1', repoRefs: ['tiny-math'] },
      {
        listRepos: () => withFolderFindings([repo('tiny-math', gone)]),
        projectRepoRefs: async () => [],
        bindProjectGraph: async () => ({ binding: null, reason: 'unbound' }),
        scratchBase: join(dir, 'chats'),
        entityCount: async () => 1,
      },
    );
    expect(res).toEqual({ ok: false, status: 409, code: REPO_FOLDER_MISSING, error: repoFolderMissingMessage(gone) });
  });
});

describe('Nerve Center and Needs-you carry a missing folder as a fixable item', () => {
  it('the repos row is down, names each repo with its path, and says how to fix it', async () => {
    const here = join(dir, 'here');
    mkdirSync(here);
    const gone = join(dir, 'target');
    const repos = await withFolderFindings([repo('wicked-core', here), repo('tiny-math', gone)]);
    const row = reposRow({ kind: 'ok', value: repos, ms: 1 });
    expect(row.key).toBe('repos');
    expect(row.label).toBe('Repositories');
    expect(row.state).toBe('down');
    expect(row.reason).toBe(`This repository's folder is missing: tiny-math (${gone}). Its code map, history, chats and new jobs cannot run.`);
    expect(row.remedy).toBe("Re-link it: register it again under the same name at its folder's new place, or put the folder back.");
    expect(row.details).toEqual({ registered: 2, missing: [{ id: 'tiny-math', name: 'tiny-math', path: gone }] });

    const needs = buildNeeds({ now: Date.now(), views: [], runs: [], infra: [row], clis: [], gaps: [], infraHoldsLive: () => false });
    expect(needs.attention).toHaveLength(1);
    expect(needs.attention[0]).toMatchObject({
      id: 'infra:repos',
      severity: 'red',
      kind: 'prevents',
      title: 'Repositories: folder missing',
      remedy: row.remedy,
      target: { kind: 'infra', key: 'repos' },
    });
  });

  it('every folder present reads ok and needs nothing; an unanswered list reads unknown', async () => {
    const here = join(dir, 'here');
    mkdirSync(here);
    const ok = reposRow({ kind: 'ok', value: await withFolderFindings([repo('a', here)]), ms: 1 });
    expect(ok.state).toBe('ok');
    expect(ok.remedy).toBeNull();
    expect(buildNeeds({ now: Date.now(), views: [], runs: [], infra: [ok], clis: [], gaps: [], infraHoldsLive: () => false }).attention).toEqual([]);
    expect(reposRow({ kind: 'timeout', ms: 4000 }).state).toBe('unknown');
    expect(reposRow({ kind: 'error', error: 'engine gone', ms: 1 }).reason).toContain('engine gone');
  });
});
