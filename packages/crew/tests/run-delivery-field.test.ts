// The run wire's delivery state (crew#393; api-types 0.18.0) — `AgentSession.delivery:
// 'delivered' | 'stranded' | 'none'` + `deliverUrl`, derived at DTO assembly on BOTH
// `GET /runs` and `GET /runs/:id`. Supersedes CREW-UX-8's object spelling
// (`{ kind: 'pull_request', url }`, api-types 0.11.0 — crew#321), whose durable record
// (the `run.delivered` audit trail + DeliveryIndex) carries over unchanged.
//
// Fastify inject() with a mock adapter (no NAPI). Pins:
//   DTO derivation — `delivery` present on EVERY served run:
//     'delivered' + deliverUrl for a run the index holds;
//     'stranded' for a COMPLETED repo-scoped run with no PR whose worktree still exists —
//       including a LEGACY-SHAPED record (the exact fields a pre-0.18 daemon persisted:
//       status/repo_ref/workdir and nothing delivery-related), which is the run 83052f0b class;
//     'none' for repo-less runs, non-completed runs, and completed runs whose worktree is gone.
//     `deliverUrl` is ABSENT — never null — except on 'delivered'.
//   Durability — the `run.delivered` audit entry (action + runId + detail.url) is the system
//     of record; a fresh DeliveryIndex hydrates it back from the trail (the restart path),
//     newest-first with first-seen-per-run winning, and a corrupt newest write never
//     resurrects an older one.
//   Extraction — `prUrlFrom` mirrors crew's own deliver-phase grep (last `/pull/<digits>`
//     match wins; the `/pull/new/<branch>` create-PR form can never match); `deliverUnitOf`
//     keys on the `:deliver` id suffix with the `tool_cmd` fallback, never on `workflow_id`.

import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import {
  DeliveryIndex,
  deliverUnitOf,
  deliveryStateOf,
  deliveryStateWithVacuity,
  gitRunBranchIsEmpty,
  gitWorktreeIsClean,
  prUrlFrom,
} from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView, WorkUnit } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

type MockAdapter = {
  sessionsDetail: ReturnType<typeof vi.fn>;
  sessions: ReturnType<typeof vi.fn>;
};

const SYSTEM_ACTOR = { id: 'daemon', kind: 'system', trust: 'admin' } as const;

function unit(id: string, over: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id,
    session_id: 'run-a',
    ord: 0,
    description: 'u',
    stage: 'build',
    assigned_cli: null,
    assigned_invocation: null,
    council_task_ref: null,
    routing: null,
    denial_reason: null,
    phase_ref: null,
    conformance_ref: null,
    phase_status: null,
    collection_scope: null,
    status: 'done',
    ...over,
  } as WorkUnit;
}

/**
 * A LEGACY-SHAPED run record: exactly the session fields a pre-0.18 daemon persisted — no
 * delivery-related field of any spelling. The stranded derivation must work on THIS shape,
 * because the stranded runs that motivated crew#393 (83052f0b) were recorded before the
 * change existed.
 */
function view(
  id: string,
  over: { status?: string; repo_ref?: string | null; workdir?: string | null } = {},
  units: WorkUnit[] = [],
): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: over.status ?? 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: over.workdir ?? null,
      repo_ref: over.repo_ref ?? null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units,
  } as unknown as SessionView;
}

function buildApp(
  mockAdapter: MockAdapter,
  deliveryIndex: DeliveryIndex,
  worktreeExists?: (p: string) => boolean,
  worktreeIsClean?: (p: string) => Promise<boolean>,
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error);
    }
  });
  registerRoutes(
    app,
    mockAdapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    {
      deliveryIndex,
      ...(worktreeExists !== undefined ? { worktreeExists } : {}),
      ...(worktreeIsClean !== undefined ? { worktreeIsClean } : {}),
    },
  );
  return app;
}

describe('crew#393 — session.delivery / deliverUrl on the run DTOs', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("'delivered' + deliverUrl on BOTH list and detail when the index holds the run", async () => {
    const index = new DeliveryIndex();
    index.set('run-a', 'https://github.com/o/r/pull/121');
    const mockAdapter: MockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-a'), view('run-b')]),
      sessions: vi.fn().mockResolvedValue(['run-a', 'run-b']),
    };
    app = buildApp(mockAdapter, index);
    await app.ready();

    const list = (await app.inject({ method: 'GET', url: '/api/v1/runs' })).json() as {
      runs: { session: Record<string, unknown> }[];
    };
    const a = list.runs.find((r) => r.session['id'] === 'run-a')!.session;
    const b = list.runs.find((r) => r.session['id'] === 'run-b')!.session;
    expect(a['delivery']).toBe('delivered');
    expect(a['deliverUrl']).toBe('https://github.com/o/r/pull/121');
    // The neighbor (completed, repo-less) is 'none' — and deliverUrl is ABSENT, never null.
    expect(b['delivery']).toBe('none');
    expect('deliverUrl' in b).toBe(false);

    const detail = (await app.inject({ method: 'GET', url: '/api/v1/runs/run-a' })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(detail.run.session['delivery']).toBe('delivered');
    expect(detail.run.session['deliverUrl']).toBe('https://github.com/o/r/pull/121');
  });

  it("'stranded' for a LEGACY-SHAPED completed repo-scoped record whose worktree exists", async () => {
    // A real directory on disk — the production probe (fs.existsSync) runs unstubbed, so this
    // is exactly how an OLD run's record reads after the daemon upgrade.
    const worktree = mkdtempSync(join(tmpdir(), 'crew-stranded-'));
    try {
      const mockAdapter: MockAdapter = {
        sessionsDetail: vi
          .fn()
          .mockResolvedValue([view('run-old', { repo_ref: 'repo-1', workdir: worktree })]),
        sessions: vi.fn().mockResolvedValue(['run-old']),
      };
      app = buildApp(mockAdapter, new DeliveryIndex());
      await app.ready();

      const detail = (
        await app.inject({ method: 'GET', url: '/api/v1/runs/run-old' })
      ).json() as { run: { session: Record<string, unknown> } };
      expect(detail.run.session['delivery']).toBe('stranded');
      expect('deliverUrl' in detail.run.session).toBe(false);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("'none' when the worktree is gone, the run is repo-less, or the run is not completed", async () => {
    const mockAdapter: MockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([
        // Completed + repo-scoped, but the worktree was cleaned up: nothing left to lift.
        view('run-swept', { repo_ref: 'repo-1', workdir: '/nowhere/run-swept' }),
        // Repo-less: no worktree ever existed.
        view('run-repoless'),
        // Repo-scoped with a live worktree but NOT completed — running work is not stranded…
        view('run-live', { status: 'executing', repo_ref: 'repo-1', workdir: '/exists' }),
        // …and neither is a failed run (its unit rejection already spells the failure).
        view('run-failed', { status: 'failed', repo_ref: 'repo-1', workdir: '/exists' }),
      ]),
      sessions: vi.fn().mockResolvedValue(['run-swept', 'run-repoless', 'run-live', 'run-failed']),
    };
    // The probe says /exists exists — pinning that non-completed statuses stay 'none' even
    // with a live worktree, and that 'stranded' NEVER comes from the probe alone.
    app = buildApp(mockAdapter, new DeliveryIndex(), (p) => p === '/exists');
    await app.ready();

    const list = (await app.inject({ method: 'GET', url: '/api/v1/runs' })).json() as {
      runs: { session: Record<string, unknown> }[];
    };
    for (const id of ['run-swept', 'run-repoless', 'run-live', 'run-failed']) {
      const s = list.runs.find((r) => r.session['id'] === id)!.session;
      expect(s['delivery'], id).toBe('none');
      expect('deliverUrl' in s, id).toBe(false);
    }
  });
});

describe('deliveryStateOf — the derivation itself', () => {
  const exists = () => true;
  const gone = () => false;

  it('a recorded URL wins over everything (delivered, with the url)', () => {
    expect(
      deliveryStateOf(
        { status: 'completed', repo_ref: 'r', workdir: '/wt' },
        'https://github.com/o/r/pull/7',
        gone, // even with the worktree gone — the PR exists, the state is delivered
      ),
    ).toEqual({ delivery: 'delivered', deliverUrl: 'https://github.com/o/r/pull/7' });
  });

  it('completed + repo-scoped + worktree present, no URL ⇒ stranded', () => {
    expect(
      deliveryStateOf({ status: 'completed', repo_ref: 'r', workdir: '/wt' }, undefined, exists),
    ).toEqual({ delivery: 'stranded' });
  });

  it('everything else ⇒ none', () => {
    // worktree gone
    expect(
      deliveryStateOf({ status: 'completed', repo_ref: 'r', workdir: '/wt' }, undefined, gone),
    ).toEqual({ delivery: 'none' });
    // repo-less
    expect(
      deliveryStateOf({ status: 'completed', repo_ref: null, workdir: null }, undefined, exists),
    ).toEqual({ delivery: 'none' });
    // not terminal / not completed
    for (const status of ['planning', 'executing', 'awaiting_human', 'failed', 'cancelled']) {
      expect(
        deliveryStateOf(
          { status: status as never, repo_ref: 'r', workdir: '/wt' },
          undefined,
          exists,
        ),
      ).toEqual({ delivery: 'none' });
    }
    // a repo-scoped record with an empty/absent workdir has nothing to stat
    expect(
      deliveryStateOf({ status: 'completed', repo_ref: 'r', workdir: '' }, undefined, exists),
    ).toEqual({ delivery: 'none' });
  });
});

describe("crew#311 — the 'vacuous' split of 'stranded' and of the reaped 'none'", () => {
  const S = { id: 'run-1', status: 'completed', repo_ref: 'r', workdir: '/wt' } as const;
  const probes = (over: {
    exists?: boolean;
    clean?: boolean;
    branchEmpty?: boolean;
  }) => ({
    worktreeExists: () => over.exists ?? true,
    worktreeIsClean: vi.fn(async () => over.clean ?? false),
    runBranchIsEmpty: vi.fn(async () => over.branchEmpty ?? false),
  });

  it('a would-be-stranded run whose worktree is POSITIVELY clean reads vacuous', async () => {
    await expect(
      deliveryStateWithVacuity(S, undefined, probes({ clean: true })),
    ).resolves.toEqual({ delivery: 'vacuous' });
  });

  it('a worktree carrying work keeps the stranded label', async () => {
    await expect(
      deliveryStateWithVacuity(S, undefined, probes({ clean: false })),
    ).resolves.toEqual({ delivery: 'stranded' });
  });

  it('a REAPED worktree with an empty (or gone) run branch reads vacuous — the FINDING-003 shape', async () => {
    // The engine reaps exactly the clean trees at terminal, so this is where a vacuous
    // completion normally lands: worktree gone, wicked/<run> branch carrying nothing.
    await expect(
      deliveryStateWithVacuity(S, undefined, probes({ exists: false, branchEmpty: true })),
    ).resolves.toEqual({ delivery: 'vacuous' });
  });

  it("a reaped worktree whose run branch carries commits stays 'none' (landed work, nothing to lift)", async () => {
    await expect(
      deliveryStateWithVacuity(S, undefined, probes({ exists: false, branchEmpty: false })),
    ).resolves.toEqual({ delivery: 'none' });
  });

  it('delivered, non-completed, and repo-less runs never consult any probe', async () => {
    const p1 = probes({ clean: true, branchEmpty: true });
    await expect(
      deliveryStateWithVacuity(S, 'https://github.com/o/r/pull/7', p1),
    ).resolves.toEqual({ delivery: 'delivered', deliverUrl: 'https://github.com/o/r/pull/7' });
    await expect(
      deliveryStateWithVacuity({ ...S, status: 'failed' } as never, undefined, p1),
    ).resolves.toEqual({ delivery: 'none' });
    await expect(
      deliveryStateWithVacuity(
        { id: 'run-2', status: 'completed', repo_ref: null, workdir: null },
        undefined,
        p1,
      ),
    ).resolves.toEqual({ delivery: 'none' });
    expect(p1.worktreeIsClean).not.toHaveBeenCalled();
    expect(p1.runBranchIsEmpty).not.toHaveBeenCalled();
  });

  it("route-level: a vacuous completed run is LOUD on both GET /runs and GET /runs/:id", async () => {
    const mockAdapter: MockAdapter = {
      sessionsDetail: vi
        .fn()
        .mockResolvedValue([view('run-empty', { repo_ref: 'repo-1', workdir: '/wt' })]),
      sessions: vi.fn().mockResolvedValue(['run-empty']),
    };
    const app = buildApp(mockAdapter, new DeliveryIndex(), () => true, async () => true);
    try {
      await app.ready();
      const list = (await app.inject({ method: 'GET', url: '/api/v1/runs' })).json() as {
        runs: { session: Record<string, unknown> }[];
      };
      expect(list.runs[0]!.session['delivery']).toBe('vacuous');
      const detail = (
        await app.inject({ method: 'GET', url: '/api/v1/runs/run-empty' })
      ).json() as { run: { session: Record<string, unknown> } };
      expect(detail.run.session['delivery']).toBe('vacuous');
      expect('deliverUrl' in detail.run.session).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('gitWorktreeIsClean — the production probe over a real run-worktree layout', () => {
  let base: string;

  const git = (cwd: string, args: string[]) => {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
  };

  /** repo + linked worktree on `wicked/run1` — the layout crew's run worktrees actually have. */
  function makeWorktree(): string {
    const repo = join(base, 'repo');
    const wt = join(base, 'wt');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '.']);
    git(repo, ['config', 'user.email', 't@example.invalid']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);
    git(repo, ['worktree', 'add', '-q', wt, '-b', 'wicked/run1']);
    return wt;
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'crew-vacuity-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('a pristine worktree is clean; an uncommitted file is not; a run-branch commit is not', async () => {
    const wt = makeWorktree();
    // Fresh probe per phase — the memo would otherwise serve the pristine answer.
    await expect(gitWorktreeIsClean()(wt)).resolves.toBe(true);

    writeFileSync(join(wt, 'feature.ts'), 'export const x = 1;\n');
    await expect(gitWorktreeIsClean()(wt)).resolves.toBe(false);

    // Committed on the run branch: porcelain goes clean, instrument 2 still sees the work.
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-qm', 'feat: the change']);
    await expect(gitWorktreeIsClean()(wt)).resolves.toBe(false);
  });

  it('fails toward NOT clean: a non-git directory never reads vacuous', async () => {
    await expect(gitWorktreeIsClean()(base)).resolves.toBe(false);
  });

  it('memoizes per path for the TTL, then re-probes', async () => {
    const wt = makeWorktree();
    let t = 0;
    const probe = gitWorktreeIsClean(30_000, () => t);
    await expect(probe(wt)).resolves.toBe(true);

    // Dirty the tree; within the TTL the memoized answer stands (one git pair per window)…
    writeFileSync(join(wt, 'feature.ts'), 'export const x = 1;\n');
    t = 29_999;
    await expect(probe(wt)).resolves.toBe(true);

    // …and past it the truth is re-read.
    t = 30_000;
    await expect(probe(wt)).resolves.toBe(false);
  });
});

describe('gitRunBranchIsEmpty — the reaped-worktree probe over the parent repo', () => {
  let base: string;

  const git = (cwd: string, args: string[]) => {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
  };

  /** A repo whose `wicked/run1` branch exists at main (the post-reap layout: worktree gone,
   *  branch untouched). Returns the repo root. */
  function makeRepo(): string {
    const repo = join(base, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main', '.']);
    git(repo, ['config', 'user.email', 't@example.invalid']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);
    git(repo, ['branch', 'wicked/run1']);
    return repo;
  }

  const rootOf =
    (repo: string | undefined) =>
    async (): Promise<string | undefined> =>
      repo;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'crew-branch-probe-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('an empty run branch is POSITIVELY empty; one carrying a commit is not; a deleted one is empty', async () => {
    const repo = makeRepo();
    await expect(gitRunBranchIsEmpty(rootOf(repo))('r', 'run1')).resolves.toBe(true);

    // Land a commit on the run branch only (the reap-after-commit layout).
    git(repo, ['checkout', '-q', 'wicked/run1']);
    writeFileSync(join(repo, 'feature.ts'), 'export const x = 1;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'feat: landed']);
    git(repo, ['checkout', '-q', 'main']);
    await expect(gitRunBranchIsEmpty(rootOf(repo))('r', 'run1')).resolves.toBe(false);

    // A hand-deleted branch (with its unique commit gone from every ref) reads empty: the run's
    // work is unreachable, which is what the run now amounts to.
    git(repo, ['branch', '-D', 'wicked/run1']);
    await expect(gitRunBranchIsEmpty(rootOf(repo))('r', 'run1')).resolves.toBe(true);
  });

  it('fails toward NOT empty: unresolvable repo, throwing registry, non-git root', async () => {
    await expect(gitRunBranchIsEmpty(rootOf(undefined))('r', 'run1')).resolves.toBe(false);
    await expect(
      gitRunBranchIsEmpty(async () => {
        throw new Error('registry down');
      })('r', 'run1'),
    ).resolves.toBe(false);
    // A registered root that is not a git repo: rev-parse exits 128, never a clean miss.
    await expect(gitRunBranchIsEmpty(rootOf(base))('r', 'run1')).resolves.toBe(false);
  });

  it('memoizes per (repo, run) for the TTL, then re-probes', async () => {
    const repo = makeRepo();
    let t = 0;
    const probe = gitRunBranchIsEmpty(rootOf(repo), 30_000, () => t);
    await expect(probe('r', 'run1')).resolves.toBe(true);

    git(repo, ['checkout', '-q', 'wicked/run1']);
    writeFileSync(join(repo, 'feature.ts'), 'export const x = 1;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'feat: landed']);
    git(repo, ['checkout', '-q', 'main']);

    t = 29_999;
    await expect(probe('r', 'run1')).resolves.toBe(true);
    t = 30_000;
    await expect(probe('r', 'run1')).resolves.toBe(false);
  });
});

describe('DeliveryIndex.hydrate — the restart path over the audit trail', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-delivery-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh index answers from the trail; newest entry per run wins', async () => {
    const auditPath = join(dir, 'audit.log');
    const audit = new AuditLog(auditPath, () => undefined);
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-a',
      detail: { url: 'https://github.com/o/r/pull/1' },
    });
    // A newer write for the same run supersedes (resume/retry re-resolution).
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-a',
      detail: { url: 'https://github.com/o/r/pull/2' },
    });
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-b',
      detail: { url: 'https://github.com/o/r/pull/3' },
    });
    await audit.flush();

    const index = new DeliveryIndex();
    await index.hydrate(new AuditLog(auditPath, () => undefined));
    expect(index.urlFor('run-a')).toBe('https://github.com/o/r/pull/2');
    expect(index.urlFor('run-b')).toBe('https://github.com/o/r/pull/3');
    expect(index.urlFor('run-c')).toBeUndefined();
  });

  it('a corrupt NEWEST entry never resurrects an older url (the #312 rule)', async () => {
    const auditPath = join(dir, 'audit.log');
    const audit = new AuditLog(auditPath, () => undefined);
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-a',
      detail: { url: 'https://github.com/o/r/pull/1' },
    });
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-a',
      detail: { url: 42 as unknown as string },
    });
    await audit.flush();

    const index = new DeliveryIndex();
    await index.hydrate(new AuditLog(auditPath, () => undefined));
    // Unknowable current record = no record — never the superseded older one.
    expect(index.urlFor('run-a')).toBeUndefined();
  });

  it('a missing trail hydrates to empty, best-effort (the pre-#321 behavior, not an error)', async () => {
    const index = new DeliveryIndex();
    await index.hydrate(new AuditLog(join(dir, 'nope.log'), () => undefined));
    expect(index.urlFor('run-a')).toBeUndefined();
  });
});

describe('prUrlFrom — crew\'s own deliver-phase grep, mirrored', () => {
  it('takes the LAST /pull/<digits> match (tail -1)', () => {
    const out = [
      'remote: Create a pull request by visiting:',
      'remote:   https://github.com/o/r/pull/new/feat-x',
      'https://github.com/o/r/pull/9',
      'https://github.com/o/r/pull/121',
    ].join('\n');
    expect(prUrlFrom(out)).toBe('https://github.com/o/r/pull/121');
  });

  it('the /pull/new/<branch> create-PR form can never match', () => {
    expect(prUrlFrom('https://github.com/o/r/pull/new/feat-x')).toBeNull();
    expect(prUrlFrom('no urls at all')).toBeNull();
  });
});

describe('deliverUnitOf — id suffix primary, tool_cmd fallback, never workflow_id', () => {
  it('finds the composed :deliver unit by id suffix', () => {
    const v = view('run-a', {}, [unit('run-a:u0'), unit('wf-base:deliver')]);
    expect(deliverUnitOf(v)?.id).toBe('wf-base:deliver');
  });

  it('falls back to a tool_cmd invoking gh pr create (overlay-carried deliver phase)', () => {
    const v = view('run-a', {}, [
      unit('run-a:u0'),
      unit('run-a:ship', { tool_cmd: ['bash', '-lc', 'git push && gh pr create --fill'] }),
    ]);
    expect(deliverUnitOf(v)?.id).toBe('run-a:ship');
  });

  it('no deliver unit → null (a run with no deliver phase claims nothing)', () => {
    expect(deliverUnitOf(view('run-a', {}, [unit('run-a:u0')]))).toBeNull();
  });
});
