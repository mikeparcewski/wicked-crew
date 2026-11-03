// DES-APPS-001 §5.1 — TLS identity for the SQL drivers, through their production paths (pgDescribe,
// mysqlDescribe): the certificate must chain to the source's CA AND name the host the person gave
// (DNS or IP SAN), even though the bytes go to the dialer's pinned address. Each endpoint speaks just
// enough of its protocol to start TLS (Postgres SSLRequest, MySQL's v10 handshake with CLIENT_SSL),
// then records whether the handshake completed. Certificates are made with openssl at test time (no
// key material in the repo); without openssl these say so and skip. (codex r2 on K1: T1.)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Resolver } from '../src/sources/dialer.js';
import { mysqlDescribe } from '../src/sources/drivers/mysql.js';
import { pgDescribe } from '../src/sources/drivers/postgres.js';
import type { SqlConnectArgs } from '../src/sources/drivers/types.js';

const OPENSSL = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const LOOPBACK = { allow: ['127.0.0.0/8'], plaintext: false };
const resolver: Resolver = async (host) => (host.endsWith('.apps.test') ? ['127.0.0.1'] : []);

interface Endpoint {
  port: number;
  /** Handshakes that completed on the server side (the client accepted the certificate). */
  secured: number;
  close: () => Promise<void>;
}

type Dialect = 'postgres' | 'mysql';

/** The MySQL v10 initial handshake, offering TLS (CLIENT_SSL) and protocol 4.1. */
function mysqlGreeting(): Buffer {
  const caps = 0x1 | 0x2 | 0x4 | 0x8 | 0x200 | 0x800 | 0x2000 | 0x8000 | 0x80000 | 0x200000;
  const body = Buffer.concat([
    Buffer.from([0x0a]),
    Buffer.from('8.4.0-tls-probe\0', 'latin1'),
    Buffer.from([1, 0, 0, 0]), // connection id
    Buffer.alloc(8, 0x61), // auth data part 1
    Buffer.from([0]),
    Buffer.from([caps & 0xff, (caps >> 8) & 0xff]),
    Buffer.from([0xff]), // utf8mb4
    Buffer.from([0x02, 0x00]), // status: autocommit
    Buffer.from([(caps >> 16) & 0xff, (caps >> 24) & 0xff]),
    Buffer.from([21]),
    Buffer.alloc(10, 0),
    Buffer.concat([Buffer.alloc(12, 0x62), Buffer.from([0])]), // auth data part 2
    Buffer.from('mysql_native_password\0', 'latin1'),
  ]);
  const head = Buffer.from([body.length & 0xff, (body.length >> 8) & 0xff, (body.length >> 16) & 0xff, 0]);
  return Buffer.concat([head, body]);
}

/** A Postgres ErrorResponse (FATAL, SQLSTATE 28000) carrying `message`. */
function pgFatal(message: string): Buffer {
  const fields = Buffer.concat([
    Buffer.from('SFATAL\0VFATAL\0C28000\0', 'latin1'),
    Buffer.from(`M${message}\0`, 'utf8'),
    Buffer.from([0]),
  ]);
  const head = Buffer.alloc(5);
  head.write('E', 0, 'latin1');
  head.writeUInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
}

/** A TCP endpoint that starts TLS the way `dialect`'s server does, with `key`/`cert`. */
async function tlsEndpoint(dialect: Dialect, key: Buffer, cert: Buffer): Promise<Endpoint> {
  const ep = { port: 0, secured: 0 } as Endpoint;
  const sockets = new Set<Socket>();
  const upgrade = (raw: Socket, rest: Buffer): void => {
    if (rest.length > 0) raw.unshift(rest);
    const tls = new TLSSocket(raw, { isServer: true, key, cert });
    tls.on('secure', () => {
      ep.secured++;
      // Enough: the client accepted the certificate. Postgres gets a FATAL ErrorResponse, so the
      // driver settles at once instead of trying the connection again; MySQL is simply hung up on.
      if (dialect === 'postgres') tls.end(pgFatal('tls probe: the handshake completed'));
      else tls.destroy();
    });
    tls.on('error', () => raw.destroy());
  };
  const server: Server = createServer((raw) => {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    // Postgres: the client opens with an 8-byte SSLRequest; MySQL: the server speaks first, then the
    // client answers with a 4-byte header plus a 32-byte SSLRequest.
    const need = dialect === 'postgres' ? 8 : 36;
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < need) return;
      raw.off('data', onData);
      raw.pause();
      if (dialect === 'postgres') raw.write('S');
      upgrade(raw, buf.subarray(need));
    };
    raw.on('data', onData);
    if (dialect === 'mysql') raw.write(mysqlGreeting());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  ep.port = (server.address() as AddressInfo).port;
  ep.close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return ep;
}

describe.skipIf(!OPENSSL)('SQL TLS identity: the certificate must name the host the person gave (DNS or IP SAN), through the drivers', () => {
  let dir = '';
  let ca = '';
  const leaf: Record<string, { key: Buffer; cert: Buffer }> = {};
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sources-tls-'));
    const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=sources tls test CA']);
    for (const [name, san] of [
      ['dns', 'DNS:db.apps.test'],
      ['ip', 'IP:127.0.0.1'],
      ['ip2', 'IP:127.0.0.2'],
    ] as const) {
      run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`]);
      writeFileSync(join(dir, `${name}.cnf`), `subjectAltName=${san}\n`);
      run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.cnf`]);
      leaf[name] = { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) };
    }
    ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const args = (driver: Dialect, host: string, port: number, withCa = true): SqlConnectArgs => ({
    source: { driver, host, port, database: 'd', user: 'u', tls: 'verify-full', ...(withCa ? { ca } : {}) },
    password: 'p',
    policy: LOOPBACK,
    dial: { resolver },
  });
  const describeWith = (driver: Dialect, a: SqlConnectArgs): Promise<unknown> => (driver === 'postgres' ? pgDescribe(a, 'SELECT 1') : mysqlDescribe(a, 'SELECT 1'));
  const IDENTITY = /altname|Hostname\/IP|does not match|not in the cert|IP: 127\.0\.0\.1 is not/i;

  for (const driver of ['postgres', 'mysql'] as const) {
    it(`${driver}: a matching DNS SAN passes TLS; another name on the same certificate and address is refused`, async () => {
      const ep = await tlsEndpoint(driver, leaf['dns']!.key, leaf['dns']!.cert);
      try {
        // The handshake completes (the endpoint then hangs up: the failure after it is not about TLS).
        const ok = await describeWith(driver, args(driver, 'db.apps.test', ep.port)).catch((e: unknown) => e);
        expect(String(ok)).not.toMatch(IDENTITY);
        expect(ep.secured).toBeGreaterThan(0);
        const before = ep.secured;
        const other = await describeWith(driver, args(driver, 'other.apps.test', ep.port)).catch((e: unknown) => e);
        expect(String((other as Error).message)).toMatch(IDENTITY);
        expect(ep.secured).toBe(before); // no handshake completed under the other name
      } finally {
        await ep.close();
      }
    });

    it(`${driver}: an IP SAN must be the IP the person gave; an unknown CA is refused`, async () => {
      const ok = await tlsEndpoint(driver, leaf['ip']!.key, leaf['ip']!.cert);
      const wrong = await tlsEndpoint(driver, leaf['ip2']!.key, leaf['ip2']!.cert);
      try {
        const first = await describeWith(driver, args(driver, '127.0.0.1', ok.port)).catch((e: unknown) => e);
        expect(String(first)).not.toMatch(IDENTITY);
        expect(ok.secured).toBeGreaterThan(0);
        const okBefore = ok.secured;
        const mismatch = await describeWith(driver, args(driver, '127.0.0.1', wrong.port)).catch((e: unknown) => e);
        expect(String((mismatch as Error).message)).toMatch(IDENTITY);
        expect(wrong.secured).toBe(0);
        // Without the source's CA, the system roots do not know this one.
        const noCa = await describeWith(driver, args(driver, '127.0.0.1', ok.port, false)).catch((e: unknown) => e);
        expect(String((noCa as Error).message)).toMatch(/self[- ]signed|unable to (get|verify)|certificate/i);
        expect(ok.secured).toBe(okBefore);
      } finally {
        await ok.close();
        await wrong.close();
      }
    });
  }
});
