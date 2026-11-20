import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registerRoutes, type RuntimeDeps } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { DeliveryIndex } from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import { withRunViews } from './support/run-views.js';
import { removeScratch } from './setup/scratch.js';

const id = 'redeliver-run';
const url = 'https://github.com/o/r/pull/42';
const roots: string[] = [];
const apps: FastifyInstance[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env } }).trim();
}
function fixture(conflict = 'CHANGELOG.md') {
  const root = mkdtempSync(join(tmpdir(), 'crew-redeliver-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const clone = join(root, 'clone');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, clone);
  git(clone, 'config', 'user.name', 'tester');
  git(clone, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(clone, 'CHANGELOG.md'), '# Changes\n\n## [Unreleased]\n\n### Fixed\n\n- baseline\n');
  writeFileSync(join(clone, 'code.txt'), 'baseline\n');
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'base');
  const oldBase = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'checkout', '-qb', 'delivered');
  writeFileSync(join(clone, conflict), conflict === 'CHANGELOG.md' ? '# Changes\n\n## [Unreleased]\n\n### Fixed\n\n- run\n- baseline\n' : 'run\n');
  writeFileSync(join(clone, 'feature.txt'), 'feature\n');
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'run');
  const old = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'push', '-q', 'origin', 'delivered');
  git(clone, 'checkout', '-q', 'main');
  writeFileSync(join(clone, conflict), conflict === 'CHANGELOG.md' ? '# Changes\n\n## [Unreleased]\n\n### Fixed\n\n- main\n- baseline\n' : 'main\n');
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'base advanced');
  git(clone, 'push', '-q', 'origin', 'main');
  const base = git(clone, 'rev-parse', 'HEAD');
  const home = join(root, 'home'); const bin = join(root, 'bin');
  mkdirSync(home); mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const log = join(root, 'gh.log'); const pushLog = join(root, 'push.log');
  // Every network git operation is intercepted BEFORE the real executable. The canonical
  // GitHub URL is mapped to the bare local origin; no GitHub connection is possible.
  writeFileSync(join(bin, 'git'), `#!/bin/bash\nunset GIT_ALLOW_PROTOCOL GIT_CONFIG_COUNT\na=()\nfor x in "$@"; do [ "$x" != 'https://github.com/o/r.git' ] || x='${origin}'; a+=("$x"); done\nprintf '%s\\n' "$*" >> '${pushLog}'\nexec '${realGit}' "\${a[@]}"\n`);
  writeFileSync(join(bin, 'gh'), `#!/bin/bash\nif [ \"\${GH_FAIL_MUTATIONS:-}\" = 1 ] && { [ \"$2\" = comment ] || [ \"$2\" = edit ]; }; then echo 'fixture mutation failure' >&2; exit 1; fi\ncase "$1 $2" in\n'auth status') exit 0;;\n'pr view') if [[ "$*" == *'--json body'* ]]; then echo 'Original body'; else cat '${join(root, 'pr.json')}'; fi;;\n'pr comment') printf '%s\\n' "$*" >> '${log}';;\n'pr edit') cat "\${@: -1}" >> '${log}';;\n*) echo "unexpected gh: $*" >&2; exit 1;;\nesac\n`);
  chmodSync(join(bin, 'git'), 0o755); chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(home, '.bash_profile'), `export PATH='${bin}':$PATH\n`);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'fixture-token', GH_ACCOUNT: '' };
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
  const pr = { number: 42, url, state: 'OPEN', isCrossRepository: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', baseRefName: 'main', headRefName: 'delivered', headRefOid: old, statusCheckRollup: [] as unknown[] };
  const savePr = () => writeFileSync(join(root, 'pr.json'), JSON.stringify(pr)); savePr();
  const index = new DeliveryIndex(); index.set(id, url, { verified: false, via: 'post_hoc', receipt: null, treeBefore: null, treeAfter: null, qeAcceptance: null }, old);
  const check = vi.fn<NonNullable<RuntimeDeps['checkRunTree']>>(async (_id: string, wd: string, _repo: string, checkedBase: string) => ({ head: git(wd, 'rev-parse', 'HEAD'), tree: git(wd, 'rev-parse', 'HEAD^{tree}'), base: checkedBase, passed: true, checksRun: 2, report: { checks: [{ name: 'install', exit_code: 0, timed_out: false, decision: { outcome: 'pass' } }, { name: 'unit', exit_code: 0, timed_out: false, decision: { outcome: 'pass' } }, { name: 'lint', exit_code: 0, timed_out: false, decision: { outcome: 'pass' } }] } }));
  const audit = AuditLog.noop(); const record = vi.spyOn(audit, 'record');
  const view = { session: { id, status: 'completed', repo_ref: 'repo', workdir: null }, units: [] } as unknown as SessionView;
  const runtime = { deliveryIndex: index, checkRunTree: check,
    redeliverGhExec: async (args: string[]) => ({ code: 0, stdout: execFileSync(join(bin, 'gh'), args, { env, encoding: 'utf8' }), stderr: '' }),
    redeliverExec: async (wd: string, script: string) => {
      try { return { status: 0, output: execFileSync('bash', ['-lc', script], { cwd: wd, env, encoding: 'utf8' }) }; }
      catch (err) { const e = err as { status: number; stdout: string; stderr: string }; return { status: e.status, output: `${e.stdout}${e.stderr}` }; }
    },
  } as RuntimeDeps;
  const app = Fastify(); apps.push(app);
  registerRoutes(app, withRunViews({ getSettings: async () => ({}), sessionsDetail: async () => [view], sessions: async () => [id], listRepos: async () => [{ id: 'repo', root_path: clone }] } as unknown as CoreAdapter), new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit, authMode: 'off' }, runtime);
  return { root, origin, clone, old, oldBase, base, env, log, pushLog, pr, savePr, index, check, record, app, view, runtime };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const root of roots.splice(0)) removeScratch(root); });
const post = (app: FastifyInstance) => app.inject({ method: 'POST', url: `/api/v1/runs/${id}/redeliver` });

it('T1/T5 rebases CHANGELOG only, checks the exact tree, leases the push and discloses the same result', async () => {
  const f = fixture(); const res = await post(f.app);
  expect(res.statusCode, res.body).toBe(200);
  const r = res.json();
  expect(r).toMatchObject({ prUrl: url, oldHead: f.old, checks: { passed: true, count: 2, names: ['unit', 'lint'] }, conflictsResolved: ['CHANGELOG.md'] });
  expect(git(f.origin, 'rev-parse', 'delivered')).toBe(r.newHead);
  expect(git(f.origin, 'show', 'delivered:CHANGELOG.md')).toContain('- run');
  expect(git(f.origin, 'show', 'delivered:CHANGELOG.md')).toContain('- main');
  expect(git(f.clone, 'diff', f.oldBase, f.old, '--', '.', ':!CHANGELOG.md')).toBe(git(f.clone, 'diff', f.base, r.newHead, '--', '.', ':!CHANGELOG.md'));
  expect(f.check).toHaveBeenCalledWith(id, expect.any(String), f.clone, f.base);
  expect(readFileSync(f.pushLog, 'utf8')).toContain(`--force-with-lease=refs/heads/delivered:${f.old}`);
  const words = readFileSync(f.log, 'utf8');
  for (const text of [f.old, r.newHead, 'PASS (2 checks)', 'unit', 'lint', 'post_hoc', 'Original body']) expect(words).toContain(text);
  expect(f.index.commitFor(id)).toBe(r.newHead);
  expect(f.record).toHaveBeenCalledWith('run.redelivered', expect.anything(), { runId: id, detail: { url, old: f.old, new: r.newHead, checks: r.checks, via: 'redeliver' } });
  expect(git(f.clone, 'worktree', 'list')).not.toContain('wicked-redeliver');
});
it('T2 refuses other-file conflicts before checks or push', async () => {
  const f = fixture('code.txt'); const res = await post(f.app);
  expect(res.statusCode).toBe(409); expect(res.json().conflicts).toEqual(['code.txt']);
  expect(f.check).not.toHaveBeenCalled(); expect(git(f.origin, 'rev-parse', 'delivered')).toBe(f.old);
});
it('T3 refuses failed repo checks without push or comment', async () => {
  const f = fixture(); f.check.mockImplementation(async (_id, wd, _repo, base) => ({ head: git(wd, 'rev-parse', 'HEAD'), tree: git(wd, 'rev-parse', 'HEAD^{tree}'), base, passed: false, checksRun: 1, report: { checks: [{ name: 'install', exit_code: 0, timed_out: false }, { name: 'unit', exit_code: 1, timed_out: false, decision: { outcome: 'new_failure' } }] } }));
  const res = await post(f.app); expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ failingChecks: ['unit'], report: { checks: [{ name: 'install', exit_code: 0, timed_out: false }, { name: 'unit', exit_code: 1, timed_out: false, decision: { outcome: 'new_failure' } }] } });
  expect(git(f.origin, 'rev-parse', 'delivered')).toBe(f.old);
  expect(() => readFileSync(f.log)).toThrow();
});
it('T4a refuses a remotely moved branch before rebasing or checks', async () => {
  const f = fixture(); git(f.origin, 'update-ref', 'refs/heads/delivered', f.base);
  const res = await post(f.app); expect(res.statusCode).toBe(409); expect(res.json().error).toMatch(/moved/i);
  expect(f.check).not.toHaveBeenCalled(); expect(git(f.origin, 'rev-parse', 'delivered')).toBe(f.base);
});
it('T4b refuses a stale lease when the branch moves during repo checks', async () => {
  const f = fixture(); const check = f.check.getMockImplementation()!;
  f.check.mockImplementation(async (...args) => { const r = await check(...args); git(f.origin, 'update-ref', 'refs/heads/delivered', f.base); return r; });
  const res = await post(f.app); expect(res.statusCode).toBe(409); expect(res.json().error).toMatch(/moved/i);
  expect(git(f.origin, 'rev-parse', 'delivered')).toBe(f.base); expect(() => readFileSync(f.log)).toThrow();
});
it('T6 reads PR status, headMoved and failing checks; names missing deliveries and unknown runs', async () => {
  const f = fixture(); f.pr.statusCheckRollup = [{ name: 'unit', conclusion: 'FAILURE' }, { context: 'legacy', state: 'ERROR' }, { name: 'ok', conclusion: 'SUCCESS' }]; f.savePr();
  const get = () => f.app.inject(`/api/v1/runs/${id}/pr`);
  const res = await get(); expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ number: 42, url, state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', baseRefName: 'main', headRefName: 'delivered', headSha: f.old, deliveredHead: f.old, headMoved: false, failingChecks: ['unit', 'legacy'] });
  f.pr.headRefOid = f.base; f.savePr(); expect((await get()).json().headMoved).toBe(true);
  f.pr.statusCheckRollup = [
    ...['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].map((conclusion) => ({ name: conclusion, conclusion })),
    { context: 'status-failure', state: 'FAILURE' }, { context: 'status-error', state: 'ERROR' },
    { name: 'pending', state: 'PENDING' },
  ]; f.savePr();
  expect((await get()).json().failingChecks).toEqual(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'status-failure', 'status-error']);
  expect((await f.app.inject('/api/v1/runs/unknown/pr')).statusCode).toBe(404);
  f.index.set(id, url); const noHead = (await get()).json();
  expect(noHead.headMoved).toBe(false); expect(noHead).not.toHaveProperty('deliveredHead');
  f.index.set(id, ''); expect((await get()).statusCode).toBe(409); expect((await post(f.app)).statusCode).toBe(409);
  f.index.set(id, url); git(f.clone, 'remote', 'set-url', 'origin', f.origin);
  expect((await get()).json().error).toContain('re-delivery supports GitHub PRs only');
  expect((await f.app.inject({ method: 'POST', url: '/api/v1/runs/unknown/redeliver' })).statusCode).toBe(404);
});
it.each(['status', 'head', 'closed', 'fork', 'origin', 'noop', 'rewrite'])('names the %s refusal without running checks', async (guard) => {
  const f = fixture();
  if (guard === 'status') f.view.session.status = 'failed';
  if (guard === 'head') f.index.set(id, url);
  if (guard === 'closed') f.pr.state = 'CLOSED';
  if (guard === 'fork') f.pr.isCrossRepository = true;
  if (guard === 'origin') git(f.clone, 'remote', 'set-url', 'origin', f.origin);
  if (guard === 'rewrite') git(f.clone, 'config', 'url.ssh://git@github.com/.insteadOf', 'https://github.com/');
  if (guard === 'noop') git(f.origin, 'update-ref', 'refs/heads/main', f.oldBase);
  f.savePr(); const res = await post(f.app); expect(res.statusCode, res.body).toBe(409); expect(res.json().error).toBeTruthy(); expect(f.check).not.toHaveBeenCalled();
});
it('freezes delivery and refuses duplicate in-flight redelivery', async () => {
  const f = fixture();
  await f.app.inject({ method: 'PUT', url: '/api/v1/deliveries/freeze', payload: { frozen: true } });
  expect((await post(f.app)).json().code).toBe('deliveries_frozen'); expect(f.check).not.toHaveBeenCalled();
  await f.app.inject({ method: 'PUT', url: '/api/v1/deliveries/freeze', payload: { frozen: false } });
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>((r) => { entered = r; }); const held = new Promise<void>((r) => { release = r; });
  const check = f.check.getMockImplementation()!;
  f.check.mockImplementation(async (...args) => { entered(); await held; return check(...args); });
  const first = post(f.app).then((r) => r);
  await ready;
  try { const second = await post(f.app); expect(second.statusCode).toBe(409); expect(second.json().error).toMatch(/in flight/); }
  finally { release(); }
  expect((await first).statusCode).toBe(200);
});
it('hydrates the new lease key from the redelivery audit after restart', async () => {
  const f = fixture();
  const trail = { readAll: vi.fn(async ({ action }: { action: string }) => action === 'run.delivered'
    ? [{ runId: id, detail: { url, commit: f.old, assurance: f.index.assuranceFor(id) } }]
    : action === 'run.redelivered' ? [{ runId: id, detail: { url, old: f.old, new: f.base } }] : []) } as unknown as AuditLog;
  const index = new DeliveryIndex(); await index.hydrate(trail);
  expect(index.commitFor(id)).toBe(f.base); expect(index.assuranceFor(id)).toEqual(f.index.assuranceFor(id));
});
it('records a successful push even when PR comment and body edits fail', async () => {
  const f = fixture(); (f.env as NodeJS.ProcessEnv).GH_FAIL_MUTATIONS = '1';
  const res = await post(f.app); expect(res.statusCode, res.body).toBe(200);
  expect(git(f.origin, 'rev-parse', 'delivered')).toBe(res.json().newHead);
  expect(f.index.commitFor(id)).toBe(res.json().newHead);
  expect(f.record).toHaveBeenCalledWith('run.redelivered', expect.anything(), expect.anything());
});
