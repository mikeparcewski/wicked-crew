/**
 * Upstream secrets for MCP servers (DES-MCP-TOOLS-001 §5, D-2). Secrets stay in the broker.
 *
 * - The registry stores a REFERENCE only: `keychain:wicked-mcp/<account>` (the OS keychain, written
 *   by `PUT /mcp/servers/:name/secret`) or `env:<NAME>` (a variable of the daemon's own env).
 * - A value is resolved only at the moment crew itself talks to the upstream (a probe here; the
 *   broker's call path later), injected into that upstream's env or header, and scrubbed out of
 *   whatever comes back (`scrubSecrets`). No route answers it and nothing logs or writes it.
 * - macOS writes through `security -i`, with the command on STDIN, so the value is never in an
 *   argv that another process of the same user (a worker) could read with `ps`. Linux uses
 *   `secret-tool store`, which reads the value from stdin. Other platforms have no store: the
 *   secret route answers 501, and `env:` references still work.
 */

import { spawn } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'wicked-mcp';
const KEYCHAIN_PREFIX = `keychain:${KEYCHAIN_SERVICE}/`;
const ENV_PREFIX = 'env:';
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** What replaces a secret value anywhere it would have left the broker. */
export const SECRET_REDACTION = '[redacted:secret]';

export type SecretRef = { kind: 'keychain'; account: string } | { kind: 'env'; name: string };

export function keychainRef(account: string): string {
  return `${KEYCHAIN_PREFIX}${account}`;
}

/** Parse a stored reference; `null` = not a reference this broker understands. */
export function parseSecretRef(ref: string): SecretRef | null {
  if (ref.startsWith(KEYCHAIN_PREFIX)) {
    const account = ref.slice(KEYCHAIN_PREFIX.length);
    return ACCOUNT_RE.test(account) ? { kind: 'keychain', account } : null;
  }
  if (ref.startsWith(ENV_PREFIX)) {
    const name = ref.slice(ENV_PREFIX.length);
    return ENV_NAME_RE.test(name) ? { kind: 'env', name } : null;
  }
  return null;
}

/** The OS secret store, behind a seam so tests never touch a real keychain. */
export interface SecretStore {
  /** `false` = this platform has no store; the secret route answers 501. */
  readonly available: boolean;
  get(account: string): Promise<string | null>;
  has(account: string): Promise<boolean>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export class SecretStoreError extends Error {}

/** Resolve a reference to its value, or `null` when it is unset. Never logs the value. */
export async function resolveSecret(ref: string, store: SecretStore, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const parsed = parseSecretRef(ref);
  if (parsed === null) return null;
  if (parsed.kind === 'env') {
    const value = env[parsed.name];
    return value === undefined || value === '' ? null : value;
  }
  if (!store.available) return null;
  return store.get(parsed.account);
}

/** Whether a reference resolves to a value, without reading the value where the store allows. */
export async function secretIsSet(ref: string, store: SecretStore, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const parsed = parseSecretRef(ref);
  if (parsed === null) return false;
  if (parsed.kind === 'env') return (env[parsed.name] ?? '') !== '';
  return store.available ? store.has(parsed.account) : false;
}

/**
 * Replace every exact occurrence of each secret in every string of `value` (object keys included).
 * Pure: `value` is not mutated. Empty secrets are ignored; longer secrets are replaced first, so a
 * secret that contains another is never left half-exposed.
 */
export function scrubSecrets<T>(value: T, secrets: ReadonlyArray<string>): T {
  const live = [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
  if (live.length === 0) return value;
  const scrubText = (text: string): string => live.reduce((acc, s) => acc.split(s).join(SECRET_REDACTION), text);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) out[scrubText(k)] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

// ── Platform stores ──────────────────────────────────────────────────────────────────────────

interface Ran {
  code: number | null;
  stdout: string;
}

/** Spawn with an optional stdin payload and a hard timeout. Output is returned, never logged. */
function run(cmd: string, args: string[], stdin: string | null, timeoutMs = 10_000): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', () => undefined);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new SecretStoreError(`${cmd} could not start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    child.stdin.end(stdin ?? '');
  });
}

/** Quote one argument for `security -i`'s tokenizer: double quotes, with `\` and `"` escaped. */
function securityQuote(arg: string): string {
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** macOS login keychain through `/usr/bin/security`; writes go through `-i` on stdin. */
export class MacKeychainStore implements SecretStore {
  readonly available = true;

  async get(account: string): Promise<string | null> {
    const r = await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], null);
    if (r.code !== 0) return null;
    return r.stdout.replace(/\n$/, '');
  }

  async has(account: string): Promise<boolean> {
    // Without `-w` the value is not printed, and reading attributes needs no keychain prompt.
    const r = await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], null);
    return r.code === 0;
  }

  async set(account: string, value: string): Promise<void> {
    const line = ['add-generic-password', '-U', '-s', securityQuote(KEYCHAIN_SERVICE), '-a', securityQuote(account), '-w', securityQuote(value)].join(' ');
    const r = await run('/usr/bin/security', ['-i'], `${line}\n`);
    // `security -i` exits 0 even when a command fails; a failure prints "<command>: returned <n>".
    if (r.code !== 0 || /returned -?\d+/.test(r.stdout)) throw new SecretStoreError('the keychain refused the write');
    if (!(await this.has(account))) throw new SecretStoreError('the keychain write did not take');
  }

  async delete(account: string): Promise<void> {
    await run('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], null);
  }
}

/** Linux Secret Service through `secret-tool` (libsecret); the value goes over stdin. */
export class SecretToolStore implements SecretStore {
  readonly available = true;
  private attrs(account: string): string[] {
    return ['service', KEYCHAIN_SERVICE, 'account', account];
  }

  async get(account: string): Promise<string | null> {
    const r = await run('secret-tool', ['lookup', ...this.attrs(account)], null);
    return r.code === 0 && r.stdout !== '' ? r.stdout.replace(/\n$/, '') : null;
  }

  async has(account: string): Promise<boolean> {
    return (await this.get(account)) !== null;
  }

  async set(account: string, value: string): Promise<void> {
    const r = await run('secret-tool', ['store', `--label=${KEYCHAIN_SERVICE} ${account}`, ...this.attrs(account)], value);
    if (r.code !== 0) throw new SecretStoreError('the secret service refused the write');
  }

  async delete(account: string): Promise<void> {
    await run('secret-tool', ['clear', ...this.attrs(account)], null);
  }
}

class NoSecretStore implements SecretStore {
  readonly available = false;
  async get(): Promise<string | null> {
    return null;
  }
  async has(): Promise<boolean> {
    return false;
  }
  async set(): Promise<void> {
    throw new SecretStoreError('no OS secret store on this platform; use an env: reference');
  }
  async delete(): Promise<void> {}
}

export function platformSecretStore(platform: NodeJS.Platform = process.platform): SecretStore {
  if (platform === 'darwin') return new MacKeychainStore();
  if (platform === 'linux') return new SecretToolStore();
  return new NoSecretStore();
}
