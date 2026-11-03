/**
 * `wicked-apps-server`: the standalone site an Apps publish puts in its container image (DES-APPS-001
 * §8.2). It reads the image's `/srv/site`, checks it, and serves the page, the spec, the named queries and
 * the granted actions of the ONE published version, with crew's executor and write path.
 *
 * Environment (the deployer's):
 *   the manifest's environment names   each source's secret; a missing one stops the server, naming it
 *   APPS_READ_ONLY=1                    no action runs (checked at every prepare and run)
 *   PORT                                default 8080
 * Volume: `/data` (an app with actions): the action records, the audit and decision logs. Without it every
 * action is refused, saying why; reads still work.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { type ActionTx, type Actor, AppActionStore, AppExecutor, AppWriteError, AppWritePath, type DialOptions, SITE_PORT, TEAMS_FRAME_ORIGINS, type Viewer } from './crew.js';
import { SignIn, type SiteSignIn } from './identity.js';
import { ImageFiles, ImageRegistry } from './image.js';
import { auditSink, JsonLines } from './log.js';
import { isMountPoint } from './mount.js';
import { type Claim, claimDataDir } from './owner.js';
import { composePage, originOf, pageCsp, type SiteBoot } from './page.js';
import { createSiteServer } from './server.js';
import { loadSite, SiteError, type Site } from './site.js';
import { checkEverything, describeOne, describeSources, missingSecrets, REDESCRIBE_MS, SiteState } from './startup.js';

/**
 * crew's action store, fenced on this server's claim of the volume: once another server owns it, every store step
 * (a grant seeded, a record prepared, the move to `running`, an outcome) is refused before it reads or writes.
 */
class FencedActionStore extends AppActionStore {
  constructor(
    file: string,
    private readonly owns: () => boolean,
  ) {
    super(file);
  }

  override async locked<T>(fn: (tx: ActionTx) => T | Promise<T>): Promise<T> {
    const fence = (): void => {
      if (!this.owns()) throw new AppWriteError(409, 'actions_off', 'another wicked-apps-server owns this volume now: this one changes nothing');
    };
    fence();
    return super.locked(async (tx) => {
      fence();
      return fn(tx);
    });
  }
}

export interface StartOptions {
  siteDir: string;
  dataDir: string;
  /** The in-process host's built script and stylesheet (the image's `/srv/server/shim/`). */
  hostJs: string;
  hostCss: string;
  port: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  dial?: DialOptions;
  /** Tests only. */
  isMount?: (dir: string) => boolean;
  verify?: SiteSignIn['verify'];
  out?: (line: string) => void;
}

export interface RunningSite {
  server: Server;
  port: number;
  site: Site;
  state: SiteState;
  registry: ImageRegistry;
  /** Describe every source again and recheck every query and action now (what the 10-minute timer does). */
  refresh(): Promise<void>;
  close(): Promise<void>;
}

const readOnly = (env: NodeJS.ProcessEnv): boolean => {
  const v = env['APPS_READ_ONLY'];
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
};

/** Start the site, or throw a {@link SiteError} that names what stops it (a failed start releases its volume claim). */
export async function startSite(opts: StartOptions): Promise<RunningSite> {
  const held: { claim: Claim | null } = { claim: null };
  try {
    return await startSiteWith(opts, held);
  } catch (err) {
    held.claim?.release();
    throw err;
  }
}

async function startSiteWith(opts: StartOptions, held: { claim: Claim | null }): Promise<RunningSite> {
  const env = opts.env ?? process.env;
  const site = loadSite(opts.siteDir);
  const { manifest } = site;
  const missing = missingSecrets(manifest, env);
  if (missing.length > 0) throw new SiteError(`the environment does not set ${missing.join(', ')}: pass ${missing.length === 1 ? 'it' : 'each'} to the container (docker run -e ${missing[0]}=…)`);

  const mounted = (opts.isMount ?? isMountPoint)(opts.dataDir);
  const hasActions = site.files.spec.actions.length > 0;
  const actionsOff = !hasActions ? 'this app has no action' : !mounted ? `no volume is mounted at ${opts.dataDir}: actions need one for their records (docker run -v <volume>:${opts.dataDir})` : readOnly(env) ? 'APPS_READ_ONLY is set' : null;
  const logDir = mounted ? join(opts.dataDir, 'log') : null;
  const decisions = new JsonLines(logDir, 'decisions.jsonl', opts.out);
  const audit = new JsonLines(logDir, 'audit.jsonl', opts.out);
  const startupLog = new JsonLines(null, '', opts.out);

  const files = new ImageFiles(site);
  const registry = new ImageRegistry(site.sources, manifest.sources, env);
  // The routes put each request's verified viewer on its actor; crew's executor and write path read it here.
  const viewers = new WeakMap<Actor, Viewer>();
  const viewerOf = async (actor: Actor): Promise<Viewer> => viewers.get(actor) ?? { id: actor.id, email: null, name: null, groups: [] };
  const executor = new AppExecutor({ store: files, registry, viewerOf, ...(opts.dial !== undefined ? { dial: opts.dial } : {}), snapshotDir: site.snapshotDir });
  let writePath: AppWritePath | null = null;
  let actions: AppActionStore | null = null;
  // The grants the image enforces are the manifest's (revoking = publishing again without one). They are set
  // again before every check: one a check withdrew (its source changed) comes back only when the source is as
  // it was granted again, which the write path rechecks at every prepare and run.
  const seedGrants = async (): Promise<void> => {
    await actions?.locked((tx) => {
      for (const a of manifest.actions) tx.setGrant(structuredClone(a.grant));
    });
  };
  const state = new SiteState();
  if (hasActions && mounted) {
    // One server per volume: a second one stops here, naming the owner (DES §7.3).
    const claim = await claimDataDir(opts.dataDir, {
      onLost: () => {
        state.actions = { on: false, reason: `another wicked-apps-server took ${opts.dataDir} over: this one runs no more actions` };
      },
    });
    held.claim = claim;
    // Every store step is fenced on the claim: a server whose volume was taken over writes nothing more, at once.
    actions = new FencedActionStore(join(opts.dataDir, 'apps-actions.json'), () => claim.held());
    await seedGrants();
    writePath = new AppWritePath({ store: files, actions, registry, audit: auditSink(audit), viewerOf, executor, env, ...(opts.dial !== undefined ? { dial: opts.dial } : {}) });
  }
  state.actions = actionsOff === null ? { on: true, reason: null } : { on: false, reason: actionsOff };

  // One check at a time: a periodic pass and an error-triggered one never run together (the later one waits).
  let checking: Promise<void> = Promise.resolve();
  const recheck = (): Promise<void> => {
    checking = checking
      .then(async () => {
        await seedGrants();
        await checkEverything(site, { executor, writePath, registry, state, log: startupLog, actionsOff });
      })
      .catch((err: unknown) => startupLog.write({ log: 'startup', event: 'check_failed', error: err instanceof Error ? err.name : 'error' }));
    return checking;
  };
  const describeDeps = { ...(opts.dial !== undefined ? { dial: opts.dial } : {}), log: startupLog };
  await describeSources(site, registry, describeDeps);
  await recheck();

  let stopping = false;
  const inflight = new Set<Promise<void>>();
  const lastTry = new Map<string, number>();
  const onSourceError = (source: string): void => {
    if (stopping) return;
    const t = Date.now();
    if (t - (lastTry.get(source) ?? 0) < 30_000) return;
    lastTry.set(source, t);
    void describeOne(site, registry, source, describeDeps).then(recheck, recheck);
  };

  const identity = manifest.identity;
  const signIn = identity === null || manifest.audience.kind === 'public'
    ? null
    : new SignIn({ identity, audience: manifest.audience, teams: manifest.targets.includes('teams'), ...(opts.dial !== undefined ? { dial: opts.dial } : {}), ...(opts.verify !== undefined ? { verify: opts.verify } : {}) });
  const endpoints = identity?.endpoints;
  if (identity !== null && (endpoints === undefined || !endpoints.authorization.startsWith('https://') || !endpoints.token.startsWith('https://'))) throw new SiteError('the manifest names an issuer but not its https endpoints');
  const boot: SiteBoot = {
    app: { slug: manifest.app.slug, name: manifest.app.name },
    origin: manifest.site.origin,
    signIn: identity === null || endpoints === undefined ? null : {
      profile: identity.profile,
      issuer: identity.issuer,
      clientId: identity.clientId,
      scope: identity.scope ?? (identity.profile === 'entra' ? `api://${new URL(manifest.site.origin).host}/${identity.clientId}/access_as_user openid profile` : 'openid email profile groups'),
      authorizationEndpoint: endpoints.authorization,
      tokenEndpoint: endpoints.token,
      ...(endpoints.idTokenAlgs !== undefined ? { idTokenAlgs: endpoints.idTokenAlgs } : {}),
    },
  };
  const page = composePage({ runtimeJs: site.runtime.js, runtimeCss: site.runtime.css, hostJs: opts.hostJs, hostCss: opts.hostCss, boot, title: manifest.app.name });
  const frameAncestors = [...manifest.embedOrigins, ...(manifest.targets.includes('teams') ? TEAMS_FRAME_ORIGINS : [])];
  const csp = pageCsp(page, { connect: boot.signIn === null ? [] : [originOf(boot.signIn.issuer), originOf(boot.signIn.tokenEndpoint)], frameAncestors });

  const trustedProxies = (env['APPS_TRUSTED_PROXIES'] ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');
  let server: Server;
  try {
    server = createSiteServer({ site, page, csp, signIn, executor, writePath, registry, state, decisions, viewers, onSourceError, trustedProxies, stopping: () => stopping, track: (h) => {
      inflight.add(h);
      void h.finally(() => inflight.delete(h));
    } });
  } catch (err) {
    throw new SiteError(err instanceof Error ? err.message : 'the server could not be made');
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => resolve());
  });
  // Every 10 minutes (started only once the site serves: a failed start leaves nothing running).
  const timer = setInterval(() => {
    if (!stopping) void describeSources(site, registry, describeDeps).then(recheck, recheck);
  }, REDESCRIBE_MS);
  timer.unref();
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : opts.port;
  startupLog.write({ log: 'startup', event: 'serving', app: manifest.app.slug, version: manifest.app.version, port, actions: state.actions, refused: state.list().length });
  return {
    server,
    port,
    site,
    state,
    registry,
    refresh: () => describeSources(site, registry, describeDeps).then(recheck, recheck),
    // Stop taking requests and refreshes, let what is in flight finish (a run past its card ends and is recorded),
    // and only then give the volume up: a replacement never loads a store this one may still write.
    close: async () => {
      stopping = true;
      clearInterval(timer);
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), 15_000);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      // Every admitted request finishes (an action's outcome and audit line are written), bounded by a minute.
      const drained = Promise.allSettled([...inflight]);
      await Promise.race([drained, new Promise((r) => setTimeout(r, 60_000).unref())]);
      await checking.catch(() => undefined);
      held.claim?.release();
    },
  };
}

/** The image's entry: everything from the environment and the image's fixed layout. */
async function main(): Promise<void> {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const shimDir = join(here, '..', '..', 'shim');
  const portText = process.env['PORT'] ?? String(SITE_PORT);
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) {
    process.stderr.write(`[apps-server] not starting: PORT=${JSON.stringify(portText).slice(0, 40)} is not a port (1-65535)\n`);
    process.exit(1);
  }
  try {
    const running = await startSite({
      siteDir: process.env['APPS_SITE_DIR'] ?? '/srv/site',
      dataDir: process.env['APPS_DATA_DIR'] ?? '/data',
      hostJs: readFileSync(join(shimDir, 'host.js'), 'utf8'),
      hostCss: readFileSync(join(shimDir, 'host.css'), 'utf8'),
      port,
    });
    const stop = (): void => {
      void running.close().then(() => process.exit(0));
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (err) {
    process.stderr.write(`[apps-server] not starting: ${err instanceof SiteError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : 'error'}\n`);
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) void main();
