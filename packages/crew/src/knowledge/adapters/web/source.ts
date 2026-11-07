/**
 * The web source's runtime (CS9): what is installed, the consented install, and the two operations the gate calls
 * (`search` through SearXNG, `fetch` through the page reader and the egress proxy). Nothing here decides WHO may
 * call: that is the gate's (`gate-web.ts`).
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { WebSourceSetupResponse } from '../../../core/types.js';
import { mcpStateDir } from '../../../mcp/registry-store.js';
import { crewStateHome } from '../../../projects/state-home.js';
import { EgressProxy, type EgressProxyDeps, type EgressReport } from './egress.js';
import { detectEngine, type EngineDetection, type Exec } from './engine.js';
import { FETCH_PACKAGE, FETCH_VERSION, type FetchArgs, type FetchResult, findPython, installVenv, type PythonFound, readLock, runFetch, venvDir, venvInstalled, venvPython } from './fetch.js';
import { type SearchAnswer, SEARXNG_DIGEST, SEARXNG_IMAGE, SEARXNG_LICENSE, SEARXNG_LICENSE_NOTE, SEARXNG_REVISION, SEARXNG_SOURCE, SEARXNG_VERSION, SearxngService } from './searxng.js';

/** How long an engine detection, a Python lookup or an image check is reused (in flight ones are shared). */
const PROBE_TTL_MS = 30_000;

/** One probe, shared while in flight and reused for {@link PROBE_TTL_MS}: concurrent setup reads spawn one process. */
class Probe<T> {
  /** `at` = when it settled; `null` = still running (always shared, whatever its age). */
  private hit: { at: number | null; value: Promise<T> } | null = null;
  constructor(private readonly run: () => Promise<T>, private readonly now: () => number) {}
  get(): Promise<T> {
    const h = this.hit;
    if (h !== null && (h.at === null || this.now() - h.at < PROBE_TTL_MS)) return h.value;
    const value = this.run();
    const entry: { at: number | null; value: Promise<T> } = { at: null, value };
    this.hit = entry;
    value.then(
      () => {
        entry.at = this.now();
      },
      () => {
        if (this.hit === entry) this.hit = null;
      },
    );
    return value;
  }
  forget(): void {
    this.hit = null;
  }
}

export interface FetchOutcome extends FetchResult {
  report: EgressReport;
}

export interface WebSourceDeps {
  mcpDir?: string;
  stateHome?: string;
  exec?: Exec;
  /** TESTS: the engine detection. */
  engine?: () => Promise<EngineDetection>;
  python?: () => Promise<PythonFound>;
  egress?: EgressProxyDeps;
  /** TESTS: replaces the reader process. */
  reader?: (python: string, proxyUrl: string, home: string, args: FetchArgs) => Promise<FetchResult>;
  /** TESTS: replaces SearXNG. */
  searcher?: Pick<SearxngService, 'search' | 'pull' | 'imagePresent' | 'stop'>;
  now?: () => number;
  log?: (message: string) => void;
}

export class WebSource {
  private readonly mcpDir: string;
  private readonly egress: EgressProxy;
  private readonly searx: Pick<SearxngService, 'search' | 'pull' | 'imagePresent' | 'stop'>;
  private readonly now: () => number;
  private readonly engineProbe: Probe<EngineDetection>;
  private readonly pythonProbe: Probe<PythonFound>;
  private readonly imageProbe: Probe<boolean>;
  private installing: Promise<void> | null = null;

  constructor(private readonly deps: WebSourceDeps = {}) {
    this.mcpDir = deps.mcpDir ?? mcpStateDir();
    this.now = deps.now ?? Date.now;
    this.egress = new EgressProxy({ ...(deps.egress ?? {}), ...(deps.log !== undefined ? { log: deps.log } : {}) });
    this.engineProbe = new Probe(() => (deps.engine !== undefined ? deps.engine() : detectEngine({ configDir: join(this.webDir(), 'engine'), ...(deps.exec !== undefined ? { exec: deps.exec } : {}) })), this.now);
    this.pythonProbe = new Probe(() => deps.python?.() ?? findPython(deps.exec), this.now);
    this.imageProbe = new Probe(async () => {
      const e = await this.engine();
      return e.ok ? this.searx.imagePresent(e.engine).catch(() => false) : false;
    }, this.now);
    this.searx =
      deps.searcher ??
      new SearxngService({
        engine: () => this.engine(),
        stateHome: deps.stateHome ?? crewStateHome(),
        scratchDir: this.webDir(),
        ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
        ...(deps.log !== undefined ? { log: deps.log } : {}),
      });
  }

  private webDir(): string {
    return join(this.mcpDir, 'adapters', 'web');
  }

  /** The person's container engine, detected at most every {@link PROBE_TTL_MS}. */
  engine(): Promise<EngineDetection> {
    return this.engineProbe.get();
  }

  private python(): Promise<PythonFound> {
    return this.pythonProbe.get();
  }

  private venv(): string {
    return venvDir(this.mcpDir, readLock().sha256);
  }

  /** The reader is installed for the current lock. */
  readerInstalled(): boolean {
    return venvInstalled(this.venv(), readLock().sha256);
  }

  get isInstalling(): boolean {
    return this.installing !== null;
  }

  /** What the install would put on this host (shown before consent), and where things stand. */
  async setup(registered: boolean, agents: WebSourceSetupResponse['agents']): Promise<WebSourceSetupResponse> {
    const lock = readLock();
    const [engine, python, image] = await Promise.all([this.engine(), this.python(), this.imageProbe.get()]);
    // The source was removed while its search container still runs: it goes now.
    if (!registered) await this.searx.stop();
    const reader = lock.packages.find((p) => p.name === FETCH_PACKAGE);
    return {
      installed: registered && this.readerInstalled() && image,
      registered,
      installing: this.isInstalling,
      lock: { sha256: lock.sha256, packages: lock.packages.map((p) => ({ name: p.name, version: p.version, markers: p.markers, sha256: p.sha256 })) },
      reader: { name: FETCH_PACKAGE, version: FETCH_VERSION, license: 'MIT', sha256: reader?.sha256 ?? [], installed: this.readerInstalled() },
      image: { ref: SEARXNG_IMAGE, version: SEARXNG_VERSION, digest: SEARXNG_DIGEST, license: SEARXNG_LICENSE, revision: SEARXNG_REVISION, source: SEARXNG_SOURCE, note: SEARXNG_LICENSE_NOTE, present: image },
      search: engine.ok ? { ready: true, engine: engine.engine.name, reason: null } : { ready: false, engine: null, reason: engine.reason },
      python: python.ok ? { found: true, version: python.version, reason: null } : { found: false, version: null, reason: python.reason },
      agents,
    };
  }

  /**
   * The consented install: Python ≥ 3.10 and a container engine first (each refusal is its plain reason), then the
   * venv from the lock and the pinned image. One at a time; the caller writes the registry entry after.
   */
  async install(consentedLock: string): Promise<void> {
    if (this.installing !== null) throw new Error('an install is already running');
    this.installing = (async () => {
      // Read the lock bytes ONCE: the hash checked against consent is the hash of exactly what pip installs.
      const lock = readLock();
      if (lock.sha256 !== consentedLock) throw new WebSourceRefusal('consent_stale', 'what you consented to is not what this crew installs (it was upgraded meanwhile): review the sheet again');
      this.engineProbe.forget();
      this.pythonProbe.forget();
      const engine = await this.engine();
      if (!engine.ok) throw new WebSourceRefusal('no_engine', engine.reason);
      const python = await this.python();
      if (!python.ok) throw new WebSourceRefusal('python_missing', python.reason);
      await installVenv({
        python: python.cmd,
        venv: venvDir(this.mcpDir, lock.sha256),
        lockText: lock.text,
        lockSha: lock.sha256,
        home: join(this.webDir(), 'install-home'),
        ...(this.deps.exec !== undefined ? { exec: this.deps.exec } : {}),
      });
      await this.searx.pull();
    })();
    try {
      await this.installing;
    } finally {
      this.installing = null;
      this.imageProbe.forget();
    }
  }

  async search(query: string): Promise<SearchAnswer> {
    const engine = await this.engine();
    if (!engine.ok) throw new WebSourceRefusal('no_engine', engine.reason);
    return this.searx.search(query);
  }

  /** One page read through a fresh proxy credential; the proxy's report says what it reached and whether it was cut. */
  async fetch(args: FetchArgs): Promise<FetchOutcome> {
    if (!this.readerInstalled() && this.deps.reader === undefined) throw new WebSourceRefusal('not_installed', 'the page reader is not installed: a person installs the web source on Settings → Sources');
    const home = join(this.webDir(), 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    const session = await this.egress.open();
    try {
      const python = venvPython(this.venv());
      const r = this.deps.reader !== undefined ? await this.deps.reader(python, session.proxyUrl, home, args) : await runFetch({ python, proxyUrl: session.proxyUrl, home, args });
      return { ...r, report: this.egress.close(session) };
    } catch (err) {
      const report = this.egress.close(session);
      if (report.cut) return { text: '', isError: true, report };
      throw err;
    }
  }

  /** The daemon is closing: the search container and the proxy go. */
  async stop(): Promise<void> {
    await Promise.allSettled([this.searx.stop(), this.egress.stop()]);
  }
}

export class WebSourceRefusal extends Error {
  constructor(readonly code: 'no_engine' | 'python_missing' | 'not_installed' | 'consent_stale', message: string) {
    super(message);
    this.name = 'WebSourceRefusal';
  }
}
