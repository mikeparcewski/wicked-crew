/**
 * (DES-APPS-001 §8.2, §9.3) The publish manifest, and the deterministic part of the publish check.
 *
 * {@link buildManifest} turns the person's publish settings (`AppPublishBody`) and an accepted version into
 * the manifest the run is bound to and the sources the image ships, or the findings that stop it:
 *
 * - the targets fit (`embed` needs a public app, `teams` the Entra profile, the site is always built);
 * - the site origin is a bare `https://` origin (or `http://localhost` / `http://127.0.0.1` for a local run);
 * - an issuer iff the app is not public, `https://`, an Entra issuer naming its tenant; the audience rule
 *   names someone;
 * - no query or action uses a source an image cannot carry (the built-in `crew` source; a local
 *   `mcp-stdio` server), each named with what uses it;
 * - a public app has no action and only public queries;
 * - every action holds a grant bound to its CURRENT action, contract and descriptor hashes, and a row
 *   write's source still has Allow writes on (the live table check runs in the publish check proper);
 * - every secret has its own environment name.
 *
 * Nothing here runs a query, an action or a describe; the issuer's discovery is the caller's (`endpoints`).
 */

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import type { AppActionGrant, AppAudienceRule, AppManifestSource, AppPublishBody, AppPublishManifest, AppSpec } from '../../core/types.js';
import type { AppFiles } from '../check.js';
import { actionHash } from '../check.js';
import { canonicalJson } from '../../mcp/classify.js';
import type { McpToolRecord } from '../../mcp/registry-store.js';
import { classifyAddress } from '../../sources/dialer.js';
import { CREW_SOURCE, DEFAULT_PORT } from '../../sources/kinds.js';
import { lookupSource, type AppSourceRegistry } from '../exec/sources.js';
import { parseToolQueryText } from '../exec/texts.js';
import { type ImageSources, secretEnvName } from './layout.js';

export interface PublishFinding {
  code: string;
  message: string;
}

export interface ManifestInput {
  app: { slug: string; name: string; version: number; tree: string; commit: string };
  files: AppFiles;
  body: AppPublishBody;
  registry: AppSourceRegistry | null;
  grantOf: (action: string) => AppActionGrant | null;
  /**
   * The issuer's endpoints from its discovery document (fetched through the dialer by the caller), and the ID-token
   * signing algorithms it says it uses (the page checks the ID token's `alg` against them).
   */
  endpoints: { authorization: string; token: string; idTokenAlgs?: string[] } | null;
}

export type ManifestOutcome = { ok: true; manifest: AppPublishManifest; sources: ImageSources; digest: string } | { ok: false; findings: PublishFinding[] };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const ENTRA_ISSUER = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/i;

/** A bare origin: `https://host[:port]`, or `http://localhost|127.0.0.1:port` for a local run. */
export function siteOriginProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'the site address is not a URL';
  }
  if (u.username !== '' || u.password !== '') return 'the site address carries credentials';
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || raw.replace(/\/$/, '') !== u.origin) return 'the site address is an origin only (no path, query or fragment)';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)) return null;
  return 'the site address is https:// (http:// only for localhost)';
}

const httpsOrigin = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.username === '' && u.password === '' && raw.replace(/\/$/, '') === u.origin;
  } catch {
    return false;
  }
};

/** The manifest's digest: what the run, the QE verdict and the `published` receipt bind to. */
export const manifestDigest = (m: AppPublishManifest): string => createHash('sha256').update(canonicalJson(m)).digest('hex');

function audienceProblem(a: AppAudienceRule): string | null {
  switch (a.kind) {
    case 'public':
      return null;
    case 'oidc-groups':
      return a.groups.length === 0 || a.groups.some((g) => g.trim() === '') ? 'name at least one group' : null;
    case 'oidc-email-domain':
      return a.domains.length === 0 || a.domains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) ? 'name at least one email domain (example.com)' : null;
    case 'entra-roles':
      return a.roles.length === 0 || a.roles.some((r) => r.trim() === '') ? 'name at least one app role' : null;
    case 'entra-groups':
      return a.groups.length === 0 || a.groups.some((g) => !/^[0-9a-f-]{36}$/i.test(g)) ? 'name at least one group object id' : null;
    default:
      return 'an unknown audience rule';
  }
}

/** Where the container must reach a source, and whether that address is loopback or private. */
function reachOf(config: { kind: string; url: string | null; sql?: { driver: string; host?: string | null; port?: number | null } | null; address?: { allow: string[] } | null }): { reach: string | null; privateAddress: boolean } {
  let host: string | null = null;
  let reach: string | null = null;
  if (config.kind === 'sql' && config.sql !== undefined && config.sql !== null) {
    if (config.sql.driver === 'sqlite') return { reach: null, privateAddress: false };
    host = config.sql.host ?? '';
    reach = `${host}:${config.sql.port ?? DEFAULT_PORT[config.sql.driver as 'postgres' | 'mysql']}`;
  } else if (config.url !== null) {
    try {
      const u = new URL(config.url);
      host = u.hostname;
      reach = u.origin;
    } catch {
      reach = config.url;
    }
  }
  const literal = host !== null && isIP(host.replace(/^\[|\]$/g, '')) !== 0 ? classifyAddress(host).cls : null;
  const privateAddress = host === 'localhost' || literal === 'loopback' || literal === 'private' || (config.address?.allow.length ?? 0) > 0;
  return { reach, privateAddress };
}

export async function buildManifest(input: ManifestInput): Promise<ManifestOutcome> {
  const { body, files, app } = input;
  const spec: AppSpec = files.spec;
  const findings: PublishFinding[] = [];
  const find = (code: string, message: string): void => {
    findings.push({ code, message });
  };
  const targets = [...new Set(['studio', 'site', ...body.targets])] as AppPublishManifest['targets'];
  const isPublic = body.audience.kind === 'public';

  // Targets, site, identity, audience.
  const originProblem = siteOriginProblem(body.site.origin);
  if (originProblem !== null) find('site_origin', originProblem);
  if (targets.includes('embed') && !isPublic) find('embed_needs_public', 'Embed is for public apps only: an iframe cannot sign in. Use the Teams tab or the link');
  if (targets.includes('teams') && body.identity?.profile !== 'entra') find('teams_needs_entra', 'The Teams tab signs in through Entra ID: choose the Entra sign-in');
  const embedOrigins = [...new Set(body.embedOrigins ?? [])];
  if (embedOrigins.length > 0 && !targets.includes('embed')) find('embed_origins_unused', 'Embed origins are named only for the Embed target');
  if (targets.includes('embed') && embedOrigins.length === 0) find('embed_origins', 'Name the origins that may frame the app (https://intranet.example.com)');
  for (const o of embedOrigins) if (!httpsOrigin(o)) find('embed_origins', `${o} is not an https:// origin`);
  if (isPublic) {
    if (body.identity !== null) find('public_has_issuer', 'A public app has no sign-in');
  } else if (body.identity === null) {
    find('identity', 'Choose who signs in: the issuer and its client id');
  } else {
    const id = body.identity;
    if (!id.issuer.startsWith('https://')) find('identity', 'The issuer is an https:// URL');
    if (id.clientId.trim() === '') find('identity', 'The client id is required');
    if (id.profile === 'entra') {
      // Entra's client id is the app registration's GUID (Teams' webApplicationInfo.id must be one too).
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.clientId)) find('identity', 'The Entra client id is the app registration’s GUID');
      const m = ENTRA_ISSUER.exec(id.issuer);
      if (m === null || id.tenantId === undefined || m[1]!.toLowerCase() !== id.tenantId.toLowerCase()) find('identity', 'The Entra issuer is https://login.microsoftonline.com/<tenant id>/v2.0, for the tenant named');
      if (!body.audience.kind.startsWith('entra-')) find('audience', 'Entra sign-in judges app roles or group object ids');
    } else if (!body.audience.kind.startsWith('oidc-')) {
      find('audience', 'OIDC sign-in judges group values or email domains');
    }
    if (input.endpoints === null) find('identity', "The issuer's discovery document could not be read");
    else if (input.endpoints.idTokenAlgs !== undefined && input.endpoints.idTokenAlgs.length === 0) find('identity', 'The issuer signs ID tokens only with algorithms the site cannot verify (it verifies RS, PS and ES)');
    // The page checks the sign-in's nonce, which needs the ID token: the scope always asks for `openid`.
    if (id.scope !== undefined && !id.scope.split(/\s+/).includes('openid')) find('identity', 'The sign-in scope must include openid');
  }
  const aud = audienceProblem(body.audience);
  if (aud !== null) find('audience', aud);

  // What the app uses, and whether an image can carry it.
  const usesOf = new Map<string, string[]>();
  for (const q of spec.queries) usesOf.set(q.source, [...(usesOf.get(q.source) ?? []), `query ${q.id}`]);
  for (const a of spec.actions) usesOf.set(a.source, [...(usesOf.get(a.source) ?? []), `action ${a.id}`]);
  if (usesOf.has(CREW_SOURCE)) find('blocked_source', `The standalone site cannot read the crew source (crew is local): remove ${usesOf.get(CREW_SOURCE)!.join(', ')}`);
  if (isPublic) {
    if (spec.actions.length > 0) find('public_has_actions', `A public app is read-only: remove ${spec.actions.map((a) => a.id).join(', ')}`);
    const closed = spec.queries.filter((q) => q.public !== true).map((q) => q.id);
    if (closed.length > 0) find('public_queries', `A public app holds only public queries: ${closed.join(', ')} ${closed.length === 1 ? 'is' : 'are'} not`);
  }

  const sources: ImageSources['sources'] = {};
  const manifestSources: AppManifestSource[] = [];
  const envNames = new Map<string, string>();
  const toolsUsed = new Map<string, Set<string>>();
  for (const q of spec.queries) {
    if (q.kind !== 'rest' && q.kind !== 'mcp') continue;
    const t = parseToolQueryText(Object.hasOwn(files.queryText, q.id) ? files.queryText[q.id]! : '');
    if (t.ok) toolsUsed.set(q.source, new Set([...(toolsUsed.get(q.source) ?? []), t.value.tool]));
  }
  for (const a of spec.actions) if (a.kind !== 'row-write' && a.call.kind === 'tool') toolsUsed.set(a.source, new Set([...(toolsUsed.get(a.source) ?? []), a.call.tool]));

  for (const name of [...usesOf.keys()].sort()) {
    if (name === CREW_SOURCE) continue;
    const src = await lookupSource(input.registry, name).catch(() => null);
    if (src === null || src.kind === 'crew') {
      find('unknown_source', `${name} is not a source on this crew any more (used by ${usesOf.get(name)!.join(', ')})`);
      continue;
    }
    if (src.kind === 'mcp-stdio') {
      find('blocked_source', `The standalone site cannot run ${name}, a local MCP server: remove ${usesOf.get(name)!.join(', ')}`);
      continue;
    }
    // A source switched off stays off: publishing never turns it back on in an image.
    if (!src.enabled) find('source_off', `${name} is switched off: turn it on, or remove ${usesOf.get(name)!.join(', ')}`);
    const pinned = Object.hasOwn(files.lock.sources, name) ? files.lock.sources[name]! : undefined;
    if (pinned === undefined || pinned.descriptorHash !== src.pin.descriptorHash) find('source_changed', `${name} changed since this version was checked: check it again`);
    const tools: McpToolRecord[] = [];
    for (const tool of [...(toolsUsed.get(name) ?? [])].sort()) {
      const t = await input.registry?.appTool(name, tool);
      if (t === undefined || t === null || !t.bound) find('source_changed', `${name}/${tool} changed since this version was checked`);
      else tools.push(t.tool);
    }
    const allowWrites = src.kind === 'sql' ? src.allowWrites : false;
    const env = src.config.auth === null ? null : secretEnvName(src.config);
    if (env !== null) {
      const other = envNames.get(env);
      if (other !== undefined) find('env_collision', `${name} and ${other} would both read ${env}: rename one source`);
      envNames.set(env, name);
    }
    sources[name] = { config: structuredClone(src.config), tools, allowWrites };
    manifestSources.push({
      name,
      kind: src.kind,
      descriptorHash: src.pin.descriptorHash,
      ...reachOf(src.config),
      env,
      allowWrites,
      ...(src.kind === 'sql' && src.config.sql?.driver === 'sqlite' && typeof src.config.sql.snapshot === 'string' ? { snapshot: src.config.sql.snapshot } : {}),
    });
  }

  // Every action holds a grant bound to what it is now.
  const actions: AppPublishManifest['actions'] = [];
  for (const a of spec.actions) {
    const locked = Object.hasOwn(files.lock.actions, a.id) ? files.lock.actions[a.id]! : undefined;
    const pinned = Object.hasOwn(files.lock.sources, a.source) ? files.lock.sources[a.source]! : undefined;
    const g = input.grantOf(a.id);
    if (locked === undefined || pinned === undefined || locked.actionHash !== actionHash(a)) {
      find('not_checked', `action ${a.id} was never checked in this version`);
      continue;
    }
    if (g === null) {
      find('not_granted', `action ${a.id} is not granted: grant it in the data panel, or remove it`);
      continue;
    }
    if (g.actionHash !== locked.actionHash || g.contractHash !== locked.contractHash || g.descriptorHash !== pinned.descriptorHash) {
      find('not_granted', `the grant for action ${a.id} is for another version of it: grant it again`);
      continue;
    }
    if (a.kind === 'row-write' && sources[a.source]?.allowWrites !== true) find('writes_off', `${a.source}'s Allow writes switch is off: action ${a.id} cannot be published`);
    actions.push({
      id: a.id,
      kind: a.kind === 'row-write' ? 'row-write' : 'api',
      source: a.source,
      grant: structuredClone(g),
      ...(a.kind === 'row-write' ? { table: a.table, columns: Object.keys(a.set ?? {}) } : {}),
    });
  }

  if (findings.length > 0) return { ok: false, findings };
  const identity = body.identity === null || input.endpoints === null ? null : { ...structuredClone(body.identity), endpoints: { authorization: input.endpoints.authorization, token: input.endpoints.token, ...(input.endpoints.idTokenAlgs !== undefined ? { idTokenAlgs: [...input.endpoints.idTokenAlgs] } : {}) } };
  const manifest: AppPublishManifest = {
    schema: 'wicked.apps.manifest/v1',
    app: { ...app },
    targets,
    site: { origin: body.site.origin.replace(/\/$/, '') },
    identity,
    audience: structuredClone(body.audience),
    embedOrigins,
    sources: manifestSources,
    queries: spec.queries.map((q) => ({ id: q.id, source: q.source, public: q.public === true })),
    actions,
    env: [...envNames.keys()].sort(),
    volume: actions.length > 0 ? '/data' : null,
  };
  return { ok: true, manifest, sources: { schema: 'wicked.apps.image-sources/v1', sources }, digest: manifestDigest(manifest) };
}
