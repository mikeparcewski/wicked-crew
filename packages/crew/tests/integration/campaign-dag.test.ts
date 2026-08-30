// TH-9 end-to-end: a small batch of API scenarios runs as a DURABLE DAG through the real engine
// scheduler, launched and resumed over /api/v1, with the campaign* frames observed on /ws.
//
// This is the test-R9 acceptance shape, honest about every layer:
//  - the scenarios are FILES (node scripts probing this daemon's own /api/v1 surface), passed to
//    the engine as Tool-phase argv paths — never inlined bodies (the 1022-byte PTY trap);
//  - the DAG is real: node `b` refuses to pass unless node `a`'s evidence artifact already
//    exists AND the daemon's own GET /campaigns/:id reports `a` completed — so a scheduler that
//    dispatched `b` early fails the campaign rather than fake-passing it;
//  - durability is proven the only way it can be: the first adapter (engine actor) is torn down
//    and a SECOND adapter over the same db serves the campaign's full state and its resume.
//
// Requires an engine addon carrying the campaign bindings (they land after wicked-core-ts
// 0.7.2). On the npm-pinned addon this file SKIPS — the route contract, mapper, and WS
// passthrough stay covered by the unit suites either way. To run it against a local engine:
// `node scripts/use-local-core-ts.mjs` (workspace root), then `npx vitest run` this file.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { Campaign } from '../../src/core/types.js';

// Presence-gated at COLLECTION time (describe.skipIf needs the answer before beforeAll): napi
// class methods live on the prototype, so the check needs no spawned engine.
const require = createRequire(import.meta.url);
const { Core } = require('wicked-core-ts') as { Core: { prototype: Record<string, unknown> } };
const supported = typeof Core.prototype['launchCampaign'] === 'function';

const CAMPAIGN_ID = 'camp-e2e-th9';

let scratch: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl = '';
let ws: WebSocket;

/** Every campaign* frame received on /ws, in arrival order, as `type[:node]`. */
const frames: string[] = [];
/** Raw campaign* frames for field-level assertions. */
const rawFrames: Array<Record<string, unknown>> = [];
let campaignDone: Promise<void>;

const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  if (!supported) return;
  scratch = mkdtempSync(join(tmpdir(), 'campaign-dag-'));

  // Lane isolation: keep the engine's side-channels (apps emit store, minted repo graphs) inside
  // the scratch dir — never the developer's real ~/.wicked-estate / ~/.something-wicked state.
  for (const key of ['WICKED_ESTATE_DB', 'WICKED_ESTATE_REPO_GRAPH_ROOT', 'WICKED_CREW_PROJECT_GRAPH_ROOT']) {
    savedEnv[key] = process.env[key];
  }
  process.env['WICKED_ESTATE_DB'] = join(scratch, 'estate-emit.db');
  process.env['WICKED_ESTATE_REPO_GRAPH_ROOT'] = join(scratch, 'repo-graphs');
  process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'] = join(scratch, 'project-graphs');

  adapter = new CoreAdapter({ dbPath: join(scratch, 'core.db'), stub: true });
  app = await createServer(adapter, { auditPath: join(scratch, 'audit.log') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  // The scenario SPEC FILES — authored to disk first, referenced by path from the campaign.
  const specs = join(scratch, 'specs');
  const evidence = join(scratch, 'evidence');
  mkdirSync(specs, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  // a: probe GET /health, demand a real body, write the wire evidence artifact.
  writeFileSync(
    join(specs, 'a-health.spec.mjs'),
    `const [base, out] = process.argv.slice(2);
const res = await fetch(base + '/api/v1/health');
if (res.status !== 200) { console.error('health != 200:', res.status); process.exit(1); }
const body = await res.json();
if (typeof body.version !== 'string') { console.error('health body has no version'); process.exit(1); }
const { writeFileSync } = await import('node:fs');
writeFileSync(out, JSON.stringify({ scenario: 'a', status: res.status, body }));
`,
  );
  // b (deps: [a]): consumer-state proof — a's artifact must exist AND the daemon must already
  // report node a completed. A premature dispatch of b fails here, loudly.
  writeFileSync(
    join(specs, 'b-consume.spec.mjs'),
    `const [base, aEvidence, out] = process.argv.slice(2);
const { readFileSync, writeFileSync } = await import('node:fs');
const upstream = JSON.parse(readFileSync(aEvidence, 'utf8'));
if (upstream.scenario !== 'a') { console.error('upstream evidence is not scenario a'); process.exit(1); }
const res = await fetch(base + '/api/v1/campaigns/${CAMPAIGN_ID}');
if (res.status !== 200) { console.error('campaign detail != 200:', res.status); process.exit(1); }
const { campaign } = await res.json();
if (campaign.node_status.a !== 'completed') { console.error('dep a not completed at b dispatch:', campaign.node_status.a); process.exit(1); }
writeFileSync(out, JSON.stringify({ scenario: 'b', dep_a: campaign.node_status.a }));
`,
  );
  // c (independent): a second API scenario with no deps — runs in parallel with the a→b chain.
  writeFileSync(
    join(specs, 'c-workflows.spec.mjs'),
    `const [base, out] = process.argv.slice(2);
const res = await fetch(base + '/api/v1/workflows');
if (res.status !== 200) { console.error('workflows != 200:', res.status); process.exit(1); }
const body = await res.json();
const ids = (body.workflows ?? body ?? []).map?.((w) => w.id) ?? [];
if (!ids.includes('feature')) { console.error('feature workflow missing:', ids); process.exit(1); }
const { writeFileSync } = await import('node:fs');
writeFileSync(out, JSON.stringify({ scenario: 'c', workflows: ids.length }));
`,
  );

  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let resolveDone!: () => void;
  campaignDone = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  ws.on('message', (data: Buffer | string) => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(ev['type'] ?? '');
    if (!type.startsWith('campaign')) return;
    rawFrames.push(ev);
    frames.push(ev['node'] !== undefined ? `${type}:${String(ev['node'])}` : type);
    if (type === 'campaignCompleted') resolveDone();
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
}, 60000);

afterAll(async () => {
  if (!supported) return;
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  await app.close();
  adapter.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
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

describe.skipIf(!supported)('campaign DAG over the API (TH-9)', () => {
  it(
    'runs a scenario batch as a durable DAG: launch → campaign* on /ws → all nodes completed',
    async () => {
      const specs = join(scratch, 'specs');
      const evidence = join(scratch, 'evidence');
      const res = await post('/api/v1/campaigns', {
        id: CAMPAIGN_ID,
        name: 'th9 e2e — API scenarios as a DAG',
        maxConcurrency: 2,
        scenarios: [
          {
            id: 'a',
            title: 'health probe',
            tool: { cmd: ['node', join(specs, 'a-health.spec.mjs'), baseUrl, join(evidence, 'a.json')] },
          },
          {
            id: 'b',
            title: 'consume a evidence + campaign detail',
            deps: ['a'],
            tool: {
              cmd: [
                'node',
                join(specs, 'b-consume.spec.mjs'),
                baseUrl,
                join(evidence, 'a.json'),
                join(evidence, 'b.json'),
              ],
            },
          },
          {
            id: 'c',
            title: 'workflows probe',
            tool: { cmd: ['node', join(specs, 'c-workflows.spec.mjs'), baseUrl, join(evidence, 'c.json')] },
          },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body['campaignId']).toBe(CAMPAIGN_ID);

      // The engine schedules; the daemon only relays. Wait for the terminal frame on /ws.
      await Promise.race([
        campaignDone,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`campaignCompleted never arrived; frames so far: ${frames.join(' → ')}`)),
            110000,
          ),
        ),
      ]);

      // Frame ORDER proves the DAG (not just completion): b starts only after a completes.
      expect(frames[0]).toBe('campaignLaunched');
      expect(frames[frames.length - 1]).toBe('campaignCompleted');
      const idx = (f: string) => {
        const i = frames.indexOf(f);
        expect(i, `${f} missing from: ${frames.join(' → ')}`).toBeGreaterThanOrEqual(0);
        return i;
      };
      expect(idx('campaignNodeCompleted:a')).toBeLessThan(idx('campaignNodeStarted:b'));
      expect(idx('campaignNodeStarted:a')).toBeLessThan(idx('campaignNodeCompleted:a'));
      expect(idx('campaignNodeStarted:c')).toBeLessThan(idx('campaignCompleted'));

      // The started frames carry the attempt-keyed run ids the design mints.
      const startedA = rawFrames.find((f) => f['type'] === 'campaignNodeStarted' && f['node'] === 'a');
      expect(startedA?.['runId']).toBe(`${CAMPAIGN_ID}:a:a0`);
      expect(startedA?.['campaign']).toBe(CAMPAIGN_ID);

      // Every scenario left its artifact — the executor genuinely ran the spec FILES.
      for (const name of ['a.json', 'b.json', 'c.json']) {
        expect(existsSync(join(evidence, name)), `${name} missing`).toBe(true);
      }
      expect(JSON.parse(readFileSync(join(evidence, 'b.json'), 'utf8'))).toEqual({
        scenario: 'b',
        dep_a: 'completed',
      });

      // And the read routes agree: list carries it, detail shows every node terminal-completed.
      const list = await get('/api/v1/campaigns');
      expect(list.status).toBe(200);
      expect((list.body['campaigns'] as Campaign[]).map((c) => c.id)).toContain(CAMPAIGN_ID);

      const detail = await get(`/api/v1/campaigns/${CAMPAIGN_ID}`);
      expect(detail.status).toBe(200);
      const campaign = detail.body['campaign'] as Campaign;
      expect(campaign.status).toBe('completed');
      expect(campaign.node_status).toEqual({ a: 'completed', b: 'completed', c: 'completed' });
      expect(campaign.node_run_id).toEqual({
        a: `${CAMPAIGN_ID}:a:a0`,
        b: `${CAMPAIGN_ID}:b:a0`,
        c: `${CAMPAIGN_ID}:c:a0`,
      });
    },
    120000,
  );

  it('resumes over the API — and 404s an id the engine never launched', async () => {
    const resumed = await post(`/api/v1/campaigns/${CAMPAIGN_ID}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toEqual({ campaignId: CAMPAIGN_ID, status: 'completed' });

    expect((await post('/api/v1/campaigns/ghost/resume')).status).toBe(404);
  });

  it('is durable: a fresh engine actor over the same db serves the state and the resume', async () => {
    // Tear the first daemon down completely (server + engine actor), then stand a second one up
    // over the SAME db — the restart shape. The campaign must come back from the store, not from
    // anything the first process held in memory.
    await app.close();
    adapter.close();

    adapter = new CoreAdapter({ dbPath: join(scratch, 'core.db'), stub: true });
    app = await createServer(adapter, { auditPath: join(scratch, 'audit2.log') });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    const detail = await get(`/api/v1/campaigns/${CAMPAIGN_ID}`);
    expect(detail.status).toBe(200);
    const campaign = detail.body['campaign'] as Campaign;
    expect(campaign.status).toBe('completed');
    expect(campaign.node_status).toEqual({ a: 'completed', b: 'completed', c: 'completed' });

    // Resume through the fresh actor: re-derives the ready set from persisted terminal statuses
    // — nothing re-runs (the node run ids stay at attempt a0) and the token is still terminal.
    const resumed = await post(`/api/v1/campaigns/${CAMPAIGN_ID}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toEqual({ campaignId: CAMPAIGN_ID, status: 'completed' });
    const after = (await get(`/api/v1/campaigns/${CAMPAIGN_ID}`)).body['campaign'] as Campaign;
    expect(after.node_run_id['a']).toBe(`${CAMPAIGN_ID}:a:a0`);
  }, 60000);
});

describe.skipIf(supported)('campaign DAG over the API (TH-9) — engine gate', () => {
  it('SKIPPED: the installed wicked-core-ts addon carries no campaign bindings', () => {
    // Not a failure: the npm-pinned addon predates the bindings. Link a local engine build
    // (node scripts/use-local-core-ts.mjs) to run the e2e above.
    expect(supported).toBe(false);
  });
});
