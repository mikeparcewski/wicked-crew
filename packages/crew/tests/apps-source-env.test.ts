// SPDX-License-Identifier: MIT
// (chat-extend CX1 review P1) A stdio MCP server's non-secret `env` decides where a call goes, so it must
// be part of the Apps source descriptor the lock pins and the write grant binds to. Without it, an env-only
// change keeps a stale lock and write grant valid for a different execution target.

import { describe, expect, it } from 'vitest';

import { appSourceDescriptor, pinOf } from '../src/apps/exec/sources.js';
import type { McpUpstreamConfig } from '../src/mcp/probe.js';

const stdio = (env?: Record<string, string>): McpUpstreamConfig => ({
  name: 'ref',
  kind: 'mcp-stdio',
  command: 'node',
  args: ['server.mjs'],
  url: null,
  auth: { ref: 'env:X', env: 'TOKEN' },
  ...(env !== undefined ? { env } : {}),
});

describe('appSourceDescriptor binds the non-secret env (CX1 review)', () => {
  it('an env-only change changes the descriptor hash; the same env is stable', () => {
    const none = pinOf(stdio()).descriptorHash;
    const a = pinOf(stdio({ LOG_LEVEL: 'debug' })).descriptorHash;
    const b = pinOf(stdio({ LOG_LEVEL: 'info' })).descriptorHash;
    const aAgain = pinOf(stdio({ LOG_LEVEL: 'debug' })).descriptorHash;
    expect(new Set([none, a, b]).size).toBe(3);
    expect(aAgain).toBe(a);
    // The fingerprint is order-independent (names and values, sorted).
    const order1 = pinOf(stdio({ A: '1', B: '2' })).descriptorHash;
    const order2 = pinOf(stdio({ B: '2', A: '1' })).descriptorHash;
    expect(order2).toBe(order1);
    // A value change alone (same name) is a different target too.
    expect(appSourceDescriptor(stdio({ A: '1' }))).not.toEqual(appSourceDescriptor(stdio({ A: '2' })));
  });

  it("the write grant is withdrawn on recheck: the grant's pinned hash no longer matches the source pin", () => {
    // The write path binds a grant to pinOf(config).descriptorHash and, on prepare/run, refuses when
    // `pinOf(current.config).descriptorHash !== source.pin.descriptorHash` (apps/actions/write-path.ts).
    const grantedConfig = stdio({ LOG_LEVEL: 'debug' });
    const grant = { descriptorHash: pinOf(grantedConfig).descriptorHash };

    // Same env on recheck: the grant still holds.
    const unchanged = pinOf(stdio({ LOG_LEVEL: 'debug' })).descriptorHash;
    expect(unchanged === grant.descriptorHash).toBe(true);

    // An env-only re-save: the source pin changes, so the recheck withdraws the grant.
    const afterEnvChange = pinOf(stdio({ LOG_LEVEL: 'info' })).descriptorHash;
    expect(afterEnvChange !== grant.descriptorHash).toBe(true);
  });
});
