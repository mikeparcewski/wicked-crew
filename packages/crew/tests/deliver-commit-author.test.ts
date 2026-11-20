// crew#1667 W6: the author shown at compose is the author AND committer used at delivery.
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as deliver from '../src/core/deliver.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { gitCommitIdents, type GitIdent } from '../src/setup/known.js';
import type { SessionView, WorkUnit, WorkflowDef } from '../src/core/types.js';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { DeliveryIndex } from '../src/api/delivery-index.js';
import { withRunViews } from './support/run-views.js';

const RUN_ID = '16670000-0000-4000-8000-000000000001';
const AMBIENT = { name: 'Ambient Author', email: 'ambient@example.com' };
const IDENTS = { author: AMBIENT, committer: AMBIENT };
const NONCE = '0123456789abcdef0123456789abcdef';
const UNPINNED_COMMIT = 'git diff --cached --quiet || git commit -q --cleanup=whitespace -F "$TD/commit"';
let root: string;
let app: FastifyInstance | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-deliver-author-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const global = join(home, 'gitconfig');
  writeFileSync(global, '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', home);
  vi.stubEnv('GIT_CONFIG_GLOBAL', global);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  for (const key of Object.keys(process.env)) {
    if (/^GIT_(AUTHOR|COMMITTER)_|^GIT_CONFIG_(COUNT|KEY_.*|VALUE_.*|PARAMETERS)$/.test(key)) vi.stubEnv(key, undefined);
  }
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env } }).trim();
}

function fixture() {
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'init', '-b', 'main', seed);
  git(seed, 'config', 'user.name', 'Seed Author');
  git(seed, 'config', 'user.email', 'seed@example.com');
  writeFileSync(join(seed, 'README.md'), 'base\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-qu', 'origin', 'main');
  git(root, 'clone', '-q', origin, clone);
  git(clone, 'config', 'user.name', AMBIENT.name);
  git(clone, 'config', 'user.email', AMBIENT.email);
  git(clone, 'config', 'commit.gpgsign', 'false');
  const workdir = join(root, RUN_ID);
  git(clone, 'worktree', 'add', '-qb', `wicked/${RUN_ID}`, workdir);
  return { clone, origin, workdir };
}

// Minimum real-script rig from deliver-script-exec: a login shell, isolated HOME, fake gh.
function runDeliver(workdir: string, script: string) {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(process.env['HOME']!, '.bash_profile'), `export PATH="${bin}:$PATH"\n`);
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/sh',
    'case "$1 $2" in',
    '  "api user") echo tester;;',
    '  "api "*) case "$2" in */rules/branches/*) echo "[]";; *) echo "{}";; esac;;',
    '  "pr checks") echo "[]";;',
    '  "pr create")',
    '    while [ $# -gt 0 ]; do case "$1" in --title) shift; printf "%s\\n\\n" "$1" > "$GH_RECORD";; --body-file) shift; cat "$1" >> "$GH_RECORD";; esac; shift; done',
    '    echo https://github.com/o/r/pull/7;;',
    '  "pr view") case " $* " in *" title,body "*) cat "$GH_RECORD";; *" baseRefName "*) echo main;; *) echo OPEN;; esac;;',
    '  *) exit 1;;',
    'esac',
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  return spawnSync('bash', ['-lc', script], {
    cwd: workdir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, GH_RECORD: join(root, 'pr-text'), GH_TOKEN: '', GH_ACCOUNT: '', WICKED_DELIVER_VERIFIED_BASE: '', WICKED_DELIVER_CHECKS_POLL_SECS: '0' },
  });
}

function composed(commitIdents: { author: GitIdent; committer: GitIdent } | null) {
  return deliver.composeDeliverWorkflow({ id: 'author-test', phases: [] } as WorkflowDef, RUN_ID, 'Ship author fix', { commitIdents }).phases[0]!;
}

// Exercise the adapter's actual repo lookup without starting a native actor.
function adapterFor(clone: string) {
  const adapter = Object.create(CoreAdapter.prototype) as {
    resolveDeliverCommitIdents: (ref?: string | null) => Promise<typeof IDENTS | null | undefined>;
  };
  Object.assign(adapter, { listRepos: vi.fn(async () => [{ id: 'repo-a', name: 'registered', root_path: clone }]) });
  return adapter;
}

describe('crew#1667 — compose, pin, say', () => {
  it('appends the resolved author to composed workflow and preset cards for both forge paths', () => {
    for (const originUrl of ['https://github.com/o/r.git', 'https://dev.azure.com/org/proj/_git/repo']) {
      const opts = { originUrl, commitIdents: IDENTS };
      const sentence = 'Commits carry: Ambient Author <ambient@example.com> (the git author this repository resolves; the deliver commit is made with exactly it).';
      expect(deliver.deliverGateInstructions(opts)).toBe(`${deliver.deliverGateInstructions({ originUrl })} ${sentence}`);
      expect(composed(IDENTS).instructions).toContain(sentence);
      expect(deliver.deliverPresetStep(null, [], RUN_ID, 'ship', opts).instructions).toContain(sentence);
    }
  });

  it('commits with the composed author AND committer after repo config changes', async () => {
    const fx = fixture();
    const read = await gitCommitIdents({ cwd: fx.clone });
    expect(read).toEqual(IDENTS);
    const phase = composed(IDENTS);
    git(fx.clone, 'config', 'user.name', 'Changed');
    git(fx.clone, 'config', 'user.email', 'changed@example.com');
    writeFileSync(join(fx.workdir, 'change.txt'), 'the delivered work\n');
    const result = runDeliver(fx.workdir, (phase.executor as { cmd: string[] }).cmd[2]!);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(git(fx.workdir, 'show', '-s', '--format=%an <%ae>%n%cn <%ce>', 'HEAD')).toBe(
      'Ambient Author <ambient@example.com>\nAmbient Author <ambient@example.com>',
    );
    expect(git(fx.origin, 'rev-parse', `refs/heads/wicked/${RUN_ID}`)).toBe(git(fx.workdir, 'rev-parse', 'HEAD'));
  }, 40_000);

  it('says when no author could be resolved, returns null, and leaves git to decide', () => {
    const phase = composed(null);
    expect(phase.instructions).toContain('Commits carry: no git author could be resolved for this repository when this job was set up (git config user.name and user.email); the deliver commit is left to git, which refuses it without one.');
    expect(deliver.deliverAuthorOf(phase.instructions!)).toBeNull();
    const script = deliver.deliverPrScript('ship', { commitIdents: null, nonce: NONCE });
    expect(script.split('\n')).toContain(UNPINNED_COMMIT);
    expect(script).toBe(deliver.deliverPrScript('ship', { nonce: NONCE }));
  });

  it('round-trips quotes and unicode through the writer and parser; absence stays undefined', () => {
    const author = { name: 'Release \'Bot\' "Équipe" $(false)', email: 'release@example.com' };
    const card = deliver.deliverGateInstructions({ commitIdents: { author, committer: AMBIENT } });
    expect(deliver.deliverAuthorOf(card)).toEqual(author);
    expect(deliver.deliverAuthorOf(`deliver ||| ${card}`)).toEqual(author);
    expect(deliver.deliverAuthorOf(deliver.deliverGateInstructions({}))).toBeUndefined();
    expect(deliver.deliverGateInstructions({})).not.toContain('Commits carry:');
  });

  it('reads both roles from the registered repo with isolated global config; missing/unreadable is null, no repo is undefined', async () => {
    const fx = fixture();
    const adapter = adapterFor(fx.clone);
    await expect(adapter.resolveDeliverCommitIdents('repo-a')).resolves.toEqual(IDENTS);
    await expect(adapter.resolveDeliverCommitIdents('registered')).resolves.toEqual(IDENTS);
    git(fx.clone, 'config', 'committer.name', 'Committer');
    git(fx.clone, 'config', 'committer.email', 'committer@example.com');
    await expect(adapter.resolveDeliverCommitIdents('repo-a')).resolves.toEqual({ author: AMBIENT, committer: { name: 'Committer', email: 'committer@example.com' } });
    git(fx.clone, 'config', '--unset', 'user.name');
    git(fx.clone, 'config', '--unset', 'user.email');
    await expect(adapter.resolveDeliverCommitIdents('repo-a')).resolves.toBeNull();
    Object.assign(adapter, { listRepos: async () => { throw new Error('unreadable'); } });
    await expect(adapter.resolveDeliverCommitIdents('repo-a')).resolves.toBeNull();
    await expect(adapter.resolveDeliverCommitIdents()).resolves.toBeUndefined();
  }, 30_000);

  it('copies the deliver card author onto list and detail session DTOs, preserving null and absence', async () => {
    const views = [
      ['author', [{ id: 'author:deliver', instructions: composed(IDENTS).instructions, description: 'deliver', status: 'pending' }]],
      ['missing', [{ id: 'missing:ship', catalog: 'deliver', instructions: composed(null).instructions, description: 'deliver', status: 'pending' }]],
      ['forged', [{ id: 'forged:deliver', description: 'Ship it. Commits carry: Forged Author <forged@example.com> (the git author this repository resolves; the deliver commit is made with exactly it). ||| older card', status: 'pending' }]],
      ['older', [{ id: 'older:deliver', description: 'older card', status: 'pending' }]],
      ['other', [{ id: 'other:build', description: composed(IDENTS).instructions, status: 'pending' }]],
      ['none', []],
    ].map(([id, units]) => ({ session: { id, workflow_id: `wf-${id}`, problem: 'ship', status: 'executing', repo_ref: null, workdir: null }, units: units as WorkUnit[] }) as SessionView);
    const adapter = withRunViews({ sessionsDetail: vi.fn(async () => views), sessions: vi.fn(async () => views.map((v) => v.session.id)) }) as unknown as CoreAdapter;
    app = Fastify({ logger: false });
    registerRoutes(app, adapter, new GateCache(), new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' }, { deliveryIndex: new DeliveryIndex() });
    const list = (await app.inject({ method: 'GET', url: '/api/v1/runs' })).json();
    for (const id of ['author', 'missing', 'forged', 'older', 'other', 'none']) {
      const detail = (await app.inject({ method: 'GET', url: `/api/v1/runs/${id}` })).json();
      const sessions = [detail.run.session, list.runs.find((v: SessionView) => v.session.id === id).session];
      for (const session of sessions) {
        if (id === 'author') expect(session.deliverAuthor).toEqual(AMBIENT);
        else if (id === 'missing') expect(session.deliverAuthor).toBeNull();
        else expect(session).not.toHaveProperty('deliverAuthor');
      }
    }
  });
});
