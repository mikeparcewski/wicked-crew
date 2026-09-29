/**
 * The MCP usage fold (DES-MCP-TOOLS-001 §7 Usage, §8 `GET /mcp/usage`; slice S7).
 *
 * A pure function over call records (`calls.ndjson`, written by the broker, S3): counts, the
 * decision split (allow / ask / deny / guard_error), the error rate and nearest-rank p50/p95/p99
 * over the calls that ran, a per-tool table, per-server totals, the tool × seat × run drill-down,
 * the common tool chains and one row per UTC day. Nothing is cached and no poller runs: every
 * `GET /mcp/usage` folds the records as they are on disk.
 */

import type {
  McpCallDecision,
  McpCallRecord,
  McpDecisionCounts,
  McpToolClass,
  McpUsageChain,
  McpUsageDay,
  McpUsageResponse,
  McpUsageRun,
  McpUsageServer,
  McpUsageStats,
  McpUsageTool,
} from '../core/types.js';
import { parseMcpSubject } from './classify.js';

export const MCP_USAGE_MAX_DAYS = 30;
export const MCP_USAGE_DEFAULT_DAYS = 7;
export const MCP_USAGE_DECISIONS: readonly McpCallDecision[] = ['allow', 'ask', 'deny', 'guard_error'];
export const MCP_USAGE_MAX_RUNS = 200;
export const MCP_USAGE_MAX_CHAINS = 20;

const DAY_MS = 86_400_000;

export interface McpUsageQuery {
  days?: number;
  subject?: string;
  seat?: string;
  decision?: McpCallDecision;
}

/** Nearest-rank percentile of ascending `sorted`: the value at position `ceil(q * n)`. */
export function nearestRank(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

function zero(): McpDecisionCounts {
  return { allow: 0, ask: 0, deny: 0, guard_error: 0 };
}

function stats(records: readonly McpCallRecord[]): McpUsageStats {
  const decisions = zero();
  const ms: number[] = [];
  let errors = 0;
  for (const r of records) {
    decisions[r.decision.decision] += 1;
    if (r.decision.decision !== 'allow') continue;
    ms.push(r.ms);
    if (r.status.code === 'error') errors += 1;
  }
  ms.sort((a, b) => a - b);
  return {
    calls: records.length,
    decisions,
    ran: ms.length,
    errors,
    errorRate: ms.length === 0 ? null : errors / ms.length,
    p50Ms: nearestRank(ms, 0.5),
    p95Ms: nearestRank(ms, 0.95),
    p99Ms: nearestRank(ms, 0.99),
  };
}

function groupBy<K>(records: readonly McpCallRecord[], key: (r: McpCallRecord) => K): Map<K, McpCallRecord[]> {
  const out = new Map<K, McpCallRecord[]>();
  for (const r of records) {
    const k = key(r);
    const list = out.get(k);
    if (list === undefined) out.set(k, [r]);
    else list.push(r);
  }
  return out;
}

const byStart = (a: McpCallRecord, b: McpCallRecord): number => a.start.localeCompare(b.start) || a.spanId.localeCompare(b.spanId);
const newest = (records: readonly McpCallRecord[]): McpCallRecord => records.reduce((n, r) => (byStart(r, n) > 0 ? r : n));
const seatOf = (r: McpCallRecord): string | null => r.attrs['wicked.seat'];
const subjectOf = (r: McpCallRecord): string => r.attrs['mcp.subject'];

/** The tool chains of `records`: consecutive calls of one unit attempt, with different subjects. */
export function foldChains(records: readonly McpCallRecord[], subject?: string): McpUsageChain[] {
  const units = groupBy(
    records.filter((r) => r.traceId !== null && r.parentSpanId !== null),
    (r) => `${r.traceId ?? ''}\u0000${r.parentSpanId ?? ''}`,
  );
  const chains = new Map<string, { from: string; to: string; count: number; runs: Set<string> }>();
  for (const calls of units.values()) {
    const ordered = [...calls].sort(byStart);
    for (let i = 1; i < ordered.length; i++) {
      const from = subjectOf(ordered[i - 1] as McpCallRecord);
      const to = subjectOf(ordered[i] as McpCallRecord);
      if (from === to) continue;
      if (subject !== undefined && from !== subject && to !== subject) continue;
      const key = `${from}\u0000${to}`;
      const c = chains.get(key) ?? { from, to, count: 0, runs: new Set<string>() };
      c.count += 1;
      c.runs.add((ordered[i] as McpCallRecord).traceId ?? '');
      chains.set(key, c);
    }
  }
  return [...chains.values()]
    .map((c) => ({ from: c.from, to: c.to, count: c.count, runs: c.runs.size }))
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, MCP_USAGE_MAX_CHAINS);
}

/**
 * Fold `records` into the usage view for the last `days` × 24 h before `now`. `skipped` passes
 * through the count of lines the reader could not parse.
 */
export function foldMcpUsage(records: readonly McpCallRecord[], query: McpUsageQuery, now: number, skipped = 0): McpUsageResponse {
  const days = query.days ?? MCP_USAGE_DEFAULT_DAYS;
  const since = now - days * DAY_MS;
  const inWindow = records.filter((r) => {
    const t = Date.parse(r.start);
    return Number.isFinite(t) && t >= since && t <= now;
  });
  const seats = [...new Set(inWindow.map(seatOf).filter((s): s is string => s !== null))].sort();
  const unitFiltered = inWindow.filter(
    (r) => (query.seat === undefined || seatOf(r) === query.seat) && (query.decision === undefined || r.decision.decision === query.decision),
  );
  const filtered = query.subject === undefined ? unitFiltered : unitFiltered.filter((r) => subjectOf(r) === query.subject);

  const tools: McpUsageTool[] = [...groupBy(filtered, subjectOf)].map(([subject, calls]) => {
    const parts = parseMcpSubject(subject);
    const last = newest(calls);
    const cls: McpToolClass | null = last.attrs['mcp.class'];
    return {
      subject,
      server: parts?.server ?? '',
      tool: parts?.tool ?? '',
      class: cls,
      seats: [...new Set(calls.map(seatOf).filter((s): s is string => s !== null))].sort(),
      lastCall: last.start,
      ...stats(calls),
    };
  });
  tools.sort((a, b) => b.calls - a.calls || a.subject.localeCompare(b.subject));

  const servers: McpUsageServer[] = [...groupBy(filtered, (r) => parseMcpSubject(subjectOf(r))?.server ?? '')].map(([server, calls]) => {
    const s = stats(calls);
    return { server, calls: s.calls, decisions: s.decisions, lastCall: newest(calls).start };
  });
  servers.sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server));

  const runs: McpUsageRun[] = [...groupBy(filtered, (r) => `${subjectOf(r)}\u0000${seatOf(r) ?? ''}\u0000${r.traceId ?? ''}`).values()].map((calls) => {
    const first = calls[0] as McpCallRecord;
    const s = stats(calls);
    return { subject: subjectOf(first), seat: seatOf(first), runId: first.traceId, calls: s.calls, decisions: s.decisions, errors: s.errors, lastCall: newest(calls).start };
  });
  runs.sort((a, b) => b.lastCall.localeCompare(a.lastCall) || a.subject.localeCompare(b.subject));

  const daily: McpUsageDay[] = [];
  const perDay = groupBy(filtered, (r) => r.start.slice(0, 10));
  const firstDay = Date.UTC(new Date(since).getUTCFullYear(), new Date(since).getUTCMonth(), new Date(since).getUTCDate());
  for (let t = firstDay; t <= now; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const s = stats(perDay.get(day) ?? []);
    daily.push({ day, calls: s.calls, decisions: s.decisions });
  }

  return {
    days,
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    filters: { subject: query.subject ?? null, seat: query.seat ?? null, decision: query.decision ?? null },
    totals: stats(filtered),
    tools,
    servers,
    runs: runs.slice(0, MCP_USAGE_MAX_RUNS),
    chains: foldChains(unitFiltered, query.subject),
    daily,
    seats,
    skipped,
  };
}
