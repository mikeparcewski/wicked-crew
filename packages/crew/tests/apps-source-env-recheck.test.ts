// SPDX-License-Identifier: MIT
// (chat-extend CX1 review) The REAL write-path recheck for an mcp-stdio source's non-secret env: an env-only
// change to the source must withdraw a standing write grant and refuse the action with 409 contract_changed
// (the write never reaches the upstream), while re-saving the identical env keeps the grant valid. This drives
// AppWritePath.prepareAction → recheck (packages/crew/src/apps/actions/write-path.ts), not just a hash compare.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppAction, AppDetail } from '../src/core/types.js';
import { appsHarness, type Harness, specWith } from './support/apps-harness.js';

const FIXTURE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'fixture-server.mjs');

const params = { type: 'object' as const, properties: { id: { type: 'integer' as const } }, required: ['id'] };
const ASSIGN: AppAction = {
  id: 'mcp_assign',
  kind: 'api',
  source: 'ref',
  call: { kind: 'tool', tool: 'assign_ticket' },
  args: { id: { kind: 'param', name: 'id' }, owner: { kind: 'literal', value: 'team-b' } },
  params,
};

describe('an mcp-stdio source env change withdraws the write grant on recheck (CX1 review)', () => {
  let h: Harness;
  let specPath: string;
  let version: number;

  const registerRef = (env: Record<string, string>) =>
    h.register({ name: 'ref', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath], env });
  const grant = () => h.call('POST', '/apps/desk/actions/mcp_assign/grant', { version });
  const prepare = (id: number) => h.call('POST', '/apps/desk/actions/mcp_assign/prepare', { version, params: { id } });

  beforeEach(async () => {
    h = await appsHarness();
    const base = mkdtempSync(join(tmpdir(), 'apps-env-recheck-'));
    specPath = join(base, 'spec.json');
    // A single write tool (not readOnly) the Apps action calls.
    writeFileSync(specPath, JSON.stringify({ tools: [{ name: 'assign_ticket', description: 'Assign a ticket', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, owner: { type: 'string' } }, required: ['id', 'owner'] }, annotations: { readOnlyHint: false, destructiveHint: false } }] }));
    // Register with env, THEN land, so the app lock pins the same descriptor the source has now.
    await registerRef({ LOG_LEVEL: 'debug' });
    await h.newApp('desk');
    const landed = await h.call('POST', '/apps/desk/edits', { base: 1, ops: [{ op: 'spec', spec: specWith([], [ASSIGN]) }] });
    expect(landed.status, JSON.stringify(landed.body)).toBe(200);
    version = (landed.body.app as AppDetail).head.version;
  });
  afterEach(async () => {
    await h.close();
  });

  it('re-saving the SAME env keeps the grant; an env-only change refuses the action (409 contract_changed)', async () => {
    // Grant the write against the source as it stands.
    expect((await grant()).status, 'grant').toBe(200);

    // Re-saving the identical env does not change the descriptor: the grant still holds and prepare passes.
    await registerRef({ LOG_LEVEL: 'debug' });
    const ok = await prepare(4821);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(h.writePath.getGrant('desk', 'mcp_assign')).not.toBeNull();

    // An env-ONLY change (same command, args, tools) changes the execution descriptor: the standing grant is
    // withdrawn and the action is refused before anything reaches the upstream.
    await registerRef({ LOG_LEVEL: 'info' });
    const refused = await prepare(4822);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('contract_changed');
    // The grant is gone (withdrawn): a fresh prepare without a new grant is still refused.
    expect(h.writePath.getGrant('desk', 'mcp_assign')).toBeNull();
  });
});
