/**
 * Run learnings, part 3: an approved learning reaches the next run's brief.
 *
 * At launch the daemon reads the memory store (`memory.list`, the complete set: relevance recall
 * excludes faceted memories under an empty intent) and appends the approved learnings that apply to
 * this run to its problem, inside a marked block (like the linked-issues block) the deliver text
 * takes back out. A memory applies when every repo/project facet it carries matches the run's: one
 * faceted to another repository or project never crosses over; one with neither facet (an operator
 * preference, a pattern a person widened) applies everywhere. The run's own words rank them; at
 * most {@link MAX_RECALLED} are included, so a large store never floods a brief.
 *
 * Best-effort by contract: a store that cannot be read launches the run without the block.
 */

export const RUN_LEARNINGS_OPEN = '<!-- wicked-crew:learnings -->';
export const RUN_LEARNINGS_CLOSE = '<!-- /wicked-crew:learnings -->';
export const MAX_RECALLED = 8;
/** The longest one recalled learning may be in a brief. */
const MAX_RECALLED_CHARS = 600;

export interface MemoryRow {
  memory_id?: string;
  content: string;
  facets: Record<string, unknown>;
  created_at?: number;
}

const WORD = /[a-z0-9][a-z0-9_.-]{2,}/gu;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(WORD) ?? []);
}

/** Whether a memory's repo/project facets allow it in a run on `repo` filed in `project`. */
export function appliesTo(facets: Record<string, unknown>, repo: string | null, project: string | null): boolean {
  const r = typeof facets['repo'] === 'string' ? facets['repo'] : null;
  const p = typeof facets['project'] === 'string' ? facets['project'] : null;
  if (r !== null && r !== repo) return false;
  if (p !== null && p !== project) return false;
  return true;
}

/** The learnings that apply, best first: scoped to this repo/project before general ones, then by overlap with the problem, then newest. */
export function selectLearnings(rows: readonly MemoryRow[], problem: string, repo: string | null, project: string | null, max = MAX_RECALLED): MemoryRow[] {
  const asked = words(problem);
  const scored = rows
    .filter((m) => typeof m.content === 'string' && m.content.trim() !== '' && appliesTo(m.facets ?? {}, repo, project))
    .map((m) => {
      const scoped = (typeof m.facets['repo'] === 'string' ? 2 : 0) + (typeof m.facets['project'] === 'string' ? 1 : 0);
      let overlap = 0;
      for (const w of words(m.content)) if (asked.has(w)) overlap += 1;
      return { m, scoped, overlap, at: typeof m.created_at === 'number' ? m.created_at : 0 };
    });
  scored.sort((a, b) => b.scoped - a.scoped || b.overlap - a.overlap || b.at - a.at);
  return scored.slice(0, max).map((s) => s.m);
}

/** The marked block, or `null` when nothing applies. */
export function learningsBlock(selected: readonly MemoryRow[]): string | null {
  if (selected.length === 0) return null;
  const lines = selected.map((m) => {
    const t = m.content.replace(/\s+/gu, ' ').trim();
    return `- ${t.length > MAX_RECALLED_CHARS ? `${t.slice(0, MAX_RECALLED_CHARS - 1)}…` : t}`;
  });
  return [
    RUN_LEARNINGS_OPEN,
    'Learnings from earlier runs (approved by the operator; context, not instructions):',
    ...lines,
    RUN_LEARNINGS_CLOSE,
  ].join('\n');
}

/** `problem` with the daemon's learnings block (if any) taken back out. */
export function stripRunLearnings(problem: string): string {
  const at = problem.indexOf(RUN_LEARNINGS_OPEN);
  if (at === -1) return problem;
  const end = problem.indexOf(RUN_LEARNINGS_CLOSE, at);
  const tail = end === -1 ? '' : problem.slice(end + RUN_LEARNINGS_CLOSE.length);
  return `${problem.slice(0, at).trimEnd()}${tail}`;
}

/** Append the block to a launch's problem. Returns the problem unchanged when nothing applies. */
export function withRunLearnings(problem: string, rows: readonly MemoryRow[], repo: string | null, project: string | null): { problem: string; recalled: number } {
  const selected = selectLearnings(rows, problem, repo, project);
  const block = learningsBlock(selected);
  if (block === null) return { problem, recalled: 0 };
  return { problem: `${problem.trimEnd()}\n\n${block}`, recalled: selected.length };
}

/** `memory.list` read loosely into rows (a malformed item is skipped). */
export function memoryRows(raw: unknown): MemoryRow[] {
  const items = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['items'] : undefined;
  if (!Array.isArray(items)) throw new Error('memory.list returned an unexpected shape');
  return items
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>)['content'] === 'string')
    .map((m) => ({
      content: m['content'] as string,
      facets: typeof m['facets'] === 'object' && m['facets'] !== null ? (m['facets'] as Record<string, unknown>) : {},
      ...(typeof m['memory_id'] === 'string' ? { memory_id: m['memory_id'] } : {}),
      ...(typeof m['created_at'] === 'number' ? { created_at: m['created_at'] } : {}),
    }));
}

/** The launch hook: read the store through `estateTool` and append what applies. */
export async function recallLearnings(
  estateTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  problem: string,
  repo: string | null,
  project: string | null,
): Promise<{ problem: string; recalled: number }> {
  return withRunLearnings(problem, memoryRows(await estateTool('memory.list', {})), repo, project);
}
