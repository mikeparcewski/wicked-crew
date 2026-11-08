/** (DES-APPS-001 §9.3, CS2) Each publish has its own manifest, checks, consent and locally built image. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { oidcAddressPolicy } from '../../api/auth.js';
import type { AppActionGrant, AppPublished, AppPublishManifest, LaunchRunInput, SessionView } from '../../core/types.js';
import { dialFetch } from '../../sources/dialer.js';
import type { AppSourceRegistry } from '../exec/sources.js';
import { LOCK_PATH, SPEC_PATH } from '../check.js';
import { AppStoreError, type AppPublisher, type AppStore, type StoredPublish } from '../store.js';
import { appsRuntime, appsServerArtifact } from './artifacts.js';
import { buildImage, ImageBuildError } from './image.js';
import { SITE_PORT } from './layout.js';
import { buildManifest, type ManifestInput, type ManifestOutcome } from './manifest.js';
import { PackError, writeImageContext } from './pack.js';

export interface PublishDeps {
  engine: {
    launchRun(input: LaunchRunInput): Promise<string>;
    sessionsDetail(): Promise<SessionView[]>;
  };
  roster: () => Promise<string>;
  registry: AppSourceRegistry | null;
  grantOf: (slug: string, action: string) => AppActionGrant | null;
}

/** Discovery uses the same bounded, address-pinned dialer and address policy as operator sign-in. */
export async function publishEndpoints(identity: ManifestInput['body']['identity']): Promise<ManifestInput['endpoints']> {
  if (identity === null) return null;
  try {
    if (!identity.issuer.startsWith('https://')) return null;
    const res = await dialFetch(`${identity.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } }, oidcAddressPolicy(identity));
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      if (reader === undefined) break;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const doc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (doc.issuer !== identity.issuer || typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') return null;
    for (const raw of [doc.authorization_endpoint, doc.token_endpoint]) {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    }
    const algs = doc.id_token_signing_alg_values_supported;
    return { authorization: doc.authorization_endpoint, token: doc.token_endpoint, ...(Array.isArray(algs) && algs.every((a) => typeof a === 'string') ? { idTokenAlgs: algs as string[] } : {}) };
  } catch {
    return null;
  }
}

/** One line for the launch problem and the Share sheet, from the persisted audience only. */
export function publishAudience(m: Pick<AppPublishManifest, 'audience' | 'identity'>): string {
  const a = m.audience;
  const values = a.kind === 'public' ? 'Anyone (public)' : a.kind === 'oidc-email-domain' ? `People with email in ${a.domains.join(', ')}` : a.kind === 'entra-roles' ? `People in app roles ${a.roles.join(', ')}` : `People in groups ${a.groups.join(', ')}`;
  return `${values}${m.identity === null ? '' : ` who sign in at ${m.identity.issuer}`}`.replace(/\s+/g, ' ').trim();
}

export class PublishService implements AppPublisher {
  constructor(private readonly deps: PublishDeps) {}

  async manifestFor(input: Pick<ManifestInput, 'app' | 'files' | 'body'>): Promise<ManifestOutcome> {
    return buildManifest({ ...input, registry: this.deps.registry, grantOf: (action) => this.deps.grantOf(input.app.slug, action), endpoints: await publishEndpoints(input.body.identity) });
  }

  async launch(p: StoredPublish, input: { repoId: string; projectId: string; excludeSeats: string[] }): Promise<void> {
    await this.deps.engine.launchRun({
      sessionId: p.runId, workflow: 'apps-publish', repoRef: input.repoId, projectId: input.projectId,
      humanConfirm: 'none', excludeSeats: input.excludeSeats, clisJson: await this.deps.roster(),
      problem: `Publish app ${JSON.stringify(p.manifest.app.slug)} v${p.base}.\nTree: ${p.tree}\nManifest digest: ${p.digest}\nAudience: ${publishAudience(p.manifest)}\nCheck this run's persisted manifest, require QE acceptance and consent, then produce its image.`,
    });
  }

  async status(runId: string): Promise<'running' | 'failed' | 'cancelled'> {
    const view = (await this.deps.engine.sessionsDetail()).find((v) => v.session.id === runId);
    if (view === undefined) return 'failed';
    if (view.session.status === 'cancelled') return 'cancelled';
    // A completed run without a produced record did not publish anything.
    return view.session.status === 'failed' || view.session.status === 'completed' ? 'failed' : 'running';
  }
}

const html = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function produce(deps: { store: AppStore }, input: { runId: string }): Promise<AppPublished> {
  return deps.store.producePublish(input.runId, async (p, files, git) => {
    const serverArtifact = appsServerArtifact();
    const runtime = appsRuntime();
    if (serverArtifact === null || runtime === null) throw new AppStoreError(503, 'apps_unavailable', 'the app server or standalone runtime is not installed');
    const ctx = mkdtempSync(join(tmpdir(), 'wicked-apps-publish-'));
    try {
      const entries = await git.readTree(p.tree);
      const text = async (name: string): Promise<string> => {
        const entry = entries.find((e) => e.name === name && e.type === 'blob' && e.mode === '100644');
        if (entry === undefined) throw new AppStoreError(409, 'unreadable_tree', `the publish tree has no ${name}`);
        return (await git.readBlob(entry.sha)).toString('utf8');
      };
      writeImageContext(ctx, { spec: files.spec, specText: await text(SPEC_PATH), lockText: await text(LOCK_PATH), queryText: files.queryText, manifest: p.manifest, sources: p.sources, serverArtifact, runtime });
      const tag = `wicked-apps/${p.manifest.app.slug}:v${p.base}-${p.digest.slice(0, 12)}`;
      const image = await buildImage(ctx, tag, { 'org.wicked.apps.manifest': p.digest, 'org.wicked.apps.run': p.runId });
      const shareUrl = `${p.manifest.site.origin.replace(/\/$/, '')}/`;
      return {
        version: p.base, tree: p.tree, runId: p.runId, at: Date.now(), actor: p.launchedBy,
        targets: p.manifest.targets, shareUrl, audience: publishAudience(p.manifest), image: { tag, id: image.id },
        snippet: p.manifest.targets.includes('embed') && p.manifest.audience.kind === 'public' ? `<iframe src="${html(shareUrl)}" title="${html(p.manifest.app.name)}"></iframe>` : null,
        teamsPackage: null, manifestDigest: p.digest, run: { env: p.manifest.env, volume: p.manifest.volume, port: SITE_PORT },
      };
    } catch (err) {
      if (err instanceof PackError) throw new AppStoreError(503, err.code, err.message);
      if (err instanceof ImageBuildError) throw new AppStoreError(503, err.code, err.message);
      throw err;
    } finally {
      rmSync(ctx, { recursive: true, force: true });
    }
  });
}
