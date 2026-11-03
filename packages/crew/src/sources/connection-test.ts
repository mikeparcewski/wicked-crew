/**
 * "Test connection" on a saved source (operator 2026-11-03): connect, describe and the read-policy
 * check again, with the saved credentials resolved now. It replaces "Describe again": the fresh
 * description is saved, as a describe saves it.
 *
 * - SQL (Postgres, MySQL): the dialer, then the catalog and (Postgres) the privilege report: whether
 *   the login is read-only or the tables it can change. SQLite (an upload): the snapshot opens.
 *   GraphQL: introspection.
 * - SQL: then the read-policy check of a probe read of one table (`SELECT count(*) …`): the policy,
 *   then prepare at the source. Never executed: no row is read.
 * - A failure is a result the person reads (with its time), not a transport error. The source's own
 *   words go to a human only, scrubbed of the secret; an agent gets crew's code. No answer carries the
 *   secret.
 */

import type { SourceConnectionTestResponse } from '../core/types.js';
import type { McpUpstreamConfig } from '../mcp/probe.js';
import { McpRegistryError, type McpRegistry } from '../mcp/registry.js';
import { scrubSecrets } from '../mcp/secrets.js';
import type { SqlCatalog } from './catalog/types.js';
import { type DialOptions, DialRedirectRefusedError, DialRefusedError } from './dialer.js';
import { SourceQueryError } from './drivers/types.js';
import { describeSource, sqlConnectArgs } from './kinds.js';
import { checkSqlQuery, type SqlSourceHandle } from './sql.js';
import { snapshotPath } from './uploads.js';

/** The read the test checks (never runs): a count of one base table, quoted for the dialect. */
export function probeRead(catalog: SqlCatalog): { text: string; relation: string } | null {
  const r = catalog.relations.find((x) => x.kind === 'table' || x.kind === 'partitioned');
  if (r === undefined) return null;
  const dq = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  const bq = (s: string): string => `\`${s.replace(/`/g, '``')}\``;
  const relation = r.schema === null ? r.name : `${r.schema}.${r.name}`;
  if (catalog.dialect === 'mysql') return { text: `SELECT count(*) AS n FROM ${r.schema === null ? '' : `${bq(r.schema)}.`}${bq(r.name)}`, relation };
  if (catalog.dialect === 'sqlite') return { text: `SELECT count(*) AS n FROM ${dq(r.name)}`, relation };
  return { text: `SELECT count(*) AS n FROM ${dq(r.schema ?? 'public')}.${dq(r.name)}`, relation };
}

/** How the connection was made, from the mode it succeeded under. */
function tlsOf(config: McpUpstreamConfig): SourceConnectionTestResponse['tls'] {
  if (config.kind === 'graphql') return (config.url ?? '').toLowerCase().startsWith('https:') ? 'verified' : 'off';
  if (config.sql?.driver === 'sqlite') return 'local';
  return (config.sql?.tls ?? 'verify-full') === 'verify-full' ? 'verified' : 'off';
}

/** A failure as the person (or an agent) reads it: crew's code, and words. */
export function testFailure(err: unknown, human: boolean, secrets: readonly string[]): { code: string; error: string } {
  const say = (words: string, fixed: string): string => (human ? scrubSecrets(words, [...secrets]) : fixed);
  if (err instanceof McpRegistryError) return { code: err.code, error: scrubSecrets(err.message, [...secrets]) };
  if (err instanceof DialRefusedError) {
    const where = err instanceof DialRedirectRefusedError && err.location !== null ? ` (to ${err.location})` : '';
    return { code: err.code, error: say(`${err.message}${where}`, `the connection was refused (${err.code})`) };
  }
  if (err instanceof SourceQueryError) {
    const code = err.refusal ?? (err.errorClass === 'refused' ? 'refused' : `source_${err.errorClass}`);
    return { code, error: say(err.message, `the source answered ${err.errorClass}${err.sqlstate !== null ? ` (SQLSTATE ${err.sqlstate})` : ''}`) };
  }
  return { code: 'test_failed', error: say(err instanceof Error ? err.message : String(err), 'the test failed') };
}

export interface ConnectionTestDeps {
  registry: McpRegistry;
  dial: DialOptions;
  snapshotDir?: string;
  now?: () => Date;
}

/** Test one saved `sql` or `graphql` source now. Throws only for no such source (404) or not a source (400). */
export async function testConnection(deps: ConnectionTestDeps, name: string, human: boolean): Promise<SourceConnectionTestResponse> {
  const { registry: r } = deps;
  const src = await r.source(name);
  const config = src.config;
  const kind = config.kind as 'sql' | 'graphql';
  const driver = config.sql?.driver ?? null;
  const tls = tlsOf(config);
  const testedAt = (deps.now ?? (() => new Date()))().toISOString();
  const started = Date.now();
  let secrets: string[] = [];
  try {
    const { secret, missing } = await r.callSecret(config);
    if (missing) throw new McpRegistryError(409, 'secret_missing', `${config.auth?.ref ?? 'the secret'} resolves to no secret: save the source again with its password`);
    secrets = secret === null ? [] : [secret];
    const d = scrubSecrets(await describeSource(config, secret, deps.dial, deps.snapshotDir), secrets);
    const ms = Date.now() - started;
    await r.saveDescription(name, d, src.descriptorHash);
    const catalog = { name, kind, catalog: d.catalog, ...(d.privileges !== undefined ? { privileges: d.privileges } : {}), descriptorHash: src.descriptorHash };
    let readCheck: SourceConnectionTestResponse['readCheck'] = null;
    if (kind === 'sql') {
      const cat = d.catalog as SqlCatalog;
      const probe = probeRead(cat);
      if (probe !== null) {
        const handle: SqlSourceHandle =
          driver === 'sqlite'
            ? { driver: 'sqlite', snapshotPath: snapshotPath(config.sql?.snapshot ?? '', deps.snapshotDir), catalog: cat }
            : { driver: driver === 'mysql' ? 'mysql' : 'postgres', connect: sqlConnectArgs(config, secret, deps.dial), catalog: cat, viewsAllowed: config.viewsAllowed ?? [] };
        const c = await checkSqlQuery(handle, probe.text);
        const fromSource = !c.ok && (c.code === 'prepare' || c.code === 'authorizer');
        readCheck = c.ok
          ? { ok: true, text: probe.text, relation: probe.relation }
          : { ok: false, text: probe.text, relation: probe.relation, code: c.code, detail: fromSource && !human ? `the source refused the read${c.sqlstate != null ? ` (SQLSTATE ${c.sqlstate})` : ''}` : scrubSecrets(c.detail, secrets) };
      }
    }
    return { name, kind, driver, ok: true, ms, testedAt, tls, catalog, readCheck };
  } catch (err) {
    const f = testFailure(err, human, secrets);
    return { name, kind, driver, ok: false, ms: Date.now() - started, testedAt, tls, code: f.code, error: f.error };
  }
}
