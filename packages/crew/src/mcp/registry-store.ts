/**
 * The MCP tools registry at rest (DES-MCP-TOOLS-001 §5): `<state home>/mcp/registry.json`.
 *
 * It holds upstreams and their tools with secret REFERENCES only; a value never lands here (D-2).
 * The `mcp` entry is registered in the state-home fence registry (tests/fixtures/
 * state-home-subtrees.json, core's `src/state_home.rs`), so a worker can't read it. The directory
 * is created on the first save, never at boot.
 *
 * Writes are serialized on one promise chain and land atomically (write a sibling temp file,
 * then rename), so a crash never leaves a torn registry. A registry that does not parse is an
 * error the routes answer 503; it is never silently replaced by an empty one, because that
 * would drop every server the operator registered.
 *
 * (DES-KNOWLEDGE-DATA-001 §5.5) Generations. The file carries a `generation` counter. Each write
 * keeps the file it replaces as `registry.json.<its generation>` (a hard link, in the same fenced
 * directory), then renames the new one over it, and keeps the last {@link GENERATIONS_KEPT}. A
 * restore (`McpRegistry.restore`) reads one of them back and reconciles it; nothing here judges it.
 */

import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { McpAuthConfig, McpHealth, McpRestMapping, McpToolAnnotations, McpToolClass, McpUpstreamKind } from '../core/types.js';
import type { DescriptorVersion, PmMarker, RetiredTracker, SourceAgentAccess, SourceRuntime, SourceTls, StoredTracker, ToolBinding, ToolboxSourceDocument, ToolDisclosure } from '../knowledge/registry/entry.js';
import { crewStateHome } from '../projects/state-home.js';
import type { AddressPolicy } from '../sources/dialer.js';
import type { SqlSourceConfig } from '../sources/kinds.js';

export const MCP_STATE_DIRNAME = 'mcp';
export const MCP_REGISTRY_FILENAME = 'registry.json';
/** (DES-KNOWLEDGE-DATA-001 §5.5) How many earlier generations of the registry are kept. */
export const GENERATIONS_KEPT = 10;
const GENERATION_FILE_RE = /^registry\.json\.([1-9][0-9]{0,15})$/;

/** `<state home>/mcp` — the one directory the MCP slices write under. */
export function mcpStateDir(): string {
  return join(crewStateHome(), 'mcp');
}

export interface McpToolRecord {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  annotations: McpToolAnnotations | null;
  classOverride: McpToolClass | null;
  enabled: boolean;
  /** The hash the operator saved (registered); `null` = never registered (a tool added after the preview). */
  schemaHash: string | null;
  /** The hash the last probe saw; differs from `schemaHash` when the schema changed. */
  observedSchemaHash: string;
  /** `false` = the last probe no longer lists the tool (`gone`, kept so old records resolve). */
  present: boolean;
  /** A `rest` tool's request mapping (slice S5a); absent/`null` for an MCP server's tool. */
  rest?: McpRestMapping | null;
  /**
   * (DES-KNOWLEDGE-DATA-001 §5.1, §7.1) What the tool's answer discloses, reviewed at preview and bound to the
   * schema hash it was reviewed against (`effectiveDisclosure`). Absent/`null` = never reviewed: the gate offers
   * the tool to no agent.
   */
  disclosure?: ToolDisclosure | null;
  /**
   * (DES-PM-001 §3, §3.1) PM entries only: crew's resource binding for the tool, bound to the schema hash it was
   * reviewed against. Absent/`null` = unbound: the gate offers the tool to no agent.
   */
  binding?: ToolBinding | null;
}

export interface McpServerRecord {
  /**
   * (DES-KNOWLEDGE-DATA-001 §5.1) The entry's immutable id: estate's source documents, `deps`, grants and records
   * key on it. Every record read through `McpRegistry` has one (a record from before ids gets a derived one, which
   * the next write persists).
   */
  id?: string;
  name: string;
  kind: McpUpstreamKind;
  command: string | null;
  args: string[];
  url: string | null;
  auth: McpAuthConfig | null;
  /** `rest` only (slice S5a): the OpenAPI URL, or the pasted document; the operations picked. */
  openapiUrl?: string | null;
  openapi?: Record<string, unknown> | null;
  operations?: string[] | null;
  /**
   * `rest` only (G2): the origin the operator confirmed with `allowOrigin` (a base URL that
   * matches none of the spec's `servers`, or a private address). Kept while the server still goes
   * there, so a re-save over it does not ask again.
   */
  allowedOrigin?: string;
  /**
   * (DES-APPS-001 §5.2) The ranges the person confirmed for this server's connections (`mcp-http`,
   * `rest`). Every save writes it; a record without it predates the dialer and gets only what is
   * safe to re-derive (`registry.ts` legacyAddress).
   */
  address?: AddressPolicy;
  /** (DES-APPS-001 §5.1) `sql` only: driver and connection settings (no secret). */
  sql?: SqlSourceConfig;
  /** `sql` only: the views a read may name. */
  viewsAllowed?: string[];
  /**
   * (DES-APPS-001 §7.4) Postgres `sql` only: the Allow writes switch. `false` on every new source;
   * changed only by a human operator (`PUT /sources/:name/allow-writes`). Not part of the descriptor.
   */
  allowWrites?: boolean;
  /**
   * (DES-KNOWLEDGE-DATA-001 §5.1) `toolbox-source` only: Toolbox's own source document (secrets as the
   * `"${WICKED_SRC_1}"` placeholder naming `auth.ref`), its runtime, its TLS choice, its descriptor version and
   * the deployment policy it was checked under. Such a record has no `sql`: the registry's read path projects it.
   */
  toolbox?: ToolboxSourceDocument;
  runtime?: SourceRuntime;
  tls?: SourceTls;
  descriptorVersion?: DescriptorVersion;
  policyVersion?: string;
  /**
   * (DES-KNOWLEDGE-DATA-001 §7.1) Data sources only: who among the agents may use it. Absent = the defaults (see
   * on, query off, no project). Changed by a human operator only. Not part of the descriptor; "query" is turned
   * off again by a descriptor change and by a restore.
   */
  agents?: SourceAgentAccess;
  /**
   * (DES-PM-001 §3) `mcp-http` / `mcp-stdio` only: this entry is a project-management system's own MCP server. Set at
   * registration by a human operator. Its calls go through the data gate (resource bindings), never the plain path.
   */
  pm?: PmMarker;
  /** (DES-PM-001 §3) PM entries only: the trackers linked to projects or repos. Written only by the tracker-links routes. */
  trackers?: StoredTracker[];
  /** (DES-PM-001 §3.4) PM entries only: trackers whose last link went, kept until estate takes their empty generation. */
  retired?: RetiredTracker[];
  enabled: boolean;
  health: McpHealth;
  registeredAt: string;
  updatedAt: string;
  tools: McpToolRecord[];
}

export interface McpRegistryFile {
  version: 1;
  /** (DES-KNOWLEDGE-DATA-001 §5.5) Bumped by every write; absent = 0 (a file from before generations). */
  generation?: number;
  servers: McpServerRecord[];
}

/** One kept generation of the registry. */
export interface McpRegistryGeneration {
  generation: number;
  /** When that generation was written (the kept file's modification time). */
  savedAt: string;
}

export class McpRegistryCorruptError extends Error {}

export class McpRegistryStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string = mcpStateDir()) {}

  get path(): string {
    return join(this.dir, MCP_REGISTRY_FILENAME);
  }

  /** The directory the registry lives in (its sibling stores live beside it). */
  get directory(): string {
    return this.dir;
  }

  async read(): Promise<McpRegistryFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, servers: [] };
      throw err;
    }
    return parseRegistry(text, this.path);
  }

  /** The kept generations, newest first (DES-KNOWLEDGE-DATA-001 §5.5). */
  async generations(): Promise<McpRegistryGeneration[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: McpRegistryGeneration[] = [];
    for (const n of names) {
      const m = GENERATION_FILE_RE.exec(n);
      if (m === null) continue;
      try {
        out.push({ generation: Number(m[1]), savedAt: (await stat(join(this.dir, n))).mtime.toISOString() });
      } catch {
        // pruned while listing
      }
    }
    return out.sort((a, b) => b.generation - a.generation);
  }

  /**
   * One kept generation, parsed. `null` = no such generation; a generation that does not parse throws
   * {@link McpRegistryCorruptError} (a restore of it is refused, and nothing changes).
   */
  async readGeneration(generation: number): Promise<McpRegistryFile | null> {
    if (!Number.isSafeInteger(generation) || generation < 1) return null;
    const path = join(this.dir, `${MCP_REGISTRY_FILENAME}.${generation}`);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return parseRegistry(text, path);
  }

  /** Resolves once every mutation queued so far has landed (or failed). Never awaited from inside a mutation. */
  settled(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  /** Read, apply `fn`, write back, one mutation at a time. `fn`'s result is returned. */
  mutate<T>(fn: (file: McpRegistryFile) => T | Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const file = await this.read();
      const result = await fn(file);
      await this.write(file);
      return result;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async write(file: McpRegistryFile): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // The generation on disk now. A file from before generations counts as generation 1 (kept as
    // `registry.json.1`); no file at all is 0 (nothing to keep).
    const current = await this.currentGeneration();
    file.generation = current + 1;
    const tmp = join(this.dir, `${MCP_REGISTRY_FILENAME}.tmp-${randomUUID()}`);
    try {
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      // The file being replaced is kept as its generation BEFORE the rename, so no write loses the one before it.
      if (current > 0) await this.keep(current);
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    // The write has COMMITTED: pruning is housekeeping, so its failure is never the write's (a save that
    // reported failure here would roll its secret back under a record that already landed). The next write
    // prunes again.
    await this.prune(file.generation).catch(() => undefined);
  }

  private async currentGeneration(): Promise<number> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    const g = parseRegistry(text, this.path).generation;
    return typeof g === 'number' && Number.isSafeInteger(g) && g >= 1 ? g : 1;
  }

  /** Keep the current file as `registry.json.<generation>`: a hard link (same directory), else a copy. */
  private async keep(generation: number): Promise<void> {
    const target = join(this.dir, `${MCP_REGISTRY_FILENAME}.${generation}`);
    await rm(target, { force: true });
    try {
      await link(this.path, target);
    } catch {
      await copyFile(this.path, target);
    }
  }

  /** Drop kept generations beyond the last {@link GENERATIONS_KEPT} before `newest`. */
  private async prune(newest: number): Promise<void> {
    for (const g of await this.generations()) {
      if (g.generation < newest - GENERATIONS_KEPT) await rm(join(this.dir, `${MCP_REGISTRY_FILENAME}.${g.generation}`), { force: true });
    }
  }
}

function parseRegistry(text: string, path: string): McpRegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpRegistryCorruptError(`${path} is not valid JSON; fix or remove it`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new McpRegistryCorruptError(`${path} is not a version 1 MCP registry`);
  const file = parsed as Partial<McpRegistryFile>;
  if (file.version !== 1 || !Array.isArray(file.servers) || !file.servers.every((s) => typeof s === 'object' && s !== null && typeof (s as { name?: unknown }).name === 'string')) {
    throw new McpRegistryCorruptError(`${path} is not a version 1 MCP registry`);
  }
  return file as McpRegistryFile;
}
