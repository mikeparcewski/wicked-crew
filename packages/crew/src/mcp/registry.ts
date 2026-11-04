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
 *
 * (DES-KNOWLEDGE-DATA-001 §5, the ONE registry) Every entry has an immutable `id`. A Postgres source
 * is stored as Toolbox's own source document (`kind: 'toolbox-source'`), and {@link configOf} is the
 * read-path projection that gives every consumer the K1 `kind: 'sql'` config it always read. A K1
 * record is mapped on read, as descriptor version 1, only when the mapping keeps its descriptor hash;
 * a save writes version 2. Each tool carries a reviewed disclosure class. Answers have a full view
 * (human operators) and an agent-safe projection ({@link agentServerView}). Every write keeps the
 * generation it replaces; {@link McpRegistry.restore} brings one back and fails closed.
 */

import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';

import type {
  McpAuthConfig,
  McpAuthState,
  McpDiscoveredServer,
  McpPreviewResponse,
  McpRestEgress,
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
  McpServerAgentView,
  McpRegistryRestoreResponse,
} from '../core/types.js';
import { agentAccessOf, effectiveDisclosure, legacyEntryId, proposedDisclosure, type ToolboxSourceEntry, type ToolDisclosure, type ToolDisclosureClass } from '../knowledge/registry/entry.js';
import { checkSourceDocument, DeploymentPolicyError, policyVersionOf } from '../knowledge/registry/policy.js';
import { canonicalJson, deriveToolClass, effectiveToolClass, ESTATE_SERVER, type HashedRestTarget, type HashedToolShape, mcpSubject, parseMcpSubject, sha256Hex, toolSchemaHash } from './classify.js';
import type { McpUpstreamConfig, ProbedTool, ProbeResult, Prober } from './probe.js';
import { GENERATIONS_KEPT, McpRegistryCorruptError, type McpRegistryFile, type McpRegistryStore, type McpServerRecord, type McpToolRecord } from './registry-store.js';
import { restTarget } from './rest.js';
import { type AddressPolicy, classifyAddress, exactRangesFor, NO_CONFIRMATION } from '../sources/dialer.js';
import { CREW_SOURCE, type SourceDescription, sourceDescriptorHash, sqlFromToolboxEntry, toolboxEntryFromSql } from '../sources/kinds.js';
import { SourceCatalogStore, type StoredDescription } from '../sources/store.js';
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
    readonly status: 400 | 403 | 404 | 409 | 500 | 501 | 502 | 503,
    readonly code: string,
    message: string,
    /** (DES-APPS-001 §5.2) Fuller words that hold a source's own text: answered to a HUMAN only. */
    readonly humanMessage?: string,
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
  /** The tool's saved schema hash (`null`: never registered, or no such tool). */
  schemaHash: string | null;
  /** (DES-KNOWLEDGE-DATA-001 §7.1) The tool's disclosure class in force; `null` = none reviewed (unavailable to agents). */
  disclosure: ToolDisclosureClass | null;
  /** The registry entry's immutable id. */
  id: string;
  registered: boolean;
  /**
   * (G2) The tool is a `rest` tool saved before its hash covered the server's target (or whose
   * target was changed outside a save): refused until the operator previews and saves it again.
   */
  resaveRequired: boolean;
}

/** A registered, enabled tool, as the tool list judges it (`callableTools`). */
export interface McpCallableTool {
  server: string;
  /** The registry entry's immutable id. */
  id: string;
  tool: string;
  kind: McpUpstreamKind;
  /** (DES-KNOWLEDGE-DATA-001 §7.1) The tool's disclosure class in force; `null` = none reviewed. */
  disclosure: ToolDisclosureClass | null;
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
  /** (G2) A `rest` preview's egress; `null` for an MCP server. */
  egress: McpRestEgress | null;
  /** (DES-APPS-001 §5.1) A `sql`/`graphql` preview's describe; `null` otherwise. */
  source: SourceDescription | null;
}

export interface McpRegistryDeps {
  store: McpRegistryStore;
  secrets: SecretStore;
  probe: Prober;
  discover: (managed: ReadonlySet<string>) => McpDiscoveredServer[];
  /** Where `sql`/`graphql` sources' descriptions live; default beside the registry file. */
  catalogs?: SourceCatalogStore;
  /**
   * (DES-KNOWLEDGE-DATA-001 §6.3) The Toolbox runtime's probe of a `runtime: 'toolbox'` source (B2's supervisor).
   * Absent = this daemon has no Toolbox runtime: such a preview is a 501 `runtime_unavailable`.
   */
  toolboxProbe?: Prober;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export class McpRegistry {
  private readonly previews = new Map<string, HeldPreview>();
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  readonly catalogs: SourceCatalogStore;

  constructor(private readonly deps: McpRegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.env = deps.env ?? process.env;
    // Beside the registry file; a store without a directory (a test double) gets the default place.
    const dir = (deps.store as { directory?: unknown }).directory;
    this.catalogs = deps.catalogs ?? new SourceCatalogStore(typeof dir === 'string' ? join(dir, 'catalogs') : undefined);
  }

  get secretStoreAvailable(): boolean {
    return this.deps.secrets.available;
  }

  async list(): Promise<McpServersResponse> {
    const file = await this.readFile();
    const servers = await Promise.all(file.servers.map((s) => this.view(s)));
    const discovered = this.deps.discover(new Set(file.servers.map((s) => s.name)));
    return { servers, discovered };
  }

  /**
   * (DES-KNOWLEDGE-DATA-001 §5.2, crew#1310) The agent-safe view: name, kind, switch, health state, the tools with
   * their classes, and a source's see/query switches. No host, port, database, login, url, command, path, address,
   * secret reference or descriptor.
   */
  async listForAgents(): Promise<{ servers: McpServerAgentView[] }> {
    const file = await this.readFile();
    return { servers: (await Promise.all(file.servers.map((s) => this.view(s)))).map(agentServerView) };
  }

  /** The kept generations of the registry, newest first (DES-KNOWLEDGE-DATA-001 §5.5). */
  async generations(): Promise<{ current: number; generations: Array<{ generation: number; savedAt: string }> }> {
    const file = await this.readFile();
    return { current: file.generation ?? 0, generations: await this.deps.store.generations() };
  }

  async get(name: string): Promise<McpServer> {
    const file = await this.readFile();
    return this.view(this.find(file.servers, name));
  }

  /**
   * Probe `config` and hold exactly what it showed, for `save` (crew#719: with `stagedSecret`, the
   * secret this server's own keychain reference will hold — probed with now, written only when the
   * save commits, so the OS store and the registry row land together or not at all).
   */
  async preview(config: McpUpstreamConfig, stagedSecret: string | null = null): Promise<McpPreviewResponse> {
    if (config.name === ESTATE_SERVER) {
      throw new McpRegistryError(400, 'reserved_name', `"${ESTATE_SERVER}" is reserved: mcp:${ESTATE_SERVER}/<tool> is the broker's estate relay (the seat's own estate), never a registered server; choose another name`);
    }
    if ((config.kind === 'sql' || config.kind === 'graphql' || config.kind === 'toolbox-source') && config.name === CREW_SOURCE) {
      throw new McpRegistryError(400, 'reserved_name', `"${CREW_SOURCE}" is the built-in crew source; choose another name`);
    }
    // (DES-KNOWLEDGE-DATA-001 §5.1) A database source is saved as its Toolbox document, checked against the
    // deployment policy here (the preview) and again when the write lands.
    config = this.forSave(config);
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
      // (DES-APPS-001 §5.2) The dialer refused the connection: a 409 naming why (an unconfirmed range
      // to confirm, an always-refused address, plaintext), not an upstream failure.
      const human = result.sourceDetail !== undefined ? `${what}: ${result.sourceDetail}` : undefined;
      if (result.refusal !== undefined) throw new McpRegistryError(409, result.refusal, `${what}: ${result.error}`, human);
      throw new McpRegistryError(502, 'probe_failed', `${what}: ${result.error}`, human);
    }
    const tools = result.tools.map((t) => ({ ...t, schemaHash: hashOf(config, t) }));
    const previewHash = sha256Hex(canonicalJson({ config, tools: tools.map((t) => [t.name, t.schemaHash]) }));
    const expiresAt = this.now() + PREVIEW_TTL_MS;
    const existing = (await this.readFile()).servers.find((s) => s.name === config.name);
    // (G2) A mismatch with the spec's `servers`, or a private address, needs the operator to name
    // the origin at save, unless an earlier save of this server already confirmed that origin.
    const egress: McpRestEgress | null =
      config.kind !== 'rest' || result.egress === undefined ? null : { ...result.egress, confirmRequired: egressRefusal(result.egress, null, existing) !== null };
    if (config.kind === 'rest' && egress === null) throw new McpRegistryError(502, 'probe_failed', 'the rest probe did not report where its calls go');
    const source = result.source ?? null;
    if ((config.kind === 'sql' || config.kind === 'graphql') && source === null) throw new McpRegistryError(502, 'probe_failed', 'the source probe did not describe the source');
    this.hold(previewHash, { config, tools, expiresAt, secret: stagedSecret, egress, source });
    const was = (name: string): McpToolRecord | undefined => existing?.tools.find((p) => p.name === name);
    // The override a save keeps: only while the tool's schema is unchanged (as `save` decides).
    const survivingOverride = (t: { name: string; schemaHash: string }): McpToolClass | null => {
      const w = was(t.name);
      return w !== undefined && w.schemaHash === t.schemaHash ? w.classOverride : null;
    };
    // (DES-KNOWLEDGE-DATA-001 §5.1) The disclosure class a save gives each tool when the body names none.
    const reviewed = (t: { name: string; schemaHash: string }): ToolDisclosureClass | null => disclosureOnSave(t, was(t.name), undefined, config.kind)?.class ?? null;
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
        class: effectiveToolClass(deriveToolClass(t.annotations), survivingOverride(t)),
        classOverride: survivingOverride(t),
        schemaHash: t.schemaHash,
        enabledOnSave: enabledOnSave(was(t.name), t),
        disclosure: reviewed(t),
        ...(config.kind === 'rest' ? { rest: t.rest ?? null } : {}),
      })),
      diff: existing === undefined ? null : diffTools(existing.tools, tools),
      ...(result.skipped !== undefined && result.skipped.length > 0 ? { skipped: result.skipped } : {}),
      ...(egress !== null ? { egress } : {}),
      ...(source !== null ? { source: { catalog: source.catalog, ...(source.privileges !== undefined ? { privileges: source.privileges } : {}) } } : {}),
    };
  }

  /**
   * Register exactly what a preview showed. Saving over an existing name re-registers it: every
   * tool of the preview becomes `registered`, a tool it no longer lists becomes `gone`, and a class
   * override survives only while the schema is unchanged.
   *
   * (G1, DES-data-connectors §3) A tool's `enabled` switch is {@link enabledOnSave}: a `write` or
   * `destructive` tool that is new, or whose schema changed, is registered DISABLED. `enabledWrites`
   * is the operator's per-tool grant (the preview's write checkbox): each name must be a write or
   * destructive tool of this preview, and is registered enabled. The route allows a grant from a
   * human operator only and audits it. A grant enables a tool; `MCP-FIRST-USE` still asks on its
   * first call.
   *
   * (G2) `allowOrigin` is the operator naming the exact origin a `rest` server's calls go to. It is
   * required when the preview's `egress.confirmRequired` (see {@link checkEgress}) and remembered
   * on the record, so a re-save over the same origin does not ask again.
   *
   * (DES-KNOWLEDGE-DATA-001 §5.1) `disclosures` is the operator's review of each tool's disclosure class (human
   * operator only, like a write grant). A tool it does not name keeps its class while its schema is unchanged;
   * a tool of crew's own Toolbox configuration gets crew's class; any other tool has none until reviewed.
   */
  async save(previewHash: string | undefined, enabledWrites: readonly string[] = [], allowOrigin: string | null = null, disclosures: Readonly<Record<string, ToolDisclosureClass>> = {}): Promise<McpServer> {
    if (previewHash === undefined) {
      throw new McpRegistryError(409, 'preview_required', 'saving a server needs the previewHash of a preview of it: POST /mcp/servers/preview first');
    }
    const held = this.previews.get(previewHash);
    if (held === undefined || held.expiresAt <= this.now()) {
      this.previews.delete(previewHash);
      throw new McpRegistryError(409, 'preview_stale', 'that previewHash is unknown or expired: preview the server again, then save');
    }
    // A wrong grant is refused before the preview is spent, so the operator can correct it and save again.
    await this.checkWriteGrants(previewHash, enabledWrites);
    await this.checkEgress(previewHash, allowOrigin);
    this.checkDisclosures(previewHash, disclosures);
    const granted = new Set(enabledWrites);
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
    const saved = await this.restoreSecretOnFailure(held.config.name, held.secret !== null, prior, () => this.mutate(async (file) => {
      const prior = file.servers.find((s) => s.name === held.config.name);
      // (G2) Re-judged against the record as it is NOW, inside the write: a confirmation the
      // preview inherited from a server since removed or re-pointed does not carry over.
      if (held.egress !== null) {
        const refusal = egressRefusal(held.egress, allowOrigin, prior);
        if (refusal !== null) throw refusal;
      }
      const tools: McpToolRecord[] = held.tools.map((t) => {
        const was = prior?.tools.find((p) => p.name === t.name);
        return {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          annotations: t.annotations,
          classOverride: was !== undefined && was.schemaHash === t.schemaHash ? was.classOverride : null,
          enabled: granted.has(t.name) || enabledOnSave(was, t),
          schemaHash: t.schemaHash,
          observedSchemaHash: t.schemaHash,
          present: true,
          ...(t.rest != null ? { rest: t.rest } : {}),
          disclosure: disclosureOnSave(t, was, disclosures[t.name], held.config.kind),
        };
      });
      for (const old of prior?.tools ?? []) {
        if (!tools.some((t) => t.name === old.name)) tools.push({ ...old, present: false });
      }
      const origin = held.egress?.origin ?? null;
      // The confirmed origin is kept while the server still goes there: named now, or by an earlier save.
      const allowedOrigin = origin !== null && (allowOrigin === origin || prior?.allowedOrigin === origin) ? origin : null;
      const { address, sql, viewsAllowed, entry, id: _unsavedId, ...config } = held.config;
      void _unsavedId;
      // (DES-KNOWLEDGE-DATA-001 §5.1) A database source is stored as its Toolbox document (no `sql`): the read
      // path projects it. A re-save keeps the entry's id; a new name gets a new one.
      const stored: Partial<McpServerRecord> =
        entry != null
          ? { kind: 'toolbox-source', toolbox: entry.toolbox, runtime: entry.runtime, tls: entry.tls, descriptorVersion: entry.descriptorVersion, policyVersion: entry.policyVersion }
          : sql != null
            ? { sql }
            : {};
      const record: McpServerRecord = {
        id: prior?.id ?? randomUUID(),
        ...config,
        ...stored,
        ...(address != null ? { address } : {}),
        ...(viewsAllowed != null ? { viewsAllowed } : {}),
        ...(allowedOrigin !== null ? { allowedOrigin } : {}),
        enabled: prior?.enabled ?? true,
        health: { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null },
        registeredAt: prior?.registeredAt ?? stamp,
        updatedAt: stamp,
        tools,
      };
      // (DES-APPS-001 §7.4, DES-KNOWLEDGE-DATA-001 §5.4) Allow writes is off on every new Postgres source, and
      // "query" on every new source. A re-save keeps each only while the descriptor is unchanged, and a K1
      // entry's first save writes descriptor version 2, which is a change (grants bind to the descriptor anyway).
      const sameDescriptor = prior !== undefined && isSourceRecord(prior) && isSourceRecord(record) && sourceDescriptorHash(configOf(prior)) === sourceDescriptorHash(configOf(record));
      if (isPostgresRecord(record)) record.allowWrites = prior !== undefined && prior.allowWrites === true && isPostgresRecord(prior) && sameDescriptor;
      if (prior !== undefined && prior.agents !== undefined && isSourceRecord(prior) && isSourceRecord(record)) {
        const was = agentAccessOf(prior);
        record.agents = { ...was, query: was.query && sameDescriptor };
      }
      file.servers = [...file.servers.filter((s) => s.name !== record.name), record];
      // The description lands INSIDE the record's own write (the store serializes mutations), so a
      // record and its description can never be paired with another save's.
      if (held.source !== null) await this.catalogs.write(record.name, { ...held.source, descriptorHash: sourceDescriptorHash(configOf(record)) });
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

  /**
   * (G1) Refuse an `enabledWrites` list that does not fit the held preview: a name it does not list
   * (400 `unknown_tool`), or a tool that would not be a write once saved (400 `not_a_write_tool`) —
   * by its annotations, or by a class override that survives the save (schema unchanged). The route
   * calls this before it withdraws any approval, so a refused grant changes nothing. An unknown or
   * expired preview is left for `save` to refuse.
   */
  async checkWriteGrants(previewHash: string, enabledWrites: readonly string[]): Promise<void> {
    if (enabledWrites.length === 0) return;
    const held = this.previews.get(previewHash);
    if (held === undefined || held.expiresAt <= this.now()) return;
    const prior = (await this.readFile()).servers.find((s) => s.name === held.config.name);
    for (const name of enabledWrites) {
      const t = held.tools.find((x) => x.name === name);
      if (t === undefined) throw new McpRegistryError(400, 'unknown_tool', `enabledWrites names ${name}, which this preview does not list`);
      const was = prior?.tools.find((p) => p.name === name);
      const override = was !== undefined && was.schemaHash === t.schemaHash ? was.classOverride : null;
      if (!isWriteGrant(t.annotations, override)) {
        throw new McpRegistryError(400, 'not_a_write_tool', `enabledWrites names ${name}, a read tool; read tools are enabled on save without a grant`);
      }
    }
  }

  /**
   * (G2, DES-data-connectors §3) Refuse a save whose egress the operator has not confirmed: when
   * the held preview's `egress.confirmRequired` (the base URL matches none of the spec's `servers`;
   * a loopback/private host is the dialer's, confirmed as `address.allow`), `allowOrigin` must be exactly `egress.origin`
   * (409 `egress_unconfirmed`). An `allowOrigin` that names another origin is refused the same way
   * even when no confirmation is needed, and one for a server that is not `rest` is a 400
   * `egress_not_rest`. Like {@link checkWriteGrants} it changes nothing, so the route calls it
   * before any approval is withdrawn; `save` judges it again inside its write. An unknown or
   * expired preview is left for `save` to refuse.
   */
  async checkEgress(previewHash: string, allowOrigin: string | null): Promise<void> {
    const held = this.previews.get(previewHash);
    if (held === undefined || held.expiresAt <= this.now()) return;
    if (held.egress === null) {
      if (allowOrigin !== null) throw new McpRegistryError(400, 'egress_not_rest', 'allowOrigin is for a rest server');
      return;
    }
    const prior = (await this.readFile()).servers.find((s) => s.name === held.config.name);
    const refusal = egressRefusal(held.egress, allowOrigin, prior);
    if (refusal !== null) throw refusal;
  }

  /**
   * (DES-KNOWLEDGE-DATA-001 §5.1) Refuse a `disclosures` review that does not fit the held preview: a tool it
   * does not list (400 `unknown_tool`). Changes nothing. An unknown or expired preview is left for `save`.
   */
  checkDisclosures(previewHash: string, disclosures: Readonly<Record<string, ToolDisclosureClass>>): void {
    const held = this.previews.get(previewHash);
    if (held === undefined || held.expiresAt <= this.now()) return;
    for (const name of Object.keys(disclosures)) {
      if (!held.tools.some((t) => t.name === name)) throw new McpRegistryError(400, 'unknown_tool', `disclosures names ${name}, which this preview does not list`);
    }
  }

  /**
   * (G2) Whether every saved tool of the `rest` server `name` has a hash that covers the server's
   * target. `false` for a registration saved before G2 (or whose url or auth header changed outside
   * a save): its approvals never covered the target, so a re-save withdraws them all. `true` for an
   * unknown server and for an MCP server.
   */
  async targetBound(name: string): Promise<boolean> {
    const s = (await this.readFile()).servers.find((x) => x.name === name);
    return s === undefined || s.tools.every((t) => targetBound(s, t));
  }

  /** What a held preview would register: its server name and each tool's schema hash (S6). */
  peekPreview(previewHash: string): { name: string; tools: Array<{ name: string; schemaHash: string }>; egress: McpRestEgress | null; target: HashedRestTarget | null; address: AddressPolicy | null } | null {
    const held = this.previews.get(previewHash);
    if (held === undefined || held.expiresAt <= this.now()) return null;
    return {
      address: held.config.address ?? null,
      name: held.config.name,
      tools: held.tools.map((t) => ({ name: t.name, schemaHash: t.schemaHash })),
      egress: held.egress,
      target: held.config.kind === 'rest' ? restTarget(held.config) : null,
    };
  }

  async setServerEnabled(name: string, enabled: boolean): Promise<McpServer> {
    const rec = await this.mutate((file) => {
      const s = this.find(file.servers, name);
      s.enabled = enabled;
      s.updatedAt = new Date(this.now()).toISOString();
      return s;
    });
    return this.view(rec);
  }

  /** Remove a server, and the keychain secret it owns (`keychain:wicked-mcp/<name>`). */
  async remove(name: string): Promise<void> {
    const removed = await this.mutate(async (file) => {
      const s = this.find(file.servers, name);
      file.servers = file.servers.filter((x) => x.name !== name);
      // Inside the mutation, serialized with every save and upload: a source saved under this name
      // next writes its catalog after this deletion, never before it.
      if (isSourceRecord(s)) await this.catalogs.remove(name);
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

  /**
   * Set a tool's switch and/or class override. (G1) A patch that leaves a tool ENABLED and a WRITE
   * (by its own annotations or by its class after the patch) when it was not both before is a write
   * grant: turning a write on, or re-classing an enabled read as a write. It is refused (403
   * `write_grant_human_only`) unless `opts.mayGrantWrite`, which the route sets for a human operator
   * only. Turning a tool off, and enabling a read, need no grant. `grantedWrite` says whether this
   * patch was one, so the route audits exactly the grants.
   */
  async patchTool(
    subject: string,
    patch: { enabled?: boolean | undefined; classOverride?: McpToolClass | null | undefined; disclosure?: ToolDisclosureClass | null | undefined },
    opts: { mayGrantWrite?: boolean; mayReviewDisclosure?: boolean } = {},
  ): Promise<{ tool: McpTool; grantedWrite: boolean }> {
    const parts = parseMcpSubject(subject);
    if (parts === null) throw new McpRegistryError(404, 'unknown_tool', `no tool ${subject}`);
    const stamp = new Date(this.now()).toISOString();
    const { server, tool, grant } = await this.mutate((file) => {
      const s = this.find(file.servers, parts.server);
      const t = s.tools.find((x) => x.name === parts.tool);
      if (t === undefined) throw new McpRegistryError(404, 'unknown_tool', `no tool ${subject}`);
      // (DES-KNOWLEDGE-DATA-001 §5.1) A disclosure class is reviewed by a human operator, against the schema the
      // operator saved; clearing one (the tool is offered to no agent) needs no review.
      if (patch.disclosure != null) {
        if (opts.mayReviewDisclosure !== true) throw new McpRegistryError(403, 'disclosure_review_human_only', `only a human operator reviews what ${subject} discloses`);
        if (t.schemaHash === null || t.schemaHash !== t.observedSchemaHash) throw new McpRegistryError(409, 'not_registered', `${subject}'s schema is not the saved one: preview and save the server again, then review it`);
      }
      const before = t.enabled && isWriteGrant(t.annotations, t.classOverride);
      const enabled = patch.enabled ?? t.enabled;
      const override = patch.classOverride !== undefined ? patch.classOverride : t.classOverride;
      const grant = !before && enabled && isWriteGrant(t.annotations, override);
      if (grant && opts.mayGrantWrite !== true) {
        throw new McpRegistryError(403, 'write_grant_human_only', `${subject} would be an enabled write tool: only a human operator can grant that`);
      }
      t.enabled = enabled;
      t.classOverride = override;
      if (patch.disclosure !== undefined) t.disclosure = patch.disclosure === null || t.schemaHash === null ? null : { class: patch.disclosure, schemaHash: t.schemaHash };
      s.updatedAt = stamp;
      return { server: s, tool: t, grant };
    });
    return { tool: toolView(server, tool), grantedWrite: grant };
  }

  /** Probe a registered server again: record its health and its tool diff. */
  async test(name: string): Promise<McpServerTestResponse> {
    const current = this.find((await this.readFile()).servers, name);
    const config = configOf(current);
    const result = await this.probe(config);
    const stamp = new Date(this.now()).toISOString();
    let diff: McpToolDiff | null = null;
    const rec = await this.mutate((file) => {
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
      const probed = result.tools.map((t) => ({ ...t, schemaHash: hashOf(config, t) }));
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
          // G1: a tool the server added is shown with the switch a save would give it.
          enabled: enabledOnSave(undefined, p),
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
    const server = this.find((await this.readFile()).servers, name);
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
    const s = (await this.readFile()).servers.find((x) => x.name === server);
    if (s === undefined) return null;
    const t = s.tools.find((x) => x.name === tool);
    return {
      config: configOf(s),
      rest: t?.rest ?? null,
      annotations: t?.annotations ?? null,
      classOverride: t?.classOverride ?? null,
      schemaHash: t?.schemaHash ?? null,
      disclosure: t === undefined ? null : effectiveDisclosure(t),
      id: entryId(s),
      registered: s.enabled && t !== undefined && t.enabled && statusOf(s, t) === 'registered',
      resaveRequired: t !== undefined && !targetBound(s, t),
    };
  }

  /**
   * Every tool a call could reach right now (slice S4, the shim's `list`): enabled servers, and
   * their enabled tools whose saved schema is the one last seen. Anything else is D-5 and would be
   * refused by the broker, so it is never offered.
   */
  async callableTools(): Promise<McpCallableTool[]> {
    const out: McpCallableTool[] = [];
    for (const s of (await this.readFile()).servers) {
      if (!s.enabled) continue;
      for (const t of s.tools) {
        if (!t.enabled || statusOf(s, t) !== 'registered') continue;
        out.push({
          server: s.name,
          id: entryId(s),
          tool: t.name,
          kind: configOf(s).kind,
          disclosure: effectiveDisclosure(t),
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
   * The MCP inspector's resolution of a registered server (DES-MCP-INSPECTOR-001 §3): its config,
   * enabled or not (an operator debugs a server it switched off), or `null` for no such name.
   */
  async inspectTarget(name: string): Promise<McpUpstreamConfig | null> {
    const s = (await this.readFile()).servers.find((x) => x.name === name);
    return s === undefined ? null : configOf(s);
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

  // ── Apps data sources (DES-APPS-001 §5, §7.4) ─────────────────────────────────────────────

  /**
   * A `sql` or `graphql` source as the sources routes need it: its config, its Allow writes switch
   * and its stored description (`null` until described). 404 for no such source, 400 for a server
   * that is not one.
   */
  async source(name: string): Promise<{ config: McpUpstreamConfig; allowWrites: boolean; description: StoredDescription | null; descriptorHash: string; enabled: boolean }> {
    const s = this.find((await this.readFile()).servers, name);
    const config = configOf(s);
    if (config.kind !== 'sql' && config.kind !== 'graphql') throw new McpRegistryError(400, 'not_a_source', `${name} is an ${config.kind} server, not a data source`);
    const descriptorHash = sourceDescriptorHash(config);
    const stored = await this.catalogs.read(name);
    // A description taken under another descriptor (a re-save since) is not this source's: not described.
    return { config, allowWrites: s.allowWrites === true, description: stored !== null && stored.descriptorHash === descriptorHash ? stored : null, descriptorHash, enabled: s.enabled };
  }

  /**
   * (DES-APPS-001 §9.4) A REST or MCP server's tool as an Apps query or API action uses it: the server's
   * config and descriptor hash, and the tool's record, with whether the person's saved schema still is the
   * one the server shows (`bound`). The per-tool switch (G1) governs agent runs only, so a tool's `enabled`
   * is not consulted here; a server switched off is. `null` = no such server or tool.
   */
  async appTool(server: string, tool: string): Promise<{ config: McpUpstreamConfig; tool: McpToolRecord; bound: boolean } | null> {
    const s = (await this.readFile()).servers.find((x) => x.name === server);
    if (s === undefined || (s.kind !== 'rest' && s.kind !== 'mcp-http' && s.kind !== 'mcp-stdio')) return null;
    const t = s.tools.find((x) => x.name === tool);
    if (t === undefined) return null;
    return { config: configOf(s), tool: structuredClone(t), bound: s.enabled && statusOf(s, t) === 'registered' };
  }

  /** (K2b) A server's config and whether it is switched on, from ONE read of the store (no presentation work). */
  async snapshot(name: string): Promise<{ config: McpUpstreamConfig; enabled: boolean } | null> {
    const s = (await this.readFile()).servers.find((x) => x.name === name);
    return s === undefined ? null : { config: configOf(s), enabled: s.enabled };
  }

  /** Store a fresh description of a source (a re-describe), bound to the descriptor it was taken under. */
  async saveDescription(name: string, description: SourceDescription, descriptorHash: string): Promise<void> {
    // Checked and written inside one registry mutation (serialized with every save), so a save that
    // lands while the source was being described always wins.
    await this.mutate(async (file) => {
      const s = this.find(file.servers, name);
      if (sourceDescriptorHash(configOf(s)) !== descriptorHash) throw new McpRegistryError(409, 'server_changed', `${name} was saved again while it was being described; describe it again`);
      await this.catalogs.write(name, { ...description, descriptorHash });
    });
  }

  /**
   * (DES-APPS-001 §7.4) Turn a Postgres source's Allow writes switch on or off. The route allows a
   * human operator only and audits it; turning it off withdraws the source's row-write grants (the
   * caller's hook). Answers whether it changed.
   */
  async setAllowWrites(name: string, allowed: boolean): Promise<{ before: boolean; after: boolean; server: McpServer }> {
    const { before, rec } = await this.mutate((file) => {
      const s = this.find(file.servers, name);
      if (!isPostgresRecord(s)) throw new McpRegistryError(400, 'writes_not_supported', `${name} is not a Postgres source: v1 row writes are Postgres only`);
      const was = s.allowWrites === true;
      s.allowWrites = allowed;
      s.updatedAt = new Date(this.now()).toISOString();
      return { before: was, rec: s };
    });
    return { before, after: allowed, server: await this.view(rec) };
  }

  /**
   * Register (or replace) an uploaded snapshot as a `sql`/`sqlite` source (DES-APPS-001 §5.1). The
   * upload IS the person's act, so there is no preview; a name held by any other kind is refused.
   */
  async registerSnapshotSource(name: string, digest: string, description: SourceDescription): Promise<McpServer> {
    if (name === CREW_SOURCE || name === ESTATE_SERVER) throw new McpRegistryError(400, 'reserved_name', `"${name}" is reserved; choose another name`);
    const stamp = new Date(this.now()).toISOString();
    const rec = await this.mutate(async (file) => {
      const prior = file.servers.find((s) => s.name === name);
      if (prior !== undefined && !(prior.kind === 'sql' && prior.sql?.driver === 'sqlite')) {
        throw new McpRegistryError(409, 'name_taken', `${name} is already a registered ${prior.kind} server; choose another name`);
      }
      const record: McpServerRecord = {
        id: prior?.id ?? randomUUID(),
        name,
        kind: 'sql',
        command: null,
        args: [],
        url: null,
        auth: null,
        sql: { driver: 'sqlite', snapshot: digest },
        viewsAllowed: [],
        enabled: true,
        health: { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null },
        registeredAt: prior?.registeredAt ?? stamp,
        updatedAt: stamp,
        tools: [],
        // (DES-KNOWLEDGE-DATA-001 §7.1) A new upload of the same name keeps the person's agent switches; "query"
        // only when it is the same snapshot (a new digest is a new descriptor).
        ...(prior?.agents !== undefined ? { agents: { ...agentAccessOf(prior), query: agentAccessOf(prior).query && prior.sql?.snapshot === digest } } : {}),
      };
      file.servers = [...file.servers.filter((s) => s.name !== name), record];
      await this.catalogs.write(name, { ...description, descriptorHash: sourceDescriptorHash(configOf(record)) });
      return record;
    });
    return this.view(rec);
  }

  // ── Generations (DES-KNOWLEDGE-DATA-001 §5.5) ──────────────────────────────────────────────

  /**
   * A kept generation's servers, normalized, for the route to judge what a restore would withdraw. 404
   * `unknown_generation` when it is not kept; 409 `generation_unreadable` when it does not parse.
   */
  async generationServers(generation: number): Promise<McpServerRecord[]> {
    let kept: McpRegistryFile | null;
    try {
      kept = await this.deps.store.readGeneration(generation);
    } catch (err) {
      if (err instanceof McpRegistryCorruptError) throw new McpRegistryError(409, 'generation_unreadable', `generation ${generation} does not parse, so it cannot be restored: ${err.message}`);
      throw err;
    }
    if (kept === null) throw new McpRegistryError(404, 'unknown_generation', `generation ${generation} is not kept (the registry keeps the last ${GENERATIONS_KEPT})`);
    return normalizeRegistryFile(kept).servers;
  }

  /**
   * Restore a kept generation, reconciled so it fails closed (§5.5). The generation in force when this runs is
   * itself kept, so a restore can be undone the same way.
   *
   * - "Query" and Allow writes come back OFF on every source: a person turns them on again.
   * - A server whose secret reference resolves to nothing (a keychain entry gone, an env variable unset, or a
   *   keychain reference on a daemon with no keychain) comes back DISABLED, `secret_missing`.
   * - Grants stay bound to their descriptors and are judged where they are used; approvals the route withdraws
   *   before calling this.
   */
  async restore(generation: number): Promise<McpRegistryRestoreResponse> {
    const servers = await this.generationServers(generation);
    const disabled: McpRegistryRestoreResponse['disabled'] = [];
    const queryReset: string[] = [];
    const writesReset: string[] = [];
    const stamp = new Date(this.now()).toISOString();
    for (const s of servers) {
      if (isSourceRecord(s)) {
        const a = agentAccessOf(s);
        if (a.query) queryReset.push(s.name);
        if (s.agents !== undefined || a.query) s.agents = { ...a, query: false };
        if (s.allowWrites === true) writesReset.push(s.name);
        if (isPostgresRecord(s)) s.allowWrites = false;
      }
      if (s.auth !== null && (await this.authStateFailClosed(s.auth)) !== 'set') {
        if (s.enabled) disabled.push({ name: s.name, code: 'secret_missing' });
        s.enabled = false;
        s.health = { ...s.health, checkedAt: stamp, lastError: `secret_missing: ${s.auth.ref} resolves to no secret; set it, then switch ${s.name} on` };
        s.updatedAt = stamp;
      }
    }
    const current = await this.mutate((file) => {
      file.servers = servers;
      return file.generation ?? 0;
    });
    return { restored: generation, generation: current + 1, servers: servers.length, disabled, queryReset, writesReset };
  }

  /** A secret's state, where an error reading the store counts as missing (a restore fails closed). */
  private async authStateFailClosed(auth: McpAuthConfig): Promise<McpAuthState> {
    try {
      return await this.authState(auth);
    } catch {
      return 'missing';
    }
  }

  /**
   * A config as a save will store it (DES-KNOWLEDGE-DATA-001 §5.1): a network Postgres source, sent in K1's form
   * or as a Toolbox document, becomes a Toolbox-form entry (descriptor version 2), checked against the deployment
   * policy; a native-runtime entry carries its K1 projection, which is what the probe describes.
   */
  private forSave(config: McpUpstreamConfig): McpUpstreamConfig {
    try {
      if (config.kind === 'sql' && config.sql?.driver === 'postgres') {
        const entry = toolboxEntryFromSql(config, 2);
        return entry === null ? config : { ...config, entry };
      }
      if (config.kind !== 'toolbox-source') return config;
      const raw = config.entry ?? null;
      if (raw === null) throw new McpRegistryError(400, 'bad_toolbox', 'a toolbox-source carries its Toolbox source document');
      const toolbox = checkSourceDocument(raw.toolbox, { runtime: raw.runtime });
      const entry: ToolboxSourceEntry = { toolbox, runtime: raw.runtime, tls: { mode: raw.tls.mode, ca: raw.tls.ca ?? null }, descriptorVersion: 2, policyVersion: policyVersionOf(toolbox.type) };
      if (raw.runtime === 'native') {
        return { ...config, kind: 'sql', sql: sqlFromToolboxEntry(entry), viewsAllowed: config.viewsAllowed ?? [], address: config.address ?? { ...NO_CONFIRMATION, allow: [] }, entry };
      }
      if (this.deps.toolboxProbe === undefined) {
        throw new McpRegistryError(501, 'runtime_unavailable', 'this daemon has no Toolbox runtime yet: save the source with runtime "native" (Postgres)');
      }
      return { ...config, entry };
    } catch (err) {
      throw policyRefusal(err);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────

  /** The registry as every reader sees it: ids present, K1 Postgres records mapped (DES-KNOWLEDGE-DATA-001 §5.4). */
  private async readFile(): Promise<McpRegistryFile> {
    return normalizeRegistryFile(await this.deps.store.read());
  }

  /**
   * One mutation of the normalized registry. The write persists the normalized form (ids, mapped entries). Every
   * Toolbox document that is new or changed by the mutation is checked against its deployment policy before the
   * write lands, so no path saves one the policy refuses.
   */
  private mutate<T>(fn: (file: McpRegistryFile) => T | Promise<T>): Promise<T> {
    return this.deps.store.mutate(async (file) => {
      normalizeRegistryFile(file);
      const before = new Map(file.servers.map((s) => [s.name, canonicalJson(s.toolbox ?? null)]));
      const result = await fn(file);
      for (const s of file.servers) {
        if (s.kind !== 'toolbox-source') continue;
        if (before.get(s.name) === canonicalJson(s.toolbox ?? null)) continue;
        try {
          checkSourceDocument(s.toolbox, { runtime: s.runtime ?? 'native' });
        } catch (err) {
          throw policyRefusal(err);
        }
      }
      return result;
    });
  }

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
    // (DES-KNOWLEDGE-DATA-001 §6.3) A Toolbox-runtime source is probed by the Toolbox runtime, never as a server.
    const prober = config.kind === 'toolbox-source' ? this.deps.toolboxProbe : this.deps.probe;
    if (prober === undefined) return { ok: false, error: 'this daemon has no Toolbox runtime' };
    if (config.auth === null) return prober(config, null);
    // (crew#719) A staged secret is probed with instead of being written first. The caller has
    // already checked it belongs to THIS server's keychain reference.
    const secret = staged ?? (await resolveSecret(config.auth.ref, this.deps.secrets, this.env));
    if (secret === null) {
      return { ok: false, error: `auth.ref ${config.auth.ref} resolves to no secret: set it, then try again`, missingSecret: true };
    }
    return prober(config, secret);
  }

  private async authState(auth: McpAuthConfig | null): Promise<McpAuthState> {
    if (auth === null) return 'none';
    if (parseSecretRef(auth.ref) === null) return 'missing';
    return (await secretIsSet(auth.ref, this.deps.secrets, this.env)) ? 'set' : 'missing';
  }

  private async view(s: McpServerRecord): Promise<McpServer> {
    const tools = s.tools.map((t) => toolView(s, t));
    const live = tools.filter((t) => t.status !== 'gone');
    const isSource = isSourceRecord(s);
    return {
      id: entryId(s),
      ...configView(configOf(s)),
      ...(isPostgresRecord(s) ? { allowWrites: s.allowWrites === true } : {}),
      ...(isSource ? { descriptorHash: sourceDescriptorHash(configOf(s)), agents: agentAccessOf(s) } : {}),
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

/**
 * A record as every consumer reads it: the READ-PATH PROJECTION (DES-KNOWLEDGE-DATA-001 §5.4). A native-runtime
 * `toolbox-source` entry answers K1's `kind: 'sql'` config, with `config.sql` synthesised from its Toolbox document,
 * so no consumer sees the new form until it moves onto the gate (M3b); `config.entry` carries the stored form. A
 * `runtime: 'toolbox'` entry keeps `kind: 'toolbox-source'` and has no `sql`: Apps cannot read it in v1 (§6.3).
 */
export function configOf(s: McpServerRecord): McpUpstreamConfig {
  const base: McpUpstreamConfig = { name: s.name, kind: s.kind, command: s.command, args: s.args, url: s.url, auth: s.auth, ...(s.id !== undefined ? { id: s.id } : {}) };
  if (s.kind === 'toolbox-source') {
    const entry = entryOf(s);
    const address = s.address ?? { ...NO_CONFIRMATION, allow: [] };
    if (entry === null) return { ...base, address };
    if (entry.runtime === 'native') return { ...base, kind: 'sql', sql: sqlFromToolboxEntry(entry), viewsAllowed: s.viewsAllowed ?? [], address, entry };
    return { ...base, address, viewsAllowed: s.viewsAllowed ?? [], entry };
  }
  if (s.kind === 'mcp-stdio') return base;
  if (s.kind === 'sql') {
    const sqlite = s.sql?.driver === 'sqlite';
    return { ...base, sql: s.sql ?? null, viewsAllowed: s.viewsAllowed ?? [], ...(sqlite ? {} : { address: s.address ?? { ...NO_CONFIRMATION, allow: [] } }) };
  }
  if (s.kind === 'graphql') return { ...base, address: s.address ?? { ...NO_CONFIRMATION, allow: [] } };
  const address = s.address ?? legacyAddress(s);
  if (s.kind !== 'rest') return { ...base, address };
  return { ...base, openapiUrl: s.openapiUrl ?? null, openapi: s.openapi ?? null, operations: s.operations ?? null, address };
}

/**
 * (DES-APPS-001 §5.2) The confirmation of a record saved before the dialer, which has none. Only
 * what is safe to re-derive: the IP literal, or `localhost`, it was explicitly registered at — an
 * `mcp-http` server's url, or the origin a `rest` server's operator confirmed with G2's
 * `allowOrigin` (before the dialer, the only way a rest server reached a loopback or private host).
 * An IP literal is the exact address (no name to re-resolve); `localhost` is loopback by definition
 * (RFC 6761). A private NAME is not re-derived: its calls are refused, naming the range to confirm,
 * until the server is saved again with one.
 */
export function legacyAddress(s: Pick<McpServerRecord, 'kind' | 'url' | 'allowedOrigin'>): AddressPolicy {
  const raw = s.kind === 'mcp-http' ? s.url : s.kind === 'rest' ? (s.allowedOrigin ?? null) : null;
  const allow = exactRangesFor(raw);
  if (allow.length === 0) return { ...NO_CONFIRMATION, allow: [] };
  // A private IP literal registered over http was registered as plaintext; loopback never needs it.
  const host = new URL(raw as string).hostname.replace(/^\[|\]$/g, '');
  const plaintext = new URL(raw as string).protocol === 'http:' && isIP(host) !== 0 && classifyAddress(host).cls === 'private';
  return { allow, plaintext };
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
  address?: AddressPolicy;
  sql?: { driver: 'postgres' | 'mysql' | 'sqlite'; host: string | null; port: number | null; database: string | null; user: string | null; tls: 'verify-full' | 'disable'; ca: boolean; snapshot: string | null };
  viewsAllowed?: string[];
  runtime?: 'native' | 'toolbox';
  toolbox?: ToolboxSourceEntry['toolbox'];
  descriptorVersion?: 1 | 2;
  policyVersion?: string;
}

/** What a response shows of a config. A pasted OpenAPI document is not echoed back. */
function configView(c: McpUpstreamConfig): ConfigView {
  const view: ConfigView = { name: c.name, kind: c.kind, command: c.command, args: c.args, url: c.url, auth: c.auth };
  if (c.kind === 'rest') {
    view.openapiUrl = c.openapiUrl ?? null;
    view.operations = c.operations ?? null;
  }
  if (c.kind !== 'mcp-stdio' && !(c.kind === 'sql' && c.sql?.driver === 'sqlite')) view.address = c.address ?? { ...NO_CONFIRMATION, allow: [] };
  if (c.kind === 'sql' && c.sql != null) {
    view.sql = { driver: c.sql.driver, host: c.sql.host ?? null, port: c.sql.port ?? null, database: c.sql.database ?? null, user: c.sql.user ?? null, tls: c.sql.tls ?? 'verify-full', ca: c.sql.ca != null, snapshot: c.sql.snapshot ?? null };
    view.viewsAllowed = c.viewsAllowed ?? [];
  }
  // (DES-KNOWLEDGE-DATA-001 §5.1) The stored form of a database source: its Toolbox document (the password is a
  // placeholder, never a value), runtime and versions. A human operator's view only.
  if (c.entry != null) {
    view.runtime = c.entry.runtime;
    view.toolbox = c.entry.toolbox;
    view.descriptorVersion = c.entry.descriptorVersion;
    view.policyVersion = c.entry.policyVersion;
    if (c.kind === 'toolbox-source') view.viewsAllowed = c.viewsAllowed ?? [];
  }
  return view;
}

/**
 * (G1, DES-data-connectors §3) The switch a save gives a tool when the operator grants nothing:
 * - the schema the operator last saved, unchanged: its switch as they left it;
 * - otherwise a `write` or `destructive` tool (by its own annotations; an override does not survive
 *   a schema change) is DISABLED until the operator grants it, so a grant covers one schema;
 * - otherwise a `read` tool keeps its switch, and a new one is enabled.
 */
export function enabledOnSave(
  was: Pick<McpToolRecord, 'enabled' | 'schemaHash'> | undefined,
  next: { annotations: McpToolAnnotations | null; schemaHash: string },
): boolean {
  if (was !== undefined && was.schemaHash !== null && was.schemaHash === next.schemaHash) return was.enabled;
  if (deriveToolClass(next.annotations) !== 'read') return false;
  return was?.enabled ?? true;
}

/** (G1) Whether enabling a tool with these annotations and class override grants a write. */
export function isWriteGrant(annotations: McpToolAnnotations | null, classOverride: McpToolClass | null): boolean {
  const derived = deriveToolClass(annotations);
  return derived !== 'read' || effectiveToolClass(derived, classOverride) !== 'read';
}

export function toolStatus(t: Pick<McpToolRecord, 'present' | 'schemaHash' | 'observedSchemaHash'>): McpToolStatus {
  if (!t.present) return 'gone';
  return t.schemaHash !== null && t.schemaHash === t.observedSchemaHash ? 'registered' : 'unregistered';
}

/**
 * (G2) Why saving a `rest` preview with this egress is refused, or `null` when it may be saved: an
 * `allowOrigin` naming another origin; or a base URL that matches none of the spec's `servers`, a
 * private host, or one that did not resolve, with neither `allowOrigin` naming the origin nor
 * `prior` (the record as it is now) holding it as confirmed.
 */
function egressRefusal(egress: Omit<McpRestEgress, 'confirmRequired'>, allowOrigin: string | null, prior: Pick<McpServerRecord, 'allowedOrigin'> | undefined): McpRegistryError | null {
  if (allowOrigin !== null && allowOrigin !== egress.origin) {
    return new McpRegistryError(409, 'egress_unconfirmed', `allowOrigin ${JSON.stringify(allowOrigin)} is not this server's origin; to confirm it, name exactly ${egress.origin}`);
  }
  if (allowOrigin !== null || prior?.allowedOrigin === egress.origin) return null;
  // (DES-APPS-001 §5.2) A loopback, private or unresolvable host is the dialer's to judge, at every
  // connection under the server's confirmed ranges; a preview could not have reached here with an
  // unconfirmed one. `allowOrigin` is only the operator accepting a base URL the spec does not list.
  const why = [
    ...(egress.matches ? [] : [egress.servers.length === 0 ? 'the OpenAPI document names no server crew can check it against' : `it matches none of the OpenAPI document's servers (${egress.servers.join(', ')})`]),
  ];
  if (why.length === 0) return null;
  return new McpRegistryError(409, 'egress_unconfirmed', `the calls would go to ${egress.origin}${egress.basePath}, but ${why.join(', and ')}: to use it anyway, save with allowOrigin set to exactly ${egress.origin}`);
}

/** A tool's schema hash: a `rest` tool's also covers its server's target (G2). */
function hashOf(config: Pick<McpUpstreamConfig, 'kind' | 'url' | 'auth'>, t: HashedToolShape): string {
  return toolSchemaHash(t, config.kind === 'rest' ? restTarget(config) : null);
}

/**
 * (G2) Whether a saved `rest` tool's hash covers the target its server's calls go to now. The
 * hash is recomputed from the saved tool and the saved config, so a tool saved before G2 (whose
 * hash has no target), and a record whose url or auth header changed outside a save, read
 * `unregistered` and are denied (D-5) until the operator saves the server again. Nothing re-hashes
 * an existing registration silently.
 */
function targetBound(s: McpServerRecord, t: McpToolRecord): boolean {
  if (s.kind !== 'rest' || t.schemaHash === null) return true;
  return hashOf(s, t) === t.schemaHash;
}

/** {@link toolStatus}, plus (G2) a `rest` tool whose saved hash does not cover its target is `unregistered`. */
function statusOf(s: McpServerRecord, t: McpToolRecord): McpToolStatus {
  const status = toolStatus(t);
  return status === 'registered' && !targetBound(s, t) ? 'unregistered' : status;
}

function toolView(s: McpServerRecord, t: McpToolRecord): McpTool {
  const derivedClass = deriveToolClass(t.annotations);
  return {
    name: t.name,
    ...(t.rest != null ? { rest: t.rest } : {}),
    subject: mcpSubject(s.name, t.name),
    description: t.description,
    annotations: t.annotations,
    inputSchema: t.inputSchema,
    derivedClass,
    classOverride: t.classOverride,
    class: effectiveToolClass(derivedClass, t.classOverride),
    enabled: t.enabled,
    status: statusOf(s, t),
    schemaHash: t.schemaHash,
    observedSchemaHash: t.observedSchemaHash,
    disclosure: effectiveDisclosure(t),
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

// ── The one registry's entry (DES-KNOWLEDGE-DATA-001 §5) ─────────────────────────────────────────

/** A data source of any form: K1 `sql`/`graphql`, or a Toolbox-form database source. */
export function isSourceRecord(s: Pick<McpServerRecord, 'kind'>): boolean {
  return s.kind === 'sql' || s.kind === 'graphql' || s.kind === 'toolbox-source';
}

/** A network Postgres source, in either form (the one kind with row writes in v1). */
export function isPostgresRecord(s: McpServerRecord): boolean {
  if (s.kind === 'toolbox-source') return s.toolbox?.type === 'postgres';
  return s.kind === 'sql' && s.sql?.driver === 'postgres';
}

/** A record's id; one read through {@link normalizeRegistryFile} always has it. */
export function entryId(s: Pick<McpServerRecord, 'id' | 'name' | 'registeredAt'>): string {
  return s.id ?? legacyEntryId(s.name, s.registeredAt);
}

/** The stored database-source part of a `toolbox-source` record; `null` when it is incomplete (a hand edit). */
function entryOf(s: McpServerRecord): ToolboxSourceEntry | null {
  if (s.toolbox === undefined || (s.runtime !== 'native' && s.runtime !== 'toolbox') || s.tls === undefined) return null;
  return { toolbox: s.toolbox, runtime: s.runtime, tls: { mode: s.tls.mode, ca: s.tls.ca ?? null }, descriptorVersion: s.descriptorVersion === 2 ? 2 : 1, policyVersion: s.policyVersion ?? policyVersionOf(s.toolbox.type) };
}

/**
 * The registry as every reader sees it, normalized IN PLACE (and answered):
 *
 * - every record has an `id` (a record from before ids gets {@link legacyEntryId}, the same on every read);
 * - a K1 network Postgres `sql` record is mapped to the Toolbox form as descriptor version 1, ONLY when the
 *   projection of the mapped record hashes exactly as the K1 record did (so every lock, grant, Allow writes switch
 *   and stored description bound to it stays valid) and its document passes the deployment policy. Anything
 *   else (a host the policy refuses, a field the projection would not give back) stays in K1's form.
 *
 * Pure and idempotent: the first write after an upgrade persists the mapped form.
 */
export function normalizeRegistryFile(file: McpRegistryFile): McpRegistryFile {
  for (const [i, s] of file.servers.entries()) {
    if (s.id === undefined) s.id = legacyEntryId(s.name, s.registeredAt);
    if (s.kind !== 'sql' || s.sql?.driver !== 'postgres') continue;
    const legacy = configOf(s);
    let entry: ToolboxSourceEntry | null;
    try {
      entry = toolboxEntryFromSql(legacy, 1);
    } catch {
      continue; // the policy refuses the mapped document: the record stays as K1 saved it
    }
    if (entry === null) continue;
    const { sql: _sql, ...rest } = s;
    void _sql;
    const mapped: McpServerRecord = { ...rest, kind: 'toolbox-source', toolbox: entry.toolbox, runtime: 'native', tls: entry.tls, descriptorVersion: 1, policyVersion: entry.policyVersion };
    if (sourceDescriptorHash(configOf(mapped)) !== sourceDescriptorHash(legacy)) continue;
    file.servers[i] = mapped;
  }
  return file;
}

/** A deployment-policy refusal as the routes answer it (400 with the policy's code). */
function policyRefusal(err: unknown): unknown {
  if (err instanceof DeploymentPolicyError) return new McpRegistryError(400, err.code, `the Toolbox source document is refused: ${err.message}`);
  return err;
}

/**
 * The disclosure class a save gives a tool (DES-KNOWLEDGE-DATA-001 §5.1): the operator's review when the body
 * gives one; else the class the tool kept while its schema is the one it was reviewed against; else crew's own
 * class for a tool of crew's Toolbox configuration; else none.
 */
export function disclosureOnSave(
  t: { name: string; schemaHash: string },
  was: Pick<McpToolRecord, 'disclosure'> | undefined,
  reviewed: ToolDisclosureClass | undefined,
  kind: McpUpstreamKind,
): ToolDisclosure | null {
  if (reviewed !== undefined) return { class: reviewed, schemaHash: t.schemaHash };
  const prior = was?.disclosure ?? null;
  if (prior !== null && prior.schemaHash === t.schemaHash) return prior;
  const proposed = proposedDisclosure(kind, t.name);
  return proposed === null ? null : { class: proposed, schemaHash: t.schemaHash };
}

/**
 * The agent-safe projection of a server (DES-KNOWLEDGE-DATA-001 §5.2, crew#1310): what an agent-kind bearer and
 * the relay may know. Built from the full view, field by field (an allowlist), so a field added to the full view
 * never reaches an agent by default.
 */
export function agentServerView(s: McpServer): McpServerAgentView {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    enabled: s.enabled,
    health: { state: s.health.state },
    tools: s.tools.filter((t) => t.status !== 'gone').map((t) => ({ name: t.name, subject: t.subject, class: t.class, disclosure: t.disclosure, enabled: t.enabled, status: t.status })),
    ...(s.agents !== undefined ? { agents: { see: s.agents.see, query: s.agents.query } } : {}),
  };
}
