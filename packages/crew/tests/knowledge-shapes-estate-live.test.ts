// DES-KNOWLEDGE-DATA-001 §10, §19 B4 against a REAL wicked-estate-mcp (B3a; knowledge.forget by source needs estate
// 0.35.9 or later): a person's profile writes its shapes straight into knowledge (crew#1625: submit then approve), a
// re-profile replaces the source's set, and the Knowledge map draws only what estate holds live. Isolated stores in a
// temp dir. Skipped without WICKED_ESTATE_MCP_EXE (CI installs no estate binary; the lane runs it).
//
// NEGATIVE CONTROLS:
// - nothing of a person's profile waits in the review queue (red on the pre-#1625 writer, which filed proposals);
// - a replaced shape is gone from recall and from the map (red without the forget: two shapes of one table recall).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { callEstateTool } from '../src/core/estate-mcp-client.js';
import { buildKnowledgeMap } from '../src/knowledge/shapes/map.js';
import { catalogDocId, shapeProposals, writeShapes } from '../src/knowledge/shapes/shapes.js';

const EXE = process.env['WICKED_ESTATE_MCP_EXE'] ?? '';
const SID = '3f0c9a1e-0000-4000-8000-00000000b4e1';
const CODE = 'scip-typescript npm escalations 1.0 src/`ticket.ts`/Ticket#';
/** Only a shape's content says this (the catalog documents never do). */
const SHAPE_WORDS = 'value-free: counts in bands';

describe.skipIf(EXE === '')('data shapes through a real wicked-estate-mcp', () => {
  let dir: string;
  const estate = (tool: string, args: Record<string, unknown>): Promise<unknown> =>
    callEstateTool(tool, args, {
      spawn: () =>
        spawn(EXE, [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            // The hermetic arming stays (tests/setup/hermetic-home.ts); every store is this test's own.
            ...process.env,
            HOME: dir,
            WICKED_HOME: dir,
            WICKED_ESTATE_DB: join(dir, 'estate.db'),
            WICKED_MEMORY_DB: join(dir, 'memory.db'),
            WICKED_KNOWLEDGE_DB: join(dir, 'knowledge.db'),
            WICKED_XEDGE_DB: join(dir, 'xedge.db'),
          },
        }),
    });
  const recall = async (visible: string[]): Promise<Array<Record<string, unknown>>> =>
    ((await estate('knowledge.recall', { query: 'support.tickets joins support.regions profiled value-free bands', visible })) as { items: Array<Record<string, unknown>> }).items;
  const shapeItems = (items: Array<Record<string, unknown>>) => items.filter((i) => JSON.stringify(i).includes(SHAPE_WORDS));
  const ids: Record<string, string> = {};
  let again: Awaited<ReturnType<typeof writeShapes>> | null = null;
  const BOTH = new Set(['support.tickets', 'support.regions']);
  const VISIBLE = [`source:${SID}`, 'repo:escalations'];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kd-b4-estate-'));
    // The source's structure, as B3b's describe writer puts it there.
    await estate('knowledge.replace_source', {
      sourceId: SID,
      generation: 1,
      label: 'support-pg',
      catalog: { source: 'support-pg', kind: 'postgres' },
      docs: ['support.tickets', 'support.regions'].map((key) => ({ key, title: `support-pg · ${key}`, entry: { relation: key, schema: 'support', name: key.split('.')[1] }, sections: [{ key: 'columns', text: `${key}: a table in data source support-pg. Columns: id integer not null.` }] })),
    });
    const profile = {
      relations: [
        { key: 'support.tickets', rows: '100-9,999' as const, error: null, columns: [{ name: 'id', type: 'integer', nullPct: 0, hasNulls: false, cardinality: 'unique' as const, keyCandidate: true }] },
        { key: 'support.regions', rows: '1-99' as const, error: null, columns: [{ name: 'id', type: 'integer', nullPct: 0, hasNulls: false, cardinality: 'unique' as const, keyCandidate: true }] },
      ],
      joins: [{ from: 'support.tickets', columns: ['region_id'], to: 'support.regions', references: ['id'], basis: 'fk' as const, overlap: 'all' as const }],
    };
    const code = new Map([['support.tickets', [{ repo: 'escalations', symbolId: CODE, name: 'Ticket', kind: 'class', file: 'src/ticket.ts' }]]]);
    const written = await writeShapes(estate, SID, shapeProposals({ id: SID, name: 'support-pg' }, profile, code, '2026-11-01T00:00:00.000Z', 'mike'), async () => BOTH, VISIBLE);
    for (const f of written.written) ids[f.relation] = f.id;
    // Profiled again days later, unchanged: estate's stored payloads (its own key order) still read as the same shapes.
    again = await writeShapes(estate, SID, shapeProposals({ id: SID, name: 'support-pg' }, profile, code, '2026-11-20T00:00:00.000Z', 'mike'), async () => BOTH, VISIBLE);
  }, 90_000);

  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('NEGATIVE CONTROL: a person\'s profile is in knowledge at once, with its typed edges, and nothing waits in the queue', async () => {
    expect(Object.keys(ids).sort()).toEqual(['support.regions', 'support.tickets']);
    expect(again).toEqual({ written: [], unchanged: 2, replaced: 0 });
    const pending = (await estate('proposal.list', { kind_type: 'knowledge', state: 'pending' })) as { proposals: unknown[] };
    expect(pending.proposals).toEqual([]);
    const m = await buildKnowledgeMap(estate, [{ id: SID, name: 'support-pg', described: true }], ['escalations']);
    expect(m.nodes.filter((n) => n.kind === 'shape').map((n) => n.proposalId).sort()).toEqual([ids['support.regions'], ids['support.tickets']].sort());
    const rel = (r: string) => m.edges.filter((e) => e.rel === r).map((e) => [e.from, e.to]);
    expect(rel('joins')).toEqual([[`knowledge:${catalogDocId(SID, 'support.tickets')}`, `knowledge:${catalogDocId(SID, 'support.regions')}`]]);
    expect(rel('describes')).toEqual([[`knowledge:${catalogDocId(SID, 'support.tickets')}`, `estate:${CODE}`]]);
    expect(m.skipped).toBe(0);
    // Recall finds both, under a visible set that holds every dep estate derived.
    expect(shapeItems(await recall([`source:${SID}`, 'repo:escalations']))).toHaveLength(2);
    // A visible set without the repo the tickets shape describes hides that one (estate derived repo:escalations).
    expect(shapeItems(await recall([`source:${SID}`]))).toHaveLength(1);
  }, 90_000);

  it('NEGATIVE CONTROL: a re-profile replaces the set: a changed shape is rewritten, a dropped table\'s shape is forgotten', async () => {
    const changed = {
      relations: [{ key: 'support.tickets', rows: '10,000-999,999' as const, error: null, columns: [{ name: 'id', type: 'integer', nullPct: 0, hasNulls: false, cardinality: 'unique' as const, keyCandidate: true }] }],
      joins: [],
    };
    const out = await writeShapes(estate, SID, shapeProposals({ id: SID, name: 'support-pg' }, changed, new Map(), '2026-11-25T00:00:00.000Z', 'mike'), async () => new Set(['support.tickets']), VISIBLE);
    expect(out.written.map((w) => w.relation)).toEqual(['support.tickets']);
    expect(out).toMatchObject({ unchanged: 0, replaced: 2 });
    const items = shapeItems(await recall([`source:${SID}`, 'repo:escalations']));
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0])).toContain('10,000-999,999');
    const m = await buildKnowledgeMap(estate, [{ id: SID, name: 'support-pg', described: true }], ['escalations']);
    expect(m.nodes.filter((n) => n.kind === 'shape').map((n) => n.proposalId)).toEqual([out.written[0]!.id]);
    expect(m.edges.filter((e) => e.rel === 'describes')).toEqual([]);
  }, 90_000);
});
