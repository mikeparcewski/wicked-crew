/**
 * The two source kinds Apps adds to crew's ONE connector registry (DES-APPS-001 §4, §5.1): `sql`
 * (drivers `postgres`, `mysql`, `sqlite`) and `graphql`. They are registry entries like the MCP and
 * REST servers, saved through the same preview/save (secret staging, human-only confirmations), but
 * they have NO tools: nothing of theirs is ever offered to a governed run.
 *
 * - The CONNECTION DESCRIPTOR is the non-secret identity (driver, host, port, database, login, TLS
 *   mode, url, auth header name, snapshot digest, confirmed ranges). Its hash binds queries, actions
 *   and grants (K2a/K2b). `allowWrites` is NOT part of it (§7.4: reads and their locks are unaffected).
 * - The probe of these kinds is a DESCRIBE: the structural catalog, and for Postgres the privilege
 *   report. No value from a row.
 */

import { createHash } from 'node:crypto';

import type { IntrospectionQuery } from 'graphql';

import { canonicalJson } from '../mcp/classify.js';
import type { McpUpstreamConfig } from '../mcp/probe.js';
import { describeMysql } from './catalog/mysql.js';
import { describePg, type PgPrivilegeReport, pgPrivileges } from './catalog/postgres.js';
import type { SqlCatalog } from './catalog/types.js';
import { addressPolicyOf, type DialOptions, DialRefusedError } from './dialer.js';
import type { SqlConnectArgs, SqlNetworkSource } from './drivers/types.js';
import { sqliteInspect } from './drivers/sqlite.js';
import { describeGraphql, type GraphqlCatalog, type GraphqlSource } from './graphql.js';
import { snapshotPath } from './uploads.js';

/** The built-in `crew` source's reserved name: never a registry entry. */
export const CREW_SOURCE = 'crew';

export type SqlDriver = 'postgres' | 'mysql' | 'sqlite';

/** A `sql` source's connection settings, as the registry stores them (no secret). */
export interface SqlSourceConfig {
  driver: SqlDriver;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  user?: string | null;
  tls?: 'verify-full' | 'disable';
  /** A CA (PEM) for the source's TLS, when it is not signed by a public root. */
  ca?: string | null;
  /** `sqlite`: the snapshot's sha256 (an upload). */
  snapshot?: string | null;
}

export const DEFAULT_PORT: Record<'postgres' | 'mysql', number> = { postgres: 5432, mysql: 3306 };

/** What a source's describe found: structure only. */
export interface SourceDescription {
  catalog: SqlCatalog | GraphqlCatalog;
  /** Postgres: the login's privilege report (no declared writes yet). */
  privileges?: PgPrivilegeReport;
  /** GraphQL: the introspection result, kept so documents can be validated without asking again. */
  introspection?: IntrospectionQuery;
}

/** The non-secret identity of a source. Excludes `allowWrites` by design (DES §7.4). */
export function sourceDescriptor(config: McpUpstreamConfig): Record<string, unknown> {
  const sql = config.sql ?? null;
  return {
    kind: config.kind,
    url: config.url,
    auth: config.auth === null ? null : { ref: config.auth.ref, header: config.auth.header?.toLowerCase() ?? null, prefix: config.auth.prefix ?? null },
    sql: sql === null ? null : { driver: sql.driver, host: sql.host ?? null, port: sql.port ?? null, database: sql.database ?? null, user: sql.user ?? null, tls: sql.tls ?? 'verify-full', ca: sql.ca == null ? null : createHash('sha256').update(sql.ca).digest('hex'), snapshot: sql.snapshot ?? null },
    address: config.address ?? null,
  };
}

/** The descriptor's hash (`sha256` of its canonical JSON): what queries, actions and grants bind to. */
export function sourceDescriptorHash(config: McpUpstreamConfig): string {
  return createHash('sha256').update(canonicalJson(sourceDescriptor(config))).digest('hex');
}

/** Connection arguments for a network SQL source; the password resolved by the caller, at the call. */
export function sqlConnectArgs(config: McpUpstreamConfig, password: string | null, dial: DialOptions = {}): SqlConnectArgs {
  const sql = config.sql;
  if (config.kind !== 'sql' || sql === undefined || sql === null || sql.driver === 'sqlite') throw new Error(`${config.name} is not a network SQL source`);
  const source: SqlNetworkSource = {
    driver: sql.driver,
    host: sql.host ?? '',
    port: sql.port ?? DEFAULT_PORT[sql.driver],
    database: sql.database ?? '',
    user: sql.user ?? '',
    tls: sql.tls ?? 'verify-full',
    ca: sql.ca ?? null,
  };
  return { source, password, policy: addressPolicyOf(config), dial };
}

export function graphqlSource(config: McpUpstreamConfig, dial: DialOptions = {}): GraphqlSource {
  if (config.kind !== 'graphql' || config.url === null) throw new Error(`${config.name} is not a GraphQL source`);
  return { url: config.url, auth: config.auth?.header === undefined ? null : { header: config.auth.header, ...(config.auth.prefix !== undefined ? { prefix: config.auth.prefix } : {}) }, policy: addressPolicyOf(config), dial };
}

/** Describe a `sql` or `graphql` source (its probe). Throws on failure; a dialer refusal keeps its code. */
export async function describeSource(config: McpUpstreamConfig, secret: string | null, dial: DialOptions = {}, snapshotDir?: string): Promise<SourceDescription> {
  if (config.kind === 'graphql') {
    const d = await describeGraphql(graphqlSource(config, dial), secret);
    return { catalog: d.catalog, introspection: d.introspection };
  }
  const sql = config.sql;
  if (config.kind !== 'sql' || sql === undefined || sql === null) throw new Error(`${config.name} is not a source`);
  if (sql.driver === 'sqlite') {
    if (typeof sql.snapshot !== 'string') throw new Error('a sqlite source names its snapshot');
    return { catalog: (await sqliteInspect(snapshotPath(sql.snapshot, snapshotDir))).catalog };
  }
  const args = sqlConnectArgs(config, secret, dial);
  if (sql.driver === 'postgres') {
    const catalog = await describePg(args);
    return { catalog, privileges: await pgPrivileges(args) };
  }
  return { catalog: await describeMysql(args) };
}

export { DialRefusedError };
