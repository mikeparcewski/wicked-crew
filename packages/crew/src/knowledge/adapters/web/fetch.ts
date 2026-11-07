/**
 * Reading pages (CS9): `mcp-server-fetch` 2026.11.4 (MIT), installed from crew's hash lock
 * (`packages/crew/adapters/web-source.lock`) into a pinned virtual environment only after a person consents, and run
 * as ONE stdio process per fetch call, through crew's egress proxy (`egress.ts`).
 *
 * - The reader starts through crew's bootstrap ({@link READER_BOOTSTRAP}), which takes the per-call proxy credential
 *   from the env (never the command line, where `ps` shows it), bounds decompression inside zlib (`max_length`, so no
 *   chunk past {@link READER_DECODED_MAX} is ever allocated; a stacked encoding is refused; the proxy can only count
 *   bytes on the wire) and caps the whole decoded body, keeps
 *   no cookie (none is stored, so none is sent, even on a redirect within a call), and on Linux bounds the process's
 *   address space. It then runs the pinned server unmodified.
 * - Never `--ignore-robots-txt` or `--allow-private-ips`: robots.txt is respected (every redirect hop is checked
 *   against its own origin's), and the server's own private-address guard (a request hook that resolves the name
 *   itself, `server.py` `_refuse_private_destination`) stays on as a second layer behind the proxy's connect-time
 *   check. `--no-readability-js`: it never starts Node or runs `npm install`.
 * - The env is minimal ({@link fetchEnv}): no proxy variables, no tokens, `HOME` an empty crew-owned directory (no
 *   `~/.netrc`). Python runs isolated (`-I`: no `PYTHON*` variables, no user site).
 * - Install: `python -m venv`, then `pip --isolated install --require-hashes --only-binary :all: -r <the consented
 *   lock bytes>` with a minimal env ({@link installEnv}): no pip configuration, no `PIP_*` variable, no netrc, the
 *   public index. Every transitive dependency is pinned by sha256; nothing is built from source; no `curl | sh`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { type Exec, execCommand, findExecutable } from './engine.js';

export const FETCH_PACKAGE = 'mcp-server-fetch';
export const FETCH_VERSION = '2026.11.4';
/** A fetch answers at most this many characters a call (page through with `start_index`). */
export const FETCH_MAX_CHARS = 20_000;
export const FETCH_URL_MAX = 2048;
const FETCH_TIMEOUT_MS = 15_000;
/** The whole call: process start, robots.txt, the page and the answer. */
export const FETCH_CALL_DEADLINE_MS = 60_000;
const MIN_PYTHON: readonly [number, number] = [3, 10];

/** `packages/crew/adapters/web-source.lock`, from `src/…` and `dist/…` alike (both four levels down). */
export function lockPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'adapters', 'web-source.lock');
}

export interface LockedPackage {
  name: string;
  version: string;
  /** The environment marker, when the pin applies to some Pythons or platforms only. */
  markers: string | null;
  sha256: string[];
}

export interface LockInfo {
  /** sha256 of the lock file: what a person consents to, and the venv's directory name. */
  sha256: string;
  packages: LockedPackage[];
}

/** Parse a `--generate-hashes` requirements file. */
export function parseLock(text: string): LockInfo {
  const packages: LockedPackage[] = [];
  let cur: LockedPackage | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\\\s*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const h = /^--hash=sha256:([0-9a-f]{64})$/.exec(line);
    if (h !== null) {
      if (cur === null) throw new Error('a hash before any requirement');
      cur.sha256.push(h[1] as string);
      continue;
    }
    const m = /^([A-Za-z0-9._-]+)==([^\s;]+)\s*(?:;\s*(.+))?$/.exec(line);
    if (m === null) throw new Error(`not a pinned requirement: ${line}`);
    cur = { name: (m[1] as string).toLowerCase(), version: m[2] as string, markers: m[3]?.trim() ?? null, sha256: [] };
    packages.push(cur);
  }
  const unhashed = packages.find((p) => p.sha256.length === 0);
  if (unhashed !== undefined) throw new Error(`${unhashed.name} has no hash`);
  return { sha256: createHash('sha256').update(text).digest('hex'), packages };
}

/** The lock as it is NOW (read afresh: an in-place upgrade is seen at once). */
export function readLock(path: string = lockPath()): LockInfo & { text: string } {
  const text = readFileSync(path, 'utf8');
  return { ...parseLock(text), text };
}

/** `<mcp state dir>/adapters/web/<lock sha12>`: one venv per lock. */
export function venvDir(mcpDir: string, lockSha: string): string {
  return join(mcpDir, 'adapters', 'web', lockSha.slice(0, 12));
}

export function venvPython(venv: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
}

const MARKER = '.crew-installed';

/** Whether the venv for this lock was installed completely. */
export function venvInstalled(venv: string, lockSha: string): boolean {
  try {
    return readFileSync(join(venv, MARKER), 'utf8').trim() === lockSha && existsSync(venvPython(venv));
  } catch {
    return false;
  }
}

export type PythonFound = { ok: true; cmd: string; version: string } | { ok: false; reason: string };

/** A Python ≥ 3.10: versioned names first (macOS's `/usr/bin/python3` is often 3.9). */
export async function findPython(exec: Exec = execCommand, find: (n: string) => Promise<string | null> = (n) => findExecutable(n, ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])): Promise<PythonFound> {
  const seen: string[] = [];
  for (const name of ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python']) {
    const cmd = await find(name);
    if (cmd === null || seen.includes(cmd)) continue;
    seen.push(cmd);
    const r = await exec(cmd, ['-I', '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], { timeoutMs: 10_000 });
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(r.stdout.trim());
    if (r.code !== 0 || m === null) continue;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) return { ok: true, cmd, version: m[0] };
  }
  return { ok: false, reason: 'Reading web pages needs Python 3.10 or newer: install it (python.org, or your package manager), then try again' };
}

export class WebInstallError extends Error {
  constructor(readonly code: 'python_missing' | 'venv_failed' | 'pip_failed', message: string) {
    super(message);
    this.name = 'WebInstallError';
  }
}

/** The public package index the lock's hashes were taken from. */
export const PYPI_INDEX = 'https://pypi.org/simple';

/**
 * The installer's whole environment: the network settings a person's machine needs to reach the index (proxy and CA
 * variables), and nothing that configures pip or carries a credential: no `PIP_*`, no pip configuration file
 * (`PIP_CONFIG_FILE` = the null device), `HOME` an empty crew directory (no `~/.netrc`, no `~/.pip`).
 */
export function installEnv(home: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const out: Record<string, string> = { HOME: home, PIP_CONFIG_FILE: platform === 'win32' ? 'NUL' : '/dev/null', PIP_NO_INPUT: '1', LANG: 'C.UTF-8' };
  if (env['PATH'] !== undefined) out['PATH'] = env['PATH'];
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']) if (env[k] !== undefined) out[k] = env[k] as string;
  if (platform === 'win32') {
    out['USERPROFILE'] = home;
    for (const k of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (env[k] !== undefined) out[k] = env[k] as string;
  } else {
    out['TMPDIR'] = home;
  }
  return out;
}

/** pip's arguments: isolated (no configuration, no `PIP_*`), the public index, hashes required, wheels only. */
export function pipArgs(lockFile: string): string[] {
  return ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', '--no-input', '--index-url', PYPI_INDEX, '--require-hashes', '--only-binary', ':all:', '--no-cache-dir', '-r', lockFile];
}

/**
 * Build the venv from EXACTLY the consented lock bytes (idempotent: an installed venv for that lock is kept). The bytes
 * are written beside the venv and pip reads that copy, so a crew upgrade that replaces the packaged lock meanwhile
 * changes nothing that was consented to.
 */
export async function installVenv(opts: { python: string; venv: string; lockText: string; lockSha: string; home: string; exec?: Exec; log?: (m: string) => void }): Promise<void> {
  if (createHash('sha256').update(opts.lockText).digest('hex') !== opts.lockSha) throw new WebInstallError('pip_failed', 'the lock bytes are not the consented lock');
  if (venvInstalled(opts.venv, opts.lockSha)) return;
  const exec = opts.exec ?? execCommand;
  await rm(opts.venv, { recursive: true, force: true });
  await mkdir(dirname(opts.venv), { recursive: true, mode: 0o700 });
  await mkdir(opts.home, { recursive: true, mode: 0o700 });
  const env = installEnv(opts.home);
  const lockFile = `${opts.venv}.lock`;
  await writeFile(lockFile, opts.lockText, { mode: 0o600 });
  const v = await exec(opts.python, ['-I', '-m', 'venv', opts.venv], { env, timeoutMs: 120_000 });
  if (v.code !== 0) throw new WebInstallError('venv_failed', `python -m venv failed: ${v.stderr.trim().slice(-400)}`);
  const pip = await exec(venvPython(opts.venv), pipArgs(lockFile), { env, timeoutMs: 15 * 60_000 });
  if (pip.code !== 0) {
    await rm(opts.venv, { recursive: true, force: true });
    throw new WebInstallError('pip_failed', `pip could not install the locked packages: ${(pip.stderr || pip.stdout).trim().slice(-600)}`);
  }
  await writeFile(join(opts.venv, MARKER), `${opts.lockSha}\n`, { mode: 0o600 });
}

/** The most a reader decodes of one response (a compressed page included). */
export const READER_DECODED_MAX = 8 * 1024 * 1024;

/**
 * crew's bootstrap for the pinned reader (httpx 0.28.1 in the lock): the proxy from the env, decoded bytes capped,
 * cookies never kept, the address space bounded on Linux; then the unmodified server.
 */
export const READER_BOOTSTRAP = [
  'import os, sys, runpy, zlib',
  "proxy = os.environ.pop('CREW_WEB_PROXY', '')",
  "if not (proxy.startswith('http://') and '@127.0.0.1:' in proxy): sys.exit('crew web reader: no crew proxy given')",
  "cap = int(os.environ.pop('CREW_WEB_DECODED_MAX', '0'))",
  "if cap <= 0: sys.exit('crew web reader: no decoded cap given')",
  'try:',
  '    import resource',
  "    if sys.platform.startswith('linux'): resource.setrlimit(resource.RLIMIT_AS, (2 << 30, 2 << 30))",
  'except Exception:',
  '    pass',
  'import httpx',
  'from httpx import _decoders, _models',
  'def _over(n):',
  "    raise httpx.DecodingError('crew: the page is larger than %d bytes once decoded' % cap)",
  // Decompression bounded INSIDE zlib (max_length), so no chunk larger than the cap is ever allocated.
  'class _Bounded(_decoders.ContentDecoder):',
  '    def __init__(self, wbits, retry):',
  '        self.wbits, self.retry, self.n = wbits, retry, 0',
  '        self.d = zlib.decompressobj(wbits)',
  '    def _run(self, data):',
  '        parts = []',
  '        while data:',
  '            out = self.d.decompress(data, cap - self.n + 1)',
  '            self.n += len(out)',
  '            if self.n > cap: _over(self.n)',
  '            parts.append(out)',
  '            data = self.d.unconsumed_tail',
  "        return b''.join(parts)",
  '    def decode(self, data):',
  '        retry, self.retry = self.retry, False',
  '        try:',
  '            return self._run(data)',
  '        except zlib.error as exc:',
  '            if retry:',
  '                self.wbits, self.n = -zlib.MAX_WBITS, 0',
  '                self.d = zlib.decompressobj(self.wbits)',
  '                return self.decode(data)',
  '            raise httpx.DecodingError(str(exc)) from exc',
  '    def flush(self):',
  '        try:',
  '            out = self.d.flush()',
  '        except zlib.error as exc:',
  '            raise httpx.DecodingError(str(exc)) from exc',
  '        self.n += len(out)',
  '        if self.n > cap: _over(self.n)',
  '        return out',
  "_models.SUPPORTED_DECODERS['gzip'] = lambda: _Bounded(zlib.MAX_WBITS | 16, False)",
  "_models.SUPPORTED_DECODERS['deflate'] = lambda: _Bounded(zlib.MAX_WBITS, True)",
  'def _layered(children):',
  "    raise httpx.DecodingError('crew: a page with more than one content encoding is refused')",
  '_models.MultiDecoder = _layered',
  // And the whole decoded body, across chunks.
  '_aiter, _iter = _models.Response.aiter_bytes, _models.Response.iter_bytes',
  'async def aiter_bytes(self, chunk_size=None):',
  '    n = 0',
  '    async for c in _aiter(self, chunk_size):',
  '        n += len(c)',
  '        if n > cap: _over(n)',
  '        yield c',
  'def iter_bytes(self, chunk_size=None):',
  '    n = 0',
  '    for c in _iter(self, chunk_size):',
  '        n += len(c)',
  '        if n > cap: _over(n)',
  '        yield c',
  '_models.Response.aiter_bytes = aiter_bytes',
  '_models.Response.iter_bytes = iter_bytes',
  '_models.Cookies.extract_cookies = lambda self, response: None',
  "sys.argv = ['mcp_server_fetch'] + sys.argv[1:] + ['--proxy-url', proxy]",
  "runpy.run_module('mcp_server_fetch', run_name='__main__', alter_sys=True)",
].join('\n');

/** The reader's command line: robots always respected, private addresses always refused, no credential on it. */
export function fetchArgv(): string[] {
  return ['-I', '-c', READER_BOOTSTRAP, '--no-readability-js', '--timeout-ms', String(FETCH_TIMEOUT_MS)];
}

/** The reader's whole environment: nothing of the daemon's beyond PATH and the locale, plus the call's proxy and cap. */
export function fetchEnv(home: string, python: string, proxyUrl: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const out: Record<string, string> = { PATH: dirname(python), HOME: home, LANG: 'C.UTF-8', PYTHONUTF8: '1', CREW_WEB_PROXY: proxyUrl, CREW_WEB_DECODED_MAX: String(READER_DECODED_MAX) };
  if (platform === 'win32') {
    out['USERPROFILE'] = home;
    for (const k of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (env[k] !== undefined) out[k] = env[k] as string;
  } else {
    out['TMPDIR'] = home;
  }
  return out;
}

export interface FetchArgs {
  url: string;
  max_length: number;
  start_index: number;
}

/** The agent's arguments, checked and clamped; a string = why they are refused. */
export function fetchArgs(args: Record<string, unknown>): FetchArgs | string {
  const url = args['url'];
  if (typeof url !== 'string' || url.length === 0 || url.length > FETCH_URL_MAX) return `url is an http(s) URL of at most ${FETCH_URL_MAX} characters`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'url is not a URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'url must be http or https';
  if (u.username !== '' || u.password !== '') return 'a URL carrying a user name or password is refused: the web source sends no credentials';
  const ml = args['max_length'];
  const si = args['start_index'];
  if (ml !== undefined && (typeof ml !== 'number' || !Number.isInteger(ml) || ml < 1)) return 'max_length is a positive integer';
  if (si !== undefined && (typeof si !== 'number' || !Number.isInteger(si) || si < 0)) return 'start_index is a non-negative integer';
  return { url: u.toString(), max_length: Math.min(typeof ml === 'number' ? ml : 5000, FETCH_MAX_CHARS), start_index: typeof si === 'number' ? si : 0 };
}

export interface FetchResult {
  text: string;
  isError: boolean;
  /** crew cut the reader's text (an error included: a robots refusal quotes the whole robots.txt). */
  clipped?: boolean;
}

/** The whole answer an agent gets is bounded: the page's characters plus the reader's own heading. */
export const FETCH_TEXT_MAX = FETCH_MAX_CHARS + 512;
export function clampText(text: string): { text: string; clipped: boolean } {
  return text.length <= FETCH_TEXT_MAX ? { text, clipped: false } : { text: `${text.slice(0, FETCH_TEXT_MAX)}\n[crew cut this answer at ${FETCH_TEXT_MAX} characters]`, clipped: true };
}

/** One fetch: start the reader, call `fetch` once, stop it. */
export async function runFetch(opts: { python: string; proxyUrl: string; home: string; args: FetchArgs; deadlineMs?: number }): Promise<FetchResult> {
  await mkdir(opts.home, { recursive: true, mode: 0o700 });
  const transport = new StdioClientTransport({ command: opts.python, args: fetchArgv(), env: fetchEnv(opts.home, opts.python, opts.proxyUrl), stderr: 'pipe' });
  transport.stderr?.on('data', () => undefined);
  const client = new Client({ name: 'wicked-crew-web-source', version: '1' }, { capabilities: {} });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => reject(new Error('the page reader did not answer in time')), opts.deadlineMs ?? FETCH_CALL_DEADLINE_MS);
  });
  const work = (async (): Promise<FetchResult> => {
    await client.connect(transport);
    const r = (await client.callTool({ name: 'fetch', arguments: { ...opts.args } })) as { content?: unknown; isError?: unknown };
    const parts = Array.isArray(r.content) ? r.content : [];
    const text = parts.map((p) => (typeof p === 'object' && p !== null && (p as Record<string, unknown>)['type'] === 'text' ? String((p as Record<string, unknown>)['text'] ?? '') : '')).join('\n');
    return { ...clampText(text), isError: r.isError === true };
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}
