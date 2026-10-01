// N1 (ship re-proof, the half of F2 that did not hold) — a SUCCESSFUL push-only delivery must not
// read as stranded.
//
// On a non-GitHub origin the deliver phase pushes the run branch, gh cannot open a PR, and the run
// completes. `deliveryStateOf` knew only delivered (a recorded PR URL), stranded (the worktree
// exists) and none, so the run read `delivery: 'stranded'` — "work is sitting uncommitted… No PR
// is on record" — and the panel offered "Deliver — open a PR", an action that cannot succeed.
// These tests pin the fourth state end to end on the daemon side: the record the deliver unit's
// transcript yields, its durability across a restart, the derivation, and both run DTOs.

import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import {
  DeliveryIndex,
  deliveryRecordFrom,
  deliveryStateOf,
  deliveryStateWithVacuity,
  isDeliverConflictStranded,
} from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import { GroupIndex } from '../src/api/group-index.js';
import { buildGroups, enrichCampaign, sessionsById } from '../src/campaigns/rollup.js';
import type { Campaign } from '../src/core/types.js';
import { pushedOnlyFrom, remoteWithoutUserinfo } from '../src/core/deliver.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';
import { removeScratch } from './setup/scratch.js';

const SYSTEM_ACTOR = { id: 'daemon', kind: 'system', trust: 'admin' } as const;

/** The deliver phase's push-only transcript tail, as the script prints it. */
const PUSH_ONLY_TAIL = [
  'none of the git remotes configured for this repository point to a known GitHub host.',
  'deliver: pushed wicked/run-p to origin (/srv/remote.git) with 1 commit(s) on top of origin/main, and no pull request was opened because that remote is not a GitHub host gh can resolve.',
  'deliver: PUSHED-NO-PR wicked/run-p /srv/remote.git',
].join('\n');

function view(id: string, workdir: string): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir,
      repo_ref: 'repo-1',
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

const scratch: string[] = [];
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const d of scratch.splice(0)) removeScratch(d);
});

describe('N1 — the record a push-only deliver transcript yields', () => {
  it('reads the branch and the remote off the script\'s last line', () => {
    expect(deliveryRecordFrom(PUSH_ONLY_TAIL)).toEqual({
      pushed: { branch: 'wicked/run-p', remote: '/srv/remote.git' },
    });
  });

  it("the script's final PUSHED-NO-PR verdict outranks a /pull/<n> URL a remote hook echoed (Copilot on crew#734)", () => {
    const hooked = `remote: see https://github.com/o/r/pull/9\n${PUSH_ONLY_TAIL}`;
    expect(deliveryRecordFrom(hooked)).toEqual({
      pushed: { branch: 'wicked/run-p', remote: '/srv/remote.git' },
    });
    expect(pushedOnlyFrom(hooked)).toEqual({ branch: 'wicked/run-p', remote: '/srv/remote.git' });
    // The PR path never prints the marker — there, the URL is the record.
    expect(deliveryRecordFrom('pushed\nhttps://github.com/o/r/pull/9')).toEqual({
      url: 'https://github.com/o/r/pull/9',
    });
    // …and a hook that FORGES the marker before gh's real URL cannot downgrade the PR (Copilot on
    // crew#734, second round): the script's verdict is the later of the two.
    expect(
      deliveryRecordFrom('remote: deliver: PUSHED-NO-PR fake-branch fake-remote\nhttps://github.com/o/r/pull/12'),
    ).toEqual({ url: 'https://github.com/o/r/pull/12' });
  });

  it('a transcript with neither records nothing', () => {
    expect(deliveryRecordFrom('deliver: pushed wicked/x to origin, prose only')).toBeNull();
  });

  it('never carries a credential onto the wire: URL userinfo is removed', () => {
    expect(
      deliveryRecordFrom('deliver: PUSHED-NO-PR wicked/run-p https://bot:tok@git.example.com/o/r.git'),
    ).toEqual({ pushed: { branch: 'wicked/run-p', remote: 'https://git.example.com/o/r.git' } });
    // An scp-like remote names an SSH login, not a secret — kept as written.
    expect(remoteWithoutUserinfo('git@gitlab.example.com:o/r.git')).toBe('git@gitlab.example.com:o/r.git');
  });
});

describe('N4 — a refused push is never read as a liftable strand', () => {
  it('the LAST marker decides: a hook that echoes the lift marker does not strand the run', () => {
    const v = {
      session: { id: 'run-h', status: 'failed', repo_ref: 'repo-1' },
      units: [
        { id: 'run-h:build', status: 'done' },
        {
          id: 'run-h:deliver',
          status: 'rejected',
          denial_reason:
            'deliver refused on unit 5: remote: deliver: LIFT-CONFLICT (hook text)\n' +
            'deliver: the remote refused the push of wicked/run-h after commit: …; deliver: PUSH-REJECTED',
        },
      ],
    } as unknown as SessionView;
    expect(isDeliverConflictStranded(v)).toBe(false);
  });
});

describe('N1 — the derivation', () => {
  const session = { id: 'run-p', status: 'completed' as const, repo_ref: 'r', workdir: '/wt' };
  const pushed = { branch: 'wicked/run-p', remote: '/srv/remote.git' };

  it("a recorded push reads 'pushed' even with the worktree still on disk — never 'stranded'", () => {
    expect(deliveryStateOf(session, undefined, () => true, true, pushed)).toEqual({
      delivery: 'pushed',
      deliverBranch: 'wicked/run-p',
      deliverRemote: '/srv/remote.git',
    });
  });

  it('the vacuity refinement never re-labels a pushed run, and spends no probe on it', async () => {
    const worktreeIsClean = vi.fn(async () => true);
    const runBranchIsEmpty = vi.fn(async () => true);
    const state = await deliveryStateWithVacuity(
      session,
      undefined,
      { worktreeExists: () => true, worktreeIsClean, runBranchIsEmpty },
      true,
      pushed,
    );
    expect(state.delivery).toBe('pushed');
    expect(worktreeIsClean).not.toHaveBeenCalled();
    expect(runBranchIsEmpty).not.toHaveBeenCalled();
  });
});

describe('N1 — durability: the run.delivered trail carries the push across a restart', () => {
  it('hydrates a pushed record; a later PR record supersedes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-n1-'));
    scratch.push(dir);
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => undefined);
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-p',
      detail: { pushed: { branch: 'wicked/run-p', remote: '/srv/remote.git' } },
    });
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-q',
      detail: { pushed: { branch: 'wicked/run-q', remote: '/srv/remote.git' } },
    });
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-q',
      detail: { url: 'https://github.com/o/r/pull/3' },
    });
    await audit.flush();

    const index = new DeliveryIndex();
    await index.hydrate(new AuditLog(path, () => undefined));
    expect(index.pushedFor('run-p')).toEqual({ branch: 'wicked/run-p', remote: '/srv/remote.git' });
    expect(index.urlFor('run-p')).toBeUndefined();
    expect(index.isDelivered('run-p')).toBe(true);
    expect(index.urlFor('run-q')).toBe('https://github.com/o/r/pull/3');
    expect(index.pushedFor('run-q')).toBeUndefined();
  });

  it('an OLDER PR record outranks a newer push-only one — the live setPushed precedence (codex review)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-n1-'));
    scratch.push(dir);
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => undefined);
    audit.record('run.delivered', SYSTEM_ACTOR, { runId: 'run-r', detail: { url: 'https://github.com/o/r/pull/7' } });
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-r',
      detail: { pushed: { branch: 'wicked/run-r', remote: 'git@gitlab.example.com:o/r.git' } },
    });
    // A corrupt newest write still decides (the #312 rule) — it never resurrects an older push.
    audit.record('run.delivered', SYSTEM_ACTOR, {
      runId: 'run-s',
      detail: { pushed: { branch: 'wicked/run-s', remote: '/srv/remote.git' } },
    });
    audit.record('run.delivered', SYSTEM_ACTOR, { runId: 'run-s', detail: { url: 42 as unknown as string } });
    await audit.flush();

    const index = new DeliveryIndex();
    await index.hydrate(new AuditLog(path, () => undefined));
    expect(index.urlFor('run-r')).toBe('https://github.com/o/r/pull/7');
    expect(index.pushedFor('run-r')).toBeUndefined();
    expect(index.isDelivered('run-s')).toBe(false);
  });
});

describe('N1 — both run DTOs say the branch is on the remote', () => {
  it("GET /runs and GET /runs/:id read 'pushed' with branch + remote, no deliverUrl", async () => {
    // A REAL worktree directory: before N1 exactly this read 'stranded'.
    const worktree = mkdtempSync(join(tmpdir(), 'crew-n1-wt-'));
    scratch.push(worktree);
    const index = new DeliveryIndex();
    index.setPushed('run-p', { branch: 'wicked/run-p', remote: '/srv/remote.git' });
    const adapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-p', worktree)]),
      sessions: vi.fn().mockResolvedValue(['run-p']),
    };
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      adapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      { deliveryIndex: index },
    );
    await app.ready();

    const detail = (await app.inject({ method: 'GET', url: '/api/v1/runs/run-p' })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(detail.run.session['delivery']).toBe('pushed');
    expect(detail.run.session['deliverBranch']).toBe('wicked/run-p');
    expect(detail.run.session['deliverRemote']).toBe('/srv/remote.git');
    expect('deliverUrl' in detail.run.session).toBe(false);

    const list = (await app.inject({ method: 'GET', url: '/api/v1/runs' })).json() as {
      runs: { session: Record<string, unknown> }[];
    };
    expect(list.runs.find((r) => r.session['id'] === 'run-p')!.session['delivery']).toBe('pushed');
  });
});

describe('N1 — the campaigns rollup carries the pushed state and its fields (Copilot on crew#734)', () => {
  it('a DAG node, an attached run and a label-group member all read pushed with branch + remote', async () => {
    const pushed = { branch: 'wicked/run-p', remote: '/srv/remote.git' };
    const views = [view('camp:n1:a0', '/wt/n1'), view('run-att', '/wt/att'), view('run-grp', '/wt/grp')];
    const groupIndex = new GroupIndex();
    groupIndex.set('run-att', { campaignId: 'camp' });
    groupIndex.set('run-grp', { label: 'batch' });
    const deps = {
      groupIndex,
      deliveryUrlFor: () => undefined,
      deliveryPushedFor: () => pushed,
      // The worktrees "exist" — before N1 every one of these read 'stranded'.
      vacuity: { worktreeExists: () => true, worktreeIsClean: async () => false, runBranchIsEmpty: async () => false },
    };
    const campaign = { id: 'camp', node_run_id: { n1: 'camp:n1:a0' } } as unknown as Campaign;
    const enriched = await enrichCampaign(campaign, sessionsById(views), deps);
    const expected = { delivery: 'pushed', deliverBranch: 'wicked/run-p', deliverRemote: '/srv/remote.git' };
    expect(enriched.node_delivery?.['n1']).toEqual(expected);
    expect(enriched.attached_runs).toEqual([{ runId: 'run-att', status: 'completed', ...expected }]);
    const groups = await buildGroups(sessionsById(views), deps);
    expect(groups).toEqual([{ label: 'batch', runs: [{ runId: 'run-grp', status: 'completed', ...expected }] }]);
  });
});
