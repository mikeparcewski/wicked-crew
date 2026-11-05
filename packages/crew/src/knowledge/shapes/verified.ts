/**
 * The approved data shapes of one source that a project may see, VERIFIED against estate's own node (DES-KNOWLEDGE-DATA-001
 * §4.3, §10.1): an app's `tables` recall and the knowledge summary read shapes through here, never from a proposal's
 * payload alone (its `shape` record is the proposer's metadata, while estate derives a shape's deps from ALL its
 * endpoints at approve, so a shape can stand on a source or repo its record does not name).
 *
 * Per approved proposal (its state read back, not assumed from the filter) whose record names the source, estate's
 * `knowledge.neighbors` on the shape's node under `visible`: estate answers nothing for a hidden or unknown node, and
 * the node it answers must be the asked one, with deps (`effectiveDeps`, the relay's rule) inside the FRESH set. A
 * shape's joins are in its approved text (the profiler writes "joins <table> on <column>"), so no edge is counted.
 *
 * Bounded: it stops once `want` shapes are admitted or `budget` candidates were checked. `exhausted` = every candidate
 * was checked; `failed` = a neighbourhood read failed. A count is established only when nothing failed and either every
 * candidate was checked or `want` were admitted (and stay admitted under the caller's release set).
 */

import { effectiveDeps } from '../../mcp/estate-relay.js';
import { type EstateCall, proposalNodeId } from './shapes.js';

export const VERIFY_BUDGET = 30;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface VerifiedShape {
  relation: string;
  /** The approved, value-free summary (the text a person approved, which estate holds as the node's content). */
  content: string;
  /** The deps estate holds for the node (a caller re-checks them against its own release set). */
  deps: string[];
}

/** The approved knowledge proposals (`proposal.list`), read once; `null` = the review queue could not be read. */
export async function approvedShapes(estate: EstateCall): Promise<unknown[] | null> {
  try {
    const listed = await estate('proposal.list', { kind_type: 'knowledge', state: 'approved' });
    return isObj(listed) && Array.isArray(listed['proposals']) ? listed['proposals'] : null;
  } catch {
    return null;
  }
}

/** The verified shapes of `sourceId` among `proposals` (module doc). */
export async function verifiedShapes(
  estate: EstateCall,
  proposals: readonly unknown[],
  sourceId: string,
  visible: readonly string[],
  fresh: () => Promise<ReadonlySet<string>>,
  opts: { want?: number; budget?: number } = {},
): Promise<{ shapes: VerifiedShape[]; exhausted: boolean; failed: boolean }> {
  const want = opts.want ?? Number.POSITIVE_INFINITY;
  const budget = opts.budget ?? VERIFY_BUDGET;
  const candidates: Array<{ id: string; cls: unknown; relation: string; content: string }> = [];
  for (const p of proposals) {
    if (!isObj(p) || p['state'] !== 'approved' || typeof p['id'] !== 'string' || !isObj(p['payload'])) continue;
    const shape = p['payload']['shape'];
    if (!isObj(shape) || shape['sourceId'] !== sourceId || typeof shape['relation'] !== 'string') continue;
    candidates.push({ id: p['id'], cls: p['payload']['class'], relation: shape['relation'], content: typeof p['payload']['content'] === 'string' ? p['payload']['content'] : '' });
  }
  const out: VerifiedShape[] = [];
  let checked = 0;
  let failed = false;
  for (const c of candidates) {
    if (out.length >= want || checked >= budget) break;
    checked++;
    const nodeId = proposalNodeId(c.id, c.cls);
    let got: unknown;
    try {
      got = await estate('knowledge.neighbors', { id: nodeId, store: 'knowledge', depth: 1, kinds: ['derived_from'], visible: [...visible] });
    } catch (err) {
      // Estate answers a hidden (or unknown) node with this tool error: that shape is not this project's, not a failure.
      if (!/no visible knowledge node/i.test(err instanceof Error ? err.message : String(err))) failed = true;
      continue;
    }
    const nodes = isObj(got) && Array.isArray(got['nodes']) ? got['nodes'] : [];
    const start = nodes.find((n) => isObj(n) && n['store'] === 'knowledge' && n['id'] === nodeId);
    if (!isObj(start)) continue;
    const deps = effectiveDeps(start);
    const now = await fresh();
    if (!deps.every((d) => now.has(d))) continue;
    out.push({ relation: c.relation, content: c.content, deps });
  }
  return { shapes: out, exhausted: checked >= candidates.length, failed };
}
