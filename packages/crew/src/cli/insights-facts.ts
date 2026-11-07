/**
 * `wicked-crew insights-facts` (DES-CATALOG-002 CS6): the `facts` Tool step of a `run-cost` run.
 *
 * The engine runs it with the unit's capability token (`WICKED_MCP_TOKEN`) and this daemon's URL (`WICKED_CREW_URL`).
 * It asks crew for the cost facts (`POST /insights/facts`) and prints them ({@link renderCostFacts}): that text is the
 * step's output, the record the model step cites and the check step re-checks. It writes no file.
 * Exit 0: printed. Exit 1: refused (the reason is printed). Exit 2: could not ask.
 */

import { renderCostFacts, type CostFacts } from '../insights/cost.js';

/** How long the facts may take (the preparer reads every run of the window's events). */
const FACTS_TIMEOUT_MS = 120_000;

export interface InsightsFactsIo {
  env: NodeJS.ProcessEnv;
  /** Writes text as given (the facts block ends in a newline). */
  out: (text: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
}

const isFacts = (v: unknown): v is CostFacts => {
  const f = v as Partial<CostFacts> | null;
  return f !== null && typeof f === 'object' && f.version === 1 && Array.isArray(f.groups) && Array.isArray(f.rows) && Array.isArray(f.rules);
};

export async function runInsightsFacts(io: InsightsFactsIo): Promise<number> {
  const token = io.env['WICKED_MCP_TOKEN'] ?? '';
  const url = (io.env['WICKED_CREW_URL'] ?? '').replace(/\/+$/, '');
  if (token === '' || url === '') {
    io.err('insights_facts: no unit token or daemon URL (WICKED_MCP_TOKEN, WICKED_CREW_URL): this runs only as a run-cost facts step; nothing was read');
    return 2;
  }
  let res: Response;
  try {
    res = await (io.fetch ?? fetch)(`${url}/api/v1/insights/facts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
  } catch (e) {
    io.err(`insights_facts: crew did not answer (${e instanceof Error ? e.message : String(e)}); nothing was read`);
    return 2;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    io.err(`insights_facts: crew answered ${res.status} with no JSON; nothing was read`);
    return 2;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { code?: string; error?: string };
    io.err(`insights_facts: refused: ${b.code ?? res.status}: ${String(b.error ?? '').slice(0, 600)}`);
    return 1;
  }
  if (!isFacts(body)) {
    io.err('insights_facts: crew answered without version-1 cost facts (an older crew); nothing was read');
    return 2;
  }
  io.out(renderCostFacts(body));
  return 0;
}
