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
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { McpAuthConfig, McpHealth, McpToolAnnotations, McpToolClass, McpUpstreamKind } from '../core/types.js';
import { crewStateHome } from '../projects/state-home.js';

export const MCP_STATE_DIRNAME = 'mcp';
export const MCP_REGISTRY_FILENAME = 'registry.json';

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
}

export interface McpServerRecord {
  name: string;
  kind: McpUpstreamKind;
  command: string | null;
  args: string[];
  url: string | null;
  auth: McpAuthConfig | null;
  enabled: boolean;
  health: McpHealth;
  registeredAt: string;
  updatedAt: string;
  tools: McpToolRecord[];
}

export interface McpRegistryFile {
  version: 1;
  servers: McpServerRecord[];
}

export class McpRegistryCorruptError extends Error {}

export class McpRegistryStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string = mcpStateDir()) {}

  get path(): string {
    return join(this.dir, MCP_REGISTRY_FILENAME);
  }

  async read(): Promise<McpRegistryFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, servers: [] };
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new McpRegistryCorruptError(`${this.path} is not valid JSON; fix or remove it`);
    }
    const file = parsed as Partial<McpRegistryFile>;
    if (file.version !== 1 || !Array.isArray(file.servers)) {
      throw new McpRegistryCorruptError(`${this.path} is not a version 1 MCP registry`);
    }
    return file as McpRegistryFile;
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
    const tmp = join(this.dir, `${MCP_REGISTRY_FILENAME}.tmp-${randomUUID()}`);
    try {
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}
