// SPDX-License-Identifier: MIT
/**
 * The ONE validator of a stdio MCP server's non-secret `env` map (chat-extend CX1). Settings, the
 * preview and every later writer call {@link validateServerEnv}; none re-implements it.
 *
 * The env saved on each server is its per-server allowlist, approved by a human operator (names
 * AND values). The API requires that approval for every change, including removals. The denylist
 * below stays the second line for everyone; the warning class is advice for the person approving it.
 * A public value is stored, answered back on the Settings read and hashed into the preview, so a
 * credential belongs in the server's secret field. A refusal names the variable and a reason code,
 * never the value.
 */

import { createHash } from 'node:crypto';

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

import { canonicalJson } from './classify.js';
import { VALUE_PATTERNS } from './redact.js';

export const ENV_MAX_NAMES = 16;
export const ENV_MAX_VALUE_CHARS = 1024;

const RUNTIME_CONTROL_NAMES: ReadonlySet<string> = new Set([
  'GOCACHEPROG', 'GOWORK', 'GOMODCACHE', 'GOCACHE', 'CC', 'CXX', 'PKG_CONFIG', 'GODEBUG',
  'ESBUILD_BINARY_PATH', 'NODE_COMPILE_CACHE', 'NODE_USE_SYSTEM_CA', 'ZDOTDIR', 'RUSTC_WRAPPER',
  'RUSTFLAGS', 'R_PROFILE', 'R_PROFILE_USER', 'R_ENVIRON', 'R_ENVIRON_USER', 'VIRTUAL_ENV',
  'RUBYPATH', 'RUBYSHELL', 'DLN_LIBRARY_PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS',
]);
const RUNTIME_CONTROL_PREFIXES: readonly string[] = ['CGO_', 'TS_NODE_', 'TSX_', 'COREPACK_', 'CARGO_', 'R_LIBS', 'JULIA_', 'CONDA_'];

/**
 * Advice shown beside each name for the person approving the server's allowlist, not a gate.
 * These names can change startup, code loading, package resolution or network trust; the gates
 * are the person's approval of the names and values and the denylist in {@link validateServerEnv}.
 */
export function envWarningClass(name: string): 'runtime_control' | 'app_setting' {
  const upper = name.toUpperCase();
  return RUNTIME_CONTROL_NAMES.has(upper) || RUNTIME_CONTROL_PREFIXES.some((p) => upper.startsWith(p))
    ? 'runtime_control' : 'app_setting';
}

export type EnvRefusalCode =
  | 'too_many'
  | 'bad_name'
  | 'duplicate'
  | 'reserved_name'
  | 'secret_variable'
  | 'credential_name'
  | 'value_too_long'
  | 'credential_value'
  | 'bad_value';

export interface EnvRefusal {
  /** The variable, cut to 64 characters; never its value. */
  name: string;
  code: EnvRefusalCode;
  message: string;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * A canonical fingerprint of a stdio server's non-secret `env` (names and values, sorted, hashed), or
 * `null` when there is none. Bound into the descriptors that decide where a call goes (the Apps lock and
 * grant, the PM query switch), so an env-only change is a different execution target (CX1 review).
 */
export function envFingerprint(env: Readonly<Record<string, string>> | undefined | null): string | null {
  if (env == null) return null;
  const names = Object.keys(env);
  if (names.length === 0) return null;
  const pairs = names.sort().map((n) => [n, env[n]] as const);
  return createHash('sha256').update(canonicalJson(pairs)).digest('hex');
}

/** What the SDK's safe inherited set holds on any platform, on top of what `getDefaultEnvironment()` reads here. */
const SDK_DEFAULT_NAMES: readonly string[] = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES'];
const RESERVED_EXACT: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'SHELL', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'PERLLIB', 'RUBYOPT', 'RUBYLIB', 'BASH_ENV', 'ENV', 'PHPRC', 'CLASSPATH',
  'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH', 'GCONV_PATH', 'LOCPATH', 'NLSPATH', 'ELECTRON_RUN_AS_NODE',
  // Go shares its leading letters with ordinary app config (GOOGLE_*): reserve only controls
  // read by the go command, never a GO* prefix.
  'GOFLAGS', 'GOPROXY', 'GOSUMDB', 'GONOSUMDB', 'GONOSUMCHECK', 'GOPRIVATE', 'GONOPROXY',
  'GOINSECURE', 'GOTOOLCHAIN', 'GOENV', 'GOPATH', 'GOROOT', 'GOBIN', 'GOEXPERIMENT',
  // Library helpers can invoke commands; TLS key logging can write session secrets.
  'BROWSER', 'EDITOR', 'VISUAL', 'PAGER', 'SSLKEYLOGFILE',
]);
// Runtime-owned families cover startup hooks, module/package/interpreter resolution and trust
// controls, including versioned Lua names. Node deliberately keeps NODE_ENV available to apps.
const RESERVED_PREFIXES: readonly string[] = [
  'LD_', 'DYLD_', 'GIT_', 'NPM_CONFIG_', 'CURL_', 'SSL_CERT_', 'NODE_TLS_', 'OPENSSL_',
  'PYTHON', 'LUA_INIT', 'LUA_PATH', 'LUA_CPATH', 'PHP_INI_', 'DOTNET_', 'CORECLR_', 'COMPLUS_',
  'UV_', 'PIP_', 'JAVA_', '_JAVA_', 'JDK_', 'PERL5', 'PERL_', 'GEM_', 'BUNDLE_', 'BUN_', 'DENO_',
];
const RESERVED_SUFFIXES: readonly string[] = ['_PROXY', '_CA_BUNDLE', '_CA_CERTS', '_CERT_FILE', '_CERT_DIR'];
const CREDENTIAL_NAME_PARTS: readonly string[] = ['TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'AUTH', 'API_KEY', 'ACCESS_KEY', 'PRIVATE_KEY'];

function isReservedName(upper: string): boolean {
  if (RESERVED_EXACT.has(upper) || RESERVED_SUFFIXES.some((s) => upper.endsWith(s))) return true;
  if (RESERVED_PREFIXES.some((p) => upper.startsWith(p))) return true;
  return SDK_DEFAULT_NAMES.includes(upper) || Object.keys(getDefaultEnvironment()).some((k) => k.toUpperCase() === upper);
}

/** A value matching one of crew's credential-shape detectors (`redact.ts`), without the detectors' global state. */
function looksLikeCredential(value: string): boolean {
  return VALUE_PATTERNS.some((p) => new RegExp(p.re.source, p.re.flags.replace('g', '')).test(value));
}

/**
 * The first refusal of `env` for a server whose secret goes into `secretEnv` (or none), or `null`.
 * Names are compared case-insensitively.
 */
export function validateServerEnv(env: Readonly<Record<string, string>>, secretEnv: string | null = null): EnvRefusal | null {
  const refuse = (name: string, code: EnvRefusalCode, why: string): EnvRefusal => {
    const shown = name.slice(0, 64);
    return { name: shown, code, message: `env variable ${shown}: ${code} (${why})` };
  };
  const names = Object.keys(env);
  const seen = new Set<string>();
  const secretUpper = secretEnv?.toUpperCase() ?? null;
  for (const [i, name] of names.entries()) {
    if (i >= ENV_MAX_NAMES) return refuse(name, 'too_many', `at most ${ENV_MAX_NAMES} variables`);
    if (!NAME_RE.test(name)) return refuse(name, 'bad_name', 'a name is letters, digits and _, not starting with a digit, at most 64 characters');
    const upper = name.toUpperCase();
    if (seen.has(upper)) return refuse(name, 'duplicate', 'names are compared without case');
    seen.add(upper);
    if (secretUpper !== null && upper === secretUpper) return refuse(name, 'secret_variable', "this server's secret goes in its secret field");
    if (isReservedName(upper)) return refuse(name, 'reserved_name', 'it changes how the process starts, loads code or reaches the network');
    if (CREDENTIAL_NAME_PARTS.some((p) => upper.includes(p))) return refuse(name, 'credential_name', 'a credential belongs in the secret field');
    const value = env[name] as string;
    if (value.length > ENV_MAX_VALUE_CHARS) return refuse(name, 'value_too_long', `at most ${ENV_MAX_VALUE_CHARS} characters`);
    if (value.includes('\0')) return refuse(name, 'bad_value', 'a value has no NUL character');
    if (looksLikeCredential(value)) return refuse(name, 'credential_value', 'the value looks like a credential; use the secret field');
  }
  return null;
}
