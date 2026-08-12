// Unit surface of the identity/actor seam (task #88): mode resolution, the
// hashed-at-rest token file, the static verifier, the trust ladder, token
// extraction, and the audit trail's append/read discipline. The request-level
// 401/403/200 matrix (REST + WS) lives in tests/integration/auth-required.test.ts.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOCAL_ACTOR,
  createOidcVerifier,
  createStaticVerifier,
  extractToken,
  loadTokenFile,
  parseTokenFile,
  requiredTrust,
  resolveAuthMode,
  tokenHash,
  trustAtLeast,
} from '../src/api/auth.js';
import { AuditLog } from '../src/api/audit.js';
import type { Actor } from '../src/core/types.js';

const OPERATOR: Actor = { id: 'op-1', kind: 'human', trust: 'operator' };

describe('resolveAuthMode', () => {
  it('defaults to off (the local loopback deployment changes nothing)', () => {
    expect(resolveAuthMode({})).toBe('off');
    expect(resolveAuthMode({ WICKED_CREW_AUTH: '' })).toBe('off');
    expect(resolveAuthMode({ WICKED_CREW_AUTH: 'off' })).toBe('off');
  });

  it('WICKED_CREW_AUTH=required arms it', () => {
    expect(resolveAuthMode({ WICKED_CREW_AUTH: 'required' })).toBe('required');
    expect(resolveAuthMode({ WICKED_CREW_AUTH: ' Required ' })).toBe('required');
  });

  it('WICKED_RUNTIME=team forces required — deny-dominant over an explicit off', () => {
    expect(resolveAuthMode({ WICKED_RUNTIME: 'team' })).toBe('required');
    expect(resolveAuthMode({ WICKED_RUNTIME: 'team', WICKED_CREW_AUTH: 'off' })).toBe('required');
  });

  it('a typo fails LOUD instead of silently running unauthenticated', () => {
    expect(() => resolveAuthMode({ WICKED_CREW_AUTH: 'reqired' })).toThrow(/must be 'required' or 'off'/);
  });
});

describe('token file (hashed at rest)', () => {
  const entry = (over?: Record<string, unknown>) => ({
    version: 1,
    tokens: [
      {
        sha256: tokenHash('secret-1'),
        actor: { id: 'ci-runner', kind: 'agent', trust: 'operator' },
        label: 'ci',
        ...over,
      },
    ],
  });

  it('maps sha256(token) → actor; the raw token never appears in the file', async () => {
    const json = JSON.stringify(entry());
    expect(json).not.toContain('secret-1');
    const verifier = createStaticVerifier(parseTokenFile(json, 'test'));
    expect(await verifier.verify('secret-1')).toEqual({ id: 'ci-runner', kind: 'agent', trust: 'operator' });
    expect(await verifier.verify('secret-2')).toBeNull();
  });

  it.each([
    [{ sha256: 'abc' }, /sha256/],
    [{ actor: { id: '', kind: 'agent', trust: 'operator' } }, /actor\.id/],
    [{ actor: { id: 'x', kind: 'robot', trust: 'operator' } }, /actor\.kind/],
    [{ actor: { id: 'x', kind: 'agent', trust: 'root' } }, /actor\.trust/],
  ] as [Record<string, unknown>, RegExp][])(
    'a malformed entry fails the PARSE, closed and named: %j',
    (over, want) => {
      // Fail closed: a typo'd trust level silently skipping its entry would
      // lock someone out (or half-demote them) with nothing saying so.
      expect(() => parseTokenFile(JSON.stringify(entry(over)), 'test')).toThrow(want);
    },
  );

  it('a duplicate hash fails the parse (two actors behind one token is ambiguity, not config)', () => {
    const dup = entry();
    dup.tokens.push({ ...dup.tokens[0]!, actor: { id: 'other', kind: 'human', trust: 'admin' } });
    expect(() => parseTokenFile(JSON.stringify(dup), 'test')).toThrow(/duplicate/);
  });

  it('a MISSING file warns loudly and yields an empty set (fail-closed: everything 401s)', () => {
    const warnings: string[] = [];
    const map = loadTokenFile(join(tmpdir(), 'no-such-dir-xyz', 'tokens.json'), (m) => warnings.push(m));
    expect(map.size).toBe(0);
    expect(warnings.join('\n')).toMatch(/NO token file/);
  });

  it('a PRESENT-but-broken file fails the boot, not the request path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-tokens-'));
    const path = join(dir, 'tokens.json');
    writeFileSync(path, '{ not json');
    expect(() => loadTokenFile(path, () => undefined)).toThrow(/not valid JSON/);
  });
});

describe('the OIDC seam', () => {
  it('is declared, not faked: configuring it throws the named follow-up', () => {
    expect(() => createOidcVerifier({ issuer: 'https://idp.example.com', audience: 'wicked-crew' })).toThrow(
      /not yet implemented/,
    );
  });
});

describe('trust ladder', () => {
  it('admin > operator > observer, and local means full trust (one shape)', () => {
    expect(LOCAL_ACTOR).toEqual({ id: 'local', kind: 'human', trust: 'admin' });
    expect(trustAtLeast(LOCAL_ACTOR, 'admin')).toBe(true);
    expect(trustAtLeast(OPERATOR, 'observer')).toBe(true);
    expect(trustAtLeast(OPERATOR, 'operator')).toBe(true);
    expect(trustAtLeast(OPERATOR, 'admin')).toBe(false);
  });

  it('reads need observer; mutations need operator; governance/settings/archive need admin', () => {
    expect(requiredTrust('GET', '/api/v1/runs', undefined)).toBe('observer');
    expect(requiredTrust('GET', '/ws', undefined)).toBe('observer');
    expect(requiredTrust('GET', '/api/v1/governance/policies', undefined)).toBe('observer');
    expect(requiredTrust('POST', '/api/v1/runs', {})).toBe('operator');
    expect(requiredTrust('POST', '/api/v1/runs/r1/gate', { approve: true })).toBe('operator');
    expect(requiredTrust('POST', '/api/v1/terminals', {})).toBe('operator');
    expect(requiredTrust('POST', '/api/v1/governance/policies', {})).toBe('admin');
    expect(requiredTrust('DELETE', '/api/v1/governance/rules/r-1', undefined)).toBe('admin');
    expect(requiredTrust('PUT', '/api/v1/settings', {})).toBe('admin');
  });

  it('project PATCH: rename is operator work; touching status (archive/restore) is admin', () => {
    expect(requiredTrust('PATCH', '/api/v1/projects/p1', { name: 'renamed' })).toBe('operator');
    expect(requiredTrust('PATCH', '/api/v1/projects/p1', { status: 'archived' })).toBe('admin');
    expect(requiredTrust('PATCH', '/api/v1/projects/p1', { status: 'active' })).toBe('admin');
  });
});

describe('extractToken', () => {
  const req = (headers: Record<string, string>, query?: Record<string, string>) =>
    ({ headers, query }) as unknown as Parameters<typeof extractToken>[0];

  it('reads Authorization: Bearer everywhere', () => {
    expect(extractToken(req({ authorization: 'Bearer tok-1' }), '/api/v1/runs')).toBe('tok-1');
    expect(extractToken(req({ authorization: 'bearer tok-1' }), '/api/v1/runs')).toBe('tok-1');
    expect(extractToken(req({}), '/api/v1/runs')).toBeNull();
    expect(extractToken(req({ authorization: 'Basic dXNlcg==' }), '/api/v1/runs')).toBeNull();
  });

  it('accepts ?access_token= on the WS upgrade paths ONLY (browsers cannot set WS headers)', () => {
    expect(extractToken(req({}, { access_token: 'tok-2' }), '/ws')).toBe('tok-2');
    expect(extractToken(req({}, { access_token: 'tok-2' }), '/ws/terminals/t1')).toBe('tok-2');
    expect(extractToken(req({}, { access_token: 'tok-2' }), '/api/v1/runs')).toBeNull();
    // The header wins when both are present.
    expect(extractToken(req({ authorization: 'Bearer tok-1' }, { access_token: 'tok-2' }), '/ws')).toBe('tok-1');
  });
});

describe('AuditLog', () => {
  it('appends one JSON line per action and reads newest-first with filters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    const log = new AuditLog(join(dir, 'nested', 'audit.log')); // parent dir is created on demand
    log.record('run.launched', OPERATOR, { runId: 'r1' });
    log.record('gate.decided', OPERATOR, { runId: 'r1', detail: { approve: true } });
    log.record('run.launched', LOCAL_ACTOR, { runId: 'r2' });
    await log.flush();

    const all = await log.read();
    expect(all.map((e) => e.action)).toEqual(['run.launched', 'gate.decided', 'run.launched']);
    expect(all[0]?.runId).toBe('r2'); // newest first

    const gates = await log.read({ runId: 'r1', action: 'gate.decided' });
    expect(gates).toHaveLength(1);
    expect(gates[0]?.actor.id).toBe('op-1');
    expect(gates[0]?.detail).toEqual({ approve: true });

    expect(await log.read({ runId: 'no-such-run' })).toEqual([]);
  });

  it('an empty trail answers [], and a torn line is skipped rather than poisoning the read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    const path = join(dir, 'audit.log');
    expect(await new AuditLog(path).read()).toEqual([]);
    writeFileSync(path, `${JSON.stringify({ ts: 1, action: 'run.launched', actor: OPERATOR })}\n{"torn`);
    const entries = await new AuditLog(path).read();
    expect(entries).toHaveLength(1);
  });

  it('noop() records nothing and reads empty — the directly-driven default never touches the real trail', async () => {
    const log = AuditLog.noop();
    log.record('run.launched', OPERATOR, { runId: 'r1' });
    await log.flush();
    expect(await log.read()).toEqual([]);
  });

  it('an unwritable path is LOUD but never fails the action (flush still resolves)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    const warnings: string[] = [];
    // A directory at the file's path makes every append fail.
    const log = new AuditLog(dir, (m) => warnings.push(m));
    log.record('run.launched', OPERATOR, { runId: 'r1' });
    await expect(log.flush()).resolves.toBeUndefined();
    expect(warnings.join('\n')).toMatch(/FAILED to record run.launched/);
  });
});
