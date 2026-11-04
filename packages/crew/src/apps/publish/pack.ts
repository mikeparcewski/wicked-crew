/**
 * (DES-APPS-001 §9.3 step 4) Packing an app into its image's build context, with product-owned tooling only.
 *
 * The context is written by crew from what the caller hands it: the checked files (their text as the tree's
 * git objects hold it), the manifest, the shipped sources, the runtime, the snapshots by digest (each one
 * verified against its digest before it is copied), and the server artifact (`packages/apps-server/dist`:
 * the product Dockerfile, the server bundle, the SQLite runner). Nothing in the app repository is read or
 * executed here, and no path inside the context comes from the app's text: every name is crew's.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppPublishManifest, AppSpec } from '../../core/types.js';
import { QUERY_EXT } from '../check.js';
import { APP_NAMED_ID_RE } from '../spec.js';
import { snapshotPath } from '../../sources/uploads.js';
import { type ImageSources, SITE_LOCK, SITE_MANIFEST, SITE_QUERIES, SITE_RUNTIME_CSS, SITE_RUNTIME_JS, SITE_SNAPSHOTS, SITE_SOURCES, SITE_SPEC } from './layout.js';

export class PackError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SiteFilesInput {
  /** The spec as parsed (for the query file names), and the exact texts of the tree's files. */
  spec: AppSpec;
  specText: string;
  lockText: string;
  queryText: Record<string, string>;
  manifest: AppPublishManifest;
  sources: ImageSources;
  runtime: { js: string; css: string };
  /** crew's snapshot store (uploads); default: its usual place. */
  snapshotDir?: string;
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

function put(dir: string, rel: string, text: string | Buffer, digests: Record<string, string>): void {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  digests[rel] = sha256(text);
}

/** Write `/srv/site` (crew's layout.ts) into `dir`. Answers each file's sha256, by its path in the site. */
export function writeSite(dir: string, input: SiteFilesInput): Record<string, string> {
  const digests: Record<string, string> = {};
  mkdirSync(dir, { recursive: true });
  put(dir, SITE_SPEC, input.specText, digests);
  put(dir, SITE_LOCK, input.lockText, digests);
  for (const q of input.spec.queries) {
    // The id is the spec check's (`APP_NAMED_ID_RE`); checked again here because it names a file.
    if (!APP_NAMED_ID_RE.test(q.id)) throw new PackError('bad_query_id', `query id ${JSON.stringify(q.id).slice(0, 70)} cannot name a file`);
    if (!Object.hasOwn(input.queryText, q.id)) throw new PackError('missing_text', `query ${q.id} has no text in this tree`);
    put(dir, `${SITE_QUERIES}/${q.id}.${QUERY_EXT[q.kind]}`, input.queryText[q.id]!, digests);
  }
  put(dir, SITE_MANIFEST, `${JSON.stringify(input.manifest, null, 2)}\n`, digests);
  put(dir, SITE_SOURCES, `${JSON.stringify(input.sources, null, 2)}\n`, digests);
  put(dir, SITE_RUNTIME_JS, input.runtime.js, digests);
  put(dir, SITE_RUNTIME_CSS, input.runtime.css, digests);
  mkdirSync(join(dir, SITE_SNAPSHOTS), { recursive: true });
  for (const s of input.manifest.sources) {
    if (s.snapshot === undefined) continue;
    const from = snapshotPath(s.snapshot, input.snapshotDir);
    if (!existsSync(from)) throw new PackError('missing_snapshot', `the upload behind ${s.name} is not in crew's snapshot store`);
    const bytes = readFileSync(from);
    if (sha256(bytes) !== s.snapshot) throw new PackError('snapshot_digest', `the upload behind ${s.name} does not match its digest: nothing was packed`);
    put(dir, `${SITE_SNAPSHOTS}/${s.snapshot}.sqlite`, bytes, digests);
  }
  return digests;
}

/**
 * Write a whole build context: the server artifact (Dockerfile, `server/`, `runners/`) and the site. Answers
 * the site's file digests.
 */
export function writeImageContext(ctx: string, input: SiteFilesInput & { serverArtifact: string }): Record<string, string> {
  for (const part of ['Dockerfile', 'server', 'runners']) {
    if (!existsSync(join(input.serverArtifact, part))) throw new PackError('no_server', `the app server artifact has no ${part} (build packages/apps-server first)`);
  }
  mkdirSync(ctx, { recursive: true });
  cpSync(join(input.serverArtifact, 'Dockerfile'), join(ctx, 'Dockerfile'));
  cpSync(join(input.serverArtifact, 'server'), join(ctx, 'server'), { recursive: true, filter: (src) => !src.endsWith('.test.js') });
  cpSync(join(input.serverArtifact, 'runners'), join(ctx, 'runners'), { recursive: true });
  return writeSite(join(ctx, 'site'), input);
}
