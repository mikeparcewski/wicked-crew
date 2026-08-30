// The /api/v1/campaigns surface (crew#342 + TH-9) — route behavior over a stubbed adapter.
//
// The engine's scheduler is exercised end-to-end by tests/integration/campaign-dag.test.ts
// (which needs an addon carrying the campaign bindings); THIS file pins the HTTP contract the
// routes owe regardless of the installed engine: status-code mapping (including the 501 an old
// addon earns — "upgrade the engine", never "fix your request"), zod strictness with unknown
// keys named, and that a launch arms the composed node workflows before the def.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CampaignsUnsupportedError, CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import type { Campaign, CampaignDef, WorkflowDef } from '../src/core/types.js';

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
  node_run_id: { a: 'camp-1:a:a0' },
  node_attempt: { a: 0 },
  pending_decision_amend: {},
  pending_failure_gates: [],
  fail_fast_tripped: false,
};

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;

/** What the stubbed adapter captured from the last launch. */
let launched: { def: CampaignDef; workflows: WorkflowDef[] } | null = null;
/** Behavior toggles, reassigned per case. */
let unsupported = false;
let detail: Campaign | null = CAMPAIGN;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'campaign-routes-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });

  // Stub the campaign seam INSTANCE-LEVEL (the run-events pattern): these tests pin the routes'
  // mapping, and must answer the same whether the installed addon carries the bindings or not.
  adapter.launchCampaign = async (def: CampaignDef, workflows: WorkflowDef[] = []) => {
    if (unsupported) throw new CampaignsUnsupportedError('Launching a campaign');
    if (def.id === 'camp-dup') throw new Error(`campaign already exists: ${def.id}`);
    launched = { def, workflows };
    return def.id;
  };
  adapter.resumeCampaign = async (id: string) => {
    if (unsupported) throw new CampaignsUnsupportedError('Resuming a campaign');
    if (id !== CAMPAIGN.id) throw new Error(`campaign not found: ${id}`);
    return 'completed';
  };
  adapter.cancelCampaign = async (id: string) => {
    if (unsupported) throw new CampaignsUnsupportedError('Cancelling a campaign');
    if (id !== CAMPAIGN.id) throw new Error(`campaign not found: ${id}`);
    return 'cancelled';
  };
  adapter.campaignDetail = async (id: string) => {
    if (unsupported) throw new CampaignsUnsupportedError('Reading a campaign');
    return id === CAMPAIGN.id ? detail : null;
  };
  adapter.campaignList = async () => {
    if (unsupported) throw new CampaignsUnsupportedError('Listing campaigns');
    return detail === null ? [] : [detail];
  };

  app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /campaigns', () => {
  it('201s a valid scenario batch and arms the composed workflows with the launch', async () => {
    unsupported = false;
    launched = null;
    const res = await post('/api/v1/campaigns', {
      id: 'camp-ok',
      scenarios: [
        { id: 'a', tool: { cmd: ['node', '/specs/a.mjs'] } },
        { id: 'b', deps: ['a'], tool: { cmd: ['node', '/specs/b.mjs'] } },
      ],
      maxConcurrency: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body['campaignId']).toBe('camp-ok');
    // Read through a cast: TS narrows the `launched = null` above across the await (it cannot
    // see the stub's side effect), so the direct read types as `never`.
    const got = launched as unknown as { def: CampaignDef; workflows: WorkflowDef[] } | null;
    expect(got).not.toBeNull();
    expect(got!.def.nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
    expect(got!.def.edges).toEqual([{ from: 'a', to: 'b', condition: 'on_success' }]);
    expect(got!.workflows.map((w) => w.id)).toEqual([
      'campaign-camp-ok-a',
      'campaign-camp-ok-b',
    ]);
  });

  it('400s a mapping reject with the mapper’s own message (the 1022-byte rule reaches the wire)', async () => {
    const res = await post('/api/v1/campaigns', {
      scenarios: [{ id: 'a', tool: { cmd: ['node', 'x'.repeat(1023)] } }],
    });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/1022-byte PTY canonical-line limit/);
  });

  it('400s unknown body fields BY NAME (strict schema, FINDING-031 doctrine)', async () => {
    const res = await post('/api/v1/campaigns', {
      scenarios: [{ id: 'a', tool: { cmd: ['true'] } }],
      nodes: [],
    });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/unknown field `nodes`/);
  });

  it('409s a campaign id that already exists', async () => {
    const res = await post('/api/v1/campaigns', {
      id: 'camp-dup',
      scenarios: [{ id: 'a', tool: { cmd: ['true'] } }],
    });
    expect(res.status).toBe(409);
  });

  it('501s when the engine addon lacks the campaign bindings — upgrade, not fix-your-request', async () => {
    unsupported = true;
    const res = await post('/api/v1/campaigns', {
      scenarios: [{ id: 'a', tool: { cmd: ['true'] } }],
    });
    expect(res.status).toBe(501);
    expect(res.body['error']).toMatch(/no campaign bindings/);
    unsupported = false;
  });
});

describe('GET /campaigns + /campaigns/:id', () => {
  it('lists campaigns in the engine wire shape', async () => {
    detail = CAMPAIGN;
    const res = await get('/api/v1/campaigns');
    expect(res.status).toBe(200);
    const campaigns = res.body['campaigns'] as Campaign[];
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]!.node_run_id['a']).toBe('camp-1:a:a0');
  });

  it('answers a known id with the full campaign and an unknown id with 404', async () => {
    const found = await get('/api/v1/campaigns/camp-1');
    expect(found.status).toBe(200);
    expect((found.body['campaign'] as Campaign).status).toBe('completed');

    const missing = await get('/api/v1/campaigns/ghost');
    expect(missing.status).toBe(404);
    expect(missing.body['error']).toMatch(/unknown campaign: ghost/);
  });

  it('501s both reads on an old addon', async () => {
    unsupported = true;
    expect((await get('/api/v1/campaigns')).status).toBe(501);
    expect((await get('/api/v1/campaigns/camp-1')).status).toBe(501);
    unsupported = false;
  });
});

describe('POST /campaigns/:id/resume + /cancel', () => {
  it('resolves the campaign status token for a known id', async () => {
    const resumed = await post('/api/v1/campaigns/camp-1/resume');
    expect(resumed.status).toBe(200);
    expect(resumed.body).toEqual({ campaignId: 'camp-1', status: 'completed' });

    const cancelled = await post('/api/v1/campaigns/camp-1/cancel');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ campaignId: 'camp-1', status: 'cancelled' });
  });

  it('404s an id the engine does not know', async () => {
    expect((await post('/api/v1/campaigns/ghost/resume')).status).toBe(404);
    expect((await post('/api/v1/campaigns/ghost/cancel')).status).toBe(404);
  });

  it('501s on an old addon', async () => {
    unsupported = true;
    expect((await post('/api/v1/campaigns/camp-1/resume')).status).toBe(501);
    expect((await post('/api/v1/campaigns/camp-1/cancel')).status).toBe(501);
    unsupported = false;
  });
});
