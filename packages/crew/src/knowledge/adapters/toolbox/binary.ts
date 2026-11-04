/**
 * The pinned MCP Toolbox for Databases binary (DES-KNOWLEDGE-DATA-001 §6.3, §16 "supply chain"): one release,
 * one sha256 per platform, downloaded ONCE into crew's state dir and verified before it is ever made
 * executable. A binary whose bytes do not match the pin is never run (and is removed).
 *
 * `<state home>/mcp/adapters/toolbox/<version>/<os>-<arch>/toolbox[.exe]`: inside the `mcp` state-home entry,
 * which workers are fenced out of (so no worker can read the run documents or swap the binary). The download is crew's own egress to
 * Google's release bucket over https, no redirect followed. The version check is off at spawn
 * (`--disable-version-check`), so the binary never phones home on its own.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { mcpStateDir } from '../../../mcp/registry-store.js';

export const TOOLBOX_VERSION = '1.15.0';

/** The release's published checksums (googleapis/genai-toolbox v1.15.0 release notes). linux/arm64 has none at this release. */
export const TOOLBOX_PINS: Readonly<Record<string, string>> = Object.freeze({
  'linux-x64': 'f6fac005c39898a379523700727a2a3d0a2828f579bec22cc0efe74e0652062d',
  'darwin-arm64': 'ddf69a8cd52904f86532d5e195d06e5d4c158de61c69dc17bd4d8b6203fc52fc',
  'darwin-x64': '7407018697f346ae1ca6e610ed6096d26173349289ba61c62017efd7dc81376b',
  'win32-x64': '354fdc30bf9afdefdeb512086da9aaf38c1b447ed596d0e4109b5d3bf581ceee',
  'win32-arm64': '5f0047762f0d68f057bbc2f99abc19dd2e4f2d56479589c24a98784ee15572af',
});

const RELEASE_OS: Record<string, string> = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
const RELEASE_ARCH: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };

/** The largest binary crew accepts (the release is ~155 MB). */
const MAX_BYTES = 400 * 1024 * 1024;

export class ToolboxBinaryError extends Error {
  constructor(
    readonly code: 'toolbox_unsupported_platform' | 'toolbox_download_failed' | 'toolbox_checksum_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'ToolboxBinaryError';
  }
}

export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function toolboxUrl(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = RELEASE_OS[platform];
  const a = RELEASE_ARCH[arch];
  if (os === undefined || a === undefined) throw new ToolboxBinaryError('toolbox_unsupported_platform', `MCP Toolbox ${TOOLBOX_VERSION} has no binary for ${platform}/${arch}`);
  return `https://storage.googleapis.com/mcp-toolbox-for-databases/v${TOOLBOX_VERSION}/${os}/${a}/toolbox${platform === 'win32' ? '.exe' : ''}`;
}

/** `<state home>/mcp/adapters/toolbox`: the binaries and each source's run directory. */
export function toolboxRoot(mcpDir: string = mcpStateDir()): string {
  return join(mcpDir, 'adapters', 'toolbox');
}

/** Each source's run directory lives here (its `tools.yaml`, placeholders only). */
export function toolboxRunRoot(mcpDir: string = mcpStateDir()): string {
  return join(toolboxRoot(mcpDir), 'run');
}

export function toolboxPath(mcpDir: string = mcpStateDir(), platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return join(toolboxRoot(mcpDir), TOOLBOX_VERSION, platformKey(platform, arch), platform === 'win32' ? 'toolbox.exe' : 'toolbox');
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export interface ToolboxBinaryDeps {
  /** The `mcp` state directory (default `<state home>/mcp`). */
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof fetch;
  /** TESTS ONLY: pins to check against (production: {@link TOOLBOX_PINS}). */
  pins?: Readonly<Record<string, string>>;
}

/**
 * The verified binary's path: the one already in the state dir when its bytes match the pin (checked once
 * per process), else downloaded, verified, then made executable. Concurrent callers share one attempt.
 */
export class ToolboxBinary {
  private verified: string | null = null;
  private pending: Promise<string> | null = null;

  constructor(private readonly deps: ToolboxBinaryDeps = {}) {}

  ensure(): Promise<string> {
    if (this.verified !== null) return Promise.resolve(this.verified);
    this.pending ??= this.locate().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async locate(): Promise<string> {
    const platform = this.deps.platform ?? process.platform;
    const arch = this.deps.arch ?? process.arch;
    const pin = (this.deps.pins ?? TOOLBOX_PINS)[platformKey(platform, arch)];
    if (pin === undefined) throw new ToolboxBinaryError('toolbox_unsupported_platform', `MCP Toolbox ${TOOLBOX_VERSION} has no pinned binary for ${platform}/${arch}`);
    const path = toolboxPath(this.deps.home, platform, arch);
    const present = await stat(path).then(
      (s) => s.isFile(),
      () => false,
    );
    if (present) {
      if ((await sha256File(path)) === pin) {
        this.verified = path;
        return path;
      }
      // Not the pinned bytes: never run it.
      await rm(path, { force: true });
    }
    await this.download(toolboxUrl(platform, arch), path, pin);
    this.verified = path;
    return path;
  }

  private async download(url: string, path: string, pin: string): Promise<void> {
    const dir = join(path, '..');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.download-${randomUUID()}`);
    const f = this.deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(url, { redirect: 'error' });
    } catch (err) {
      throw new ToolboxBinaryError('toolbox_download_failed', `MCP Toolbox ${TOOLBOX_VERSION} could not be downloaded: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok || res.body === null) throw new ToolboxBinaryError('toolbox_download_failed', `MCP Toolbox ${TOOLBOX_VERSION} could not be downloaded (HTTP ${res.status})`);
    const h = createHash('sha256');
    const fh = await open(tmp, 'w', 0o600);
    let bytes = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) throw new ToolboxBinaryError('toolbox_download_failed', `the MCP Toolbox download is larger than ${MAX_BYTES} bytes`);
        h.update(chunk);
        await fh.write(chunk);
      }
      await fh.close();
      const got = h.digest('hex');
      if (got !== pin) throw new ToolboxBinaryError('toolbox_checksum_mismatch', `the MCP Toolbox ${TOOLBOX_VERSION} download does not match its pinned sha256 (got ${got.slice(0, 12)}…)`);
      await chmod(tmp, 0o700);
      await rename(tmp, path);
    } catch (err) {
      await fh.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw err;
    }
  }
}
