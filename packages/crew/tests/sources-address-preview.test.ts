// crew#1294: preview refusals carry every address, while their human words stay unchanged.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { probeMcpServerWithin } from '../src/mcp/probe.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import { probeRestServer } from '../src/mcp/rest.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { resolveTarget } from '../src/sources/dialer.js';

const resolver = async () => ['::1', '127.0.0.1'];
const addresses = [{ address: '::1', class: 'loopback' }, { address: '127.0.0.1', class: 'loopback' }];
const suggest = ['::1/128', '127.0.0.0/8'];
const words = 'dual.apps.test (::1) is a loopback address, which a source reaches only when the person confirms a range covering it for that source (e.g. ::1/128)';

describe('structured address confirmation', () => {
  it.each(['rest', 'mcp-http', 'graphql', 'sql', 'mysql'] as const)('%s preview keeps its words and names both unconfirmed addresses', async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'address-preview-'));
    const secrets: SecretStore = { available: false, get: async () => null, has: async () => false, set: async () => undefined, delete: async () => undefined };
    const registry = new McpRegistry({ store: new McpRegistryStore(join(dir, 'mcp')), secrets, discover: () => [], probe: (config, secret) => config.kind === 'rest'
      ? probeRestServer(config, secret, { resolver })
      : probeMcpServerWithin(config, secret, { now: Date.now, budgetMs: 1000, retryDelaysMs: [0], sleep: async () => undefined }, { resolver }) });
    const audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    const app = Fastify();
    registerMcpRoutes(app, { registry, audit, actorOf: () => LOCAL_ACTOR });
    try {
      const payload = kind === 'sql' || kind === 'mysql'
        ? { name: 'dual', kind: 'sql', sql: { driver: kind === 'mysql' ? 'mysql' : 'postgres', host: 'dual.apps.test', port: 5432, database: 'apps', user: 'reader', tls: 'verify-full' } }
        : { name: 'dual', kind, url: 'https://dual.apps.test/api', ...(kind === 'rest' ? { openapiUrl: 'https://dual.apps.test/openapi.json' } : {}) };
      const r = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toEqual({ error: `${kind === 'rest' ? 'the OpenAPI document could not be imported' : 'the server did not answer tools/list'}: ${words}`, code: 'address_unconfirmed', addresses, suggest });
    } finally { await app.close(); await audit.flush(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('includes only unconfirmed addresses and preserves the first refusal', async () => {
    await expect(resolveTarget('dual.apps.test', { allow: ['::1/128'], plaintext: false }, resolver)).rejects.toMatchObject({ addresses: [addresses[1]], suggest: [suggest[1]] });
    await expect(resolveTarget('dual.apps.test', { allow: [], plaintext: false }, async () => ['169.254.169.254', '127.0.0.1'])).rejects.toMatchObject({ code: 'address_refused' });
    await expect(resolveTarget('dual.apps.test', { allow: [], plaintext: false }, async () => ['127.0.0.1', '169.254.169.254'])).rejects.toMatchObject({ code: 'address_unconfirmed', addresses: [addresses[1]] });
  });
});
