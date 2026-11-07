/**
 * Web search (CS9): SearXNG, run UNMODIFIED from its official image, pinned by digest, in the person's container
 * engine. crew pulls the image, writes its settings, starts ONE container published on 127.0.0.1 only, asks its JSON
 * API, and removes the container when the daemon closes.
 *
 * License: SearXNG is AGPL-3.0-or-later. crew does not link, bundle, modify or redistribute it: the person's engine
 * pulls the official image, crew hands it a settings file (configuration, not a modification), and only crew talks
 * to it, on loopback. So AGPL §13's source offer (for modified versions served to network users) does not arise.
 *
 * Its own outbound does NOT go through crew's egress proxy: a container cannot reach a listener on the host's
 * loopback (Rancher Desktop, Docker on Linux), and crew does not put a proxy on any other interface. SearXNG talks
 * only to the fixed engine list below; the agent controls the query text, never a destination; image proxy,
 * favicons and autocomplete are off, so it never fetches a result's URL. crew reads at most
 * {@link SEARCH_READ_BYTES} of its answer and hands an agent at most {@link SEARCH_RESULTS_MAX} results.
 */

import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stringify } from 'yaml';

import type { ContainerEngine, EngineDetection, Exec } from './engine.js';
import { execCommand } from './engine.js';

export const SEARXNG_VERSION = '2026.11.5-3e95f6cd2';
export const SEARXNG_DIGEST = 'sha256:ffad724acd87b8dd312328d18da88ddd42e5c4b1d23231594662620053c13cae';
export const SEARXNG_IMAGE = `docker.io/searxng/searxng:${SEARXNG_VERSION}@${SEARXNG_DIGEST}`;
export const SEARXNG_REVISION = '3e95f6cd2a68add0329cb162907b49289e2bc1fd';
export const SEARXNG_LICENSE = 'AGPL-3.0-or-later';
export const SEARXNG_SOURCE = `https://github.com/searxng/searxng/tree/${SEARXNG_REVISION}`;
export const SEARXNG_LICENSE_NOTE =
  'Search runs SearXNG (AGPL-3.0), unmodified, from its official image, in your container engine. crew only gives it settings and talks to it on this computer; it is not bundled with or changed by crew.';
/** The engines it asks: a minimal list of general web engines. */
export const SEARXNG_ENGINES: readonly string[] = Object.freeze(['brave', 'duckduckgo', 'mojeek', 'wikipedia']);

export const SEARCH_RESULTS_MAX = 10;
export const SEARCH_READ_BYTES = 512 * 1024;
const SEARCH_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 45_000;
const CMD_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 15 * 60_000;
/** The container is removed after this long with no search (and when the daemon closes). */
export const SEARCH_IDLE_STOP_MS = 30 * 60_000;
/** The image's own `searxng` user. */
const SEARXNG_UID = '977:977';

/** The settings crew writes for one start (a fresh secret each time). */
export function searxngSettings(secret: string): string {
  return stringify({
    use_default_settings: { engines: { keep_only: [...SEARXNG_ENGINES] } },
    general: { instance_name: 'crew web source', enable_metrics: false, open_metrics: '' },
    search: { safe_search: 0, autocomplete: '', favicon_resolver: '', formats: ['json'] },
    server: { secret_key: secret, limiter: false, public_instance: false, image_proxy: false, method: 'GET' },
    valkey: { url: false },
    outgoing: { request_timeout: 5.0, max_request_timeout: 10.0, pool_connections: 10, pool_maxsize: 5 },
  });
}

/** One container per crew state home: two daemons on one host never share or remove each other's. */
export function containerName(stateHome: string): string {
  return `wicked-web-search-${createHash('sha256').update(stateHome).digest('hex').slice(0, 8)}`;
}

/** `docker create` arguments: loopback-only publish, no capabilities, no privilege gain, bounded. */
export function createArgs(name: string): string[] {
  return [
    'create',
    '--name', name,
    '--label', 'wicked.crew.web-search=1',
    '--user', SEARXNG_UID,
    '-e', 'FORCE_OWNERSHIP=false',
    '-p', '127.0.0.1::8080',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--memory', '512m',
    '--pids-limit', '256',
    SEARXNG_IMAGE,
  ];
}

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchAnswer {
  results: SearchHit[];
  unresponsive: string[];
}

function stoppedWhileStarting(): SearchUnavailableError {
  return new SearchUnavailableError('search_failed', 'the web source was stopped while its search was starting');
}

export class SearchUnavailableError extends Error {
  constructor(readonly code: 'no_engine' | 'not_installed' | 'search_failed', message: string) {
    super(message);
    this.name = 'SearchUnavailableError';
  }
}

export interface SearxngDeps {
  engine: () => Promise<EngineDetection>;
  stateHome: string;
  /** A crew-owned scratch directory (0700) for the settings handed to the container. */
  scratchDir: string;
  exec?: Exec;
  log?: (message: string) => void;
}

const clip = (s: unknown, n: number): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** SearXNG's JSON answer → what an agent gets: http(s) URLs only, bounded text, at most {@link SEARCH_RESULTS_MAX}. */
export function searchHits(body: unknown): SearchAnswer {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const results: SearchHit[] = [];
  for (const r of Array.isArray(b['results']) ? b['results'] : []) {
    if (results.length >= SEARCH_RESULTS_MAX) break;
    const o = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
    const url = typeof o['url'] === 'string' ? o['url'] : '';
    if (!/^https?:\/\//i.test(url) || url.length > 2048) continue;
    results.push({ url, title: clip(o['title'], 300), snippet: clip(o['content'], 500) });
  }
  const unresponsive = (Array.isArray(b['unresponsive_engines']) ? b['unresponsive_engines'] : []).map((u) => (Array.isArray(u) ? `${String(u[0])}: ${String(u[1])}` : String(u))).slice(0, 10);
  return { results, unresponsive };
}

export class SearxngService {
  private readonly exec: Exec;
  private readonly name: string;
  private port: number | null = null;
  private starting: Promise<number> | null = null;
  private engineUsed: ContainerEngine | null = null;
  private idle: NodeJS.Timeout | null = null;
  /** Bumped by every stop: a start that began before it removes what it made and publishes nothing. */
  private generation = 0;

  constructor(private readonly deps: SearxngDeps) {
    this.exec = deps.exec ?? execCommand;
    this.name = containerName(deps.stateHome);
  }

  get container(): string {
    return this.name;
  }

  private async engine(): Promise<ContainerEngine> {
    const d = await this.deps.engine();
    if (!d.ok) throw new SearchUnavailableError('no_engine', d.reason);
    return d.engine;
  }

  /** Whether the pinned image is in the engine already. */
  async imagePresent(e?: ContainerEngine): Promise<boolean> {
    const eng = e ?? (await this.engine());
    const r = await this.exec(eng.cli, ['image', 'inspect', SEARXNG_IMAGE, '--format', '{{.Id}}'], { env: eng.env, timeoutMs: CMD_TIMEOUT_MS });
    return r.code === 0;
  }

  /** Pull the pinned image (anonymous: crew's own empty client config). */
  async pull(): Promise<void> {
    const eng = await this.engine();
    if (await this.imagePresent(eng)) return;
    const r = await this.exec(eng.cli, ['pull', ...eng.pullArgs, SEARXNG_IMAGE], { env: eng.env, timeoutMs: PULL_TIMEOUT_MS });
    if (r.code !== 0) throw new SearchUnavailableError('search_failed', `${eng.label} could not pull the SearXNG image: ${clip(r.stderr || r.stdout, 300)}`);
  }

  /** The running container's loopback port, starting it when needed. */
  ensure(): Promise<number> {
    if (this.port !== null) return Promise.resolve(this.port);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<number> {
    const gen = this.generation;
    const eng = await this.engine();
    if (!(await this.imagePresent(eng))) throw new SearchUnavailableError('not_installed', 'the web source is not installed: a person installs it on Settings → Sources');
    const run = (args: string[]) => this.exec(eng.cli, args, { env: eng.env, timeoutMs: CMD_TIMEOUT_MS });
    const cancelled = (): boolean => gen !== this.generation;
    // A leftover from a daemon that did not close is removed first.
    await run(['rm', '-f', this.name]);
    // From here a stop knows which engine to remove the container from.
    this.engineUsed = eng;
    try {
      const dir = await mkdtemp(join(this.deps.scratchDir, 'searxng-'));
      try {
        const settings = join(dir, 'settings.yml');
        await writeFile(settings, searxngSettings(randomBytes(32).toString('hex')), { mode: 0o644 });
        const created = await run(createArgs(this.name));
        if (created.code !== 0) throw new SearchUnavailableError('search_failed', `${eng.label} could not create the search container: ${clip(created.stderr, 300)}`);
        if (cancelled()) throw stoppedWhileStarting();
        const copied = await run(['cp', settings, `${this.name}:/etc/searxng/settings.yml`]);
        if (copied.code !== 0) throw new SearchUnavailableError('search_failed', `${eng.label} could not hand the search container its settings: ${clip(copied.stderr, 300)}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      if (cancelled()) throw stoppedWhileStarting();
      const started = await run(['start', this.name]);
      if (started.code !== 0) throw new SearchUnavailableError('search_failed', `${eng.label} could not start the search container: ${clip(started.stderr, 300)}`);
      const mapped = await run(['port', this.name, '8080/tcp']);
      const m = /127\.0\.0\.1:(\d+)/.exec(mapped.stdout);
      if (m === null) throw new SearchUnavailableError('search_failed', 'the search container is not published on 127.0.0.1');
      const port = Number(m[1]);
      const deadline = Date.now() + READY_TIMEOUT_MS;
      for (;;) {
        if (cancelled()) throw stoppedWhileStarting();
        const ok = await loopbackGet(port, '/healthz', 2_000, 4096).then((r) => r.status === 200, () => false);
        if (ok) break;
        if (Date.now() > deadline) throw new SearchUnavailableError('search_failed', 'the search container did not become ready');
        await new Promise((r) => setTimeout(r, 500));
      }
      // Stopped while it started (the source was removed, or the daemon is closing): nothing is published.
      if (cancelled()) throw stoppedWhileStarting();
      this.port = port;
      return port;
    } catch (err) {
      // Whatever failed or was cancelled after the create, this start owns the container: it removes it, with the
      // engine it was made on (a stop that ran meanwhile may have had none to use).
      await run(['rm', '-f', this.name]).catch(() => undefined);
      if (this.engineUsed === eng && this.port === null) this.engineUsed = null;
      throw err;
    }
  }

  /** One search: SearXNG's JSON API on loopback. */
  async search(query: string): Promise<SearchAnswer> {
    if (this.idle !== null) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.stop(), SEARCH_IDLE_STOP_MS);
    this.idle.unref();
    for (let attempt = 0; ; attempt++) {
      const port = await this.ensure();
      try {
        const r = await loopbackGet(port, `/search?${new URLSearchParams({ q: query, format: 'json', safesearch: '0' }).toString()}`, SEARCH_TIMEOUT_MS, SEARCH_READ_BYTES);
        if (r.status !== 200) throw new SearchUnavailableError('search_failed', `the search service answered HTTP ${r.status}`);
        return searchHits(JSON.parse(r.body) as unknown);
      } catch (err) {
        // The container went away (an engine restart): start it again, once.
        if (attempt === 0 && (err as { code?: unknown }).code === 'ECONNREFUSED') {
          this.port = null;
          continue;
        }
        if (err instanceof SearchUnavailableError) throw err;
        throw new SearchUnavailableError('search_failed', `the search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Remove the container (the daemon is closing, or the source was removed). */
  async stop(): Promise<void> {
    this.generation++;
    if (this.idle !== null) clearTimeout(this.idle);
    this.idle = null;
    this.port = null;
    const eng = this.engineUsed;
    if (eng === null) return;
    this.engineUsed = null;
    await this.exec(eng.cli, ['rm', '-f', this.name], { env: eng.env, timeoutMs: CMD_TIMEOUT_MS }).catch(() => undefined);
  }
}

/** A GET to 127.0.0.1:`port`, body read up to `max` bytes (more is an error). */
export function loopbackGet(port: number, path: string, timeoutMs: number, max: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => {
        n += c.length;
        if (n > max) {
          req.destroy(new Error(`the answer is larger than ${max} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}
