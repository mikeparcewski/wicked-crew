/**
 * What the server checks before it serves and keeps checking while it runs (DES-APPS-001 §8.2 "Secrets").
 *
 * 1. Every environment name the manifest lists is set and not empty; a missing one stops the server,
 *    naming it ({@link missingSecrets}).
 * 2. Every `sql` and `graphql` source is described live with crew's describe ({@link describeSources}); the
 *    description replaces the one the image's registry answers, so the executor recomputes each contract
 *    against today's source.
 * 3. Every query (crew's `checkQuery`) and every action (crew's `checkAction`: the grant, the descriptor,
 *    Allow writes and, for a row write, the table safety check against the live catalog) is checked
 *    without being run ({@link checkEverything}). A refusal names the query or action and its reason: it is
 *    not served (the executor and the write path refuse it themselves at every call), and `/healthz` and
 *    `GET /spec` list it.
 *
 * Steps 2-3 run again every 10 minutes and, for one source, after any read of it fails.
 */

import type { AppExecutor, AppPublishManifest, AppWritePath, DialOptions } from './crew.js';
import { AppExecError, AppWriteError, describeSource, probeMcpServer, restTarget, toolSchemaHash } from './crew.js';
import type { ImageRegistry } from './image.js';
import type { JsonLines } from './log.js';
import type { Site } from './site.js';

export interface Refusal {
  kind: 'query' | 'action';
  id: string;
  reason: string;
}

export class SiteState {
  readonly refused = new Map<string, Refusal>();
  /** Whether actions run on this site, and if not, why. */
  actions: { on: boolean; reason: string | null } = { on: false, reason: 'not checked yet' };
  checkedAt: number | null = null;

  list(): Refusal[] {
    return [...this.refused.values()].sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
  }
}

export const REDESCRIBE_MS = 10 * 60 * 1000;
const DESCRIBE_DEADLINE_MS = 20_000;

/** The environment names the manifest lists that are unset or empty, sorted. */
export function missingSecrets(manifest: Pick<AppPublishManifest, 'env'>, env: NodeJS.ProcessEnv = process.env): string[] {
  return [...manifest.env].filter((name) => (env[name] ?? '') === '').sort();
}

/** A failure's class, never its message (a driver's message can echo a value). */
function codeOf(err: unknown): string {
  const e = err as { code?: unknown; errorClass?: unknown; sqlstate?: unknown };
  if (typeof e?.code === 'string' && /^[a-z0-9_.-]{1,40}$/i.test(e.code)) return e.code;
  if (typeof e?.errorClass === 'string') return e.errorClass + (typeof e.sqlstate === 'string' ? ` ${e.sqlstate}` : '');
  return err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'error';
}

export async function describeOne(site: Site, registry: ImageRegistry, name: string, deps: { dial?: DialOptions; log: JsonLines; now?: () => number }): Promise<boolean> {
  const config = registry.config(name);
  if (config === null) return true;
  const now = deps.now ?? Date.now;
  const g = registry.beginDescribe(name);
  try {
    const { secret, missing } = await registry.callSecret(config);
    if (missing) throw Object.assign(new Error('secret missing'), { code: 'secret_missing' });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('describe deadline'), { code: 'timeout' })), DESCRIBE_DEADLINE_MS);
    });
    const bounded = <T>(p: Promise<T>): Promise<T> => Promise.race([p, deadline]).finally(() => clearTimeout(timer));
    if (config.kind === 'rest' || config.kind === 'mcp-http') {
      // The server's operations as it shows them NOW, hashed as crew hashed them at publish (crew's probe).
      const probed = await bounded(probeMcpServer(config, secret));
      if (!probed.ok) throw Object.assign(new Error('probe failed'), { code: 'probe_failed' });
      const target = config.kind === 'rest' ? restTarget(config) : null;
      registry.setObserved(name, new Map(probed.tools.map((t) => [t.name, toolSchemaHash(t, target)])), g);
      // A pasted OpenAPI document is the contract the person declared (its hash is in the source's descriptor): there
      // is nothing live to re-describe, and every answer is validated against the declared columns at each call.
      if (config.kind === 'rest' && (config.openapiUrl ?? null) === null) {
        deps.log.write({ log: 'startup', event: 'described', source: name, from: 'the pasted OpenAPI document (no live contract endpoint): answers are validated at every call' });
        return true;
      }
    } else if (config.kind === 'sql' || config.kind === 'graphql') {
      registry.setDescription(name, await bounded(describeSource(config, secret, deps.dial ?? {}, site.snapshotDir)), g);
    } else {
      clearTimeout(timer);
      return true;
    }
    deps.log.write({ log: 'startup', event: 'described', source: name });
    return true;
  } catch (err) {
    const code = codeOf(err);
    registry.setDown(name, code, now(), g);
    deps.log.write({ log: 'startup', event: 'describe_failed', source: name, code });
    return false;
  }
}

export async function describeSources(site: Site, registry: ImageRegistry, deps: { dial?: DialOptions; log: JsonLines; now?: () => number }): Promise<void> {
  await Promise.all(registry.names().map((name) => describeOne(site, registry, name, deps)));
}

const reasonOf = (err: unknown): string => (err instanceof AppExecError || err instanceof AppWriteError ? `${err.code}: ${err.message}` : `error: ${codeOf(err)}`);

export async function checkEverything(
  site: Site,
  deps: { executor: AppExecutor; writePath: AppWritePath | null; registry: ImageRegistry; state: SiteState; log: JsonLines; actionsOff: string | null; now?: () => number },
): Promise<void> {
  const { app } = site.manifest;
  const next = new Map<string, Refusal>();
  const refuse = (r: Refusal): void => {
    next.set(`${r.kind}:${r.id}`, r);
  };
  for (const q of site.files.spec.queries) {
    const down = deps.registry.downOf(q.source);
    if (down !== null) {
      refuse({ kind: 'query', id: q.id, reason: `source_unavailable: ${q.source} could not be described (${down.reason}); the server tries again` });
      continue;
    }
    try {
      await deps.executor.checkQuery(app.slug, app.version, q.id);
    } catch (err) {
      refuse({ kind: 'query', id: q.id, reason: reasonOf(err) });
    }
  }
  // Actions off for the whole site (no volume, APPS_READ_ONLY): `actions: false` says so once; nothing is broken.
  for (const a of deps.actionsOff !== null || deps.writePath === null ? [] : site.files.spec.actions) {
    if (deps.writePath === null) continue;
    const down = deps.registry.downOf(a.source);
    if (down !== null) {
      refuse({ kind: 'action', id: a.id, reason: `source_unavailable: ${a.source} could not be described (${down.reason}); the server tries again` });
      continue;
    }
    try {
      await deps.writePath!.checkAction(app.slug, a.id, app.version);
    } catch (err) {
      refuse({ kind: 'action', id: a.id, reason: reasonOf(err) });
    }
  }
  // Swap in one step: a route reading the list sees the old one or the new one, never half of it.
  deps.state.refused.clear();
  for (const [k, v] of next) deps.state.refused.set(k, v);
  deps.state.checkedAt = (deps.now ?? Date.now)();
  for (const r of next.values()) deps.log.write({ log: 'startup', event: 'refused', kind: r.kind, id: r.id, reason: r.reason });
}
