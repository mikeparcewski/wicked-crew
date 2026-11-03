/**
 * (DES-APPS-001 §9.3, slice K6) How the daemon serves Publish: the `apps-publish` launcher over the engine adapter,
 * the unit-token resolver the check and produce routes need, the issuer's discovery through the dialer, and where
 * the runtime and the app server artifact are (both carried in crew's own dist).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Actor } from '../../core/types.js';
import { oidcAddressPolicy } from '../../api/auth.js';
import { dialFetch } from '../../sources/dialer.js';
import type { AppPublishLauncher } from '../store.js';

/** The engine adapter as the publish needs it (crew's `CoreAdapter`). */
export interface PublishAdapter {
  launchRun(input: { problem: string; sessionId: string; clisJson: string; workflow: string; repoRef: string; projectId?: string; excludeSeats?: string[] }): Promise<string>;
  seatsForWorkflow(workflow: string): Promise<unknown>;
  sessionsDetail(): Promise<Array<{ session: { id: string; status: string }; units: Array<{ ord: number; phase_ref: string | null; command?: unknown }> }>>;
  askUnit(token: string): Promise<{ runId: string; ord: number }>;
}

export const APPS_PUBLISH_WORKFLOW = 'apps-publish';
const ENDED = new Set(['completed', 'failed', 'cancelled', 'canceled', 'partially_completed', 'superseded']);

export function publishLauncher(adapter: PublishAdapter, hooks: { launched?: (runId: string, projectId: string, actor: Actor) => void } = {}): AppPublishLauncher {
  return {
    async launch(input) {
      // The preset carries the plan (check → QE forced → produce behind consent); the engine refuses a skip, the host
      // floor, reduced assurance and a QE seat among `excludeSeats` (K0).
      await adapter.launchRun({
        problem: `Publish ${input.name} v${input.version}: check the manifest, accept on fixture evidence, then produce the image after consent`,
        sessionId: input.runId,
        clisJson: JSON.stringify(await adapter.seatsForWorkflow(APPS_PUBLISH_WORKFLOW)),
        workflow: APPS_PUBLISH_WORKFLOW,
        repoRef: input.repoId,
        projectId: input.projectId,
        ...(input.excludeSeats.length > 0 ? { excludeSeats: input.excludeSeats } : {}),
      });
      hooks.launched?.(input.runId, input.projectId, input.actor);
    },
    async isActive(runId) {
      const run = (await adapter.sessionsDetail()).find((s) => s.session.id === runId);
      return run !== undefined && !ENDED.has(run.session.status);
    },
  };
}

/** The unit a capability token belongs to, with its step: only a Tool unit (it has a command) runs crew's CLI. */
export function unitOfToken(adapter: PublishAdapter): (token: string) => Promise<{ runId: string; step: string | null; tool: boolean } | null> {
  return async (token) => {
    let unit: { runId: string; ord: number };
    try {
      unit = await adapter.askUnit(token);
    } catch {
      return null;
    }
    const run = (await adapter.sessionsDetail()).find((s) => s.session.id === unit.runId);
    const u = run?.units.find((x) => x.ord === unit.ord);
    if (u === undefined) return null;
    return { runId: unit.runId, step: u.phase_ref, tool: u.command !== undefined && u.command !== null };
  };
}

/** The issuer's endpoints from its discovery document, through the dialer (`oidcAddressPolicy`); `null` on any failure. */
export async function discoverIssuer(issuer: string, allowRanges: string[]): Promise<{ authorization: string; token: string; idTokenAlgs?: string[] } | null> {
  if (!issuer.startsWith('https://')) return null;
  try {
    const res = await dialFetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } }, oidcAddressPolicy({ issuer, allowRanges }));
    if (!res.ok) return null;
    const doc = (await res.json()) as { issuer?: unknown; authorization_endpoint?: unknown; token_endpoint?: unknown; id_token_signing_alg_values_supported?: unknown };
    const https = (u: unknown): u is string => typeof u === 'string' && u.startsWith('https://');
    if (doc.issuer !== issuer || !https(doc.authorization_endpoint) || !https(doc.token_endpoint)) return null;
    const algs = Array.isArray(doc.id_token_signing_alg_values_supported) ? doc.id_token_signing_alg_values_supported.filter((a): a is string => typeof a === 'string' && /^[A-Z0-9]{2,10}$/.test(a)) : [];
    return { authorization: doc.authorization_endpoint, token: doc.token_endpoint, ...(algs.length > 0 ? { idTokenAlgs: algs } : {}) };
  } catch {
    return null;
  }
}

const crewDist = (): string => join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The runtime's standalone build: `WICKED_APPS_RUNTIME_DIR`, else the bundled studio's `apps-standalone`. */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const set = env['WICKED_APPS_RUNTIME_DIR'];
  if (set !== undefined && set !== '') return set;
  const bundled = join(crewDist(), 'studio', 'apps-standalone');
  return existsSync(join(bundled, 'runtime.js')) ? bundled : null;
}

/** The app server artifact: `WICKED_APPS_SERVER_ARTIFACT`, else crew's `dist/apps-server` (copied at build). */
export function serverArtifact(env: NodeJS.ProcessEnv = process.env): string | null {
  const set = env['WICKED_APPS_SERVER_ARTIFACT'];
  if (set !== undefined && set !== '') return set;
  const bundled = join(crewDist(), 'apps-server');
  return existsSync(join(bundled, 'Dockerfile')) ? bundled : null;
}
