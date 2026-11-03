/**
 * (DES-APPS-001 §8.1, §9.3 step 4) What an Apps image holds under `/srv/site`, named once: crew's packer
 * writes it and `wicked-apps-server` (packages/apps-server) reads it.
 *
 *   apps.json, apps.lock.json, queries/<id>.<ext>   the checked files, from the tree's git objects
 *   manifest.json                                   the AppPublishManifest the person consented to
 *   sources.json                                    each shipped source's config as crew's registry holds it
 *                                                   (secret REFERENCES only: the descriptor hash includes
 *                                                   them) and, for a REST or MCP server, its tool records
 *   runtime/runtime.js, runtime/runtime.css         the wicked-apps runtime's standalone entry and its one
 *                                                   stylesheet (studio's build)
 *   snapshots/<sha256>.sqlite                       each upload the app reads, by digest
 */

import type { McpUpstreamConfig } from '../../mcp/probe.js';
import type { McpToolRecord } from '../../mcp/registry-store.js';

export const SITE_SPEC = 'apps.json';
export const SITE_LOCK = 'apps.lock.json';
export const SITE_QUERIES = 'queries';
export const SITE_MANIFEST = 'manifest.json';
export const SITE_SOURCES = 'sources.json';
export const SITE_RUNTIME_JS = 'runtime/runtime.js';
export const SITE_RUNTIME_CSS = 'runtime/runtime.css';
export const SITE_SNAPSHOTS = 'snapshots';

/** The port the server listens on inside the container. */
export const SITE_PORT = 8080;

export interface ImageSource {
  config: McpUpstreamConfig;
  /** A REST or MCP server's tools as crew's registry held them at publish (none for `sql` and `graphql`). */
  tools: McpToolRecord[];
  /** A Postgres source's Allow writes switch at publish (the manifest shows it to the person). */
  allowWrites: boolean;
}

export interface ImageSources {
  schema: 'wicked.apps.image-sources/v1';
  sources: Record<string, ImageSource>;
}

/** The Teams clients' frame origins (DES §8.2: "the Teams package names the Teams origins"; K6b certifies them). */
export const TEAMS_FRAME_ORIGINS = ['https://teams.microsoft.com', 'https://*.teams.microsoft.com', 'https://teams.cloud.microsoft'] as const;

/** The environment variable a source's secret arrives in: `APPS_SRC_<NAME>_PASSWORD` (SQL) or `_TOKEN`. */
export function secretEnvName(config: Pick<McpUpstreamConfig, 'name' | 'kind'>): string {
  const base = config.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `APPS_SRC_${base}_${config.kind === 'sql' ? 'PASSWORD' : 'TOKEN'}`;
}
