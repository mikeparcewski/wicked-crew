// crew#1068 — the engine always has a wicked-vault CLI to record held boundary findings with
// (wicked-core#959 / #1006, `src/team/vault.rs` reads `WICKED_VAULT_BIN` per record).
//
//   - resolution: crew's own `wicked-vault` dependency's bin is an existing, absolute, executable
//     path, exported as `WICKED_VAULT_BIN`; on Windows it is npm's `.cmd` shim beside the package.
//   - an operator's own value is respected exactly; an EMPTY one stays empty (vault switched off on
//     purpose) and reads as the `vault.off` warning.
//   - an unresolvable bin never fails boot: the real (stub-spawned) adapter constructs, and
//     `/health.warnings` + `/diagnostics.vault` carry `vault.unresolvable` with the remedy.

import Fastify, { type FastifyInstance } from 'fastify';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { DiagnosticsResponse, HealthResponse } from '../src/core/types.js';
import {
  applyVaultBinEnv,
  BOOT_VAULT_BIN,
  resolveShippedVaultBin,
  VAULT_BIN_ENV,
  vaultBinWarning,
  vaultDiagnostics,
} from '../src/core/vault-bin.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { removeScratch } from './setup/scratch.js';

const scratch: string[] = [];
const apps: FastifyInstance[] = [];
const adapters: CoreAdapter[] = [];
const savedEnv = process.env[VAULT_BIN_ENV];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const a of adapters.splice(0)) a.close();
  for (const d of scratch.splice(0)) removeScratch(d);
  if (savedEnv === undefined) delete process.env[VAULT_BIN_ENV];
  else process.env[VAULT_BIN_ENV] = savedEnv;
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'crew-1068-'));
  scratch.push(d);
  return d;
}

/** A fake installed package: `<root>/node_modules/wicked-vault/{package.json,bin/wicked-vault.mjs}`. */
function fakeInstall(bin: unknown = { 'wicked-vault': 'bin/wicked-vault.mjs' }): { pkgJson: string; binFile: string; root: string } {
  const root = tmp();
  const pkgDir = join(root, 'node_modules', 'wicked-vault');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  const pkgJson = join(pkgDir, 'package.json');
  writeFileSync(pkgJson, JSON.stringify({ name: 'wicked-vault', bin }));
  const binFile = join(pkgDir, 'bin', 'wicked-vault.mjs');
  writeFileSync(binFile, '#!/usr/bin/env node\n');
  chmodSync(binFile, 0o755);
  return { pkgJson, binFile, root };
}

describe('resolveShippedVaultBin (crew#1068)', () => {
  it.skipIf(process.platform === 'win32')('resolves crew\'s own wicked-vault dependency to an existing, absolute, executable bin', () => {
    const bin = resolveShippedVaultBin();
    expect(isAbsolute(bin)).toBe(true);
    expect(existsSync(bin)).toBe(true);
    expect(bin).toMatch(/wicked-vault[\\/]bin[\\/]wicked-vault\.mjs$/);
    expect(statSync(bin).mode & 0o111).not.toBe(0);
  });

  it('reads the package\'s bin field (object or string form)', () => {
    const obj = fakeInstall();
    expect(resolveShippedVaultBin('linux', () => obj.pkgJson)).toBe(obj.binFile);
    const str = fakeInstall('bin/wicked-vault.mjs');
    expect(resolveShippedVaultBin('linux', () => str.pkgJson)).toBe(str.binFile);
  });

  it('on Windows names npm\'s .cmd shim in the .bin dir beside the package', () => {
    const { pkgJson, root } = fakeInstall();
    const shim = join(root, 'node_modules', '.bin', 'wicked-vault.cmd');
    expect(() => resolveShippedVaultBin('win32', () => pkgJson)).toThrow(/wicked-vault\.cmd does not exist/);
    mkdirSync(join(root, 'node_modules', '.bin'));
    writeFileSync(shim, '@node "%~dp0\\..\\wicked-vault\\bin\\wicked-vault.mjs" %*\r\n');
    expect(resolveShippedVaultBin('win32', () => pkgJson)).toBe(shim);
  });

  it('throws — with the reason — when the package, its bin field or the file is missing', () => {
    expect(() =>
      resolveShippedVaultBin('linux', () => {
        throw new Error("Cannot find module 'wicked-vault/package.json'");
      }),
    ).toThrow(/Cannot find module/);
    const noBin = fakeInstall({ other: 'x.mjs' });
    expect(() => resolveShippedVaultBin('linux', () => noBin.pkgJson)).toThrow(/declares no "wicked-vault" bin/);
    const gone = fakeInstall({ 'wicked-vault': 'bin/missing.mjs' });
    expect(() => resolveShippedVaultBin('linux', () => gone.pkgJson)).toThrow(/does not exist/);
  });
});

describe('applyVaultBinEnv (crew#1068)', () => {
  it('no operator value: exports crew\'s resolved bin — an existing absolute path', () => {
    const env: NodeJS.ProcessEnv = {};
    const { binFile, pkgJson } = fakeInstall();
    const posture = applyVaultBinEnv(env, () => resolveShippedVaultBin('linux', () => pkgJson), undefined);
    expect(posture).toEqual({ source: 'shipped', bin: binFile });
    expect(env[VAULT_BIN_ENV]).toBe(binFile);
    expect(isAbsolute(env[VAULT_BIN_ENV]!)).toBe(true);
    expect(existsSync(env[VAULT_BIN_ENV]!)).toBe(true);
    expect(vaultBinWarning(posture)).toBeNull();
    expect(vaultDiagnostics(posture)).toEqual({ bin: binFile, source: 'shipped', finding: null });
  });

  it('an operator override is respected exactly — nothing resolved, nothing rewritten', () => {
    const env: NodeJS.ProcessEnv = { [VAULT_BIN_ENV]: '/opt/vault/bin/wicked-vault' };
    const posture = applyVaultBinEnv(
      env,
      () => {
        throw new Error('must not be consulted');
      },
      '/opt/vault/bin/wicked-vault',
    );
    expect(posture).toEqual({ source: 'operator', bin: '/opt/vault/bin/wicked-vault' });
    expect(env[VAULT_BIN_ENV]).toBe('/opt/vault/bin/wicked-vault');
    expect(vaultBinWarning(posture)).toBeNull();
  });

  it('an EMPTY operator value stays empty and reads as the switched-off warning', () => {
    const env: NodeJS.ProcessEnv = { [VAULT_BIN_ENV]: '' };
    const posture = applyVaultBinEnv(env, () => '/never/used', '');
    expect(posture).toEqual({ source: 'off', bin: null });
    expect(env[VAULT_BIN_ENV]).toBe('');
    const warning = vaultBinWarning(posture)!;
    expect(warning.kind).toBe('vault.off');
    expect(warning.severity).toBe('warning');
    expect(warning.message).toMatch(/switched off \(WICKED_VAULT_BIN is set empty\); held boundary findings will not be vaulted/);
    expect(warning.message).toMatch(/unset WICKED_VAULT_BIN/);
    const diag = vaultDiagnostics(posture);
    expect(diag.source).toBe('off');
    expect(diag.finding?.kind).toBe('vault.off');
    expect(diag.finding?.remedy).toMatch(/unset WICKED_VAULT_BIN/);
  });

  it('an unresolvable bin exports nothing and reads as the unresolvable warning with a remedy', () => {
    const env: NodeJS.ProcessEnv = {};
    const posture = applyVaultBinEnv(
      env,
      () => {
        throw new Error("Cannot find module 'wicked-vault/package.json'");
      },
      undefined,
    );
    expect(posture).toEqual({ source: 'unresolvable', bin: null, reason: "Cannot find module 'wicked-vault/package.json'" });
    expect(VAULT_BIN_ENV in env).toBe(false);
    expect(vaultBinWarning(posture)!.message).toMatch(
      /^wicked-vault is not resolvable \(Cannot find module 'wicked-vault\/package\.json'\); held boundary findings will not be vaulted — reinstall wicked-crew/,
    );
  });
});

describe('boot with an unresolvable wicked-vault (crew#1068)', () => {
  function routes(adapter: CoreAdapter): FastifyInstance {
    const app = Fastify({ logger: false });
    registerRoutes(
      app,
      adapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      { governanceLegacyOutboxPath: null },
    );
    apps.push(app);
    return app;
  }

  // The posture is decided from the value the process BOOTED with: a runner that exported its own
  // WICKED_VAULT_BIN is an operator override, which this case is not about.
  it.skipIf(BOOT_VAULT_BIN !== undefined)(
    'the real adapter still boots; /health.warnings and /diagnostics.vault carry vault.unresolvable with the remedy',
    async () => {
      delete process.env[VAULT_BIN_ENV];
      const adapter = new CoreAdapter({
        dbPath: join(tmp(), 'core.db'),
        stub: true,
        resolveVaultBin: () => {
          throw new Error("Cannot find module 'wicked-vault/package.json'");
        },
      });
      adapters.push(adapter);
      expect(adapter.vaultBin.source).toBe('unresolvable');
      expect(VAULT_BIN_ENV in process.env).toBe(false);
      const app = routes(adapter);

      const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
      expect(health.status).toBe('ok');
      const vault = (health.warnings ?? []).filter((w) => w.kind.startsWith('vault.'));
      expect(vault).toHaveLength(1);
      expect(vault[0]!.kind).toBe('vault.unresolvable');
      expect(vault[0]!.message).toContain('wicked-vault is not resolvable');
      expect(vault[0]!.message).toContain('held boundary findings will not be vaulted');
      expect(vault[0]!.message).toContain('reinstall wicked-crew');

      const diag = (await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse;
      expect(diag.vault?.source).toBe('unresolvable');
      expect(diag.vault?.bin).toBeNull();
      expect(diag.vault?.finding?.kind).toBe('vault.unresolvable');
      expect(diag.vault?.finding?.remedy).toMatch(/reinstall wicked-crew .* or set WICKED_VAULT_BIN/);
    },
  );

  it.skipIf(BOOT_VAULT_BIN !== undefined || process.platform === 'win32')(
    'the default boot hands the engine crew\'s own bin and says nothing about the vault',
    async () => {
      delete process.env[VAULT_BIN_ENV];
      const adapter = new CoreAdapter({ dbPath: join(tmp(), 'core.db'), stub: true });
      adapters.push(adapter);
      expect(adapter.vaultBin.source).toBe('shipped');
      expect(process.env[VAULT_BIN_ENV]).toBe(resolveShippedVaultBin());
      const app = routes(adapter);
      const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
      expect((health.warnings ?? []).filter((w) => w.kind.startsWith('vault.'))).toEqual([]);
      const diag = (await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse;
      expect(diag.vault).toEqual({ bin: resolveShippedVaultBin(), source: 'shipped', finding: null });
    },
  );
});
