/**
 * Where default-eval runs are kept: beside the steering evals, under the daemon state home.
 *
 *   <home>/evals/default/runs.jsonl        one {@link DefaultEvalSummary} per line (the list)
 *   <home>/evals/default/results/<id>.json the full report and its cases (the drilldown)
 *
 * Same posture as `api/eval-store.ts`: the detail is written first (tmp + rename), then the index line, so every
 * listed row has a readable detail; a torn line is skipped on read, never the store.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultEvalStoreRoot } from '../api/eval-store.js';
import type { DefaultEvalDetail, DefaultEvalReport, DefaultEvalSummary } from './types.js';
import { summarize } from './runner.js';

/** `<eval store root>/default`: the steering eval store's root (its env override, else the state home's `evals`). */
export function defaultEvalsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultEvalStoreRoot(env), 'default');
}

export type { DefaultEvalDetail };

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export class DefaultEvalStore {
  constructor(private readonly root: string = defaultEvalsRoot()) {}

  async record(detail: DefaultEvalDetail): Promise<DefaultEvalSummary> {
    if (!SAFE_ID.test(detail.report.id)) throw new Error(`default evals: unsafe run id ${detail.report.id}`);
    const results = join(this.root, 'results');
    await mkdir(results, { recursive: true });
    const file = join(results, `${detail.report.id}.json`);
    const tmp = `${file}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(detail));
    await rename(tmp, file);
    const summary = summarize(detail.report);
    await appendFile(join(this.root, 'runs.jsonl'), `${JSON.stringify(summary)}\n`);
    return summary;
  }

  /** Newest first. */
  async list(): Promise<DefaultEvalSummary[]> {
    let text: string;
    try {
      text = await readFile(join(this.root, 'runs.jsonl'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const rows: DefaultEvalSummary[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line) as DefaultEvalSummary;
        if (typeof row.id === 'string' && typeof row.createdAt === 'string') rows.push(row);
      } catch {
        // a torn line degrades one row, never the list
      }
    }
    return rows.reverse();
  }

  async get(id: string): Promise<DefaultEvalDetail | null> {
    if (!SAFE_ID.test(id)) return null;
    try {
      return JSON.parse(await readFile(join(this.root, 'results', `${id}.json`), 'utf8')) as DefaultEvalDetail;
    } catch {
      return null;
    }
  }

  /** The last stored report of the same scope (`null` project = every project). */
  async previous(project: string | null): Promise<DefaultEvalReport | null> {
    for (const row of await this.list()) {
      if (row.project !== project) continue;
      const d = await this.get(row.id);
      if (d !== null) return d.report;
    }
    return null;
  }
}
