/** (DES-APPS-001 §9.3, CS2) Each publish has its own manifest, checks, consent and locally built image. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { oidcAddressPolicy } from '../../api/auth.js';
import type { AppActionGrant, AppPublished, AppPublishManifest, LaunchRunInput, SessionView } from '../../core/types.js';
import { DialRefusedError, dialFetch, validateAllowRanges } from '../../sources/dialer.js';
import { projectMaySee, type AppSourceRegistry } from '../exec/sources.js';
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
    /** One run's view (crew#1779: that run alone, never a fold of the store). */
    runView(runId: string): Promise<SessionView | undefined>;
  };
  roster: () => Promise<string>;
  registry: AppSourceRegistry | null;
  /** The sources a project may see now, and the app's project (crew#1533): the manifest refuses any other source. */
  visibleSources: (projectId: string | null) => Promise<ReadonlySet<string>>;
  projectOf: (slug: string) => string | null;
  grantOf: (slug: string, action: string) => AppActionGrant | null;
}

/** Discovery uses the same bounded, address-pinned dialer and address policy as operator sign-in. */
export async function publishEndpoints(identity: ManifestInput['body']['identity']): Promise<ManifestInput['endpoints']> {
  return (await publishDiscovery(identity)).endpoints;
}

/**
 * (crew#1457) Why a discovery read nothing, in words for the Publish sheet: an issuer on a private (or loopback)
 * address the sign-in's allowed ranges do not cover names the range that would allow it; any other refusal of the
 * dialer is its own words (a malformed URL is described, never quoted); anything else is `null` (the finding then says only that it could not be read).
 */
function discoveryRefusal(err: unknown, issuer: string): string | null {
  if (!(err instanceof DialRefusedError)) return null;
  if (err.code === 'address_unconfirmed' && err.addresses !== undefined && err.addresses.length > 0) {
    let host = issuer;
    try {
      host = new URL(issuer).hostname;
    } catch {
      /* the issuer as written */
    }
    const where = err.addresses.map((a) => a.address).join(', ');
    const kind = err.addresses.every((a) => a.class === 'loopback') ? 'a loopback address on this machine' : 'a private-network address';
    // The narrowest range that allows it: exactly the addresses it resolved to (the person may widen it).
    const ranges = err.addresses.map((a) => `${a.address}/${a.address.includes(':') ? 128 : 32}`);
    return `${host} resolves to ${kind} (${where}), which crew reaches only when the sign-in allows its range (identity.allowRanges, e.g. ${ranges.join(', ')})`;
  }
  // A URL the dialer would not parse is described, never quoted: the issuer as typed may carry a password, a path or a
  // query (xreview r1). The other refusals name only the host, its addresses and the status.
  if (err.code === 'url_refused') return 'the issuer is not a URL crew dials (https, a host, no credentials)';
  return err.message;
}

/**
 * A URL a discovery document or the sign-in names, as it may be shown: an http(s) URL with no credentials, query or
 * fragment, at most 300 characters, exactly as written (a trailing slash is the difference that matters); else `null`.
 */
function shownUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300 || !/^https?:\/\/\S+$/.test(raw)) return null;
  try {
    const u = new URL(raw);
    return u.username === '' && u.password === '' && u.search === '' && u.hash === '' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The issuer's endpoints, or `null` with why (crew#1457): the dialer's refusal, an error status, an oversize or
 * non-JSON document, an issuer the document does not match (both shown when they are plain URLs), or endpoints that
 * are not https. Nothing is dialled when the sign-in's allowed ranges are refused (the manifest says why).
 */
export async function publishDiscovery(identity: ManifestInput['body']['identity']): Promise<{ endpoints: ManifestInput['endpoints']; why: string | null }> {
  if (identity === null) return { endpoints: null, why: null };
  const none = (why: string | null = null) => ({ endpoints: null, why });
  if (identity.allowRanges !== undefined && validateAllowRanges(identity.allowRanges) !== null) return none();
  try {
    if (!identity.issuer.startsWith('https://')) return none();
    const res = await dialFetch(`${identity.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } }, oidcAddressPolicy(identity));
    if (!res.ok) {
      await res.body?.cancel();
      return none(`it answered HTTP ${res.status}`);
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      if (reader === undefined) break;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); return none('the document is over 1 MB'); }
      chunks.push(value);
    }
    let doc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return none('the document is not a JSON object');
      doc = parsed as Record<string, unknown>;
    } catch {
      return none('the document is not JSON');
    }
    if (doc.issuer !== identity.issuer) {
      const says = shownUrl(doc.issuer);
      const ours = shownUrl(identity.issuer);
      const slash = typeof doc.issuer === 'string' && doc.issuer.replace(/\/$/, '') === identity.issuer.replace(/\/$/, '');
      return none(`issuer mismatch: discovery says ${says ?? (doc.issuer === undefined ? 'no issuer' : 'an issuer that is not a plain URL')}, the sign-in says ${ours ?? 'an issuer that is not a plain URL'}${slash ? ' (they differ only in a trailing slash: use the issuer exactly as discovery writes it)' : ''}`);
    }
    if (typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') return none('the document names no authorization_endpoint or token_endpoint');
    for (const [name, raw] of [['authorization_endpoint', doc.authorization_endpoint], ['token_endpoint', doc.token_endpoint]] as const) {
      let url: URL | null = null;
      try {
        url = new URL(raw);
      } catch {
        url = null;
      }
      if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '') return none(`its ${name} is not an https URL without credentials`);
    }
    const algs = doc.id_token_signing_alg_values_supported;
    return { endpoints: { authorization: doc.authorization_endpoint, token: doc.token_endpoint, ...(Array.isArray(algs) && algs.every((a) => typeof a === 'string') ? { idTokenAlgs: algs as string[] } : {}) }, why: null };
  } catch (err) {
    return none(discoveryRefusal(err, identity.issuer));
  }
}

/** One line for the launch problem and the Share sheet, from the persisted audience only. */
export function publishAudience(m: Pick<AppPublishManifest, 'audience' | 'identity'>): string {
  const a = m.audience;
  const values = a.kind === 'public' ? 'Anyone (public)' : a.kind === 'oidc-email-domain' ? `People with email in ${a.domains.join(', ')}` : a.kind === 'entra-roles' ? `People in app roles ${a.roles.join(', ')}` : `People in groups ${a.groups.join(', ')}`;
  return `${values}${m.identity === null ? '' : ` who sign in at ${m.identity.issuer}`}`.replace(/\s+/g, ' ').trim();
}

/** The manifest's discovery fields: the endpoints, and why there are none when that is known. */
async function discoveryOf(identity: ManifestInput['body']['identity']): Promise<Pick<ManifestInput, 'endpoints' | 'endpointsWhy'>> {
  const d = await publishDiscovery(identity);
  return { endpoints: d.endpoints, ...(d.why !== null ? { endpointsWhy: d.why } : {}) };
}

export class PublishService implements AppPublisher {
  constructor(private readonly deps: PublishDeps) {}

  async manifestFor(input: Pick<ManifestInput, 'app' | 'files' | 'body'>): Promise<ManifestOutcome> {
    let visible: Promise<ReadonlySet<string>> | undefined;
    const maySee = (source: Parameters<typeof projectMaySee>[0]): Promise<boolean> =>
      projectMaySee(source, () => (visible ??= this.deps.visibleSources(this.deps.projectOf(input.app.slug))));
    return buildManifest({ ...input, registry: this.deps.registry, maySee, grantOf: (action) => this.deps.grantOf(input.app.slug, action), ...await discoveryOf(input.body.identity) });
  }

  async launch(p: StoredPublish, input: { repoId: string; projectId: string; excludeSeats: string[] }): Promise<void> {
    await this.deps.engine.launchRun({
      sessionId: p.runId, workflow: 'apps-publish', repoRef: input.repoId, projectId: input.projectId,
      humanConfirm: 'none', excludeSeats: input.excludeSeats, clisJson: await this.deps.roster(),
      problem: `Publish app ${JSON.stringify(p.manifest.app.slug)} v${p.base}.\nTree: ${p.tree}\nManifest digest: ${p.digest}\nAudience: ${publishAudience(p.manifest)}\nCheck this run's persisted manifest, require QE acceptance and consent, then produce its image.`,
    });
  }

  async status(runId: string): Promise<'running' | 'failed' | 'cancelled'> {
    const view = await this.deps.engine.runView(runId);
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
