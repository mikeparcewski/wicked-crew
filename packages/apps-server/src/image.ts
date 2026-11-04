/**
 * The image's own app store and connector registry: what crew's executor and write path ask, answered for
 * the ONE published (app, tree) and the sources the publish shipped.
 *
 * - {@link ImageFiles}: only the published tree is accepted (its receipt is `published`); any other
 *   version, commit or app is refused.
 * - {@link ImageRegistry}: each source's config exactly as crew's registry held it (so the descriptor hash,
 *   which includes the secret REFERENCE, still equals the lock's), a description taken live by this server
 *   (crew's describe, at startup, every 10 minutes and after an error), the tool records a REST or MCP
 *   server had at publish, and each secret read from the environment name the manifest lists for it.
 */

import { type Actor, AppExecError, type AppFiles, type AppFilesSource, type AppReceipt, type AppSourceRegistry, type ImageSource, McpRegistryError, type McpToolRecord, type McpUpstreamConfig, type StoredDescription, sourceDescriptorHash } from './crew.js';
import type { Site } from './site.js';

const PUBLISHER: Actor = Object.freeze({ id: 'wicked-apps-publish', kind: 'human', trust: 'operator' }) as Actor;

export class ImageFiles implements AppFilesSource {
  private readonly receipt: AppReceipt;

  constructor(private readonly site: Site) {
    const { app } = site.manifest;
    this.receipt = Object.freeze({ kind: 'published', tree: app.tree, version: app.version, at: 0, actor: PUBLISHER }) as AppReceipt;
  }

  private matches(slug: string, version: number | string): boolean {
    const { app } = this.site.manifest;
    if (slug !== app.slug) return false;
    if (typeof version === 'number') return version === app.version;
    const v = version.toLowerCase();
    return v === app.commit.toLowerCase() || v === app.tree.toLowerCase();
  }

  async acceptedFiles(slug: string, version: number | string): Promise<{ files: AppFiles; tree: string; commit: string; version: number | null; receipt: AppReceipt }> {
    if (!this.matches(slug, version)) throw new AppExecError(409, 'not_accepted', `this site serves ${this.site.manifest.app.slug} v${this.site.manifest.app.version} only`);
    const { app } = this.site.manifest;
    return { files: structuredClone(this.site.files), tree: app.tree, commit: app.commit, version: app.version, receipt: this.receipt };
  }

  acceptedReceipt(slug: string, tree: string): AppReceipt | null {
    return slug === this.site.manifest.app.slug && tree === this.site.manifest.app.tree ? this.receipt : null;
  }
}

/** Why a source cannot be used right now (its last describe failed), for the routes' words. */
export interface SourceDown {
  reason: string;
  at: number;
}

export class ImageRegistry implements AppSourceRegistry {
  private readonly descriptions = new Map<string, StoredDescription>();
  /** A REST or MCP server's tools as THIS server last probed them: name → the schema hash the server shows now. */
  private readonly observed = new Map<string, Map<string, string>>();
  /**
   * Per source, the generation of the newest describe STARTED. A describe commits only if it is still the newest:
   * an older probe that answers late never overwrites what a newer one saw (a refusal, or a recovery).
   */
  private readonly generation = new Map<string, number>();
  private readonly down = new Map<string, SourceDown>();
  private readonly envOf = new Map<string, string | null>();

  constructor(
    private readonly sources: Record<string, ImageSource>,
    manifestSources: ReadonlyArray<{ name: string; env: string | null }>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const s of manifestSources) this.envOf.set(s.name, s.env);
  }

  private find(name: string): ImageSource | null {
    return Object.hasOwn(this.sources, name) ? this.sources[name]! : null;
  }

  names(): string[] {
    return Object.keys(this.sources);
  }

  config(name: string): McpUpstreamConfig | null {
    return this.find(name)?.config ?? null;
  }

  /** Start describing `name`: the generation its result must still hold to be committed. */
  beginDescribe(name: string): number {
    const g = (this.generation.get(name) ?? 0) + 1;
    this.generation.set(name, g);
    return g;
  }

  private newest(name: string, g: number | undefined): boolean {
    return g === undefined || this.generation.get(name) === g;
  }

  /** A fresh description of `name`, taken by this server under its current descriptor. */
  setDescription(name: string, description: Omit<StoredDescription, 'descriptorHash'>, g?: number): void {
    const s = this.find(name);
    if (s === null || !this.newest(name, g)) return;
    this.descriptions.set(name, { ...description, descriptorHash: sourceDescriptorHash(s.config) });
    this.down.delete(name);
  }

  /** A REST or MCP server probed live: each tool it shows now, with the schema hash it hashes to. */
  setObserved(name: string, tools: Map<string, string>, g?: number): void {
    if (this.find(name) === null || !this.newest(name, g)) return;
    this.observed.set(name, tools);
    this.down.delete(name);
  }

  /** The describe failed: the source's queries answer "unavailable" until the next one succeeds. */
  setDown(name: string, reason: string, at: number, g?: number): void {
    if (!this.newest(name, g)) return;
    this.descriptions.delete(name);
    this.observed.delete(name);
    this.down.set(name, { reason, at });
  }

  downOf(name: string): SourceDown | null {
    return this.down.get(name) ?? null;
  }

  async snapshot(name: string): Promise<{ config: McpUpstreamConfig; enabled: boolean } | null> {
    const s = this.find(name);
    return s === null ? null : { config: structuredClone(s.config), enabled: true };
  }

  async source(name: string): Promise<{ config: McpUpstreamConfig; allowWrites: boolean; description: StoredDescription | null; descriptorHash: string; enabled: boolean }> {
    const s = this.find(name);
    if (s === null) throw new McpRegistryError(404, 'unknown_server', `no source ${name} in this image`);
    if (s.config.kind !== 'sql' && s.config.kind !== 'graphql') throw new McpRegistryError(400, 'not_a_source', `${name} is an ${s.config.kind} server, not a data source`);
    const description = this.descriptions.get(name) ?? null;
    return { config: structuredClone(s.config), allowWrites: s.allowWrites === true, description: description === null ? null : structuredClone(description), descriptorHash: sourceDescriptorHash(s.config), enabled: true };
  }

  async appTool(server: string, tool: string): Promise<{ config: McpUpstreamConfig; tool: McpToolRecord; bound: boolean } | null> {
    const s = this.find(server);
    if (s === null || (s.config.kind !== 'rest' && s.config.kind !== 'mcp-http')) return null;
    const t = s.tools.find((x) => x.name === tool);
    if (t === undefined) return null;
    // Bound only while the server, probed by this site, still shows the schema the publish saved (S14): a changed
    // or removed operation is a changed contract, like a changed column.
    const seen = this.observed.get(server)?.get(tool);
    return { config: structuredClone(s.config), tool: structuredClone(t), bound: seen !== undefined && t.schemaHash !== null && seen === t.schemaHash };
  }

  /**
   * The secret a call is made with, read from the environment NOW (never cached). `missing` = the source
   * names a secret and its environment variable is unset or empty: the call is not made without it.
   */
  async callSecret(config: McpUpstreamConfig): Promise<{ secret: string | null; missing: boolean }> {
    if (config.auth === null) return { secret: null, missing: false };
    const name = this.envOf.get(config.name) ?? null;
    const value = name === null ? undefined : this.env[name];
    if (value === undefined || value === '') return { secret: null, missing: true };
    return { secret: value, missing: false };
  }
}
