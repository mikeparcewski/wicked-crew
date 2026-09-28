/**
 * The MCP tools registry (DES-MCP-TOOLS-001 §5, §8; slice S2): register upstream MCP servers,
 * keep their tool lists honest, and hold their secrets out of every response.
 *
 * - **Preview, then save.** `preview` probes the server and answers its tools with their classes
 *   and a `previewHash` over the exact config and tool schemas it saw. `save` takes ONLY that hash
 *   and registers what the preview showed. A save without a hash, or with one this daemon did not
 *   issue (or issued more than {@link PREVIEW_TTL_MS} ago), is refused, so nothing is registered
 *   that the operator did not see.
 * - **Tool diff.** `test` probes a registered server again and records the difference. A tool
 *   whose schema hash changed, and a tool the server added, is `unregistered` (D-5 denies it)
 *   until it is previewed and saved again. A tool the server dropped is `gone`: kept, never
 *   deleted, so old call records still resolve. Health turns `failing` after 3 consecutive
 *   failed probes.
 * - **Secrets.** Only a reference is stored. A value is resolved just for the probe and scrubbed
 *   from its result (`probe.ts`).
 */

import type {
  McpAuthConfig,
  McpAuthState,
  McpDiscoveredServer,
  McpPreviewResponse,
  McpServer,
  McpServersResponse,
  McpServerTestResponse,
  McpTool,
  McpToolClass,
  McpToolDiff,
  McpToolStatus,
  McpUpstreamKind,
} from '../core/types.js';
import { canonicalJson, deriveToolClass, effectiveToolClass, mcpSubject, parseMcpSubject, sha256Hex, toolSchemaHash } from './classify.js';
import type { McpUpstreamConfig, ProbedTool, ProbeResult, Prober } from './probe.js';
import type { McpRegistryStore, McpServerRecord, McpToolRecord } from './registry-store.js';
import { keychainRef, parseSecretRef, resolveSecret, secretIsSet, type SecretStore } from './secrets.js';

/** How long a preview can be saved. */
export const PREVIEW_TTL_MS = 15 * 60 * 1000;
/** At most this many previews are held; the oldest is dropped first. */
const PREVIEW_CACHE_MAX = 64;
/** Consecutive failed probes before a server's health reads `failing`. */
export const HEALTH_FAILING_AFTER = 3;

/** A refusal the routes map to a status code. */
export class McpRegistryError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 501 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface HeldPreview {
  config: McpUpstreamConfig;
  tools: Array<ProbedTool & { schemaHash: string }>;
  expiresAt: number;
}

export interface McpRegistryDeps {
  store: McpRegistryStore;
  secrets: SecretStore;
  probe: Prober;
  discover: (managed: ReadonlySet<string>) => McpDiscoveredServer[];
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export class McpRegistry {
  private readonly previews = new Map<string, HeldPreview>();
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly deps: McpRegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.env = deps.env ?? process.env;
  }

  get secretStoreAvailable(): boolean {
    return this.deps.secrets.available;
  }

  async list(): Promise<McpServersResponse> {
    const file = await this.deps.store.read();
    const servers = await Promise.all(file.servers.map((s) => this.view(s)));
    const discovered = this.deps.discover(new Set(file.servers.map((s) => s.name)));
    return { servers, discovered };
  }

  async get(name: string): Promise<McpServer> {
    const file = await this.deps.store.read();
    return this.view(this.find(file.servers, name));
  }

  async preview(config: McpUpstreamConfig): Promise<McpPreviewResponse> {
    const result = await this.probe(config);
    if ('missingSecret' in result) throw new McpRegistryError(409, 'secret_missing', result.error);
    if (!result.ok) throw new McpRegistryError(502, 'probe_failed', `the server did not answer tools/list: ${result.error}`);
    const tools = result.tools.map((t) => ({ ...t, schemaHash: toolSchemaHash(t) }));
    const previewHash = sha256Hex(canonicalJson({ config, tools: tools.map((t) => [t.name, t.schemaHash]) }));
    const expiresAt = this.now() + PREVIEW_TTL_MS;
    this.hold(previewHash, { config, tools, expiresAt });
    const existing = (await this.deps.store.read()).servers.find((s) => s.name === config.name);
    return {
      previewHash,
      expiresAt: new Date(expiresAt).toISOString(),
      server: configView(config),
      serverInfo: result.serverInfo,
      tools: tools.map((t) => ({
        name: t.name,
        subject: mcpSubject(config.name, t.name),
        description: t.description,
        annotations: t.annotations,
        inputSchema: t.inputSchema,
        class: deriveToolClass(t.annotations),
        schemaHash: t.schemaHash,
      })),
      diff: existing === undefined ? null : diffTools(existing.tools, tools),
    };
  }

  /**
   * Register exactly what a preview showed. Saving over an existing name re-registers it: every
   * tool of the preview becomes `registered`, a tool it no longer lists becomes `gone`, a tool's
   * `enabled` switch survives, and a class override survives only while the schema is unchanged.
   */
  async save(previewHash: string | undefined): Promise<McpServer> {
    if (previewHash === undefined) {
      throw new McpRegistryError(409, 'preview_required', 'saving a server needs the previewHash of a preview of it: POST /mcp/servers/preview first');
    }
    const held = this.previews.get(previewHash);
    if (held === undefined || held.expiresAt <= this.now()) {
      this.previews.delete(previewHash);
      throw new McpRegistryError(409, 'preview_stale', 'that previewHash is unknown or expired: preview the server again, then save');
    }
    this.previews.delete(previewHash);
    const stamp = new Date(this.now()).toISOString();
    const saved = await this.deps.store.mutate((file) => {
      const prior = file.servers.find((s) => s.name === held.config.name);
      const tools: McpToolRecord[] = held.tools.map((t) => {
        const was = prior?.tools.find((p) => p.name === t.name);
        return {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          annotations: t.annotations,
          classOverride: was !== undefined && was.schemaHash === t.schemaHash ? was.classOverride : null,
          enabled: was?.enabled ?? true,
          schemaHash: t.schemaHash,
          observedSchemaHash: t.schemaHash,
          present: true,
        };
      });
      for (const old of prior?.tools ?? []) {
        if (!tools.some((t) => t.name === old.name)) tools.push({ ...old, present: false });
      }
      const record: McpServerRecord = {
        ...held.config,
        enabled: prior?.enabled ?? true,
        health: { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null },
        registeredAt: prior?.registeredAt ?? stamp,
        updatedAt: stamp,
        tools,
      };
      file.servers = [...file.servers.filter((s) => s.name !== record.name), record];
      return record;
    });
    return this.view(saved);
  }

  async setServerEnabled(name: string, enabled: boolean): Promise<McpServer> {
    const rec = await this.deps.store.mutate((file) => {
      const s = this.find(file.servers, name);
      s.enabled = enabled;
      s.updatedAt = new Date(this.now()).toISOString();
      return s;
    });
    return this.view(rec);
  }

  /** Remove a server, and the keychain secret it owns (`keychain:wicked-mcp/<name>`). */
  async remove(name: string): Promise<void> {
    const removed = await this.deps.store.mutate((file) => {
      const s = this.find(file.servers, name);
      file.servers = file.servers.filter((x) => x.name !== name);
      return s;
    });
    if (removed.auth?.ref === keychainRef(name) && this.deps.secrets.available) await this.deps.secrets.delete(name);
  }

  async patchTool(subject: string, patch: { enabled?: boolean | undefined; classOverride?: McpToolClass | null | undefined }): Promise<McpTool> {
    const parts = parseMcpSubject(subject);
    if (parts === null) throw new McpRegistryError(404, 'unknown_tool', `no tool ${subject}`);
    const stamp = new Date(this.now()).toISOString();
    const { server, tool } = await this.deps.store.mutate((file) => {
      const s = this.find(file.servers, parts.server);
      const t = s.tools.find((x) => x.name === parts.tool);
      if (t === undefined) throw new McpRegistryError(404, 'unknown_tool', `no tool ${subject}`);
      if (patch.enabled !== undefined) t.enabled = patch.enabled;
      if (patch.classOverride !== undefined) t.classOverride = patch.classOverride;
      s.updatedAt = stamp;
      return { server: s, tool: t };
    });
    return toolView(server.name, tool);
  }

  /** Probe a registered server again: record its health and its tool diff. */
  async test(name: string): Promise<McpServerTestResponse> {
    const current = this.find((await this.deps.store.read()).servers, name);
    const config = configOf(current);
    const result = await this.probe(config);
    const stamp = new Date(this.now()).toISOString();
    let diff: McpToolDiff | null = null;
    const rec = await this.deps.store.mutate((file) => {
      const s = this.find(file.servers, name);
      // A save with a different config landed while the probe ran: the result describes a server
      // that is no longer registered, so it is not applied to the new one.
      if (canonicalJson(configOf(s)) !== canonicalJson(config)) {
        throw new McpRegistryError(409, 'server_changed', `${name} was saved again while it was being tested; test it again`);
      }
      if (!result.ok) {
        const failures = s.health.consecutiveFailures + 1;
        const state = failures >= HEALTH_FAILING_AFTER ? 'failing' : s.health.state;
        s.health = { state, consecutiveFailures: failures, checkedAt: stamp, lastError: result.error };
        return s;
      }
      const probed = result.tools.map((t) => ({ ...t, schemaHash: toolSchemaHash(t) }));
      diff = diffTools(s.tools, probed);
      for (const t of s.tools) {
        const now = probed.find((p) => p.name === t.name);
        t.present = now !== undefined;
        if (now !== undefined) t.observedSchemaHash = now.schemaHash;
      }
      for (const p of probed) {
        if (s.tools.some((t) => t.name === p.name)) continue;
        s.tools.push({
          name: p.name,
          description: p.description,
          inputSchema: p.inputSchema,
          outputSchema: p.outputSchema,
          annotations: p.annotations,
          classOverride: null,
          enabled: true,
          schemaHash: null,
          observedSchemaHash: p.schemaHash,
          present: true,
        });
      }
      s.health = { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null };
      return s;
    });
    return { ok: result.ok, error: result.ok ? null : result.error, diff, server: await this.view(rec) };
  }

  /** Write a server's secret to the OS store; answers the reference to put in its `auth.ref`. */
  async setSecret(name: string, value: string): Promise<string> {
    if (!this.deps.secrets.available) {
      throw new McpRegistryError(501, 'secret_store_unavailable', 'this platform has no OS secret store; reference a daemon env variable instead (auth.ref "env:<NAME>")');
    }
    const ref = keychainRef(name);
    // The route answers and audits the reference, so a value it contains would be echoed there.
    if (ref.includes(value)) throw new McpRegistryError(400, 'secret_in_ref', 'the secret must not appear in its own reference; choose a different value');
    await this.deps.secrets.set(name, value);
    return ref;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────

  private find(servers: McpServerRecord[], name: string): McpServerRecord {
    const s = servers.find((x) => x.name === name);
    if (s === undefined) throw new McpRegistryError(404, 'unknown_server', `no MCP server named ${name}`);
    return s;
  }

  private hold(hash: string, preview: HeldPreview): void {
    const now = this.now();
    for (const [k, v] of this.previews) if (v.expiresAt <= now) this.previews.delete(k);
    this.previews.delete(hash);
    this.previews.set(hash, preview);
    while (this.previews.size > PREVIEW_CACHE_MAX) this.previews.delete(this.previews.keys().next().value as string);
  }

  /**
   * Probe with the server's secret. A server whose `auth` names a secret that resolves to nothing
   * is NOT probed unauthenticated (that would register what an anonymous caller sees): it fails
   * without connecting.
   */
  private async probe(config: McpUpstreamConfig): Promise<ProbeResult | { ok: false; error: string; missingSecret: true }> {
    if (config.auth === null) return this.deps.probe(config, null);
    const secret = await resolveSecret(config.auth.ref, this.deps.secrets, this.env);
    if (secret === null) {
      return { ok: false, error: `auth.ref ${config.auth.ref} resolves to no secret: set it, then try again`, missingSecret: true };
    }
    return this.deps.probe(config, secret);
  }

  private async authState(auth: McpAuthConfig | null): Promise<McpAuthState> {
    if (auth === null) return 'none';
    if (parseSecretRef(auth.ref) === null) return 'missing';
    return (await secretIsSet(auth.ref, this.deps.secrets, this.env)) ? 'set' : 'missing';
  }

  private async view(s: McpServerRecord): Promise<McpServer> {
    const tools = s.tools.map((t) => toolView(s.name, t));
    const live = tools.filter((t) => t.status !== 'gone');
    return {
      ...configView(configOf(s)),
      authState: await this.authState(s.auth),
      enabled: s.enabled,
      health: s.health,
      registeredAt: s.registeredAt,
      updatedAt: s.updatedAt,
      tools,
      counts: {
        total: live.length,
        enabled: live.filter((t) => t.enabled).length,
        registered: live.filter((t) => t.status === 'registered').length,
        read: live.filter((t) => t.class === 'read').length,
        write: live.filter((t) => t.class === 'write').length,
        destructive: live.filter((t) => t.class === 'destructive').length,
      },
    };
  }
}

function configOf(s: McpServerRecord): McpUpstreamConfig {
  return { name: s.name, kind: s.kind, command: s.command, args: s.args, url: s.url, auth: s.auth };
}

function configView(c: McpUpstreamConfig): { name: string; kind: McpUpstreamKind; command: string | null; args: string[]; url: string | null; auth: McpAuthConfig | null } {
  return { name: c.name, kind: c.kind, command: c.command, args: c.args, url: c.url, auth: c.auth };
}

export function toolStatus(t: Pick<McpToolRecord, 'present' | 'schemaHash' | 'observedSchemaHash'>): McpToolStatus {
  if (!t.present) return 'gone';
  return t.schemaHash !== null && t.schemaHash === t.observedSchemaHash ? 'registered' : 'unregistered';
}

function toolView(server: string, t: McpToolRecord): McpTool {
  const derivedClass = deriveToolClass(t.annotations);
  return {
    name: t.name,
    subject: mcpSubject(server, t.name),
    description: t.description,
    annotations: t.annotations,
    inputSchema: t.inputSchema,
    derivedClass,
    classOverride: t.classOverride,
    class: effectiveToolClass(derivedClass, t.classOverride),
    enabled: t.enabled,
    status: toolStatus(t),
    schemaHash: t.schemaHash,
    observedSchemaHash: t.observedSchemaHash,
  };
}

/** The difference between the registered tools and a probe's (by name, then schema hash). */
export function diffTools(registered: ReadonlyArray<Pick<McpToolRecord, 'name' | 'schemaHash' | 'present'>>, probed: ReadonlyArray<{ name: string; schemaHash: string }>): McpToolDiff {
  const known = registered.filter((t) => t.present);
  const diff: McpToolDiff = { added: [], removed: [], changed: [], unchanged: [] };
  for (const p of probed) {
    const was = known.find((t) => t.name === p.name);
    // A tool that was never registered (added after the last save) is still `added`.
    if (was === undefined || was.schemaHash === null) diff.added.push(p.name);
    else if (was.schemaHash === p.schemaHash) diff.unchanged.push(p.name);
    else diff.changed.push(p.name);
  }
  for (const t of known) if (!probed.some((p) => p.name === t.name)) diff.removed.push(t.name);
  return diff;
}
