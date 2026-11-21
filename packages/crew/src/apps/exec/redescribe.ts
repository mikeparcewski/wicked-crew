/**
 * Active apps keep reading against a fresh catalog, even when nobody opens the source sheet.
 * The executor already recomputes contracts on every read; refreshing the description lets that
 * check see a changed column. Descriptions never change the version's accepted lock.
 */
import type { AppSpec } from '../../core/types.js';
import type { McpRegistry } from '../../mcp/registry.js';
import { scrubSecrets } from '../../mcp/secrets.js';
import { STATEMENT_DEADLINE_MS } from '../../sources/drivers/types.js';
import { describeSource, sourceDescriptorHash } from '../../sources/kinds.js';

/** Shared with the published server: used sources are described every ten minutes. */
export const REDESCRIBE_MS = 10 * 60_000;

interface RedescriptionDeps {
  store: () => { list(): Array<{ slug: string }>; detail(slug: string): Promise<{ spec: AppSpec }> } | null;
  registry: Pick<McpRegistry, 'snapshot' | 'callSecret' | 'saveDescription'>;
  describe?: typeof describeSource;
  log: (message: string) => void;
}

export class AppsRedescriber {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: RedescriptionDeps) {}

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => { void this.refresh(); }, REDESCRIBE_MS);
    this.timer.unref();
  }

  /** A slow pass owns the next tick too, so scheduled passes never overlap. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.running ??= this.describeUsed().catch(() => {
      this.deps.log('[apps] used sources could not be read for re-describe');
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  private async describeUsed(): Promise<void> {
    const store = this.deps.store();
    if (store === null) return;
    const names = new Set<string>();
    for (const app of store.list()) {
      try {
        const { spec } = await store.detail(app.slug);
        for (const q of spec.queries) if (q.kind === 'sql' || q.kind === 'graphql') names.add(q.source);
        for (const a of spec.actions) names.add(a.source);
      } catch {
        this.deps.log(`[apps] ${app.slug}'s head could not be read for re-describe`);
      }
    }
    for (const name of names) {
      if (this.stopped) break;
      let timer: NodeJS.Timeout | undefined;
      try {
        const source = await this.deps.registry.snapshot(name);
        if (source === null || !source.enabled || (source.config.kind !== 'sql' && source.config.kind !== 'graphql')) continue;
        // An upload's snapshot is content-addressed: its description never changes, so there is nothing to refresh.
        if (source.config.sql?.driver === 'sqlite') continue;
        // Hold the descriptor from before the network call: a save during describe must win.
        const hash = sourceDescriptorHash(source.config);
        const { secret, missing } = await this.deps.registry.callSecret(source.config);
        if (missing) throw new Error('the source secret is missing');
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('the describe deadline passed')), STATEMENT_DEADLINE_MS);
        });
        const described = await Promise.race([(this.deps.describe ?? describeSource)(source.config, secret), deadline]);
        // Stored as the source routes store a description: with the source's secret scrubbed out of it.
        if (!this.stopped) await this.deps.registry.saveDescription(name, scrubSecrets(described, secret === null ? [] : [secret]), hash);
      } catch {
        // The source's own words may contain data or credentials. One named failure per pass is enough.
        this.deps.log(`[apps] ${name} could not be re-described`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
