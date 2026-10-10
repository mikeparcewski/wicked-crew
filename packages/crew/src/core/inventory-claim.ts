/**
 * The completeness claim an enumerating step ends its reply with (wicked-crew#721).
 *
 * wicked-garden's `core/refs/inventory-report.md` codebook asks a step that lists things a later
 * step acts on (issues, PRs, files) to end with one fenced `wicked-inventory` JSON block per source:
 * where it listed from, whether the source answered fully, how many it has, the total the source
 * reported, and what it could not read. crew#648 is why: two triage runs reported success, one
 * inventory was six items short, and nothing on the wire told them apart.
 *
 * Pure: text in, claims out. Deny-dominates on the claim itself. A block that does not parse reads
 * `unknown`, never `full`. A `full` that its own numbers contradict (something unread, or fewer
 * listed than the source's total) reads `partial`, with the contradiction added to `unread`.
 */

export type InventoryAnswered = 'full' | 'partial' | 'none' | 'unknown';

export interface InventoryClaim {
  source: string | null;
  answered: InventoryAnswered;
  listed: number | null;
  expected: number | null;
  unread: string[];
}

const BLOCK = /```wicked-inventory[^\S\n]*\n([\s\S]*?)\n```/g;
const ANSWERED = new Set<InventoryAnswered>(['full', 'partial', 'none']);

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

function claimOf(body: string): InventoryClaim {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    return unknown(`the wicked-inventory block is not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return unknown('the wicked-inventory block is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const source = typeof o['source'] === 'string' && o['source'].trim() !== '' ? o['source'] : null;
  const listed = count(o['listed']);
  const expected = o['expected'] === null ? null : count(o['expected']);
  const unread = Array.isArray(o['unread']) ? o['unread'].filter((u): u is string => typeof u === 'string') : [];
  const claimed = o['answered'];
  if (typeof claimed !== 'string' || !ANSWERED.has(claimed as InventoryAnswered)) {
    return { source, answered: 'unknown', listed, expected, unread: [...unread, `answered is not full|partial|none: ${JSON.stringify(claimed)}`] };
  }
  let answered = claimed as InventoryAnswered;
  if (answered === 'full') {
    const why: string[] = [];
    if (unread.length > 0) why.push('it lists unread items');
    if (listed === null) why.push('it gives no listed count');
    else if (expected !== null && listed !== expected) why.push(`it lists ${listed} of the source's ${expected}`);
    if (why.length > 0) {
      answered = 'partial';
      unread.push(`claimed full, but ${why.join(' and ')}`);
    }
  }
  return { source, answered, listed, expected, unread };
}

function unknown(why: string): InventoryClaim {
  return { source: null, answered: 'unknown', listed: null, expected: null, unread: [why] };
}

/** Every `wicked-inventory` block in `text`, in order. Empty when the text claims nothing. */
export function parseInventoryClaims(text: string): InventoryClaim[] {
  const out: InventoryClaim[] = [];
  for (const m of text.matchAll(BLOCK)) out.push(claimOf(m[1] ?? ''));
  return out;
}

/** Whether a set of claims says the inventory is complete: at least one claim, every one `full`. */
export function inventoryComplete(claims: InventoryClaim[]): boolean {
  return claims.length > 0 && claims.every((c) => c.answered === 'full');
}
