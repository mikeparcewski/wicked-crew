import { Core } from 'wicked-core-ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RedeliverRunResult, RunPullRequest } from 'wicked-crew-api-types';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCapped } from '../core/exec.js';
import { defaultGhExec, githubRepoOf, isSafeRefName, pinnedGhExec, pushIdentityOf, readDeliverOriginUrl, type GhExec } from '../core/deliver.js';
import { refreshPushScript, refreshRebaseScript, type RefreshOptions } from '../core/redeliver.js';
import type { CoreAdapter } from '../core/adapter.js';
import type { Actor } from '../core/types.js';
import type { AuditLog } from './audit.js';
import type { DeliveryIndex } from './delivery-index.js';
import { frozenRefusal, type DeliveryFreeze } from './delivery-freeze.js';
import { API_PREFIX as V } from './api-prefix.js';
export interface RunTreeCheck {
  head: string;
  tree: string;
  base: string;
  passed: boolean;
  checksRun: number;
  report: {
    checks: Array<{
      name: string;
      exit_code: number | null;
      timed_out: boolean;
      spawn_error?: string | null;
      decision?: {
        outcome: string;
      } | null;
    }>;
  };
}
export type CheckRunTree = (runId: string, worktree: string, repoRoot: string, baseSha: string) => Promise<RunTreeCheck>;
export type RedeliverExec = (cwd: string, script: string) => Promise<{
  status: number;
  output: string;
}>;
export const runRefreshScript: RedeliverExec = async (cwd, script) => {
  try {
    const r = await execCapped('bash', ['-lc', script], { cwd, timeout: 5 * 60000 });
    return { status: 0, output: r.stdout + r.stderr };
  } catch (err) {
    const e = err as {
      code?: unknown;
      stdout?: string;
      stderr?: string;
      message: string;
    };
    if (typeof e.code !== 'number')
      throw err;
    return { status: e.code, output: `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message };
  }
};
class Refusal extends Error {
  constructor(message: string, readonly detail: Record<string, unknown> = {}, readonly status = 409) { super(message); }
}
export const checkRunTreeViaCore: CheckRunTree = async (...args) => {
  // Read at CALL time: a daemon with an older addon gives a named unsupported response.
  if (typeof Core.checkRunTree !== 'function')
    throw new Refusal('redeliver unsupported: the engine addon has no Core.checkRunTree', {}, 501);
  return JSON.parse(await Core.checkRunTree(...args)) as RunTreeCheck;
};
interface Deps {
  adapter: CoreAdapter;
  index: DeliveryIndex;
  audit: AuditLog;
  freeze: DeliveryFreeze;
  actorOf: (req: FastifyRequest) => Actor;
  repoRootOf: (ref: string) => Promise<string | undefined>;
  withRepoDeliverLock: <T>(ref: string, fn: () => Promise<T>) => Promise<T>;
  ghExec?: GhExec | undefined;
  exec?: RedeliverExec | undefined;
  checkRunTree?: CheckRunTree | undefined;
  identityFor: (ref: string) => Promise<string | undefined>;
}
const failedConclusions = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
export function registerRedeliverRoutes(app: FastifyInstance, d: Deps): void {
  const inFlight = new Set<string>();
  const exec = d.exec ?? runRefreshScript;
  const checkTree = d.checkRunTree ?? checkRunTreeViaCore;
  async function context(id: string) {
    const run = await d.adapter.runView(id);
    if (!run)
      throw new Refusal('Run not found', {}, 404);
    const url = d.index.urlFor(id);
    if (!url)
      throw new Refusal(`run ${id} has no recorded delivered PR url`);
    const ref = run.session.repo_ref;
    const root = ref == null ? undefined : await d.repoRootOf(ref);
    const repo = root === undefined ? null : githubRepoOf(await readDeliverOriginUrl(root));
    if (root === undefined || repo === null || ref == null)
      throw new Refusal('re-delivery supports GitHub PRs only');
    // Bind the recorded PR to the repository whose branch we are going to lease.
    if (!url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/pull/`) || !/^\d+$/.test(url.split('/pull/')[1] ?? ''))
      throw new Refusal('re-delivery supports GitHub PRs only: delivered PR does not match origin');
    return { run, url, ref, root, repo };
  }
  async function readPr(root: string, ref: string, url: string, fork = false) {
    const fields = 'number,url,state,mergeable,mergeStateStatus,baseRefName,headRefName,headRefOid,statusCheckRollup';
    // crew#1804: the PR is read as the deliver identity the push uses (its pin or the setting, else GH_ACCOUNT).
    const gh = pinnedGhExec(async () => pushIdentityOf(await d.identityFor(ref)), d.ghExec ?? defaultGhExec);
    const out = await gh(['pr', 'view', url, '--json', fields + (fork ? ',isCrossRepository' : '')], { cwd: root, timeoutMs: 5000 });
    if (out.code !== 0)
      throw new Refusal(`gh could not read delivered PR: ${(out.stderr || out.stdout).slice(-1000)}`);
    let pr: Record<string, unknown>;
    try {
      pr = JSON.parse(out.stdout) as Record<string, unknown>;
    }
    catch {
      throw new Refusal('gh could not read delivered PR: invalid JSON');
    }
    if (!pr || typeof pr.number !== 'number' || pr.url !== url || typeof pr.state !== 'string' || typeof pr.mergeable !== 'string' || typeof pr.mergeStateStatus !== 'string' || typeof pr.baseRefName !== 'string' || typeof pr.headRefName !== 'string' || typeof pr.headRefOid !== 'string' || !/^[a-f0-9]{40}$/.test(pr.headRefOid) || !Array.isArray(pr.statusCheckRollup) || (fork && typeof pr.isCrossRepository !== 'boolean'))
      throw new Refusal('gh could not read delivered PR: missing PR fields');
    return pr;
  }
  function failure(err: unknown) {
    return err instanceof Refusal ? { status: err.status, body: { error: err.message, ...err.detail } } : { status: 500, body: { error: `redeliver failed: ${err instanceof Error ? err.message : String(err)}` } };
  }
  app.get(`${V}/runs/:id/pr`, { config: { manifest: { responseType: 'RunPullRequest', statusCodes: [200, 404, 409, 500] } } }, async (req, reply) => {
    try {
      const { id } = req.params as {
        id: string;
      };
      const c = await context(id);
      const pr = await readPr(c.root, c.ref, c.url);
      const headSha = pr.headRefOid as string;
      const deliveredHead = d.index.commitFor(id);
      return { number: pr.number, url: pr.url, state: pr.state, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, baseRefName: pr.baseRefName, headRefName: pr.headRefName, headSha, ...(deliveredHead === undefined ? {} : { deliveredHead }), headMoved: deliveredHead !== undefined && headSha !== deliveredHead,
        failingChecks: (pr.statusCheckRollup as Array<Record<string, unknown>>).filter((r) => failedConclusions.has(String(r.conclusion)) || r.state === 'FAILURE' || r.state === 'ERROR').map((r) => String(r.name ?? r.context)),
      } as RunPullRequest;
    } catch (err) {
      const f = failure(err);
      return reply.code(f.status).send(f.body);
    }
  });
  app.post(`${V}/runs/:id/redeliver`, { config: { manifest: { responseType: 'RedeliverRunResult', statusCodes: [200, 404, 409, 500, 501] } } }, async (req, reply) => {
    const { id } = req.params as {
      id: string;
    };
    if (inFlight.has(id))
      return reply.code(409).send({ error: `a redelivery for run ${id} is already in flight` });
    inFlight.add(id);
    try {
      const initial = await context(id);
      return await d.withRepoDeliverLock(initial.ref, async () => {
        // Re-read all mutable guards under the repo lock, including the lease key.
        const c = await context(id);
        if (c.run.session.status !== 'completed')
          throw new Refusal(`run ${id} is not completed`);
        if (d.freeze.state().frozen) {
          const f = frozenRefusal(d.freeze.state());
          throw new Refusal(f.error, { code: f.code });
        }
        const old = d.index.commitFor(id);
        if (old === undefined)
          throw new Refusal(`run ${id} has no recorded delivered head`);
        const pr = await readPr(c.root, c.ref, c.url, true);
        if (pr.state !== 'OPEN')
          throw new Refusal('only an OPEN PR can be re-delivered');
        if (pr.isCrossRepository === true)
          throw new Refusal('cannot re-deliver a fork PR');
        if (pr.headRefOid !== old)
          throw new Refusal('PR branch moved since delivery');
        if (!isSafeRefName(pr.baseRefName as string) || !isSafeRefName(pr.headRefName as string))
          throw new Refusal('PR has an unsafe branch name');
        const identity = await d.identityFor(c.ref);
        const dir = await mkdtemp(join(tmpdir(), 'wicked-redeliver-'));
        const worktree = join(dir, 'tree');
        const branch = `wicked-redeliver/${dir.split('/').pop()!}`;
        const opts: RefreshOptions = { repo: c.repo, base: pr.baseRefName as string, head: pr.headRefName as string, deliveredHead: old, worktree, branch, identity };
        try {
          const rebase = await exec(c.root, refreshRebaseScript(opts));
          if (rebase.status !== 0) {
            if (rebase.output.includes('redeliver: MOVED'))
              throw new Refusal('PR branch moved since delivery');
            const conflicts = /redeliver: CONFLICT\n([\s\S]*?)\nredeliver: END/.exec(rebase.output);
            if (conflicts)
              throw new Refusal('rebase conflicts outside the additive changelog resolver', { conflicts: conflicts[1]!.split('\n').filter(Boolean) });
            throw new Refusal(`redeliver rebase failed: ${rebase.output.slice(-2000)}`);
          }
          const rebased = /redeliver: REBASED old=([a-f0-9]{40}) new=([a-f0-9]{40}) base=([a-f0-9]{40})/.exec(rebase.output);
          if (!rebased || rebased[1] !== old)
            throw new Error('redeliver script did not report its rebased head and base');
          const newHead = rebased[2]!;
          const base = rebased[3]!;
          if (newHead === old)
            throw new Refusal('nothing to rebase: the PR head already contains the base');
          const checked = await checkTree(id, worktree, c.root, base);
          if (!checked.passed)
            throw new Refusal('repo checks failed on the rebased tree', { failingChecks: checked.report.checks.filter((r) => r.decision ? !['pass', 'pass_excluded'].includes(r.decision.outcome) : r.exit_code !== 0 || r.timed_out || r.spawn_error != null).map((r) => r.name), report: checked.report });
          if (checked.head !== newHead || checked.base !== base)
            throw new Refusal('repo checks did not verify the rebased head and base');
          // Core's checksRun counts substantive checks, excluding provisioning.
          const names = checked.report.checks.filter((r) => r.name !== 'install' && r.name !== 'native-build').map((r) => r.name);
          const result: RedeliverRunResult = { prUrl: c.url, oldHead: old, newHead, checks: { passed: true, count: checked.checksRun, names }, conflictsResolved: [...new Set([...rebase.output.matchAll(/redeliver: RESOLVED\n([\s\S]*?)\nredeliver: END/g)].flatMap((m) => m[1]!.split('\n').filter(Boolean)))] };
          const assurance = d.index.assuranceFor(id);
          if (d.freeze.state().frozen)
            throw new Refusal(frozenRefusal(d.freeze.state()).error);
          const pushed = await exec(worktree, refreshPushScript(opts, result, assurance));
          if (pushed.status !== 0)
            throw new Refusal(pushed.output.includes('redeliver: MOVED') ? 'PR branch moved since delivery' : `redeliver push failed: ${pushed.output.slice(-2000)}`);
          d.audit.record('run.redelivered', d.actorOf(req), { runId: id, detail: { url: c.url, old, new: newHead, checks: result.checks, via: 'redeliver' } });
          d.index.set(id, c.url, assurance, newHead);
          return result;
        }
        finally {
          await execCapped('git', ['worktree', 'remove', '--force', worktree], { cwd: c.root }).catch(() => undefined);
          await execCapped('git', ['branch', '-D', branch], { cwd: c.root }).catch(() => undefined);
          await rm(dir, { recursive: true, force: true });
        }
      });
    } catch (err) {
      const f = failure(err);
      return reply.code(f.status).send(f.body);
    } finally {
      inFlight.delete(id);
    }
  });
}
