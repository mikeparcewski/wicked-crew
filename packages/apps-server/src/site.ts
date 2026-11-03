/**
 * What the image carries under `/srv/site` (crew's `apps/publish/layout.ts`), read once at startup and
 * checked for consistency: the spec, the query texts and the lock of ONE accepted tree, the manifest the
 * person consented to, the shipped sources and the runtime. The spec always comes from here, never from a
 * request (DES §8.2). A site that does not hold together stops the server with the reason.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type AppFiles,
  type AppLock,
  type AppPublishManifest,
  type ImageSources,
  parseSpec,
  QUERY_EXT,
  SITE_LOCK,
  SITE_MANIFEST,
  SITE_QUERIES,
  SITE_RUNTIME_CSS,
  SITE_RUNTIME_JS,
  SITE_SNAPSHOTS,
  SITE_SOURCES,
  SITE_SPEC,
} from './crew.js';

export class SiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteError';
  }
}

export interface Site {
  dir: string;
  manifest: AppPublishManifest;
  files: AppFiles;
  sources: ImageSources['sources'];
  runtime: { js: string; css: string };
  snapshotDir: string;
}

const MAX_FILE = 16 * 1024 * 1024;

function readText(path: string, what: string): string {
  if (!existsSync(path)) throw new SiteError(`the image has no ${what} (${path})`);
  const buf = readFileSync(path);
  if (buf.byteLength > MAX_FILE) throw new SiteError(`the image's ${what} is larger than ${MAX_FILE} bytes`);
  return buf.toString('utf8');
}

function readJson<T>(path: string, what: string): T {
  try {
    return JSON.parse(readText(path, what)) as T;
  } catch (err) {
    if (err instanceof SiteError) throw err;
    throw new SiteError(`the image's ${what} is not JSON`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function loadSite(dir: string): Site {
  const manifest = readJson<AppPublishManifest>(join(dir, SITE_MANIFEST), 'manifest');
  if (!isObj(manifest) || manifest.schema !== 'wicked.apps.manifest/v1' || !isObj(manifest.app) || typeof manifest.app.slug !== 'string') {
    throw new SiteError('the manifest is not a wicked.apps.manifest/v1');
  }
  const parsed = parseSpec(readJson<unknown>(join(dir, SITE_SPEC), SITE_SPEC));
  if (parsed.spec === null) throw new SiteError(`${SITE_SPEC} does not pass the spec check: ${parsed.findings.map((f) => f.message).slice(0, 3).join('; ')}`);
  const spec = parsed.spec;
  const lock = readJson<AppLock>(join(dir, SITE_LOCK), SITE_LOCK);
  if (!isObj(lock) || lock.schema !== 'wicked.apps.lock/v1') throw new SiteError(`${SITE_LOCK} is not a wicked.apps.lock/v1`);
  const queryText: Record<string, string> = {};
  for (const q of spec.queries) queryText[q.id] = readText(join(dir, SITE_QUERIES, `${q.id}.${QUERY_EXT[q.kind]}`), `text of query ${q.id}`);
  const sources = readJson<ImageSources>(join(dir, SITE_SOURCES), 'sources');
  if (!isObj(sources) || sources.schema !== 'wicked.apps.image-sources/v1' || !isObj(sources.sources)) throw new SiteError('sources.json is not a wicked.apps.image-sources/v1');

  // The manifest the person consented to and the files must say the same thing.
  const listed = new Set(manifest.queries.map((q) => q.id));
  for (const q of spec.queries) if (!listed.has(q.id)) throw new SiteError(`query ${q.id} is not in the manifest`);
  for (const q of manifest.queries) if (!spec.queries.some((x) => x.id === q.id)) throw new SiteError(`the manifest lists query ${q.id}, which the spec does not hold`);
  const granted = new Set(manifest.actions.map((a) => a.id));
  for (const a of spec.actions) if (!granted.has(a.id)) throw new SiteError(`action ${a.id} has no grant in the manifest`);
  for (const a of manifest.actions) {
    if (!spec.actions.some((x) => x.id === a.id)) throw new SiteError(`the manifest grants action ${a.id}, which the spec does not hold`);
    if (a.grant.app !== manifest.app.slug || a.grant.action !== a.id) throw new SiteError(`the grant for action ${a.id} is another action's`);
  }
  const shipped = new Set(manifest.sources.map((s) => s.name));
  for (const name of new Set([...spec.queries.map((q) => q.source), ...spec.actions.map((a) => a.source)])) {
    if (!shipped.has(name) || !Object.hasOwn(sources.sources, name)) throw new SiteError(`source ${name} is not shipped in this image`);
  }
  // A public site holds only public queries and no action (DES §8.2).
  if (manifest.audience.kind === 'public') {
    if (spec.actions.length > 0) throw new SiteError('a public site holds no action');
    const notPublic = spec.queries.find((q) => q.public !== true);
    if (notPublic !== undefined) throw new SiteError(`a public site holds only public queries (${notPublic.id} is not)`);
    if (manifest.identity !== null) throw new SiteError('a public site has no issuer');
  } else if (manifest.identity === null) {
    throw new SiteError('a signed-in site names its issuer');
  }
  const runtime = { js: readText(join(dir, SITE_RUNTIME_JS), 'runtime script'), css: readText(join(dir, SITE_RUNTIME_CSS), 'runtime stylesheet') };
  return { dir, manifest, files: { spec, queryText, lock }, sources: sources.sources, runtime, snapshotDir: join(dir, SITE_SNAPSHOTS) };
}
