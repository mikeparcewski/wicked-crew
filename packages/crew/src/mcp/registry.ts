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
  McpRestMapping,
  McpServer,
  McpServersResponse,
  McpServerTestResponse,
  McpTool,
  McpToolAnnotations,
  McpToolClass,
  McpToolDiff,
  McpToolStatus,
  McpUpstreamKind,
} from '../core/types.js';
import { canonicalJson, deriveToolClass, effectiveToolClass, mcpSubject, parseMcpSubject, sha256Hex, toolSchemaHash } from './classify.js';
import type { McpUpstreamConfig, ProbedTool, ProbeResult, Prober } from './probe.js';
import type { McpRegistryStore, McpServerRecord, McpToolRecord } from './registry-store.js';
import { KEYCHAIN_SERVICE, keychainRef, parseSecretRef, resolveSecret, secretIsSet, type SecretStore } from './secrets.js';

/** How long a preview can be saved. */
export const PREVIEW_TTL_MS = 15 * 60 * 1000;
/** At most this many previews are held; the oldest is dropped first. */
const PREVIEW_CACHE_MAX = 64;
/** Consecutive failed probes before a server's health reads `failing`. */
export const HEALTH_FAILING_AFTER = 3;

/** A refusal the routes map to a status code. */
export class McpRegistryError extends Error {
  constructor(
    // 500: the registry and the OS secret store disagree and crew could not reconcile them
    // (crew#719, `secret_orphaned`) — the message names what was left behind.
    readonly status: 400 | 404 | 409 | 500 | 501 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What the registry holds for one brokered call's subject. */
export interface McpCallTarget {
  config: McpUpstreamConfig;
  /** A `rest` tool's request mapping (slice S5a); `null` for an MCP server's tool. */
  rest: McpRestMapping | null;
  annotations: McpToolAnnotations | null;
  classOverride: McpToolClass | null;
  registered: boolean;
}

/** A registered, enabled tool, as the tool list judges it (`callableTools`). */
export interface McpCallableTool {
  server: string;
  tool: string;
  kind: McpUpstreamKind;
  annotations: McpToolAnnotations | null;
  classOverride: McpToolClass | null;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
}

interface HeldPreview {
  config: McpUpstreamConfig;
  tools: Array<ProbedTool & { schemaHash: string }>;
  expiresAt: number;
  /**
   * (crew#719) The secret this preview was PROBED with, held in memory for the preview's TTL and
   * committed to the OS store by `save`, beside the registry row. `null` = the caller staged none
   * (an unauthenticated server, an `env:` reference, or a re-save of a secret already stored).
   *
   * It is never written to the registry file, answered by a route, logged or audited — the same
   * rule as every other secret value in this module. A preview that expires takes it with it.
   */
  secret: string | null;
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

  /**
   * Probe `config` and hold exactly what it showed, for `save` (crew#719: with `stagedSecret`, the
   * secret this server's own keychain reference will hold — probed with now, written only when the
   * save commits, so the OS store and the registry row land together or not at all).
   */
  async preview(config: McpUpstreamConfig, stagedSecret: string | null = null): Promise<McpPreviewResponse> {
    if (stagedSecret !== null) {
      if (!this.deps.secrets.available) {
        throw new McpRegistryError(501, 'secret_store_unavailable', 'this platform has no OS secret store; reference a daemon env variable instead (auth.ref "env:<NAME>")');
      }
      if (config.auth === null || config.auth.ref !== keychainRef(config.name)) {
        throw new McpRegistryError(400, 'secret_not_staged_here', `a staged secret is stored as this server's own keychain entry, so auth.ref must be ${keychainRef(config.name)}`);
      }
      // The reference is answered back and audited, so a value it contains would be echoed there.
      if (config.auth.ref.includes(stagedSecret)) {
        throw new McpRegistryError(400, 'secret_in_ref', 'the secret must not appear in its own reference; choose a different value');
      }
    }
    const result = await this.probe(config, stagedSecret);
    if ('missingSecret' in result) throw new McpRegistryError(409, 'secret_missing', result.error);
    if (!result.ok) {
      const what = config.kind === 'rest' ? 'the OpenAPI document could not be imported' : 'the server did not answer tools/list';
      throw new McpRegistryError(502, 'probe_failed', `${what}: ${result.error}`);
    }
    const tools = result.tools.map((t) => ({ ...t, schemaHash: toolSchemaHash(t) }));
    const previewHash = sha256Hex(canonicalJson({ config, tools: tools.map((t) => [t.name, t.schemaHash]) }));
    const expiresAt = this.now() + PREVIEW_TTL_MS;
    this.hold(previewHash, { config, tools, expiresAt, secret: stagedSecret });
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
        ...(config.kind === 'rest' ? { rest: t.rest ?? null } : {}),
      })),
      diff: existing === undefined ? null : diffTools(existing.tools, tools),
      ...(result.skipped !== undefined && result.skipped.length > 0 ? { skipped: result.skipped } : {}),
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
    // (crew#719) The staged secret and the registry row commit TOGETHER. Studio used to write the
    // keychain itself and then save, so a failure between the two left a keychain entry with no
    // server — invisible, because nothing can enumerate the entries of a keychain service — or a
    // server whose secret never landed. The write happens here, inside the save, and a save that
    // then fails puts the entry back exactly as it was; the only residue left is one this call
    // NAMES.
    //
    // The PRIOR value is read first (review of PR #724, HIGH). A re-key of a registered server
    // whose registry write then failed used to leave the NEW secret behind under an unchanged row:
    // the credential its running calls use had silently changed, which is a worse outcome than the
    // orphan this was written to prevent. `null` = no prior value, and then the rollback deletes.
    const prior = held.secret === null ? null : await this.deps.secrets.get(held.config.name);
    if (held.secret !== null) await this.deps.secrets.set(held.config.name, held.secret);
    const saved = await this.restoreSecretOnFailure(held.config.name, held.secret !== null, prior, () => this.deps.store.mutate((file) => {
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
          ...(t.rest != null ? { rest: t.rest } : {}),
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
    }));
    return this.view(saved);
  }

  /**
   * Run `commit`; if it throws and this save had written the OS secret store, put the entry back
   * exactly as it was — deleted when there was no `prior` value, restored to `prior` when there
   * was (crew#719, review of PR #724). Either way the registry row and the credential it
   * references end up as they were before the save.
   *
   * A rollback that ALSO fails is reported rather than swallowed: the operator is told what was
   * left behind and under which account, because nothing else can find a keychain entry for them.
   */
  private async restoreSecretOnFailure<T>(name: string, wrote: boolean, prior: string | null, commit: () => Promise<T>): Promise<T> {
    try {
      return await commit();
    } catch (err) {
      if (!wrote) throw err;
      try {
        if (prior === null) await this.deps.secrets.delete(name);
        else await this.deps.secrets.set(name, prior);
      } catch (rollback) {
        const why = err instanceof Error ? err.message : String(err);
        const also = rollback instanceof Error ? rollback.message : String(rollback);
        const left = prior === null
          ? 'its secret could not be taken back out'
          : 'the secret it replaced could not be put back, so the entry now holds the value this save staged';
        throw new McpRegistryError(
          500,
          'secret_orphaned',
          `${name} was not registered (${why}) and ${left} (${also}); fix the "${KEYCHAIN_SERVICE}" keychain entry for account "${name}" by hand`,
        );
      }
      throw err;
    }
  }

  /** What a held preview would register: its server name and each tool's schema hash (S6). */
  peekPreview(previewHash: string): { name: string; tools: Array<{ name: string; schemaHash: string }> } | null {
    const held = this.previews.get(previewHash);
    if (held === undefined || held.expiresAt <= this.now()) return null;
    return { name: held.config.name, tools: held.tools.map((t) => ({ name: t.name, schemaHash: t.schemaHash })) };
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
    if (removed.auth?.ref === keychainRef(name) && this.deps.secrets.available) {
      try {
        await this.deps.secrets.delete(name);
      } catch (err) {
        // (crew#719) The row is already gone, so the secret is now unreachable by any route. Say
        // so — the alternative is a silent orphan in the operator's keychain.
        const why = err instanceof Error ? err.message : String(err);
        throw new McpRegistryError(500, 'secret_orphaned', `${name} was removed but its secret could not be deleted (${why}); remove the "${KEYCHAIN_SERVICE}" keychain entry for account "${name}" by hand`);
      }
    }
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
        // The mapping a REST call is made with stays the SAVED one: a changed mapping is a changed
        // schema hash, so the tool is unregistered (D-5) until it is previewed and saved again.
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
          ...(p.rest != null ? { rest: p.rest } : {}),
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
    // (crew#719) RE-KEY ONLY. A secret written for a name no registered server references is an
    // orphan nothing can find again — a keychain service's entries cannot be enumerated — and it
    // was the first half of the non-atomic add: secret, then save, with a window between them.
    // A NEW server's secret is staged with its preview and committed by `save`.
    const server = this.find((await this.deps.store.read()).servers, name);
    if (server.auth?.ref !== ref) {
      throw new McpRegistryError(400, 'secret_not_referenced', `${name} does not reference ${ref} (auth.ref is ${server.auth?.ref ?? 'unset'}), so a secret stored there would be unreachable; stage it with the preview instead`);
    }
    await this.deps.secrets.set(name, value);
    return ref;
  }

  /**
   * The broker's resolution of one subject (§6 step 2). `null` = no server of that name. A server
   * that is disabled, a tool that is disabled, `gone`, never saved, or whose schema changed since it
   * was saved reads `registered: false`, which the engine denies (D-5).
   */
  async resolveCall(server: string, tool: string): Promise<McpCallTarget | null> {
    const s = (await this.deps.store.read()).servers.find((x) => x.name === server);
    if (s === undefined) return null;
    const t = s.tools.find((x) => x.name === tool);
    return {
      config: configOf(s),
      rest: t?.rest ?? null,
      annotations: t?.annotations ?? null,
      classOverride: t?.classOverride ?? null,
      registered: s.enabled && t !== undefined && t.enabled && toolStatus(t) === 'registered',
    };
  }

  /**
   * Every tool a call could reach right now (slice S4, the shim's `list`): enabled servers, and
   * their enabled tools whose saved schema is the one last seen. Anything else is D-5 and would be
   * refused by the broker, so it is never offered.
   */
  async callableTools(): Promise<McpCallableTool[]> {
    const out: McpCallableTool[] = [];
    for (const s of (await this.deps.store.read()).servers) {
      if (!s.enabled) continue;
      for (const t of s.tools) {
        if (!t.enabled || toolStatus(t) !== 'registered') continue;
        out.push({
          server: s.name,
          tool: t.name,
          kind: s.kind,
          annotations: t.annotations,
          classOverride: t.classOverride,
          description: t.description,
          inputSchema: t.inputSchema,
        });
      }
    }
    return out;
  }

  /**
   * The secret a call to `config` is made with, resolved at the moment of the call and nowhere
   * else. `missing` = the server names a secret that resolves to nothing: the call is not made
   * unauthenticated.
   */
  async callSecret(config: McpUpstreamConfig): Promise<{ secret: string | null; missing: boolean }> {
    if (config.auth === null) return { secret: null, missing: false };
    const secret = await resolveSecret(config.auth.ref, this.deps.secrets, this.env);
    return { secret, missing: secret === null };
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
  private async probe(config: McpUpstreamConfig, staged: string | null = null): Promise<ProbeResult | { ok: false; error: string; missingSecret: true }> {
    if (config.auth === null) return this.deps.probe(config, null);
    // (crew#719) A staged secret is probed with instead of being written first. The caller has
    // already checked it belongs to THIS server's keychain reference.
    const secret = staged ?? (await resolveSecret(config.auth.ref, this.deps.secrets, this.env));
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
  const base: McpUpstreamConfig = { name: s.name, kind: s.kind, command: s.command, args: s.args, url: s.url, auth: s.auth };
  if (s.kind !== 'rest') return base;
  return { ...base, openapiUrl: s.openapiUrl ?? null, openapi: s.openapi ?? null, operations: s.operations ?? null };
}

interface ConfigView {
  name: string;
  kind: McpUpstreamKind;
  command: string | null;
  args: string[];
  url: string | null;
  auth: McpAuthConfig | null;
  openapiUrl?: string | null;
  operations?: string[] | null;
}

/** What a response shows of a config. A pasted OpenAPI document is not echoed back. */
function configView(c: McpUpstreamConfig): ConfigView {
  const view: ConfigView = { name: c.name, kind: c.kind, command: c.command, args: c.args, url: c.url, auth: c.auth };
  if (c.kind === 'rest') {
    view.openapiUrl = c.openapiUrl ?? null;
    view.operations = c.operations ?? null;
  }
  return view;
}

export function toolStatus(t: Pick<McpToolRecord, 'present' | 'schemaHash' | 'observedSchemaHash'>): McpToolStatus {
  if (!t.present) return 'gone';
  return t.schemaHash !== null && t.schemaHash === t.observedSchemaHash ? 'registered' : 'unregistered';
}

function toolView(server: string, t: McpToolRecord): McpTool {
  const derivedClass = deriveToolClass(t.annotations);
  return {
    name: t.name,
    ...(t.rest != null ? { rest: t.rest } : {}),
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
