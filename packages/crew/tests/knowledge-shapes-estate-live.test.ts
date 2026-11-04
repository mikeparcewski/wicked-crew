// DES-KNOWLEDGE-DATA-001 §10, §19 B4 against a REAL wicked-estate-mcp (B3a, estate >= e6b1f9a): a profiled shape is an
// inert proposal until a person approves it, and the Knowledge map draws only what estate holds live. Isolated stores
// in a temp dir. Skipped without WICKED_ESTATE_MCP_EXE (CI installs no estate binary; the lane runs it).
//
// NEGATIVE CONTROLS (each red with its mutant, scripts/mutants.py in the lane):
// - an unapproved shape is invisible to recall (mutant: the profiler writes the shape with knowledge.write);
// - a declined shape never appears in the Knowledge map (mutant: the map draws shapes from the queue's payloads).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { callEstateTool } from '../src/core/estate-mcp-client.js';
import { buildKnowledgeMap } from '../src/knowledge/shapes/map.js';
import { catalogDocId, fileShapes, shapeProposals } from '../src/knowledge/shapes/shapes.js';

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
  let again: Awaited<ReturnType<typeof fileShapes>> = { filed: [], skipped: -1 };

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
    const filed = await fileShapes(estate, shapeProposals({ id: SID, name: 'support-pg' }, profile, code, new Date().toISOString()));
    for (const f of filed.filed) ids[f.relation] = f.id;
    // Profiled again days later, unchanged: estate's stored payloads (its own key order) still read as the same shapes.
    again = await fileShapes(estate, shapeProposals({ id: SID, name: 'support-pg' }, profile, code, '2026-12-01T00:00:00.000Z'));
  }, 90_000);

  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('NEGATIVE CONTROL: an unapproved shape is invisible to recall; the source structure is not', async () => {
    expect(Object.keys(ids).sort()).toEqual(['support.regions', 'support.tickets']);
    expect(again).toEqual({ filed: [], skipped: 2 });
    const items = await recall([`source:${SID}`, 'repo:escalations']);
    expect(items.some((i) => i['node_id'] === catalogDocId(SID, 'support.tickets') || String(i['node_id']).startsWith(`ksection synthetic source:${SID}/support.tickets`))).toBe(true);
    expect(shapeItems(items)).toEqual([]);
    const pending = (await estate('proposal.list', { kind_type: 'knowledge', state: 'pending' })) as { proposals: unknown[] };
    expect(pending.proposals).toHaveLength(2);
  }, 60_000);

  it('NEGATIVE CONTROL: approved, it is drawn with its typed edges; declined, it never appears in the Knowledge map', async () => {
    const approved = (await estate('proposal.approve', { id: ids['support.tickets'] })) as Record<string, unknown>;
    expect(approved['outcome']).toBe('promoted');
    await estate('proposal.reject', { id: ids['support.regions'] });
    const m = await buildKnowledgeMap(estate, [{ id: SID, name: 'support-pg', described: true }], ['escalations']);
    const shapes = m.nodes.filter((n) => n.kind === 'shape');
    expect(shapes.map((n) => n.proposalId)).toEqual([ids['support.tickets']]);
    expect(JSON.stringify(m)).not.toContain(ids['support.regions']!);
    const rel = (r: string) => m.edges.filter((e) => e.rel === r).map((e) => [e.from, e.to]);
    expect(rel('joins')).toEqual([[`knowledge:${catalogDocId(SID, 'support.tickets')}`, `knowledge:${catalogDocId(SID, 'support.regions')}`]]);
    expect(rel('describes')).toEqual([[`knowledge:${catalogDocId(SID, 'support.tickets')}`, `estate:${CODE}`]]);
    expect(m.nodes.find((n) => n.key === `estate:${CODE}`)).toMatchObject({ kind: 'code', label: 'Ticket', repo: 'escalations' });
    expect(m.sources).toEqual([{ id: SID, name: 'support-pg', described: true, inKnowledge: true, tables: 2 }]);
    // Now recall finds the approved shape, under a visible set that holds every dep it derived.
    expect(shapeItems(await recall([`source:${SID}`, 'repo:escalations']))).toHaveLength(1);
    // A visible set without the repo it describes hides it (estate derived repo:escalations as a dep at approve).
    expect(shapeItems(await recall([`source:${SID}`]))).toEqual([]);
    const narrow = await buildKnowledgeMap(estate, [{ id: SID, name: 'support-pg', described: true }], []);
    expect(narrow.nodes.filter((n) => n.kind === 'shape')).toEqual([]);
    expect(narrow.skipped).toBe(1);
  }, 90_000);
});
