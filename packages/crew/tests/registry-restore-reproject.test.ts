// crew#1328 item 3: a restored registry generation changes what estate must hold for a source (its descriptor and
// allowed views) with no catalog written, so `catalogs.onWritten` never fires; the visible set then hid the source
// until the next describe or boot. The registry now names every source a restore commits (`onSourceChanged`), and
// the daemon re-projects it. An ordinary MCP server is not a source and is not named.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { removeScratch } from './setup/scratch.js';

const noSecrets: SecretStore = { available: true, get: async () => null, has: async () => false, set: async () => undefined, delete: async () => undefined };

const stamp = '2026-11-04T00:00:00.000Z';
const health = { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null };

function sourceRecord(name: string): Record<string, unknown> {
  return {
    id: '3f0c9a1e-0000-4000-8000-000000132801',
    name,
    kind: 'toolbox-source',
    runtime: 'toolbox',
    command: null,
    args: [],
    url: null,
    auth: null,
    toolbox: { kind: 'source', type: 'postgres', host: '127.0.0.1', port: '55431', user: 'reader', password: '${WICKED_SRC_1}', database: 'support' },
    address: { allow: ['127.0.0.0/8'], plaintext: false },
    tls: { mode: 'disable', ca: null },
    descriptorVersion: 2,
    policyVersion: 'postgres/1@toolbox-v1.15.0',
    enabled: true,
    health,
    registeredAt: stamp,
    updatedAt: stamp,
    tools: [],
  };
}

function serverRecord(name: string): Record<string, unknown> {
  return { name, kind: 'mcp-stdio', command: process.execPath, args: [], url: null, auth: null, enabled: true, health, registeredAt: stamp, updatedAt: stamp, tools: [] };
}

describe('a registry restore names the sources it committed, for re-projection (crew#1328)', () => {
  let base: string | undefined;
  afterEach(() => {
    if (base !== undefined) removeScratch(base);
    base = undefined;
  });

  it('every restored source is named once the restore has landed; an ordinary server is not', async () => {
    base = mkdtempSync(join(tmpdir(), 'reproject-'));
    const dir = join(base, 'mcp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({ version: 1, servers: [sourceRecord('support-pg'), serverRecord('fx')] }));
    const store = new McpRegistryStore(dir);
    const registry = new McpRegistry({ store, secrets: noSecrets, probe: probeMcpServer, discover: () => [] });
    // A later write keeps this file as generation 1.
    await registry.setServerEnabled('fx', false);
    const named: Array<{ name: string; fxEnabledOnDisk: boolean }> = [];
    registry.onSourceChanged = (name) => {
      // Read synchronously as the listener runs: the restore has already landed (generation 1 had fx enabled).
      const onDisk = JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8')) as { servers: Array<{ name: string; enabled: boolean }> };
      named.push({ name, fxEnabledOnDisk: onDisk.servers.find((s) => s.name === 'fx')?.enabled === true });
      throw new Error('a listener failure is its own');
    };
    const plan = await registry.planRestore(1);
    const out = await registry.restore(plan);
    expect(out.servers).toBe(2);
    // Named once, after the commit: what the projector reads then is the restored registry.
    expect(named).toEqual([{ name: 'support-pg', fxEnabledOnDisk: true }]);
  });
});
