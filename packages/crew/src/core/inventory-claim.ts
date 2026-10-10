/**
 * The completeness claim an enumerating step ends its reply with (wicked-crew#721).
 *
 * wicked-garden's `core/refs/inventory-report.md` codebook asks a step that lists things a later
 * step acts on (issues, PRs, files) to end with one fenced `wicked-inventory` JSON block per source:
 * where it listed from, whether the source answered fully, how many it has, the total the source
 * reported, and what it could not read. crew#648 is why: two triage runs reported success, one
 * inventory was six items short, and nothing on the wire told them apart.
 *
 * Pure: text in, claims out. Deny-dominates on the claim itself: a block that does not parse, or
 * has a required field missing or misshapen, reads `unknown`, never `full`; a `full` that its own
 * numbers contradict (something unread, or a count unlike the source's total) reads `partial`, with
 * the contradiction added to `unread`. Only the blocks that end the reply are the report.
 */

export type InventoryAnswered = 'full' | 'partial' | 'none' | 'unknown';

export interface InventoryClaim {
  source: string | null;
  answered: InventoryAnswered;
  listed: number | null;
  expected: number | null;
  unread: string[];
}

const ANSWERED = new Set<InventoryAnswered>(['full', 'partial', 'none']);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

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
  // Every field is required, as the codebook states it. A claim with a field missing or misshapen
  // cannot vouch for anything, so it reads `unknown` with the reason (never normalized to `full`).
  const problems: string[] = [];
  if (typeof o['source'] !== 'string' || o['source'].trim() === '') problems.push('source is not a non-empty string');
  if (!isCount(o['listed'])) problems.push('listed is not a non-negative integer');
  if (!('expected' in o) || !(o['expected'] === null || isCount(o['expected']))) {
    problems.push('expected is not a non-negative integer or null');
  }
  const unreadRaw = o['unread'];
  if (!Array.isArray(unreadRaw) || !unreadRaw.every((u) => typeof u === 'string')) {
    problems.push('unread is not an array of strings');
  }
  const answeredRaw = o['answered'];
  if (typeof answeredRaw !== 'string' || !ANSWERED.has(answeredRaw as InventoryAnswered)) {
    problems.push(`answered is not full|partial|none: ${JSON.stringify(answeredRaw)}`);
  }
  const source = typeof o['source'] === 'string' && o['source'].trim() !== '' ? o['source'] : null;
  const listed = isCount(o['listed']) ? o['listed'] : null;
  const expected = isCount(o['expected']) ? o['expected'] : null;
  const unread = Array.isArray(unreadRaw) ? unreadRaw.map((u) => (typeof u === 'string' ? u : JSON.stringify(u))) : [];
  if (problems.length > 0) {
    return { source, answered: 'unknown', listed, expected, unread: [...unread, `malformed claim: ${problems.join('; ')}`] };
  }
  let answered = answeredRaw as InventoryAnswered;
  if (answered === 'full') {
    const why: string[] = [];
    if (unread.length > 0) why.push('it lists unread items');
    if (expected !== null && listed !== expected) why.push(`it lists ${listed} of the source's ${expected}`);
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

/** A fence line: up to three SPACES (a tab makes an indented code block, not a fence), the run of
 *  backticks or tildes, then the info string (whose first word is the language). */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The report's claims: the `wicked-inventory` blocks that END the reply, as the codebook asks
 * ("one block per source, nothing after them"). Parsed line by line with fence tracking, so:
 * - a block quoted inside another fence (an example in a code sample) is not a claim;
 * - a block followed by more prose is not the report (an example earlier in the reply);
 * - an inventory opener that never closes (a truncated reply) is an `unknown` claim.
 * Empty when the reply makes no report.
 */
export function parseInventoryClaims(text: string): InventoryClaim[] {
  const lines = text.split(/\r?\n/);
  // Each top-level fenced region: [startLine, endLine (exclusive of nothing; -1 = unclosed), info].
  const regions: { start: number; end: number; info: string; body: string[] }[] = [];
  let open: { start: number; ch: string; len: number; info: string; body: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = FENCE.exec(line);
    if (open === null) {
      if (m) {
        const ch = m[1]![0]!;
        const info = (m[2] ?? '').trim();
        // A backtick fence's info string cannot contain a backtick (that line is inline code).
        if (ch === '`' && info.includes('`')) continue;
        open = { start: i, ch, len: m[1]!.length, info: info.split(/\s+/)[0] ?? '', body: [] };
      }
      continue;
    }
    if (m && (m[2] ?? '').trim() === '' && m[1]![0] === open.ch && m[1]!.length >= open.len) {
      regions.push({ start: open.start, end: i, info: open.info, body: open.body });
      open = null;
    } else {
      open.body.push(line);
    }
  }
  if (open !== null && open.info === 'wicked-inventory') {
    // A truncated report: the opener is the last fence and nothing closed it.
    const closed = trailingReport(lines, regions, open.start);
    return [...closed, unknown('a wicked-inventory block was opened and never closed (the reply was cut off?)')];
  }
  if (open !== null) return [];
  return trailingReport(lines, regions, lines.length);
}

/** The claims of the inventory blocks after which nothing but blank lines and more of them follow. */
function trailingReport(
  lines: string[],
  regions: { start: number; end: number; info: string; body: string[] }[],
  end: number,
): InventoryClaim[] {
  const out: InventoryClaim[] = [];
  let cursor = end;
  for (let r = regions.length - 1; r >= 0; r--) {
    const region = regions[r]!;
    const between = lines.slice(region.end + 1, cursor);
    if (between.some((l) => l.trim() !== '')) break;
    if (region.info !== 'wicked-inventory') break;
    out.unshift(claimOf(region.body.join('\n')));
    cursor = region.start;
  }
  return out;
}

/** Whether a set of claims says the inventory is complete: at least one claim, every one `full`. */
export function inventoryComplete(claims: InventoryClaim[]): boolean {
  return claims.length > 0 && claims.every((c) => c.answered === 'full');
}
