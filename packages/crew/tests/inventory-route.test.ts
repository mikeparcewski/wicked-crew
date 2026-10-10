// GET /runs/:id/inventory (wicked-crew#721): each enumerating unit's completeness claim, served.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import type { SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let views: SessionView[] = [];
let outputs: Record<string, string | null> = {};
let throwing = new Set<string>();

const block = (o: unknown) => '```wicked-inventory\n' + JSON.stringify(o) + '\n```';

function run(id: string, phases: string[]): SessionView {
  return {
    session: { id, workflow_id: 'triage', problem: 'p', status: 'completed', unit_ix: phases.length, attempt: 0 },
    units: phases.map((p, i) => ({ id: `${id}:${p}`, ord: i + 1, session_id: id, status: 'done' })),
  } as unknown as SessionView;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'inventory-route-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapter.sessionsDetail = async () => views;
  adapter.sessions = async () => views.map((v) => v.session.id);
  adapter.workOutput = async (unitId: string) => {
    if (throwing.has(unitId)) throw new Error('transcript store unavailable');
    return outputs[unitId] ?? null;
  };
  adapter.interactionRequests = async () => [];
  adapter.runEvents = async () => [];
  app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

beforeEach(() => {
  views = [];
  outputs = {};
  throwing = new Set();
});

afterAll(async () => {
  await app.close();
  adapter.close();
  removeScratch(dir);
});

async function get(id: string) {
  const res = await fetch(`${baseUrl}/api/v1/runs/${id}/inventory`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /runs/:id/inventory', () => {
  it('serves the #648 shape: a short inventory reads partial and the run is not complete', async () => {
    views = [run('r1', ['recon', 'adjudicate'])];
    outputs['r1:recon'] = `9 issues\n${block({ source: 'gh issue list', answered: 'partial', listed: 9, expected: 10, unread: ['issue #936'] })}`;
    outputs['r1:adjudicate'] = 'dispositions';
    const { status, body } = await get('r1');
    expect(status).toBe(200);
    expect(body).toMatchObject({ runId: 'r1', readable: true, complete: false });
    expect(body['units']).toEqual([
      { ord: 1, unitId: 'r1:recon', claims: [{ source: 'gh issue list', answered: 'partial', listed: 9, expected: 10, unread: ['issue #936'] }] },
    ]);
  });

  it('every claim full: complete', async () => {
    views = [run('r2', ['issues', 'prs'])];
    outputs['r2:issues'] = block({ source: 'gh issue list', answered: 'full', listed: 58, expected: 58, unread: [] });
    outputs['r2:prs'] = block({ source: 'gh pr list', answered: 'full', listed: 1, expected: 1, unread: [] });
    const { body } = await get('r2');
    expect(body['complete']).toBe(true);
    expect((body['units'] as unknown[]).length).toBe(2);
  });

  it('a unit whose output cannot be read keeps the run from reading complete (codex r1)', async () => {
    views = [run('r4', ['issues', 'prs'])];
    outputs['r4:issues'] = block({ source: 'gh issue list', answered: 'full', listed: 5, expected: 5, unread: [] });
    throwing.add('r4:prs');
    const { body } = await get('r4');
    expect(body).toMatchObject({ complete: false, unreadUnits: ['r4:prs'] });
  });

  it('a finished unit with no stored transcript also blocks complete; a unit that has not run does not (codex r3)', async () => {
    views = [run('r5', ['issues', 'prs'])];
    outputs['r5:issues'] = block({ source: 'gh issue list', answered: 'full', listed: 5, expected: 5, unread: [] });
    expect((await get('r5')).body).toMatchObject({ complete: false, unreadUnits: ['r5:prs'] });
    const pending = run('r6', ['issues', 'prs']);
    (pending.units[1] as { status: string }).status = 'pending';
    views = [pending];
    outputs['r6:issues'] = outputs['r5:issues']!;
    expect((await get('r6')).body).toMatchObject({ complete: true, unreadUnits: [] });
  });

  it('a run that claims nothing is not complete, and an unknown run is a 404', async () => {
    views = [run('r3', ['explore'])];
    outputs['r3:explore'] = 'no inventory';
    expect((await get('r3')).body).toMatchObject({ readable: true, complete: false, units: [], unreadUnits: [] });
    expect((await get('nope')).status).toBe(404);
  });
});
