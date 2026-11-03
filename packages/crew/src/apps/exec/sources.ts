/**
 * A source as Apps sees it (DES-APPS-001 §4 "Source", §7.2 step 4): its kind, its connection descriptor and
 * that descriptor's hash (what the lock pins and what a grant and an action record bind to), read from
 * crew's ONE connector registry, or the built-in `crew` source.
 *
 * The descriptor of a `sql` or `graphql` source is K1's (`sourceDescriptor`: driver, host, port, database,
 * login, TLS, url, auth header name, snapshot digest, confirmed ranges; never Allow writes). A REST or MCP
 * server's adds what decides where a call goes that K1's leaves out: the command and arguments of a local
 * MCP server, and a REST server's OpenAPI location.
 */

import { createHash } from 'node:crypto';

import type { AppLockSource, AppQueryKind } from '../../core/types.js';
import { canonicalJson } from '../../mcp/classify.js';
import type { McpUpstreamConfig } from '../../mcp/probe.js';
import type { McpRegistry } from '../../mcp/registry.js';
import { CREW_SOURCE, sourceDescriptor } from '../../sources/kinds.js';
import type { StoredDescription } from '../../sources/store.js';

const sha = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex');

/** The non-secret descriptor of any registry source Apps may use. */
export function appSourceDescriptor(config: McpUpstreamConfig): Record<string, unknown> {
  const base = sourceDescriptor(config);
  if (config.kind === 'sql' || config.kind === 'graphql') return base;
  return { ...base, command: config.command, args: [...config.args], openapiUrl: config.openapiUrl ?? null, openapi: config.openapi == null ? null : sha(config.openapi) };
}

export const CREW_PIN: AppLockSource = (() => {
  const descriptor = { kind: 'crew' };
  return { kind: 'crew', descriptor, descriptorHash: sha(descriptor) };
})();

export function pinOf(config: McpUpstreamConfig): AppLockSource {
  const descriptor = appSourceDescriptor(config);
  return { kind: config.kind, descriptor, descriptorHash: sha(descriptor) };
}

/** A source resolved for one check, read or write. */
export type AppSource =
  | { name: typeof CREW_SOURCE; kind: 'crew'; pin: AppLockSource }
  | { name: string; kind: 'sql'; pin: AppLockSource; config: McpUpstreamConfig; description: StoredDescription | null; allowWrites: boolean }
  | { name: string; kind: 'graphql'; pin: AppLockSource; config: McpUpstreamConfig; description: StoredDescription | null; allowWrites: boolean }
  | { name: string; kind: 'rest' | 'mcp-http' | 'mcp-stdio'; pin: AppLockSource; config: McpUpstreamConfig };

/** Look a source up now; `null` = no such source in the registry. */
export async function lookupSource(registry: McpRegistry | null, name: string): Promise<AppSource | null> {
  if (name === CREW_SOURCE) return { name: CREW_SOURCE, kind: 'crew', pin: CREW_PIN };
  if (registry === null) return null;
  const config = await registry.inspectTarget(name);
  if (config === null) return null;
  if (config.kind === 'sql' || config.kind === 'graphql') {
    const s = await registry.source(name);
    const base = { name, pin: pinOf(s.config), config: s.config, description: s.description, allowWrites: s.allowWrites };
    return config.kind === 'sql' ? { ...base, kind: 'sql' } : { ...base, kind: 'graphql' };
  }
  return { name, kind: config.kind, pin: pinOf(config), config };
}

/** Whether a query of `kind` reads a source of this kind. */
export function queryKindFits(kind: AppQueryKind, source: AppSource): boolean {
  if (kind === 'crew') return source.kind === 'crew';
  if (kind === 'sql') return source.kind === 'sql';
  if (kind === 'graphql') return source.kind === 'graphql';
  if (kind === 'rest') return source.kind === 'rest';
  return source.kind === 'mcp-http' || source.kind === 'mcp-stdio';
}
