/**
 * (DES-APPS-001 §9.3, slice K6) Publish: one governed `apps-publish` run bound to the head tree and the manifest the
 * request carried. crew's side of its three steps:
 *
 * - **start** (`POST /apps/:app/publish`, a HUMAN operator): the issuer's discovery through the dialer, the
 *   deterministic publish check (`buildManifest`), the record bound to (tree, manifest digest), the run launched with
 *   QE forced (the preset) and the builders since the last publish excluded from its QE seat.
 * - **check** (`wicked-crew apps-check --publish`, the run's `check` Tool unit): the manifest built again from
 *   today's state must be the one the run is bound to; then every query (`checkQuery`) and every action
 *   (`checkAction`: the grant now, a row write's table safety check now) is checked without running anything. It
 *   answers the consent card: the manifest in words.
 * - **produce** (`wicked-crew apps-produce`, the run's `produce` Tool unit, which the engine runs only after the
 *   person consented and QE passed): pack from the tree's git objects and the snapshots by digest, build the image
 *   in the local engine, write the Teams package and the snippet, and record the `published` receipt and the share
 *   link. Nothing is pushed anywhere.
 *
 * The two Tool routes take the unit's capability token (`WICKED_MCP_TOKEN`), and only the token of THAT run's
 * `check` (or `produce`) step: an agent unit's token (the QE seat's) is refused.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Actor, AppPublished, AppPublishBody, AppPublishManifest } from '../../core/types.js';
import type { AppSourceRegistry } from '../exec/sources.js';
import type { AppExecutor } from '../exec/executor.js';
import type { AppWritePath } from '../actions/write-path.js';
import { AppStoreError, type AppStore } from '../store.js';
import { buildManifest, type PublishFinding } from './manifest.js';
import { PackError, writeImageContext } from './pack.js';
import { buildImage, ImageBuildError } from './image.js';
import { SITE_PORT, TEAMS_FRAME_ORIGINS } from './layout.js';
import { teamsPackage } from './teams.js';

export class PublishError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly findings: PublishFinding[] = [],
  ) {
    super(message);
  }

  /** The findings in the app routes' shape (`AppErrorBody.findings`, stage `publish`). */
  wireFindings(): Array<{ stage: 'publish'; code: string; path: string; message: string }> {
    return this.findings.map((f) => ({ stage: 'publish', code: f.code, path: '$', message: f.message }));
  }
}

export interface PublishDeps {
  store: AppStore;
  registry: AppSourceRegistry | null;
  executor: Pick<AppExecutor, 'checkQuery'>;
  writePath: Pick<AppWritePath, 'getGrant' | 'checkAction'> | null;
  /** The unit a capability token belongs to: its run and its step (`phase_ref`), and whether it is a Tool unit. */
  unitOf: (token: string) => Promise<{ runId: string; step: string | null; tool: boolean } | null>;
  /** The issuer's endpoints from its discovery document, through the dialer (`null` = could not be read). */
  discover: (issuer: string, allowRanges: string[]) => Promise<{ authorization: string; token: string; idTokenAlgs?: string[] } | null>;
  /** The wicked-apps runtime's standalone build (`<studio dist>/apps-standalone`). */
  runtimeDir: () => string | null;
  /** The app server artifact (`packages/apps-server/dist`, carried in crew's dist). */
  serverArtifact: () => string | null;
  snapshotDir?: string;
  build?: typeof buildImage;
  /** Where produced Teams packages are kept, by app (`GET /apps/:app/published/teams.zip`). */
  artifactsDir: string;
  now?: () => number;
}

const AUDIENCE_WORDS = (m: AppPublishManifest): string => {
  const a = m.audience;
  const at = m.identity === null ? '' : ` who sign in at ${new URL(m.identity.issuer).host}`;
  switch (a.kind) {
    case 'public':
      return 'Anyone with the link, read-only';
    case 'oidc-groups':
      return `People in ${a.groups.length === 1 ? 'group' : 'groups'} ${a.groups.join(', ')}${at}`;
    case 'oidc-email-domain':
      return `People with a verified ${a.domains.map((d) => `@${d}`).join(' or ')} email${at}`;
    case 'entra-roles':
      return `People with app role ${a.roles.join(', ')}${at}`;
    case 'entra-groups':
      return `People in Entra ${a.groups.length === 1 ? 'group' : 'groups'} ${a.groups.join(', ')}${at}`;
    default:
      return 'People in the audience';
  }
};

/** The consent card the produce step's gate shows: the manifest in words (DES §9.3 step 3). */
export function consentCard(m: AppPublishManifest): string {
  const lines = [
    `Publish ${m.app.name} v${m.app.version} (tree ${m.app.tree.slice(0, 12)})`,
    `Share link: ${m.site.origin}/`,
    `Targets: ${m.targets.join(', ')}`,
    `Who can open it: ${AUDIENCE_WORDS(m)}`,
    ...(m.identity !== null ? [`Issuer: ${m.identity.issuer} (client ${m.identity.clientId}, ${m.identity.profile})`] : []),
    'Sources:',
    ...m.sources.map((s) => `  ${s.name} (${s.kind})${s.reach !== null ? ` -> ${s.reach}` : ''}${s.privateAddress ? ' [the container must reach this private address]' : ''}${s.env !== null ? `, secret in ${s.env}` : ''}${s.kind === 'sql' ? `, Allow writes ${s.allowWrites ? 'on' : 'off'}` : ''}${s.snapshot !== undefined ? `, snapshot ${s.snapshot.slice(0, 12)}` : ''}`),
    `Queries: ${m.queries.length} (${m.queries.filter((q) => q.public).length} public)`,
    'Actions:',
    ...(m.actions.length === 0 ? ['  none'] : m.actions.map((a) => `  ${a.id}: ${a.kind === 'row-write' ? `row write on ${a.table} (${(a.columns ?? []).join(', ')})` : 'API action'} on ${a.source}, granted by ${a.grant.grantedBy.id}, on the site only (read-only in frames)`)),
    `Environment: ${m.env.length === 0 ? 'none' : m.env.join(', ')}`,
    `Volume: ${m.volume ?? 'none needed'}`,
    `Framed by: ${m.embedOrigins.length > 0 ? m.embedOrigins.join(', ') : m.targets.includes('teams') ? TEAMS_FRAME_ORIGINS.join(', ') : 'nobody'}`,
    'Nothing is pushed anywhere: you get a local image, and the snippet or Teams package when chosen.',
  ];
  return lines.join('\n');
}

export class AppPublishService {
  private readonly now: () => number;

  constructor(private readonly deps: PublishDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async manifestFor(slug: string, at: { version: number; tree: string; commit: string; name: string; files: Awaited<ReturnType<AppStore['acceptedFiles']>>['files'] }, body: AppPublishBody) {
    const endpoints = body.identity === null ? null : await this.deps.discover(body.identity.issuer, body.identity.allowRanges ?? []);
    return buildManifest({
      app: { slug, name: at.name, version: at.version, tree: at.tree, commit: at.commit },
      files: at.files,
      body,
      registry: this.deps.registry,
      grantOf: (id) => this.deps.writePath?.getGrant(slug, id) ?? null,
      endpoints,
    });
  }

  /** `POST /apps/:app/publish`: check, bind and launch. */
  async start(slug: string, body: AppPublishBody, actor: Actor): Promise<{ runId: string; manifestDigest: string }> {
    let findings: PublishFinding[] = [];
    try {
      const p = await this.deps.store.beginPublish(slug, {
        base: body.base,
        actor,
        prepare: async (at) => {
          const out = await this.manifestFor(slug, at, body);
          if (!out.ok) {
            findings = out.findings;
            throw new PublishError(422, 'check_failed', out.findings.map((f) => f.message).slice(0, 5).join('; '), out.findings);
          }
          // The stored publish carries the BODY too (the check rebuilds the manifest from it).
          return { manifest: out.manifest, digest: out.digest, sources: out.sources, body };
        },
      });
      return { runId: p.runId, manifestDigest: p.digest };
    } catch (err) {
      if (err instanceof PublishError) throw err;
      if (err instanceof AppStoreError) throw new PublishError(err.status, err.code, err.message, findings);
      throw err;
    }
  }

  private async unit(token: string, step: 'check' | 'produce') {
    const u = await this.deps.unitOf(token);
    if (u === null) throw new PublishError(401, 'invalid_token', 'the unit token is not valid');
    // Only the run's own `check` (or `produce`) Tool unit: never an agent unit of the same run, never another run.
    if (u.step !== step || !u.tool) throw new PublishError(403, 'not_this_step', `this token is not the publish's ${step} step`);
    const found = this.deps.store.publishingOf(u.runId);
    if (found === null) throw new PublishError(404, 'not_publishing', `run ${u.runId} is not a publish crew is running`);
    return found;
  }

  /** The publish check (the `check` step): unwaivable, nothing runs. */
  async check(token: string): Promise<{ ok: boolean; card: string; findings: PublishFinding[] }> {
    const { slug, publishing: p } = await this.unit(token, 'check');
    const at = await this.deps.store.acceptedFiles(slug, p.commit);
    const again = await this.manifestFor(slug, { version: p.version, tree: p.tree, commit: p.commit, name: p.manifest.app.name, files: at.files }, p.body);
    const findings: PublishFinding[] = [];
    if (!again.ok) findings.push(...again.findings);
    else if (again.digest !== p.digest) findings.push({ code: 'manifest_changed', message: 'what this publish would ship changed since it started (a grant, a source or the issuer): publish again' });
    for (const q of at.files.spec.queries) {
      try {
        await this.deps.executor.checkQuery(slug, p.commit, q.id);
      } catch (err) {
        findings.push({ code: 'query_refused', message: `query ${q.id}: ${(err as Error).message}` });
      }
    }
    for (const a of at.files.spec.actions) {
      if (this.deps.writePath === null) {
        findings.push({ code: 'not_granted', message: `action ${a.id}: this daemon runs no actions` });
        continue;
      }
      try {
        await this.deps.writePath.checkAction(slug, a.id, p.commit);
      } catch (err) {
        findings.push({ code: 'action_refused', message: `action ${a.id}: ${(err as Error).message}` });
      }
    }
    return { ok: findings.length === 0, card: consentCard(p.manifest), findings };
  }

  /** The produce step: pack, build, record. */
  async produce(token: string): Promise<{ published: AppPublished; log: string }> {
    const { slug, publishing: p } = await this.unit(token, 'produce');
    const runtime = this.deps.runtimeDir();
    const server = this.deps.serverArtifact();
    if (runtime === null || !existsSync(join(runtime, 'runtime.js'))) throw new PublishError(503, 'no_runtime', 'this crew carries no wicked-apps standalone runtime (a studio build with apps-standalone)');
    if (server === null || !existsSync(join(server, 'Dockerfile'))) throw new PublishError(503, 'no_server', 'this crew carries no app server artifact (packages/apps-server dist)');
    const texts = await this.deps.store.treeTexts(slug, p.tree);
    const ctx = mkdtempSync(join(tmpdir(), `wicked-apps-${slug}-`));
    // Everything this produce writes is THIS run's (its image tag, its Teams package): a stale or duplicate produce
    // can never move what a newer publish's record points at.
    const runTag = p.runId.slice(-12);
    try {
      const { readFileSync } = await import('node:fs');
      writeImageContext(ctx, {
        ...texts,
        manifest: p.manifest,
        sources: p.sources,
        runtime: { js: readFileSync(join(runtime, 'runtime.js'), 'utf8'), css: readFileSync(join(runtime, 'runtime.css'), 'utf8') },
        serverArtifact: server,
        ...(this.deps.snapshotDir !== undefined ? { snapshotDir: this.deps.snapshotDir } : {}),
      });
      const tag = `wicked-apps/${slug}:v${p.version}-${runTag}`;
      const built = await (this.deps.build ?? buildImage)(ctx, tag, { 'wicked.apps.app': slug, 'wicked.apps.version': String(p.version), 'wicked.apps.manifest': p.digest, 'wicked.apps.run': p.runId });
      let teams: AppPublished['teamsPackage'] = null;
      if (p.manifest.targets.includes('teams') && p.manifest.identity !== null) {
        // The package's version climbs with every publish (Teams takes a changed manifest only at a higher version).
        const zip = teamsPackage(p.manifest, this.deps.store.publishCount(slug) + 1);
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(join(this.deps.artifactsDir, slug, runTag), { recursive: true });
        writeFileSync(join(this.deps.artifactsDir, slug, runTag, 'teams.zip'), zip);
        teams = { url: `/api/v1/apps/${slug}/published/teams.zip`, sha256: createHash('sha256').update(zip).digest('hex') };
      }
      const origin = p.manifest.site.origin;
      const published: AppPublished = {
        version: p.version,
        tree: p.tree,
        runId: p.runId,
        at: this.now(),
        actor: p.actor,
        targets: p.manifest.targets,
        shareUrl: `${origin}/`,
        audience: AUDIENCE_WORDS(p.manifest),
        image: { tag, id: built.id },
        snippet: p.manifest.targets.includes('embed') ? `<iframe src="${origin}/" title="${p.manifest.app.name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}" width="100%" height="600" style="border:0" loading="lazy" referrerpolicy="no-referrer"></iframe>` : null,
        teamsPackage: teams,
        manifestDigest: p.digest,
        run: { env: [...p.manifest.env], volume: p.manifest.volume, port: SITE_PORT },
      };
      await this.deps.store.finishPublish(p.runId, published);
      return { published, log: built.log };
    } catch (err) {
      // Routine failures answer with a code, never a bare 500 (the step's output shows the reason).
      if (err instanceof ImageBuildError) throw new PublishError(err.code === 'no_engine' ? 503 : 502, err.code === 'no_engine' ? 'no_container_engine' : 'image_build_failed', `${err.message}${err.log !== '' ? `: ${err.log.slice(-600)}` : ''}`);
      if (err instanceof PackError) throw new PublishError(409, 'pack_failed', err.message);
      throw err;
    } finally {
      rmSync(ctx, { recursive: true, force: true });
    }
  }
}
