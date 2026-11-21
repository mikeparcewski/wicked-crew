import { createHash } from 'node:crypto';
import type { ConformanceRule } from '../core/types.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function ruleRevision(rule: ConformanceRule): string {
  const stored = { ...rule } as ConformanceRule & { revision?: string };
  delete stored.revision;
  return createHash('sha256').update(JSON.stringify(canonical(stored))).digest('hex').slice(0, 16);
}

export class RuleChangedError extends Error {
  constructor(readonly revision: string | null) {
    super('Rule changed since it was read — read the rule again before writing.');
  }
}
