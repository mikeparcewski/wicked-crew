/**
 * Request parameters (DES-APPS-001 §7.2 step 3): validated against the query's (or action's) schema;
 * VIEWER-BOUND ones are filled by crew from the verified viewer, and a client value for one is refused.
 *
 * The viewer (§7.2 "Viewer identity"): studio with auth off is the daemon user, whose email and name are
 * the global git `user.email` / `user.name` (today's local actor has none). An authenticated actor carries
 * only an id here; a value crew does not know is refused rather than guessed (`viewer.groups` does not
 * exist locally: "not available in local preview").
 */

import type { AppParamSchema, AppParamsSchema } from '../../core/types.js';
import { paramValueProblem } from '../spec.js';
import { paramOrder } from './contract.js';

export interface Viewer {
  id: string;
  email: string | null;
  name: string | null;
  /** `null` = not known here (local preview). */
  groups: string[] | null;
}

export class ParamError extends Error {
  constructor(
    readonly code: 'bad_params' | 'viewer_unavailable',
    message: string,
  ) {
    super(message);
  }
}

const MAX_ARRAY = 200;

function viewerValue(p: AppParamSchema, name: string, viewer: Viewer): unknown {
  switch (p.from) {
    case 'viewer.email':
      if (viewer.email === null) throw new ParamError('viewer_unavailable', `parameter ${name} is your email, and crew does not know it: set your git user.email`);
      return viewer.email;
    case 'viewer.name':
      if (viewer.name === null) throw new ParamError('viewer_unavailable', `parameter ${name} is your name, and crew does not know it: set your git user.name`);
      return viewer.name;
    case 'viewer.id':
      return viewer.id;
    case 'viewer.groups':
      if (viewer.groups === null) throw new ParamError('viewer_unavailable', `parameter ${name} is your groups, which are not available in local preview`);
      return [...viewer.groups];
    default:
      return undefined;
  }
}

/** Why `v` does not satisfy `p` (scalars by the spec's own rule; arrays item by item), or `null`. */
export function valueProblem(p: AppParamSchema, v: unknown): string | null {
  if (p.type !== 'array') return paramValueProblem(p, v);
  if (!Array.isArray(v)) return 'is not an array';
  if (v.length > MAX_ARRAY) return `holds more than ${MAX_ARRAY} items`;
  for (const [i, item] of v.entries()) {
    const problem = paramValueProblem({ type: p.items?.type ?? 'string' }, item);
    if (problem !== null) return `item ${i} ${problem}`;
  }
  return null;
}

/**
 * Bind a request's values: every key a declared, non-viewer parameter; viewer-bound ones from `viewer`;
 * each value valid; a missing one takes its default, a missing required one is refused, a missing optional
 * one is `null`. Answers the values by name and in declaration order (`$n` is the n-th).
 */
export function bindParams(params: AppParamsSchema | undefined, supplied: Record<string, unknown> | undefined, viewer: Viewer): { byName: Record<string, unknown>; ordered: unknown[]; absent: ReadonlySet<string> } {
  const props = params?.properties ?? {};
  const given = supplied ?? {};
  for (const k of Object.keys(given)) {
    if (!Object.hasOwn(props, k)) throw new ParamError('bad_params', `there is no parameter ${JSON.stringify(k)}`);
    if (props[k]!.from !== undefined) throw new ParamError('bad_params', `parameter ${k} is filled by crew from ${props[k]!.from}; a request may not set it`);
  }
  const required = new Set(params?.required ?? []);
  const byName: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  // Optional parameters nobody filled: SQL binds them as NULL; a tool argument or GraphQL variable they fill is
  // left out of the call (a document's default then applies), never sent as null (codex r2).
  const absent = new Set<string>();
  for (const name of paramOrder(params)) {
    const p = props[name]!;
    let v: unknown;
    if (p.from !== undefined) v = viewerValue(p, name, viewer);
    else if (Object.hasOwn(given, name) && given[name] !== undefined) v = given[name];
    else if (p.default !== undefined) v = p.default;
    else if (required.has(name)) throw new ParamError('bad_params', `parameter ${name} is required`);
    else {
      byName[name] = null;
      absent.add(name);
      continue;
    }
    const problem = valueProblem(p, v);
    if (problem !== null) throw new ParamError('bad_params', `parameter ${name} ${problem}`);
    byName[name] = v;
  }
  return { byName, ordered: paramOrder(params).map((n) => byName[n]), absent };
}
