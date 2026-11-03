// The real databases the Apps source tests run against (DES-APPS-001 §13 K1): Postgres 16 and 17 and
// MySQL 8, as CI service containers (job `sources-db`) or local containers. Each test file creates a
// FRESH database per run, seeds it from tests/fixtures/apps-sources/, and drops it after.
//
// APPS_PG16_URL / APPS_PG17_URL / APPS_MYSQL8_URL name the admin connection. Without them the tests
// skip and say why; WICKED_SOURCES_DB=required (CI) turns a missing database into a failure.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConnection } from 'mysql2/promise';
import postgres from 'postgres';

import type { Resolver } from '../../src/sources/dialer.js';

export const DB_REQUIRED = process.env['WICKED_SOURCES_DB'] === 'required';
const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'apps-sources');

export interface DbTarget {
  label: string;
  url: URL;
  /** The server major version the target must be (checked against the live server). */
  major: number;
}

/** With WICKED_SOURCES_DB=required every declared target must be set: one missing is a failure, not a smaller run. */
function targets(pairs: Array<[string, string, number]>): DbTarget[] {
  return pairs.flatMap(([label, env, major]) => {
    const v = process.env[env];
    if (v === undefined || v === '') {
      if (DB_REQUIRED) throw new Error(`WICKED_SOURCES_DB=required, but ${env} (${label}) is not set`);
      return [];
    }
    return [{ label, url: new URL(v), major }];
  });
}

export const PG_TARGETS = targets([
  ['postgres 16', 'APPS_PG16_URL', 16],
  ['postgres 17', 'APPS_PG17_URL', 17],
]);
export const MYSQL_TARGETS = targets([['mysql 8', 'APPS_MYSQL8_URL', 8]]);

/** Every source connection in the tests goes through the dialer by this NAME; the resolver counts dials. */
export const DB_HOST = 'db.apps.test';

export function countingResolver(): Resolver & { calls: number } {
  const r = (async (host: string) => {
    r.calls++;
    return host === DB_HOST ? ['127.0.0.1'] : [];
  }) as Resolver & { calls: number };
  r.calls = 0;
  return r;
}

export const LOOPBACK = { allow: ['127.0.0.0/8'], plaintext: false };

export interface FreshPg {
  database: string;
  port: number;
  admin: postgres.Sql<Record<string, never>>;
  drop(): Promise<void>;
}

/** A fresh Postgres database seeded from postgres/seed.sql; `admin` is a superuser session on it. */
export async function freshPgDatabase(t: DbTarget): Promise<FreshPg> {
  const base = postgres(t.url.href, { max: 1, onnotice: () => undefined });
  const database = `apps_k1_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await base.unsafe(`CREATE DATABASE ${database}`);
  await base.end();
  const url = new URL(t.url.href);
  url.pathname = `/${database}`;
  const admin = postgres(url.href, { max: 2, onnotice: () => undefined }) as unknown as postgres.Sql<Record<string, never>>;
  const [{ v } = { v: '0' }] = await admin.unsafe<Array<{ v: string }>>("SELECT current_setting('server_version_num') AS v");
  if (Math.floor(Number(v) / 10_000) !== t.major) throw new Error(`${t.label}: the server at ${t.url.host} is version ${v}, not ${t.major}`);
  await admin.unsafe(readFileSync(join(FIX, 'postgres', 'seed.sql'), 'utf8'));
  return {
    database,
    port: Number(t.url.port),
    admin,
    drop: async () => {
      await admin.end({ timeout: 1 });
      const b = postgres(t.url.href, { max: 1, onnotice: () => undefined });
      await b.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await b.end();
    },
  };
}

export interface FreshMysql {
  database: string;
  port: number;
  admin: import('mysql2/promise').Connection;
  drop(): Promise<void>;
}

/** A fresh MySQL database seeded from mysql/seed.sql; `admin` is a root session. */
export async function freshMysqlDatabase(t: DbTarget): Promise<FreshMysql> {
  const admin = await createConnection({ host: t.url.hostname, port: Number(t.url.port), user: decodeURIComponent(t.url.username), password: decodeURIComponent(t.url.password), multipleStatements: true });
  const [ver] = (await admin.query('SELECT VERSION() AS v')) as unknown as [Array<{ v: string }>];
  if (Number(String(ver[0]?.v ?? '0').split('.')[0]) !== t.major) throw new Error(`${t.label}: the server is version ${ver[0]?.v ?? '?'}, not ${t.major}`);
  const database = `apps_k1_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(readFileSync(join(FIX, 'mysql', 'seed.sql'), 'utf8').replace(/\{\{db\}\}/g, database));
  // The read login (users are server-wide: created once, granted per database).
  await admin.query("CREATE USER IF NOT EXISTS 'apps_reader'@'%' IDENTIFIED BY 'apps-reader'");
  await admin.query(`GRANT SELECT ON ${database}.* TO 'apps_reader'@'%'`);
  return {
    database,
    port: Number(t.url.port),
    admin,
    drop: async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`).catch(() => undefined);
      admin.destroy();
    },
  };
}
