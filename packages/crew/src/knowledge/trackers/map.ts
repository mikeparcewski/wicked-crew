/**
 * The trackers on the Knowledge map (DES-PM-001 §3.4 "The map", §6 step 5): each linked tracker estate holds, its
 * `tracked_in` links to the studio projects and repos a person linked it to, and the trail of the issues runs address
 * (`run addresses issue_ref`). Read from estate only, live, under the person's visible set (every source, repo,
 * tracker and project: the view is a human operator's). Labels of `control` endpoints come from crew's own lists.
 */

import type { KnowledgeMapEdge, KnowledgeMapNode, KnowledgeMapResponse } from '../../core/types.js';
import { catalogDocId, readCatalog } from '../shapes/shapes.js';

export const MAP_TRACKERS_MAX = 30;
export const MAP_ISSUES_MAX = 60;

type EstateCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const nodeKey = (store: string, id: string): string => `${store}:${id}`;
/** A typed edge's end as the map keys it: a `control` repo is the map's own repo node. */
const endKey = (store: string, id: string): string => (store === 'control' && id.startsWith('repo:') ? nodeKey('repo', id.slice(5)) : nodeKey(store, id));

export interface MapTracker {
  id: string;
  source: string;
  key: string;
  label: string;
}

/** The map with the trackers drawn in (module doc). Never throws for one bad read: it is noted. */
export async function withTrackers(
  estate: EstateCall,
  map: KnowledgeMapResponse,
  trackers: readonly MapTracker[],
  projects: ReadonlyArray<{ id: string; name: string }>,
  visibleBase: readonly string[],
): Promise<KnowledgeMapResponse> {
  if (trackers.length === 0) return map;
  const nodes = new Map(map.nodes.map((n) => [n.key, n]));
  const edges = new Map(map.edges.map((e) => [`${e.rel}\u0000${e.from}\u0000${e.to}\u0000${e.owner ?? ''}`, e]));
  const notes = [...map.notes];
  let truncated = map.truncated;
  const visible = [...new Set([...visibleBase, ...trackers.map((t) => `source:${t.id}`), ...projects.map((p) => `project:${p.id}`)])];
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const addEdge = (e: KnowledgeMapEdge): void => {
    const k = `${e.rel}\u0000${e.from}\u0000${e.to}\u0000${e.owner ?? ''}`;
    if (!edges.has(k)) edges.set(k, e);
  };
  const controlNode = (id: string): KnowledgeMapNode | null => {
    const k = endKey('control', id);
    if (id.startsWith('project:')) return { key: k, kind: 'project', label: projectName.get(id.slice(8)) ?? id.slice(8) };
    if (id.startsWith('repo:')) return { key: k, kind: 'repo', label: id.slice(5) };
    if (id.startsWith('run:')) return { key: k, kind: 'run', label: `job ${id.slice(4, 12)}` };
    if (id.startsWith('pr:')) return { key: k, kind: 'pr', label: `PR #${id.slice(id.lastIndexOf('#') + 1)}`, repo: id.slice(3, id.lastIndexOf('#')) };
    return null;
  };
  /** One depth-1 neighbourhood of a tracker's document: its control ends and the typed links to them. */
  const neighbours = async (docId: string): Promise<boolean> => {
    type Got = { nodes?: unknown[]; edges?: unknown[]; truncated?: unknown } | null;
    // "The knowledge changed while it was being read" is estate's retryable answer: read again, up to three times.
    const read = async (attempt: number): Promise<Got | undefined> => {
      try {
        return (await estate('knowledge.neighbors', { id: docId, store: 'knowledge', depth: 1, visible })) as Got;
      } catch (err) {
        if (attempt < 2 && /changed/i.test(err instanceof Error ? err.message : String(err))) return read(attempt + 1);
        return undefined;
      }
    };
    const got = await read(0);
    if (got === undefined) return false;
    if (!isObj(got) || !Array.isArray(got.nodes)) return false;
    if (got.truncated === true) truncated = true;
    for (const n of got.nodes) {
      if (!isObj(n) || str(n['store']) !== 'control') continue;
      const id = str(n['id']);
      const node = id === null ? null : controlNode(id);
      if (node !== null && !nodes.has(node.key)) nodes.set(node.key, node);
      // A PR sits in its repo: the trail reaches the repo's own graph from there.
      if (node !== null && node.kind === 'pr' && node.repo !== undefined) {
        const rk = nodeKey('repo', node.repo);
        if (!nodes.has(rk)) nodes.set(rk, { key: rk, kind: 'repo', label: node.repo });
        addEdge({ rel: 'contains', from: rk, to: node.key, confidence: null, evidence: null, owner: null });
      }
    }
    for (const e of got.edges ?? []) {
      if (!isObj(e) || !isObj(e['from']) || !isObj(e['to'])) continue;
      const rel = str(e['rel']);
      const fs = str(e['from']['store']);
      const fi = str(e['from']['id']);
      const ts = str(e['to']['store']);
      const ti = str(e['to']['id']);
      if (rel === null || fs === null || fi === null || ts === null || ti === null) continue;
      addEdge({ rel, from: endKey(fs, fi), to: endKey(ts, ti), confidence: typeof e['confidence'] === 'number' ? e['confidence'] : null, evidence: null, owner: str(e['owner']) });
    }
    return true;
  };
  let issues = 0;
  for (const t of trackers.slice(0, MAP_TRACKERS_MAX)) {
    let cat: Awaited<ReturnType<typeof readCatalog>> = null;
    try {
      cat = await readCatalog(estate, t.id, visible);
    } catch {
      notes.push(`${t.key} (${t.source}) could not be read from estate just now`);
      continue;
    }
    if (cat === null) {
      notes.push(`${t.key} (${t.source}) is not in Understand yet: its projection has not landed`);
      continue;
    }
    const docId = catalogDocId(t.id, 'tracker');
    const tk = nodeKey('knowledge', docId);
    nodes.set(tk, { key: tk, kind: 'tracker', label: t.key, tracker: { source: t.source, key: t.key } });
    if (!(await neighbours(docId))) notes.push(`${t.key}'s links could not be read from estate just now`);
    for (const d of cat.docs) {
      if (!d.key.startsWith('issue/')) continue;
      if (issues >= MAP_ISSUES_MAX) {
        truncated = true;
        break;
      }
      issues++;
      const id = catalogDocId(t.id, d.key);
      const k = nodeKey('knowledge', id);
      nodes.set(k, { key: k, kind: 'issue', label: d.key.slice('issue/'.length), tracker: { source: t.source, key: t.key } });
      addEdge({ rel: 'contains', from: tk, to: k, confidence: null, evidence: null, owner: null });
      await neighbours(id);
    }
  }
  if (trackers.length > MAP_TRACKERS_MAX) truncated = true;
  const drawn = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));
  return { ...map, nodes: [...nodes.values()], edges: drawn, truncated, notes };
}
