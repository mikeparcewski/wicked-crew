/**
 * The built-in `crew` source (DES-APPS-001 §5.1): crew's own API, read IN-PROCESS as the viewing
 * actor. Nothing to add, always on, no writes. Only the allowlisted `GET` routes below are readable;
 * their shapes are the published `wicked-crew-api-types` ones. A read is an in-process request that
 * carries the viewer's own credentials, so crew's auth judges it exactly as it judges the viewer.
 */

import type { CrewSourceCatalog } from '../core/types.js';

/** The routes an app may read from crew itself. */
export const CREW_SOURCE_ROUTES: CrewSourceCatalog['routes'] = [
  { path: '/runs', responseType: '{ runs: SessionView[] }', params: [] },
  { path: '/runs/:id', responseType: '{ run: SessionView }', params: ['id'] },
  { path: '/runs/:id/acceptance', responseType: 'RunAcceptanceResponse', params: ['id'] },
  { path: '/system', responseType: 'SystemSnapshot', params: [] },
  { path: '/diagnostics', responseType: 'DiagnosticsResponse', params: [] },
  { path: '/repos/:id/requirements', responseType: 'RepoRequirementsResponse', params: ['id'] },
  { path: '/mcp/usage', responseType: 'McpUsageResponse', params: [] },
  { path: '/schedules', responseType: 'SchedulesResponse', params: [] },
];

export function crewSourceCatalog(): CrewSourceCatalog {
  return { routes: CREW_SOURCE_ROUTES.map((r) => ({ ...r, params: [...r.params] })) };
}

/** An in-process request: Fastify's `inject`, narrowed to what a crew-source read needs. */
export type CrewInject = (req: { method: 'GET'; url: string; headers: Record<string, string> }) => Promise<{ statusCode: number; body: string }>;

/**
 * Read one allowlisted route as the viewer. `path` must be one of {@link CREW_SOURCE_ROUTES} with its
 * `:params` filled from `params` (each encoded as one path segment); `query` becomes the query string.
 * `viewerHeaders` are the viewer's own `authorization` (and nothing else), so the read is judged as them.
 */
export async function readCrewSource(
  inject: CrewInject,
  path: string,
  params: Record<string, string>,
  query: Record<string, string>,
  viewerHeaders: { authorization?: string },
): Promise<{ status: number; json: unknown }> {
  const route = CREW_SOURCE_ROUTES.find((r) => r.path === path);
  if (route === undefined) throw new Error(`${path} is not a route the crew source reads`);
  let filled = route.path;
  for (const p of route.params) {
    const v = params[p];
    if (typeof v !== 'string' || v === '' || v === '.' || v === '..') throw new Error(`the crew source read of ${path} needs :${p}`);
    filled = filled.replace(`:${p}`, encodeURIComponent(v));
  }
  const qs = new URLSearchParams(query).toString();
  const res = await inject({ method: 'GET', url: `/api/v1${filled}${qs === '' ? '' : `?${qs}`}`, headers: viewerHeaders.authorization === undefined ? {} : { authorization: viewerHeaders.authorization } });
  let json: unknown = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.statusCode, json };
}
