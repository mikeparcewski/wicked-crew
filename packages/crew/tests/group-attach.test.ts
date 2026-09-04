// wicked-studio#27 (api-types 0.19.0) — ad-hoc run grouping + the campaigns-surface rollup.
//
// Fastify inject() with a mock adapter (no NAPI), the run-dto-lineage pattern. Pins:
//   - `POST /runs` group attach: `campaignId` must name an EXISTING campaign (404 otherwise,
//     nothing launched; 501 when the engine addon lacks the campaign bindings), `groupLabel`
//     is create-on-first-use, the two are mutually exclusive (400 naming it), and the attach
//     NEVER reaches the engine: the launch input is byte-identical to an ungrouped launch.
//   - The run DTO echoes `campaign_id` / `group_label` (absent — never null — when ungrouped),
//     and a fresh GroupIndex hydrated from the audit trail restores the echo (restart path).
//   - `GET /campaigns` serves the rollup with NO per-node fetch: per-node `node_delivery`
//     (from the same DeliveryIndex record the run wire uses), `attached_runs` on the campaign,
//     and the ad-hoc `groups` rows — each member carrying runId + status + delivery.
//   - `GET /campaigns/:id` carries the same join as the list.

import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { GroupIndex } from '../src/api/group-index.js';
import { DeliveryIndex } from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import { DELIVER_LIFT_CONFLICT_MARKER } from '../src/core/deliver.js';
import { CampaignsUnsupportedError, type CoreAdapter } from '../src/core/adapter.js';
import type { Campaign, LaunchRunInput, SessionView, WorkUnit } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';
import { removeScratch } from './setup/scratch.js';

const NODE_RUN_ID = 'camp-1:a:a0';
const PR_URL = 'https://github.com/o/r/pull/7';

const CAMPAIGN: Campaign = {
  id: 'camp-1',
  def_id: 'camp-1',
  status: 'completed',
  def: {
    id: 'camp-1',
    name: 'camp-1',
    nodes: [],
    edges: [],
    policy: 'continue_independent',
    max_concurrency: 2,
  },
  node_status: { a: 'completed' },
  node_run_id: { a: NODE_RUN_ID },
  node_attempt: { a: 0 },
  pending_decision_amend: {},
  pending_failure_gates: [],
  fail_fast_tripped: false,
};

function view(id: string, status = 'executing'): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status,
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

/** A crew#418 lift-conflict strand as the engine persists it: the run is `failed` (its deliver
 *  Tool phase exited non-zero on the collision) with the deliver unit `rejected` carrying the
 *  LIFT-CONFLICT marker, but its work is committed on the `wicked/<id>` branch. The run wire
 *  reinterprets this as completed+stranded; the campaigns rollup must read it identically. */
function strandView(id: string): SessionView {
  const v = view(id, 'failed');
  v.session.repo_ref = 'repo-1';
  v.session.workdir = `/tmp/${id}`;
  (v as { units: WorkUnit[] }).units = [
    { session_id: id, id: `${id}:build`, ord: 3, status: 'done', denial_reason: null } as unknown as WorkUnit,
    {
      session_id: id,
      id: `${id}:deliver`,
      ord: 5,
      status: 'rejected',
      tool_cmd: ['bash', '-lc', 'gh pr create --head "$B" --fill'],
      denial_reason:
        `Worker FAILED on unit 5 (triage: the deliver step exited non-zero): ` +
        `Rebasing (1/1)\nCONFLICT (content): Merge conflict in src/thing.ts\n` +
        `${DELIVER_LIFT_CONFLICT_MARKER} — rebase of wicked/${id} onto origin/main hit ` +
        `conflicts outside the changelog; resolve on the branch and re-run; nothing was pushed`,
    } as unknown as WorkUnit,
  ];
  return v;
}

describe('wicked-studio#27 — ad-hoc grouping + campaigns rollup', () => {
  let dir: string;
  let app: FastifyInstance;
  let audit: AuditLog;
  let groupIndex: GroupIndex;
  let deliveryIndex: DeliveryIndex;
  /** The mock engine store: launched runs land here; sessionsDetail serves it. */
  let store: SessionView[];
  /** Every input the engine saw — the byte-identical pin reads these. */
  let launchInputs: LaunchRunInput[];
  let campaignsUnsupported: boolean;

  function buildApp(gi: GroupIndex): FastifyInstance {
    const a = Fastify({ logger: false });
    a.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      if (!body) return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch (e) {
        done(e as Error);
      }
    });
    const mockAdapter = {
      sessionsDetail: vi.fn(async () => store),
      sessions: vi.fn(async () => store.map((v) => v.session.id)),
      launchRun: vi.fn(async (input: LaunchRunInput) => {
        launchInputs.push(input);
        store.push(view(input.sessionId));
        return input.sessionId;
      }),
      campaignDetail: vi.fn(async (id: string) => {
        if (campaignsUnsupported) throw new CampaignsUnsupportedError('Reading a campaign');
        return id === CAMPAIGN.id ? CAMPAIGN : null;
      }),
      campaignList: vi.fn(async () => {
        if (campaignsUnsupported) throw new CampaignsUnsupportedError('Listing campaigns');
        return [CAMPAIGN];
      }),
      listRepos: vi.fn(async () => []),
    };
    registerRoutes(
      a,
      mockAdapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      new QeGateCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit, authMode: 'off' },
      { groupIndex: gi, deliveryIndex },
    );
    return a;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'group-attach-'));
    audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    groupIndex = new GroupIndex();
    deliveryIndex = new DeliveryIndex();
    deliveryIndex.set(NODE_RUN_ID, PR_URL); // the durable run.delivered fact, pre-recorded
    store = [view(NODE_RUN_ID, 'completed')];
    launchInputs = [];
    campaignsUnsupported = false;
    app = buildApp(groupIndex);
  });

  afterEach(async () => {
    await app.close();
    await audit.flush();
    removeScratch(dir);
  });

  async function launch(body: Record<string, unknown>) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: body });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  async function listSessions(): Promise<Record<string, unknown>[]> {
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs' });
    expect(res.statusCode).toBe(200);
    return (res.json() as { runs: { session: Record<string, unknown> }[] }).runs.map(
      (r) => r.session,
    );
  }

  it('groupLabel is create-on-first-use: two launches share one group, echoed on the DTO', async () => {
    const r1 = await launch({ problem: 'sib 1', sessionId: 'run-1', groupLabel: 'dogfood-s27' });
    const r2 = await launch({ problem: 'sib 2', sessionId: 'run-2', groupLabel: 'dogfood-s27' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const sessions = await listSessions();
    for (const id of ['run-1', 'run-2']) {
      const s = sessions.find((x) => x['id'] === id)!;
      expect(s['group_label']).toBe('dogfood-s27');
      expect('campaign_id' in s).toBe(false);
    }

    const res = await app.inject({ method: 'GET', url: '/api/v1/campaigns' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      groups: { label: string; runs: { runId: string; status: string; delivery: string }[] }[];
    };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]!.label).toBe('dogfood-s27');
    // Launch order, each member carrying status + the delivery tri-state — the rollup needs
    // no second fetch.
    expect(body.groups[0]!.runs).toEqual([
      { runId: 'run-1', status: 'executing', delivery: 'none' },
      { runId: 'run-2', status: 'executing', delivery: 'none' },
    ]);
  });

  it('campaignId attaches to an existing campaign: attached_runs + node_delivery on both GET routes', async () => {
    const r = await launch({ problem: 'extra', sessionId: 'run-3', campaignId: 'camp-1' });
    expect(r.status).toBe(201);

    const s = (await listSessions()).find((x) => x['id'] === 'run-3')!;
    expect(s['campaign_id']).toBe('camp-1');
    expect('group_label' in s).toBe(false);

    for (const url of ['/api/v1/campaigns', '/api/v1/campaigns/camp-1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      const raw = res.json() as Record<string, unknown>;
      const campaign = (
        url.endsWith('camp-1') ? raw['campaign'] : (raw['campaigns'] as unknown[])[0]
      ) as Campaign;
      // The ad-hoc member, with the run wire's own fields.
      expect(campaign.attached_runs).toEqual([
        { runId: 'run-3', status: 'executing', delivery: 'none' },
      ]);
      // The DAG node's delivery, from the durable DeliveryIndex record — 'delivered' + URL.
      expect(campaign.node_delivery).toEqual({
        a: { delivery: 'delivered', deliverUrl: PR_URL },
      });
      // The engine's own persisted fields ride untouched beside the join.
      expect(campaign.node_run_id).toEqual({ a: NODE_RUN_ID });
      expect(campaign.node_status).toEqual({ a: 'completed' });
    }
  });

  it('crew#418: a lift-conflict strand reads completed+stranded on the rollup (a recorded PR still wins)', async () => {
    const r = await launch({ problem: 'strand me', sessionId: 'run-strand', campaignId: 'camp-1' });
    expect(r.status).toBe(201);
    // The engine persists the attached run as a lift-conflict strand: `failed`, the deliver unit
    // `rejected` with the marker. Un-normalized this reads failed+none — the split-brain crew#418
    // fixes on the run wire; the rollup must apply the SAME reinterpretation.
    store[store.findIndex((v) => v.session.id === 'run-strand')] = strandView('run-strand');
    // The DAG node is ALSO strand-shaped, but it carries a recorded PR (set in beforeEach) — the
    // 'delivered' precedence must still win over the strand clause, exactly as resolveDelivery orders it.
    store[store.findIndex((v) => v.session.id === NODE_RUN_ID)] = strandView(NODE_RUN_ID);

    for (const url of ['/api/v1/campaigns', '/api/v1/campaigns/camp-1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      const raw = res.json() as Record<string, unknown>;
      const campaign = (
        url.endsWith('camp-1') ? raw['campaign'] : (raw['campaigns'] as unknown[])[0]
      ) as Campaign;
      // attached_runs: completed + stranded (both the status flip in snapshot and the delivery
      // flip in deliveryOf), NOT the engine's failed + none.
      expect(campaign.attached_runs).toEqual([
        { runId: 'run-strand', status: 'completed', delivery: 'stranded' },
      ]);
      // node_delivery: the recorded PR beats the strand reinterpretation.
      expect(campaign.node_delivery).toEqual({ a: { delivery: 'delivered', deliverUrl: PR_URL } });
    }
  });

  it('an unknown campaignId is a loud 404 and nothing launches', async () => {
    const r = await launch({ problem: 'x', sessionId: 'run-x', campaignId: 'nope' });
    expect(r.status).toBe(404);
    expect(r.body['error']).toMatch(/unknown campaign: nope/);
    expect(launchInputs).toHaveLength(0);
    // Nothing recorded either: the trail has no run.launched for it.
    await audit.flush();
    expect(await audit.readAll({ action: 'run.launched' })).toHaveLength(0);
  });

  it('campaignId + groupLabel is a 400 naming the exclusivity', async () => {
    const r = await launch({
      problem: 'x',
      campaignId: 'camp-1',
      groupLabel: 'both',
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/mutually exclusive/);
    expect(launchInputs).toHaveLength(0);
  });

  it('campaignId on an engine without the campaign bindings is a 501, never a dropped attach', async () => {
    campaignsUnsupported = true;
    const r = await launch({ problem: 'x', campaignId: 'camp-1' });
    expect(r.status).toBe(501);
    expect(launchInputs).toHaveLength(0);
  });

  it('the attach never reaches the engine, and an ungrouped launch is untouched', async () => {
    await launch({ problem: 'grouped', sessionId: 'run-g', groupLabel: 'g' });
    await launch({ problem: 'attached', sessionId: 'run-c', campaignId: 'camp-1' });
    const ungrouped = await launch({ problem: 'plain', sessionId: 'run-p' });
    expect(ungrouped.status).toBe(201);
    expect(Object.keys(ungrouped.body)).toEqual(['runId']);
    // The engine input carries NO grouping key on any launch — grouped or not, the launch is
    // byte-identical to pre-0.19 behavior.
    expect(launchInputs).toHaveLength(3);
    for (const input of launchInputs) {
      expect('campaignId' in input).toBe(false);
      expect('groupLabel' in input).toBe(false);
    }
    // The ungrouped run's DTO has neither echo field.
    const s = (await listSessions()).find((x) => x['id'] === 'run-p')!;
    expect('campaign_id' in s).toBe(false);
    expect('group_label' in s).toBe(false);
    // The ungrouped run's audit detail carries neither key.
    await audit.flush();
    const entry = (await audit.readAll({ action: 'run.launched' })).find(
      (e) => e.runId === 'run-p',
    )!;
    expect(entry.detail !== undefined && 'campaignId' in entry.detail).toBe(false);
    expect(entry.detail !== undefined && 'groupLabel' in entry.detail).toBe(false);
  });

  it('a restarted daemon re-hydrates the attach from the trail (GroupIndex + run.launched)', async () => {
    await launch({ problem: 'sib 1', sessionId: 'run-1', groupLabel: 'sprint-9' });
    await launch({ problem: 'extra', sessionId: 'run-2', campaignId: 'camp-1' });
    await audit.flush();

    // "Restart": a fresh GroupIndex hydrated from the same trail, driving a fresh route set.
    const rehydrated = new GroupIndex();
    await rehydrated.hydrate(audit);
    const app2 = buildApp(rehydrated);
    try {
      const res = await app2.inject({ method: 'GET', url: '/api/v1/runs' });
      const sessions = (res.json() as { runs: { session: Record<string, unknown> }[] }).runs.map(
        (r) => r.session,
      );
      expect(sessions.find((s) => s['id'] === 'run-1')!['group_label']).toBe('sprint-9');
      expect(sessions.find((s) => s['id'] === 'run-2')!['campaign_id']).toBe('camp-1');

      const camps = await app2.inject({ method: 'GET', url: '/api/v1/campaigns' });
      const body = camps.json() as {
        campaigns: Campaign[];
        groups: { label: string; runs: { runId: string }[] }[];
      };
      expect(body.groups.map((g) => g.label)).toEqual(['sprint-9']);
      expect(body.campaigns[0]!.attached_runs!.map((r) => r.runId)).toEqual(['run-2']);
    } finally {
      await app2.close();
    }
  });
});
