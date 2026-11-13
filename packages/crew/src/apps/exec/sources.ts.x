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
import { envFingerprint } from '../../mcp/env.js';
import type { McpUpstreamConfig } from '../../mcp/probe.js';
import type { McpRegistry } from '../../mcp/registry.js';
import { ESTATE_SERVER } from '../../mcp/classify.js';
import { CREW_SOURCE, sourceDescriptor } from '../../sources/kinds.js';
import type { StoredDescription } from '../../sources/store.js';

const sha = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex');

/**
 * The part of crew's connector registry Apps reads to run a query or an action. crew passes its
 * `McpRegistry`; the app server (K6) passes the registry its image carries (the published sources,
 * their secrets from the environment names the manifest lists).
 */
export type AppSourceRegistry = Pick<McpRegistry, 'snapshot' | 'source' | 'appTool' | 'callSecret'>;

/** The non-secret descriptor of any registry source Apps may use. */
export function appSourceDescriptor(config: McpUpstreamConfig): Record<string, unknown> {
  const base = sourceDescriptor(config);
  if (config.kind === 'sql' || config.kind === 'graphql') return base;
  // (CX1 review) The non-secret env of a stdio server decides where the call goes: an env-only change must
  // change the descriptor hash, so a stale lock and write grant are withdrawn on recheck.
  return { ...base, command: config.command, args: [...config.args], openapiUrl: config.openapiUrl ?? null, openapi: config.openapi == null ? null : sha(config.openapi), env: envFingerprint(config.env) };
}

export const CREW_PIN: AppLockSource = (() => {
  const descriptor = { kind: 'crew' };
  return { kind: 'crew', descriptor, descriptorHash: sha(descriptor) };
})();

/** (DES-KNOWLEDGE-DATA-001 §9.1) The system's knowledge, read by `recall` queries: one fixed descriptor. */
export const ESTATE_PIN: AppLockSource = (() => {
  const descriptor = { kind: 'estate' };
  return { kind: 'estate', descriptor, descriptorHash: sha(descriptor) };
})();

export function pinOf(config: McpUpstreamConfig): AppLockSource {
  const descriptor = appSourceDescriptor(config);
  return { kind: config.kind, descriptor, descriptorHash: sha(descriptor) };
}

/** A source resolved for one check, read or write. */
export type AppSource =
  | { name: typeof CREW_SOURCE; kind: 'crew'; pin: AppLockSource }
  | { name: typeof ESTATE_SERVER; kind: 'estate'; pin: AppLockSource }
  | { name: string; kind: 'sql'; pin: AppLockSource; config: McpUpstreamConfig; description: StoredDescription | null; allowWrites: boolean; enabled: boolean }
  | { name: string; kind: 'graphql'; pin: AppLockSource; config: McpUpstreamConfig; description: StoredDescription | null; allowWrites: boolean; enabled: boolean }
  | { name: string; kind: 'rest' | 'mcp-http' | 'mcp-stdio'; pin: AppLockSource; config: McpUpstreamConfig; enabled: boolean };

/** Look a source up now; `null` = no such source in the registry. */
export async function lookupSource(registry: Pick<AppSourceRegistry, 'snapshot' | 'source'> | null, name: string): Promise<AppSource | null> {
  if (name === CREW_SOURCE) return { name: CREW_SOURCE, kind: 'crew', pin: CREW_PIN };
  // Reserved for every registry kind (the broker's relay), so it is never a person's source.
  if (name === ESTATE_SERVER) return { name: ESTATE_SERVER, kind: 'estate', pin: ESTATE_PIN };
  if (registry === null) return null;
  // One read of the store: the config, its kind and (for a tool server) its switch belong together (codex r4).
  const snap = await registry.snapshot(name);
  if (snap === null) return null;
  const config = snap.config;
  if (config.kind === 'sql' || config.kind === 'graphql') {
    // Everything of a data source (its kind included) comes from this one read (codex r5): a save between the
    // two reads cannot pair one record's kind with another's config.
    const s = await registry.source(name);
    const base = { name, pin: pinOf(s.config), config: s.config, description: s.description, allowWrites: s.allowWrites, enabled: s.enabled };
    return s.config.kind === 'sql' ? { ...base, kind: 'sql' } : { ...base, kind: 'graphql' };
  }
  // (DES-KNOWLEDGE-DATA-001 §6.3) A Toolbox-runtime database source is no Apps source in v1 (a native one reads as `sql`).
  if (config.kind === 'toolbox-source') return null;
  // (CS9) The web source is no Apps source: its tools are the data gate's, for agents only.
  if (config.kind === 'web') return null;
  // A server switched off is part of the snapshot for every kind (codex r2 on the write path).
  return { name, kind: config.kind, pin: pinOf(config), config, enabled: snap.enabled };
}

/** Whether a query of `kind` reads a source of this kind. */
export function queryKindFits(kind: AppQueryKind, source: AppSource): boolean {
  if (kind === 'crew') return source.kind === 'crew';
  if (kind === 'recall') return source.kind === 'estate';
  if (kind === 'sql') return source.kind === 'sql';
  if (kind === 'graphql') return source.kind === 'graphql';
  if (kind === 'rest') return source.kind === 'rest';
  return source.kind === 'mcp-http' || source.kind === 'mcp-stdio';
}
