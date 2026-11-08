/**
 * (DES-APPS-001 §7.3) The pure card builder: how an action's resolved values become the per-run consent
 * card. {@link cardCell} is the single value mapping both the live write path ({@link AppWritePath.prepareAction})
 * and the publish check's fixture evidence use, so the card a person consents to in studio and the card QE
 * sees for the same action are generated the same way. Nothing here reads a source, a record or a rate limit.
 *
 * The live path resolves each value against the real viewer and the live table columns; the publish check
 * resolves them against deterministic fixture values. The mapping of a value to its
 * `from` and `label`, plus the full row and API presentation, is shared.
 */

import type { AppActionCard, AppApiAction, AppRowWriteAction, AppActionCardValue, AppActionValueSource, AppParamsSchema, AppValue } from '../../core/types.js';

import type { McpUpstreamConfig } from '../../mcp/probe.js';
import type { McpToolRecord } from '../../mcp/registry-store.js';
import type { ResolvedOperation } from './store.js';
import { describeMutation, describeToolRequest, idempotencyArg } from './api-action.js';

/** The words for each `from` (DES §7.3: the host draws these outside the app's frame). */
export const CARD_LABEL: Record<AppActionValueSource, string> = {
  param: 'you entered it',
  app: 'fixed by the app',
  viewer: 'your sign-in',
  crew: 'filled by studio',
};

/** One resolved card cell: its raw value, where it came from, and the words for that. */
export interface Cell {
  value: unknown;
  from: AppActionValueSource;
  label: string;
}

/** How {@link cardCell} reaches the values it cannot know itself (the bound parameters, the viewer, a fresh uuid). */
export interface CellResolve {
  /** The bound value of a declared parameter. */
  paramValue: (name: string) => unknown;
  /** A viewer claim, or `null` when crew does not know it (the live path refuses; the fixture supplies a sample). */
  viewerClaim: (claim: 'email' | 'name' | 'id') => string | null;
  /** A fresh uuid for a `crew: uuid` value. */
  newUuid: () => string;
}

/** Thrown by {@link cardCell} when a viewer-claim value is needed and crew does not know it. The caller maps it. */
export class ViewerClaimUnavailable extends Error {
  constructor(readonly claim: 'email' | 'name' | 'id') {
    super(`the action needs your ${claim}, and crew does not know it`);
    this.name = 'ViewerClaimUnavailable';
  }
}

/**
 * Map one {@link AppValue} to its card cell. A `crew: now` value keeps the caller's convention of a raw `''`
 * here (the live path fills it with the column's `now` form or the ISO instant right after); everything else
 * is the final cell. Pure: it calls only the three functions `resolve` gives it.
 */
export function cardCell(v: AppValue, params: AppParamsSchema | undefined, resolve: CellResolve): Cell {
  if (v.kind === 'param') {
    const decl = params?.properties[v.name];
    const from: AppActionValueSource = decl?.from !== undefined ? 'viewer' : 'param';
    return { value: resolve.paramValue(v.name), from, label: from === 'viewer' ? CARD_LABEL.viewer : CARD_LABEL.param };
  }
  if (v.kind === 'literal') return { value: v.value, from: 'app', label: CARD_LABEL.app };
  if (v.kind === 'viewer') {
    const claim = resolve.viewerClaim(v.claim);
    if (claim === null) throw new ViewerClaimUnavailable(v.claim);
    return { value: claim, from: 'viewer', label: CARD_LABEL.viewer };
  }
  return { value: v.value === 'now' ? '' : resolve.newUuid(), from: 'crew', label: `${CARD_LABEL.crew}: ${v.value === 'now' ? 'now' : 'new uuid'}` };
}

/** The complete row presentation shared by prepareAction and fixture evidence. */
export function buildRowCard(app: string, action: AppRowWriteAction, input: { login: string; columns: AppActionCardValue[]; key: AppActionCardValue[]; statement: string; checks?: string }): AppActionCard {
  const verb = action.op === 'insert' ? 'INSERT' : action.op === 'update' ? 'UPDATE' : 'DELETE';
  return {
    kind: 'row-write',
    app,
    action: action.id,
    source: action.source,
    login: input.login,
    verb,
    table: action.table,
    columns: input.columns,
    key: input.key,
    rows: 'exactly 1 row, verified',
    checks: input.checks ?? 'plain table: no triggers, rules, inheritance or row security; checked just now',
    statement: input.statement,
    ...(action.description !== undefined ? { appSays: action.description } : {}),
  };
}

/** Resolved metadata only: building a card never looks up a source or executes an operation. */
export interface ApiCardMetadata {
  config: McpUpstreamConfig;
  tool?: McpToolRecord;
  field?: string;
  validateMutation?: (args: Record<string, unknown>) => void;
}

export function buildApiCard(
  app: string,
  action: AppApiAction,
  metadata: ApiCardMetadata,
  value: (v: AppValue) => Cell,
  nowAt: Date,
  absent: ReadonlySet<string>,
  recordId: string,
): { card: AppActionCard; operation: ResolvedOperation } {
  const cards: AppActionCardValue[] = [];
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action.args)) {
    // An absent optional parameter's argument is left out of the call (and off the card), never sent as null.
    if (v.kind === 'param' && absent.has(v.name)) continue;
    const r = value(v);
    const sent = v.kind === 'crew' && v.value === 'now' ? nowAt.toISOString() : r.value;
    args[k] = sent;
    cards.push({ name: k, value: sent === undefined ? null : (sent as AppActionCardValue['value']), from: r.from, label: r.label });
  }

  let shown: { operation: string; request: string };
  let operation: ResolvedOperation;
  if (action.call.kind === 'tool') {
    const tool = metadata.tool!;
    // An operation that maps an Idempotency-Key header gets the record id, on the card like any value (codex/pi r1).
    const idem = idempotencyArg(tool.rest);
    if (idem !== null && !Object.hasOwn(args, idem)) {
      args[idem] = recordId;
      cards.push({ name: idem, value: recordId, from: 'crew', label: `${CARD_LABEL.crew}: the record id` });
    }
    shown = describeToolRequest(metadata.config, tool.name, tool.rest, args);
    operation = { kind: 'tool', tool: tool.name, args };
  } else {
    metadata.validateMutation?.(args);
    shown = describeMutation(metadata.config, action.call.mutation, args, metadata.field ?? 'mutation');
    operation = { kind: 'mutation', document: action.call.mutation, variables: args };
  }
  const card: AppActionCard = {
    kind: 'api',
    app,
    action: action.id,
    source: action.source,
    sourceKind: metadata.config.kind,
    operation: shown.operation,
    args: cards,
    request: shown.request,
    ...(action.description !== undefined ? { appSays: action.description } : {}),
  };
  return { card, operation };
}
