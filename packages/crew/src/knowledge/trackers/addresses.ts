/**
 * The issues each run addresses (DES-PM-001 §3.2, §4): the trackers its launch resolved linked issues through, kept
 * with the run so delivery, the governed actions and the projection read the same answer. Written once at launch,
 * from the resolved references only. `<state home>/mcp/tracker-addresses.json` (the fenced `mcp` directory: no
 * worker reads it); written atomically, serialized, bounded to the newest {@link ADDRESSES_RUNS_KEPT} runs.
 *
 * (crew#1352) That file is a bounded cache. The durable record is the run's `run.launched` trail entry, which carries
 * the same addresses (`detail.trackerAddresses`) for the run's lifetime: {@link TrackerAddressesDeps.launched} reads
 * it back, so a run the cache evicted (or whose write failed) still delivers, acts and projects with its addresses.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { mcpStateDir } from '../../mcp/registry-store.js';
import type { PmSystem } from '../registry/entry.js';

export const ADDRESSES_RUNS_KEPT = 5_000;

/** One issue a run addresses: the tracker that admitted it at launch, and the issue's reference there. */
export interface RunAddress {
  trackerId: string;
  source: string;
  system: PmSystem;
  /** `PROJA-1`, `owner/repo#42`. */
  ref: string;
  /** The reference as the intent spelled it (`#42`, `jira@c2:PROJ-1`): what delivery links back for. */
  asked?: string;
  /**
   * Whether the delivered PR closes it: a GitHub reference the intent paired with a closing verb (`Fixes`), or a Jira
   * key (the PR names it in its title, Jira's own link back). A mere mention (`Refs:`) is not.
   */
  closing?: boolean;
}

interface AddressesFile {
  version: 1;
  runs: Array<{ runId: string; at: string; projectId: string | null; repoId: string | null; addresses: RunAddress[] }>;
}

/** A run's addresses as its launch recorded them (the run-timing index's read of `run.launched`). */
export interface LaunchedRunAddresses {
  runId: string;
  /** The launch instant (ms). */
  at: number;
  projectId: string | null;
  repoId: string | null;
  addresses: RunAddress[];
}

export interface TrackerAddressesDeps {
  /** The launch record's read: one run, and every run that recorded addresses. Absent = the cache alone. */
  launched?: { of(runId: string): LaunchedRunAddresses | undefined; all(): LaunchedRunAddresses[] };
}

export class TrackerAddresses {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string = mcpStateDir(),
    private readonly deps: TrackerAddressesDeps = {},
  ) {}

  private get file(): string {
    return join(this.dir, 'tracker-addresses.json');
  }

  private async load(): Promise<AddressesFile> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AddressesFile>;
      const runs = Array.isArray(raw.runs) ? raw.runs.filter((r) => typeof r?.runId === 'string' && Array.isArray(r.addresses)) : [];
      return { version: 1, runs: runs.map((r) => ({ ...r, projectId: typeof r.projectId === 'string' ? r.projectId : null, repoId: typeof r.repoId === 'string' ? r.repoId : null })) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, runs: [] };
      throw err;
    }
  }

  /** Record what `runId` addresses (once, at launch). Nothing to record writes nothing. */
  record(runId: string, addresses: readonly RunAddress[], scope: { projectId: string | null; repoId: string | null }, now: () => number = Date.now): Promise<void> {
    if (addresses.length === 0) return Promise.resolve();
    const next = this.chain.then(async () => {
      const f = await this.load();
      f.runs = [...f.runs.filter((r) => r.runId !== runId), { runId, at: new Date(now()).toISOString(), projectId: scope.projectId, repoId: scope.repoId, addresses: [...addresses] }].slice(-ADDRESSES_RUNS_KEPT);
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(f)}\n`, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** What `runId` addresses: the cache's record, else the launch record's; `[]` when neither has one. */
  async of(runId: string): Promise<RunAddress[]> {
    await this.chain;
    return (await this.load()).runs.find((r) => r.runId === runId)?.addresses ?? this.deps.launched?.of(runId)?.addresses ?? [];
  }

  /**
   * Every recorded run (the projection's `addresses` edges), oldest first: the cache's runs, and every run the launch
   * record holds that the cache does not (evicted, or never written).
   */
  async all(): Promise<Array<{ runId: string; projectId: string | null; repoId: string | null; addresses: RunAddress[] }>> {
    await this.chain;
    const cached = (await this.load()).runs.map((r) => ({ at: Date.parse(r.at), runId: r.runId, projectId: r.projectId, repoId: r.repoId, addresses: r.addresses }));
    const held = new Set(cached.map((r) => r.runId));
    const launched = (this.deps.launched?.all() ?? []).filter((r) => !held.has(r.runId));
    if (launched.length === 0) return cached.map((r) => ({ runId: r.runId, projectId: r.projectId, repoId: r.repoId, addresses: r.addresses }));
    return [...cached.map((r) => ({ ...r, at: Number.isFinite(r.at) ? r.at : 0 })), ...launched]
      .map((r, i) => ({ r, i }))
      .sort((a, b) => a.r.at - b.r.at || a.i - b.i)
      .map(({ r }) => ({ runId: r.runId, projectId: r.projectId, repoId: r.repoId, addresses: r.addresses }));
  }
}
