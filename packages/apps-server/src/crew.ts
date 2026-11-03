/**
 * The ONE place the app server reaches into crew's source. Everything that decides what a query reads or
 * what an action writes is crew's code, imported here and bundled into the image (scripts/build.mjs): the
 * executor, the write path, the action store, the source describe, the OIDC verifier and the dialer. The
 * server adds only the routes, sign-in and the image's own store and registry.
 */

export { verifyOidcClaims, type OidcConfig } from '../../crew/src/api/auth.js';
export type { AuditLog } from '../../crew/src/api/audit.js';
export type { Actor, AppAction, AppLock, AppPublishManifest, AppQuery, AppReceipt, AppSiteHealth, AppSiteSpecResponse, AppSpec, AppAudienceRule, AppPublishIdentity } from '../../crew/src/core/types.js';
export { AppWriteError, AppWritePath } from '../../crew/src/apps/actions/write-path.js';
export { AppActionStore, type ActionTx } from '../../crew/src/apps/actions/store.js';
export { AppExecError, AppExecutor, type AppFilesSource } from '../../crew/src/apps/exec/executor.js';
export type { Viewer } from '../../crew/src/apps/exec/params.js';
export type { AppSourceRegistry } from '../../crew/src/apps/exec/sources.js';
export { QUERY_EXT, type AppFiles } from '../../crew/src/apps/check.js';
export { parseSpec } from '../../crew/src/apps/spec.js';
export { McpRegistryError } from '../../crew/src/mcp/registry.js';
export type { McpUpstreamConfig } from '../../crew/src/mcp/probe.js';
export type { McpToolRecord } from '../../crew/src/mcp/registry-store.js';
export { describeSource, sourceDescriptorHash } from '../../crew/src/sources/kinds.js';
export { probeMcpServer } from '../../crew/src/mcp/probe.js';
export { toolSchemaHash } from '../../crew/src/mcp/classify.js';
export { restTarget } from '../../crew/src/mcp/rest.js';
export type { StoredDescription } from '../../crew/src/sources/store.js';
export type { DialOptions } from '../../crew/src/sources/dialer.js';
export {
  SITE_LOCK,
  SITE_MANIFEST,
  SITE_PORT,
  SITE_QUERIES,
  SITE_RUNTIME_CSS,
  SITE_RUNTIME_JS,
  SITE_SNAPSHOTS,
  SITE_SOURCES,
  SITE_SPEC,
  TEAMS_FRAME_ORIGINS,
  type ImageSource,
  type ImageSources,
} from '../../crew/src/apps/publish/layout.js';
