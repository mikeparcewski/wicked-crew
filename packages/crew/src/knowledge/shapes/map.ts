/**
 * The Knowledge map (DES-KNOWLEDGE-DATA-001 §10.3): what Understand's Knowledge view draws. Sources and their tables
 * (the catalogs estate holds), approved data shapes, and the code they describe, joined by typed edges.
 *
 * Read from estate only, and only what estate returns LIVE: the catalogs (`knowledge.source_catalog`), the approved
 * knowledge proposals (`proposal.list`, state approved), and each shape's neighbourhood (`knowledge.neighbors`,
 * depth 2), every read under the person's visible set (every source and repo this daemon knows: the view is a human
 * operator's). A pending or declined shape has no node in estate, so it is never drawn; a shape whose node is gone,
 * or hidden, is skipped and counted.
 */

import type { KnowledgeMapEdge, KnowledgeMapNode, KnowledgeMapResponse } from '../../core/types.js';
import { catalogDocId, type EstateCall, proposalIdOfNode, proposalNodeId, readCatalog } from './shapes.js';

export const MAP_SHAPES_MAX = 60;
export const MAP_TABLES_MAX = 300;

interface MapSource {
  id: string;
  name: string;
  described: boolean;
}

interface NeighborNodeWire {
  store?: unknown;
  id?: unknown;
  class?: unknown;
  label?: unknown;
  scope?: unknown;
  deps?: unknown;
  hydrated?: unknown;
}

interface NeighborEdgeWire {
  rel?: unknown;
  from?: { store?: unknown; id?: unknown };
  to?: { store?: unknown; id?: unknown };
  owner?: unknown;
  confidence?: unknown;
  meta?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const nodeKey = (store: string, id: string): string => `${store}:${id}`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A code symbol id's short name (`… src/models/ticket.ts/Ticket#` -> `Ticket`), for an endpoint the graph did not hydrate. */
export function symbolName(id: string): string {
  const core = id.replace(/[#.:()\s]+$/, '');
  const parts = core.split(/[/#.\s`]+/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? id;
}

/** Build the map (module doc). Never throws for one bad read: it is counted in `skipped` or named in `notes`. */
export async function buildKnowledgeMap(estate: EstateCall, sources: readonly MapSource[], repos: readonly string[]): Promise<KnowledgeMapResponse> {
  const visible = [...sources.map((s) => `source:${s.id}`), ...repos.map((r) => `repo:${r}`)];
  const nodes = new Map<string, KnowledgeMapNode>();
  const edges = new Map<string, KnowledgeMapEdge>();
  const notes: string[] = [];
  let truncated = false;
  const sourceOfDoc = new Map<string, string>();
  const unhydrated = new Set<string>();
  /** Sources whose catalog could not be read whole: none of their tables is drawn, from any read. */
  const unread = new Set<string>();
  let tables = 0;
  /** The one admission of a table node (the catalog read and every neighbourhood alike), under {@link MAP_TABLES_MAX}. */
  const admitTable = (): boolean => {
    if (tables >= MAP_TABLES_MAX) {
      truncated = true;
      return false;
    }
    tables++;
    return true;
  };
  const sourceRows: KnowledgeMapResponse['sources'] = [];
  const addEdge = (e: KnowledgeMapEdge): void => {
    const k = `${e.rel}\u0000${e.from}\u0000${e.to}\u0000${e.owner ?? ''}`;
    if (!edges.has(k)) edges.set(k, e);
  };

  for (const s of sources) {
    const srcKey = nodeKey('source', s.id);
    let inKnowledge = false;
    let count = 0;
    if (s.described) {
      // One generation of the source's catalog, or none of it (never a mix of two, never a silent part).
      let got: Awaited<ReturnType<typeof readCatalog>> = null;
      try {
        got = await readCatalog(estate, s.id, visible);
      } catch {
        notes.push(`${s.name}'s tables could not be read from estate just now`);
        unread.add(s.id);
        truncated = true;
      }
      if (got !== null) {
        inKnowledge = true;
        if (got.truncated) truncated = true;
        for (const d of got.docs) {
          count++;
          if (!admitTable()) continue;
          const id = catalogDocId(s.id, d.key);
          const k = nodeKey('knowledge', id);
          sourceOfDoc.set(id, s.name);
          nodes.set(k, { key: k, kind: 'table', label: d.key, source: s.name });
          addEdge({ rel: 'contains', from: srcKey, to: k, confidence: null, evidence: null, owner: null });
        }
      }
    }
    nodes.set(srcKey, { key: srcKey, kind: 'source', label: s.name });
    sourceRows.push({ id: s.id, name: s.name, described: s.described, inKnowledge, tables: count });
  }

  let approved: Array<{ id?: unknown; payload?: { content?: unknown; class?: unknown; relate?: unknown; relate_code?: unknown; shape?: { relation?: unknown; source?: unknown } } }> = [];
  try {
    const got = (await estate('proposal.list', { kind_type: 'knowledge', state: 'approved' })) as { proposals?: typeof approved } | null;
    approved = (got?.proposals ?? []).filter((p) => Array.isArray(p.payload?.relate) || Array.isArray(p.payload?.relate_code));
  } catch {
    notes.push('the approved shapes could not be read from estate');
  }
  if (approved.length > MAP_SHAPES_MAX) {
    truncated = true;
    approved = approved.slice(-MAP_SHAPES_MAX);
  }
  let skipped = 0;
  let shapeNodes = 0;
  for (const p of approved) {
    const pid = str(p.id);
    if (pid === null) continue;
    let got: { nodes?: NeighborNodeWire[]; edges?: NeighborEdgeWire[]; truncated?: unknown } | null;
    try {
      got = (await estate('knowledge.neighbors', { id: proposalNodeId(pid, p.payload?.class), store: 'knowledge', depth: 2, visible })) as typeof got;
    } catch {
      skipped++;
      continue;
    }
    if (!isObj(got) || !Array.isArray(got.nodes)) {
      skipped++;
      continue;
    }
    if (got.truncated === true) truncated = true;
    for (const n of got.nodes) {
      const store = str(n.store);
      const id = str(n.id);
      if (store === null || id === null) continue;
      const k = nodeKey(store, id);
      if (nodes.has(k)) continue;
      const deps = Array.isArray(n.deps) ? n.deps.filter((d): d is string => typeof d === 'string') : [];
      if (store === 'estate') {
        const repo = deps.find((d) => d.startsWith('repo:'))?.slice(5) ?? null;
        if (n.hydrated !== true) unhydrated.add(k);
        nodes.set(k, { key: k, kind: 'code', label: n.hydrated === true ? (str(n.label) ?? symbolName(id)) : symbolName(id), ...(repo !== null ? { repo } : {}) });
        if (repo !== null) {
          const rk = nodeKey('repo', repo);
          if (!nodes.has(rk)) nodes.set(rk, { key: rk, kind: 'repo', label: repo });
          addEdge({ rel: 'contains', from: rk, to: k, confidence: null, evidence: null, owner: null });
        }
      } else if (proposalIdOfNode(id) !== null) {
        // One bound on shapes, whether a shape is a seed or reached through a neighbourhood.
        if (shapeNodes >= MAP_SHAPES_MAX) {
          truncated = true;
          continue;
        }
        shapeNodes++;
        const ownId = proposalIdOfNode(id)!;
        const own = approved.find((x) => String(x.id) === ownId);
        const relation = str(own?.payload?.shape?.relation);
        nodes.set(k, { key: k, kind: 'shape', label: relation !== null ? `${relation} shape` : (str(n.label) ?? id).slice(0, 80), proposalId: ownId, summary: (str(own?.payload?.content) ?? str(n.label) ?? '').slice(0, 600) });
      } else {
        const scope = str(n.scope) ?? '';
        if (scope.startsWith('source:') && unread.has(scope.slice('source:'.length))) continue;
        const table = scope.startsWith('source:') && str(n.class) === 'kdoc';
        if (table && !admitTable()) continue;
        nodes.set(k, { key: k, kind: table ? 'table' : 'knowledge', label: (str(n.label) ?? id).slice(0, 120), ...(sourceOfDoc.has(id) ? { source: sourceOfDoc.get(id)! } : {}) });
      }
    }
    for (const e of got.edges ?? []) {
      const rel = str(e.rel);
      const fs = str(e.from?.store);
      const fi = str(e.from?.id);
      const ts = str(e.to?.store);
      const ti = str(e.to?.id);
      if (rel === null || fs === null || fi === null || ts === null || ti === null) continue;
      const meta = isObj(e.meta) ? e.meta : {};
      const evidence = isObj(meta['evidence']) ? (meta['evidence'] as Record<string, unknown>) : null;
      addEdge({ rel, from: nodeKey(fs, fi), to: nodeKey(ts, ti), confidence: typeof e.confidence === 'number' ? e.confidence : null, evidence, owner: str(e.owner) });
    }
  }
  if (skipped > 0) notes.push(`${skipped} approved shape${skipped === 1 ? ' is' : 's are'} not drawn: estate no longer holds ${skipped === 1 ? 'it' : 'them'}, or hides ${skipped === 1 ? 'it' : 'them'}`);
  // A code endpoint estate could not hydrate is named by its shape's evidence (`label`, else `name`), else its id's tail.
  for (const e of edges.values()) {
    const n = nodes.get(e.to);
    if (n === undefined || n.kind !== 'code' || !unhydrated.has(n.key) || e.evidence === null) continue;
    const named = str(e.evidence['label']) ?? str(e.evidence['name']);
    if (named !== null) nodes.set(n.key, { ...n, label: named.slice(0, 120) });
  }
  // Only edges whose both ends are drawn.
  const drawn = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));
  return { nodes: [...nodes.values()], edges: drawn, sources: sourceRows, shapes: shapeNodes, skipped, truncated, notes };
}

