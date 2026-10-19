/**
 * (crew#1068) The wicked-vault CLI the engine records held team findings with.
 *
 * wicked-core vaults a team finding held for the operator (core#959 / core#1006) by running the
 * wicked-vault CLI named by `WICKED_VAULT_BIN`, read per record (`src/team/vault.rs`; empty = the
 * vault is switched off). Crew ships `wicked-vault` as a runtime dependency and, before the engine
 * spawns, exports the absolute path of that package's own `wicked-vault` bin as the variable, so a
 * held finding always gets a vault entry instead of reading "not vaulted". ONE mechanism: PATH is
 * never touched, and nothing else is tried.
 *
 * An operator's own `WICKED_VAULT_BIN` (the value this process booted with) is kept exactly — an
 * explicit empty value included, because that is the vault switched off on purpose. When crew's own
 * bin cannot be resolved, or the operator switched the vault off, the daemon still boots: the
 * posture rides `/health.warnings` (and `wicked-crew status`) and `/diagnostics.vault` with a remedy.
 */

import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

import type { DiagnosticsVault, HealthWarning } from 'wicked-crew-api-types';

export const VAULT_BIN_ENV = 'WICKED_VAULT_BIN';

/** The value this process BOOTED with: an operator's choice, never one crew exported itself. */
export const BOOT_VAULT_BIN: string | undefined = process.env[VAULT_BIN_ENV];

/** What the engine is handed: crew's shipped bin, the operator's value, the vault switched off by
 *  the operator, or nothing because crew's bin could not be resolved (`reason` says why). */
export type VaultBinPosture =
  | { source: 'shipped'; bin: string }
  | { source: 'operator'; bin: string }
  | { source: 'off'; bin: null }
  | { source: 'unresolvable'; bin: null; reason: string };

/** Resolves the absolute path of the `wicked-vault` bin; throws with the reason it cannot. */
export type VaultBinResolver = () => string;

const VAULT_PKG = 'wicked-vault';

/**
 * The absolute path of crew's own `wicked-vault` bin: the installed package's `bin.wicked-vault`
 * file (`wicked-vault/package.json`, resolved from this module and never loaded). On Windows the
 * engine cannot start a `.mjs` file, so the path is npm's `.cmd` shim for that bin, which npm writes
 * into the `.bin` dir of the `node_modules` holding the package. Throws when the package, its bin
 * field or the file is missing, or (POSIX) the file is not executable.
 */
export function resolveShippedVaultBin(
  platform: NodeJS.Platform = process.platform,
  resolvePackageJson: () => string = () => createRequire(import.meta.url).resolve(`${VAULT_PKG}/package.json`),
): string {
  const pkgJson = resolvePackageJson();
  const pkgDir = dirname(pkgJson);
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { bin?: string | Record<string, string> };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[VAULT_PKG];
  if (typeof rel !== 'string' || rel === '') throw new Error(`${pkgJson} declares no "${VAULT_PKG}" bin`);
  const bin = platform === 'win32' ? join(dirname(pkgDir), '.bin', `${VAULT_PKG}.cmd`) : join(pkgDir, rel);
  if (!isAbsolute(bin)) throw new Error(`${bin} is not an absolute path`);
  if (!existsSync(bin)) throw new Error(`${bin} does not exist`);
  if (platform !== 'win32') accessSync(bin, constants.X_OK);
  return bin;
}

/**
 * Hand the engine its wicked-vault CLI in `env` before it spawns. The operator's boot value wins,
 * untouched (`''` = switched off, kept empty); otherwise crew's resolved bin is exported. A bin that
 * cannot be resolved leaves `env` as it was and is reported — it never fails boot.
 */
export function applyVaultBinEnv(
  env: NodeJS.ProcessEnv = process.env,
  resolve: VaultBinResolver = resolveShippedVaultBin,
  operator: string | undefined = BOOT_VAULT_BIN,
): VaultBinPosture {
  if (operator !== undefined) {
    return operator.trim() === '' ? { source: 'off', bin: null } : { source: 'operator', bin: operator };
  }
  let bin: string;
  try {
    bin = resolve();
  } catch (err) {
    return { source: 'unresolvable', bin: null, reason: err instanceof Error ? err.message : String(err) };
  }
  env[VAULT_BIN_ENV] = bin;
  return { source: 'shipped', bin };
}

const UNRESOLVABLE_REMEDY =
  'reinstall wicked-crew so its wicked-vault dependency is present (npm i -g wicked-crew), or set WICKED_VAULT_BIN to a wicked-vault CLI, then restart the daemon';
const OFF_REMEDY = 'unset WICKED_VAULT_BIN (crew then hands the engine its own wicked-vault) and restart the daemon';

/** The finding a posture carries, or `null` when the engine has a CLI to vault with. */
function vaultFinding(p: VaultBinPosture): NonNullable<DiagnosticsVault['finding']> | null {
  if (p.source === 'unresolvable') {
    return {
      kind: 'vault.unresolvable',
      severity: 'warning',
      message: `wicked-vault is not resolvable (${p.reason}); held boundary findings will not be vaulted`,
      remedy: UNRESOLVABLE_REMEDY,
    };
  }
  if (p.source === 'off') {
    return {
      kind: 'vault.off',
      severity: 'warning',
      message: 'wicked-vault is switched off (WICKED_VAULT_BIN is set empty); held boundary findings will not be vaulted',
      remedy: OFF_REMEDY,
    };
  }
  return null;
}

/** The `/health.warnings[]` entry for a posture (the message carries the remedy), or `null`. */
export function vaultBinWarning(p: VaultBinPosture): HealthWarning | null {
  const f = vaultFinding(p);
  return f === null ? null : { kind: f.kind, severity: f.severity, message: `${f.message} — ${f.remedy}` };
}

/** `/diagnostics.vault`: what the engine is handed, and the finding with its remedy. */
export function vaultDiagnostics(p: VaultBinPosture): DiagnosticsVault {
  return { bin: p.bin, source: p.source, finding: vaultFinding(p) };
}
