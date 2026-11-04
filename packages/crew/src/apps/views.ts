/**
 * (DES-KNOWLEDGE-DATA-001 §5.2, crew#1317) The Apps detail as a non-human reader may see it.
 *
 * `GET /apps/:app` is an observer read. Its lock pins each source's connection DESCRIPTOR (driver, host,
 * port, database, login, TLS mode, confirmed ranges, secret-reference identity, a descriptor-version-2
 * entry's Toolbox document), its `queryText` holds the app's SQL, which names the source's relations, and
 * its spec's actions hold a row write's table and columns and an API action's call (a GraphQL mutation
 * document). A human actor (studio's app viewers) reads it whole. Any other actor ({@link viewOf} `agent`)
 * reads the lock's sources reduced to `{kind, descriptorHash}`, no `queryText`, and each action as what it
 * is, not what it touches (`{id, kind, source, op, description}`), and no `turns` (the app's chat, K5). Everything
 * else passes through. Crew's
 * own readers (the K5 builder's turn, the check, the executor) call the store in process, not the route, so
 * they keep the full detail.
 */

import { viewOf } from '../api/auth.js';
import type { Actor, AppAction, AppDetail, AppLock, AppLockSource, AppSpec } from '../core/types.js';

/** An action as a non-human reader sees it: no table, columns, call, arguments or parameters. */
export type AppActionAgentView = Pick<AppAction, 'id' | 'kind' | 'source' | 'description'> & { op?: 'insert' | 'update' | 'delete' };

/** The agent-safe form of the Apps detail. Crew-local (api-types unchanged). */
export type AppDetailAgentView = Omit<AppDetail, 'queryText' | 'lock' | 'spec' | 'turns'> & {
  spec: Omit<AppSpec, 'actions'> & { actions: AppActionAgentView[] };
  lock: Omit<AppLock, 'sources'> & { sources: Record<string, Pick<AppLockSource, 'kind' | 'descriptorHash'>> };
};

function actionFor(a: AppAction): AppActionAgentView {
  return {
    id: a.id,
    kind: a.kind,
    source: a.source,
    ...(a.kind === 'row-write' ? { op: a.op } : {}),
    ...(a.description !== undefined ? { description: a.description } : {}),
  };
}

/** `detail` as `actor` may read it. */
export function appDetailFor(actor: Actor | null | undefined, detail: AppDetail): AppDetail | AppDetailAgentView {
  if (viewOf(actor) === 'full') return detail;
  const view: Partial<AppDetail> = { ...detail };
  delete view.queryText;
  // (K5) The app's chat is the person's: its messages and crew's reasons (a check's findings name queries and
  // relations; a builder's words) are not an agent's to read.
  delete view.turns;
  const sources = Object.fromEntries(Object.entries(detail.lock.sources).map(([name, s]) => [name, { kind: s.kind, descriptorHash: s.descriptorHash }]));
  return {
    ...(view as Omit<AppDetail, 'queryText' | 'lock' | 'spec' | 'turns'>),
    spec: { ...detail.spec, actions: (detail.spec.actions ?? []).map(actionFor) },
    // pi r2: the lock is built from its known fields, so a field added to it later stays out of the agent form.
    lock: { schema: detail.lock.schema, sources, queries: detail.lock.queries, actions: detail.lock.actions, uploads: detail.lock.uploads },
  };
}
