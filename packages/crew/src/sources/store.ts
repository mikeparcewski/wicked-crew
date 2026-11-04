/**
 * Where a source's description lives: `<state home>/mcp/catalogs/<name>.json` (the catalog, the
 * Postgres privilege report, a GraphQL introspection). Structure only — never a row value — but kept
 * out of `registry.json` so the registry every MCP call reads stays small, and inside the `mcp`
 * state-home entry workers are fenced out of. Written atomically (temp file, then rename), 0600.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MCP_SERVER_NAME_RE } from '../mcp/classify.js';
import { mcpStateDir } from '../mcp/registry-store.js';
import type { SourceDescription } from './kinds.js';

export interface StoredDescription extends SourceDescription {
  /** The descriptor hash the description was taken under. */
  descriptorHash: string;
}

export class SourceCatalogStore {
  /**
   * Told the name of each catalog once it is stored (DES-KNOWLEDGE-DATA-001 §4.1: the describe -> estate projector).
   * Called inside the registry mutation that wrote it, so it must not await that mutation; it never throws into it.
   */
  onWritten: ((name: string) => void) | null = null;

  constructor(private readonly dir: string = join(mcpStateDir(), 'catalogs')) {}

  private path(name: string): string {
    if (!MCP_SERVER_NAME_RE.test(name)) throw new Error(`not a source name: ${name}`);
    return join(this.dir, `${name}.json`);
  }

  async read(name: string): Promise<StoredDescription | null> {
    try {
      return JSON.parse(await readFile(this.path(name), 'utf8')) as StoredDescription;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(name: string, d: StoredDescription): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `.${name}.json.tmp-${randomUUID()}`);
    try {
      await writeFile(tmp, `${JSON.stringify(d)}\n`, { mode: 0o600 });
      await rename(tmp, this.path(name));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    try {
      this.onWritten?.(name);
    } catch {
      // The catalog is stored; a listener's failure is its own to report.
    }
  }

  async remove(name: string): Promise<void> {
    await rm(this.path(name), { force: true });
  }
}
